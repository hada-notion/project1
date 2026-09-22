// supabase/functions/generate-tuition/index.ts
//
// 클래스(학원) DB의 "월 수강료 생성" 버튼이 호출한다.
// "수강료 생성 대상" 관계(limit 1)로 연결된 "알림톡 발송함(학원) DB" 페이지의 "기간"을 기준으로
// 대상 달을 정한다. 그 시작일 이전에 등록해서 현재 수강 중인 등록(학생) 각각에 대해
// 수강료(학원) DB에 한 건씩 생성하고, 생성된 건을 그 발송함과 "알림톡 발송함" 관계로 연결한다
// (발송함의 '일괄 전송' 버튼이 이 관계로 대상을 찾는다). 같은 달에 이미 생성된 건이 있으면
// 건너뛴다 (버튼을 여러 번 눌러도 안전 -- idempotent).
//
// (2026-09-21, 월수강료 계산방식 재설계) 수강료(학원) DB의 "청구금액" 수식은 이제 항상
// 등록.수강료 * (실제 수업량 / 등록.월간 수업 총량(클래스)) + 청구금액 조정 으로 계산된다
// (예전의 "정산방식"(횟수제/총량제) 분기는 제거됨 -- "단위"는 이제 화면 표시용일 뿐 계산에는
// 영향을 주지 않는다). 그래서 이 함수는 "실제 수업량"만 채우면 나머지는 수식이 자동으로
// 계산한다. 생성 시점에는 완납을 가정해 클래스의 "월간 수업 총량"과 동일한 값을 기본으로
// 채운다 -- 결석/중도등록 등 예외가 있으면 생성된 수강료 건의 "실제 수업량"을 직접 수정한다
// (예전처럼 "월간 수업 횟수" 수식(시간표 수*4)을 분자로 쓰지 않는다: 그 수식은 더 이상 청구
// 계산에 쓰이지 않고, 참고용으로만 등록(학원) DB에 남아있다).
//
// 클래스의 "월간 수업 총량"이 비어있으면(신규 클래스 등 설정 전) 이 클래스는 통째로 건너뛴다 --
// 0으로 청구금액을 만들어버리는 대신 사용자가 클래스 설정을 먼저 채우도록 유도한다.
//
// (2026-09-16) 수강료(학원) DB에 "알림톡 설정" 관계 속성이 다시 있다. 이 관계는 표시 전용이다 --
// send-tuition-notice는 여전히 발송 시점에 "발송 구분" 문자열로 알림톡 설정 DB를 조회해서 안내멘트
// 등을 가져오므로, 실제 발송 동작은 이 관계값과 무관하다. 다만 Notion 화면에서 이 수강료 건이
// 어떤 발송 설정과 연결되는지 직관적으로 보이도록, 생성 시점에 getScheduleConfig("수강료 안내")로
// 조회한 설정 행을 이 관계에 채워둔다 (조회 실패 시에는 조용히 건너뛰고 생성 자체는 계속 진행함).
//
// generate-classes(시간표 기반 수업/출석 생성)와 같은 버튼-웹훅 패턴을 따른다:
// Notion의 "웹훅 보내기" 액션은 응답을 동기적으로 기다리므로, 처리가 오래 걸리면 타임아웃
// 알림이 뜰 수 있다. 그래서 즉시 202를 반환하고 실제 작업은 백그라운드에서 계속한다.
// 진행 상태는 클래스 페이지의 "실시간 처리 상태" 속성으로 확인한다.
//
// (2026-09-21, PART N-2: 관리자 키 인증 추가) 이 함수를 호출하는 클래스(학원) DB "월 수강료 생성"
// 버튼 자동화에 x-admin-key 헤더를 먼저 추가해둔 뒤, webhookIngest.ts의 handleLockedBackgroundWebhook
// 에 새로 추가된 opt-in requireAdminKey 옵션을 여기서 켠다.

import {
	getPage,
	createPage,
	archivePage,
	mapWithConcurrency,
} from "../_shared/notionClient.ts"
import { handleLockedBackgroundWebhook } from "../_shared/webhookIngest.ts"
import { getScheduleConfig } from "../_shared/adminShared.ts"
import { PROP_LAST_ERROR } from "../_shared/constants.ts"
import { type StatusSpec } from "../_shared/statusTracking.ts"
import {
	DS_TUITION,
	getActiveRegistrationsForClass,
	findTuitionForMonth,
	monthRange,
	PROP_NOTIFICATION_BATCH_RELATION,
	PROP_BATCH_PERIOD,
} from "../_shared/generateShared.ts"

// (2026-09-22, 처리 상태 관리 리팩토링 Phase 3) "수강료 생성중" 체크박스 -> "수강료 생성 상태"(select)
// + "수강료 생성 처리 시작 시각"(date). 마스터플랜: https://app.notion.com/p/903c90386c1d473494c5df6306c53517
const CLASS_TUITION_STATUS_SPEC: StatusSpec = {
	statusProp: "수강료 생성 상태",
	errorProp: PROP_LAST_ERROR,
	startedAtProp: "수강료 생성 처리 시작 시각",
}

// "수강료 생성 대상" 관계(limit 1)로 연결된 "알림톡 발송함(학원) DB" 페이지의 "기간"을 기준으로 생성한다.
// "기간"/발송함 relation 속성명은 generate-report, send-selected-notifications와 공유하므로
// _shared/generateShared.ts의 상수를 그대로 쓴다 (2026-09-16, 속성명 중복 하드코딩 정리).
const PROP_CLASS_TUITION_TARGET = "수강료 생성 대상" // 클래스(학원) DB → 알림톡 발송함(학원) DB

async function processClass(classId: string, log: string[]): Promise<void> {
	const classPage = await getPage(classId)
	const className = classPage.properties?.["클래스명"]?.title?.[0]?.plain_text ?? classId

	const batchId: string | null = classPage.properties?.[PROP_CLASS_TUITION_TARGET]?.relation?.[0]?.id ?? null
	if (!batchId) {
		log.push(`[skip] ${className}: "${PROP_CLASS_TUITION_TARGET}"이 연결되지 않음 (알림톡 발송함을 먼저 연결해주세요)`)
		return
	}
	const batchPage = await getPage(batchId)
	const periodProp = batchPage.properties?.[PROP_BATCH_PERIOD]?.date
	const periodStartRaw: string | undefined = periodProp?.start
	if (!periodStartRaw) {
		log.push(`[skip] ${className}: 연결된 발송함(${batchId})에 "${PROP_BATCH_PERIOD}"이 입력되지 않음`)
		return
	}
	const periodStart = periodStartRaw.slice(0, 10)
	// 실제 대상 기간: 발송함의 기간에 종료일(end)이 명시돼 있으면 그대로 쓰고, 없으면 시작일이
	// 속한 달 전체를 대상으로 한다 (발송함 "기간"은 보통 그 달의 1일 하나만 지정함).
	const monthDefault = monthRange(periodStart)
	const monthStart = monthDefault.start
	const monthEnd = (periodProp?.end ?? null) ? String(periodProp.end).slice(0, 10) : monthDefault.end

	// (2026-09-21) 청구금액 계산의 분모. 비어있으면(신규 클래스 등 미설정) 0원짜리 수강료를
	// 만들어버리는 대신 클래스 설정을 먼저 채우도록 안내하고 건너뛴다.
	const monthlyTotalQuantity: number | null = classPage.properties?.["월간 수업 총량"]?.number ?? null
	if (monthlyTotalQuantity == null) {
		log.push(`[skip] ${className}: "월간 수업 총량"이 설정되지 않음 (클래스 설정에서 먼저 입력해주세요)`)
		return
	}

	// 클래스 DB "해당월 수강료 생성 내역" 수식과 동일하게, 청구 기간(monthStart~monthEnd)과
	// 등록 기간(등록일~종료일)이 겹치는 등록만 대상으로 함 (당일 등록생 포함).
	const registrations = await getActiveRegistrationsForClass(classId, monthStart, monthEnd)
	if (registrations.length === 0) {
		log.push(`[ok] ${className}: 대상 등록 없음`)
		return
	}

	// [NEW] 표시용 "알림톡 설정" 관계에 채울 설정 행 -- 클래스 하나를 처리하는 동안은 항상
	// 같은 카테고리("수강료 안내")이므로 루프 밖에서 한 번만 조회한다.
	const tuitionConfig = await getScheduleConfig("수강료 안내")

	let created = 0
	let skipped = 0
	let dedupCleaned = 0
	for (const reg of registrations) {
		const existingIds = await findTuitionForMonth(reg.id, monthStart, monthEnd)
		if (existingIds.length > 1) {
			// 처리 중에 버튼이 다시 눌려서 생긴 중복: 가장 먼저 생성된 한 건만 남기고 나머지는 삭제한다.
			const extras = existingIds.slice(1)
			await mapWithConcurrency(extras, 4, (id) => archivePage(id))
			dedupCleaned += extras.length
			skipped++
			continue
		}
		if (existingIds.length === 1) {
			skipped++
			continue
		}
		const title = `${reg.studentLabel} ${monthStart.slice(0, 7)} 수강료`
		await createPage(DS_TUITION, {
			청구명: { title: [{ text: { content: title.slice(0, 200) } }] },
			청구기간: { date: { start: monthStart, end: monthEnd !== monthStart ? monthEnd : null } },
			등록: { relation: [{ id: reg.id }] },
			// 완납 가정: 클래스의 "월간 수업 총량"과 동일한 값을 기본으로 채운다. 결석/중도등록 등
			// 예외가 있으면 생성 후 이 값을 직접 조정한다.
			"실제 수업량": { number: monthlyTotalQuantity },
			// 이 건이 속한 알림톡 발송함(배치)과 연결 -- "일괄 전송" 버튼이 이 관계로 대상을 찾는다.
			[PROP_NOTIFICATION_BATCH_RELATION]: { relation: [{ id: batchId }] },
			// [NEW] 표시용: 이 건의 발송 설정이 알림톡 설정(학원) DB의 어느 행인지 한눈에 보여준다
			// (실제 발송 동작에는 영향 없음, 위 파일 상단 주석 참고).
			...(tuitionConfig ? { "알림톡 설정": { relation: [{ id: tuitionConfig.rowId }] } } : {}),
			// 생성 직후에는 기본으로 일괄전송 대상에 포함시킨다 (원치 않으면 사용자가 직접 체크 해제).
			"일괄전송 선택": { checkbox: true },
		})
		created++
	}
	log.push(
		`[done] ${className}: 생성 ${created}건, 중복스킵 ${skipped}건, 중복정리 ${dedupCleaned}건 (총 대상 ${registrations.length}건)`,
	)
}

// (2026-09-20, 웹훅 코드 정리 6단계) generate-report와 100% 같던 "POST 확인 -> body 파싱 ->
// classId 추출 -> 락 확인 -> 처리중 표시 -> 백그라운드 실행 -> 완료/오류 표시 -> 202 응답" 뼈대를
// _shared/webhookIngest.ts의 handleLockedBackgroundWebhook으로 옮겼다.
Deno.serve((req: Request) =>
	handleLockedBackgroundWebhook(
		req,
		{
			functionName: "generate-tuition",
			statusSpec: CLASS_TUITION_STATUS_SPEC,
			missingIdError: "classId를 찾지 못함",
			idField: "classId",
			requireAdminKey: true,
		},
		processClass,
	)
)

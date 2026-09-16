// supabase/functions/generate-tuition/index.ts
//
// 클래스(학원) DB의 "월 수강료 생성" 버튼이 호출한다.
// "수강료 생성 대상" 관계(limit 1)로 연결된 "알림톡 발송함(학원) DB" 페이지의 "기간"을 기준으로
// 대상 달을 정한다. 그 시작일 이전에 등록해서 현재 수강 중인 등록(학생) 각각에 대해
// 수강료(학원) DB에 한 건씩 생성하고, 생성된 건을 그 발송함과 "알림톡 발송함" 관계로 연결한다
// (발송함의 '일괄 전송' 버튼이 이 관계로 대상을 찾는다). 같은 달에 이미 생성된 건이 있으면
// 건너뛴다 (버튼을 여러 번 눌러도 안전 -- idempotent).
//
// 수강료(학원) DB의 "청구금액" 수식은 등록.수강료 * (수업 횟수 / 등록.월간 수업 횟수) + 청구금액 조정
// 으로 계산되므로, 이 함수는 "수업 횟수"만 채우면 나머지는 수식이 자동으로 계산한다.
//
// "수업 횟수"는 실제 출석 건수 대신 등록의 "월간 수업 횟수" 수식값(클래스 시간표의 요일 수 * 4)을
// 그대로 사용한다 (다음달 수강료를 미리 생성해두는 흐름에서는 그 달의 수업/출석 레코드가 아직
// 하나도 없어 실제 출석 건수가 항상 0이 되는 문제가 있었음).
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

import {
	getPage,
	createPage,
	archivePage,
	mapWithConcurrency,
	checkboxValue,
} from "../_shared/notionClient.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"
import { extractPageId } from "../_shared/notionClient.ts"
import { getScheduleConfig } from "../_shared/adminShared.ts"
import {
	DS_TUITION,
	getActiveRegistrationsForClass,
	findTuitionForMonth,
	monthRange,
	makeClassStatusSetter,
	PROP_NOTIFICATION_BATCH_RELATION,
	PROP_BATCH_PERIOD,
} from "../_shared/generateShared.ts"

// 이 체크박스가 이미 true면(백그라운드 처리가 아직 안 끝남) 버튼이 다시 눌려도 새로 시작하지
// 않고 즉시 반환한다 -- 처리 중 재클릭 시 두 실행이 동시에 "이미 있나?" 체크를 통과해버려서
// 같은 등록에 수강료가 2건 생성되는 문제(사용자 리포트, 2026-09-11)가 있었다.
const CLASS_TUITION_RUNNING = "수강료 생성중"
const setClassStatus = makeClassStatusSetter(CLASS_TUITION_RUNNING)

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
		const sessionCount = reg.monthlyClassCount
		const title = `${reg.studentLabel} ${monthStart.slice(0, 7)} 수강료`
		await createPage(DS_TUITION, {
			청구명: { title: [{ text: { content: title.slice(0, 200) } }] },
			청구기간: { date: { start: monthStart, end: monthEnd !== monthStart ? monthEnd : null } },
			등록: { relation: [{ id: reg.id }] },
			"수업 횟수": { number: sessionCount },
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

Deno.serve(async (req: Request) => {
	if (req.method !== "POST") {
		return new Response("Use POST", { status: 405 })
	}

	let body: unknown
	try {
		body = await req.json()
	} catch {
		body = undefined
	}
	const classId = body ? extractPageId(body) : null
	if (!classId) {
		return new Response(JSON.stringify({ ok: false, error: "classId를 찾지 못함", rawBody: body }, null, 2), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		})
	}

	// 이미 처리 중이면(백그라운드 작업이 아직 안 끝남) 새로 시작하지 않고 바로 반환한다 --
	// 이렇게 해야 처리 중 재클릭으로 인한 중복 생성 자체를 막을 수 있다.
	const classPageForLock = await getPage(classId)
	if (checkboxValue(classPageForLock, CLASS_TUITION_RUNNING)) {
		return new Response(JSON.stringify({ ok: true, message: "already_processing", classId }, null, 2), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})
	}

	const log: string[] = []
	await setClassStatus(classId, "처리중")

	runInBackground(async () => {
		try {
			await processClass(classId, log)
			console.log("generate-tuition finished:", classId, "\n", log.join("\n"))
			await setClassStatus(classId, "완료")
		} catch (err) {
			console.error("generate-tuition failed:", (err as Error).message, "\nlog so far:", log.join("\n"), "\nstack:", (err as Error).stack)
			await setClassStatus(classId, "오류", (err as Error).message)
		}
	})

	return respondAccepted({ classId })
})

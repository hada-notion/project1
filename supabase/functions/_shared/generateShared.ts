// _shared/generateShared.ts
//
// generate-report / generate-tuition 두 Edge Function이 공통으로 쓰는 헬퍼.
// 사용자가 "보고서와 수강료는 로직이 상당히 비슷하다"고 지적한 부분 -- 클래스(학원) DB의
// 활성 등록(수강상태==수강 중, 등록일 < 기준일) 조회 로직과 날짜 범위 계산을 여기 모은다.
// 이 파일 하나를 고치면 두 함수 모두에 반영된다.

import {
	queryAllPages,
	getPage,
	updatePageProperties,
	relIds,
	dateStart,
	selectName,
	queryDataSource,
	setCombinedSyncStatus,
} from "./notionClient.ts"
import {
	DS_REGISTRATION,
	DS_CLASS,
	DS_ATTENDANCE,
	DS_LEARNING_RECORD,
	DS_TUITION,
	DS_REPORT,
	DS_STUDY_ACTIVITY,
} from "./constants.ts"
// (2026-09-21, 이식성 리팩토링) DS_TUITION/DS_REPORT/DS_STUDY_ACTIVITY도 이제 constants.ts에서
// 가져온다(예전엔 이 파일에 하드코딩돼 있었음). generate-report/generate-tuition/
// send-selected-notifications가 이 파일의 재수출(re-export)을 그대로 쓰고 있어서 아래 export
// 목록은 그대로 유지한다.

export { DS_REGISTRATION, DS_CLASS, DS_ATTENDANCE, DS_LEARNING_RECORD, DS_TUITION, DS_REPORT, DS_STUDY_ACTIVITY, queryAllPages, getPage, updatePageProperties, relIds, dateStart, selectName, queryDataSource }

// 알림톡 발송함(학원) DB 관련 공용 속성명.
// (2026-09-16) generate-report/generate-tuition/send-selected-notifications 세 파일이 각각
// PROP_REPORT_BATCH_RELATION / PROP_TUITION_BATCH_RELATION / PROP_BATCH_RELATION라는 별도
// 상수로 같은 "알림톡 발송함" 문자열을 따로 들고 있었다. 관계 속성 이름이 바뀔 때 세 곳 중
// 하나만 고치고 나머지를 빠뜨리면 배치 연결이 조용히 깨지는 버그가 실제로 있었다 (로드맵 5-26).
// 이제 이 파일의 상수 하나로 통일해서 세 함수가 모두 여기서 가져다 쓴다.
export const PROP_NOTIFICATION_BATCH_RELATION = "알림톡 발송함" // 보고서(학원) DB / 수강료(학원) DB → 알림톡 발송함(학원) DB
export const PROP_BATCH_PERIOD = "기간" // 알림톡 발송함(학원) DB
export const PROP_BATCH_TYPE = "구분" // 알림톡 발송함(학원) DB

// 클래스(학원) DB: 자동화 실패 시 에러 메시지를 남기는 공유 텍스트 필드 (등록 DB의 "마지막 오류"와
// 이름/역할 동일). "실시간 처리 상태" 수식이 이 값과 각 "...생성중" 체크박스를 조합해서 표시한다.
export const PROP_CLASS_LAST_ERROR = "마지막 오류"

// generate-tuition("수강료 생성중")/generate-report("보고서 생성중") 등 클래스 DB를 건드리는
// 함수마다 자기 체크박스 이름만 다르게 넘겨서 쓰는 상태 표시 헬퍼. 등록 DB의 makeSyncStatusSetter와
// 동일한 패턴 (2026-09-11, "동기화 상태" select → 체크박스 + 실시간 수식 전환).
export function makeClassStatusSetter(selfFlagProp: string) {
	return async function setClassStatus(
		classId: string,
		status: "처리중" | "완료" | "오류",
		errorMessage?: string,
	): Promise<void> {
		await setCombinedSyncStatus(classId, {
			selfFlagProp,
			errorProp: PROP_CLASS_LAST_ERROR,
			phase: status === "처리중" ? "start" : status === "완료" ? "success" : "error",
			errorMessage,
		})
	}
}

export function toDateOnly(iso: string): string {
	return iso.slice(0, 10)
}

// 해당 날짜가 속한 달의 1일과 마지막날을 반환한다.
export function monthRange(dateStr: string): { start: string; end: string } {
	const d = toDateOnly(dateStr)
	const year = Number(d.slice(0, 4))
	const month = Number(d.slice(5, 7))
	const start = `${d.slice(0, 7)}-01`
	const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
	const end = `${d.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`
	return { start, end }
}

// 해당 날짜가 속한 주(월~일)의 시작/끝 날짜를 반환한다.
export function weekRange(dateStr: string): { start: string; end: string } {
	const d = toDateOnly(dateStr)
	const date = new Date(d + "T00:00:00Z")
	const weekday = date.getUTCDay() // 0=일 ... 6=토
	const diffToMonday = weekday === 0 ? -6 : 1 - weekday
	const monday = new Date(date)
	monday.setUTCDate(monday.getUTCDate() + diffToMonday)
	const sunday = new Date(monday)
	sunday.setUTCDate(sunday.getUTCDate() + 6)
	return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) }
}

export type ActiveRegistration = {
	id: string
	studentLabel: string
}

function anyTitleOf(page: any): string {
	const properties = page?.properties ?? {}
	for (const key of Object.keys(properties)) {
		const prop = properties[key]
		if (prop?.type === "title") {
			return (prop.title ?? []).map((t: any) => t.plain_text ?? "").join("") || page.id
		}
	}
	return page.id
}

// 해당 클래스에서 대상 기간(periodStart~periodEnd)과 등록 기간(등록일~종료일)이 겹치는 등록(학생)
// 목록을 반환한다. 클래스 DB의 "해당월 수강료 생성 내역"/"해당기간 보고서 생성 내역" 수식과 동일한
// 필터링 기준: 등록일 <= periodEnd 이고 (종료일이 없거나 종료일 >= periodStart).
// (2026-09-16) 예전에는 "수강상태(수식) == 수강 중" + "등록일 < 기준일(당일 미포함)"으로 걸렀는데,
// 1) 수강상태 수식이 today() 기준이라 미래/과거 기간 생성 시 실제 대상 기간과 안 맞았고,
// 2) 등록일이 기준일과 같은 날(당일 등록)인 학생이 통째로 누락되는 문제(사용자 리포트)가 있었다.
// 위 두 수식이 이미 등록일<=기간종료일 / 종료일>=기간시작일 기준으로 정리됐으므로 코드도 맞춘다.
export async function getActiveRegistrationsForClass(
	classId: string,
	periodStart: string,
	periodEnd: string,
): Promise<ActiveRegistration[]> {
	const results = await queryAllPages(DS_REGISTRATION, {
		and: [
			{ property: "\ud074\ub798\uc2a4", relation: { contains: classId } },
			{ property: "\ub4f1\ub85d\uc77c", date: { on_or_before: periodEnd } },
			{
				or: [
					{ property: "\uc885\ub8cc\uc77c", date: { is_empty: true } },
					{ property: "\uc885\ub8cc\uc77c", date: { on_or_after: periodStart } },
				],
			},
		],
	})
	return results.map((p: any) => ({
		id: p.id,
		studentLabel: anyTitleOf(p),
	}))
}

// 등록 1건에 대해 대상 기간(startDate~endDate, 날짜만) 안에 실제로 열린 출석 건수를 센다.
// 수강료 보정용("수업 횟수") -- 이달 중간에 등록해도 실제 수업 수만큼만 청구 비율을 맞추려는 목적.
export async function countAttendanceInRange(registrationId: string, startDate: string, endDate: string): Promise<number> {
	const startIso = `${startDate}T00:00:00+09:00`
	const endIso = `${endDate}T23:59:59+09:00`
	const results = await queryAllPages(DS_ATTENDANCE, {
		and: [
			{ property: "\ub4f1\ub85d", relation: { contains: registrationId } },
			{ property: "\uc218\uc5c5\uc77c\uc2dc", date: { on_or_after: startIso } },
			{ property: "\uc218\uc5c5\uc77c\uc2dc", date: { on_or_before: endIso } },
		],
	})
	return results.length
}

// 등록 1건에 대해 이번 달(monthStart~monthEnd)에 이미 생성된 수강료(생성된 건)가 있는지 확인한다 (중복 방지).
// 등록 1건에 대해 이번 달(monthStart~monthEnd)에 이미 생성된 수강료 페이지 id 목록을 오래된
// 것부터 정렬해서 반환한다 (2026-09-11, boolean -> id 목록으로 변경). 버튼이 처리 중에 다시
// 눌려서 같은 달에 수강료가 2건 이상 생겨버린 경우, 가장 먼저 생성된 한 건만 남기고 나머지를
// 지우는 정리 로직(generate-tuition)에서 이 목록을 사용한다.
export async function findTuitionForMonth(registrationId: string, monthStart: string, monthEnd: string): Promise<string[]> {
	const results = await queryAllPages(DS_TUITION, {
		and: [
			{ property: "등록", relation: { contains: registrationId } },
			{ property: "청구기간", date: { on_or_after: monthStart } },
			{ property: "청구기간", date: { on_or_before: monthEnd } },
		],
	})
	return results
		.slice()
		.sort((a, b) => String(a.created_time ?? "").localeCompare(String(b.created_time ?? "")))
		.map((p) => p.id)
}

// Supabase Edge Function: generate-report
//
// 클래스(학원) DB의 "보고서 생성" 버튼이 호출한다.
// "보고서 생성 대상" 관계(limit 1)로 연결된 "알림톡 발송함(학원) DB" 페이지의 "기간"(날짜)과
// "구분"(주간 보고서/월간 보고서)을 기준으로 실제 학습 기간(주간: 월~일, 월간: 1일~말일)을
// 계산한다. 그 기간 시작일 이전에 등록해서 현재 수강 중인 등록(학생) 각각에 대해 보고서(학원)
// DB에 한 건씩 생성하고, 생성된 건을 그 발송함과 "알림톡 발송함" 관계로 연결한다 (발송함의 '일괄 전송'
// 버튼이 이 관계로 대상을 찾는다). 같은 기간+구분의 보고서가 이미 있으면 건너뛴다 (중복 방지).
//
// 생성하는 각 보고서에는 해당 기간 안에 있는 출석/학습기록/학습활동을 바로 연결해서,
// 보고서 DB의 출석현황/학생이름/과제이행률 등 수식이 보고서 생성 즉시 제대로 계산되게 한다.
//
// (2026-09-16) 보고서(학원) DB에서 "알림톡 설정" 관계 속성을 제거했다. 안내멘트 등 발송 설정은
// send-report가 발송 시점에 "발송 구분" 문자열로 알림톡 설정 DB를 조회해서 가져오므로, 생성
// 시점에 설정 행을 관계로 미리 연결해둘 필요가 없다. (이 함수는 더 이상 getScheduleConfig를
// 호출하지 않는다.)
//
// generate-classes/generate-tuition과 같은 버튼-웹훅 패턴: 즉시 202 응답 -> 백그라운드 실행.
// 진행 상태는 클래스 페이지의 "실시간 처리 상태" 속성으로 확인한다.

import { getPage, createPage, queryAllPages, extractPageId, archivePage, mapWithConcurrency, checkboxValue } from "../_shared/notionClient.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"
import {
	DS_REPORT,
	DS_ATTENDANCE,
	DS_LEARNING_RECORD,
	DS_STUDY_ACTIVITY,
	getActiveRegistrationsForClass,
	monthRange,
	weekRange,
	makeClassStatusSetter,
	PROP_NOTIFICATION_BATCH_RELATION,
	PROP_BATCH_PERIOD,
	PROP_BATCH_TYPE,
} from "../_shared/generateShared.ts"

// 이미 처리 중이면 재클릭으로 중복 생성되는 문제(사용자 리포트, 2026-09-11)를 막기 위한
// 락 체크에 이 상수를 사용한다.
const CLASS_REPORT_RUNNING = "보고서 생성중"
const setClassStatus = makeClassStatusSetter(CLASS_REPORT_RUNNING)

// "보고서 생성 대상" 관계(limit 1)로 연결된 "알림톡 발송함(학원) DB" 페이지의 "기간"/"구분"을 기준으로 생성한다.
// "기간"/"구분"/발송함 relation 속성명은 generate-tuition, send-selected-notifications와 공유하므로
// _shared/generateShared.ts의 상수를 그대로 쓴다 (2026-09-16, 속성명 중복 하드코딩 정리).
const PROP_CLASS_REPORT_TARGET = "보고서 생성 대상" // 클래스(학원) DB → 알림톡 발송함(학원) DB
const REPORT_TYPE_WEEKLY = "주간 보고서"

// dateProp이 일반 date 속성이면 "date", 롤업(rollup)/수식(formula)으로 계산되는 날짜 속성이면
// 그에 맞는 필터 형태를 써야 한다 (Notion API는 속성 타입마다 필터 모양이 다르다).
type DatePropKind = "date" | "rollup_date"

async function findIdsInRange(
	dataSourceId: string,
	dateProp: string,
	registrationId: string,
	startDate: string,
	endDate: string,
	datePropKind: DatePropKind = "date",
): Promise<string[]> {
	const startIso = `${startDate}T00:00:00+09:00`
	const endIso = `${endDate}T23:59:59+09:00`
	const dateFilter = (range: { on_or_after?: string; on_or_before?: string }) =>
		datePropKind === "rollup_date" ? { property: dateProp, rollup: { date: range } } : { property: dateProp, date: range }
	const results = await queryAllPages(dataSourceId, {
		and: [
			{ property: "등록", relation: { contains: registrationId } },
			dateFilter({ on_or_after: startIso }),
			dateFilter({ on_or_before: endIso }),
		],
	})
	return results.map((p: any) => p.id)
}

// 같은 등록+기간+구분의 기존 보고서 id 목록을 오래된 것부터 정렬해서 반환한다 (처리 중 재클릭으로
// 생긴 중복을 찾아 정리하기 위해 필요).
async function findReportForPeriod(registrationId: string, reportType: string, periodStart: string): Promise<string[]> {
	const results = await queryAllPages(DS_REPORT, {
		and: [
			{ property: "등록", relation: { contains: registrationId } },
			{ property: "보고서 구분", select: { equals: reportType } },
			{ property: "보고서 기간", date: { equals: periodStart } },
		],
	})
	return results
		.slice()
		.sort((a: any, b: any) => String(a.created_time ?? "").localeCompare(String(b.created_time ?? "")))
		.map((p: any) => p.id)
}

async function processClass(classId: string, log: string[]): Promise<void> {
	const classPage = await getPage(classId)
	const className = classPage.properties?.["클래스명"]?.title?.[0]?.plain_text ?? classId

	const batchId: string | null = classPage.properties?.[PROP_CLASS_REPORT_TARGET]?.relation?.[0]?.id ?? null
	if (!batchId) {
		log.push(`[skip] ${className}: "${PROP_CLASS_REPORT_TARGET}"이 연결되지 않음 (알림톡 발송함을 먼저 연결해주세요)`)
		return
	}
	const batchPage = await getPage(batchId)
	const reportType: string | undefined = batchPage.properties?.[PROP_BATCH_TYPE]?.select?.name
	const rawStart: string | undefined = batchPage.properties?.[PROP_BATCH_PERIOD]?.date?.start
	if (!rawStart || (reportType !== "주간 보고서" && reportType !== "월간 보고서")) {
		log.push(`[skip] ${className}: 연결된 발송함(${batchId})의 "${PROP_BATCH_PERIOD}"/"${PROP_BATCH_TYPE}"이 올바르지 않음 (구분: ${reportType || "없음"})`)
		return
	}
	const rawStartDate = rawStart.slice(0, 10)
	const isWeekly = reportType === REPORT_TYPE_WEEKLY
	const { start: periodStart, end: periodEnd } = isWeekly ? weekRange(rawStartDate) : monthRange(rawStartDate)

	// 클래스 DB "해당기간 보고서 생성 내역" 수식과 동일하게, 보고서 기간(periodStart~periodEnd)과
	// 등록 기간(등록일~종료일)이 겹치는 등록만 대상으로 함 (당일 등록생 포함).
	const registrations = await getActiveRegistrationsForClass(classId, periodStart, periodEnd)
	if (registrations.length === 0) {
		log.push(`[ok] ${className}: 대상 등록 없음`)
		return
	}

	let created = 0
	let skipped = 0
	let dedupCleaned = 0
	for (const reg of registrations) {
		const existingIds = await findReportForPeriod(reg.id, reportType, periodStart)
		if (existingIds.length > 1) {
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
		const [attendanceIds, recordIds, activityIds] = await Promise.all([
			findIdsInRange(DS_ATTENDANCE, "수업일시", reg.id, periodStart, periodEnd),
			findIdsInRange(DS_LEARNING_RECORD, "수업일", reg.id, periodStart, periodEnd),
			findIdsInRange(DS_STUDY_ACTIVITY, "수업일", reg.id, periodStart, periodEnd, "rollup_date"),
		])
		const periodLabel = isWeekly ? `${periodStart}~${periodEnd}` : periodStart.slice(0, 7)
		const title = `${reg.studentLabel} ${reportType} (${periodLabel})`
		await createPage(DS_REPORT, {
			보고서: { title: [{ text: { content: title.slice(0, 200) } }] },
			"보고서 기간": { date: { start: periodStart, end: periodEnd !== periodStart ? periodEnd : null } },
			"보고서 구분": { select: { name: reportType } },
			등록: { relation: [{ id: reg.id }] },
			출석: { relation: attendanceIds.map((id) => ({ id })) },
			학습기록: { relation: recordIds.map((id) => ({ id })) },
			학습활동: { relation: activityIds.map((id) => ({ id })) },
			// 이 건이 속한 알림톡 발송함(배치)과 연결 -- "일괄 전송" 버튼이 이 관계로 대상을 찾는다.
			[PROP_NOTIFICATION_BATCH_RELATION]: { relation: [{ id: batchId }] },
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

	// 이미 처리 중이면 새로 시작하지 않고 바로 반환 -- 처리 중 재클릭으로 인한 중복 생성 방지.
	const classPageForLock = await getPage(classId)
	if (checkboxValue(classPageForLock, CLASS_REPORT_RUNNING)) {
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
			console.log("generate-report finished:", classId, "\n", log.join("\n"))
			await setClassStatus(classId, "완료")
		} catch (err) {
			console.error("generate-report failed:", (err as Error).message, "\nlog so far:", log.join("\n"), "\nstack:", (err as Error).stack)
			await setClassStatus(classId, "오류", (err as Error).message)
		}
	})

	return respondAccepted({ classId })
})

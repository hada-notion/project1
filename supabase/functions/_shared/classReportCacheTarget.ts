// _shared/classReportCacheTarget.ts
//
// sync-class-report-cache가 처리하는 실제 리포트 재가결산 로직을 별도 파일로 분리했다
// (2026-09-18, 큐 기반 순차 처리 도입, Phase 2). 원래 index.ts 안에 있던 코드를 그대로 옮긴 것이다.

import { getPage, queryAllPages, mapWithConcurrency } from "./notionClient.ts"
import { makePageCache, upsertReportCacheRows, type ReportCacheRow } from "./reportCacheShared.ts"
import { buildCacheRowForRegistration } from "./reportCacheBuilder.ts"
import { makeClassStatusSetter } from "./generateShared.ts"

// 등록(학원) DB. sync-report-cache/index.ts와 동일한 고정값.
export const DS_REGISTRATION = "16dba040-586b-838a-ae3c-876c0e9cd474"

export const CLASS_REPORT_SYNC_RUNNING = "학생 페이지 동기화중"
export const setClassStatus = makeClassStatusSetter(CLASS_REPORT_SYNC_RUNNING)

// 이 클래스에 속하고 리포트 토큰이 발급된(=학보 리포트 링크가 생성된) 등록만 대상으로 한다.
export async function processClass(classId: string): Promise<string> {
	const registrations = await queryAllPages(DS_REGISTRATION, {
		and: [
			{ property: "클래스", relation: { contains: classId } },
			{ property: "토큰", rich_text: { is_not_empty: true } },
		],
	})
	if (registrations.length === 0) return "대상 등록 없음 (리포트 토큰이 발급된 학생이 없음)"

	const cachedGetPage = makePageCache()
	const rows = await mapWithConcurrency(registrations, 4, (reg: any) => buildCacheRowForRegistration(reg, cachedGetPage))
	const validRows = rows.filter((r): r is ReportCacheRow => r != null)
	await upsertReportCacheRows(validRows)
	return `동기화 ${validRows.length}건, 스킵 ${rows.length - validRows.length}건 (대상 ${registrations.length}건)`
}

// process-sync-queue 워커가 target: "sync-class-report-cache" 작업을 처리할 때 호출하는 진입점.
export async function processSyncClassReportCacheQueueItem(payload: { classId: string }): Promise<void> {
	try {
		const summary = await processClass(payload.classId)
		console.log("sync-class-report-cache (queue) finished:", payload.classId, summary)
		await setClassStatus(payload.classId, "완료")
	} catch (err) {
		console.error("sync-class-report-cache (queue) failed:", (err as Error).message, "\nstack:", (err as Error).stack)
		await setClassStatus(payload.classId, "오류", (err as Error).message)
		throw err
	}
}

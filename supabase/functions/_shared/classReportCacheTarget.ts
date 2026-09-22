// _shared/classReportCacheTarget.ts
//
// sync-class-report-cache가 처리하는 실제 리포트 재가결산 로직을 별도 파일로 분리했다
// (2026-09-18, 큐 기반 순차 처리 도입, Phase 2). 원래 index.ts 안에 있던 코드를 그대로 옮긴 것이다.

import { getPage, queryAllPages, mapWithConcurrency } from "./notionClient.ts"
import { makePageCache, upsertReportCacheRows, type ReportCacheRow } from "./reportCacheShared.ts"
import { buildCacheRowForRegistration } from "./reportCacheBuilder.ts"
import { markDone, markError, type StatusSpec } from "./statusTracking.ts"
import { DS_REGISTRATION, PROP_LAST_ERROR } from "./constants.ts"
// (2026-09-21, 이식성 리팩토링) 등록(학원) DB ID를 여기서도 하드코딩하지 않고 constants.ts에서
// 가져온다 (다른 여러 파일과 동일한 값).

// (2026-09-22, 처리 상태 관리 리팩토링 Phase 3) "학생 페이지 동기화중" 체크박스 -> "학생 페이지
// 동기화 상태"(select) + "학생 페이지 동기화 처리 시작 시각"(date). index.ts(락 확인+시작)와 이
// 파일(완료/오류 반영, 큐 워커에서 직접 호출) 양쪽에서 써서 export한다. 마스터플랜:
// https://app.notion.com/p/903c90386c1d473494c5df6306c53517
export const CLASS_REPORT_SYNC_STATUS_SPEC: StatusSpec = {
	statusProp: "학생 페이지 동기화 상태",
	errorProp: PROP_LAST_ERROR,
	startedAtProp: "학생 페이지 동기화 처리 시작 시각",
}

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
		await markDone(payload.classId, CLASS_REPORT_SYNC_STATUS_SPEC)
	} catch (err) {
		console.error("sync-class-report-cache (queue) failed:", (err as Error).message, "\nstack:", (err as Error).stack)
		await markError(payload.classId, CLASS_REPORT_SYNC_STATUS_SPEC, (err as Error).message)
		throw err
	}
}

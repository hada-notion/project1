// _shared/statusTracking.ts
//
// (2026-09-21, 처리 상태 관리 리팩토링 Phase 1) 여러 DB/함수가 반복해온 "OO 처리중"(checkbox) +
// "마지막 오류"(text) + "실시간 처리 상태"(formula) 3종 조합을, 상태(select) 속성 하나로 정리하기
// 위한 공용 헬퍼. 기존 setCombinedSyncStatus(registrationSync.ts/generateShared.ts)와
// markGenRunning/markGenDone/markGenError류(generate-classes)를 점진적으로 이걸로 교체한다.
// 마스터플랜: https://app.notion.com/p/903c90386c1d473494c5df6306c53517
//
// 상태값 5종: ⚪ 대기 / 🔄 작업중 / ✅ 완료 / ⚠️ 오류 / ⏱️ 타임아웃 복구
//
// 배경: notionClient.ts의 fetchWithRetry는 429/5xx는 재시도하지만 fetch 자체에 타임아웃이 없어서,
// Notion API 호출 하나가 응답 없이 멈추면 그 작업의 "완료" 신호가 영원히 오지 않는다 -- 실제로
// generate-classes(시간표 일괄 생성)에서 이 방식으로 "작업중" 체크박스가 몇 분씩 멈춘 사례가
// 나왔다(2026-09-21). 네트워크 계층의 근본 한계라 완전히 막을 수는 없으므로, 대신 "작업중"으로
// 바뀐 시각을 항상 함께 기록해두고, 워치독(sweepStaleStatus)이 주기적으로 돌면서 임계값보다
// 오래 걸린 항목을 스스로 회수하게 한다 -- process-sync-queue의 recoverStaleSyncQueueItems와
// 같은 원리를, Postgres sync_queue 테이블이 아니라 Notion 페이지 속성에 대해 적용한 버전이다.

import { queryAllPages, updatePageProperties } from "./notionClient.ts"

export const STATUS_IDLE = "⚪ 대기"
export const STATUS_RUNNING = "🔄 작업중"
export const STATUS_DONE = "✅ 완료"
export const STATUS_ERROR = "⚠️ 오류"
export const STATUS_TIMEOUT_RECOVERED = "⏱️ 타임아웃 복구"

export type StatusSpec = {
	// select 속성 이름 (예: "상태")
	statusProp: string
	// 오류 메시지 본문을 담는 text 속성 이름 (예: "마지막 오류")
	errorProp: string
	// "작업중"으로 바뀐 시점을 기록하는 date 속성 이름 (예: "처리 시작 시각") — 워치독 판단 기준.
	startedAtProp: string
}

function selectName(page: any, propName: string): string | undefined {
	return page?.properties?.[propName]?.select?.name
}

// 이미 로드한 page 객체가 현재 "작업중"인지 확인한다. 기존
// checkboxValue(page, lockProp) 호출부를 그대로 대체할 수 있는 시그니처로 맞췄다.
export function isRunning(page: any, spec: StatusSpec): boolean {
	return selectName(page, spec.statusProp) === STATUS_RUNNING
}

// 처리 시작: 상태를 "작업중"으로, 시작 시각을 지금으로 기록하고 이전 오류는 비운다.
// (이전 setCombinedSyncStatus의 phase: "start" / markGenRunning(id, true)에 대응)
export async function markRunning(pageId: string, spec: StatusSpec): Promise<void> {
	await updatePageProperties(pageId, {
		[spec.statusProp]: { select: { name: STATUS_RUNNING } },
		[spec.errorProp]: { rich_text: [] },
		[spec.startedAtProp]: { date: { start: new Date().toISOString() } },
	})
}

// 처리 완료: 상태를 "완료"로, 오류는 비운다.
// (이전 setCombinedSyncStatus의 phase: "success" / markGenDone(id)에 대응)
export async function markDone(pageId: string, spec: StatusSpec): Promise<void> {
	await updatePageProperties(pageId, {
		[spec.statusProp]: { select: { name: STATUS_DONE } },
		[spec.errorProp]: { rich_text: [] },
	})
}

// 처리 실패: 상태를 "오류"로, 오류 메시지를 기록한다.
// (이전 setCombinedSyncStatus의 phase: "error" / markGenError(id, message)에 대응)
export async function markError(pageId: string, spec: StatusSpec, message: string): Promise<void> {
	await updatePageProperties(pageId, {
		[spec.statusProp]: { select: { name: STATUS_ERROR } },
		[spec.errorProp]: { rich_text: [{ text: { content: message.slice(0, 1900) } }] },
	})
}

// 범용 워치독: dataSourceId 안에서 "작업중" 상태가 staleMinutes보다 오래 지속된 행을 찾아
// "⏱️ 타임아웃 복구"로 되돌리고 마지막 오류에 회수 사실을 남긴다. dataSourceId+spec을 그대로
// 인자로 받아서 여러 DB/속성 조합에 재사용할 수 있게 했다 (Phase 4에서 크론이 대상 목록을
// 순회하며 이 함수를 반복 호출하는 구조를 만든다).
export async function sweepStaleStatus(
	dataSourceId: string,
	spec: StatusSpec,
	staleMinutes = 15,
): Promise<{ recovered: number; ids: string[] }> {
	const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString()
	const stalePages = await queryAllPages(dataSourceId, {
		and: [
			{ property: spec.statusProp, select: { equals: STATUS_RUNNING } },
			{ property: spec.startedAtProp, date: { before: cutoff } },
		],
	})

	const ids: string[] = []
	for (const page of stalePages) {
		try {
			await updatePageProperties(page.id, {
				[spec.statusProp]: { select: { name: STATUS_TIMEOUT_RECOVERED } },
				[spec.errorProp]: {
					rich_text: [
						{
							text: {
								content: `⏱️ ${staleMinutes}분 넘게 "작업중" 상태로 멈춰 있어 워치독이 자동으로 회수함 (${new Date().toISOString()})`,
							},
						},
					],
				},
			})
			ids.push(page.id)
		} catch (err) {
			console.error(`[sweepStaleStatus] ${dataSourceId} ${page.id} 회수 실패:`, (err as Error).message)
		}
	}
	if (ids.length > 0) {
		console.log(`[sweepStaleStatus] ${dataSourceId}.${spec.statusProp}: stale ${ids.length}건 회수함`, ids)
	}
	return { recovered: ids.length, ids }
}

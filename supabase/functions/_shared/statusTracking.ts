// _shared/statusTracking.ts
//
// (2026-09-21, 처리 상태 관리 리팩토링 Phase 1) 여러 DB/함수가 반복해온 "OO 처리중"(checkbox) +
// "마지막 오류"(text) + "실시간 처리 상태"(formula) 3종 조합을, 상태(select) 속성 하나로 정리하기
// 위한 공용 헬퍼. 기존 setCombinedSyncStatus(registrationSync.ts/generateShared.ts)와
// markGenRunning/markGenDone/markGenError류(generate-classes)를 점진적으로 이걸로 교체한다.
// 마스터플랜: https://app.notion.com/p/903c90386c1d473494c5df6306c53517
//
// 상태값 6종: ⚪ 대기 / ⏳ 대기열 / 🔄 작업중 / ✅ 완료 / ⚠️ 오류 / ⏱️ 타임아웃 복구
//
// 배경: notionClient.ts의 fetchWithRetry는 429/5xx는 재시도하지만 fetch 자체에 타임아웃이 없어서,
// Notion API 호출 하나가 응답 없이 멈추면 그 작업의 "완료" 신호가 영원히 오지 않는다 -- 실제로
// generate-classes(시간표 일괄 생성)에서 이 방식으로 "작업중" 체크박스가 몇 분씩 멈춘 사례가
// 나왔다(2026-09-21). 네트워크 계층의 근본 한계라 완전히 막을 수는 없으므로, 대신 "작업중"으로
// 바뀐 시각을 항상 함께 기록해두고, 워치독(sweepStaleStatus)이 주기적으로 돌면서 임계값보다
// 오래 걸린 항목을 스스로 회수하게 한다 -- process-sync-queue의 recoverStaleSyncQueueItems와
// 같은 원리를, Postgres sync_queue 테이블이 아니라 Notion 페이지 속성에 대해 적용한 버전이다.
//
// (2026-09-22, Phase 6: 동시성 제어) 큐(sync_queue)를 거치는 함수들은 지금까지 "웹훅 접수 즉시"
// markRunning을 호출했다 — 그런데 process-sync-queue가 동시에 N개까지만 실제로 처리하도록
// 바뀌면서, "접수는 됐지만 아직 실제로 처리를 시작하지 않은" 항목과 "지금 진짜로 Notion API를
// 두드리고 있는" 항목을 구분할 필요가 생겼다(안 그러면 한꺼번에 여러 페이지를 클릭했을 때 전부
// "🔄 작업중"으로 보여서, 실제로는 N개만 동시에 처리되고 있다는 사실이 화면에 드러나지 않는다).
// 그래서 STATUS_QUEUED("⏳ 대기열")를 추가했다: 웹훅 접수 시점엔 markQueued로 이 값을 쓰고,
// process-sync-queue가 실제로 그 항목을 집어서 처리를 시작하는 순간에만 markRunning("🔄 작업중")을
// 호출한다. 마스터플랜: https://app.notion.com/p/903c90386c1d473494c5df6306c53517

import { queryAllPages, updatePageProperties } from "./notionClient.ts"

export const STATUS_IDLE = "⚪ 대기"
export const STATUS_QUEUED = "⏳ 대기열"
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

// 이미 로드한 page 객체가 지금 "접수되어 있는"(대기열 대기 중이거나 실제로 작업 중인) 상태인지
// 확인한다. 기존 checkboxValue(page, lockProp) 호출부를 그대로 대체할 수 있는 시그니처로 맞췄다.
// (2026-09-22, Phase 6) 중복 클릭 방지 목적상 "⏳ 대기열"도 "이미 접수됨"으로 취급해야 한다 —
// 대기열에 있는 걸 못 보고 또 접수하면 같은 페이지가 큐에 중복으로 쌓인다.
export function isRunning(page: any, spec: StatusSpec): boolean {
	const v = selectName(page, spec.statusProp)
	return v === STATUS_RUNNING || v === STATUS_QUEUED
}

// "지금 실제로 Notion API를 두드리며 처리 중"인지만 좁게 확인한다 (대기열은 제외). 워치독처럼
// "진짜로 멈춰있는 작업"만 다뤄야 하는 곳에서 isRunning 대신 이걸 쓴다.
export function isActivelyRunning(page: any, spec: StatusSpec): boolean {
	return selectName(page, spec.statusProp) === STATUS_RUNNING
}

// (2026-09-23) isRunning과 같지만, "작업중/대기열"로 바뀐 지 staleMinutes분이 넘었으면 이미 죽은
// 실행(플랫폼 실행시간 한도로 조용히 죽어서 완료/오류 표시를 못 남긴 경우)일 가능성이 높다고 보고
// false(=이제 다시 처리해도 됨)를 돌려준다. generate-classes처럼 사용자가 버튼을 다시 눌렀을 때
// 워치독(기본 15분)까지 기다리지 않고 바로 재시도되길 원하는 곳에서 옵트인으로 쓴다 — 다른 곳에
// 영향 없도록 isRunning 자체는 그대로 두고 새 함수로 분리했다. staleMinutes는 호출부가 그 작업의
// 플랫폼 실행시간 한도(Supabase Edge Function은 약 150초)보다 넉넉히 크게 잡아야, 아직 살아서
// 정상적으로 처리 중인 항목을 오판해 중복 처리하는 일이 없다.
export function isRunningFresh(page: any, spec: StatusSpec, staleMinutes: number): boolean {
	const v = selectName(page, spec.statusProp)
	if (v !== STATUS_RUNNING && v !== STATUS_QUEUED) return false
	const startedAtIso: string | undefined = page?.properties?.[spec.startedAtProp]?.date?.start
	if (!startedAtIso) return true // 시작 시각을 못 읽으면 안전하게 "아직 실행 중"으로 취급
	const startedAtMs = new Date(startedAtIso).getTime()
	if (Number.isNaN(startedAtMs)) return true
	return Date.now() - startedAtMs < staleMinutes * 60_000
}

// (2026-09-22, Phase 6) 큐에 접수만 되고 아직 실제 처리가 시작되지 않은 상태로 표시한다.
// "처리 시작 시각"은 아직 기록하지 않는다 — 실제로 작업이 시작될 때 markRunning이 기록해야
// 워치독이 "대기열에 오래 있었을 뿐인 항목"을 "멈춘 작업"으로 오판하지 않는다.
export async function markQueued(pageId: string, spec: StatusSpec): Promise<void> {
	await updatePageProperties(pageId, {
		[spec.statusProp]: { select: { name: STATUS_QUEUED } },
		[spec.errorProp]: { rich_text: [] },
	})
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

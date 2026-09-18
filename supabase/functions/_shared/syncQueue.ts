// _shared/syncQueue.ts
//
// 동기화 웹훅 대기열 공용 헬퍼. 여러 Notion DB에서 동시에 웹훅이 들어와도, 실제 무거운 처리는
// process-sync-queue 워커가 "생성된 순서대로 하나씩만" 처리하도록 만들기 위한 큐 적재/조회 함수
// 모음이다 (2026-09-18, 큐 기반 순차 처리 도입). 각 웹훅 함수(sync-report-cache 등)는 요청을 받으면
// 이 파일의 enqueueSync()로 큐에 한 건 적재하고 곧바로 202를 반환한다. 실제 처리 로직은
// process-sync-queue/index.ts가 target별로 나눠서 호출한다.

import { fetchSupabaseWithRetry } from "./reportCacheShared.ts"

const SB_URL = Deno.env.get("SB_URL") ?? ""
const SB_SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""

function requireEnv() {
  if (!SB_URL || !SB_SERVICE_ROLE_KEY) {
    throw new Error("SB_URL / SB_SERVICE_ROLE_KEY Secrets가 설정되어 있지 않습니다. Supabase 대시보드 Edge Functions Secrets에 추가하세요.")
  }
}

function authHeaders() {
  return {
    apikey: SB_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  }
}

export type SyncQueueItem = {
  id: number
  target: string
  payload: Record<string, unknown>
  status: string
  attempts: number
  last_error: string | null
}

// 큐에 작업 1건을 적재한다. 실패하면 그대로 throw한다 -- 웹훅 함수 쪽에서 그대로 500을 반환하게
// 해서, Notion 자동화 화면에 실패가 보이게 한다 (조용히 삼켜서 이벤트를 유실시키는 것보다
// 눈에 보이는 실패가 낫다). fetchSupabaseWithRetry가 이미 일시적인 401/5xx는 재시도한다.
export async function enqueueSync(target: string, payload: Record<string, unknown>): Promise<void> {
  requireEnv()
  const res = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/sync_queue`, {
    method: "POST",
    headers: { ...authHeaders(), Prefer: "return=minimal" },
    body: JSON.stringify([{ target, payload }]),
  })
  if (!res.ok) {
    throw new Error(`sync_queue 적재 실패: ${res.status} ${await res.text()}`)
  }
}

// 큐에 쌓인 작업을 지금 바로 처리하도록 워커를 깨운다 (지연시간을 줄이기 위한 것일 뿐이므로,
// 실패해도 조용히 무시한다 -- 어차피 pg_cron이 매분 안전망으로 다시 깨워준다).
export function wakeSyncQueueWorker(): void {
  if (!SB_URL) return
  fetch(`${SB_URL}/functions/v1/process-sync-queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "wake" }),
  }).catch((err) => {
    console.error("[wakeSyncQueueWorker] 워커 즉시 트리거 실패 (pg_cron이 대신 처리함):", (err as Error)?.message)
  })
}

export async function tryAcquireWorkerLock(leaseSeconds = 120): Promise<boolean> {
  requireEnv()
  const res = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/rpc/try_acquire_sync_queue_lock`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ lease_seconds: leaseSeconds }),
  })
  if (!res.ok) throw new Error(`try_acquire_sync_queue_lock 실패: ${res.status} ${await res.text()}`)
  return (await res.json()) === true
}

export async function releaseWorkerLock(): Promise<void> {
  requireEnv()
  const res = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/rpc/release_sync_queue_lock`, {
    method: "POST",
    headers: authHeaders(),
    body: "{}",
  })
  if (!res.ok) {
    console.error(`release_sync_queue_lock 실패 (lease가 만료될 때까지 잠금이 유지됨): ${res.status} ${await res.text()}`)
  }
}

export async function claimNextSyncQueueItem(): Promise<SyncQueueItem | null> {
  requireEnv()
  const res = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/rpc/claim_next_sync_queue_item`, {
    method: "POST",
    headers: authHeaders(),
    body: "{}",
  })
  if (!res.ok) throw new Error(`claim_next_sync_queue_item 실패: ${res.status} ${await res.text()}`)
  const rows = await res.json()
  return rows?.[0] ?? null
}

export async function markSyncQueueItemDone(id: number): Promise<void> {
  requireEnv()
  const res = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/sync_queue?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...authHeaders(), Prefer: "return=minimal" },
    body: JSON.stringify({ status: "done", finished_at: new Date().toISOString(), last_error: null }),
  })
  if (!res.ok) console.error(`sync_queue #${id} done 표시 실패: ${res.status} ${await res.text()}`)
}

export async function markSyncQueueItemFailed(id: number, errorMessage: string): Promise<void> {
  requireEnv()
  const res = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/sync_queue?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...authHeaders(), Prefer: "return=minimal" },
    body: JSON.stringify({ status: "failed", finished_at: new Date().toISOString(), last_error: errorMessage.slice(0, 1900) }),
  })
  if (!res.ok) console.error(`sync_queue #${id} failed 표시 실패: ${res.status} ${await res.text()}`)
}

// 큐에 pending 상태인 작업이 남아있는지 확인한다 (워커가 시간 예산을 다 쓰고 멈췄을 때, 남은 작업이
// 있으면 스스로를 다시 깨워서 다음 pg_cron 주기(최대 1분)까지 기다리지 않고 계속 이어가게 한다).
export async function hasPendingSyncQueueItems(): Promise<boolean> {
  requireEnv()
  const res = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/sync_queue?status=eq.pending&select=id&limit=1`, {
    headers: authHeaders(),
  })
  if (!res.ok) return false
  const rows = await res.json()
  return Array.isArray(rows) && rows.length > 0
}

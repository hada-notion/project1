// _shared/syncQueue.ts
//
// 동기화 웹훅 대기열 공용 헬퍼. 여러 Notion DB에서 동시에 웹훅이 들어와도, 실제 무거운 처리는
// process-sync-queue 워커가 "생성된 순서대로 하나씩만" 처리하도록 만들기 위한 큐 적재/조회 함수
// 모음이다 (2026-09-18, 큐 기반 순차 처리 도입). 각 웹훅 함수(sync-report-cache 등)는 요청을 받으면
// 이 파일의 enqueueSync()로 큐에 한 건 적재하고 곧바로 202를 반환한다. 실제 처리 로직은
// process-sync-queue/index.ts가 target별로 나눠서 호출한다.

import { fetchSupabaseWithRetry } from "./reportCacheShared.ts"
import { getCurrentAdminKey } from "./adminShared.ts"

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
// (2026-09-21, process-sync-queue 인증 추가) process-sync-queue가 이제 requireAdminKey로 보호되므로,
// 이 내부 호출도 x-admin-key 헤더를 함께 보내야 한다. getCurrentAdminKey()를 그대로 써서 KV에
// 저장된 관리자 비밀번호 변경이 있어도(admin.html에서 재발급) 항상 최신 값과 일치하게 한다.
export function wakeSyncQueueWorker(): void {
  if (!SB_URL) return
  getCurrentAdminKey()
    .then((adminKey) =>
      fetch(`${SB_URL}/functions/v1/process-sync-queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify({ source: "wake" }),
      }),
    )
    .catch((err) => {
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

// (2026-09-21, 워커 락 리스 연장 도입) 처리 루프가 길어질 때 120초 리스가 중간에 만료되지 않도록,
// process-sync-queue가 처리 도중 주기적으로(약 60초마다) 호출해서 리스를 다시 120초로 늘린다.
// 실패해도 throw하지 않고 조용히 로그만 남긴다 -- 이 호출이 실패한다고 지금 처리 중인 항목을
// 멈출 이유는 없고, 최악의 경우에도 recoverStaleSyncQueueItems(15분 기준)가 나중에 정리해준다.
export async function renewWorkerLock(leaseSeconds = 120): Promise<void> {
  requireEnv()
  const res = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/rpc/renew_sync_queue_lock`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ lease_seconds: leaseSeconds }),
  })
  if (!res.ok) {
    console.error(`renew_sync_queue_lock 실패: ${res.status} ${await res.text()}`)
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

// (2026-09-18 밤) 처리 중 오류가 나면 지금까지는 곧바로 failed로 확정해서 재시도가 전혀 없었다.
// 이제 시도 횟수(item.attempts, claim_next_sync_queue_item이 집을 때마다 이미 +1 되어 있는 값)가
// 한도 미만이면 pending으로 되돌려 다시 시도할 기회를 주고, 한도에 도달했을 때만 failed로 확정한다.
// 이 재시도는 각 target 핸들러가 처리 전 현재 상태를 확인하고 진행하도록 설계되어 있다는 전제 하에
// 안전하다 -- create-assignment(학습기록당 학습활동 1회 생성 확인 추가)와 create-learning-record
// ("오늘 학습" 체크를 생성 전에 먼저 소비)도 이 전제에 맞게 함께 정리했다(2026-09-18).
export async function markSyncQueueItemFailedOrRetry(
  item: SyncQueueItem,
  errorMessage: string,
  maxAttempts = 3,
): Promise<"retrying" | "failed"> {
  requireEnv()
  const willRetry = item.attempts < maxAttempts
  const res = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/sync_queue?id=eq.${item.id}`, {
    method: "PATCH",
    headers: { ...authHeaders(), Prefer: "return=minimal" },
    body: JSON.stringify(
      willRetry
        ? { status: "pending", updated_at: new Date().toISOString(), last_error: errorMessage.slice(0, 1900) }
        : { status: "failed", finished_at: new Date().toISOString(), last_error: errorMessage.slice(0, 1900) },
    ),
  })
  if (!res.ok) {
    console.error(`sync_queue #${item.id} 재시도/실패 표시 실패: ${res.status} ${await res.text()}`)
  }
  return willRetry ? "retrying" : "failed"
}

// (2026-09-18 밤) 워커 프로세스 자체가 중간에 죽어서(배포 중 재시작, 메모리 부족 등) processing
// 상태로 영원히 멈춰있는 작업을 찾아 되돌린다. stale_after_seconds는 이 워커의 정상적인 처리
// 시간(전체 루프 예산 100초, 잠금 리스 120초)보다 훨씬 여유있게 큰 기본값(15분)을 쓴다 -- 너무
// 짧게 잡으면 실제로는 아직 살아서 느리게 처리 중인 작업을 오작동으로 잘못 판단해 되돌려, 두 워커가
// 같은 작업을 동시에 처리하는 위험(중복 생성)이 생길 수 있기 때문이다.
export async function recoverStaleSyncQueueItems(staleAfterSeconds = 900, maxAttempts = 3): Promise<number> {
  requireEnv()
  const res = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/rpc/recover_stale_sync_queue_items`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ stale_after_seconds: staleAfterSeconds, max_attempts: maxAttempts }),
  })
  if (!res.ok) {
    console.error(`recover_stale_sync_queue_items 실패: ${res.status} ${await res.text()}`)
    return 0
  }
  const rows = await res.json()
  return Array.isArray(rows) ? rows.length : 0
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

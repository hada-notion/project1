// _shared/dashboardDateLock.ts
//
// findOrCreateDashboard()(dashboardLinkTarget.ts)가 같은 날짜의 대시보드(학원) 페이지를 두 번
// 만드는 것을 막기 위한 날짜별 단기 잠금 헬퍼. (2026-09-23, 대시보드 중복 생성 방지 -- 사용자가
// 같은 날짜에 대시보드가 여러 개 만들어져 있는 걸 발견해서 원인을 찾아 고쳤다.)
//
// 원인: findOrCreateDashboard()는 "이 날짜의 대시보드가 이미 있는지 조회 -> 없으면 새로 만들기"
// 패턴인데, 이 두 단계가 원자적이지 않았다. 같은 날짜를 대상으로 하는 두 호출이 거의 동시에 조회
// 단계를 지나가면 둘 다 "없음"으로 보고 각자 새 대시보드를 만들 수 있다. 특히
// nightly-dashboard-link-audit이 mapWithConcurrency(..., 3, ...)으로 여러 건을 동시에 처리할 때
// 발생하기 쉬웠다(여러 반이 같은 요일에 몰려 있으면, 동시에 처리되는 최대 3건 중 여러 건이 같은
// 날짜를 가리키는 경우가 흔함).
//
// 실제 잠금 테이블/RPC 함수는 supabase/migrations/20260923000000_dashboard_date_lock.sql 참고
// (sync_queue_worker_lock과 동일한 "테이블 행 기반 리스(lease) 잠금" 패턴 -- Edge Function 호출은
// 매번 별도의 짧은 연결이라 세션 기반 advisory lock을 쓸 수 없기 때문).

import { fetchSupabaseWithRetry } from "./reportCacheShared.ts"

const SB_URL = Deno.env.get("SB_URL") ?? ""
const SB_SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""

function authHeaders() {
  return {
    apikey: SB_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  }
}

async function tryAcquire(dateKey: string, leaseSeconds: number): Promise<boolean> {
  if (!SB_URL || !SB_SERVICE_ROLE_KEY) return false
  const res = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/rpc/try_acquire_dashboard_date_lock`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ p_date_key: dateKey, lease_seconds: leaseSeconds }),
  })
  if (!res.ok) return false
  return (await res.json()) === true
}

async function release(dateKey: string): Promise<void> {
  if (!SB_URL || !SB_SERVICE_ROLE_KEY) return
  try {
    const res = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/rpc/release_dashboard_date_lock`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ p_date_key: dateKey }),
    })
    if (!res.ok) {
      console.error(`release_dashboard_date_lock(${dateKey}) 실패: ${res.status} ${await res.text()}`)
    }
  } catch (err) {
    console.error(`release_dashboard_date_lock(${dateKey}) 오류:`, (err as Error)?.message)
  }
}

// dateKey(예: "2026-10-28") 하나에 대해서는 fn이 항상 한 번에 하나만 실행되도록 보장한 뒤 실행한다.
// 최대 10초 동안 300ms 간격으로 짧게 재시도하고, 그래도 잠금을 못 얻으면(예: Secrets 누락, Supabase
// 일시 장애) 잠금 없이 그냥 진행한다 -- 이 잠금은 "중복 생성을 막기 위한 보강"이고, 잠금 메커니즘
// 자체의 장애가 대시보드 연결 기능 전체를 막아서는 안 되기 때문이다.
export async function withDashboardDateLock<T>(dateKey: string, fn: () => Promise<T>): Promise<T> {
  const leaseSeconds = 30
  const deadline = Date.now() + 10_000
  let acquired = false
  while (Date.now() < deadline) {
    acquired = await tryAcquire(dateKey, leaseSeconds).catch(() => false)
    if (acquired) break
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  if (!acquired) {
    console.warn(`[dashboardDateLock] ${dateKey} 잠금을 얻지 못해 잠금 없이 진행함 (중복 생성 위험이 남을 수 있음)`)
  }
  try {
    return await fn()
  } finally {
    if (acquired) await release(dateKey)
  }
}

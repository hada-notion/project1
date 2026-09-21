// POST /functions/v1/process-sync-queue
//
// sync_queue에 쌓인 작업을 "생성된 순서대로 하나씩만" 꾼내서 처리하는 전용 워커.
// (2026-09-18, 큐 기반 순차 처리 도입 -- 배경 설명은 _shared/syncQueue.ts, sync-report-cache/index.ts 참고)
//
// 두 가지 경로로 호출된다:
//   1) 각 웹훅 함수가 작업을 적재한 직후 fire-and-forget으로 즉시 호출 (지연시간 줄이기용, 실패해도
//      무시될 -- _shared/syncQueue.ts의 wakeSyncQueueWorker).
//   2) pg_cron이 매분 호출하는 안전망 (즉시 트리거가 실패/유실되거나, 처리 중 이 함수 자체가
//      시간 예산을 다 쓰고 멈춰도 다음 분에 이어서 처리하도록).
//
// 동시에 여러 번 호출돼도(즉시 트리거 + 마침 겡친 cron 등) 실제 처리가 격지지 않도록,
// public.sync_queue_worker_lock 테이블 기반의 리스(lease) 잠금을 먼저 얻어야 시작한다. 잠금을 못
// 얻으면 (이미 다른 실행이 돌고 있다는 뜻) 바로 조용히 끝난다 -- 이렇게 해서 아무리 많은 요청이
// 동시에 몰려도 실제 처리는 항상 한 번에 하나씩, 큐에 쌓인 순서대로만 진행된다.
//
// (2026-09-18, Phase 2~3 / 2026-09-20, 웹훅 코드 정리 2단계) 한때 이 워커가 처리하던 target은
// cascade-delete / create-assignment / create-learning-record / sync-textbook-distribution
// (from-cart, from-class-carts) / sync-class-report-cache / fix-attendance / sync-exam-scope /
// sync-registration-enroll / sync-registration-end / sync-registration-timetable / sync-registration-textbook
// (create-individual) / sync-dashboard-link / sync-registration-class-session까지 총 15개였다.
// 당시에는 "여러 DB에서 동시에 웹훅이 몰릴 수 있으니 전부 큐로" 라는 방향으로 일관되게 통일했었다.
//
// (2026-09-22, PART N-4: 개별 트리거 버튼 동기화 전환) 그런데 돌이켜보면 이 target들 중 대부분은
// "한 페이지에서 누른 버튼 1건"이라는 개별(단건) 트리거였고, 실제 작업도 Notion API 호출 몇 건
// 수준으로 가벼웠다. 큐를 거치면 (a) 실제 완료 시점과 무관하게 버튼 클릭 즉시 202가 떨어져서
// "실시간 처리 상태"가 진짜 완료 훨씬 전에 사라져 보이고, (b) 지금 이 워커(즉시 트리거 또는 최대
// 1분 뒤 cron)가 실제로 돌 때까지 사용자가 기다려야 하는 불필요한 지연이 생겼다 (등록(학원) DB
// "등록" 버튼이 실제로 오래 멈춰 보이는 사고로 이어짐 -- PART N-2가 이 워커에 관리자 키 인증을
// 추가하면서, 그동안 숨어있던 wakeSyncQueueWorker의 EdgeRuntime.waitUntil 누락 버그가 겉으로
// 드러난 사례). "개별 트리거는 즉시 동기 처리, 일괄(여러 페이지를 한 번에 대상으로 하는) 트리거만
// 큐 사용"이라는 원칙으로 정리하면서, 아래 셋만 이 워커에 남기고 나머지는 각자의 index.ts가
// 실제 처리 함수를 직접 호출하는 동기 방식으로 되돌렸다 (_shared/webhookIngest.ts의
// runSyncWebhookForPage/handleSyncWebhook 참고):
//   - create-learning-record: 트리거 DB(수업/출석)와 무관하게 항상 그 수업 세션의 로스터
//     전체(여러 학생)를 처리하는 내부 구조라, 어느 쪽에서 호출되든 실질적으로 "일괄" 작업이다.
//   - sync-textbook-distribution:from-class-carts: 클래스(학원) DB "교재비 생성" 버튼 —
//     명시적으로 반 전체(여러 등록)를 대상으로 하는 일괄 버튼.
//   - sync-class-report-cache: 클래스 단위로 여러 등록의 보고서 캐시를 한 번에 재계산하는 일괄 작업.

import {
  tryAcquireWorkerLock,
  releaseWorkerLock,
  renewWorkerLock,
  claimNextSyncQueueItem,
  markSyncQueueItemDone,
  markSyncQueueItemFailedOrRetry,
  recoverStaleSyncQueueItems,
  hasPendingSyncQueueItems,
  wakeSyncQueueWorker,
  type SyncQueueItem,
} from "../_shared/syncQueue.ts"
import { CORS_HEADERS, makePageCache } from "../_shared/reportCacheShared.ts"
import { requireAdminKey } from "../_shared/adminShared.ts"
import { processCreateLearningRecordQueueItem } from "../_shared/createLearningRecordTarget.ts"
import { processFromClassCartsQueueItem } from "../_shared/textbookDistributionTarget.ts"
import { processSyncClassReportCacheQueueItem } from "../_shared/classReportCacheTarget.ts"

// target별 실제 처리 함수. 앞으로 다른 "일괄(bulk)" 웹훅 함수가 추가되면 여기에 추가한다 (개별
// 트리거 버튼은 큐를 쓰지 않는다 -- 위 2026-09-22 주석 참고).
const HANDLERS: Record<string, (payload: any, cachedGetPage: (id: string) => Promise<any>) => Promise<void>> = {
  "create-learning-record": processCreateLearningRecordQueueItem,
  "sync-textbook-distribution:from-class-carts": processFromClassCartsQueueItem,
  "sync-class-report-cache": processSyncClassReportCacheQueueItem,
}

// Edge Function 자체의 실행 시간 한도보다 여유 있게 짧은 시간 예산 안에서만 계속 처리하고, 남으면
// 스스로를 다시 깨운다 (한 번의 실행이 시간 제한에 걸려 강제 종료되는 것보다, 미리 멈추고 이어가는
// 쪽이 처리 중이던 항목이 애매한 상태로 남을 위험이 적다).
const TIME_BUDGET_MS = 100_000

// (2026-09-18 밤) 이 값들보다 오래 processing 상태로 멈춰있으면 복구 대상으로 보고, 실패한 항목은
// 이 횟수까지만 재시도한다. 두 값 모두 target 전체에 동일하게 적용한다 (함수별로 실제 처리
// 시간 편차가 있을 수 있지만, 지금은 실측 데이터가 없어 안전 마진이 큰 값 하나로 통일했다).
const STALE_PROCESSING_SECONDS = 900 // 15분
const MAX_ATTEMPTS = 3

// (2026-09-21, 워커 락 리스 연장 도입) 리스(120초)보다 충분히 짧은 주기로 연장해서, 처리가
// 길어져도 리스가 먼저 만료되는 일이 없도록 한다.
const LOCK_RENEWAL_INTERVAL_MS = 60_000
const LOCK_LEASE_SECONDS = 120

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })

  // (2026-09-21, 인증 정책 감사 후속) 이 함수는 지금까지 인증이 전혀 없어서, URL만 알면 누구나
  // 큐 처리를 강제로 트리거할 수 있었다. 호출자는 (a) 남은 세 target(create-learning-record 등)의
  // wakeSyncQueueWorker, (b) pg_cron의 매분 안전망 두 곳뿐이라 관리자 키 인증을 그대로 적용한다.
  const authError = await requireAdminKey(req)
  if (authError) return authError

  const acquired = await tryAcquireWorkerLock(LOCK_LEASE_SECONDS).catch((err) => {
    console.error("[process-sync-queue] 잠금 획득 실패:", (err as Error)?.message)
    return false
  })
  if (!acquired) {
    return new Response(JSON.stringify({ ok: true, skipped: "already running" }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }

  let processed = 0
  let failed = 0
  let retried = 0
  const cachedGetPage = makePageCache()
  const deadline = Date.now() + TIME_BUDGET_MS

  // 60초마다 리스를 120초로 다시 연장해서, 처리 루프가 다 돌기 전에 리스가 만료되지 않도록 한다.
  const lockRenewalTimer = setInterval(() => {
    renewWorkerLock(LOCK_LEASE_SECONDS).catch((err) => {
      console.error("[process-sync-queue] 잠금 연장 중 오류:", (err as Error)?.message)
    })
  }, LOCK_RENEWAL_INTERVAL_MS)

  try {
    const recoveredCount = await recoverStaleSyncQueueItems(STALE_PROCESSING_SECONDS, MAX_ATTEMPTS).catch((err) => {
      console.error("[process-sync-queue] 멈춘 작업 복구 중 오류:", (err as Error)?.message)
      return 0
    })
    if (recoveredCount > 0) {
      console.log(`[process-sync-queue] 처리 중 상태로 멈춰있던 작업 ${recoveredCount}건을 복구함 (pending 또는 failed로 확정)`)
    }

    while (Date.now() < deadline) {
      const item: SyncQueueItem | null = await claimNextSyncQueueItem()
      if (!item) break

      const handler = HANDLERS[item.target]
      try {
        if (!handler) throw new Error(`알 수 없는 target: ${item.target}`)
        await handler(item.payload, cachedGetPage)
        await markSyncQueueItemDone(item.id)
        processed++
      } catch (err) {
        const message = String((err as Error)?.message ?? err)
        const outcome = await markSyncQueueItemFailedOrRetry(item, message, MAX_ATTEMPTS)
        if (outcome === "retrying") {
          retried++
          console.error(
            `[process-sync-queue] #${item.id} (target=${item.target}) 처리 실패, 재시도 예정 (시도 ${item.attempts}/${MAX_ATTEMPTS}):`,
            message,
          )
        } else {
          failed++
          console.error(
            `[process-sync-queue] #${item.id} (target=${item.target}) 처리 실패, 재시도 한도(${MAX_ATTEMPTS}회) 초과로 최종 실패:`,
            message,
          )
        }
      }
    }
  } finally {
    clearInterval(lockRenewalTimer)
    await releaseWorkerLock()
  }

  // 시간 예산을 다 쓰고 멈춰는데 아직 남은 작업이 있으면, 다음 pg_cron 주기(최대 1분)까지 기다리지
  // 않고 스스로를 한 번 더 깨운다.
  if (Date.now() >= deadline && (await hasPendingSyncQueueItems().catch(() => false))) {
    wakeSyncQueueWorker()
  }

  return new Response(JSON.stringify({ ok: true, processed, retried, failed }), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  })
})
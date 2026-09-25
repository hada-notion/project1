// POST /functions/v1/process-sync-queue
//
// sync_queue에 쌓인 작업을 "생성된 순서대로 하나씩만" 꺼내서 처리하는 전용 워커.
// (2026-09-18, 큐 기반 순차 처리 도입 -- 배경 설명은 _shared/syncQueue.ts, sync-report-cache/index.ts 참고)
//
// 두 가지 경로로 호출된다:
//   1) 각 웹훅 함수가 작업을 적재한 직후 fire-and-forget으로 즉시 호출 (지연시간 줄이기용, 실패해도
//      무시될 -- _shared/syncQueue.ts의 wakeSyncQueueWorker).
//   2) pg_cron이 매분 호출하는 안전망 (즉시 트리거가 실패/유실되거나, 처리 중 이 함수 자체가
//      시간 예산을 다 쓰고 멈춰도 다음 분에 이어서 처리하도록).
//
// 동시에 여러 번 호출돼도(즉시 트리거 + 마침 겹친 cron 등) 실제 처리가 겹치지 않도록,
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
//
// (2026-09-22, Phase 6: 동시성 제어) PART N-4/N-5 이후에도 "개별 트리거인데 사람이 여러 페이지를
// 동시에(멀티 셀렉트 등으로) 클릭하는" 시나리오는 여전히 남아있었다 -- cascade-delete(여러 수업/
// 출석 등을 한꺼번에 "삭제"), generate-report/generate-tuition(클래스 여러 개를 한꺼번에 "보고서
// 생성"/"수강료 생성")가 실제로 이렇게 쓰였다. 이때 (a) Notion API 호출이 동시에 너무 많이 몰려
// 하나가 응답 없이 멈추는 사고(이제 fetchWithRetry의 30초 타임아웃으로 완화)와 (b) 실제로는 몇 건만
// 동시에 처리되는데도 화면에는 클릭한 전부가 "🔄 작업중"으로 보여 실제 진행 상황을 알 수 없는 문제가
// 있었다. PART N-4가 지적한 지연 문제(당시엔 wakeSyncQueueWorker의 EdgeRuntime.waitUntil 누락
// 버그로 즉시 트리거가 거의 항상 유실되고 있었음)는 PART N-3에서 이미 고쳤으므로, 이제 큐를 다시
// 쓰더라도 부하가 없는 평소에는 지연이 거의 없다 -- 그래서 이 셋도 큐에 추가했다(처음엔 아래
// CONCURRENCY를 3으로 두고 동시에(순서 보장 없이) 처리하도록 했으나, 실제 운영 중 문제가 드러나
// 다시 1로 되돌렸다 -- 아래 CONCURRENCY 선언부 주석 참고). 마스터플랜:
// https://app.notion.com/p/903c90386c1d473494c5df6306c53517

// [현재 상태, 2026-09-25] 대시보드 관련 자동화와 직접 enqueue 호출은 제거됐다. 따라서
// sync-dashboard-link 핸들러와 전용 레인은 현재 새 작업을 받지 않는 휴면 경로다. 기존 큐 항목 처리와
// 향후 재설계 가능성을 위해 코드는 남겼으며, 삭제는 별도 구조 변경으로 다룬다.

import {
  tryAcquireWorkerLock,
  releaseWorkerLock,
  renewWorkerLock,
  claimNextSyncQueueItemForTargets,
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
import { processCascadeDeleteQueueItem } from "../_shared/cascadeDeleteTarget.ts"
import { processGenerateReportQueueItem } from "../_shared/generateReportTarget.ts"
import { processGenerateTuitionQueueItem } from "../_shared/generateTuitionTarget.ts"
import { processDashboardLinkQueueItem } from "../_shared/dashboardLinkTarget.ts"

// target별 실제 처리 함수. 앞으로 다른 "일괄(bulk)" 웹훅 함수나, 사람이 여러 페이지를 동시에 클릭할
// 수 있는 "개별" 웹훅 함수가 추가되면 여기에 추가한다 (위 2026-09-22 Phase 6 주석 참고).
//
// [FIX, 2026-09-23] PART N-4가 대부분의 target을 이 워커에서 빼면서 sync-dashboard-link도 함께
// 빠졌는데, generate-classes/kiosk-checkin의 enqueueDashboardLink()(_shared/dashboardLinkTarget.ts)
// 는 그 이후로도 계속 target: "sync-dashboard-link"로 sync_queue에 적재하고 있었다. 그 결과 그
// 항목들은 claim된 뒤 항상 "알 수 없는 target"으로 실패해(3회 재시도 후 영구 실패) 대시보드 연결이
// 전혀 되지 않고, 오직 다음날 새벽 nightly-dashboard-link-audit(대시보드 relation이 비어있는 건을
// 다시 찾아 연결)에만 의존하고 있었다. 그런데 그 audit은 mapWithConcurrency(..., 3, ...)으로 여러
// 건을 동시에 처리해서, findOrCreateDashboard()의 레이스(대시보드 중복 생성, dashboardLinkTarget.ts
// 참고)를 오히려 자주 유발하는 쪽이었다. 대시보드 연결은 사람이 지켜보는 "실시간 처리 상태"가 없어
// 지연에 관대하고, 오히려 이 워커의 CONCURRENCY=1 순차 처리에 맡기는 쪽이 동시성 문제를 줄여주므로
// 다시 등록한다 (findOrCreateDashboard 자체의 날짜별 잠금과 함께 이중 방어).
const HANDLERS: Record<string, (payload: any, cachedGetPage: (id: string) => Promise<any>) => Promise<void>> = {
  "create-learning-record": processCreateLearningRecordQueueItem,
  "sync-textbook-distribution:from-class-carts": processFromClassCartsQueueItem,
  "sync-class-report-cache": processSyncClassReportCacheQueueItem,
  "cascade-delete": processCascadeDeleteQueueItem,
  "generate-report": processGenerateReportQueueItem,
  "generate-tuition": processGenerateTuitionQueueItem,
  "sync-dashboard-link": processDashboardLinkQueueItem,
}

// (2026-09-22, Phase 6) 이 워커 한 번의 실행(위 sync_queue_worker_lock으로 항상 한 번에 하나만
// 돈다) 안에서, claim -> 처리 -> 다음 claim을 반복하는 "레인(lane)"을 동시에 돌린다.
// claim_next_sync_queue_item 계열 RPC는 FOR UPDATE SKIP LOCKED를 써서 여러 레인이 동시에 호출해도
// 같은 항목을 두 번 집지 않는다(원래도 여러 워커 인스턴스가 동시에 떠도 안전하게 설계되어 있었음
// -- 이제 그 안전성을 한 인스턴스 안의 동시 레인에도 그대로 활용).
//
// (2026-09-22, Phase 6 후속: 3 -> 1로 되돌림) 실제 운영에서 N=3(target 구분 없는 동일한 하나의
// 레인을 3개 동시 실행)으로 돌려보니 두 가지 문제가 드러났다: (1) 학생 수가 많은 클래스(보고서/
// 수강료 생성)의 등록별 처리가 당시 순차 for 루프였던 탓에 한 항목이 몇 분씩 걸렸고, 그동안 레인
// 하나가 계속 묶여 있었다. (2) 더 심각하게는, 그렇게 오래 걸리는 항목을 처리하던 함수 실행이
// Supabase Edge Function의 실행시간 한도에 걸려 도중에 강제 종료되면 sync_queue_worker_lock까지
// 함께 유실되어(정상적으로 release되지 못함), 다음 pg_cron 주기가 새로 락을 잡고 또 3개를 새로
// 집으면서 화면에 "작업중"이 3개 한도를 넘어 계속 쌓이는 현상(사용자 보고, 2026-09-22)으로
// 이어졌다. 사용자 요청에 따라 (a) 등록별 처리는 병렬화해서 항목 하나의 처리 시간 자체를 줄이고
// (generateReportTarget.ts/generateTuitionTarget.ts의 REG_CONCURRENCY 참고), (b) 큐 처리 자체는
// 다시 완전히 하나씩(요청이 들어온 시간순, 즉 큐에 쌓인 created_at 순서 그대로) 처리하도록
// 되돌려서, 화면에는 항상 최대 1건만 "🔄 작업중"으로 보이고 순서도 항상 예측 가능하게 만든다.
// 마스터플랜: https://app.notion.com/p/903c90386c1d473494c5df6306c53517
//
// (2026-09-24, sync_queue 분리큐 1단계) 사용자가 Supabase SQL Editor에서 직접 실측한 결과,
// sync-dashboard-link만 물량이 압도적으로 많았다(대기 중인 항목 1056건, 평균 대기 885초/최대
// 6857초) -- generate-classes/kiosk-checkin이 수업/출석 페이지를 만들 때마다 건별로 하나씩
// 쌓이기 때문이다. target 구분 없는 위 "하나씩" 레인 하나만 있으면, 이 대량 적체가 무관한
// cascade-delete(298건, 평균 대기 366초) 등 다른 target까지 뒤에서 오래 기다리게 만든다(레인
// 기아). sync-dashboard-link의 중복 생성 방지는 이미 findOrCreateDashboard의 날짜별 advisory
// lock(20260923000000 마이그레이션, dashboardLinkTarget.ts)이 별도로 보장하므로, 이 target을
// 다른 target들과 같은 줄에 세울 필요가 없다 -- 아래처럼 target 목록으로 필터링해 꺼내는
// claim_next_sync_queue_item_for_targets(20260924020000 마이그레이션)를 이용해, "레인은 여전히
// 하나씩(각 레인 내부 순서 보장, 위 Phase 6 후속 교훈 유지)"를 지키면서 sync-dashboard-link
// 전용 레인과 나머지 6개 target 전용 레인을 독립적으로 동시에 돌린다. 두 레인이 서로 다른 target만
// 보므로 서로를 막지 않는다. (나머지 6개 target 중 실측상 유의미한 대기가 있던 건 cascade-delete
// 뿐이었는데, 이는 sync-dashboard-link 적체에 밀려 대기했던 것으로 추정된다 -- 이번 분리 후 재측정
// 해서 여전히 대기가 크면 그 다음 단계로 cascade-delete도 별도 레인으로 뗀다, 사용자 지시: "결과적
// 으로는 다 분리하기로 하는데, 일단 하나씩하나씩 분리해보자.")
const DASHBOARD_TARGET = "sync-dashboard-link"
const OTHER_TARGETS = Object.keys(HANDLERS).filter((target) => target !== DASHBOARD_TARGET)

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

    // (2026-09-22, Phase 6 / 2026-09-24 분리큐 1단계) 한 항목을 claim -> 처리 -> 결과 반영까지
    // 끝내는 레인 하나. deadline까지 "이 레인이 맡은 target들 중 더 이상 집을 게 없을 때"만
    // 멈추므로, 해당 target에 항목이 남아있는 한 이 레인은 계속 다음 항목을 이어서 집는다 --
    // 아래에서 target 목록이 서로 다른 레인 2개(sync-dashboard-link 전용 / 나머지 전용)를 동시에
    // 돌려서, 서로 다른 target끼리는 줄을 분리하되 각 레인 내부는 여전히 하나씩 순서대로 처리한다.
    async function lane(targets: string[]): Promise<void> {
      while (Date.now() < deadline) {
        const item: SyncQueueItem | null = await claimNextSyncQueueItemForTargets(targets)
        if (!item) return

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
    }

    await Promise.all([lane([DASHBOARD_TARGET]), lane(OTHER_TARGETS)])
  } finally {
    clearInterval(lockRenewalTimer)
    await releaseWorkerLock()
  }

  // 시간 예산을 다 쓰고 멈췄는데 아직 남은 작업이 있으면, 다음 pg_cron 주기(최대 1분)까지 기다리지
  // 않고 스스로를 한 번 더 깨운다.
  if (Date.now() >= deadline && (await hasPendingSyncQueueItems().catch(() => false))) {
    wakeSyncQueueWorker()
  }

  return new Response(JSON.stringify({ ok: true, processed, retried, failed }), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  })
})
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
// (2026-09-18, Phase 2) cascade-delete / create-assignment / create-learning-record /
// sync-textbook-distribution(from-cart, from-class-carts) / sync-class-report-cache 를 HANDLERS에
// 추가했다. 이 다섯 함수 모두 여러 Notion DB에서 동시에 웹훅이 몰릴 수 있는 함수라, 이제 sync-report-cache와
// 동일하게 요청을 받으면 즉시 큐에 적재만 하고, 실제 무거운 처리는 이 워커가 순서대로 하나씩 담당한다.
//
// (2026-09-18, Phase 3) fix-attendance / sync-exam-scope / sync-registration-enroll /
// sync-registration-end / sync-registration-timetable(웹훅 단건 경로만) /
// sync-registration-textbook(create-individual 라우트만) 를 HANDLERS에 추가했다. 등록(학원) DB의
// "남은 버튼"들도 같은 이유로 큐로 옥긴 것. sync-registration-timetable의 매일 cron 전체 스캔과
// sync-registration-textbook의 cleanup-on-end 라우트(다른 함수가 내부적으로 동기 호출)는 의도적으로
// 큐를 거치지 않고 계속 동기 처리된다.
//
// (2026-09-18 밤, 복구/재시도 도입) 지금까지는 (a) 워커가 항목 처리 도중 죽으면 그 항목이 processing
// 상태로 영원히 멈춰있었고, (b) 처리 중 오류가 나면 재시도 없이 곳바로 failed로 확정됐다. 이제 매 실행
// 시작 시 STALE_PROCESSING_SECONDS(15분)보다 오래 processing 상태로 멈춰있는 항목을 자동으로
// 되돌리고(recoverStaleSyncQueueItems), 처리 중 오류가 나면 시도 횟수가 MAX_ATTEMPTS(3회) 미만일
// 때는 pending으로 되돌려 재시도하게 한다(markSyncQueueItemFailedOrRetry). 이 재시도가 안전하려면
// 각 target 핸들러가 "처리 전 현재 상태를 확인하고 진행"하도록 되어 있어야 한다 -- 13개 target을
// 모두 검토했고, create-assignment(학습기록당 학습활동 1회 생성 확인 추가)와 create-learning-record
// ("오늘 학습" 체크를 생성 전에 먼저 소비하도록 순서 변경)를 이 재시도 도입에 맞춰 함께 정리했다.
//
// (2026-09-20, 웹훅 코드 정리 2단계) sync-registration-class-session을 HANDLERS에 추가했다. 등록(학원)
// DB의 다른 버튼(enroll/end/timetable/textbook)은 이미 Phase 3에서 큐로 옥겨졌는데 "수업 생성" 버튼만
// 빠져 있었다 -- 같은 DB의 버튼인데 하나만 다른 동시성 모델을 쓰는 일관성 공백을 없옌다.
//
// (2026-09-21, 워커 락 리스 연장 도입) 잠금은 120초 리스로 얻고 전체 루프 예산은 100초라 평소에는 여유가
// 있지만, target 핸들러 중 하나가 유난히 느린 외부 호출에 걸려 단일 항목 처리가 오래 걸리면 리스가
// 루프 중간에 만료될 수 있었다. 이렇게 되면 pg_cron이 매분 깨우는 다음 실행이 새로 잠금을 얻어버려,
// 두 워커가 동시에 같은 작업을 중복 처리할 위험이 생긴다. 이를 막기 위해 잠금을 얻은 직후부터
// setInterval로 60초마다 renewWorkerLock(120)을 호출해 리스를 계속 연장하고, finally에서
// clearInterval로 정리한다 (releaseWorkerLock과 마찬가지로 마지막에 반드시 정리되어야 함).

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
import { processSyncReportCacheQueueItem } from "../_shared/syncReportCacheTarget.ts"
import { processCascadeDeleteQueueItem } from "../_shared/cascadeDeleteTarget.ts"
import { processCreateAssignmentQueueItem } from "../_shared/createAssignmentTarget.ts"
import { processCreateLearningRecordQueueItem } from "../_shared/createLearningRecordTarget.ts"
import {
  processFromCartQueueItem,
  processFromClassCartsQueueItem,
} from "../_shared/textbookDistributionTarget.ts"
import { processSyncClassReportCacheQueueItem } from "../_shared/classReportCacheTarget.ts"
import { processFixAttendanceQueueItem } from "../_shared/fixAttendanceTarget.ts"
import { processSyncExamScopeQueueItem } from "../_shared/examScopeTarget.ts"
import { processSyncRegistrationEnrollQueueItem } from "../_shared/registrationEnrollTarget.ts"
import { processSyncRegistrationEndQueueItem } from "../_shared/registrationEndTarget.ts"
import { processSyncRegistrationTimetableQueueItem } from "../_shared/registrationTimetableTarget.ts"
import { processCreateIndividualBooksQueueItem } from "../_shared/registrationTextbookTarget.ts"
import { processDashboardLinkQueueItem } from "../_shared/dashboardLinkTarget.ts"
import { processSyncRegistrationClassSessionQueueItem } from "../_shared/registrationClassSessionTarget.ts"

// target별 실제 처리 함수. 앞으로 다른 웹훅 함수들도 같은 큐 패턴으로 옥기면 여기에 추가한다.
const HANDLERS: Record<string, (payload: any, cachedGetPage: (id: string) => Promise<any>) => Promise<void>> = {
  "sync-report-cache": processSyncReportCacheQueueItem,
  "cascade-delete": processCascadeDeleteQueueItem,
  "create-assignment": processCreateAssignmentQueueItem,
  "create-learning-record": processCreateLearningRecordQueueItem,
  "sync-textbook-distribution:from-cart": processFromCartQueueItem,
  "sync-textbook-distribution:from-class-carts": processFromClassCartsQueueItem,
  "sync-class-report-cache": processSyncClassReportCacheQueueItem,
  "fix-attendance": processFixAttendanceQueueItem,
  "sync-exam-scope": processSyncExamScopeQueueItem,
  "sync-registration-enroll": processSyncRegistrationEnrollQueueItem,
  "sync-registration-end": processSyncRegistrationEndQueueItem,
  "sync-registration-timetable": processSyncRegistrationTimetableQueueItem,
  "sync-registration-textbook:create-individual": processCreateIndividualBooksQueueItem,
  "sync-dashboard-link": processDashboardLinkQueueItem,
  "sync-registration-class-session": processSyncRegistrationClassSessionQueueItem,
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
  // 큐 처리를 강제로 트리거할 수 있었다. 호출자는 (a) 각 웹훅 함수의 wakeSyncQueueWorker
  // (x-admin-key를 함께 보내도록 이미 수정함), (b) pg_cron의 매분 안전망(호출 SQL도 헤더를
  // 추가한 마이그레이션으로 갱신함) 두 곳뿐이라 관리자 키 인증을 그대로 적용한다.
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

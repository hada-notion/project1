// POST /functions/v1/process-sync-queue
//
// sync_queue에 쌓인 작업을 "생성된 순서대로 하나씩만" 꺼내서 처리하는 전용 워커.
// (2026-09-18, 큐 기반 순차 처리 도입 -- 배경 설명은 _shared/syncQueue.ts, sync-report-cache/index.ts 참고)
//
// 두 가지 경로로 호출된다:
//   1) 각 웹훅 함수가 작업을 적재한 직후 fire-and-forget으로 즉시 호출 (지연시간 줄이기용, 실패해도
//      무시될 -- _shared/syncQueue.ts의 wakeSyncQueueWorker).
//   2) pg_cron이 매분 호출하는 안전망 (즉시 트리거가 실패/유실되거나, 처리 중 이 함수 자체가
//      시간 예산을 다 써서 멈췄도 다음 분에 이어서 처리하도록).
//
// 동시에 여러 번 호출돼도(즉시 트리거 + 마침 겹친 cron 등) 실제 처리가 겹지지 않도록,
// public.sync_queue_worker_lock 테이블 기반의 리스(lease) 잠금을 먼저 얻어야 시작한다. 잠금을 못
// 얻으면 (이미 다른 실행이 돌고 있다는 뜻) 바로 조용히 끝낸다 -- 이렇게 해서 아무리 많은 요청이
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
// "남은 버튼"들도 같은 이유로 큐로 옮긴 것. sync-registration-timetable의 매일 cron 전체 스캔과
// sync-registration-textbook의 cleanup-on-end 라우트(다른 함수가 내부적으로 동기 호출)는 의도적으로
// 큐를 거치지 않고 계속 동기 처리된다.

import {
  tryAcquireWorkerLock,
  releaseWorkerLock,
  claimNextSyncQueueItem,
  markSyncQueueItemDone,
  markSyncQueueItemFailed,
  hasPendingSyncQueueItems,
  wakeSyncQueueWorker,
  type SyncQueueItem,
} from "../_shared/syncQueue.ts"
import { CORS_HEADERS, makePageCache } from "../_shared/reportCacheShared.ts"
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

// target별 실제 처리 함수. 앞으로 다른 웹훅 함수들도 같은 큐 패턴으로 옮기면 여기에 추가한다.
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
}

// Edge Function 자체의 실행 시간 한도보다 여유 있게 짧은 시간 예산 안에서만 계속 처리하고, 남으면
// 스스로를 다시 깨운다 (한 번의 실행이 시간 제한에 걸려 강제 종료되는 것보다, 미리 멈추고 이어가는
// 쪽이 처리 중이던 항목이 애매한 상태로 남을 위험이 적다).
const TIME_BUDGET_MS = 100_000

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })

  const acquired = await tryAcquireWorkerLock(120).catch((err) => {
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
  const cachedGetPage = makePageCache()
  const deadline = Date.now() + TIME_BUDGET_MS

  try {
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
        failed++
        console.error(`[process-sync-queue] #${item.id} (target=${item.target}) 처리 실패:`, (err as Error)?.message)
        await markSyncQueueItemFailed(item.id, String((err as Error)?.message ?? err))
      }
    }
  } finally {
    await releaseWorkerLock()
  }

  // 시간 예산을 다 써서 멈췄는데 아직 남은 작업이 있으면, 다음 pg_cron 주기(최대 1분)까지 기다리지
  // 않고 스스로를 한 번 더 깨운다.
  if (Date.now() >= deadline && (await hasPendingSyncQueueItems().catch(() => false))) {
    wakeSyncQueueWorker()
  }

  return new Response(JSON.stringify({ ok: true, processed, failed }), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  })
})

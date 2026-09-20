// Supabase Edge Function: sync-registration-timetable
//
// 시간표 연결: 클래스 기준 자동 연결은 이 함수에서 더 이상 하지 않는다 (2026-09-10 변경).
//   - 클래스의 시간표가 학생 개개인에게 똑같이 적용되는 게 아니라서, 자동 연결은
//     "등록" 버튼(sync-registration-enroll)에서만 한 번 세팅하고, 그 뒤엔 담당자가
//     수동으로 조정할 수 있게 한다. 여기서는 그 값을 다시 덮어쓰지 않는다.
//   - 이 함수는 등록일/종료일 관련 후처리(출석/수업 정리, 종료된 등록 시간표 해제,
//     복원)만 계속 담당한다.
//
// 해제(등록 종료):
//   - 종료일이 입력/수정되면 즉시(웹훅) 종료일 이후 날짜의 출석 페이지를 삭제하고,
//     종료일 이후 날짜의 수업 페이지들에서도 이 등록을 roster에서 제거한다.
//     (종료일이 미래여도 즉시 실행 — 아직 남은 정상 수강 기간의 수업엔 영향 없음.)
//   - 수강상태가 실제로 "수강 종료"로 바뀌 뒤에는(매일 cron 스캔 포함, 상태 계산은 종료일 지남 여부로 자동 결정)
//     시간표 관계 전체를 해제해서, 시간표에는 현재 수강 중인 등록만 남도록 한다.
//
// 호출 방식:
//   - body에 { pageId: "등록 페이지 id" } 를 담아 호출하면 그 등록 1건만 연결 처리 (속성 편집 웹훅용, 예: 클래스 연결).
//   - body 없이 호출하면 전체 스캔: 연결 누락분 보정 + 종료된 등록 해제까지 한 번에 처리 (매일 cron용).
//
// (2026-09-18, 큐 기반 순차 처리 도입, Phase 3) 웹훅 단건(pageId 있는) 경로만 큐로 옮겨서
// process-sync-queue 워커가 순서대로 처리하도록 바꿔다 (_shared/registrationTimetableTarget.ts).
// 매일 cron 전체 스캔 경로(body 없음)는 버튼이 기다리는 응답이 아니므로 의도적으로 그대로 동기 유지한다.
//
// (2026-09-20, 웹훅 코드 정리 3단계) pageId가 있는 웹훅 단건 경로의 "잠금 확인 -> 처리중 표시 ->
// 큐 적재 -> 202 응답" 부분을 _shared/webhookIngest.ts의 runLockedQueueWebhookForPage로 옮겼다.
// cron 전체 스캔 분기(pageId 없음)는 이 함수 고유의 로직이라 그대로 남긴다.

import {
  PROP_STATUS,
  PROP_TIMETABLE,
  PROP_SYNC_TIMETABLE_RUNNING,
} from "../_shared/constants.ts"
import { extractPageId } from "../_shared/notionClient.ts"
import {
  setTimetableSyncStatus,
  restoreAllPendingClassSessions,
  cleanupTextbooksForEndedOrInvalidRegistrations,
  cleanupAttendanceForAllEndedRegistrations,
  disconnectTimetableForEndedRegistrations,
} from "../_shared/registrationTimetableTarget.ts"
import { runLockedQueueWebhookForPage } from "../_shared/webhookIngest.ts"

void PROP_STATUS
void PROP_TIMETABLE

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Use POST", { status: 405 })
  }
  const log: string[] = []
  try {
    let body: Record<string, unknown> = {}
    try {
      body = await req.json()
    } catch {
      body = {}
    }
    console.log("[sync-registration-timetable] received body:", JSON.stringify(body))

    // 웹훅 body에 pageId / pageUrl / url / id 중 하나라도 들어오면 그 페이지 1건만 처리한다.
    const pageId = extractPageId(body)
    console.log("[sync-registration-timetable] extracted pageId:", pageId)

    if (pageId) {
      return await runLockedQueueWebhookForPage(pageId, {
        functionName: "sync-registration-timetable",
        lockProp: PROP_SYNC_TIMETABLE_RUNNING,
        target: "sync-registration-timetable",
        setStatus: setTimetableSyncStatus,
      })
    }

    // body가 없거나 페이지를 못 찾았으면(매일 cron용) 전체 스캔 — 웹훅을 놓친 경우의 안전망. 버튼이
    // 기다리는 응답이 아니므로 동기적으로 유지한다 (큐를 거치지 않고 그대로 직접 처리).
    await restoreAllPendingClassSessions(log)
    await cleanupTextbooksForEndedOrInvalidRegistrations(log)
    await cleanupAttendanceForAllEndedRegistrations(log)
    await disconnectTimetableForEndedRegistrations(log)

    return new Response(JSON.stringify({ ok: true, log }, null, 2), {
      headers: { "Content-Type": "application/json" },
    })
  } catch (err) {
    console.error("[sync-registration-timetable] ERROR:", (err as Error).message, (err as Error).stack)
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message, log }, null, 2), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
})

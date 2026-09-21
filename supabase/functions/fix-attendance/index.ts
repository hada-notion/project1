// Supabase Edge Function: fix-attendance
//
// Triggered by the "출석 조정" button on a 수업(학원) DB page (via Notion's built-in
// "웹훅 보내기" automation action -- same wiring pattern as the "수업추가" button).
//
// Reconciles that class-session's attendance records against its timetable's registrations
// that were ACTIVE AS OF THIS CLASS SESSION'S OWN DATE (등록일 <= 수업일시 <= 종료일, or 종료일
// empty) -- NOT "현재 시각 기준 수강상태". Checking current-time status is wrong: e.g. a student who
// ended on 9/8 was still validly attending on 9/7, so 9/7's attendance must NOT be flagged
// "extra" just because "now" (9/9+) is past their end date. Matches the session-bound
// activeRegistrations definition in the "생성 오류" formula on 수업(학원) DB.
//
//   - Missing (registration is active but has no attendance page for this class session):
//       - If an attendance page already exists for that registration on the same calendar
//         day but isn't linked to any class session (수업 relation empty) -> LINK it here.
//       - Otherwise -> CREATE a new attendance page.
//   - Extra (attendance page exists but its registration is no longer actively enrolled)
//     or Duplicate (more than one attendance page for the same registration on this class
//     session, keep only the earliest) -> set "삭제" checkbox = true, so the existing
//     cascade-delete automation/function handles the actual deletion (including downstream
//     학습활동 records).
//
// (2026-09-18, 큐 기반 순차 처리 도입, Phase 3) 실제 출석 조정 로직은 _shared/fixAttendanceTarget.ts로
// 옮겼다. 이 파일은 웹훅 body에서 수업 페이지 id를 찾은 뒤, 처리를 큐에 적재만 하고 즉시 응답한다.
//
// [2026-09-20, 웹훅 코드 정리 1단계] 자체 extractPageId/deepFindPageObjectId/resolveClassSessionId를
// 지우고 _shared/notionClient.ts의 공용 extractPageId로 교체했다 (cascade-delete와 동일한 이유 --
// 상세 설명은 그 파일 v9 주석 참고. 동작은 그대로, 더 안전한 "문자열 끝에서만 UUID 추출" 버전으로 교체).
//
// [2026-09-21, PART N: 관리자 키 인증 추가] 이 함수를 호출하는 "출석 조정" 버튼 웹훅에 x-admin-key
// 커스텀 헤더를 미리 추가해둔 뒤, 함수 쪽에도 동일한 검증을 추가한다. adminShared.ts의
// resolveAdminKeyFromRequest/getCurrentAdminKey를 그대로 사용(다른 관리자 함수들과 동일한 패턴).
// 헤더가 없으면 body.adminKey도 확인한다.

import { extractPageId } from "../_shared/notionClient.ts"
import { respondAccepted } from "../_shared/backgroundTask.ts"
import { enqueueSync, wakeSyncQueueWorker } from "../_shared/syncQueue.ts"
import { markAttendanceFixRunning } from "../_shared/fixAttendanceTarget.ts"
import { resolveAdminKeyFromRequest, getCurrentAdminKey } from "../_shared/adminShared.ts"

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Use POST", { status: 405 })
  }

  const log: string[] = []
  const rawText = await req.text()
  console.log("fix-attendance raw body:", rawText)

  let body: any = {}
  try {
    body = rawText ? JSON.parse(rawText) : {}
  } catch {
    body = {}
  }

  const adminKey = resolveAdminKeyFromRequest(req, body)
  const currentAdminKey = await getCurrentAdminKey()
  if (!adminKey || adminKey !== currentAdminKey) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })
  }

  try {
    const classSessionId = extractPageId(body)
    if (!classSessionId) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "수업 페이지 id를 payload에서 찾지 못하였습니다. raw body를 확인하세요.",
          receivedBodyPreview: rawText.slice(0, 500),
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }
    await markAttendanceFixRunning(classSessionId)

    // 큐에 적재만 하고 즉시 응답한다 -- 실제 출석 조정은 process-sync-queue 워커가 순서대로
    // 처리한다 (2026-09-18, Phase 3). 진행 상황은 그 수업의 "동기화 상태"(이미 처리중으로
    // 설정됨)로 확인할 수 있다.
    await enqueueSync("fix-attendance", { classSessionId })
    wakeSyncQueueWorker()

    return respondAccepted({ classSessionId })
  } catch (err) {
    console.error("fix-attendance failed:", (err as Error).message, "\nlog so far:", log.join("\n"), "\nstack:", (err as Error).stack)
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message, log }, null, 2), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
})

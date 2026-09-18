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

import { respondAccepted } from "../_shared/backgroundTask.ts"
import { enqueueSync, wakeSyncQueueWorker } from "../_shared/syncQueue.ts"
import { markAttendanceFixRunning } from "../_shared/fixAttendanceTarget.ts"

function extractPageId(input: unknown): string | null {
  if (typeof input !== "string") return null
  const dashed = input.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/)
  if (dashed) return dashed[0]
  const bare = input.match(/[0-9a-fA-F]{32}/)
  if (bare) return bare[0]
  return null
}

function deepFindPageObjectId(node: unknown, depth = 0): string | null {
  if (depth > 8 || node === null || typeof node !== "object") return null
  const obj = node as Record<string, unknown>
  if (obj.object === "page" && typeof obj.id === "string") {
    const id = extractPageId(obj.id)
    if (id) return id
  }
  for (const key of Object.keys(obj)) {
    const value = obj[key]
    if (value && typeof value === "object") {
      const found = deepFindPageObjectId(value, depth + 1)
      if (found) return found
    }
  }
  return null
}

// Same robust page-id extraction as cascade-delete/generate-classes: Notion's built-in
// "웹훅 보내기" action has no free-text JSON body editor, so we look for the triggering
// page's id in every place Notion is known to put it.
function resolveClassSessionId(body: any): string | null {
  const flatCandidates = [
    body?.classSessionId,
    body?.pageId,
    body?.pageUrl,
    body?.page_id,
    body?.url,
    body?.id,
    body?.data?.id,
    body?.data?.url,
    body?.data?.page?.id,
    body?.page?.id,
  ]
  for (const candidate of flatCandidates) {
    const id = extractPageId(candidate)
    if (id) return id
  }
  const deep = deepFindPageObjectId(body)
  if (deep) return deep
  return extractPageId(JSON.stringify(body))
}

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

  try {
    const classSessionId = resolveClassSessionId(body)
    if (!classSessionId) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "수업 페이지 id를 payload에서 찾지 목하였습니다. raw body를 확인하세요.",
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

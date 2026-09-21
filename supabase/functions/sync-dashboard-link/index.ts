// Supabase Edge Function: sync-dashboard-link
//
// 대시보드(학원) DB, 일정(학원) DB에 걸어둔 "페이지가 생성되면 → 웹훅 보내기" 자동화가 호출하는
// 엔드포인트 (2026-09-20, 대시보드 기능 추가). 수업(학원)/출석(학원) 페이지는 대부분
// generate-classes/kiosk-checkin이 Notion API로 직접 만들기 때문에 이 자동화를 걸어도 트리거되지
// 않는 경우가 많아서(사람이 직접 만든 경우에만 트리거됨), 그 두 함수는 페이지 생성 직후 이 함수를
// 거치지 않고 같은 큐에 바로 적재한다 (_shared/dashboardLinkTarget.ts의 enqueueDashboardLink).
//
// 실제 처리(같은 날짜의 대시보드 찾기/만들기 + 양방향 연결, 또는 대시보드 쪼 재구성)는
// process-sync-queue 워커가 순서대로 담당한다 (_shared/dashboardLinkTarget.ts).
//
// (2026-09-21, PART N-2) 대시보드/일정/수업/출석(학원) DB의 "페이지가 생성되면 → 웹훅 보내기"
// 자동화에 x-admin-key 헤더를 미리 추가해둔 뒤, 이 파일 진입부에서 직접 관리자 키를 확인한다
// (generate-classes/kiosk-checkin은 이 HTTP 엔드포인트를 거치지 않고 같은 큐에 직접 적재하므로
// 이 검사의 영향을 받지 않는다).

import { extractPageId } from "../_shared/notionClient.ts"
import { enqueueSync, wakeSyncQueueWorker } from "../_shared/syncQueue.ts"
import { respondAccepted } from "../_shared/backgroundTask.ts"
import { resolveAdminKeyFromRequest, getCurrentAdminKey } from "../_shared/adminShared.ts"

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Use POST", { status: 405 })
  }

  let body: Record<string, unknown> = {}
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  console.log("[sync-dashboard-link] received body:", JSON.stringify(body))

  const adminKey = resolveAdminKeyFromRequest(req, body)
  const currentAdminKey = await getCurrentAdminKey()
  if (!adminKey || adminKey !== currentAdminKey) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })
  }

  const pageId = extractPageId(body)
  if (!pageId) {
    return new Response(JSON.stringify({ ok: false, error: "pageId를 찾을 수 없습니다.", body }, null, 2), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })
  }

  try {
    await enqueueSync("sync-dashboard-link", { pageId })
  } catch (err) {
    console.error("[sync-dashboard-link] 큐 적재 실패:", (err as Error).message)
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message }, null, 2), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
  wakeSyncQueueWorker()

  return respondAccepted({ pageId })
})

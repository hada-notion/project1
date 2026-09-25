// Supabase Edge Function: sync-dashboard-link
//
// 같은 날짜의 수업·출석·일정과 대시보드 페이지를 연결하는 엔드포인트다.
// [현재 상태, 2026-09-25] Notion 생성 자동화, generate-classes/kiosk-checkin 직접 적재,
// nightly-dashboard-link-audit가 모두 제거되어 현재 이 엔드포인트를 호출하는 운영 경로는 없다.
// 수업 생성 중 Notion API 호출량을 줄이기 위해 제거 상태를 유지한다.
//
// 아래 코드는 대시보드 연결을 별도 pull/수동 방식으로 재설계할 가능성에 대비해 남아 있지만,
// 호출자가 없는 휴면 코드다. 삭제 여부는 실행 로직 변경이므로 문구 정리와 별도로 결정한다.

import { extractPageId } from "../_shared/notionClient.ts"
import { processDashboardLinkQueueItem } from "../_shared/dashboardLinkTarget.ts"
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
    await processDashboardLinkQueueItem({ pageId })
  } catch (err) {
    console.error("[sync-dashboard-link] 처리 실패:", (err as Error).message)
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message }, null, 2), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }

  return new Response(JSON.stringify({ ok: true, pageId }, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
})
import { authorizeKey, securityEnabled } from "../_shared/adminSecurity.ts"
// Supabase Edge Function: sync-dashboard-link
//
// 같은 날짜의 수업·출석·일정과 대시보드 페이지를 연결하는 엔드포인트다.
// [현재 상태, 2026-10-13 원본 Notion 확인] 대시보드(학원) DB의 웹훅 자동화 2개가 호출한다:
// "날짜 속성 편집" 시, "페이지 추가" 시. 둘 다 그 대시보드 페이지 id를 보내고, 이 함수가 그 날짜의
// 수업·출석·일정을 찾아 대시보드 쪽 relation에 채운다(응답을 기다리는 동기 처리).
// 반대 방향 호출(수업·출석·일정 DB 자동화, generate-classes/kiosk-checkin의 직접 적재,
// nightly-dashboard-link-audit)은 수업 생성 중 Notion API 호출량 때문에 제거했고 다시 연결하지 않는다.

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
  const currentAdminKey = securityEnabled() ? "" : await getCurrentAdminKey()
  if (!adminKey || !await authorizeKey(req, adminKey, currentAdminKey)) {
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
// Supabase Edge Function: sync-dashboard-link
//
// 대시보드(학원) DB, 일정(학원) DB에 걸어둔 "페이지가 생성되면 → 웹훅 보내기" 자동화가 호출하는
// 엔드포인트 (2026-09-20, 대시보드 기능 추가). 수업(학원)/출석(학원) 페이지는 대부분
// generate-classes/kiosk-checkin이 Notion API로 직접 만들기 때문에 이 자동화를 걸어도 트리거되지
// 않는 경우가 많아서(사람이 직접 만든 경우에만 트리거됨), 그 두 함수는 페이지 생성 직후 이 함수를
// 거치지 않고 같은 큐에 바로 적재한다 (_shared/dashboardLinkTarget.ts의 enqueueDashboardLink —
// generate-classes/kiosk-checkin은 반 전체/여러 학생을 한 번에 처리하는 일괄 작업이라 계속 큐를
// 쓴다, 이 파일의 변경과 무관).
//
// (2026-09-21, PART N-2) 대시보드/일정/수업/출석(학원) DB의 "페이지가 생성되면 → 웹훅 보내기"
// 자동화에 x-admin-key 헤더를 미리 추가해둔 뒤, 이 파일 진입부에서 직접 관리자 키를 확인한다
// (generate-classes/kiosk-checkin은 이 HTTP 엔드포인트를 거치지 않고 같은 큐에 직접 적재하므로
// 이 검사의 영향을 받지 않는다).
//
// (2026-09-22, PART N-4: 개별 트리거 버튼 동기화 전환) 이 HTTP 엔드포인트로 들어오는 건 사람이
// 직접 만든 페이지 1건뿐인 개별 트리거라, sync_queue에 적재하지 않고 processDashboardLinkQueueItem을
// 바로 await한 뒤 결과를 그 자리에서 응답한다. (이 함수는 잠금 체크박스가 없다 — 항상 그 시점
// 기준으로 다시 계산하는 멱등 작업이라 재실행해도 안전하다.) generate-classes/kiosk-checkin이
// 쓰는 enqueueDashboardLink()는 이 파일과 별개의 호출 경로라 그대로 큐를 쓴다.

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
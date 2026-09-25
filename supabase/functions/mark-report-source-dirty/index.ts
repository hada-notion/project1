// Notion DB 자동화 공용 웹훅.
// 보고서에 영향을 주는 속성의 편집 트리거에서 이 주소를 호출하면, 해당 페이지의
// `학습정보 수정일`만 현재 시각으로 기록한다. 이 속성 자체는 자동화 트리거에서 제외해야 한다.

import { CORS_HEADERS } from "../_shared/adminShared.ts"
import { extractPageId, updatePageProperties } from "../_shared/notionClient.ts"
import { PROP_SOURCE_MODIFIED_AT } from "../_shared/reportDirtySync.ts"

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })
  try {
    const body = await req.json().catch(() => ({}))
    const pageId = extractPageId(body)
    if (!pageId) {
      return new Response(JSON.stringify({ error: "pageId를 찾을 수 없습니다." }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      })
    }
    const modifiedAt = new Date().toISOString()
    await updatePageProperties(pageId, {
      [PROP_SOURCE_MODIFIED_AT]: { date: { start: modifiedAt } },
    })
    return new Response(JSON.stringify({ ok: true, pageId, modifiedAt }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  } catch (err) {
    console.error("mark-report-source-dirty error:", err)
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }
})

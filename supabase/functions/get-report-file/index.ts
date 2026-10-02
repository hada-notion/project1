// POST /functions/v1/get-report-file
// body: { token: string, blockId: string }
//
// Notion 업로드 파일 URL은 만료된다. 학생 보고서 토큰이 접근할 수 있는 캐시 안에 blockId가
// 실제로 포함돼 있는지 먼저 검증하고, 클릭 시점에 Notion 블록을 다시 읽어 최신 URL을 반환한다.
import { getBlock } from "../_shared/notionClient.ts"
import { CORS_HEADERS, selectReportCacheByToken } from "../_shared/reportCacheShared.ts"

function containsBlockId(value: unknown, blockId: string): boolean {
  if (value === blockId) return true
  if (Array.isArray(value)) return value.some((item) => containsBlockId(item, blockId))
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) => containsBlockId(item, blockId))
  }
  return false
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405)

  try {
    const { token, blockId } = await req.json().catch(() => ({}))
    const safeBlockId = typeof blockId === "string" ? blockId.replace(/[^a-zA-Z0-9-]/g, "") : ""
    if (!token || !safeBlockId) return json({ error: "token과 blockId가 필요합니다." }, 400)

    const row = await selectReportCacheByToken(String(token))
    if (!row) return json({ error: "유효하지 않은 토큰입니다." }, 404)
    if (!containsBlockId(row.registration_detail, safeBlockId)) {
      return json({ error: "이 보고서에서 접근할 수 없는 파일입니다." }, 403)
    }

    const block = await getBlock(safeBlockId)
    const type = block?.type
    if (type !== "pdf" && type !== "file") return json({ error: "지원하지 않는 파일 블록입니다." }, 400)

    const media = block[type]
    const url = media?.type === "external" ? media.external?.url : media?.file?.url
    if (!url) return json({ error: "파일 URL을 찾을 수 없습니다." }, 404)

    const fallbackName = type === "pdf" ? "PDF 문서" : "첨부 파일"
    return json({ url: String(url), name: String(media?.name || fallbackName), type })
  } catch (err) {
    console.error("get-report-file failed", err)
    return json({ error: String((err as Error)?.message ?? err) }, 500)
  }
})

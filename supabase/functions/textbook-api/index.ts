// POST /functions/v1/textbook-api
// 교재 검색(textbook_search.html, v2.5.118). 관리자 로그인 세션만 통과한다(adminSecurity.ts의 브라우저 경로).
//   search   { query }                       알라딘 검색 + 정규교재 DB에 이미 있는지(ISBN13)
//   detail   { isbn13 }                      한 권의 정보·목차 → 단원 후보
//   parse    { text }                        붙여넣은 목차 → 단원 후보
//   register { isbn13, title?, units, noCover? }  정규교재 1권 + 단원목록 만들기
// 실제 로직은 _shared/textbookSearch.ts, 목차 규칙은 _shared/textbookToc.ts.
import { CORS_HEADERS, requireAdminKey } from "../_shared/adminShared.ts"
import { TextbookError, bookDetail, parsePasted, registerBook, searchBooks } from "../_shared/textbookSearch.ts"

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" } })

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS })
  if (req.method !== "POST") return json({ error: "POST 요청만 지원합니다." }, 405)
  const denied = await requireAdminKey(req)
  if (denied) return denied
  try {
    const raw = await req.text()
    if (raw.length > 64_000) return json({ error: "요청이 너무 큽니다." }, 413)
    let body: any
    try { body = JSON.parse(raw) } catch { return json({ error: "요청 형식이 올바르지 않습니다." }, 400) }
    switch (body?.action) {
      case "search": return json(await searchBooks(body.query))
      case "detail": return json(await bookDetail(body.isbn13))
      case "parse": return json(parsePasted(body.text))
      case "register": return json(await registerBook(body))
      default: return json({ error: "지원하지 않는 작업입니다." }, 400)
    }
  } catch (err) {
    if (err instanceof TextbookError) return json({ error: err.message }, err.status)
    console.error("[textbook-api]", (err as Error).message)
    return json({ error: "처리 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요." }, 500)
  }
})

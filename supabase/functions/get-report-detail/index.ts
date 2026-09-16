// POST /functions/v1/get-report-detail
// body: { token: string }
//
// get-report-fast와 동일하게 Notion을 직접 조회하지 않고 report_cache 테이블의
// registration_detail(출석/학습기록/과제/시험/선생님 코멘트 등)을 그대로 응답한다.
import { CORS_HEADERS, selectReportCacheByToken } from "../_shared/reportCacheShared.ts"

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })

  try {
    const { token } = await req.json()
    if (!token) {
      return new Response(JSON.stringify({ error: "token이 필요합니다." }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      })
    }

    const row = await selectReportCacheByToken(token)
    if (!row) {
      return new Response(JSON.stringify({ error: "유효하지 않은 토큰입니다." }), {
        status: 404,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      })
    }

    const payload = {
      ...row.registration_detail,
      registration_id: row.registration_id,
      token: row.access_token,
    }

    return new Response(JSON.stringify(payload), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }
})

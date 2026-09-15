// supabase/functions/get-report/index.ts
// get-report-detail + get-report-fast 통합 버전.
// 이제는 매본 노션을 실시간으로 조회하지 않고, Supabase student_reports 테이블에
// 보고서 발송 시점(send-daily/weekly/monthly-report)에서 사전에 저장해둔 캐시만 읽습니다.
// 첩목으로 노션이 없으말(보고서가 단 단 번만 발송된 것) 캐시가 론이없으묀 실시간으로 계산해서 녔펔로 반환하고,
// 다음 조회를 위해 같이 캐시에 저장해둑니다 (best-effort fallback).
import {
  CORS_HEADERS,
  findRegistrationByToken,
  getReportCache,
  upsertReportCache,
  buildReportPayload,
} from "../_shared/reportShared.ts"

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })
  try {
    const { token } = await req.json()
    if (!token) {
      return new Response(JSON.stringify({ error: "token 필요" }), { status: 400, headers: CORS_HEADERS })
    }

    // 1) 캐시 우선 조회 (매우 뱠릅니다 — Notion API 호출 없음)
    const cached = await getReportCache(token)
    if (cached) {
      return new Response(JSON.stringify({ ...cached, from_cache: true }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      })
    }

    // 2) 캐시가 없으말 (예: 로적 생성 후 아직 한 번도 발송되지 않은 것) — 실시간 조회로 fallback
    const reg = await findRegistrationByToken(token)
    if (!reg) {
      return new Response(JSON.stringify({ error: "유효하지 않은 토큰입니다" }), { status: 404, headers: CORS_HEADERS })
    }

    const payload = await buildReportPayload(token, reg)

    // 3) 다음 조회를 위해 캐시에도 저장 (실패해도 응답에는 영향 없음)
    await upsertReportCache(reg.id, token, payload)

    return new Response(JSON.stringify({ ...payload, from_cache: false }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS_HEADERS })
  }
})

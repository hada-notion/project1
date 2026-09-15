// supabase/functions/get-report/index.ts
// [2026-09-16] 이 함수는 애초부터 미완성 상태로 올라가 있었습니다: _shared/reportShared.ts에
// 존재하지 않는 getReportCache/upsertReportCache/buildReportPayload를 가져오려 해서 배포 시
// 타입 검사(deno check)에 걸려 전체 배포가 막혔습니다 (오늘 처음 추가된 타입 검사 단계에서 발견됨).
// Supabase에 보고서를 저장해서 열람하는 웹앱 기능은 추후 별도로 새로 설계해서 만들 예정이라,
// 그 전까지는 이 엔드포인트가 명확히 "준비 중"임을 응답하도록만 남겨둡니다.
import { CORS_HEADERS, findRegistrationByToken } from "../_shared/reportShared.ts"

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })
  try {
    const { token } = await req.json()
    if (!token) {
      return new Response(JSON.stringify({ error: "token 필요" }), { status: 400, headers: CORS_HEADERS })
    }

    const reg = await findRegistrationByToken(token)
    if (!reg) {
      return new Response(JSON.stringify({ error: "유효하지 않은 토큰입니다" }), { status: 404, headers: CORS_HEADERS })
    }

    // 보고서 조회 웹앱 기능은 아직 준비 중입니다 (Supabase 저장 방식으로 재설계 예정, 2026-09-16).
    return new Response(
      JSON.stringify({ error: "보고서 조회 기능은 아직 준비 중입니다.", not_implemented: true }),
      { status: 501, headers: CORS_HEADERS },
    )
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS_HEADERS })
  }
})

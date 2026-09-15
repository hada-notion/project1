// POST /functions/v1/sync-student-report
// body: { registrationId }
// 이 새 토큰 기반 실시간 조회 구조에서는 Postgres 쿤시가 없으므려, "등록"은
// 해당 등록의 "토큰"이 없을 대 새로 만들어 주는 역할로 축소됩니다.
// (토큰이 있으뱴 그대로 재사용함 — 리포트는 언제낟 조회되느란 별도 "동감"가 무의버로 필요 없습니다.)
import {
  CORS_HEADERS,
  requireAdminKey,
  notionGetPage,
  notionPatchPageProperties,
  generateToken,
  parseTokenValue,
} from "../_shared/adminShared.ts"

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })

  const authError = await requireAdminKey(req)
  if (authError) return authError

  try {
    const { registrationId } = await req.json()
    if (!registrationId) throw new Error("registrationId가 필요합니다.")

    const page = await notionGetPage(registrationId)
    const currentRaw = (page.properties?.["토큰"]?.rich_text ?? []).map((t: any) => t.plain_text).join("")
    const { accessToken: existingToken, disabled } = parseTokenValue(currentRaw)

    let accessToken = existingToken
    if (!accessToken || disabled) {
      accessToken = generateToken()
      await notionPatchPageProperties(registrationId, {
        "토큰": { rich_text: [{ text: { content: accessToken } }] },
      })
    }

    return new Response(JSON.stringify({ access_token: accessToken }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err?.message ?? err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }
})

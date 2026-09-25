// POST /functions/v1/sync-student-report
// body: { registrationId }
// 등록의 학부모 리포트 토큰이 없을 때 새로 발급한다. 기존 토큰이 있으면 그대로 재사용하므로,
// 리포트를 열 때마다 별도 동기화할 필요가 없다.
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
    return new Response(JSON.stringify({ error: String((err as Error)?.message ?? err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }
})

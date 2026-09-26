// POST /functions/v1/sync-student-report
// body: { registrationId }
// 토큰이 없을 때만 새로 발급한다. 비활성화된 토큰은 자동으로 다시 활성화하지 않는다.
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
    if (!accessToken) {
      accessToken = generateToken()
      await notionPatchPageProperties(registrationId, {
        "토큰": { rich_text: [{ text: { content: accessToken } }] },
      })
    }

    return new Response(JSON.stringify({ access_token: accessToken, disabled }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as Error)?.message ?? err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }
})

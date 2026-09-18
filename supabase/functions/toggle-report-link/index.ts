// POST /functions/v1/toggle-report-link
// body: { registrationIds: string[], action: "enable" | "disable" | "regenerate" }
import {
  CORS_HEADERS,
  requireAdminKey,
  notionGetPage,
  notionPatchPageProperties,
  generateToken,
  parseTokenValue,
  DISABLED_PREFIX,
} from "../_shared/adminShared.ts"

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })

  const authError = await requireAdminKey(req)
  if (authError) return authError

  try {
    const { registrationIds, action } = await req.json()
    if (!Array.isArray(registrationIds) || !registrationIds.length) throw new Error("registrationIds가 필요합니다.")
    if (!["enable", "disable", "regenerate"].includes(action)) throw new Error("action이 올바르지 않습니다.")

    const tokens: Record<string, string> = {}

    for (const registrationId of registrationIds) {
      const page = await notionGetPage(registrationId)
      const currentRaw = (page.properties?.["토큰"]?.rich_text ?? []).map((t: any) => t.plain_text).join("")
      const { accessToken: existingToken } = parseTokenValue(currentRaw)

      let newValue: string
      if (action === "regenerate") {
        const fresh = generateToken()
        newValue = fresh
        tokens[registrationId] = fresh
      } else if (action === "disable") {
        const base = existingToken ?? generateToken()
        newValue = `${DISABLED_PREFIX}${base}`
      } else {
        // enable
        const base = existingToken ?? generateToken()
        newValue = base
        tokens[registrationId] = base
      }

      await notionPatchPageProperties(registrationId, {
        "토큰": { rich_text: [{ text: { content: newValue } }] },
      })
    }

    return new Response(JSON.stringify({ ok: true, tokens }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as Error)?.message ?? err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }
})

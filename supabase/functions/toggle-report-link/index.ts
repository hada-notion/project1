// POST /functions/v1/toggle-report-link
// 등록(학원) DB의 링크 재발급/링크 비활성화 자동화가 호출한다.
// x-link-action: enable | disable | regenerate
import {
  CORS_HEADERS,
  requireAdminKey,
  notionGetPage,
  notionPatchPageProperties,
  generateToken,
  parseTokenValue,
  DISABLED_PREFIX,
} from "../_shared/adminShared.ts"
import { extractPageId } from "../_shared/notionClient.ts"

const SB_URL = Deno.env.get("SB_URL") ?? ""
const SB_SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""

function resolveLinkAction(req: Request, body: any): string | null {
  return req.headers.get("x-link-action") ?? new URL(req.url).searchParams.get("action") ?? body?.action ?? null
}

// 학부모 화면은 Notion이 아니라 report_cache를 읽으므로 토큰 속성만 바꾸면 기존 링크가 계속 열린다.
// 링크 상태 변경과 같은 요청 안에서 캐시의 토큰/차단 상태도 즉시 맞춘다.
async function updateCachedLinkState(registrationId: string, accessToken: string, disabled: boolean): Promise<void> {
  if (!SB_URL || !SB_SERVICE_ROLE_KEY) {
    throw new Error("SB_URL / SB_SERVICE_ROLE_KEY Secrets가 설정되어 있지 않습니다.")
  }
  const res = await fetch(
    `${SB_URL}/rest/v1/report_cache?registration_id=eq.${encodeURIComponent(registrationId)}`,
    {
      method: "PATCH",
      headers: {
        apikey: SB_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        access_token: accessToken,
        link_disabled: disabled,
        updated_at: new Date().toISOString(),
      }),
    },
  )
  if (!res.ok) throw new Error(`report_cache 링크 상태 갱신 실패: ${res.status} ${await res.text()}`)
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })

  const authError = await requireAdminKey(req)
  if (authError) return authError

  let body: any = {}
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  try {
    const action = resolveLinkAction(req, body)
    if (!action || !["enable", "disable", "regenerate"].includes(action)) {
      throw new Error("action이 올바르지 않습니다 (x-link-action 헤더, ?action= 쿼리, 또는 body.action이 필요합니다).")
    }

    let registrationIds: string[]
    if (Array.isArray(body?.registrationIds) && body.registrationIds.length) {
      registrationIds = body.registrationIds
    } else {
      const pageId = extractPageId(body)
      if (!pageId) throw new Error("registrationIds 또는 등록 페이지 id를 찾을 수 없습니다.")
      registrationIds = [pageId]
    }

    const tokens: Record<string, string> = {}

    for (const registrationId of registrationIds) {
      const page = await notionGetPage(registrationId)
      const currentRaw = (page.properties?.["토큰"]?.rich_text ?? []).map((t: any) => t.plain_text).join("")
      const { accessToken: existingToken } = parseTokenValue(currentRaw)

      let accessToken: string
      let disabled = false
      let notionTokenValue: string

      if (action === "regenerate") {
        accessToken = generateToken()
        notionTokenValue = accessToken
        tokens[registrationId] = accessToken
      } else if (action === "disable") {
        accessToken = existingToken ?? generateToken()
        disabled = true
        notionTokenValue = `${DISABLED_PREFIX}${accessToken}`
      } else {
        accessToken = existingToken ?? generateToken()
        notionTokenValue = accessToken
        tokens[registrationId] = accessToken
      }

      await notionPatchPageProperties(registrationId, {
        "토큰": { rich_text: [{ text: { content: notionTokenValue } }] },
      })
      await updateCachedLinkState(registrationId, accessToken, disabled)
    }

    return new Response(JSON.stringify({ ok: true, action, tokens }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  } catch (err) {
    console.error("toggle-report-link failed", err)
    return new Response(JSON.stringify({ error: String((err as Error)?.message ?? err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }
})

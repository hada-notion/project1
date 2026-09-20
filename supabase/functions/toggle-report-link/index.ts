// POST /functions/v1/toggle-report-link
// 등록(학원) DB의 "링크 재발급"/"링크 비활성화" 버튼(속성)이 호출한다.
//
// [2026-09-21] 기존 코드는 { registrationIds: string[], action: "enable"|"disable"|"regenerate" }
// 형태의 raw JSON 바디를 기대했지만, Notion 버튼/자동화의 "웹훅 보내기" 액션은 이런 임의의 JSON
// 바디를 직접 구성해서 보낼 수 없다(트리거 페이지 관련 필드만 자동으로 채워 보낸다). 즉 이 함수는
// 실제로는 한 번도 정상 호출될 수 없는 상태였다 (등록 DB에 실제로 연결도 안 되어 있었음).
//
// 다른 웹훅들이 이미 검증한 것과 같은 해결 패턴을 그대로 따른다: 자동화의 URL에 커스텀 HTTP 헤더를
// 추가해서(x-admin-key와 동일한 방식) 원하는 동작(action)을 함께 실어 보낸다.
//   - "링크 재발급" 버튼: x-admin-key: 0000, x-link-action: regenerate
//   - "링크 비활성화" 체크박스(버튼이 아니라 checkbox 속성이라 자동화 2개 필요):
//       체크됨  -> x-admin-key: 0000, x-link-action: disable
//       체크 해제 -> x-admin-key: 0000, x-link-action: enable
// (헤더가 없는 옛 방식 호출도 계속 지원하도록 body.action / URL 쿼리 ?action=도 fallback으로 확인한다.)
//
// registrationIds도 body에 직접 넣어 보낼 수 없으므로, _shared/notionClient.ts의 extractPageId로
// 트리거된 등록 페이지 자신의 id를 웹훅 바디에서 찾는다 (sync-exam-scope 등에서 이미 검증된 방식).
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

function resolveLinkAction(req: Request, body: any): string | null {
  return (
    req.headers.get("x-link-action") ??
    new URL(req.url).searchParams.get("action") ??
    body?.action ??
    null
  )
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
      throw new Error(
        "action이 올바르지 않습니다 (x-link-action 헤더, ?action= 쿼리, 또는 body.action 중 하나가 필요합니다).",
      )
    }

    let registrationIds: string[]
    if (Array.isArray(body?.registrationIds) && body.registrationIds.length) {
      // 옛 방식(직접 JSON 바디로 여러 건)도 계속 지원.
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

    return new Response(JSON.stringify({ ok: true, action, tokens }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as Error)?.message ?? err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }
})

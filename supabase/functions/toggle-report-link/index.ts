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
//
// [FIX, 2026-09-26] report_cache.registration_id는 text 컬럼이고 Notion API가 항상 반환하는
// 하이픈 포함 표준 UUID 포맷("xxxxxxxx-xxxx-...")으로 저장돼 있다. 그런데 이 함수를 호출하는 쪽은
// notionClient.ts의 extractPageId()로 뽑은 registrationId를 그대로 넘겨왔는데, extractPageId 내부
// idFromString()이 하이픈을 전부 제거해서 32자 hex 문자열을 돌려준다. Notion 페이지 조회/수정
// (notionGetPage/notionPatchPageProperties)은 하이픈 유무를 가리지 않아 정상 동작했지만, 이 함수의
// PostgREST 필터(`registration_id=eq.<하이픈 없는 값>`)는 저장된 하이픈 포함 문자열과 절대 일치하지
// 않아 매칭 행이 0개였다 -- PATCH가 0행에 적용돼도 PostgREST는 오류 없이 200을 반환하므로, 겉으로는
// "성공"했지만 실제로는 캐시가 전혀 갱신되지 않았다. 그 결과 Notion의 토큰 속성은 바뀌어도
// report_cache.access_token은 예전 값 그대로 남아, 옛 링크만 계속 열리고 새로 발급한 링크는 항상
// 404(유효하지 않은 토큰)가 났다. 이제 이 함수는 항상 Notion이 반환한 표준 하이픈 포맷 pageId를
// 받아서 그 값으로 필터링한다 (호출부에서 notionGetPage 응답의 page.id를 넘긴다).
async function updateCachedLinkState(canonicalRegistrationId: string, accessToken: string, disabled: boolean): Promise<void> {
  if (!SB_URL || !SB_SERVICE_ROLE_KEY) {
    throw new Error("SB_URL / SB_SERVICE_ROLE_KEY Secrets가 설정되어 있지 않습니다.")
  }
  const res = await fetch(
    `${SB_URL}/rest/v1/report_cache?registration_id=eq.${encodeURIComponent(canonicalRegistrationId)}`,
    {
      method: "PATCH",
      headers: {
        apikey: SB_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        access_token: accessToken,
        link_disabled: disabled,
        updated_at: new Date().toISOString(),
      }),
    },
  )
  if (!res.ok) throw new Error(`report_cache 링크 상태 갱신 실패: ${res.status} ${await res.text()}`)
  // [FIX, 2026-09-26] Prefer: return=minimal이면 0행 매칭도 200으로 조용히 넘어가서 이번 버그를
  // 알아채기 어려웠다. return=representation으로 바꿔 실제로 갱신된 행을 돌려받고, 0건이면 즉시
  // 명확한 오류를 던져서 report_cache와 Notion 토큰이 다시 어긋나면 바로 드러나게 한다.
  const updatedRows = await res.json()
  if (!Array.isArray(updatedRows) || updatedRows.length === 0) {
    throw new Error(
      `report_cache에 registration_id=${canonicalRegistrationId} 행이 없어 링크 상태를 갱신하지 못했습니다. ` +
        `sync-report-cache로 먼저 캐시를 생성한 뒤 다시 시도하세요.`,
    )
  }
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
      // [FIX, 2026-09-26] 아래부터는 입력으로 받은(하이픈이 제거됐을 수 있는) registrationId가 아니라,
      // Notion이 실제로 반환한 표준 하이픈 포맷 page.id를 report_cache 쪽 식별자로 사용한다.
      const canonicalRegistrationId = page.id
      const currentRaw = (page.properties?.["토큰"]?.rich_text ?? []).map((t: any) => t.plain_text).join("")
      const { accessToken: existingToken } = parseTokenValue(currentRaw)

      let accessToken: string
      let disabled = false
      let notionTokenValue: string

      if (action === "regenerate") {
        accessToken = generateToken()
        notionTokenValue = accessToken
        tokens[canonicalRegistrationId] = accessToken
      } else if (action === "disable") {
        accessToken = existingToken ?? generateToken()
        disabled = true
        notionTokenValue = `${DISABLED_PREFIX}${accessToken}`
      } else {
        accessToken = existingToken ?? generateToken()
        notionTokenValue = accessToken
        tokens[canonicalRegistrationId] = accessToken
      }

      await notionPatchPageProperties(registrationId, {
        "토큰": { rich_text: [{ text: { content: notionTokenValue } }] },
      })
      await updateCachedLinkState(canonicalRegistrationId, accessToken, disabled)
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

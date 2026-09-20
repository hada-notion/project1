// supabase/functions/send-textbook-notice/index.ts (v2)
// 교재비 안내 카카오 알림톡 발송. 교재비(학원) DB의 "안내문 전송" 버튼이 호출합니다.
// send-tuition-notice와 동일한 패턴을 따른다:
// - Notion 버튼의 "웹훅 보내기" 액션은 커스텀 HTTP 헤더를 보낼 수 없으므로,
//   x-admin-key 헤더가 없으면 요청 바디의 adminKey 필드도 확인한다 (수강료 안내 버튼과 동일한 방식으로
//   웹훅 바디에 adminKey를 고정값으로 추가해야 함).
// - 관리자 키는 adminShared의 getCurrentAdminKey()로 확인한다.
// - pfId/템플릿ID/발신번호는 "알림톡 설정(학원) DB"의 "교재비 안내" 행에서 조회하고,
//   값이 없거나 비활성화된 경우에만 Secrets 기본값(Fallback)으로 대체한다.
// - [v2, 2026-09-16] 교재비(학원) DB의 "안내문" 수식은 이제 계좌번호를 포함하지 않는다
//   (미납 교재 목록 + 합계 + 입금 안내 문구까지만 생성). 계좌번호 등 공통 안내 문구는
//   "알림톡 설정(학원) DB"의 "교재비 안내" 행 "안내멘트"에서 가져와 안내문 뒤에 이어붙인다
//   (getScheduleConfig, send-tuition-notice가 수강료 안내에 쓰는 것과 동일한 헬퍼).
//   카카오 알림톡 템플릿은 여전히 이 합쳐진 전체 문구를 하나의 변수(#{안내문})로 받는 형태를 권장한다.

import {
  notionGetPage,
  createSendLogEntry,
  getAlimtalkConfig,
  getScheduleConfig,
  getCurrentAdminKey,
  getBotUserId,
  assertValidPhone,
  extractErrorMessage,
} from "../_shared/adminShared.ts"
import {
  getFormulaText,
  getRelationFirstId,
  getRollupText,
  normalizePhone,
  isSendingLockActive,
  withSendingLock,
} from "../_shared/alimtalkShared.ts"

const SOLAPI_API_KEY = Deno.env.get("SOLAPI_API_KEY")!
const SOLAPI_API_SECRET = Deno.env.get("SOLAPI_API_SECRET")!
const SOLAPI_SENDER_NUMBER_FALLBACK = Deno.env.get("SOLAPI_SENDER_NUMBER") ?? ""
const SOLAPI_PF_ID_FALLBACK = Deno.env.get("SOLAPI_PF_ID") ?? ""
const SOLAPI_TEMPLATE_ID_TEXTBOOK_FALLBACK = Deno.env.get("SOLAPI_TEMPLATE_ID_TEXTBOOK") ?? ""

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

// 수강료 안내와 달리 부모 연락처는 교재비 카트 페이지 자신이 아니라, 연결된 "등록" 페이지의
// "학부모 연락처" 롤업에 들어있다. (2026-09-20, 웹훅 코드 정리 4단계) send-tuition-notice와
// 100% 중복이던 getRollupText/extractRollupItemText는 _shared/alimtalkShared.ts로 옮겼다.

function anyTitleText(page: any): string {
  const properties = page?.properties ?? {}
  for (const key of Object.keys(properties)) {
    const prop = properties[key]
    if (prop?.type === "title") {
      return (prop.title ?? []).map((t: any) => t.plain_text ?? "").join("")
    }
  }
  return ""
}

async function sendAlimtalk(
  to: string,
  variables: Record<string, string>,
  config: { pfId: string; templateId: string; senderNumber: string },
) {
  if (!to) throw new Error("Missing recipient phone number (학부모 연락처).")
  if (!config.templateId) {
    throw new Error(
      "템플릿 ID가 설정되지 않았습니다. '알림톡 설정(학원) DB'의 '교재비 안내' 행에 템플릿 ID를 입력해주세요.",
    )
  }
  const { SolapiMessageService } = await import("npm:solapi")
  const messageService = new SolapiMessageService(SOLAPI_API_KEY, SOLAPI_API_SECRET)
  return messageService.send({
    to: normalizePhone(to),
    from: normalizePhone(config.senderNumber),
    kakaoOptions: {
      pfId: config.pfId,
      templateId: config.templateId,
      variables,
      disableSms: false,
    },
  })
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

  let body: any
  try {
    body = await req.json()
  } catch (_e) {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }

  const adminKey = req.headers.get("x-admin-key") ?? body?.adminKey ?? null
  const currentAdminKey = await getCurrentAdminKey()
  if (!adminKey || adminKey !== currentAdminKey) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }

  try {
    const cartId = body?.data?.id ?? body?.cartId ?? body?.pageId ?? null
    if (!cartId) {
      return new Response(JSON.stringify({ error: "cartId required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const cartPage = await notionGetPage(cartId)

    if (isSendingLockActive(cartPage, "안내문 발송중")) {
      return new Response(JSON.stringify({ ok: true, message: "already_processing", cartId }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const notice = getFormulaText(cartPage, "안내문")
    // [v2] 계좌번호 등 공통 안내 문구는 "알림톡 설정(학원) DB"의 "교재비 안내" 행 "안내멘트"에서 가져와
    // 안내문 뒤에 이어붙인다 (안내멘트가 비어있으면 안내문만 사용).
    const scheduleConfig = await getScheduleConfig("교재비 안내")
    const accountNotice = scheduleConfig?.notice ?? ""
    const fullNotice = accountNotice ? `${notice}\n\n${accountNotice}` : notice
    const registrationId = getRelationFirstId(cartPage, "등록")
    if (!registrationId) {
      throw new Error("교재비 페이지에 연결된 등록이 없습니다.")
    }

    const registrationPage = await notionGetPage(registrationId)
    const studentName = anyTitleText(registrationPage) || "학생"
    const parentPhone = getRollupText(registrationPage, "학부모 연락처")

    const clickerUserId =
      body?.data?.properties?.["실행자"]?.people?.[0]?.id ??
      cartPage.properties?.["실행자"]?.people?.[0]?.id ??
      null
    const senderUserId = clickerUserId ?? (await getBotUserId().catch(() => null)) ?? undefined

    const config = await getAlimtalkConfig("교재비 안내", {
      pfId: SOLAPI_PF_ID_FALLBACK,
      templateId: SOLAPI_TEMPLATE_ID_TEXTBOOK_FALLBACK,
      senderNumber: SOLAPI_SENDER_NUMBER_FALLBACK,
    })

    const variables: Record<string, string> = {
      "#{학생이름}": studentName,
      "#{안내문}": fullNotice,
    }

    const sendResult = await withSendingLock(cartId, "안내문 발송중", async () => {
      try {
        assertValidPhone(parentPhone)
        return await sendAlimtalk(parentPhone, variables, config)
      } catch (sendErr) {
        await createSendLogEntry({
          registrationId,
          senderUserId,
          title: studentName || "교재비 안내",
          category: "교재비 안내",
          status: "실패",
          failReason: extractErrorMessage(sendErr),
        })
        throw sendErr
      }
    })

    await createSendLogEntry({
      registrationId,
      senderUserId,
      title: studentName || "교재비 안내",
      category: "교재비 안내",
      status: "성공",
    })

    return new Response(JSON.stringify({ sendResult }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})

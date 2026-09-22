// supabase/functions/send-textbook-notice/index.ts (v3)
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
// - [v2.1, 2026-09-21] #{학생이름} 변수에 등록 페이지의 제목("강인희 고1 A반"처럼 학생+반이 합쳐진 값)을
//   그대로 넣던 버그를 수정. 등록(학원) DB의 "학생이름(등록)" 롤업(학생(학원) DB 제목만 반영)을 사용해
//   실제 학생 이름만 들어가도록 변경했다.
// - [v3, 2026-09-23] 실제로 Solapi에 승인되어 있는 "교재비 안내" 템플릿을 확인해보니 변수가
//   #{학생이름}/#{클래스}/#{교재비안내}/#{안내멘트} 4개로 고정되어 있는데, 이 코드는 그동안
//   #{학생이름}/#{안내문} 2개만 보내고 있었다 (템플릿에 없는 #{안내문}은 그냥 무시되고, 템플릿이
//   기대하던 #{클래스}/#{교재비안내}/#{안내멘트}는 항상 빈 값으로 나갔던 것). 알림톡 자체는 성공으로
//   전송되어 "전송 내역"/"실시간 처리 상태"는 정상 표시됐지만, 실제 수신 메시지의 클래스/교재
//   목록/안내멘트 칸이 계속 비어 보였던 원인이 이것이었다. 이제 템플릿과 동일한 4개 변수로 정확히
//   맞춰 보낸다: #{학생이름}(학생이름(등록) 롤업), #{클래스}(교재비 DB의 "클래스명(표시)" 롤업),
//   #{교재비안내}(교재비 DB의 "미납교재" 수식 — 미납 목록 + 청구 금액), #{안내멘트}(알림톡 설정 DB의
//   "교재비 안내" 행 안내멘트, getAlimtalkConfig가 이미 반환하는 값이라 별도 getScheduleConfig 호출을
//   제거했다). "안내문" 수식 자체는 Notion 화면 미리보기용으로 계속 남겨두되, 발송 변수로는 쓰지 않는다.
// - [v3, 2026-09-23 #2] createSendLogEntry에 textbookCartId를 추가로 넘긴다. adminShared.ts가
//   전송로그의 "교재비" 관계를 지금까지 채워주지 않아서, 발송 자체는 성공해도 교재비(카트) 페이지의
//   "전송 내역"/"발송 횟수" 수식이 항상 빈 값으로 보이는 두 번째 버그가 있었다(보고서/수강료는 각각
//   reportId/tuitionId로 이미 연결되고 있었는데 교재비만 빠져 있었음).

import {
  notionGetPage,
  createSendLogEntry,
  getAlimtalkConfig,
  getCurrentAdminKey,
  resolveAdminKeyFromRequest,
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

  const adminKey = resolveAdminKeyFromRequest(req, body)
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

    // [v3] 카카오 템플릿의 #{교재비안내}/#{클래스}에 그대로 대응하는 값들.
    const textbookNotice = getFormulaText(cartPage, "미납교재")
    const className = getRollupText(cartPage, "클래스명(표시)")
    const registrationId = getRelationFirstId(cartPage, "등록")
    if (!registrationId) {
      throw new Error("교재비 페이지에 연결된 등록이 없습니다.")
    }

    const registrationPage = await notionGetPage(registrationId)
    // [v2.1] 등록 페이지 제목("강인희 고1 A반")이 아니라, 학생 실제 이름만 담긴 롤업을 사용한다.
    const studentName = getRollupText(registrationPage, "학생이름(등록)") || "학생"
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

    // [v3] 실제 승인된 템플릿 변수(#{학생이름}/#{클래스}/#{교재비안내}/#{안내멘트})에 정확히 맞춘다.
    // config.notice는 getAlimtalkConfig가 "알림톡 설정(학원) DB"의 "교재비 안내" 행 "안내멘트"를
    // 그대로 읽어온 값이라(adminShared.ts 참고) 별도 getScheduleConfig 호출이 필요 없다.
    const variables: Record<string, string> = {
      "#{학생이름}": studentName,
      "#{클래스}": className,
      "#{교재비안내}": textbookNotice,
      "#{안내멘트}": config.notice,
    }

    const sendResult = await withSendingLock(cartId, "안내문 발송중", async () => {
      try {
        assertValidPhone(parentPhone)
        return await sendAlimtalk(parentPhone, variables, config)
      } catch (sendErr) {
        await createSendLogEntry({
          registrationId,
          textbookCartId: cartId,
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
      textbookCartId: cartId,
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

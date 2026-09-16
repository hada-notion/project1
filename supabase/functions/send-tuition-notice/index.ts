// supabase/functions/send-tuition-notice/index.ts (v3)
// 수강료 안내 카카오 알림톡 발송. 수강료(학원) DB의 "수강료 안내 발송" 버튼이 호출합니다.
// - [v2] Notion 버튼의 "웹훅 보내기" 액션은 커스텀 HTTP 헤더를 보낼 수 없으므로,
//   x-admin-key 헤더가 없으면 요청 바디의 adminKey 필드도 확인합니다 (send-daily-report와 동일 패턴).
// - [v2] 관리자 키는 adminShared의 getCurrentAdminKey()로 확인합니다 (KV에 저장된 값이 있으면 그것을,
//   없으면 Secrets의 ADMIN_SECRET을 기본값으로 사용) — 다른 어드민 함수들과 동일한 방식입니다.
// - [v2] pfId/템플릿ID/발신번호는 "알림톡 설정(학원) DB"의 "수강료 안내" 행에서 조회하고,
//   값이 없거나 비활성화된 경우에만 Secrets 기본값(Fallback)으로 대체합니다.
// - [v2] 변수 매핑을 최종 확정된 알림톡 템플릿에 맞춰 갱신했습니다:
//   #{청구기간} #{학생이름} #{클래스} #{청구금액} #{안내멘트}
//   (청구기간(표시)/청구금액(표시)/클래스(수강료)/안내멘트는 2026-09 추가된 새 속성입니다.)
// - [v3, 2026-09-16] send-report와 100% 중복이던 헬퍼(getFormulaText/getDateRange/getRelationFirstId/
//   normalizePhone/발송중 락 처리)를 _shared/alimtalkShared.ts로 옮기고 이 파일에서는 가져다 씁니다
//   (로드맵 5-9 공용 모듈화 후속). 동작은 이전과 동일합니다.
// - [v4, 2026-09-17] "안내멘트"는 수강료(학원) DB에 존재하지도 않는 롤업(getRollupText(tuitionPage,
//   "안내멘트"))을 읽으려고 해서 항상 빈 값이 나가던 버그를 수정. 이제 getAlimtalkConfig()가 돌려주는
//   "알림톡 설정(학원) DB"의 "수강료 안내" 행 안내멘트를 그대로 사용한다 (adminShared.ts 참고).
// - [v5, 2026-09-17] 안내멘트가 여전히 발송 메시지에 안 보인다는 리포트로 원인 추적용 임시 디버그
//   로그 추가 (실제로 solapi에 보내는 variables 전체와 notice 길이를 로그로 남김). 기능 변경 없음.

import {
  notionGetPage,
  createSendLogEntry,
  getAlimtalkConfig,
  getCurrentAdminKey,
  getBotUserId,
  assertValidPhone,
  extractErrorMessage,
} from "../_shared/adminShared.ts"
import {
  getFormulaText,
  getDateRange,
  getRelationFirstId,
  normalizePhone,
  isSendingLockActive,
  withSendingLock,
} from "../_shared/alimtalkShared.ts"

const SOLAPI_API_KEY = Deno.env.get("SOLAPI_API_KEY")!
const SOLAPI_API_SECRET = Deno.env.get("SOLAPI_API_SECRET")!
const SOLAPI_SENDER_NUMBER_FALLBACK = Deno.env.get("SOLAPI_SENDER_NUMBER") ?? ""
const SOLAPI_PF_ID_FALLBACK = Deno.env.get("SOLAPI_PF_ID") ?? ""
const SOLAPI_TEMPLATE_ID_TUITION_FALLBACK = Deno.env.get("SOLAPI_TEMPLATE_ID_TUITION") ?? ""

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

function getRichText(page: any, name: string): string {
  return (page.properties?.[name]?.rich_text ?? []).map((t: any) => t.plain_text).join("")
}

function extractRollupItemText(item: any): string {
  if (!item) return ""
  if (item.type === "title") return (item.title ?? []).map((t: any) => t.plain_text).join("")
  if (item.type === "rich_text") return (item.rich_text ?? []).map((t: any) => t.plain_text).join("")
  if (item.type === "formula" && item.formula?.type === "string") return item.formula.string ?? ""
  if (item.type === "rollup") {
    const nested = item.rollup?.array?.[0]
    return extractRollupItemText(nested)
  }
  return ""
}

function getRollupText(page: any, name: string): string {
  const rollup = page.properties?.[name]?.rollup
  if (rollup?.type === "array") {
    return extractRollupItemText(rollup.array?.[0])
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
      "템플릿 ID가 설정되지 않았습니다. '알림톡 설정(학원) DB'의 '수강료 안내' 행에 템플릿 ID를 입력해주세요.",
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
    const tuitionId = body?.data?.id ?? body?.tuitionId ?? null
    if (!tuitionId) {
      return new Response(JSON.stringify({ error: "tuitionId required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const tuitionPage = await notionGetPage(tuitionId)

    if (isSendingLockActive(tuitionPage, "발송중")) {
      return new Response(JSON.stringify({ ok: true, message: "already_processing", tuitionId }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const studentName = getFormulaText(tuitionPage, "학생정보")
    const className = getRollupText(tuitionPage, "클래스(수강료)")
    const parentPhone = getRollupText(tuitionPage, "학부모 연락처")
    const period = getDateRange(tuitionPage, "청구기간")
    const periodDisplay = getFormulaText(tuitionPage, "청구기간(표시)")
    const amountDisplay = getFormulaText(tuitionPage, "청구금액(표시)")
    const billingMonth = getFormulaText(tuitionPage, "청구년월(보고서)")
    const registrationId = getRelationFirstId(tuitionPage, "등록")

    const clickerUserId =
      body?.data?.properties?.["실행자"]?.people?.[0]?.id ??
      tuitionPage.properties?.["실행자"]?.people?.[0]?.id ??
      null
    const senderUserId = clickerUserId ?? (await getBotUserId().catch(() => null)) ?? undefined

    const config = await getAlimtalkConfig("수강료 안내", {
      pfId: SOLAPI_PF_ID_FALLBACK,
      templateId: SOLAPI_TEMPLATE_ID_TUITION_FALLBACK,
      senderNumber: SOLAPI_SENDER_NUMBER_FALLBACK,
    })
    // [FIX, 2026-09-17] "안내멘트"는 수강료(학원) DB에 없는 롤업이 아니라, "알림톡 설정(학원) DB"의
    // "수강료 안내" 행 안내멘트를 그대로 쓴다 (예전 getRollupText(tuitionPage, "안내멘트")는 항상 빈 값이었음).
    const notice = config.notice

    const variables: Record<string, string> = {
      "#{청구년월}": billingMonth,
      "#{청구기간}": periodDisplay,
      "#{학생이름}": studentName,
      "#{클래스}": className,
      "#{청구금액}": amountDisplay,
      "#{안내멘트}": notice,
    }

    // [DEBUG, 2026-09-17] 안내멘트 누락 원인 추적용 임시 로그. 원인 파악 후 제거 예정.
    console.log(
      `[send-tuition-notice][debug] tuitionId=${tuitionId}, noticeLength=${notice.length}, templateId=${config.templateId}, pfId=${config.pfId}, variables=${JSON.stringify(variables)}`,
    )

    const sendResult = await withSendingLock(tuitionId, "발송중", async () => {
      try {
        assertValidPhone(parentPhone)
        return await sendAlimtalk(parentPhone, variables, config)
      } catch (sendErr) {
        if (registrationId) {
          await createSendLogEntry({
            registrationId,
            tuitionId,
            senderUserId,
            title: studentName || "수강료 안내",
            category: "수강료 안내",
            status: "실패",
            periodStart: period.start || undefined,
            periodEnd: period.end || undefined,
            failReason: extractErrorMessage(sendErr),
          })
        }
        throw sendErr
      }
    })

    if (registrationId) {
      await createSendLogEntry({
        registrationId,
        tuitionId,
        senderUserId,
        title: studentName || "수강료 안내",
        category: "수강료 안내",
        status: "성공",
        periodStart: period.start || undefined,
        periodEnd: period.end || undefined,
      })
    }

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

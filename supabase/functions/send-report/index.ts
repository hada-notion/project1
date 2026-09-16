// supabase/functions/send-report/index.ts (v2)
// 주간/월간 보고서 카카오 알림톡 발송을 하나로 통합한 함수입니다.
// send-weekly-report / send-monthly-report를 대체합니다 (이 둘은 이제 사용하지 않아도 됩니다).
//
// 이전에는 주간/월간이 카카오 템플릿 ID(pfId/템플릿ID/발신번호)가 서로 달라서 함수를 둘로 나눠야 했지만,
// 보고서(학원) DB에 이미 "보고서 구분"(주간 보고서 / 월간 보고서) 속성이 있으므로, 이 값을 읽어서
// "알림톡 설정(학원) DB"에서 알맞은 카테고리 행을 자동으로 고르도록 합쳤습니다.
// 덕분에 Notion "보고서 전송" 버튼 자동화 1개(조건 분기 없이) → 웹훅 1개로만 연결하면 됩니다.
//
// - 관리자 키는 getCurrentAdminKey()로 확인, 헤더가 없으면 바디의 adminKey도 확인 (Notion 버튼 웹훅은 커스텀 헤더를 못 보냄).
// - 보고서 링크(#{페이지ID})는 send-daily-report와 동일하게 "등록" 페이지의 영구 토큰("토큰" 속성)을 사용합니다.
// - [2026-09] "발송중" 체크박스 + "실시간 처리상태" 수식을 보고서(학원) DB에 추가했습니다. 이 함수가 실제로
//   카카오 발송을 시도하는 동안에만 "발송중"이 체크되도록 했습니다. 개별 "보고서 전송" 버튼 클릭과
//   "선택 일괄전송"(send-selected-notifications) 모두 결국 이 함수를 호출하므로, 별도 처리 없이 두 경로
//   모두에서 동일하게 실시간 상태가 반영됩니다. 일괄전송은 동시에 최대 3건만 처리하므로 실제로 지금
//   처리 중인 건만 "발송중"으로 표시됩니다.
// - [v2, 2026-09-16] send-tuition-notice와 100% 중복이던 헬퍼(getFormulaText/getDateRange/
//   getRelationFirstId/normalizePhone/발송중 락 처리)를 _shared/alimtalkShared.ts로 옮기고
//   이 파일에서는 가져다 씁니다 (로드맵 5-9 공용 모듈화 후속). 동작은 이전과 동일합니다.

import {
  notionGetPage,
  notionPatchPageProperties,
  generateToken,
  parseTokenValue,
  createSendLogEntry,
  getBotUserId,
  getAlimtalkConfig,
  getCurrentAdminKey,
  assertValidPhone,
  extractErrorMessage,
  type SendLogCategory,
} from "../_shared/adminShared.ts"
import {
  getFormulaText,
  getDateRange,
  getRelationFirstId,
  normalizePhone,
  isSendingLockActive,
  withSendingLock,
} from "../_shared/alimtalkShared.ts"

const ALIMTALK_CONFIG_CATEGORY = "보고서" as const

const SOLAPI_API_KEY = Deno.env.get("SOLAPI_API_KEY")!
const SOLAPI_API_SECRET = Deno.env.get("SOLAPI_API_SECRET")!
const SOLAPI_SENDER_NUMBER_FALLBACK = Deno.env.get("SOLAPI_SENDER_NUMBER") ?? ""
const SOLAPI_PF_ID_FALLBACK = Deno.env.get("SOLAPI_PF_ID") ?? ""
const SOLAPI_TEMPLATE_ID_WEEKLY_FALLBACK = Deno.env.get("SOLAPI_TEMPLATE_ID_WEEKLY") ?? ""
const SOLAPI_TEMPLATE_ID_MONTHLY_FALLBACK = Deno.env.get("SOLAPI_TEMPLATE_ID_MONTHLY") ?? ""
const REPORT_PATH = Deno.env.get("REPORT_PATH") ?? "/project1/student_report.html"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

const getSelectName = (page: any, name: string) => page.properties?.[name]?.select?.name ?? ""

function templateFallbackFor(_reportType: string): string {
  return SOLAPI_TEMPLATE_ID_WEEKLY_FALLBACK || SOLAPI_TEMPLATE_ID_MONTHLY_FALLBACK
}

async function syncStudentReport(registrationId: string): Promise<{ access_token: string; tokenQueryString: string }> {
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

  const tokenQueryString = REPORT_PATH + "?token=" + accessToken
  return { access_token: accessToken, tokenQueryString }
}

async function sendAlimtalk(
  to: string,
  variables: Record<string, string>,
  config: { pfId: string; templateId: string; senderNumber: string },
  reportType: string,
) {
  if (!to) throw new Error("Missing recipient phone number (학부모 연락처).")
  if (!config.templateId) {
    throw new Error(
      `템플릿 ID가 설정되지 않았습니다. '알림톡 설정(학원) DB'의 '${reportType}' 행에 템플릿 ID를 입력해주세요.`,
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
    const reportId = body?.data?.id ?? body?.reportId ?? null
    if (!reportId) {
      return new Response(JSON.stringify({ error: "reportId required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const reportPage = await notionGetPage(reportId)

    if (isSendingLockActive(reportPage, "발송중")) {
      return new Response(JSON.stringify({ ok: true, message: "already_processing", reportId }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const reportType = getSelectName(reportPage, "보고서 구분")
    if (reportType !== "주간 보고서" && reportType !== "월간 보고서") {
      throw new Error(`이 보고서의 '보고서 구분'이 "주간 보고서" / "월간 보고서" 중 하나가 아닙니다 (현재 값: "${reportType || "없음"}").`)
    }

    const studentName = getFormulaText(reportPage, "학생이름(보고서)")
    const parentPhone = getFormulaText(reportPage, "학부모 연락처(보고서)")
    const reportPeriodLabel = getFormulaText(reportPage, "보고서기간(보고서)")
    const className = getFormulaText(reportPage, "클래스(보고서)")
    const studyPeriod = getFormulaText(reportPage, "학습기간(보고서)")
    const reportSummary = getFormulaText(reportPage, "보고서요약(보고서)")
    const period = getDateRange(reportPage, "보고서 기간")
    const registrationId = getRelationFirstId(reportPage, "등록")

    if (!registrationId) {
      throw new Error("이 보고서에 연결된 '등록'이 없습니다.")
    }

    const { tokenQueryString } = await syncStudentReport(registrationId)

    const clickerUserId =
      body?.data?.properties?.["실행자"]?.people?.[0]?.id ??
      reportPage.properties?.["실행자"]?.people?.[0]?.id ??
      null
    const senderUserId = clickerUserId ?? (await getBotUserId().catch(() => null)) ?? undefined

    const config = await getAlimtalkConfig(ALIMTALK_CONFIG_CATEGORY, {
      pfId: SOLAPI_PF_ID_FALLBACK,
      templateId: templateFallbackFor(reportType),
      senderNumber: SOLAPI_SENDER_NUMBER_FALLBACK,
    })

    const variables: Record<string, string> = {
      "#{보고서기간}": reportPeriodLabel,
      "#{보고서구분}": reportType,
      "#{학생이름}": studentName,
      "#{클래스}": className,
      "#{학습기간}": studyPeriod,
      "#{보고서요약}": reportSummary,
      "#{페이지ID}": tokenQueryString,
    }

    const sendResult = await withSendingLock(reportId, "발송중", async () => {
      try {
        assertValidPhone(parentPhone)
        return await sendAlimtalk(parentPhone, variables, config, reportType)
      } catch (sendErr) {
        await createSendLogEntry({
          registrationId,
          reportId,
          senderUserId,
          title: studentName || reportType,
          category: reportType as SendLogCategory,
          status: "실패",
          periodStart: period.start || undefined,
          periodEnd: period.end || undefined,
          failReason: extractErrorMessage(sendErr),
        })
        throw sendErr
      }
    })

    await createSendLogEntry({
      registrationId,
      reportId,
      senderUserId,
      title: studentName || reportType,
      category: reportType as SendLogCategory,
      status: "성공",
      periodStart: period.start || undefined,
      periodEnd: period.end || undefined,
    })

    return new Response(JSON.stringify({ sendResult, reportType }), {
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

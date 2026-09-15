// supabase/functions/send-report/index.ts (v1)
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

// [NEW] 주간/월간 보고서는 카카오 알림톡 템플릿이 하나로 통합되어 있어서,
// "알림톡 설정(학원) DB"는 "보고서" 하나의 행만 조회합니다 (이전에는 주간/월간 2개 행이었음).
// 전송로그의 "발송 구분"은 이와 무관하게 여전히 "주간 보고서"/"월간 보고서"로 구분되어 기록됩니다.
const ALIMTALK_CONFIG_CATEGORY = "보고서" as const

const SOLAPI_API_KEY = Deno.env.get("SOLAPI_API_KEY")!
const SOLAPI_API_SECRET = Deno.env.get("SOLAPI_API_SECRET")!
// 아래 값들은 "알림톡 설정(학원) DB"에 값이 없을 때만 쓰이는 기본값(fallback)입니다.
const SOLAPI_SENDER_NUMBER_FALLBACK = Deno.env.get("SOLAPI_SENDER_NUMBER") ?? ""

// [NEW] 발송이 아무리 빨리 끝나도 "발송중" 상태가 최소 이 시간(ms) 동안은 화면에 보이도록 합니다.
const SENDING_MIN_VISIBLE_MS = 1200

// [NEW, 2026-09] 중복 발송 방지 안전장치: 이미 "발송중"이면 새로 시작하지 않고 즉시 반환한다
// (cascade-delete/sync-registration-* 등 다른 함수들이 이미 쓰고 있는 것과 동일한 패턴).
// run-auto-schedule(자동 스케줄)과 send-selected-notifications(수동 일괄전송)이 서로 다른
// 잠금 체계를 쓰고 있어 둘이 거의 동시에 같은 건을 처리하면 중복 발송될 수 있었는데, 실제 발송은
// 결국 이 함수를 공통으로 거치므로 여기서 막으면 두 경로 모두 자동으로 보호된다. 다만 이 시간(ms)
// 이상 락이 갱신되지 않았으면 이전 실행이 Edge Function 실행시간 제한 등으로 죽어서 응답 없이
// 멈춘 것으로 보고, 막지 않고 재시도한다 (그렇지 않으면 그 건이 영구히 발송 안 되고 멈춰버림).
const STALE_LOCK_MS = 3 * 60 * 1000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
const SOLAPI_PF_ID_FALLBACK = Deno.env.get("SOLAPI_PF_ID") ?? ""
const SOLAPI_TEMPLATE_ID_WEEKLY_FALLBACK = Deno.env.get("SOLAPI_TEMPLATE_ID_WEEKLY") ?? ""
const SOLAPI_TEMPLATE_ID_MONTHLY_FALLBACK = Deno.env.get("SOLAPI_TEMPLATE_ID_MONTHLY") ?? ""
const REPORT_PATH = Deno.env.get("REPORT_PATH") ?? "/project1/student_report.html"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

function normalizePhone(phone: string): string {
  return (phone || "").replace(/[^0-9]/g, "")
}

const getFormulaText = (page: any, name: string) => page.properties?.[name]?.formula?.string ?? ""
const getSelectName = (page: any, name: string) => page.properties?.[name]?.select?.name ?? ""

function getDateRange(page: any, name: string): { start: string; end: string } {
  const d = page.properties?.[name]?.date
  return { start: d?.start ?? "", end: d?.end ?? d?.start ?? "" }
}

function getRelationFirstId(page: any, name: string): string | null {
  return page.properties?.[name]?.relation?.[0]?.id ?? null
}

// 주간/월간 공통: 템플릿이 하나로 통합되어 있으므로, Notion 설정이 없을 때의 fallback도 하나만 씁니다.
function templateFallbackFor(_reportType: string): string {
  return SOLAPI_TEMPLATE_ID_WEEKLY_FALLBACK || SOLAPI_TEMPLATE_ID_MONTHLY_FALLBACK
}

// send-daily-report와 동일한 로직: 토큰이 있으면 재사용하고, 없거나 비활성화되었으면 새로 발급합니다.
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

    // [NEW] 이미 발송 처리 중이면(자동 스케줄과 수동 버튼/선택 일괄전송이 겹치는 경우 등) 새로
    // 시작하지 않고 즉시 반환한다 -- 이렇게 해야 같은 건이 동시에 두 번 발송되는 것을 막을 수 있다.
    if (reportPage.properties?.["발송중"]?.checkbox === true) {
      const lastEditedMs = reportPage.last_edited_time ? new Date(reportPage.last_edited_time).getTime() : 0
      const ageMs = Date.now() - lastEditedMs
      if (ageMs < STALE_LOCK_MS) {
        return new Response(JSON.stringify({ ok: true, message: "already_processing", reportId }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }
      console.log(
        `send-report: stale "발송중" lock detected for ${reportId} (age ${Math.round(ageMs / 1000)}s) — retrying instead of blocking`,
      )
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

    // [NEW] send-daily-report와 동일한 우선순위: 버튼을 실제로 클릭한 사람("실행자")이 있으면 그 사람을 "발송자"로 기록하고, 없으면 통합 봇 계정으로 대신합니다.
    // 웹훅 바디가 버튼 클릭 시점의 오래된 스냅샷을 보낼 수 있어, 다시 조회한 reportPage 값도 함께 확인합니다.
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

    // [NEW] "실시간 처리상태": 실제로 이 건을 발송 처리하는 동안에만 "발송중"을 체크합니다.
    // 체크/해제가 실패해도(예: 네트워크 오류) 실제 발송 자체는 막지 않도록 오류를 ���시합니다.
    const sendingStartedAt = Date.now()
    await notionPatchPageProperties(reportId, { "발송중": { checkbox: true } }).catch(() => {})

    let sendResult: unknown
    try {
      try {
        // [NEW] 연락처가 비었거나 형식이 이상하면 발송 시도 전에 걸러서, 실패 사유에
        // "연락처 오류: ..."로 명확하게 남긴다 (Solapi로 잘못 보내서 애매한 오류가 남는 것을 방지).
        assertValidPhone(parentPhone)
        sendResult = await sendAlimtalk(parentPhone, variables, config, reportType)
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
    } finally {
      // [NEW] 너무 빨리 끝났으면 "발송중" 표시가 최소한의 시간 동안 눈에 보이도록 잠깐 대기합니다.
      const elapsedMs = Date.now() - sendingStartedAt
      if (elapsedMs < SENDING_MIN_VISIBLE_MS) {
        await sleep(SENDING_MIN_VISIBLE_MS - elapsedMs)
      }
      // 성공/실패 관계없이 발송 처리가 끝나면 "발송중"을 항상 해제합니다.
      await notionPatchPageProperties(reportId, { "발송중": { checkbox: false } }).catch(() => {})
    }

    // 참고: "전송 완료"(person) 속성은 보고서(학원) DB에 존재하지 않습니다 -- 전송 여부/발송자는
    // 이미 전송로그(관계)와 그 "발송자" 속성으로 기록되므로 별도 person 속성이 필요 없습니다.

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

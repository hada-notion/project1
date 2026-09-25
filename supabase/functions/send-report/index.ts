// supabase/functions/send-report/index.ts (v2)
// 주간/월간 보고서 카카오 알림톡 발송을 하나로 통합한 함수입니다.
// send-weekly-report / send-monthly-report를 대체합니다 (이 둘은 이제 사용하지 않아도 됩니다).
//
// 이전에는 주간/월간이 카카오 템플릿 ID(pfId/템플릿ID/발신번호)가 서로 달라서 함수를 둘로 나눈야 했지만,
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
//   getRelationFirstId/normalizePhone/발송중 락 처리)를 _shared/alimtalkShared.ts로 옥기고
//   이 파일에서는 가져다 씁니다 (로드맵 5-9 공용 모듈화 후속). 동작은 이전과 동일합니다.
// - [v3, 2026-09-17] 보고서 발송 직전에 해당 등록의 출석/학습기록/학습활동과 report_cache를
//   다시 계산하는 안전망을 추가했다.
// - [v6, 2026-09-25] 최신화 실패를 무시하고 옛 캐시 링크를 보내던 동작을 제거했다. 이제 토큰 보장 ->
//   출석 원본 -> 학습기록/학습활동/선생님 코멘트 포함 완성 캐시가 성공한 경우에만 발송한다.
//   일괄전송에서 최신화가 실패한 건도 선택 체크를 해제해 같은 건이 체인에서 무한 반복되지 않는다.
// - [v4, 2026-09-22] 발송 성공 후 "일괄전송 선택" 체크박스를 자동으로 해제한다. 개별 "보고서 전송"
//   버튼으로 이미 보낸 건이 나중에 클래스/발송함의 "일괄 전송"에 다시 걸려 중복 발송되는 것을 막기
//   위함(사용자 요청). send-selected-notifications는 이미 자체적으로 성공 후 이 체크박스를 끄고
//   있었으므로, 개별 발송 경로에도 동일하게 적용해 두 경로의 동작을 통일한다. 이 갱신이 실패해도
//   (예: 일시적 Notion API 오류) 발송 자체는 이미 끝난 뒤이므로 응답에는 영향을 주지 않고 로그만 남긴다.
// - [v5, 2026-09-23, PART N-8: 일괄전송 고정 청크 재설계] send-selected-notifications가 호출할 때
//   (SYNC_WAIT_FLAG=true) 발송이 실패해도 "일괄전송 선택"을 해제한다. 예전에는 실패 시 체크박스를
//   그대로 켜둬서 "다음 일괄전송에서 재시도"를 노렸지만, 데이터 문제로 항상 실패하는 건이 있으면
//   매 이어달리기(자기 자신 재호출)마다 똑같이 다시 걸려 무한 반복될 위험이 있었다. 이제 일괄전송
//   경로는 "1건당 1회 시도 -> 결과와 무관하게 체크 해제"로 단순화하고, 실패 이력은 전송로그(자동화
//   로그)에 남기고 배치 완료 메시지에도 이름+사유를 나열해 사용자가 직접 확인/재처리하게 한다. 개별
//   "보고서 전송" 버튼 클릭(SYNC_WAIT_FLAG 없음)은 이 변경의 영향을 받지 않는다 -- 사람이 직접 누른
//   시도가 실패했다고 대상에서 자동으로 빠지면 오히려 혼란스러울 수 있어서, 그 경로는 기존 동작
//   (체크박스 유지)을 그대로 둔다.

import {
  notionGetPage,
  notionPatchPageProperties,
  createSendLogEntry,
  getBotUserId,
  getAlimtalkConfig,
  getCurrentAdminKey,
  resolveAdminKeyFromRequest,
  extractErrorMessage,
  type SendLogCategory,
} from "../_shared/adminShared.ts"
import {
  getFormulaText,
  getDateRange,
  getRelationFirstId,
  normalizePhone,
  resolveAlimtalkRecipients,
  isSendingLockActive,
  withSendingLock,
  SYNC_WAIT_FLAG,
} from "../_shared/alimtalkShared.ts"
import { refreshStudentReport } from "../_shared/dailyReportRefresh.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"

const ALIMTALK_CONFIG_CATEGORY = "보고서" as const

const SOLAPI_API_KEY = Deno.env.get("SOLAPI_API_KEY")!
const SOLAPI_API_SECRET = Deno.env.get("SOLAPI_API_SECRET")!
const SOLAPI_SENDER_NUMBER_FALLBACK = Deno.env.get("SOLAPI_SENDER_NUMBER") ?? ""
const SOLAPI_PF_ID_FALLBACK = Deno.env.get("SOLAPI_PF_ID") ?? ""
const SOLAPI_TEMPLATE_ID_WEEKLY_FALLBACK = Deno.env.get("SOLAPI_TEMPLATE_ID_WEEKLY") ?? ""
const SOLAPI_TEMPLATE_ID_MONTHLY_FALLBACK = Deno.env.get("SOLAPI_TEMPLATE_ID_MONTHLY") ?? ""
const REPORT_PATH = Deno.env.get("REPORT_PATH") ?? "/project1/student_report.html"

// 보고서(학원) DB / 수강료(학원) DB에 공통으로 있는 체크박스. send-selected-notifications가
// 일괄전송 대상을 고르는 필터이기도 하다 (_shared/PROP_BULK_SELECT와 이름을 동일하게 유지).
const PROP_BULK_SELECT = "일괄전송 선택"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

const getSelectName = (page: any, name: string) => page.properties?.[name]?.select?.name ?? ""

function templateFallbackFor(_reportType: string): string {
  return SOLAPI_TEMPLATE_ID_WEEKLY_FALLBACK || SOLAPI_TEMPLATE_ID_MONTHLY_FALLBACK
}

// 발송 성공 후에는 개별/일괄 경로 모두 "일괄전송 선택"을 끈다. 일괄 경로는 실패해도 1회
// 시도로 끝내야 다음 청크가 같은 보고서를 다시 집어 무한 반복하지 않으므로 실패 catch에서도 끈다.
// 속성 갱신 실패는 원래 발송/실패 결과를 바꾸지 않고 로그만 남긴다.
async function clearBulkSelectFlag(reportId: string): Promise<void> {
  try {
    await notionPatchPageProperties(reportId, { [PROP_BULK_SELECT]: { checkbox: false } })
  } catch (err) {
    console.error("일괄전송 선택 해제 실패:", reportId, (err as Error).message)
  }
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

  const adminKey = resolveAdminKeyFromRequest(req, body)
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
    const teacherComment = (reportPage.properties?.["선생님 한마디"]?.rich_text ?? [])
      .map((item: any) => item.plain_text ?? "")
      .join("")
      .trim()
    const period = getDateRange(reportPage, "보고서 기간")
    const registrationId = getRelationFirstId(reportPage, "등록")

    if (!registrationId) {
      throw new Error("이 보고서에 연결된 '등록'이 없습니다.")
    }

    // [NEW, 2026-09-23, PART N-7: 개별 버튼 응답 지연 해소] 개별 "보고서 전송" 버튼 클릭(웹훅
    // 보내기)이 아래 무거운 처리(캐시 재계산 + 알림톡 발송 + 로그 기록)를 끝까지 기다리다 시간
    // 초과로 실패 표시를 띄우는 사례가 있었다 (실제로는 끝까지 정상 완료됨 -- fix-attendance/종료
    // 처리와 동일한 원인). 반면 send-selected-notifications(일괄 전송)는 이 함수의 최종 성공/실패를
    // res.ok로 판단해 "일괄전송 선택" 체크박스를 끄거나 재시도용으로 남겨두므로, 그 경로는 예전과
    // 동일하게 끝까지 동기로 기다려야 한다. body에 SYNC_WAIT_FLAG(=true)가 있는지로 두 경로를
    // 구분한다 (send-selected-notifications만 이 플래그를 보낸다).
    const performSend = async (): Promise<{ sendResult: unknown; reportType: string }> => {
      const clickerUserId =
        body?.data?.properties?.["실행자"]?.people?.[0]?.id ??
        reportPage.properties?.["실행자"]?.people?.[0]?.id ??
        null
      const senderUserId = clickerUserId ?? (await getBotUserId().catch(() => null)) ?? undefined

      try {
        const result = await withSendingLock(reportId, "발송중", async () => {
          // 공용 전체 최신화는 토큰을 먼저 보장하고, 출석 원본과 학습기록·학습활동·보고서 코멘트를
          // 포함한 완성 캐시까지 성공해야 반환한다. 실패하면 아래 catch로 이동해 알림톡을 보내지 않는다.
          const { access_token, cacheRow } = await refreshStudentReport(registrationId)
          const tokenQueryString = REPORT_PATH + "?token=" + access_token

          // 현재 전송하려는 보고서에 선생님 코멘트가 있다면, 방금 생성한 캐시에 그 보고서 행이 실제로
          // 포함됐는지 확인한다. 코멘트 누락 상태로 링크를 보내는 것을 마지막 단계에서 차단한다.
          if (teacherComment) {
            const comments = (cacheRow.registration_detail?.report_comments ?? []) as Array<{ id?: string; comment?: string }>
            const normalizedReportId = reportId.replaceAll("-", "").toLowerCase()
            const included = comments.some((comment) =>
              String(comment.id ?? "").replaceAll("-", "").toLowerCase() === normalizedReportId &&
              comment.comment === teacherComment
            )
            if (!included) throw new Error("선생님 코멘트가 최신 보고서 캐시에 포함되지 않았습니다.")
          }

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

          const recipients = await resolveAlimtalkRecipients({
            registrationId,
            primaryPhone: parentPhone,
            recipientTarget: config.recipientTarget,
          })
          const sendResults = []
          for (const recipient of recipients) {
            sendResults.push(await sendAlimtalk(recipient.phone, variables, config, reportType))
          }
          return sendResults
        }, { skipMinVisibleDelay: body?.[SYNC_WAIT_FLAG] === true })

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
        await clearBulkSelectFlag(reportId)
        return { sendResult: result, reportType }
      } catch (err) {
        // 최신화/코멘트 검증/연락처/알림톡 중 어느 단계에서 실패해도 동일한 실패 로그를 남긴다.
        await createSendLogEntry({
          registrationId,
          reportId,
          senderUserId,
          title: studentName || reportType,
          category: reportType as SendLogCategory,
          status: "실패",
          periodStart: period.start || undefined,
          periodEnd: period.end || undefined,
          failReason: extractErrorMessage(err),
        }).catch((logErr) => console.error("보고서 실패 로그 기록 실패:", extractErrorMessage(logErr)))

        // 일괄전송은 실패 건도 1회 시도로 끝내야 다음 청크가 같은 페이지를 무한 반복하지 않는다.
        if (body?.[SYNC_WAIT_FLAG] === true) await clearBulkSelectFlag(reportId)
        throw err
      }
    }

    const waitForCompletion = body?.[SYNC_WAIT_FLAG] === true
    if (waitForCompletion) {
      const result = await performSend()
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    runInBackground(async () => {
      try {
        await performSend()
      } catch (err) {
        console.error("send-report background 처리 실패:", reportId, (err as Error).message)
      }
    })

    return respondAccepted({ reportId })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})

// supabase/functions/send-tuition-notice/index.ts (v2)
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

import {
  notionGetPage,
  notionPatchPageProperties,
  createSendLogEntry,
  getAlimtalkConfig,
  getCurrentAdminKey,
  getBotUserId,
  assertValidPhone,
  extractErrorMessage,
} from "../_shared/adminShared.ts"

// [2026-09] "발송중" 체크박스 + "실시간 처리상태" 수식을 수강료(학원) DB에 추가했습니다. 이 함수가 실제로
// 카카오 발송을 시도하는 동안에만 "발송중"이 체크되도록 했습니다. 개별 "안내문 발송" 버튼 클릭과
// "선택 일괄전송"(send-selected-notifications) 모두 결국 이 함수를 호출하므로, 별도 처리 없이 두 경로
// 모두에서 동일하게 실시간 상태가 반영됩니다. 일괄전송은 동시에 최대 3건만 처리하므로 실제로 지금
// 처리 중인 건만 "발송중"으로 표시됩니다.

const SOLAPI_API_KEY = Deno.env.get("SOLAPI_API_KEY")!
const SOLAPI_API_SECRET = Deno.env.get("SOLAPI_API_SECRET")!
// 아래 3개는 "알림톡 설정(학원) DB"에 값이 없을 때만 쓰이는 기본값(fallback)입니다.
const SOLAPI_SENDER_NUMBER_FALLBACK = Deno.env.get("SOLAPI_SENDER_NUMBER") ?? ""
const SOLAPI_PF_ID_FALLBACK = Deno.env.get("SOLAPI_PF_ID") ?? ""
const SOLAPI_TEMPLATE_ID_TUITION_FALLBACK = Deno.env.get("SOLAPI_TEMPLATE_ID_TUITION") ?? ""

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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

function normalizePhone(phone: string): string {
  return (phone || "").replace(/[^0-9]/g, "")
}

const getFormulaText = (page: any, name: string) => page.properties?.[name]?.formula?.string ?? ""

function getRichText(page: any, name: string): string {
  return (page.properties?.[name]?.rich_text ?? []).map((t: any) => t.plain_text).join("")
}

// rollup 배열의 항목 하나에서 텍스트를 뽑아낸다. 항목이 title/rich_text/formula(string)이면 그대로 쓰고,
// 항목이 또 다른 rollup(중첩 rollup, 예: "클래스(수강료)" → 등록."클래스명(등록)" → 클래스."클래스명",
// 또는 "학부모 연락처" → 등록."학부모 연락처" → 학생정보.전화번호 formula)이면 한 단계 더 파고든다.
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

function getDateRange(page: any, name: string): { start: string; end: string } {
  const d = page.properties?.[name]?.date
  return { start: d?.start ?? "", end: d?.end ?? d?.start ?? "" }
}

function getRelationFirstId(page: any, name: string): string | null {
  return page.properties?.[name]?.relation?.[0]?.id ?? null
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

  // [v2] 헤더에 없으면 바디의 adminKey 필드도 확인 (Notion 버튼 웹훅은 커스텀 헤더를 못 보냄).
  const adminKey = req.headers.get("x-admin-key") ?? body?.adminKey ?? null
  const currentAdminKey = await getCurrentAdminKey()
  if (!adminKey || adminKey !== currentAdminKey) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }

  try {
    // Notion 버튼(자동화) 웹훅은 { data: { id, ... } } 형태로 전체 페이지 스냅샷을 보낸다.
    // 대시보드 등 다른 호출자는 { tuitionId }로 직접 호출할 수 있다.
    const tuitionId = body?.data?.id ?? body?.tuitionId ?? null
    if (!tuitionId) {
      return new Response(JSON.stringify({ error: "tuitionId required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const tuitionPage = await notionGetPage(tuitionId)

    // [NEW] 이미 발송 처리 중이면(자동 스케줄과 수동 버튼/선택 일괄전송이 겹치는 경우 등) 새로
    // 시작하지 않고 즉시 반환한다 -- 이렇게 해야 같은 건이 동시에 두 번 발송되는 것을 막을 수 있다.
    if (tuitionPage.properties?.["발송중"]?.checkbox === true) {
      const lastEditedMs = tuitionPage.last_edited_time ? new Date(tuitionPage.last_edited_time).getTime() : 0
      const ageMs = Date.now() - lastEditedMs
      if (ageMs < STALE_LOCK_MS) {
        return new Response(JSON.stringify({ ok: true, message: "already_processing", tuitionId }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }
      console.log(
        `send-tuition-notice: stale "발송중" lock detected for ${tuitionId} (age ${Math.round(ageMs / 1000)}s) — retrying instead of blocking`,
      )
    }

    const studentName = getFormulaText(tuitionPage, "학생정보")
    const className = getRollupText(tuitionPage, "클래스(수강료)")
    const parentPhone = getRollupText(tuitionPage, "학부모 연락처")
    const period = getDateRange(tuitionPage, "청구기간")
    const periodDisplay = getFormulaText(tuitionPage, "청구기간(표시)")
    const amountDisplay = getFormulaText(tuitionPage, "청구금액(표시)")
    const billingMonth = getFormulaText(tuitionPage, "청구년월(보고서)") // [2026-09] 알림톡 템플릿에 #{청구년월} 변수가 추가되어 매핑
    const notice = getRollupText(tuitionPage, "안내멘트") // [2026-09] 안내멘트는 이제 수강료 건 자체가 아니라 "알림톡 설정" DB에서 롤업으로 바로 가져옴
    const registrationId = getRelationFirstId(tuitionPage, "등록")

    // [NEW] send-daily-report와 동일한 우선순위: 버튼을 실제로 클릭한 사람("실행자")이 있으면 그 사람을 "발송자"로 기록하고, 없으면 통합 봇 계정으로 대신합니다.
    // 웹훅 바디가 버튼 클릭 시점의 오래된 스냅샷을 보낼 수 있어, 다시 조회한 tuitionPage 값도 함께 확인합니다.
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

    const variables: Record<string, string> = {
      "#{청구년월}": billingMonth,
      "#{청구기간}": periodDisplay,
      "#{학생이름}": studentName,
      "#{클래스}": className,
      "#{청구금액}": amountDisplay,
      "#{안내멘트}": notice,
    }

    // [NEW] "실시간 처리상태": 실제로 이 건을 발송 처리하는 동안에만 "발송중"을 체크합니다.
    // 체크/해제가 실패해도(예: 네트워크 오류) 실제 발송 자체는 막지 않도록 오류를 무시합니다.
    // ���제 발송(Solapi 호출)이 1초도 안 걸릴 때가 많아서, 화면에서 "발송중"이 눈에 보이지도 못하고
    // 바로 사라지는 문제가 있었습니다. 그래서 발송이 아주 빨리 끝나도 최소 SENDING_MIN_VISIBLE_MS만큼은
    // "발송중" 상태를 유지한 ��� 해제하여, 눈으로 진행 상황을 확인할 수 있게 했습니다.
    const sendingStartedAt = Date.now()
    await notionPatchPageProperties(tuitionId, { "발송중": { checkbox: true } }).catch(() => {})

    let sendResult: unknown
    try {
      try {
        // [NEW] 연락처가 비었거나 형식이 이상하면 발송 시도 전에 걸러서, 실패 사유에
        // "연락처 오류: ..."로 명확하게 남긴다.
        assertValidPhone(parentPhone)
        sendResult = await sendAlimtalk(parentPhone, variables, config)
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
    } finally {
      // [NEW] 너무 빨리 끝났으면 "발송중" 표시가 최소한의 시간 동안 눈에 보이도록 잠깐 대기합니다.
      const elapsedMs = Date.now() - sendingStartedAt
      if (elapsedMs < SENDING_MIN_VISIBLE_MS) {
        await sleep(SENDING_MIN_VISIBLE_MS - elapsedMs)
      }
      // 성공/실패 관계없이 발송 처리가 끝나면 "발송중"을 항상 해제합니다.
      await notionPatchPageProperties(tuitionId, { "발송중": { checkbox: false } }).catch(() => {})
    }

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

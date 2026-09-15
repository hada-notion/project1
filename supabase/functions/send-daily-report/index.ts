// supabase/functions/send-daily-report/index.ts (v4)
// Sends the daily study-report Kakao AlimTalk for one class day, based on a single
// row in the attendance (출석) database.
// - [v4] Notion 버튼의 "웹훅 버내기" 액션은 지워진 HTTP 헤더를 보려지 않으뭐부터 굼사가율을 적용하여,
//   x-admin-key 헤더가 없을 경우 요츠 롐리의 adminKey 필드도 확인합니다.
// - [v3] pfId/템플릿ID/발신닫번호는 이제 "알림톡 설정(학원) DB"에서 조회합니다 (Secrets 값은 기본값으로만 사용).
// - [v3] 출석 DB의 "전송 완료"가 이제 수식(formula) 속성이뭐부터 더 이상 그 속성을 직접 patch하지 않습니다.
//   대신 전송로기(학원) DB 행에 "출석" 관계형과 "발송자" 인물 속성을 채워서, 출석 DB의 수식이 그 값을 읽어
//   자동으로 가상하도록 합니다.

import {
  notionGetPage as sharedGetNotionPage,
  notionPatchPageProperties,
  generateToken,
  parseTokenValue,
  createSendLogEntry,
  getBotUserId,
  getAlimtalkConfig,
} from "../_shared/adminShared.ts"

const SITE_BASE_URL = Deno.env.get("SITE_BASE_URL") ?? ""
const NOTION_API_BASE = "https://api.notion.com/v1"

// 이전 sync-student-report 함수와 동일한 로직입니다: 토큰이 있으면 재사용하고, 없거나 뱄토ꮙ으로면 새로 발급합니다.
async function syncStudentReport(registrationId: string): Promise<{ access_token: string; reportUrl: string }> {
  const page = await sharedGetNotionPage(registrationId)
  const currentRaw = (page.properties?.["토큰"]?.rich_text ?? []).map((t: any) => t.plain_text).join("")
  const { accessToken: existingToken, disabled } = parseTokenValue(currentRaw)

  let accessToken = existingToken
  if (!accessToken || disabled) {
    accessToken = generateToken()
    await notionPatchPageProperties(registrationId, {
      "토큰": { rich_text: [{ text: { content: accessToken } }] },
    })
  }

  const reportUrl = SITE_BASE_URL + "/student_report.html?token=" + accessToken
  return { access_token: accessToken, reportUrl }
}

const SUPABASE_URL = Deno.env.get("SB_URL")!
const SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY")!
const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET")!
const NOTION_TOKEN = Deno.env.get("NOTION_TOKEN")!

const SOLAPI_API_KEY = Deno.env.get("SOLAPI_API_KEY")!
const SOLAPI_API_SECRET = Deno.env.get("SOLAPI_API_SECRET")!
// 아뀌 3가건 이제 "기본값(fallback)"으로만 쓰윬에니.
// 실제 발송에 사용할 값은 매 요츠닷다 "알림톡 설정(학원) DB"에서 물은 조회하거롮니다,
// 그 DB에 값이 없거나 당화되었 경우에만 이 Secrets 값으로 대신합니다.
const SOLAPI_SENDER_NUMBER_FALLBACK = Deno.env.get("SOLAPI_SENDER_NUMBER") ?? ""
const SOLAPI_PF_ID_FALLBACK = Deno.env.get("SOLAPI_PF_ID") ?? ""
const SOLAPI_TEMPLATE_ID_DAILY_FALLBACK = Deno.env.get("SOLAPI_TEMPLATE_ID_DAILY") ?? ""

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

async function getEffectiveAdminKey(): Promise<string> {
  try {
    const res = await fetch(SUPABASE_URL + "/rest/v1/admin_settings?select=admin_key&id=eq.1", {
      headers: {
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": "Bearer " + SERVICE_ROLE_KEY,
      },
    })
    if (res.ok) {
      const rows = await res.json()
      if (rows.length && rows[0].admin_key) return rows[0].admin_key
    }
  } catch (_e) {
    // fall back to env var
  }
  return ADMIN_SECRET
}

async function notionGetPage(pageId: string) {
  return sharedGetNotionPage(pageId)
}

const getFormulaText = (page: any, name: string) =>
  page.properties?.[name]?.formula?.string ?? ""

const PARENT_PHONE_PROPERTY = "학보비 연리첨"

async function resolveParentPhone(attendancePage: any, registrationId: string): Promise<string> {
  const fromAttendance = getFormulaText(attendancePage, PARENT_PHONE_PROPERTY)
  if (fromAttendance) return fromAttendance

  const registrationPage = await notionGetPage(registrationId)
  const rollup = registrationPage.properties?.[PARENT_PHONE_PROPERTY]?.rollup
  if (rollup?.type === "array") {
    const first = rollup.array?.find((v: any) => v?.type === "formula" || v?.type === "rich_text")
    if (first?.type === "formula" && first.formula?.type === "string") return first.formula.string ?? ""
    if (first?.type === "rich_text") return (first.rich_text ?? []).map((t: any) => t.plain_text).join("")
  }
  return ""
}

function normalizePhone(phone: string): string {
  return (phone || "").replace(/[^0-9]/g, "")
}

// Real Solapi AlimTalk send. pfId/templateId/발신닫번호는 "알림톡 설정(학원) DB"에서 조회한 값을 우선 사용하고,
// 없으뭐부터 Secrets 기본값으로 대신합니다.
async function sendDailyReportAlimtalk(payload: {
  to: string
  variables: Record<string, string>
}) {
  if (!payload.to) {
    throw new Error("Missing recipient phone number (parent contact).")
  }

  const config = await getAlimtalkConfig("일일 보고서", {
    pfId: SOLAPI_PF_ID_FALLBACK,
    templateId: SOLAPI_TEMPLATE_ID_DAILY_FALLBACK,
    senderNumber: SOLAPI_SENDER_NUMBER_FALLBACK,
  })

  const { SolapiMessageService } = await import("npm:solapi")
  const messageService = new SolapiMessageService(SOLAPI_API_KEY, SOLAPI_API_SECRET)

  const result = await messageService.send({
    to: normalizePhone(payload.to),
    from: normalizePhone(config.senderNumber),
    kakaoOptions: {
      pfId: config.pfId,
      templateId: config.templateId,
      variables: payload.variables,
      disableSms: false,
    },
  })

  return result
}

// 발송 성공 시, 보고서 페이지의 "발송 로그" 속성에 발송 시각을 누적으로 기록합니다.
async function appendSendLog(attendancePage: any): Promise<void> {
  try {
    const reportRelation = attendancePage.properties?.["보고서"]?.relation
    const reportPageId = reportRelation?.[0]?.id
    if (!reportPageId) return

    const pageRes = await fetch(NOTION_API_BASE + "/pages/" + reportPageId, {
      headers: {
        "Authorization": "Bearer " + NOTION_TOKEN,
        "Notion-Version": "2022-06-28",
      },
    })
    if (!pageRes.ok) return
    const reportPage = await pageRes.json()
    const existing = (reportPage.properties?.["발송 로그"]?.rich_text ?? [])
      .map((t: any) => t.plain_text).join("")

    const nowKst = new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).format(new Date())
    const newLine = nowKst + " 발송 완료"
    const combined = existing ? existing + "\n" + newLine : newLine
    const trimmed = combined.length > 1900 ? combined.slice(combined.length - 1900) : combined

    await fetch(NOTION_API_BASE + "/pages/" + reportPageId, {
      method: "PATCH",
      headers: {
        "Authorization": "Bearer " + NOTION_TOKEN,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        properties: {
          "발송 로그": { rich_text: [{ text: { content: trimmed } }] },
        },
      }),
    })
  } catch (_e) {
    // 발송 로그 기록 실패는 전송 자신을 실패로 처리하지 않습니다.
  }
}

async function setReportSendingFlag(attendanceId: string, sending: boolean): Promise<void> {
  try {
    const props: Record<string, unknown> = { "보고서 전송중": { checkbox: sending } }
    // 새 전송이 시작되는 순간(버튼 클릭 직후) 이전 오류를 바로 지옗새, 끝날 때까지 오랡된 오류 텍스트가
    // 남아있지 않도록 합니다 (2026-09-11 fix).
    if (sending) {
      props["마지막 오류"] = { rich_text: [] }
    }
    await notionPatchPageProperties(attendanceId, props)
  } catch (_e) {
    // 상태 표시 실패는 전송 자신을 막지 않습니다.
  }
}

// [v8] 전송이 성공하면 "전송완료 체크"를 켜서, 사용자가 이 체크를 직접 해제하지 않는 한 같은 건을 다시 버튼으로 누를땄 재전송하지 않도록 합니다.
async function setReportCompleteFlag(attendanceId: string, complete: boolean): Promise<void> {
  try {
    await notionPatchPageProperties(attendanceId, { "전송완료 체크": { checkbox: complete } })
  } catch (_e) {
    // 상태 표시 실패는 전송 자신을 막지 않습니다.
  }
}

async function setLastError(attendanceId: string, message: string | null): Promise<void> {
  try {
    await notionPatchPageProperties(attendanceId, {
      "마지막 오류": { rich_text: message ? [{ text: { content: message.slice(0, 1900) } }] : [] },
    })
  } catch (_e) {
    // 상태 표시 실패는 전송 자신을 막지 않습니다.
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  // [v4] 요츠 바낔드를 부륰(따 한 번만) 파싱해서, 헤더가 없는 경우 바낔드의 adminKey로도 인증할 수 있게 합니다.
  let body: any
  try {
    body = await req.json()
  } catch (_e) {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }

  const adminKey = req.headers.get("x-admin-key") ?? body?.adminKey ?? null
  const effectiveAdminKey = await getEffectiveAdminKey()
  if (!adminKey || adminKey !== effectiveAdminKey) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }

  let attendanceId: string | null = null
  try {
    // [v6] Notion 버튼(자동화) 웹훅은 { source, data } 형태로 전송 페이지 정리만도 보뙔니다.
    // data.id 가 출석 페이지 id이고, data.properties["등록"].relation[0].id 가 등록 페이지 id입니다.
    // 직접 { registrationId, attendanceId } 형태로 호출하는 다말다말 호출자(예: 대시보딴 웹앱)도 여전히 지원합니다.
    attendanceId = body?.data?.id ?? body?.attendanceId ?? null
    const registrationId = body?.data?.properties?.["등록"]?.relation?.[0]?.id ?? body?.registrationId ?? null
    if (!registrationId || !attendanceId) {
      return new Response(JSON.stringify({ error: "registrationId, attendanceId required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    // [v6] "실시간 처리 상태" 수식이 이 함수의 진행 상황도 표시할 수 있도록,
    // 처리 시작 시 "보고서 전송중" 체크박스를 켜니다 (성공/실패 시 항상 다시 끔니다).
    await setReportSendingFlag(attendanceId, true)

    const { access_token, reportUrl } = await syncStudentReport(registrationId)

    const attendancePage = await notionGetPage(attendanceId)
    const studentName = getFormulaText(attendancePage, "학생이맄(보고서)")

    // [v8] 이미 전송 완료된 건이면(사용자가 "전송완료 체크"를 해제하지 않는 한) 재전송하지 않습니다.
    const alreadySent = attendancePage.properties?.["전송완료 체크"]?.checkbox === true
    if (alreadySent) {
      await setLastError(attendanceId, "이미 전송 완료된 건입니다. 다시 보난려면 '전송완료 체크'를 해제한 뒤 버튼을 놌듐거서요.")
      await setReportSendingFlag(attendanceId, false)
      return new Response(JSON.stringify({ skipped: true, message: "already sent" }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const className = getFormulaText(attendancePage, "클래스(보고서)")
    const classDate = getFormulaText(attendancePage, "수업일(보고서)")
    const attendanceStatus = getFormulaText(attendancePage, "출석상태(보고서)")
    const studyContent = getFormulaText(attendancePage, "학습 내용(보고서)")

    const parentPhone = await resolveParentPhone(attendancePage, registrationId)

    const REPORT_PATH = Deno.env.get("REPORT_PATH") ?? "/project1/student_report.html"
    const tokenQueryString = REPORT_PATH + "?token=" + access_token
    const variables: Record<string, string> = {
      "#{학생이맄}": studentName,
      "#{클래스}": className,
      "#{수업일}": classDate,
      "#{출석상태}": attendanceStatus,
      "#{학습내용}": studyContent,
      "#{페이지ID}": tokenQueryString,
    }

    // [v9] 이 버튼을 실제로 클릭한 사말이 있으뭐부터(버튼 자동화가 설정한 "실행자" 사말 속성) 그 사말을 "발송자"로 기록하고,
    // 없으뭐부터 통합 봇 계정으로 대신합니다. 웹훅 바낔드가 버튼 클릭 시점의 오랡된 스냅샷을 보뙔뭐부터 있어, 다시 조회한 attendancePage 값도 함께 확인합니다.
    const clickerUserId =
      body?.data?.properties?.["실행자"]?.people?.[0]?.id ??
      attendancePage.properties?.["실행자"]?.people?.[0]?.id ??
      null
    const botUserId = clickerUserId ?? (await getBotUserId().catch(() => null))

    let sendResult: unknown
    try {
      sendResult = await sendDailyReportAlimtalk({ to: parentPhone, variables })
    } catch (sendErr) {
      await createSendLogEntry({
        registrationId,
        attendanceId,
        senderUserId: botUserId ?? undefined,
        title: studentName || "일일 보고서",
        category: "일일 보고서",
        status: "실패",
        failReason: String((sendErr as any)?.message ?? sendErr),
      })
      throw sendErr
    }

    await appendSendLog(attendancePage)
    // 전송로기(학원) DB에도 구조화된 기록을 남김니다.
    // "출석" 관계형과 "발송자" 인물 속성을 채워서, 출석 DB의 "전송 완료" 수식이
    // 이 로기를 찾아 "몰월 마이 야기뭐심에 누가 전송했다"는 문구를 계산하도록 합니다.
    await createSendLogEntry({
      registrationId,
      attendanceId,
      senderUserId: botUserId ?? undefined,
      title: studentName || "일일 보고서",
      category: "일일 보고서",
      status: "성공",
    })

    await setLastError(attendanceId, null)
    await setReportCompleteFlag(attendanceId, true)
    await setReportSendingFlag(attendanceId, false)

    return new Response(JSON.stringify({ access_token, reportUrl, sendResult }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err) {
    if (attendanceId) {
      await setLastError(attendanceId, String((err as any)?.message ?? err))
      await setReportSendingFlag(attendanceId, false)
    }
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})

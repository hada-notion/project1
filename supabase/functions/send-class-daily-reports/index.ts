// supabase/functions/send-class-daily-reports/index.ts (v1)
// 하나의 수업(학원) DB 페이지에 연결된 모든 출석 학생에게 일일 보고서 AlimTalk을 일괄 전송합니다.
// - send-daily-report(v7)와 동일한 syncStudentReport/발송/로그 로직을 각 출석 건마다 반복 실행합니다.
// - 개별 학생 전송 실패가 있어도 나머지 학생 전송은 계속 진행합니다 (부분 성공 허용).
// - 진행 중에는 수업 페이지의 "보고서 일괄전송중" 체크박스를 켜서 "실시간 처리 상태" 수식에 표시되게 하고,
//   완료 후 항상 다시 끕니다.
// - 실패한 학생이 있으면 수업 페이지의 "마지막 오류"에 요약("N명 중 M명 실패: 이름1, 이름2")을 남기고,
//   전원 성공하면 그 필드를 비웁니다.
// - Notion 버튼의 "웹훅 보내기" 액션은 커스텀 헤더를 보낼 수 없으므로, x-admin-key 헤더가 없으면
//   요청 바디의 adminKey 필드도 확인합니다 (send-daily-report와 동일한 패턴).

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

const SUPABASE_URL = Deno.env.get("SB_URL")!
const SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY")!
const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET")!
const NOTION_TOKEN = Deno.env.get("NOTION_TOKEN")!

const SOLAPI_API_KEY = Deno.env.get("SOLAPI_API_KEY")!
const SOLAPI_API_SECRET = Deno.env.get("SOLAPI_API_SECRET")!
// 아래 3개는 "기본값(fallback)"으로만 쓰이고, 실제 값은 매 요청마다 "알림톡 설정(학원) DB"에서 조회합니다.
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

const PARENT_PHONE_PROPERTY = "학부모 연락처"

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

// send-daily-report와 동일한 로직: 토큰이 있으면 재사용하고, 없거나 비활성화면 새로 발급합니다.
async function syncStudentReport(registrationId: string): Promise<{ access_token: string; reportUrl: string }> {
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

  const reportUrl = SITE_BASE_URL + "/student_report.html?token=" + accessToken
  return { access_token: accessToken, reportUrl }
}

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
    // 발송 로그 기록 실패는 전송 자체를 실패로 처리하지 않습니다.
  }
}

// --- 출석(학원) DB 행 단위 상태 표시 (send-daily-report와 동일) ---
async function setAttendanceSendingFlag(attendanceId: string, sending: boolean): Promise<void> {
  try {
    const props: Record<string, unknown> = { "보고서 전송중": { checkbox: sending } }
    // 새 전송이 시작되는 순간 이전 오류를 바로 지웁새, 끝날 때까지 오래된 오류 텍스트가 남아있지
    // 않도록 합니다 (2026-09-11 fix).
    if (sending) {
      props["마지막 오류"] = { rich_text: [] }
    }
    await notionPatchPageProperties(attendanceId, props)
  } catch (_e) {
    // 상태 표시 실패는 전송 자체를 막지 않습니다.
  }
}

async function setAttendanceLastError(attendanceId: string, message: string | null): Promise<void> {
  try {
    await notionPatchPageProperties(attendanceId, {
      "마지막 오류": { rich_text: message ? [{ text: { content: message.slice(0, 1900) } }] : [] },
    })
  } catch (_e) {
    // 상태 표시 실패는 전송 자체를 막지 않습니다.
  }
}

// [v3] 전송이 성공하면 "전송완료 체크"를 켜서, 사용자가 이 체크를 직접 해제하지 않는 한 같은 건을 다시 버튼(개별/일괄 모두)으로 보내지 않도록 합니다.
async function setAttendanceCompleteFlag(attendanceId: string, complete: boolean): Promise<void> {
  try {
    await notionPatchPageProperties(attendanceId, { "전송완료 체크": { checkbox: complete } })
  } catch (_e) {
    // 상태 표시 실패는 전송 자체를 막지 않습니다.
  }
}

// --- 수업(학원) DB 페이지 단위 상태 표시 (이 함수 전용) ---
async function setClassBulkSendingFlag(classId: string, sending: boolean): Promise<void> {
  try {
    const props: Record<string, unknown> = { "보고서 일괄전송중": { checkbox: sending } }
    // 새 일괄 전송이 시작되는 순간 이전 오류를 바로 지웁새, 끝날 때까지 오래된 오류 텍스트가 남아있지
    // 않도록 합니다 (2026-09-11 fix).
    if (sending) {
      props["마지막 오류"] = { rich_text: [] }
    }
    await notionPatchPageProperties(classId, props)
  } catch (_e) {
    // 상태 표시 실패는 전송 자체를 막지 않습니다.
  }
}

async function setClassLastError(classId: string, message: string | null): Promise<void> {
  try {
    await notionPatchPageProperties(classId, {
      "마지막 오류": { rich_text: message ? [{ text: { content: message.slice(0, 1900) } }] : [] },
    })
  } catch (_e) {
    // 상태 표시 실패는 전송 자체를 막지 않습니다.
  }
}

// 출석 건 하나에 대한 일일 보고서 발송을 실행합니다. send-daily-report(v7)의 핵심 로직과 동일합니다.
// clickerUserId가 주어지면(수업 페이지에서 "보고서 일괄 전송" 버튼을 클릭한 사람) 그 사람을 "발송자"로 기록합니다.
async function sendOneStudentReport(attendanceId: string, clickerUserId?: string | null): Promise<{ studentName: string; skipped?: boolean }> {
  await setAttendanceSendingFlag(attendanceId, true)

  try {
    const attendancePage = await notionGetPage(attendanceId)
    const registrationId = attendancePage.properties?.["등록"]?.relation?.[0]?.id ?? null
    const studentName = getFormulaText(attendancePage, "학생이름(보고서)") || "(이름 미상)"

    if (!registrationId) {
      throw new Error("등록 관계가 비어 있습니다.")
    }

    // [v3] 이미 전송 완료된 건이면(사용자가 "전송완료 체크"를 해제하지 않는 한) 재전송하지 않고 건너뜁니다.
    const alreadySent = attendancePage.properties?.["전송완료 체크"]?.checkbox === true
    if (alreadySent) {
      await setAttendanceSendingFlag(attendanceId, false)
      return { studentName, skipped: true }
    }

    const { access_token } = await syncStudentReport(registrationId)

    const className = getFormulaText(attendancePage, "클래스(보고서)")
    const classDate = getFormulaText(attendancePage, "수업일(보고서)")
    const attendanceStatus = getFormulaText(attendancePage, "출석상태(보고서)")
    const studyContent = getFormulaText(attendancePage, "학습 내용(보고서)")

    const parentPhone = await resolveParentPhone(attendancePage, registrationId)

    const REPORT_PATH = Deno.env.get("REPORT_PATH") ?? "/project1/student_report.html"
    const tokenQueryString = REPORT_PATH + "?token=" + access_token
    const variables: Record<string, string> = {
      "#{학생이름}": studentName,
      "#{클래스}": className,
      "#{수업일}": classDate,
      "#{출석상태}": attendanceStatus,
      "#{학습내용}": studyContent,
      "#{페이지ID}": tokenQueryString,
    }

    // [v2] 수업 페이지에서 넘겨받은 실제 버튼 클릭자(clickerUserId)가 있으면 우선 사용하고,
    // 없거나 이 출석 페이지 자체의 "실행자" 속성이 따로 채워져 있으면 그것을, 둘 다 없으면 통합 봇 id로 대체합니다.
    const botUserId =
      clickerUserId ??
      attendancePage.properties?.["실행자"]?.people?.[0]?.id ??
      (await getBotUserId().catch(() => null))

    try {
      await sendDailyReportAlimtalk({ to: parentPhone, variables })
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
    await createSendLogEntry({
      registrationId,
      attendanceId,
      senderUserId: botUserId ?? undefined,
      title: studentName || "일일 보고서",
      category: "일일 보고서",
      status: "성공",
    })

    await setAttendanceLastError(attendanceId, null)
    await setAttendanceCompleteFlag(attendanceId, true)
    await setAttendanceSendingFlag(attendanceId, false)

    return { studentName }
  } catch (err) {
    await setAttendanceLastError(attendanceId, String((err as any)?.message ?? err))
    await setAttendanceSendingFlag(attendanceId, false)
    throw err
  }
}

// 실제 학생별 발송/기록 루프. Notion 버튼 자동화가 응답을 기다리다 타임아웃되지 않도록,
// 이 함수는 Deno.serve 핸들러가 응답을 반환한 뒤에도 EdgeRuntime.waitUntil로 백그라운드에서 계속 실행됩니다.
async function processClassBulkSend(classSessionId: string, attendanceIds: string[], clickerUserId?: string | null): Promise<void> {
  const failedNames: string[] = []
  const skippedNames: string[] = []
  let successCount = 0

  // 순서대로 하나씩 처리합니다 (동시 다발 발송으로 인한 알림톡 rate limit/중복 오류를 피하기 위함).
  for (const attendanceId of attendanceIds) {
    try {
      const result = await sendOneStudentReport(attendanceId, clickerUserId)
      if (result.skipped) {
        skippedNames.push(result.studentName)
      } else {
        successCount++
      }
    } catch (err) {
      let name = "(알 수 없음)"
      try {
        const page = await notionGetPage(attendanceId)
        name = getFormulaText(page, "학생이름(보고서)") || name
      } catch (_e) {
        // 이름 조회 실패는 무시하고 계속 진행합니다.
      }
      failedNames.push(name)
    }
  }

  const failCount = failedNames.length
  const messages: string[] = []
  if (failCount > 0) {
    messages.push(attendanceIds.length + "명 중 " + failCount + "명 실패: " + failedNames.join(", "))
  }
  if (skippedNames.length > 0) {
    // [v3] 이미 "전송완료 체크"가 되어 있어 재전송하지 않고 건너뛴 학생들을 알려줍니다.
    messages.push(skippedNames.length + "명은 이미 전송 완료되어 건너뜀: " + skippedNames.join(", "))
  }
  await setClassLastError(classSessionId, messages.length > 0 ? messages.join("\n") : null)
  await setClassBulkSendingFlag(classSessionId, false)
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

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

  // Notion 버튼(자동화) 웹훅은 { source, data } 형태로 전체 페이지 정보를 보냅니다.
  // data.id 가 수업 페이지 id입니다. 직접 { classSessionId } 형태로 호출하는 다른 호출자도 지원합니다.
  let classSessionId: string | null = null
  try {
    classSessionId = body?.data?.id ?? body?.classSessionId ?? null
    if (!classSessionId) {
      return new Response(JSON.stringify({ error: "classSessionId required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    await setClassBulkSendingFlag(classSessionId, true)

    // data.properties에 이미 "출석" 관계형이 포함되어 있으면 재사용하고, 없으면 페이지를 다시 조회합니다.
    let attendanceRelation = body?.data?.properties?.["출석"]?.relation ?? null
    // [v3] 웹훅 바디의 "실행자"는 버튼 클릭 시점의 오래된 스냅샷일 수 있어(속성 편집 액션이 끝나기 전 값), 항상
    // 수업 페이지를 다시 조회해서 최신 "실행자" 값도 함께 확인합니다.
    const classPage = await notionGetPage(classSessionId)
    if (!attendanceRelation) {
      attendanceRelation = classPage.properties?.["출석"]?.relation ?? []
    }
    const attendanceIds: string[] = (attendanceRelation ?? []).map((r: any) => r.id).filter(Boolean)

    // [v3] 이 수업의 "보고서 일괄 전송" 버튼을 실제로 클릭한 사람이 있으면 모든 학생의 발송자로 기록합니다.
    const clickerUserId: string | null =
      body?.data?.properties?.["실행자"]?.people?.[0]?.id ??
      classPage.properties?.["실행자"]?.people?.[0]?.id ??
      null

    if (attendanceIds.length === 0) {
      await setClassLastError(classSessionId, "이 수업에 연결된 출석 학생이 없습니다.")
      await setClassBulkSendingFlag(classSessionId, false)
      return new Response(JSON.stringify({ started: false, total: 0, message: "no attendance rows" }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    // [v2] Notion 버튼의 "웹훅 보내기" 액션은 응답이 늦으면 "웹훅 요청 시간이 초과되었습니다" 오류 배너를 띄웁니다.
    // 학생이 많으면 순차 발송에 시간이 오래 걸리므로, 실제 발송/기록 작업은 EdgeRuntime.waitUntil로
    // 백그라운드에서 계속 진행하고, 버튼에는 즉시 200 응답을 돌려줍니다.
    const backgroundWork = processClassBulkSend(classSessionId, attendanceIds, clickerUserId)
    const globalScope = globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }
    if (globalScope.EdgeRuntime?.waitUntil) {
      globalScope.EdgeRuntime.waitUntil(backgroundWork)
    } else {
      // EdgeRuntime이 없는 실행 환경(로컬 등)에서는 그냥 백그라운드로 흘려보냅니다.
      backgroundWork.catch(() => {})
    }

    return new Response(
      JSON.stringify({ started: true, total: attendanceIds.length }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
    )
  } catch (err) {
    if (classSessionId) {
      await setClassLastError(classSessionId, String((err as any)?.message ?? err))
      await setClassBulkSendingFlag(classSessionId, false)
    }
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})

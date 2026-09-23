// _shared/alimtalkShared.ts
//
// send-daily-report / send-tuition-notice / send-report / send-class-daily-reports 네 함수가
// 거의 동일하게 중복 구현하고 있던 헬퍼를 한 곳에 모은다 (로드맵 5-9 공용 모듈화 후속, 2026-09-16).
// 기능은 원래 각 파일의 구현과 100% 동일하게 유지했고, 코드 위치만 옮겼다. 파일별로 남아있는 차이
// (예: send-report는 REPORT_PATH 기반의 별도 토큰 URL 형식을 쓰고, send-tuition-notice/send-report는
// getCurrentAdminKey()(Deno KV)로 인증하는 반면 send-daily-report/send-class-daily-reports는
// getEffectiveAdminKey()(Supabase admin_settings 테이블)로 인증하는 등)는 실제 동작이 달라서
// 그대로 유지했다.

import {
  notionGetPage,
  notionPatchPageProperties,
  getAlimtalkConfig,
  parseTokenValue,
  generateToken,
} from "./adminShared.ts"

// ---------- 노션 속성 읽기 (4개 함수 공통) ----------

export const getFormulaText = (page: any, name: string): string => page.properties?.[name]?.formula?.string ?? ""

export function getDateRange(page: any, name: string): { start: string; end: string } {
  const d = page.properties?.[name]?.date
  return { start: d?.start ?? "", end: d?.end ?? d?.start ?? "" }
}

export function getRelationFirstId(page: any, name: string): string | null {
  return page.properties?.[name]?.relation?.[0]?.id ?? null
}

export function normalizePhone(phone: string): string {
  return (phone || "").replace(/[^0-9]/g, "")
}

// ---------- 롤업 텍스트 읽기 (send-tuition-notice / send-textbook-notice 공용) ----------
// (2026-09-20, 웹훅 코드 정리 4단계) 두 파일에 100% 동일하게 복사돼 있던 헬퍼를 이 파일로 옮겼다.

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

export function getRollupText(page: any, name: string): string {
  const rollup = page.properties?.[name]?.rollup
  if (rollup?.type === "array") {
    return extractRollupItemText(rollup.array?.[0])
  }
  return ""
}

// ---------- 관리자 키 확인 (send-daily-report / send-class-daily-reports 전용 방식) ----------

const SUPABASE_URL = Deno.env.get("SB_URL")!
const SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY")!
const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET")!

export async function getEffectiveAdminKey(): Promise<string> {
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

// ---------- 일일 보고서 발송 (send-daily-report / send-class-daily-reports 공용) ----------

const PARENT_PHONE_PROPERTY = "학부모 연락처"

export async function resolveParentPhone(attendancePage: any, registrationId: string): Promise<string> {
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

const SITE_BASE_URL = Deno.env.get("SITE_BASE_URL") ?? ""

export async function syncStudentReport(registrationId: string): Promise<{ access_token: string; reportUrl: string }> {
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

const SOLAPI_API_KEY = Deno.env.get("SOLAPI_API_KEY")!
const SOLAPI_API_SECRET = Deno.env.get("SOLAPI_API_SECRET")!
const SOLAPI_SENDER_NUMBER_FALLBACK = Deno.env.get("SOLAPI_SENDER_NUMBER") ?? ""
const SOLAPI_PF_ID_FALLBACK = Deno.env.get("SOLAPI_PF_ID") ?? ""
const SOLAPI_TEMPLATE_ID_DAILY_FALLBACK = Deno.env.get("SOLAPI_TEMPLATE_ID_DAILY") ?? ""

export async function sendDailyReportAlimtalk(payload: {
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

const NOTION_TOKEN = Deno.env.get("NOTION_TOKEN")!
const NOTION_API_BASE = "https://api.notion.com/v1"

export async function appendSendLog(attendancePage: any): Promise<void> {
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

// ---------- 출석(학원) DB 행 단위 상태 표시 (send-daily-report / send-class-daily-reports 공용) ----------

export async function setAttendanceReportSendingFlag(attendanceId: string, sending: boolean): Promise<void> {
  try {
    const props: Record<string, unknown> = { "보고서 전송중": { checkbox: sending } }
    if (sending) {
      props["마지막 오류"] = { rich_text: [] }
    }
    await notionPatchPageProperties(attendanceId, props)
  } catch (_e) {
    // 상태 표시 실패는 전송 자체를 막지 않습니다.
  }
}

export async function setAttendanceReportLastError(attendanceId: string, message: string | null): Promise<void> {
  try {
    await notionPatchPageProperties(attendanceId, {
      "마지막 오류": { rich_text: message ? [{ text: { content: message.slice(0, 1900) } }] : [] },
    })
  } catch (_e) {
    // 상태 표시 실패는 전송 자체를 막지 않습니다.
  }
}

export async function setAttendanceReportCompleteFlag(attendanceId: string, complete: boolean): Promise<void> {
  try {
    await notionPatchPageProperties(attendanceId, { "전송완료 체크": { checkbox: complete } })
  } catch (_e) {
    // 상태 표시 실패는 전송 자체를 막지 않습니다.
  }
}

// ---------- 동기 처리 요청 플래그 (send-selected-notifications 전용) ----------
// (2026-09-23, PART N-7: 개별 버튼 응답 지연 해소) send-report/send-tuition-notice는 개별 "보고서
// 전송"/"수강료 안내 발송" 버튼 클릭에서는 즉시 응답 + 백그라운드 처리로 바뀌지만,
// send-selected-notifications(일괄 전송)는 각 건의 실제 성공/실패를 res.ok로 판단해 "일괄전송
// 선택" 체크박스를 끄거나 재시도용으로 남겨둬야 하므로 예전과 동일하게 발송이 끝날 때까지 동기로
// 기다려야 한다. 호출부(send-selected-notifications)가 요청 바디에 이 필드를 true로 넣으면, 두
// 함수는 기존과 동일한 완전 동기 동작을 그대로 유지한다. 이름을 여기 한 곳에서만 정의해 호출부/
// 수신부가 서로 다른 문자열을 쓰는 실수를 막는다.
export const SYNC_WAIT_FLAG = "waitForCompletion"

// ---------- 발송중 락 (send-tuition-notice / send-report 공용) ----------

export const STALE_LOCK_MS = 3 * 60 * 1000
export const SENDING_MIN_VISIBLE_MS = 1200

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isSendingLockActive(page: any, lockPropName: string): boolean {
  if (page.properties?.[lockPropName]?.checkbox !== true) return false
  const lastEditedMs = page.last_edited_time ? new Date(page.last_edited_time).getTime() : 0
  const ageMs = Date.now() - lastEditedMs
  return ageMs < STALE_LOCK_MS
}

// [FIX, 2026-09-23, PART N-8: 일괄 전송 처리량 개선] SENDING_MIN_VISIBLE_MS(1.2초)는 사람이 개별
// 버튼을 눌렀을 때 "발송중" 체크박스가 너무 순식간에 사라지지 않도록 최소 노출 시간을 주기 위한
// 화면용 장치다. 그런데 send-selected-notifications(일괄 전송)가 건별로 이 함수를 호출할 때는
// 그 체크박스를 실시간으로 보고 있는 사람이 없는데도 매 건마다 이 지연이 그대로 적용되고 있었다
// (89건 × 1.2초 = 그것만으로 100초 이상 — 아래 PROCESSING_TIME_BUDGET_MS 예산을 대부분 잡아먹는
// 주범이었다). opts.skipMinVisibleDelay=true를 넘기면(일괄 전송 경로에서만 사용) 이 지연을
// 건너뛴다. 개별 버튼 클릭 경로는 옵션을 넘기지 않으므로 동작이 그대로 유지된다.
export async function withSendingLock<T>(
  pageId: string,
  lockPropName: string,
  fn: () => Promise<T>,
  opts?: { skipMinVisibleDelay?: boolean },
): Promise<T> {
  const startedAt = Date.now()
  await notionPatchPageProperties(pageId, { [lockPropName]: { checkbox: true } }).catch(() => {})
  try {
    return await fn()
  } finally {
    if (!opts?.skipMinVisibleDelay) {
      const elapsedMs = Date.now() - startedAt
      if (elapsedMs < SENDING_MIN_VISIBLE_MS) {
        await sleep(SENDING_MIN_VISIBLE_MS - elapsedMs)
      }
    }
    await notionPatchPageProperties(pageId, { [lockPropName]: { checkbox: false } }).catch(() => {})
  }
}

import { securityEnabled, currentInternalKey } from "./adminSecurity.ts"
import { fitVariablesToTemplate } from "./templateFit.ts"
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
  assertValidPhone,
  type AlimtalkRecipientTarget,
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
  if (securityEnabled()) return await currentInternalKey()
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

export type AlimtalkRecipient = { label: "우선 연락 대상" | "어머니" | "아버지" | "기타 보호자" | "학생"; phone: string }

function getPropertyText(property: any): string {
  if (!property) return ""
  if (property.type === "phone_number") return property.phone_number ?? ""
  if (property.type === "formula") return property.formula?.string ?? ""
  if (property.type === "rich_text") return (property.rich_text ?? []).map((item: any) => item.plain_text ?? "").join("")
  if (property.type === "title") return (property.title ?? []).map((item: any) => item.plain_text ?? "").join("")
  if (property.type === "rollup" && property.rollup?.type === "array") {
    return property.rollup.array.map(getPropertyText).find(Boolean) ?? ""
  }
  return ""
}

// 알림톡 설정의 수신 대상에 맞춰 연락처를 모은다. 우선 연락 대상은 등록 `학부모 연락처`(또는 넘겨받은 번호),
// 어머니·아버지·기타 보호자·학생은 등록 → 학생정보의 각 연락처. 같은 번호는 한 번만 보낸다.
// (10/31 사용자, 다중 선택) 대상을 하나만 골랐으면 그 번호가 없거나 잘못됐을 때 지금처럼 오류.
// 여럿을 골랐으면 없는 사람은 건너뛰고(예: 휴대폰 없는 학생) 한 명에게도 못 보낼 때만 오류.
// "모든 연락처"(예전 값)는 어머니·아버지·기타 보호자를 고른 것과 같다(그중 하나라도 있으면 보냄).
export async function resolveAlimtalkRecipients(args: {
  registrationId: string
  primaryPhone?: string
  recipientTarget: AlimtalkRecipientTarget | AlimtalkRecipientTarget[]
}): Promise<AlimtalkRecipient[]> {
  const raw = Array.isArray(args.recipientTarget) ? args.recipientTarget : [args.recipientTarget]
  const allGuardians = raw.includes("모든 연락처")
  const targets = [...new Set(raw.flatMap((t) => (t === "모든 연락처" ? ["어머니", "아버지", "기타 보호자"] : [t])))] as AlimtalkRecipient["label"][]
  if (!targets.length) targets.push("우선 연락 대상")
  const strict = targets.length === 1 && !allGuardians

  let registrationPage: any = null
  const registration = async () => (registrationPage ??= await notionGetPage(args.registrationId))
  let studentPage: any = null
  const student = async () => {
    if (studentPage) return studentPage
    const studentId = getRelationFirstId(await registration(), "학생정보")
    if (!studentId) throw new Error("연락처 오류: 등록 페이지에 연결된 학생정보가 없습니다.")
    return (studentPage = await notionGetPage(studentId))
  }
  const STUDENT_PROP: Record<string, string> = { "어머니": "어머니 연락처", "아버지": "아버지 연락처", "기타 보호자": "기타 보호자 연락처", "학생": "학생 연락처" }

  const out: AlimtalkRecipient[] = []
  const seen = new Set<string>()
  const skipped: string[] = []
  for (const label of targets) {
    let phone = ""
    if (label === "우선 연락 대상") {
      phone = args.primaryPhone ?? ""
      if (!phone) phone = getRollupText(await registration(), PARENT_PHONE_PROPERTY)
    } else {
      phone = getPropertyText((await student()).properties?.[STUDENT_PROP[label]])
    }
    const name = label === "우선 연락 대상" ? "우선 연락처" : `${label} 연락처`
    if (!phone) {
      if (strict && label === "우선 연락 대상") assertValidPhone(phone, name) // 예전과 같은 오류 문구
      if (strict) throw new Error(`연락처 오류: ${name}가 비어 있습니다.`)
      skipped.push(label)
      continue
    }
    try {
      assertValidPhone(phone, name)
    } catch (err) {
      if (strict) throw err
      skipped.push(label)
      continue
    }
    const normalized = normalizePhone(phone)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push({ label, phone: normalized })
  }
  if (!out.length) {
    throw new Error(allGuardians && targets.length === 3
      ? "연락처 오류: 어머니·아버지·기타 보호자 연락처가 모두 비어 있습니다."
      : `연락처 오류: 고른 수신 대상(${targets.join("·")})의 연락처가 모두 비어 있거나 잘못됐습니다.`)
  }
  return out
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
  registrationId: string
  primaryPhone: string
  variables: Record<string, string>
  // (v2.8.0 구역) 예체능 반은 "일일 활동 보고서" 행. 그 행이 없거나 꺼져 있으면 "일일 보고서" 행(변수는 같고 구역 이름만 다름).
  configCategory?: "일일 보고서" | "일일 활동 보고서"
}) {

  const category = payload.configCategory ?? "일일 보고서"
  const config = await getAlimtalkConfig(category, {
    pfId: SOLAPI_PF_ID_FALLBACK,
    templateId: SOLAPI_TEMPLATE_ID_DAILY_FALLBACK,
    senderNumber: SOLAPI_SENDER_NUMBER_FALLBACK,
  }, category === "일일 보고서" ? undefined : "일일 보고서")

  const { SolapiMessageService } = await import("npm:solapi")
  const messageService = new SolapiMessageService(SOLAPI_API_KEY, SOLAPI_API_SECRET)
  // (v2.8.0 통일안) 옛·새 템플릿 변수를 함께 받으므로 이 템플릿에 있는 것만 보낸다.
  const variables = await fitVariablesToTemplate(messageService, config.templateId, payload.variables)

  const recipients = await resolveAlimtalkRecipients({
    registrationId: payload.registrationId,
    primaryPhone: payload.primaryPhone,
    recipientTarget: config.recipientTarget,
  })
  const results = []
  for (const recipient of recipients) {
    results.push(await messageService.send({
      to: recipient.phone,
      from: normalizePhone(config.senderNumber),
      kakaoOptions: {
        pfId: config.pfId,
        templateId: config.templateId,
        variables,
        disableSms: false,
      },
    }, { allowDuplicates: true }))
  }
  return results
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

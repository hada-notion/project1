// 상담 신청 접수 안내 알림톡
// - 상담 폼: 학생 DB의 "페이지 추가" 자동화 + "개인정보 동의=체크됨" 조건으로 호출
// - 관리자 직접 입력: 학생 DB의 "접수안내 발송" 버튼으로 호출
// 상담 신청 시 선택한 "우선 연락 대상"의 번호로 발송하고, 당시 수신 정보를 로그에 보존한다.

import {
  CORS_HEADERS,
  assertValidPhone,
  extractErrorMessage,
  getCurrentAdminKey,
  notionCreatePage,
  notionGetPage,
  notionPatchPageProperties,
  notionQueryDatabase,
  resolveAdminKeyFromRequest,
} from "../_shared/adminShared.ts"
import { normalizePhone } from "../_shared/alimtalkShared.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"

const FUNCTION_NAME = "send-inquiry-receipt"
const CONFIG_CODE = "상담 신청 접수 안내"
const STATUS_PROP = "접수안내 상태"
const ERROR_PROP = "접수안내 마지막 오류"

const SOLAPI_API_KEY = Deno.env.get("SOLAPI_API_KEY")!
const SOLAPI_API_SECRET = Deno.env.get("SOLAPI_API_SECRET")!
const SOLAPI_SENDER_NUMBER_FALLBACK = Deno.env.get("SOLAPI_SENDER_NUMBER") ?? ""
const ALIMTALK_CONFIG_DB_ID =
  Deno.env.get("NOTION_ALIMTALK_CONFIG_DB_ID") || Deno.env.get("ALIMTALK_CONFIG_DB_ID") || ""
const SEND_LOG_DB_ID = Deno.env.get("NOTION_SEND_LOG_DB_ID") ?? ""
const CONFIG_CACHE_MS = 5 * 60 * 1000
const PROCESSING_STALE_MS = 10 * 60 * 1000

type Config = {
  active: boolean
  pfId: string
  templateId: string
  senderNumber: string
}

type StudentSnapshot = {
  studentName: string
  recipientType: string
  recipientPhone: string
  guardianRelation: string
  school: string
  grade: string
  status: string
}

type DeliveryState = {
  status: "processing" | "sent"
  startedAt: number
  sentAt?: number
  logCreated?: boolean
  snapshot?: StudentSnapshot
}

let kv: Deno.Kv | null | undefined
let memoryConfigCache: { value: Config; expiresAt: number } | null = null

async function getKvStore(): Promise<Deno.Kv | null> {
  if (kv !== undefined) return kv
  try {
    kv = await Deno.openKv()
  } catch (_err) {
    kv = null
  }
  return kv
}

function property(page: any, propertyName: string): any {
  return page?.properties?.[propertyName]
}

function plainText(value: any): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (!value) return ""
  if (typeof value?.name === "string") return value.name.trim()
  if (typeof value?.string === "string") return value.string.trim()
  if (typeof value?.phone_number === "string") return value.phone_number.trim()
  for (const key of ["title", "rich_text"]) {
    if (Array.isArray(value?.[key])) {
      return value[key].map((item: any) => item?.plain_text ?? item?.text?.content ?? "").join("").trim()
    }
  }
  return ""
}

function titleText(page: any, propertyName: string): string {
  return plainText(property(page, propertyName))
}

function richText(page: any, propertyName: string): string {
  return plainText(property(page, propertyName))
}

function formulaText(page: any, propertyName: string): string {
  const value = property(page, propertyName)
  return plainText(value?.formula ?? value)
}

function selectText(page: any, propertyName: string): string {
  const value = property(page, propertyName)
  return plainText(value?.select ?? value?.status ?? value)
}

function phoneText(page: any, propertyName: string): string {
  const value = property(page, propertyName)
  return plainText(value?.phone_number ?? value)
}

function snapshotFromPage(page: any): StudentSnapshot {
  const recipientType = selectText(page, "우선 연락 대상")
  const phoneProperty =
    recipientType === "어머니"
      ? "어머니 연락처"
      : recipientType === "아버지"
      ? "아버지 연락처"
      : recipientType === "기타 보호자"
      ? "기타 보호자 연락처"
      : ""
  return {
    studentName: titleText(page, "학생이름") || "학생",
    recipientType,
    recipientPhone:
      formulaText(page, "우선 연락처") || (phoneProperty ? phoneText(page, phoneProperty) : ""),
    guardianRelation: richText(page, "학생과의 관계"),
    school: formulaText(page, "학교(설문)") || richText(page, "학교(설문)"),
    grade: formulaText(page, "학년(설문)") || richText(page, "학년(설문)"),
    status: selectText(page, STATUS_PROP),
  }
}

function snapshotCanSend(snapshot: StudentSnapshot): boolean {
  return Boolean(snapshot.recipientType && snapshot.recipientPhone)
}

function payloadPage(body: any): any | null {
  const candidates = [body?.data?.page, body?.page, body?.data, body]
  return candidates.find((candidate) => candidate?.properties && typeof candidate.properties === "object") ?? null
}

async function setStatus(pageId: string, status: "⚪ 대기" | "🔄 작업중" | "✅ 완료" | "⚠️ 오류", error = "") {
  await notionPatchPageProperties(pageId, {
    [STATUS_PROP]: { select: { name: status } },
    [ERROR_PROP]: { rich_text: error ? [{ text: { content: error.slice(0, 1900) } }] : [] },
  })
}

async function getConfig(): Promise<Config> {
  if (!ALIMTALK_CONFIG_DB_ID) throw new Error("알림톡 설정 DB ID가 등록되지 않았습니다.")
  const now = Date.now()
  if (memoryConfigCache && memoryConfigCache.expiresAt > now) return memoryConfigCache.value

  const store = await getKvStore()
  const cacheKey = ["inquiry_receipt", "config", CONFIG_CODE]
  const cached = store ? (await store.get<{ value: Config; expiresAt: number }>(cacheKey)).value : null
  if (cached && cached.expiresAt > now) {
    memoryConfigCache = cached
    return cached.value
  }

  try {
    const json = await notionQueryDatabase(ALIMTALK_CONFIG_DB_ID, {
      filter: { property: "코드", rich_text: { equals: CONFIG_CODE } },
      page_size: 1,
    })
    const page = json.results?.[0]
    if (!page) throw new Error(`알림톡 설정에서 코드 '${CONFIG_CODE}' 행을 찾을 수 없습니다.`)

    const getText = (name: string) =>
      (page.properties?.[name]?.rich_text ?? []).map((item: any) => item.plain_text ?? "").join("").trim()
    const value: Config = {
      active: page.properties?.["활성 여부"]?.checkbox === true,
      pfId: getText("카카오 채널 ID (pfId)"),
      templateId: getText("템플릿 ID"),
      senderNumber: getText("발신번호") || SOLAPI_SENDER_NUMBER_FALLBACK,
    }
    const entry = { value, expiresAt: now + CONFIG_CACHE_MS }
    memoryConfigCache = entry
    await store?.set(cacheKey, entry)
    return value
  } catch (err) {
    if (cached?.value) {
      console.warn(`[${FUNCTION_NAME}] 설정 DB 조회 실패로 만료된 캐시 사용:`, extractErrorMessage(err))
      return cached.value
    }
    throw err
  }
}

async function writeLog(args: {
  studentId: string
  studentName: string
  status: "성공" | "실패"
  recipientType: string
  recipientPhone: string
  guardianRelation: string
  failReason?: string
}): Promise<boolean> {
  if (!SEND_LOG_DB_ID) return false
  try {
    const date = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const snapshot = [
      `신청 당시 우선 연락 대상: ${args.recipientType || "미입력"}`,
      args.recipientType === "기타 보호자" ? `학생과의 관계: ${args.guardianRelation || "미입력"}` : "",
      `수신번호: ${args.recipientPhone || "미입력"}`,
    ].filter(Boolean).join("\n")

    const properties: Record<string, unknown> = {
      "이름": { title: [{ text: { content: `[${CONFIG_CODE}] ${args.studentName} (${date})` } }] },
      "발송 구분": { select: { name: CONFIG_CODE } },
      "발송 상태": { select: { name: args.status } },
      "발송일시": { date: { start: new Date().toISOString() } },
      "발송 채널": { select: { name: "알림톡" } },
      "학생": { relation: [{ id: args.studentId }] },
      "메모": { rich_text: [{ text: { content: snapshot.slice(0, 1900) } }] },
    }
    if (args.failReason) {
      properties["실패 사유"] = {
        rich_text: [{ text: { content: args.failReason.slice(0, 1900) } }],
      }
    }
    await notionCreatePage(SEND_LOG_DB_ID, properties)
    return true
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] 자동화 로그 기록 실패:`, (err as Error).message)
    return false
  }
}

async function reconcileSent(studentId: string, state: DeliveryState) {
  const snapshot = state.snapshot!
  const statusTask = setStatus(studentId, "✅ 완료")
  const logTask = state.logCreated
    ? Promise.resolve(true)
    : writeLog({
      studentId,
      studentName: snapshot.studentName,
      status: "성공",
      recipientType: snapshot.recipientType,
      recipientPhone: snapshot.recipientPhone,
      guardianRelation: snapshot.guardianRelation,
    })
  const [statusResult, logResult] = await Promise.allSettled([statusTask, logTask])
  if (statusResult.status === "rejected") {
    console.error(`[${FUNCTION_NAME}] 완료 상태 기록 실패:`, extractErrorMessage(statusResult.reason))
  }
  if (logResult.status === "fulfilled" && logResult.value && !state.logCreated) {
    state.logCreated = true
    const store = await getKvStore()
    await store?.set(["inquiry_receipt", "delivery", studentId], state)
  }
}

async function processStudent(studentId: string, webhookPage: any | null) {
  const store = await getKvStore()
  const deliveryKey = ["inquiry_receipt", "delivery", studentId]
  let state = store ? (await store.get<DeliveryState>(deliveryKey)).value : null

  if (state?.status === "sent" && state.snapshot) {
    console.log(`[${FUNCTION_NAME}] 이미 발송됨, Notion 기록만 재확인:`, studentId)
    await reconcileSent(studentId, state)
    return
  }
  if (state?.status === "processing" && Date.now() - state.startedAt < PROCESSING_STALE_MS) {
    console.log(`[${FUNCTION_NAME}] 이미 처리 중이어서 건너뜀:`, studentId)
    return
  }

  let snapshot = webhookPage ? snapshotFromPage(webhookPage) : null
  try {
    if (!snapshot || !snapshotCanSend(snapshot)) {
      console.log(`[${FUNCTION_NAME}] 웹훅 속성이 부족해 학생 페이지 조회:`, studentId)
      const studentPage = await notionGetPage(studentId)
      snapshot = snapshotFromPage(studentPage)
    } else {
      console.log(`[${FUNCTION_NAME}] 웹훅 속성으로 우선 발송 처리:`, studentId)
    }
    if (snapshot.status === "✅ 완료") {
      console.log(`[${FUNCTION_NAME}] Notion에 이미 발송 완료로 표시되어 건너뜀:`, studentId)
      return
    }
    if (!snapshot.recipientType) throw new Error("우선 연락 대상을 선택해주세요.")

    const config = await getConfig()
    if (!config.active) {
      await setStatus(studentId, "⚪ 대기")
      console.log(`[${FUNCTION_NAME}] 알림톡 설정이 비활성화되어 발송을 건너뜀:`, studentId)
      return
    }
    if (!config.pfId) throw new Error("카카오 채널 ID (pfId)가 비어 있습니다.")
    if (!config.templateId) throw new Error("템플릿 ID가 비어 있습니다.")
    if (!config.senderNumber) throw new Error("발신번호가 비어 있습니다.")

    assertValidPhone(snapshot.recipientPhone, "우선 연락처")
    if (snapshot.recipientType === "기타 보호자" && !snapshot.guardianRelation) {
      throw new Error("기타 보호자의 학생과의 관계를 입력해주세요.")
    }

    state = { status: "processing", startedAt: Date.now(), snapshot }
    await store?.set(deliveryKey, state)

    const variables: Record<string, string> = {
      "#{학생이름}": snapshot.studentName,
      "#{학교}": snapshot.school || "미입력",
      "#{학년}": snapshot.grade || "미입력",
      "#{학부모연락처}": snapshot.recipientPhone,
    }

    const { SolapiMessageService } = await import("npm:solapi")
    const service = new SolapiMessageService(SOLAPI_API_KEY, SOLAPI_API_SECRET)
    await service.send({
      to: normalizePhone(snapshot.recipientPhone),
      from: normalizePhone(config.senderNumber),
      kakaoOptions: {
        pfId: config.pfId,
        templateId: config.templateId,
        variables,
        disableSms: false,
      },
    })

    state = { status: "sent", startedAt: state.startedAt, sentAt: Date.now(), logCreated: false, snapshot }
    await store?.set(deliveryKey, state)
    await reconcileSent(studentId, state)
    console.log(`[${FUNCTION_NAME}] 발송 완료:`, studentId)
  } catch (err) {
    const message = extractErrorMessage(err)
    if (state?.status !== "sent") await store?.delete(deliveryKey)
    if (snapshot) {
      await Promise.allSettled([
        setStatus(studentId, "⚠️ 오류", message),
        writeLog({
          studentId,
          studentName: snapshot.studentName,
          status: "실패",
          recipientType: snapshot.recipientType,
          recipientPhone: snapshot.recipientPhone,
          guardianRelation: snapshot.guardianRelation,
          failReason: message,
        }),
      ])
    } else {
      await setStatus(studentId, "⚠️ 오류", message).catch(() => {})
    }
    console.error(`[${FUNCTION_NAME}] 발송 실패:`, studentId, message)
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })

  let body: any = {}
  try {
    body = await req.json()
  } catch (_err) {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }

  const providedKey = resolveAdminKeyFromRequest(req, body)
  const currentKey = await getCurrentAdminKey()
  if (!providedKey || providedKey !== currentKey) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }

  const studentId =
    body?.data?.id ??
    body?.id ??
    body?.page?.id ??
    body?.data?.page_id ??
    body?.page_id ??
    body?.studentId ??
    body?.pageId ??
    null
  if (!studentId) {
    return new Response(JSON.stringify({ error: "studentId required" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }

  // 자동화 웹훅은 선택한 DB 속성을 함께 보낼 수 있으므로 그 스냅샷으로 먼저 발송한다.
  // 데이터베이스 버튼처럼 속성이 없는 요청만 Notion 페이지 조회로 보완한다.
  runInBackground(() => processStudent(studentId, payloadPage(body)))

  return respondAccepted({ studentId })
})

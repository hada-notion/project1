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

type Config = {
  active: boolean
  pfId: string
  templateId: string
  senderNumber: string
}

function titleText(page: any, propertyName: string): string {
  return (page.properties?.[propertyName]?.title ?? []).map((item: any) => item.plain_text ?? "").join("").trim()
}

function richText(page: any, propertyName: string): string {
  return (page.properties?.[propertyName]?.rich_text ?? [])
    .map((item: any) => item.plain_text ?? "")
    .join("")
    .trim()
}

function formulaText(page: any, propertyName: string): string {
  const formula = page.properties?.[propertyName]?.formula
  if (!formula) return ""
  if (formula.type === "string") return formula.string ?? ""
  return formula.string ?? ""
}

function selectText(page: any, propertyName: string): string {
  return page.properties?.[propertyName]?.select?.name ?? ""
}

async function setStatus(pageId: string, status: "⚪ 대기" | "🔄 작업중" | "✅ 완료" | "⚠️ 오류", error = "") {
  await notionPatchPageProperties(pageId, {
    [STATUS_PROP]: { select: { name: status } },
    [ERROR_PROP]: { rich_text: error ? [{ text: { content: error.slice(0, 1900) } }] : [] },
  })
}

async function getConfig(): Promise<Config> {
  if (!ALIMTALK_CONFIG_DB_ID) throw new Error("알림톡 설정 DB ID가 등록되지 않았습니다.")
  const json = await notionQueryDatabase(ALIMTALK_CONFIG_DB_ID, {
    filter: { property: "코드", rich_text: { equals: CONFIG_CODE } },
    page_size: 1,
  })
  const page = json.results?.[0]
  if (!page) throw new Error(`알림톡 설정에서 코드 '${CONFIG_CODE}' 행을 찾을 수 없습니다.`)

  const getText = (name: string) =>
    (page.properties?.[name]?.rich_text ?? []).map((item: any) => item.plain_text ?? "").join("").trim()

  return {
    active: page.properties?.["활성 여부"]?.checkbox === true,
    pfId: getText("카카오 채널 ID (pfId)"),
    templateId: getText("템플릿 ID"),
    senderNumber: getText("발신번호") || SOLAPI_SENDER_NUMBER_FALLBACK,
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
}) {
  if (!SEND_LOG_DB_ID) return
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
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] 자동화 로그 기록 실패:`, (err as Error).message)
  }
}

async function processStudent(studentId: string, studentPage: any) {
  const studentName = titleText(studentPage, "학생이름") || "학생"
  const recipientType = selectText(studentPage, "우선 연락 대상")
  const recipientPhone = formulaText(studentPage, "우선 연락처")
  const guardianRelation = richText(studentPage, "학생과의 관계")

  try {
    if (studentPage.properties?.["개인정보 동의"]?.checkbox !== true) {
      throw new Error("개인정보 동의를 확인한 뒤 발송해주세요.")
    }
    if (!recipientType) throw new Error("우선 연락 대상을 선택해주세요.")

    const config = await getConfig()
    if (!config.active) {
      await setStatus(studentId, "⚪ 대기")
      console.log(`[${FUNCTION_NAME}] 알림톡 설정이 비활성화되어 발송을 건너뜀:`, studentId)
      return
    }
    if (!config.pfId) throw new Error("카카오 채널 ID (pfId)가 비어 있습니다.")
    if (!config.templateId) throw new Error("템플릿 ID가 비어 있습니다.")
    if (!config.senderNumber) throw new Error("발신번호가 비어 있습니다.")

    assertValidPhone(recipientPhone, "우선 연락처")
    if (recipientType === "기타 보호자" && !guardianRelation) {
      throw new Error("기타 보호자의 학생과의 관계를 입력해주세요.")
    }

    const variables: Record<string, string> = {
      "#{학생이름}": studentName,
      "#{학교}": formulaText(studentPage, "학교(설문)") || "미입력",
      "#{학년}": formulaText(studentPage, "학년(설문)") || "미입력",
      "#{학부모연락처}": recipientPhone,
    }

    const { SolapiMessageService } = await import("npm:solapi")
    const service = new SolapiMessageService(SOLAPI_API_KEY, SOLAPI_API_SECRET)
    await service.send({
      to: normalizePhone(recipientPhone),
      from: normalizePhone(config.senderNumber),
      kakaoOptions: {
        pfId: config.pfId,
        templateId: config.templateId,
        variables,
        disableSms: false,
      },
    })

    await setStatus(studentId, "✅ 완료")
    await writeLog({
      studentId,
      studentName,
      status: "성공",
      recipientType,
      recipientPhone,
      guardianRelation,
    })
    console.log(`[${FUNCTION_NAME}] 발송 완료:`, studentId)
  } catch (err) {
    const message = extractErrorMessage(err)
    await setStatus(studentId, "⚠️ 오류", message).catch(() => {})
    await writeLog({
      studentId,
      studentName,
      status: "실패",
      recipientType,
      recipientPhone,
      guardianRelation,
      failReason: message,
    })
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

  const studentId = body?.data?.id ?? body?.studentId ?? body?.pageId ?? null
  if (!studentId) {
    return new Response(JSON.stringify({ error: "studentId required" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }

  try {
    const studentPage = await notionGetPage(studentId)
    const status = studentPage.properties?.[STATUS_PROP]?.select?.name ?? ""
    if (status === "✅ 완료") {
      return new Response(JSON.stringify({ ok: true, message: "already_sent", studentId }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      })
    }
    if (status === "🔄 작업중") {
      return new Response(JSON.stringify({ ok: true, message: "already_processing", studentId }), {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      })
    }

    await setStatus(studentId, "🔄 작업중")
    runInBackground(() => processStudent(studentId, studentPage))
    return respondAccepted({ studentId })
  } catch (err) {
    const message = extractErrorMessage(err)
    await setStatus(studentId, "⚠️ 오류", message).catch(() => {})
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }
})

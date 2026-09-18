// 이 파일은 새로 작성하는 5개 어드민 함수가 공통으로 쓰는 헬퍼입니다.
// reportShared.ts(학부모용 리포트 읽기 전용)와 별도로 분리해서 관리 입닥점을 명확하게 합니다.
//
// (2026-09-16, 로드맵 5-9) 노션 API 호출은 이제 notionClient.ts의 fetchWithRetry를 그대로 가져다
// 쓴다. 예전에는 이 파일이 순수 fetch만 써서 429(레이트리밋)/5xx를 만나면 바로 실패했는데,
// notionClient.ts 계열 함수들(cascade-delete/generate-classes/sync-registration-* 등)은 이미
// 자동 재시도가 되고 있어 두 계보의 안정성이 달랐다. 함수 시그니처/동작은 그대로 유지하고
// (정상 응답 시 차이 없음) 재시도 로직만 공유하도록 바꾼다 (기능 변경 없음).
//
// [FIX, 2026-09-17] 2026-09-16의 "안내멘트 버그 수정" 커밋(027a8ce)이 이 파일을 통째로 새로
// 작성하면서 getScheduleConfig/notionGetPage/notionPatchPageProperties/createSendLogEntry/
// getBotUserId/CORS_HEADERS/requireAdminKey 등 다른 Edge Function들이 쓰던 export를 대량으로
// 삭제해버렸다. 그 결과 generate-tuition 등에서 deno check가 실패해서, 그 이후의 모든 배포가
// type-check 단계에서 막혀 실제로는 한 번도 배포되지 않았다 (안내멘트 수정 자체도 포함).
// 이번 수정은 027a8ce 이전 버전 전체를 복원하고, notice 필드/디버그 로그만 그대로 유지한다.
// [FIX, 2026-09-17 #2] 복원 기준이었던 eee8078 버전에는 027a8ce 이전의 또 다른 커밋(cb036ee,
// "전송로그 발송 구분에 교재비 안내 카테고리 추가")이 반영되어 있지 않아서 SendLogCategory에
// "교재비 안내"가 빠져 있었다. send-textbook-notice가 이 카테고리로 로그를 남기려다 타입체크가
// 또 실패했음 -- 아래에 다시 추가한다.

import { fetchWithRetry } from "./notionClient.ts"

const NOTION_TOKEN = Deno.env.get("NOTION_TOKEN")!
const REGISTRATION_DB_ID = Deno.env.get("NOTION_REGISTRATION_DB_ID")!
// 전송로그(학원) DB. Supabase 프로젝트 Secrets에 실제 데이터베이스 ID를 등록해야 합니다.
const SEND_LOG_DB_ID = Deno.env.get("NOTION_SEND_LOG_DB_ID") ?? ""
// [NEW] 알림톡 설정(학원) DB. 카카오 채널 ID(pfId)/템플릿 ID를 코드 수정 없이 Notion에서 바꿀 수 있게 해줍니다.
// Supabase Secrets에 등록: supabase secrets set NOTION_ALIMTALK_CONFIG_DB_ID=<32자리 DB ID>
// (2026-09-15) Secrets에 이 값이 등록돼 있지 않으면 getScheduleConfig()가 항상 null을 반환해서
// generate-report/generate-tuition이 새로 만드는 건마다 "알림톡 설정" 관계형을 못 채우는 버그가 있었다.
// (getAlimtalkConfig 쪽은 실패 시 fallback 값으로 조용히 대체되어 발송 자체는 문제없이 되고 있었어서
// 이 문제가 드러나지 않았음). Secrets 미등록 시에도 항상 동작하도록 실제 DB ID를 기본값으로 넣어둔다.
// [FIX, 2026-09-17] 2026-09-16 커밋(027a8ce)이 실수로 이름을 ALIMTALK_CONFIG_DB_ID로 바꿔서
// Secrets에 등록된 기존 이름(NOTION_ALIMTALK_CONFIG_DB_ID)을 못 읽는 상태였다. 두 이름을 모두
// 인식하도록 해서 Secrets 이름 불일치로 인한 누락 가능성을 없앤다.
const ALIMTALK_CONFIG_DB_ID =
  Deno.env.get("NOTION_ALIMTALK_CONFIG_DB_ID") ||
  Deno.env.get("ALIMTALK_CONFIG_DB_ID") ||
  "e40c92b3-53cf-4f7e-bef5-46ffe52f4007"
const NOTION_VERSION = "2022-06-28"
const NOTION_API_BASE = "https://api.notion.com/v1"

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
}

export function notionHeaders() {
  return {
    "Authorization": "Bearer " + NOTION_TOKEN,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  }
}

export function getRegistrationDbId() {
  return REGISTRATION_DB_ID
}

// 내부 KV에 저장된 관리자 비밀번호가 있으면 그것을, 없으면 Secrets의 ADMIN_SECRET을 기본값으로 사용합니다.
let kv: Deno.Kv | null = null
async function getKv(): Promise<Deno.Kv | null> {
  if (kv) return kv
  try {
    kv = await Deno.openKv()
    return kv
  } catch (_e) {
    return null
  }
}

export async function getCurrentAdminKey(): Promise<string> {
  const store = await getKv()
  if (store) {
    const entry = await store.get(["admin_key"])
    if (entry.value) return String(entry.value)
  }
  return Deno.env.get("ADMIN_SECRET") ?? ""
}

export async function setCurrentAdminKey(newKey: string): Promise<boolean> {
  const store = await getKv()
  if (!store) return false
  await store.set(["admin_key"], newKey)
  return true
}

export async function requireAdminKey(req: Request): Promise<Response | null> {
  const provided = req.headers.get("x-admin-key") ?? ""
  const current = await getCurrentAdminKey()
  if (!current || provided !== current) {
    return new Response(JSON.stringify({ error: "인증 실패" }), { status: 401, headers: CORS_HEADERS })
  }
  return null
}

let cachedBotUserId: string | null = null
export async function getBotUserId(): Promise<string | null> {
  if (cachedBotUserId) return cachedBotUserId
  try {
    const res = await fetchWithRetry(NOTION_API_BASE + "/users/me", { headers: notionHeaders() })
    if (!res.ok) {
      console.error("getBotUserId 실패:", res.status, await res.text())
      return null
    }
    const data = await res.json()
    cachedBotUserId = data?.id ?? null
    if (!cachedBotUserId) {
      console.error("getBotUserId: 응답에 id가 없음", JSON.stringify(data))
    }
    return cachedBotUserId
  } catch (e) {
    console.error("getBotUserId 오류:", e)
    return null
  }
}

export async function notionQueryDatabase(databaseId: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetchWithRetry(NOTION_API_BASE + "/databases/" + databaseId + "/query", {
    method: "POST",
    headers: notionHeaders(),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error("Notion query failed: " + res.status + " " + (await res.text()))
  return res.json()
}

export async function notionQueryDatabaseAll(databaseId: string, body: Record<string, unknown>): Promise<any[]> {
  const results: any[] = []
  let cursor: string | undefined = undefined
  let loopCount = 0
  do {
    loopCount++
    const json = await notionQueryDatabase(databaseId, { ...body, start_cursor: cursor })
    results.push(...(json.results ?? []))
    cursor = json.has_more ? json.next_cursor : undefined
    if (loopCount > 50) break
  } while (cursor)
  return results
}

export async function notionGetPage(pageId: string): Promise<any> {
  const res = await fetchWithRetry(NOTION_API_BASE + "/pages/" + pageId, { headers: notionHeaders() })
  if (!res.ok) throw new Error("Notion page fetch failed: " + res.status + " " + (await res.text()))
  return res.json()
}

export async function notionPatchPageProperties(pageId: string, properties: Record<string, unknown>): Promise<any> {
  const res = await fetchWithRetry(NOTION_API_BASE + "/pages/" + pageId, {
    method: "PATCH",
    headers: notionHeaders(),
    body: JSON.stringify({ properties }),
  })
  if (!res.ok) throw new Error("Notion page update failed: " + res.status + " " + (await res.text()))
  return res.json()
}

export async function notionGetDatabase(databaseId: string): Promise<any> {
  const res = await fetchWithRetry(NOTION_API_BASE + "/databases/" + databaseId, { headers: notionHeaders() })
  if (!res.ok) throw new Error("Notion database fetch failed: " + res.status + " " + (await res.text()))
  return res.json()
}

const relatedDbCache = new Map<string, string>()

export async function resolveRelatedDatabaseId(fromDatabaseId: string, relationPropertyName: string): Promise<string> {
  const cacheKey = fromDatabaseId + ":" + relationPropertyName
  if (relatedDbCache.has(cacheKey)) return relatedDbCache.get(cacheKey)!
  const db = await notionGetDatabase(fromDatabaseId)
  const prop = db?.properties?.[relationPropertyName]
  const relatedId = prop?.relation?.database_id
  if (!relatedId) throw new Error('"' + relationPropertyName + '" relation이 가리키는 DB를 찾지 못함 (DB: ' + fromDatabaseId + ')')
  relatedDbCache.set(cacheKey, relatedId)
  return relatedId
}

export const DISABLED_PREFIX = "disabled:"

export function parseTokenValue(raw: string): { accessToken: string | null; disabled: boolean } {
  if (!raw) return { accessToken: null, disabled: false }
  if (raw.startsWith(DISABLED_PREFIX)) {
    return { accessToken: raw.slice(DISABLED_PREFIX.length), disabled: true }
  }
  return { accessToken: raw, disabled: false }
}

export function generateToken(): string {
  return crypto.randomUUID()
}

// "전송로그(학원) DB"에 알림톡 발송 결과 한 건을 기록합니다.
// [NEW] "출석"(relation) / "발송자"(person)를 채워서, 출석 DB의 "전송 완료" 수식이 자동 계산하도록 합니다.
export type SendLogCategory = "일일 보고서" | "주간 보고서" | "월간 보고서" | "수강료 안내" | "교재비 안내"
export type SendLogStatus = "성공" | "실패"

function formatSendLogDate(periodStart?: string): string {
  if (periodStart && /^\d{4}-\d{2}-\d{2}/.test(periodStart)) {
    return periodStart.slice(0, 10)
  }
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
  return kst.toISOString().slice(0, 10)
}

function buildSendLogTitle(name: string, category: SendLogCategory, periodStart?: string): string {
  return "[" + category + "] " + name + " (" + formatSendLogDate(periodStart) + ")"
}

export async function createSendLogEntry(args: {
  registrationId: string
  attendanceId?: string
  reportId?: string
  tuitionId?: string
  senderUserId?: string
  title: string
  category: SendLogCategory
  status: SendLogStatus
  periodStart?: string
  periodEnd?: string
  failReason?: string
}): Promise<void> {
  if (!SEND_LOG_DB_ID) return
  try {
    const formattedTitle = buildSendLogTitle(args.title, args.category, args.periodStart)
    const properties: Record<string, unknown> = {
      "이름": { title: [{ text: { content: formattedTitle.slice(0, 200) } }] },
      "발송 구분": { select: { name: args.category } },
      "발송 상태": { select: { name: args.status } },
      "발송일시": { date: { start: new Date().toISOString() } },
      "발송 채널": { select: { name: "알림톡" } },
      "등록": { relation: [{ id: args.registrationId }] },
    }
    if (args.attendanceId) {
      properties["출석"] = { relation: [{ id: args.attendanceId }] }
    }
    // [NEW] 보고서(주간/월간)와 수강료도 출석과 동일하게 전송로그에 연결해서,
    // 각 DB의 "전송 내역" 수식이 "누가 언제 보냈는지"를 계산할 수 있게 합니다.
    if (args.reportId) {
      properties["보고서"] = { relation: [{ id: args.reportId }] }
    }
    if (args.tuitionId) {
      properties["수강료"] = { relation: [{ id: args.tuitionId }] }
    }
    if (args.senderUserId) {
      properties["발송자"] = { people: [{ id: args.senderUserId }] }
    }
    if (args.periodStart) {
      properties["보고서 기간"] = {
        date: {
          start: args.periodStart,
          end: args.periodEnd && args.periodEnd !== args.periodStart ? args.periodEnd : null,
        },
      }
    }
    if (args.failReason) {
      properties["실패 사유"] = { rich_text: [{ text: { content: String(args.failReason).slice(0, 1900) } }] }
    }

    const res = await fetchWithRetry(NOTION_API_BASE + "/pages", {
      method: "POST",
      headers: notionHeaders(),
      body: JSON.stringify({
        parent: { database_id: SEND_LOG_DB_ID },
        properties,
      }),
    })
    if (!res.ok) {
      console.error("전송로그 기록 실패:", res.status, await res.text())
    }
  } catch (e) {
    console.error("전송로그 기록 중 오류:", e)
  }
}

// [NEW] "알림톡 설정(학원) DB"에서 발송 구분별 pfId/템플릿ID/발신번호를 가져옵니다.
// 카카오 채널이나 템플릿이 바뀌면 코드 수정 없이 이 Notion DB의 값만 바꾸면 됩니다.
// 설정 DB에 해당 행이 없거나 "활성 여부"가 꺼져 있거나 조회가 실패하면 fallback(Secrets 기본값)을 사용합니다.
export type AlimtalkConfig = {
  pfId: string
  templateId: string
  senderNumber: string
  // [NEW, 2026-09-17] "발송 구분" 행의 "안내멘트"를 그대로 담아서 반환한다.
  // 예전에는 send-tuition-notice가 수강료(학원) DB에 존재하지도 않는 "안내멘트" 롤업을 직접
  // 읽으려 했는데, 그 속성이 실제로는 없어서 항상 빈 값이 나가던 버그가 있었다.
  // 이제 발송 코드가 이 config.notice를 쓰도록 바꿔서 알림톡 설정 DB의 "안내멘트" 값이 그대로 반영된다.
  notice: string
}

const alimtalkConfigCache = new Map<string, { value: AlimtalkConfig; expiresAt: number }>()
const ALIMTALK_CONFIG_CACHE_MS = 60_000

// [NEW] 주간/월간 보고서는 카카오 템플릿이 하나로 통합되어 있어서, "알림톡 설정(학원) DB"에서는 "보고서" 하나의 행으로 조회합니다.
// 전송로그의 "발송 구분"(일일/주간/월간/수강료)은 이와 별개로 그대로 유지됩니다.
export type AlimtalkConfigCategory = SendLogCategory | "보고서"

// [NEW] 연락처(휴대폰/유선) 형식 검증. 비정상이면 "연락처 오류: ..." 형태의 명확한 에러를 던져서,
// 실패 사유(전송로그)에 그대로 남도록 한다.
export function assertValidPhone(phone: string, label = "학부모 연락처"): void {
  const digits = (phone || "").replace(/[^0-9]/g, "")
  if (!digits) {
    throw new Error(`연락처 오류: ${label}가 비어 있습니다.`)
  }
  if (digits.length < 9 || digits.length > 11) {
    throw new Error(`연락처 오류: ${label} 형식이 올바르지 않습니다 (입력값: "${phone}").`)
  }
}

// [NEW] Solapi 등 외부 API 오류 객체에서 가능한 한 상세한 메시지를 뽑아낸다.
// 단순 err.message만으로는 "Request failed" 같은 뭉뚱그려진 메시지만 남는 경우가 있어,
// 중첩된 응답 본문(response.data)이나 카카오/문자 발송 실패 상세를 함께 붙여준다.
export function extractErrorMessage(err: unknown): string {
  if (!err) return "알 수 없는 오류"
  const anyErr = err as any
  const nested =
    anyErr?.response?.data?.errorMessage ??
    anyErr?.response?.data?.message ??
    anyErr?.failedMessageList?.[0]?.statusMessage ??
    anyErr?.errorMessage ??
    null
  const base = anyErr?.message ?? String(err)
  if (nested && String(nested) !== String(base)) return `${base} (${nested})`
  return base
}

export async function getAlimtalkConfig(
  category: AlimtalkConfigCategory,
  fallback: { pfId: string; templateId: string; senderNumber: string },
): Promise<AlimtalkConfig> {
  const cached = alimtalkConfigCache.get(category)
  if (cached && cached.expiresAt > Date.now()) {
    // [DEBUG, 2026-09-17] 안내멘트 누락 원인 추적용 임시 로그. 원인 파악 후 제거 예정.
    console.log(
      `[getAlimtalkConfig][${category}] cache hit, noticeLength=${cached.value.notice.length}, noticePreview=${JSON.stringify(cached.value.notice.slice(0, 15))}`,
    )
    return cached.value
  }

  if (!ALIMTALK_CONFIG_DB_ID) {
    console.warn(`[getAlimtalkConfig][${category}] ALIMTALK_CONFIG_DB_ID env var가 비어있어 fallback 사용`)
    return { ...fallback, notice: "" }
  }

  try {
    const json = await notionQueryDatabase(ALIMTALK_CONFIG_DB_ID, {
      filter: {
        property: "발송 구분",
        title: { equals: category },
      },
      page_size: 1,
    })
    const page = json.results?.[0]
    if (!page) {
      console.warn(
        `[getAlimtalkConfig][${category}] ALIMTALK_CONFIG_DB_ID=${ALIMTALK_CONFIG_DB_ID}에서 일치하는 행을 못 찾음`,
      )
      return { ...fallback, notice: "" }
    }

    const active = page.properties?.["활성 여부"]?.checkbox
    if (active === false) {
      console.warn(`[getAlimtalkConfig][${category}] 해당 행의 활성 여부가 꺼져있어 fallback 사용 (pageId=${page.id})`)
      return { ...fallback, notice: "" }
    }

    const getText = (name: string) =>
      (page.properties?.[name]?.rich_text ?? []).map((t: any) => t.plain_text).join("").trim()

    const config: AlimtalkConfig = {
      pfId: getText("카카오 채널 ID (pfId)") || fallback.pfId,
      templateId: getText("템플릿 ID") || fallback.templateId,
      senderNumber: getText("발신번호") || fallback.senderNumber,
      notice: getText("안내멘트"),
    }

    // [DEBUG, 2026-09-17] 안내멘트 누락 원인 추적용 임시 로그. 원인 파악 후 제거 예정.
    console.log(
      `[getAlimtalkConfig][${category}] Notion 조회 성공, pageId=${page.id}, noticeLength=${config.notice.length}, noticePreview=${JSON.stringify(config.notice.slice(0, 15))}`,
    )

    alimtalkConfigCache.set(category, { value: config, expiresAt: Date.now() + ALIMTALK_CONFIG_CACHE_MS })
    return config
  } catch (e) {
    console.error(`[getAlimtalkConfig][${category}] 조회 실패, Secrets 기본값 사용:`, e)
    return { ...fallback, notice: "" }
  }
}

import { getPage } from "./notionClient.ts"

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
}

const SB_URL = Deno.env.get("SB_URL") ?? ""
const SB_SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""

export function text(prop: any): string {
  if (!prop) return ""
  switch (prop.type) {
    case "title":
      return (prop.title ?? []).map((t: any) => t.plain_text).join("")
    case "rich_text":
      return (prop.rich_text ?? []).map((t: any) => t.plain_text).join("")
    case "select":
      return prop.select?.name ?? ""
    case "status":
      return prop.status?.name ?? ""
    case "multi_select":
      return (prop.multi_select ?? []).map((s: any) => s.name).join(", ")
    case "phone_number":
      return prop.phone_number ?? ""
    case "number":
      return prop.number != null ? String(prop.number) : ""
    case "date":
      return prop.date?.start ?? ""
    case "formula": {
      const f = prop.formula
      if (!f) return ""
      if (f.type === "string") return f.string ?? ""
      if (f.type === "number") return f.number != null ? String(f.number) : ""
      if (f.type === "date") return f.date?.start ?? ""
      if (f.type === "boolean") return f.boolean ? "true" : ""
      return ""
    }
    default:
      return ""
  }
}

export function numberOf(prop: any): number | null {
  if (!prop) return null
  if (prop.type === "number") return prop.number
  if (prop.type === "formula" && prop.formula?.type === "number") return prop.formula.number
  if (prop.type === "rollup" && prop.rollup?.type === "number") return prop.rollup.number
  return null
}

export function dateStartOf(prop: any): string | null {
  if (!prop) return null
  if (prop.type === "date") return prop.date?.start ?? null
  if (prop.type === "formula" && prop.formula?.type === "date") return prop.formula.date?.start ?? null
  return null
}

export function dateEndOf(prop: any): string | null {
  if (!prop) return null
  if (prop.type === "date") return prop.date?.end ?? prop.date?.start ?? null
  if (prop.type === "formula" && prop.formula?.type === "date") return prop.formula.date?.end ?? prop.formula.date?.start ?? null
  return null
}

export function fileUrlOf(prop: any): string | undefined {
  if (!prop || prop.type !== "files") return undefined
  const f = prop.files?.[0]
  if (!f) return undefined
  return f.type === "external" ? f.external?.url : f.file?.url
}

export function relationIds(prop: any): string[] {
  return (prop?.relation ?? []).map((r: any) => r.id)
}

export function firstRelationId(prop: any): string | undefined {
  return relationIds(prop)[0]
}

export function anyTitle(page: any): string {
  const properties = page?.properties ?? {}
  for (const key of Object.keys(properties)) {
    const prop = properties[key]
    if (prop?.type === "title") {
      return (prop.title ?? []).map((t: any) => t.plain_text ?? "").join("")
    }
  }
  return ""
}

const WEEKDAY_KR = ["일", "월", "화", "수", "목", "금", "토"]

export function kstDateOf(iso: string | null): string {
  if (!iso) return ""
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(iso))
  } catch (_e) {
    return ""
  }
}

function kstYmd(iso: string | null): { y: number; m: number; d: number } | null {
  const kst = kstDateOf(iso)
  if (!kst) return null
  const [y, m, d] = kst.split("-").map(Number)
  if (!y || !m || !d) return null
  return { y, m, d }
}

export function dmWeekday(iso: string | null): { dm: string; wd: string } {
  const ymd = kstYmd(iso)
  if (!ymd) return { dm: "", wd: "" }
  const wd = WEEKDAY_KR[new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d)).getUTCDay()]
  return { dm: `${ymd.m}/${ymd.d}`, wd }
}

export function fmtDateKr(iso: string | null): string {
  const ymd = kstYmd(iso)
  if (!ymd) return ""
  const wd = WEEKDAY_KR[new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d)).getUTCDay()]
  return `${ymd.m}월 ${ymd.d}일 (${wd})`
}

export function normalizeStatus(s: string): string {
  if (!s) return ""
  if (s.includes("결석")) return "결석"
  if (s.includes("보강")) return "보강"
  if (s.includes("출석")) return "출석"
  if (s.includes("미제출")) return "미제출"
  if (s.includes("제출")) return "제출"
  return s.replace(/^[^\w가-힣]+/u, "").trim()
}

export function shortExamLabel(examTitle: string, gradeLabel: string): string {
  const t = (examTitle || "").trim()
  const g = (gradeLabel || "").trim()
  if (!t) return g
  const writtenMatch = t.match(/(\d)학기\s*(중간|기말)고사/)
  if (writtenMatch) {
    const [, semester, kind] = writtenMatch
    return g ? `${g}-${semester} ${kind}` : `${semester}학기 ${kind}`
  }
  const mockMatch = t.match(/(\d{1,2})월\s*모의고사/)
  if (mockMatch) {
    const [, month] = mockMatch
    return g ? `${g} ${month}모` : `${month}월모의`
  }
  if (t.includes("수능")) return g ? `${g} 수능` : "수능"
  return [g, t].filter(Boolean).join(" ").trim()
}

export function makePageCache() {
  const cache = new Map<string, Promise<any>>()
  return function cachedGetPage(pageId: string): Promise<any> {
    let p = cache.get(pageId)
    if (!p) {
      p = getPage(pageId)
      cache.set(pageId, p)
    }
    return p
  }
}

function requireSupabaseEnv() {
  if (!SB_URL || !SB_SERVICE_ROLE_KEY) {
    throw new Error("SB_URL / SB_SERVICE_ROLE_KEY Secrets가 설정되어 있지 않습니다. Supabase 대시보드 Edge Functions Secrets에 추가하세요.")
  }
}

// (2026-09-22, Phase 6: 동시성 제어) notionClient.ts의 fetchWithRetry와 같은 이유로 타임아웃을
// 추가했다 -- 이 함수는 sync_queue 적재/집기(claim)/완료표시 등 큐 메커니즘 자체가 의존하는
// Supabase REST/RPC 호출에 쓰이므로, 이 fetch가 응답 없이 멈추면 큐 전체가 멈출 수 있다.
// 마스터플랜: https://app.notion.com/p/903c90386c1d473494c5df6306c53517
const SUPABASE_FETCH_TIMEOUT_MS = 30_000

export async function fetchSupabaseWithRetry(url: string, init: RequestInit, maxRetries = 3): Promise<Response> {
  let lastRes: Response | undefined
  let lastErr: Error | undefined
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), SUPABASE_FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      if (res.ok || (res.status !== 401 && res.status < 500)) return res
      lastRes = res
      lastErr = undefined
      if (attempt === maxRetries) return res
      await new Promise((resolve) => setTimeout(resolve, 300 * Math.pow(2, attempt)))
    } catch (err) {
      lastErr = err as Error
      lastRes = undefined
      if (attempt === maxRetries) {
        throw new Error(
          `Supabase 요청이 ${maxRetries + 1}번 시도 후에도 실패함 (마지막 원인: ${lastErr.message}): ${url}`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 300 * Math.pow(2, attempt)))
    } finally {
      clearTimeout(timeoutId)
    }
  }
  if (lastRes) return lastRes
  throw lastErr ?? new Error(`fetchSupabaseWithRetry: 알 수 없는 오류로 응답을 받지 못함: ${url}`)
}

export type ReportCacheRow = {
  access_token: string
  registration_id: string
  student_key: string
  link_disabled?: boolean
  student_fields: Record<string, unknown>
  registration_overview: Record<string, unknown>
  registration_detail: Record<string, unknown>
  updated_at?: string
}

export async function upsertReportCacheRows(rows: ReportCacheRow[]): Promise<void> {
  if (rows.length === 0) return
  requireSupabaseEnv()
  const payload = rows.map((r) => ({ ...r, updated_at: new Date().toISOString() }))
  const res = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/report_cache?on_conflict=access_token`, {
    method: "POST",
    headers: {
      apikey: SB_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    throw new Error(`report_cache upsert 실패: ${res.status} ${await res.text()}`)
  }
}

export async function selectReportCacheByToken(token: string): Promise<ReportCacheRow | null> {
  requireSupabaseEnv()
  const res = await fetchSupabaseWithRetry(
    `${SB_URL}/rest/v1/report_cache?access_token=eq.${encodeURIComponent(token)}&link_disabled=eq.false&select=*`,
    { headers: { apikey: SB_SERVICE_ROLE_KEY, Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}` } },
  )
  if (!res.ok) throw new Error(`report_cache 조회 실패: ${res.status} ${await res.text()}`)
  const rows = await res.json()
  return rows[0] ?? null
}

// [FIX, 2026-09-19] 형제 등록 목록을 조회할 때 registration_overview만 가져와서, 프론트엔드가
// 화면에 열려 있는 등록(예: 다른 형제의 반)에 대해 "지금 바로 동기화" 요청을 보낼 registrationId를
// 알 방법이 없었다. registration_id도 함께 select해서 각 overview 객체에 얹어준다.
export async function selectReportCacheOverviewsByStudentKey(studentKey: string): Promise<Record<string, unknown>[]> {
  requireSupabaseEnv()
  const res = await fetchSupabaseWithRetry(
    `${SB_URL}/rest/v1/report_cache?student_key=eq.${encodeURIComponent(studentKey)}&link_disabled=eq.false&select=registration_id,registration_overview`,
    { headers: { apikey: SB_SERVICE_ROLE_KEY, Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}` } },
  )
  if (!res.ok) throw new Error(`report_cache(형제) 조회 실패: ${res.status} ${await res.text()}`)
  const rows = await res.json()
  return rows.map((r: any) => ({ ...r.registration_overview, registration_id: r.registration_id }))
}
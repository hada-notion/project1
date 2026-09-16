// 학부모 리포트 캐시(report_cache) 관련 함수(sync-report-cache/get-report-fast/get-report-detail)가
// 공통으로 쓰는 헬퍼. Notion API 호출 자체는 notionClient.ts(fetchWithRetry/getPage/queryAllPages 등)를
// 그대로 재사용하고, 여기서는 리포트 전용 속성 파싱 + Supabase(Postgres REST) 접근만 추가한다.

import { getPage } from "./notionClient.ts"

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
}

const SB_URL = Deno.env.get("SB_URL") ?? ""
const SB_SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""

// ---------- Notion 속성 읽기 (raw Notion API 페이지 property 객체 기준) ----------

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

// 속성명을 몰라도, 페이지의 title 타입 속성을 찾아서 반환한다 (DB마다 title 속성명이 달라서
// "이름"/"교재명"처럼 이름을 아는 경우를 빼고는 이 함수를 쓰는 게 안전하다).
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

export function dmWeekday(iso: string | null): { dm: string; wd: string } {
  if (!iso) return { dm: "", wd: "" }
  const d = new Date(iso)
  return { dm: `${d.getMonth() + 1}/${d.getDate()}`, wd: WEEKDAY_KR[d.getDay()] }
}

export function fmtDateKr(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY_KR[d.getDay()]})`
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

// "1학기 중간고사", "3월 모의고사" 같은 시험범위 이름 + 학년 라벨을 짧은 표시용 문구로 조합한다.
// (2026-09-16 성적 DB "시험구분" 속성 삭제로, 더 이상 그 속성을 직접 쓸 수 없어 새로 만든 대체 로직)
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

// ---------- 페이지 캐시 (같은 실행 안에서 같은 페이지 중복 조회 방지) ----------

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

// ---------- Supabase(Postgres) REST 접근 ----------

function requireSupabaseEnv() {
  if (!SB_URL || !SB_SERVICE_ROLE_KEY) {
    throw new Error("SB_URL / SB_SERVICE_ROLE_KEY Secrets가 설정되어 있지 않습니다. Supabase 대시보드 Edge Functions Secrets에 추가하세요.")
  }
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
  const res = await fetch(`${SB_URL}/rest/v1/report_cache?on_conflict=access_token`, {
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
  const res = await fetch(
    `${SB_URL}/rest/v1/report_cache?access_token=eq.${encodeURIComponent(token)}&link_disabled=eq.false&select=*`,
    { headers: { apikey: SB_SERVICE_ROLE_KEY, Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}` } },
  )
  if (!res.ok) throw new Error(`report_cache 조회 실패: ${res.status} ${await res.text()}`)
  const rows = await res.json()
  return rows[0] ?? null
}

export async function selectReportCacheOverviewsByStudentKey(studentKey: string): Promise<Record<string, unknown>[]> {
  requireSupabaseEnv()
  const res = await fetch(
    `${SB_URL}/rest/v1/report_cache?student_key=eq.${encodeURIComponent(studentKey)}&link_disabled=eq.false&select=registration_overview`,
    { headers: { apikey: SB_SERVICE_ROLE_KEY, Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}` } },
  )
  if (!res.ok) throw new Error(`report_cache(형제) 조회 실패: ${res.status} ${await res.text()}`)
  const rows = await res.json()
  return rows.map((r: any) => r.registration_overview)
}

// Notion의 `동기화 필요` 수식으로 좁힌 원본만 확인하고, 의미 있는 속성의 지문이 실제로
// 달라진 경우에만 보고서 캐시를 다시 만들기 위한 공용 모듈.

import { DS_ATTENDANCE, DS_LEARNING_RECORD, DS_STUDY_ACTIVITY, DS_REPORT } from "./constants.ts"
import { queryAllPages, updatePageProperties, mapWithConcurrency } from "./notionClient.ts"
import { dateStartOf, relationIds, fetchSupabaseWithRetry, type ReportCacheRow } from "./reportCacheShared.ts"

const SB_URL = Deno.env.get("SB_URL") ?? ""
const SB_SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""

export const PROP_SOURCE_MODIFIED_AT = "학습정보 수정일"
export const PROP_SOURCE_SYNCED_AT = "마지막 동기화"
export const PROP_SOURCE_DIRTY = "동기화 필요"

export type ReportSourceType = "attendance" | "learning_record" | "study_activity" | "report"

type SourceConfig = {
  type: ReportSourceType
  dataSourceId: string
  registrationProp: string
  meaningfulProps: string[]
}

const SOURCE_CONFIGS: SourceConfig[] = [
  {
    type: "attendance",
    dataSourceId: DS_ATTENDANCE,
    registrationProp: "등록",
    meaningfulProps: [
      "출석 상태", "수업일시", "선생님 한마디", "선생님 한마때",
      "학습기록", "학습활동/과제", "학습활동", "등록", "수업", "클래스", "담당강사",
    ],
  },
  {
    type: "learning_record",
    dataSourceId: DS_LEARNING_RECORD,
    registrationProp: "등록",
    meaningfulProps: ["내용", "범위", "구분", "진도교재", "교재", "과목", "출석", "수업", "등록", "학습활동"],
  },
  {
    type: "study_activity",
    dataSourceId: DS_STUDY_ACTIVITY,
    registrationProp: "등록",
    meaningfulProps: ["과제상태", "전체 문항", "정답 문항", "학습기록", "출석", "등록", "수업", "과제 마감", "과제 마감일"],
  },
  {
    type: "report",
    dataSourceId: DS_REPORT,
    registrationProp: "등록",
    meaningfulProps: ["보고서 기간", "보고서 구분", "선생님 한마디", "등록", "출석", "학습기록", "학습활동"],
  },
]

export type DirtySourceSnapshot = {
  page: any
  pageId: string
  sourceType: ReportSourceType
  registrationIds: string[]
  sourceHash: string
  sourceModifiedAt: string
  changed: boolean
}

export type DirtyInspection = {
  enabled: boolean
  reason?: string
  snapshots: DirtySourceSnapshot[]
  changed: DirtySourceSnapshot[]
}

function requireSupabaseEnv() {
  if (!SB_URL || !SB_SERVICE_ROLE_KEY) throw new Error("SB_URL / SB_SERVICE_ROLE_KEY Secrets가 설정되어 있지 않습니다.")
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SB_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`,
    ...extra,
  }
}

function plainText(items: any[]): string {
  return (items ?? []).map((item: any) => item?.plain_text ?? item?.text?.content ?? "").join("")
}

// 속성 표시 순서나 관계 배열 순서만 달라져도 지문이 바뀌지 않도록 정규화한다.
function canonicalProperty(prop: any): unknown {
  if (!prop) return null
  switch (prop.type) {
    case "title": return plainText(prop.title)
    case "rich_text": return plainText(prop.rich_text)
    case "select": return prop.select?.name ?? null
    case "status": return prop.status?.name ?? null
    case "multi_select": return (prop.multi_select ?? []).map((v: any) => v.name).sort()
    case "relation": return (prop.relation ?? []).map((v: any) => v.id).sort()
    case "people": return (prop.people ?? []).map((v: any) => v.id).sort()
    case "date": return prop.date ? { start: prop.date.start ?? null, end: prop.date.end ?? null, time_zone: prop.date.time_zone ?? null } : null
    case "number": return prop.number ?? null
    case "checkbox": return prop.checkbox === true
    case "url": return prop.url ?? null
    case "email": return prop.email ?? null
    case "phone_number": return prop.phone_number ?? null
    default: return null
  }
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function sourceHash(page: any, config: SourceConfig): Promise<string> {
  const values: Record<string, unknown> = {}
  for (const name of config.meaningfulProps) values[name] = canonicalProperty(page.properties?.[name])
  return await sha256({ version: 1, sourceType: config.type, values })
}

async function selectStoredHashes(pageIds: string[]): Promise<Map<string, string>> {
  requireSupabaseEnv()
  const result = new Map<string, string>()
  for (let i = 0; i < pageIds.length; i += 100) {
    const ids = pageIds.slice(i, i + 100)
    if (!ids.length) continue
    const filter = `in.(${ids.join(",")})`
    const params = new URLSearchParams({ notion_page_id: filter, select: "notion_page_id,source_hash" })
    const res = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/report_source_sync_state?${params.toString()}`, { headers: headers() })
    if (!res.ok) throw new Error(`report_source_sync_state 조회 실패: ${res.status} ${await res.text()}`)
    const rows: Array<{ notion_page_id: string; source_hash: string }> = await res.json()
    rows.forEach((row) => result.set(row.notion_page_id, row.source_hash))
  }
  return result
}

async function queryDirtyPages(registrationId: string, config: SourceConfig): Promise<any[]> {
  return await queryAllPages(config.dataSourceId, {
    and: [
      { property: config.registrationProp, relation: { contains: registrationId } },
      { property: PROP_SOURCE_DIRTY, formula: { checkbox: { equals: true } } },
    ],
  })
}

// 스키마 전환 중 속성이 아직 없는 DB가 하나라도 있으면 기존 전체 최신화로 fail-open 한다.
export async function inspectDirtyReportSources(registrationId: string): Promise<DirtyInspection> {
  try {
    const queried = await Promise.all(SOURCE_CONFIGS.map(async (config) => ({ config, pages: await queryDirtyPages(registrationId, config) })))
    const base = queried.flatMap(({ config, pages }) => pages.map((page) => ({ config, page })))
    const stored = await selectStoredHashes(base.map(({ page }) => page.id))
    const snapshots = await Promise.all(base.map(async ({ config, page }): Promise<DirtySourceSnapshot> => {
      const hash = await sourceHash(page, config)
      return {
        page,
        pageId: page.id,
        sourceType: config.type,
        registrationIds: relationIds(page.properties?.[config.registrationProp]),
        sourceHash: hash,
        sourceModifiedAt: dateStartOf(page.properties?.[PROP_SOURCE_MODIFIED_AT]) ?? new Date().toISOString(),
        changed: stored.get(page.id) !== hash,
      }
    }))
    return { enabled: true, snapshots, changed: snapshots.filter((item) => item.changed) }
  } catch (err) {
    const reason = String((err as any)?.message ?? err)
    console.warn("동기화 필요 체계를 사용할 수 없어 기존 전체 최신화로 전환합니다:", reason)
    return { enabled: false, reason, snapshots: [], changed: [] }
  }
}

async function saveSnapshots(snapshots: DirtySourceSnapshot[]): Promise<void> {
  if (!snapshots.length) return
  requireSupabaseEnv()
  const payload = snapshots.map((item) => ({
    notion_page_id: item.pageId,
    source_type: item.sourceType,
    registration_ids: item.registrationIds,
    source_hash: item.sourceHash,
    source_modified_at: item.sourceModifiedAt,
    synced_at: new Date().toISOString(),
  }))
  const res = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/report_source_sync_state?on_conflict=notion_page_id`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`report_source_sync_state 저장 실패: ${res.status} ${await res.text()}`)
}

// 캐시 반영이 성공한 뒤에만 호출한다. 읽었던 수정일을 그대로 기록하므로 실행 중 재편집된 페이지는
// 수정일 > 마지막 동기화 상태로 남아 다음 실행에서 다시 잡힌다.
export async function commitDirtyReportSources(snapshots: DirtySourceSnapshot[]): Promise<void> {
  if (!snapshots.length) return
  await saveSnapshots(snapshots)
  await mapWithConcurrency(snapshots, 2, async (item) => {
    await updatePageProperties(item.pageId, {
      [PROP_SOURCE_SYNCED_AT]: { date: { start: item.sourceModifiedAt } },
    })
  })
}

export async function selectReportCacheByRegistrationId(registrationId: string): Promise<ReportCacheRow | null> {
  requireSupabaseEnv()
  const params = new URLSearchParams({ registration_id: `eq.${registrationId}`, select: "*", limit: "1" })
  const res = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/report_cache?${params.toString()}`, { headers: headers() })
  if (!res.ok) throw new Error(`report_cache 등록 조회 실패: ${res.status} ${await res.text()}`)
  const rows = await res.json()
  return rows[0] ?? null
}

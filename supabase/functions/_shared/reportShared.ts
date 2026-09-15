const NOTION_TOKEN = Deno.env.get("NOTION_TOKEN")!
const REGISTRATION_DB_ID = Deno.env.get("NOTION_REGISTRATION_DB_ID")!
const NOTION_VERSION = "2022-06-28"

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

function notionHeaders() {
  return {
    "Authorization": `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  }
}

const pageCache = new Map<string, any>()

export async function getNotionPage(pageId: string): Promise<any> {
  if (pageCache.has(pageId)) return pageCache.get(pageId)
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers: notionHeaders() })
  if (!res.ok) throw new Error(`Notion page fetch failed: ${res.status} ${await res.text()}`)
  const json = await res.json()
  pageCache.set(pageId, json)
  return json
}

export async function findRegistrationByToken(token: string): Promise<any | null> {
  if (!token) return null
  const res = await fetch(`https://api.notion.com/v1/databases/${REGISTRATION_DB_ID}/query`, {
    method: "POST",
    headers: notionHeaders(),
    body: JSON.stringify({
      filter: { property: "토큰", rich_text: { equals: token } },
      page_size: 1,
    }),
  })
  if (!res.ok) throw new Error(`Notion query failed: ${res.status} ${await res.text()}`)
  const json = await res.json()
  return json.results?.[0] ?? null
}

export async function getFullRelationIds(page: any, propName: string): Promise<string[]> {
  const prop = page?.properties?.[propName]
  if (!prop || prop.type !== "relation") return []
  if (!prop.has_more) {
    return (prop.relation ?? []).map((r: any) => r.id)
  }
  const propId = prop.id
  const ids: string[] = []
  let cursor: string | undefined = undefined
  let loopCount = 0
  do {
    loopCount++
    const qs = new URLSearchParams({ page_size: "100" })
    if (cursor) qs.set("start_cursor", cursor)
    const url = "https://api.notion.com/v1/pages/" + page.id + "/properties/" + propId + "?" + qs.toString()
    const res = await fetch(url, { headers: notionHeaders() })
    if (!res.ok) break
    const json = await res.json()
    const results = json.results ?? []
    for (const item of results) {
      if (item?.relation?.id) ids.push(item.relation.id)
    }
    cursor = json.has_more ? json.next_cursor : undefined
    if (loopCount > 30) break
  } while (cursor)
  return ids
}

const blocksCache = new Map<string, any[]>()

async function getBlockChildren(pageId: string, pageSize = 50): Promise<any[]> {
  if (!pageId) return []
  const cacheKey = `${pageId}:${pageSize}`
  if (blocksCache.has(cacheKey)) return blocksCache.get(cacheKey) as any[]
  try {
    const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=${pageSize}`, { headers: notionHeaders() })
    if (!res.ok) { blocksCache.set(cacheKey, []); return [] }
    const json = await res.json()
    const results: any[] = json?.results ?? []
    blocksCache.set(cacheKey, results)
    return results
  } catch (_e) {
    blocksCache.set(cacheKey, [])
    return []
  }
}

function richTextToPlain(rich: any): string {
  if (!Array.isArray(rich)) return ""
  return rich.map((r: any) => r?.plain_text ?? "").join("").trim()
}

const coverCache = new Map<string, string | undefined>()

async function fetchPageBodyImageUrl(pageId: string): Promise<string | undefined> {
  if (!pageId) return undefined
  const blocks = await getBlockChildren(pageId, 25)
  for (const b of blocks) {
    if (b?.type === "image") {
      const img = b.image
      const url = img?.type === "external" ? img?.external?.url : img?.file?.url
      if (url) return String(url)
    }
  }
  for (const b of blocks) {
    const url = b?.type === "embed" ? b.embed?.url : b?.type === "bookmark" ? b.bookmark?.url : null
    if (url && /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(String(url))) return String(url)
  }
  for (const b of blocks) {
    const rich = b?.[b?.type]?.rich_text
    if (!Array.isArray(rich)) continue
    for (const r of rich) {
      const href = r?.href ?? r?.text?.link?.url
      if (href && /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(String(href))) return String(href)
    }
  }
  return undefined
}

export async function resolveBookCover(regularProps: any, regularPageId?: string): Promise<string | undefined> {
  const fromProp = fileUrlOf(regularProps?.["북커버"])
  if (fromProp) return fromProp
  if (!regularPageId) return undefined
  if (coverCache.has(regularPageId)) return coverCache.get(regularPageId)
  const fromBody = await fetchPageBodyImageUrl(regularPageId)
  coverCache.set(regularPageId, fromBody)
  return fromBody
}

type FeedBlock =
  | { type: "text"; style: string; text: string }
  | { type: "image"; url: string; caption: string }
  | { type: "video"; url: string; caption: string }

export async function fetchStudyLogFeed(pageId: string, maxBlocks = 40): Promise<FeedBlock[]> {
  if (!pageId) return []
  const blocks = await getBlockChildren(pageId, maxBlocks)
  const feed: FeedBlock[] = []
  for (const b of blocks) {
    const t = b?.type
    if (!t) continue
    if (t === "image") {
      const img = b.image
      const url = img?.type === "external" ? img?.external?.url : img?.file?.url
      if (url) feed.push({ type: "image", url: String(url), caption: richTextToPlain(img?.caption) })
      continue
    }
    if (t === "video") {
      const vid = b.video
      const url = vid?.type === "external" ? vid?.external?.url : vid?.file?.url
      if (url) feed.push({ type: "video", url: String(url), caption: richTextToPlain(vid?.caption) })
      continue
    }
    if (t === "embed" || t === "bookmark") {
      const url = t === "embed" ? b.embed?.url : b.bookmark?.url
      if (url && /(youtube\.com|youtu\.be|vimeo\.com)/i.test(String(url))) {
        feed.push({ type: "video", url: String(url), caption: "" })
        continue
      }
    }
    if (t === "paragraph") {
      const txt = richTextToPlain(b.paragraph?.rich_text)
      if (txt) feed.push({ type: "text", style: "paragraph", text: txt })
      continue
    }
    if (t === "heading_1" || t === "heading_2" || t === "heading_3") {
      const txt = richTextToPlain(b[t]?.rich_text)
      if (txt) feed.push({ type: "text", style: "heading", text: txt })
      continue
    }
    if (t === "bulleted_list_item" || t === "numbered_list_item" || t === "to_do") {
      const txt = richTextToPlain(b[t]?.rich_text)
      if (txt) feed.push({ type: "text", style: "bullet", text: txt })
      continue
    }
    if (t === "quote" || t === "callout") {
      const emoji = t === "callout" ? (b.callout?.icon?.emoji ?? "") : ""
      const txt = richTextToPlain(b[t]?.rich_text)
      if (txt) feed.push({ type: "text", style: "quote", text: (emoji ? emoji + " " : "") + txt })
      continue
    }
    if (t === "toggle") continue
    const fallback = richTextToPlain(b?.[t]?.rich_text)
    if (fallback) feed.push({ type: "text", style: "paragraph", text: fallback })
  }
  return feed
}

export function text(prop: any): string {
  if (!prop) return ""
  switch (prop.type) {
    case "title": return prop.title.map((t: any) => t.plain_text).join("")
    case "rich_text": return prop.rich_text.map((t: any) => t.plain_text).join("")
    case "formula":
      if (prop.formula.type === "string") return prop.formula.string ?? ""
      if (prop.formula.type === "number") return prop.formula.number != null ? String(prop.formula.number) : ""
      if (prop.formula.type === "date") return prop.formula.date?.start ?? ""
      if (prop.formula.type === "array") return formulaArrayText(prop)
      return ""
    case "rollup":
      if (prop.rollup.type === "array") return prop.rollup.array.map((v: any) => rollupItemText(v)).join(", ")
      if (prop.rollup.type === "number") return prop.rollup.number != null ? String(prop.rollup.number) : ""
      return ""
    case "select": return prop.select?.name ?? ""
    case "status": return prop.status?.name ?? ""
    case "multi_select": return (prop.multi_select ?? []).map((s: any) => s.name).join(", ")
    case "phone_number": return prop.phone_number ?? ""
    case "date": return prop.date?.start ?? ""
    case "number": return prop.number != null ? String(prop.number) : ""
    default: return ""
  }
}

export function shortExamLabel(examType: string, gradeLabel: string): string {
  const t = (examType || "").trim()
  const g = (gradeLabel || "").trim()
  if (!t) return g
  const writtenMatch = t.match(/^(\d)학기\s*(중간|기말)고사$/)
  if (writtenMatch) {
    const [, semester, kind] = writtenMatch
    return g ? `${g}-${semester} ${kind}` : `${semester}학기 ${kind}`
  }
  const mockMatch = t.match(/^(\d{1,2})월\s*모의고사$/)
  if (mockMatch) {
    const [, month] = mockMatch
    return g ? `${g} ${month}모` : `${month}월모의`
  }
  if (t === "수능") return g ? `${g} 수능` : "수능"
  return [g, t].filter(Boolean).join(" ").trim()
}

function rollupItemText(item: any): string {
  if (!item) return ""
  if (item.type === "title") return item.title.map((t: any) => t.plain_text).join("")
  if (item.type === "rich_text") return item.rich_text.map((t: any) => t.plain_text).join("")
  if (item.type === "select") return item.select?.name ?? ""
  if (item.type === "number") return item.number != null ? String(item.number) : ""
  return ""
}

export function formulaDateOf(prop: any): string | null {
  if (!prop) return null
  if (prop.type === "formula") {
    const f = prop.formula
    if (f.type === "date") return f.date?.start ?? null
    if (f.type === "array") {
      const firstDate = (f.array ?? []).find((v: any) => v.type === "date")
      return firstDate?.date?.start ?? null
    }
  }
  if (prop.type === "date") return prop.date?.start ?? null
  return null
}

function formulaArrayText(prop: any): string {
  if (!prop || prop.type !== "formula" || prop.formula?.type !== "array") return ""
  return (prop.formula.array ?? []).map((v: any) => (v.type === "text" ? v.text ?? "" : "")).filter(Boolean).join("/")
}

export function numberOf(prop: any): number | null {
  if (!prop) return null
  if (prop.type === "number") return prop.number
  if (prop.type === "formula" && prop.formula.type === "number") return prop.formula.number
  if (prop.type === "rollup" && prop.rollup.type === "number") return prop.rollup.number
  return null
}

export function dateStartOf(prop: any): string | null {
  if (!prop) return null
  if (prop.type === "date") return prop.date?.start ?? null
  if (prop.type === "formula" && prop.formula.type === "date") return prop.formula.date?.start ?? null
  return null
}

export function dateEndOf(prop: any): string | null {
  if (!prop) return null
  if (prop.type === "date") return prop.date?.end ?? prop.date?.start ?? null
  if (prop.type === "formula" && prop.formula.type === "date") return prop.formula.date?.end ?? prop.formula.date?.start ?? null
  return null
}

export function fileUrlOf(prop: any): string | undefined {
  if (!prop || prop.type !== "files") return undefined
  const f = prop.files?.[0]
  if (!f) return undefined
  return f.type === "external" ? f.external?.url : f.file?.url
}

export function relationIds(prop: any): string[] {
  return prop?.relation?.map((r: any) => r.id) ?? []
}

export function firstRelationId(prop: any): string | undefined {
  return relationIds(prop)[0]
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
  if (s.includes("출석")) return "출석"
  if (s.includes("보강")) return "보강"
  if (s.includes("결석")) return "결석"
  if (s.includes("제출") && !s.includes("미제출")) return "제출"
  if (s.includes("미제출")) return "미제출"
  return s.replace(/^[^\w가-힣]+/u, "").trim()
}

export function hasWarning(s: string): boolean {
  return typeof s === "string" && (s.includes("⚠️") || s.includes("🔁"))
}

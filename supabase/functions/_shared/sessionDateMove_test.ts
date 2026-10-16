// All network calls are mocked. No live Notion/Supabase writes or secret values are used.
function assert(value: unknown, message = "assertion failed") { if (!value) throw new Error(message) }
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_ATTENDANCE_ID: "attendance", DATA_SOURCE_CLASS_SESSION_ID: "sessions", DATA_SOURCE_LEARNING_RECORD_ID: "records", DATA_SOURCE_STUDY_ACTIVITY_ID: "activities", DATA_SOURCE_REGISTRATION_ID: "registrations", DATA_SOURCE_TIMETABLE_ID: "timetables" })) Deno.env.set(key, value)
const { koreanDateLabel, retitle, processSessionDateQueueItem } = await import("./sessionDateMove.ts")
let handler: (req: Request) => Promise<Response>
const serve = Deno.serve
;(Deno as any).serve = (h: any) => { handler = h; return {} }
await import("../fix-attendance/index.ts")
;(Deno as any).serve = serve
const S = "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa"
const title = (s: string) => ({ title: [{ plain_text: s, text: { content: s } }] })
const when = (start: string, end?: string) => ({ date: { start, end: end ?? null } })

Deno.test("v2.6.18 날짜 표시: 한국 날짜·요일(일요일 포함), 제목의 마지막 날짜만 바꿈", () => {
 assert(koreanDateLabel("2026-10-03T08:00:00.000Z") === "10.03(토)")
 assert(koreanDateLabel("2026-10-04T23:30:00.000Z") === "10.05(월)", "UTC 전날 밤 = 한국 다음 날 아침")
 assert(koreanDateLabel("2026-10-04T08:00:00+09:00") === "10.04(일)")
 assert(retitle("[학습] 쎈 공통수학2(고1 A) 10.02(금)", "10.03(토)") === "[학습] 쎈 공통수학2(고1 A) 10.03(토)")
 assert(retitle("[과제] 박수빈 10.30(금)", "10.30(금)") === null, "같으면 쓰지 않음")
 assert(retitle("보강 기록", "10.03(토)") === null, "날짜 표시 없으면 그대로")
})

function mock(pages: Record<string, any>) {
 const writes: { id: string; body: any }[] = [], calls: { url: string; method: string; body: any }[] = []
 const fetch = async (input: any, init: any = {}) => {
  const url = String(input), method = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : {}
  calls.push({ url, method, body })
  if (url.startsWith("https://mock.supabase/")) return new Response("[]")
  const db = url.match(/\/data_sources\/([^/]+)\/query/)?.[1]
  if (db) return new Response(JSON.stringify({ results: Object.values(pages).filter((p: any) => p.db === db && (p.properties["수업"]?.relation ?? []).some((r: any) => r.id === body.filter.relation.contains)), has_more: false }))
  const id = url.match(/\/pages\/([^/?]+)/)?.[1]
  if (id && method === "PATCH") { writes.push({ id, body }); Object.assign(pages[id].properties, body.properties); return new Response(JSON.stringify(pages[id])) }
  if (id) return new Response(JSON.stringify(pages[id]))
  throw new Error("unmocked " + url)
 }
 return { writes, calls, fetch }
}
async function withMock(pages: Record<string, any>, run: (m: ReturnType<typeof mock>) => Promise<void>) {
 const m = mock(pages), original = globalThis.fetch
 globalThis.fetch = m.fetch as typeof fetch
 ;(globalThis as any).EdgeRuntime = { waitUntil: (p: Promise<unknown>) => p.catch(() => {}) }
 try { await run(m) } finally { globalThis.fetch = original; delete (globalThis as any).EdgeRuntime }
}
const rel = (...ids: string[]) => ({ relation: ids.map((id) => ({ id })) })

Deno.test("v2.6.18 수업 날짜 이동: 출석 날짜를 수업과 맞추고(이미 같은 건 그대로) 학습기록·학습활동 제목의 날짜만 바꾼다", async () => {
 const NEW = "2026-10-03T17:00:00.000+09:00", NEW_END = "2026-10-03T18:00:00.000+09:00"
 const pages: Record<string, any> = {
  [S]: { id: S, db: "sessions", properties: { 이름: title("중1 B 10.03(토)"), 수업일시: when(NEW, NEW_END) } },
  a1: { id: "a1", db: "attendance", properties: { 출석: title("조하은 10.02(금)"), 수업: rel(S), 수업일시: when("2026-10-02T17:00:00.000+09:00", "2026-10-02T18:00:00.000+09:00") } },
  a2: { id: "a2", db: "attendance", properties: { 출석: title("임현우 10.03(토)"), 수업: rel(S), 수업일시: when("2026-10-03T08:00:00.000Z", "2026-10-03T09:00:00.000Z") } },
  r1: { id: "r1", db: "records", properties: { 학습: title("[학습] 개념원리(중1 B) 10.02(금)"), 수업: rel(S) } },
  r2: { id: "r2", db: "records", properties: { 학습: title("[과제] 주제만"), 수업: rel(S) } },
  v1: { id: "v1", db: "activities", properties: { 학습활동: title("[학습] 조하은 10.02(금)"), 수업: rel(S) } },
 }
 await withMock(pages, async (m) => {
  await processSessionDateQueueItem({ pageId: S })
  assert(m.writes.map((w) => w.id).sort().join() === "a1,r1,v1", m.writes.map((w) => w.id).join())
  const a1 = m.writes.find((w) => w.id === "a1")!
  assert(a1.body.properties["수업일시"].date.start === NEW && a1.body.properties["수업일시"].date.end === NEW_END && !a1.body.properties["출석"], "출석은 날짜만(이름은 Notion 자동화)")
  assert(pages.r1.properties["학습"].title[0].text.content === "[학습] 개념원리(중1 B) 10.03(토)")
  assert(pages.v1.properties["학습활동"].title[0].text.content === "[학습] 조하은 10.03(토)")
  assert(m.calls.filter((c) => c.method === "GET").length === 1, "수업 읽기 1번")
 })
})

Deno.test("v2.6.18 fix-attendance/session-date: 인증 후 큐에만 넣고 Notion을 읽지 않는다", () => withMock({}, async (m) => {
 const unauth = await handler(new Request("https://mock.supabase/functions/v1/fix-attendance/session-date", { method: "POST", body: JSON.stringify({ data: { id: S } }) }))
 assert(unauth.status === 401)
 const res = await handler(new Request("https://mock.supabase/functions/v1/fix-attendance/session-date", { method: "POST", headers: { "x-admin-key": "test-only" }, body: JSON.stringify({ source: { type: "automation" }, data: { object: "page", id: S, properties: {} } }) }))
 assert(res.status === 202)
 const q = m.calls.filter((c) => c.url.endsWith("/rest/v1/sync_queue")).map((c) => c.body[0])
 assert(q.length === 1 && q[0].target === "session-date" && q[0].payload.pageId === S, JSON.stringify(q))
 assert(!m.calls.some((c) => c.url.includes("api.notion.com")), "Notion 읽기 없음")
}))

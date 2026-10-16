// All network calls are mocked. No live Notion/Supabase writes or secret values are used.
function assert(value: unknown, message = "assertion failed") { if (!value) throw new Error(message) }
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_ATTENDANCE_ID: "attendance", DATA_SOURCE_LEARNING_RECORD_ID: "records", DATA_SOURCE_STUDY_ACTIVITY_ID: "activities", DATA_SOURCE_REGISTRATION_ID: "registrations", DATA_SOURCE_REPORT_ID: "reports", DATA_SOURCE_CLASS_SESSION_ID: "sessions" })) Deno.env.set(key, value)
const { processClass } = await import("./generateReportTarget.ts")
const rel = (...ids: string[]) => ({ relation: ids.map((id) => ({ id })) })

Deno.test("v2.6.19 보고서 만들기: 학습기록·학습활동은 날짜 수식이 아니라 기간 안 출석의 관계로 가져온다", async () => {
 const pages: Record<string, any> = {
  cls: { id: "cls", properties: { 클래스명: { title: [{ plain_text: "고1 A" }] }, "보고서 생성 대상": rel("batch") } },
  batch: { id: "batch", properties: { 구분: { select: { name: "월간 보고서" } }, 기간: { date: { start: "2026-10-01" } } } },
 }
 const calls: { url: string; body: any }[] = [], created: any[] = []
 const original = globalThis.fetch
 globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input), body = init.body ? JSON.parse(init.body) : {}
  calls.push({ url, body })
  const db = url.match(/\/data_sources\/([^/]+)\/query/)?.[1]
  if (db === "registrations") return new Response(JSON.stringify({ results: [{ id: "reg", properties: { 이름: { type: "title", title: [{ plain_text: "박수빈 고1 A" }] } } }], has_more: false }))
  if (db === "reports") return new Response(JSON.stringify({ results: [], has_more: false }))
  if (db === "attendance") return new Response(JSON.stringify({ results: [
   { id: "a1", properties: { 학습기록: rel("rec-shared", "rec-mine"), 학습활동: rel("act1") } },
   { id: "a2", properties: { 학습기록: rel("rec-shared"), 학습활동: rel("act2", "act3") } },
  ], has_more: false }))
  if (db) throw new Error("이 DB를 날짜 수식으로 조회하면 안 됨: " + db)
  const id = url.match(/\/pages\/([^/?]+)/)?.[1]
  if (id && pages[id]) return new Response(JSON.stringify(pages[id]))
  if (url.endsWith("/v1/pages") && init.method === "POST") { created.push(body); return new Response(JSON.stringify({ id: "new" })) }
  if (url.startsWith("https://mock.supabase/")) return new Response("[]")
  throw new Error("unmocked " + url)
 }) as typeof fetch
 try {
  const log: string[] = []
  await processClass("cls", log)
  assert(created.length === 1, log.join("\n"))
  const ids = (k: string) => created[0].properties[k].relation.map((r: any) => r.id).sort().join()
  assert(ids("출석") === "a1,a2" && ids("학습기록") === "rec-mine,rec-shared" && ids("학습활동") === "act1,act2,act3", JSON.stringify(created[0].properties))
  const attQuery = calls.find((c) => c.url.includes("/data_sources/attendance/query"))!
  assert(JSON.stringify(attQuery.body).includes("수업일시"), "기간은 출석 수업일시로")
  assert(!calls.some((c) => c.url.includes("/data_sources/records/") || c.url.includes("/data_sources/activities/")), "학습기록·학습활동 날짜 조회 없음")
 } finally { globalThis.fetch = original }
})

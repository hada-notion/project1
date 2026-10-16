// All network calls are mocked. No live Notion/Supabase writes or secret values are used.
function assert(value: unknown, message = "assertion failed") { if (!value) throw new Error(message) }
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_ATTENDANCE_ID: "attendance", DATA_SOURCE_CLASS_SESSION_ID: "sessions", DATA_SOURCE_LEARNING_RECORD_ID: "records", DATA_SOURCE_STUDY_ACTIVITY_ID: "activities", DATA_SOURCE_REGISTRATION_ID: "registrations" })) Deno.env.set(key, value)
let handler: (req: Request) => Promise<Response>
const serve = Deno.serve
;(Deno as any).serve = (h: any) => { handler = h; return {} }
await import("../create-learning-record/index.ts")
;(Deno as any).serve = serve
const { processCreateLearningRecordQueueItem, MAKEUP_SESSION_REQUIRED } = await import("./createLearningRecordTarget.ts")
const ATT = "11111111111141118111111111111111"
function mock() {
 const calls: { url: string; method: string; body: any }[] = []
 const fetch = async (input: any, init: any = {}) => {
  const url = String(input), method = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : {}
  calls.push({ url, method, body })
  if (url.startsWith("https://mock.supabase/")) return new Response("[]")
  if (url.includes(`/pages/${ATT}`) && method === "GET") return new Response(JSON.stringify({ id: ATT, parent: { data_source_id: "attendance" }, properties: { 수업: { relation: [] }, 등록: { relation: [{ id: "reg" }] } } }))
  if (url.includes("/pages/") && method === "PATCH") return new Response(JSON.stringify({ id: ATT, properties: body.properties }))
  throw new Error("unmocked " + method + " " + url)
 }
 return { calls, fetch }
}
async function withMock(run: (m: ReturnType<typeof mock>) => Promise<void>) {
 const m = mock(), original = globalThis.fetch
 globalThis.fetch = m.fetch as typeof fetch
 ;(globalThis as any).EdgeRuntime = { waitUntil: (p: Promise<unknown>) => p.catch(() => {}) }
 try { await run(m) } finally { globalThis.fetch = original; delete (globalThis as any).EdgeRuntime }
}
const errorText = (m: ReturnType<typeof mock>) => m.calls.filter((c) => c.method === "PATCH").map((c) => JSON.stringify(c.body)).join("\n")

Deno.test("v2.6.17 수업 없는 출석의 [학습기록 생성]: 기록을 만들지 않고 안내를 남기며 큐에 넣지 않는다", () => withMock(async (m) => {
 const res = await handler(new Request("https://mock.supabase/functions/v1/create-learning-record", { method: "POST", headers: { "x-admin-key": "test-only" }, body: JSON.stringify({ data: { object: "page", id: ATT } }) }))
 const json = await res.json()
 assert(res.status === 200 && json.reason === "makeup_session_required", JSON.stringify(json))
 assert(!m.calls.some((c) => c.url.endsWith("/rest/v1/sync_queue")), "큐에 넣지 않음")
 assert(!m.calls.some((c) => c.method === "POST" && c.url.endsWith("/v1/pages")), "기록 만들지 않음")
 assert(errorText(m).includes("보강 대기실"), "마지막 오류에 안내")
}))

Deno.test("v2.6.17 배포 전에 큐에 들어간 수업 없는 출석 항목: 기록을 만들지 않고 오류로 남기며 재시도하지 않는다", () => withMock(async (m) => {
 await processCreateLearningRecordQueueItem({ attendanceId: ATT, statusTargetIds: [ATT] })
 assert(!m.calls.some((c) => c.method === "POST" && c.url.endsWith("/v1/pages")), "기록 만들지 않음")
 assert(errorText(m).includes(MAKEUP_SESSION_REQUIRED.slice(0, 10)), errorText(m))
}))

// All network calls are mocked. No live Notion/Supabase/Solapi calls or secret values are used.
function assert(value: unknown, message = "assertion failed") { if (!value) throw new Error(message) }
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", SOLAPI_API_KEY: "x", SOLAPI_API_SECRET: "x", DATA_SOURCE_ATTENDANCE_ID: "attendance", DATA_SOURCE_REGISTRATION_ID: "registrations", DATA_SOURCE_CLASS_SESSION_ID: "sessions" })) Deno.env.set(key, value)
const q = await import("./dailyReportQueue.ts")
let handler: (req: Request) => Promise<Response>
const serve = Deno.serve
;(Deno as any).serve = (h: any) => { handler = h; return {} }
await import("../send-daily-report/index.ts")
;(Deno as any).serve = serve

const f = (s: string) => ({ type: "formula", formula: { type: "string", string: s } })
const rel = (...ids: string[]) => ({ relation: ids.map((id) => ({ id })) })
function attendance(extra: Record<string, any> = {}) {
 return { id: "att", properties: { 등록: rel("reg"), 수업: rel("sess"), "전송완료 체크": { checkbox: false }, "학생이름(보고서)": f("박현준"), "클래스(보고서)": f("고1 A"), "수업일(보고서)": f("10.05(월)"), "출석상태(보고서)": f("출석"), "학습 내용(보고서)": f("개념 정리"), "학부모 연락처": f("010-0000-0000"), 실행자: { people: [{ id: "user" }] }, "리포트 토큰": { type: "rollup", rollup: { type: "array", array: [{ type: "rich_text", rich_text: [{ plain_text: "tok123" }] }] } }, 보고서: rel(), ...extra } }
}
function mock(page: any) {
 const patches: any[] = [], calls: string[] = []
 const fetch = async (input: any, init: any = {}) => {
  const url = String(input), method = init.method ?? "GET"; calls.push(method + " " + url)
  if (url.startsWith("https://mock.supabase/")) return new Response("[]")
  if (url.includes("/pages/att") && method === "GET") return new Response(JSON.stringify(page))
  if (url.includes("/pages/") && method === "PATCH") { patches.push(JSON.parse(init.body)); return new Response("{}") }
  if (url.includes("/users/me")) return new Response(JSON.stringify({ id: "bot" }))
  return new Response("{}")
 }
 return { patches, calls, fetch }
}
async function run(page: any, opts: { sendFails?: boolean; refreshFails?: boolean } = {}) {
 const m = mock(page), original = globalThis.fetch
 const sent: any[] = [], refreshed: any[] = []
 const deps = { ...q.dailyReportDeps }
 q.dailyReportDeps.refresh = (async (reg: string, o: any) => { refreshed.push({ reg, o }); if (opts.refreshFails) throw new Error("refresh boom"); return { access_token: "tok123", reportUrl: "", cacheRow: {} } }) as any
 q.dailyReportDeps.send = (async (p: any) => { sent.push(p); if (opts.sendFails) throw new Error("solapi boom"); return [] }) as any
 globalThis.fetch = m.fetch as typeof fetch
 let threw: Error | null = null
 try { await q.processDailyReportQueueItem({ attendanceId: "att" }) } catch (e) { threw = e as Error } finally { globalThis.fetch = original; Object.assign(q.dailyReportDeps, deps) }
 return { ...m, sent, refreshed, threw }
}
const statusOf = (p: any) => p.properties?.["보고서 전송 상태"]?.select?.name

Deno.test("v2.6.20 일일 보고서 한 건: 출석 1번 읽고 최신화(공용 캐시·토큰 재사용) → 발송 → 출석 쓰기 1번", async () => {
 const r = await run(attendance())
 assert(!r.threw, String(r.threw))
 assert(r.calls.filter((c) => c.startsWith("GET") && c.includes("/pages/")).length === 1, "출석 1번 읽기: " + r.calls.join("\n"))
 assert(r.refreshed.length === 1 && r.refreshed[0].o.tokenRaw === "tok123" && /^daily:sess:\d+$/.test(r.refreshed[0].o.sharedRunKey), JSON.stringify(r.refreshed))
 const v = r.sent[0].variables
 assert(r.sent.length === 1 && r.sent[0].primaryPhone === "010-0000-0000" && v["#{학생이름}"] === "박현준" && v["#{학습내용}"] === "개념 정리" && v["#{페이지ID}"].endsWith("?token=tok123"), JSON.stringify(r.sent))
 assert(v["#{등원정보}"] === "📅 수업일  10.05(월)\n✅ 출결  출석", JSON.stringify(v))
 const att = r.patches.filter((p) => p.properties?.["보고서 전송 상태"])
 assert(att.length === 1 && statusOf(att[0]) === "✅ 완료" && att[0].properties["전송완료 체크"].checkbox === true, JSON.stringify(r.patches))
})

Deno.test("v2.6.20 이미 보낸 출석은 최신화·발송 없이 안내만 남긴다", async () => {
 const r = await run(attendance({ "전송완료 체크": { checkbox: true } }))
 assert(r.sent.length === 0 && r.refreshed.length === 0)
 assert(r.patches.length === 1 && statusOf(r.patches[0]) === "⚠️ 오류")
})

Deno.test("v2.6.20 발송 실패는 다시 보내지 않고 오류로 남긴다, 발송 전 실패는 큐 재시도", async () => {
 const a = await run(attendance(), { sendFails: true })
 assert(!a.threw && a.sent.length === 1, "발송 실패는 예외로 재시도하지 않음")
 assert(a.patches.some((p) => statusOf(p) === "⚠️ 오류" && JSON.stringify(p).includes("solapi boom")))
 assert(!a.patches.some((p) => p.properties?.["전송완료 체크"]), "전송완료로 표시하지 않음")
 const b = await run(attendance(), { refreshFails: true })
 assert(b.threw && b.sent.length === 0, "최신화 실패는 예외 → 큐 재시도(아직 안 보냄)")
})

Deno.test("v2.6.20 send-daily-report/queue: 인증 후 큐에만 넣고 Notion을 읽지 않는다", async () => {
 const m = mock(attendance()), original = globalThis.fetch
 globalThis.fetch = m.fetch as typeof fetch
 ;(globalThis as any).EdgeRuntime = { waitUntil: (p: Promise<unknown>) => p.catch(() => {}) }
 try {
  const res = await handler(new Request("https://mock.supabase/functions/v1/send-daily-report/queue", { method: "POST", headers: { "x-admin-key": "test-only" }, body: JSON.stringify({ source: { type: "automation" }, data: { object: "page", id: "11111111111141118111111111111111", properties: { 실행자: { people: [{ id: "user" }] } } } }) }))
  assert(res.status === 202, String(res.status))
  const q2 = m.calls.filter((c) => c.endsWith("/rest/v1/sync_queue"))
  assert(q2.length === 1, m.calls.join("\n"))
  assert(!m.calls.some((c) => c.includes("api.notion.com")), "Notion 읽기 없음")
 } finally { globalThis.fetch = original; delete (globalThis as any).EdgeRuntime }
})

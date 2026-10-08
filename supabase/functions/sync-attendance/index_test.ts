// All network boundaries are mocked. No live Notion/Supabase writes or real secrets.
function assert(value: unknown, message = "assertion failed"): asserts value { if (!value) throw new Error(message) }
for (const [key, value] of Object.entries({ ADMIN_SECRET: "test-only", NOTION_TOKEN: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_ATTENDANCE_ID: "attendance" })) Deno.env.set(key, value)
let handler: (req: Request) => Promise<Response>
const serve = Deno.serve
;(Deno as any).serve = (h: any) => { handler = h; return {} }
await import("./index.ts")
;(Deno as any).serve = serve
const rel = (id: string) => ({ type: "relation", relation: [{ id }] })
function fixture(opts: { empty?: boolean; noCursor?: boolean; paginate?: boolean; rejectWrite?: boolean } = {}) {
  const calls: Array<{ url: string; method: string; body: any }> = []
  const pages = opts.empty ? [] : ["a", "b"].map(id => ({ id, last_edited_time: "2026-10-08T01:00:00Z", properties: { "등록": rel("reg"), "수업일시": { type: "date", date: { start: "2026-10-08T10:00:00+09:00", end: "2026-10-08T11:00:00+09:00" } }, "출석 상태": { type: "select", select: { name: "🟢 출석" } }, "학습기록": rel("log") } }))
  const reply = (body: any, status = 200) => new Response(JSON.stringify(body), { status })
  const fetch = async (input: any, init: any = {}) => {
    const url = String(input), method = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ url, method, body })
    if (url.includes("/rest/v1/sync_cursors")) return reply(method === "GET" ? (opts.noCursor ? [] : [{ last_synced_at: "2026-10-08T00:00:00Z" }]) : [])
    if (url.endsWith("/data_sources/attendance/query")) {
      if (opts.paginate && !body.start_cursor) return reply({ results: pages.slice(0, 1), has_more: true, next_cursor: "next" })
      return reply({ results: opts.paginate ? pages.slice(1) : pages, has_more: false })
    }
    if (url.includes("/rest/v1/attendance_records")) {
      if (method === "GET") return reply([{ notion_page_id: "a" }, { notion_page_id: "stale" }])
      if (method === "POST" && opts.rejectWrite) return reply({ message: "mock write rejected" }, 400)
      return reply([])
    }
    // A tokenless registration intentionally skips full cache generation, but proves
    // that incremental still invokes the cache builder once per distinct registration.
    if (url.endsWith("/pages/reg")) return reply({ id: "reg", properties: { "토큰": { rich_text: [] } } })
    throw new Error("unmocked request: " + url)
  }
  return { calls, pages, fetch }
}
const request = (body: any, key?: string) => new Request("https://mock.supabase/functions/v1/sync-attendance", { method: "POST", headers: key === undefined ? {} : { "x-admin-key": key }, body: JSON.stringify(body) })
async function withMock(opts: Parameters<typeof fixture>[0], run: (f: ReturnType<typeof fixture>) => Promise<void>) {
  const f = fixture(opts), original = globalThis.fetch
  globalThis.fetch = f.fetch as typeof fetch
  try { await run(f) } finally { globalThis.fetch = original }
}
for (const [name, body] of Object.entries({ "legacy pageId": { pageId: "old-page" }, "legacy Notion payload": { data: { id: "old-page" } }, "missing mode": {}, "unknown mode": { mode: "all" }, "null body": null })) {
  Deno.test("scheduled-only: reject " + name + " without side effects", () => withMock({}, async f => {
    const response = await handler(request(body, "test-only"))
    assert(response.status === 400); assert(f.calls.length === 0)
  }))
}
Deno.test("scheduled-only: malformed JSON is 400", () => withMock({}, async f => {
  const response = await handler(new Request("https://mock.supabase", { method: "POST", body: "{" }))
  assert(response.status === 400); assert(f.calls.length === 0)
}))
for (const mode of ["incremental", "reconcile"]) {
  for (const key of [undefined, "wrong-key"]) Deno.test(mode + ": admin authentication required (" + (key ?? "missing") + ")", () => withMock({}, async f => {
    const response = await handler(request({ mode }, key))
    assert(response.status === 401); assert(f.calls.length === 0)
  }))
}
Deno.test("incremental: cursor filter, pagination, upsert, cursor safety margin, deduplicated cache refresh", () => withMock({ paginate: true }, async f => {
  const before = Date.now(), response = await handler(request({ mode: "incremental" }, "test-only")), after = Date.now()
  assert(response.status === 200); assert((await response.json()).synced === 2)
  const queries = f.calls.filter(c => c.url.endsWith("/data_sources/attendance/query"))
  assert(queries.length === 2); assert(queries[0].body.filter.timestamp === "last_edited_time")
  assert(queries[0].body.filter.last_edited_time.after === "2026-10-08T00:00:00Z"); assert(queries[1].body.start_cursor === "next")
  const write = f.calls.find(c => c.url.includes("attendance_records") && c.method === "POST")!
  assert(write.body.length === 2 && write.body[0].status === "출석"); assert(write.body[0].check_in === "10:00" && write.body[0].check_out === "11:00")
  const cursor = f.calls.find(c => c.url.includes("sync_cursors") && c.method === "POST")!
  const time = Date.parse(cursor.body[0].last_synced_at)
  assert(time >= before - 120000 && time <= after - 120000)
  assert(f.calls.filter(c => c.url.endsWith("/pages/reg")).length === 1)
  assert(!f.calls.some(c => c.method === "DELETE"))
}))
Deno.test("incremental: absent cursor uses 24-hour fallback", () => withMock({ noCursor: true, empty: true }, async f => {
  const before = Date.now(), response = await handler(request({ mode: "incremental" }, "test-only")), after = Date.now()
  assert(response.status === 200 && (await response.json()).synced === 0)
  const filter = f.calls.find(c => c.url.endsWith("/data_sources/attendance/query"))!.body.filter
  const time = Date.parse(filter.last_edited_time.after)
  assert(time >= before - 86400000 && time <= after - 86400000)
  assert(!f.calls.some(c => c.url.endsWith("/pages/reg") || (c.url.includes("attendance_records") && c.method === "POST")))
}))
Deno.test("reconcile: all rows, stale deletion, cursor update, no report-cache refresh", () => withMock({}, async f => {
  const response = await handler(request({ mode: "reconcile" }, "test-only"))
  const data = await response.json(); assert(response.status === 200 && data.synced === 2 && data.deleted === 1)
  const query = f.calls.find(c => c.url.endsWith("/data_sources/attendance/query"))!
  assert(JSON.stringify(query.body.filter) === "{}")
  const deletion = f.calls.find(c => c.method === "DELETE")!
  assert(deletion.url.includes("stale") && !deletion.url.includes('"a"'))
  assert(f.calls.some(c => c.url.includes("sync_cursors") && c.method === "POST"))
  assert(!f.calls.some(c => c.url.endsWith("/pages/reg")))
}))
Deno.test("reconcile: failed upsert does not delete or advance cursor", () => withMock({ rejectWrite: true }, async f => {
  const response = await handler(request({ mode: "reconcile" }, "test-only"))
  assert(response.status === 500)
  assert(!f.calls.some(c => c.method === "DELETE" || (c.url.includes("sync_cursors") && c.method === "POST")))
}))
Deno.test("OPTIONS preserves preflight and has no side effects", () => withMock({}, async f => {
  const response = await handler(new Request("https://mock.supabase", { method: "OPTIONS" }))
  assert(response.status === 200 && response.headers.get("Access-Control-Allow-Origin") === "*"); assert(f.calls.length === 0)
}))

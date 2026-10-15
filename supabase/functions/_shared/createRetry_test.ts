// All network calls are mocked. No live Notion/Supabase writes or secret values are used.
function assert(v: unknown, m = "assertion failed") { if (!v) throw new Error(m) }
for (const [k, v] of Object.entries({ NOTION_TOKEN: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", ADMIN_SECRET: "test-only" })) Deno.env.set(k, v)
const { createPage, updatePageProperties, fetchWithRetry } = await import("./notionClient.ts")
async function withFetch(seq: (() => Response | Error)[], run: (calls: number[]) => Promise<void>) {
 const calls: number[] = [], original = globalThis.fetch
 globalThis.fetch = (async () => { const r = seq[Math.min(calls.length, seq.length - 1)](); calls.push(1); if (r instanceof Error) throw r; return r }) as typeof fetch
 try { await run(calls) } finally { globalThis.fetch = original }
}
const ok = () => new Response(JSON.stringify({ id: "p1" }), { status: 200 })
Deno.test("v2.6.13 페이지 만들기: 5xx는 다시 보내지 않고 실패로(같은 페이지가 두 번 생기지 않게)", () => withFetch([() => new Response("boom", { status: 502 }), ok], async (calls) => {
 let threw = false; try { await createPage("db", {}) } catch { threw = true }
 assert(threw && calls.length === 1, "calls " + calls.length)
}))
Deno.test("v2.6.13 페이지 만들기: 연결 오류도 다시 보내지 않음", () => withFetch([() => new Error("socket hang up"), ok], async (calls) => {
 let msg = ""; try { await createPage("db", {}) } catch (e) { msg = (e as Error).message }
 assert(/이미 처리됐을 수 있음/.test(msg) && calls.length === 1, msg)
}))
Deno.test("v2.6.13 페이지 만들기: 429(처리 안 됨)는 다시 보낸다", () => withFetch([() => new Response("", { status: 429, headers: { "Retry-After": "0" } }), ok], async (calls) => {
 const p = await createPage("db", {}); assert(p.id === "p1" && calls.length === 2)
}))
Deno.test("고치기(PATCH)는 전처럼 5xx도 다시 보낸다", () => withFetch([() => new Response("boom", { status: 500 }), ok], async (calls) => {
 await updatePageProperties("11111111111141118111111111111111", {}); assert(calls.length === 2)
}))
Deno.test("fetchWithRetry 기본값은 전과 같음", () => withFetch([() => new Response("boom", { status: 503 }), ok], async (calls) => {
 const r = await fetchWithRetry("https://api.notion.com/v1/x", {}, 1); assert(r.status === 200 && calls.length === 2)
}))

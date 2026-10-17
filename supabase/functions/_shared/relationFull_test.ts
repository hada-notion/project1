// All network calls are mocked. No live Notion/Supabase writes or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_ATTENDANCE_ID: "attendance", DATA_SOURCE_STUDY_ACTIVITY_ID: "activities", DATA_SOURCE_CLASS_SESSION_ID: "sessions", DATA_SOURCE_LEARNING_RECORD_ID: "records" })) Deno.env.set(key, value)
const assert = (v: unknown, m = "assertion failed") => { if (!v) throw new Error(m) }
const { fullRelationIds, withFullRelations } = await import("./notionClient.ts")
const { cascadeDelete } = await import("./cascadeDeleteTarget.ts")

const ids = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`)
// 30개 관계: 조회 결과에는 25개 + has_more, 속성 항목 API는 100개씩(여기선 2쪽으로 나눠 줌)
function mockProps(full: Record<string, string[]>) {
	const calls: string[] = []
	const saved = globalThis.fetch
	globalThis.fetch = (async (input: any) => {
		const url = new URL(String(input))
		const m = url.pathname.match(/\/pages\/([^/]+)\/properties\/([^/]+)/)
		if (!m) throw new Error("unmocked " + url)
		calls.push(decodeURIComponent(m[2]))
		const all = full[decodeURIComponent(m[2])]
		const start = Number(url.searchParams.get("start_cursor") ?? 0)
		const slice = all.slice(start, start + 20)
		const more = start + 20 < all.length
		return new Response(JSON.stringify({ results: slice.map((id) => ({ relation: { id } })), has_more: more, next_cursor: more ? String(start + 20) : null }))
	}) as typeof fetch
	return { calls, restore: () => { globalThis.fetch = saved } }
}
const truncated = (id: string, all: string[]) => ({ id, type: "relation", relation: all.slice(0, 25).map((x) => ({ id: x })), has_more: true })

Deno.test("v2.6.32 관계가 잘렸으면(has_more) 끝까지 읽고, 25개 이하면 추가 호출 없음", async () => {
	const all = ids(30, "a")
	const t = mockProps({ "p-att": all })
	try {
		const page = { id: "rec", properties: { 출석: truncated("p-att", all), 등록: { id: "p-reg", relation: [{ id: "r1" }], has_more: false } } }
		const got = await fullRelationIds(page, "출석")
		assert(got.length === 30 && got[29] === "a29", "30개 전부: " + got.length)
		assert((await fullRelationIds(page, "등록")).length === 1 && t.calls.length === 2, "잘리지 않은 속성은 읽지 않음")
		const filled = await withFullRelations(page, ["출석", "등록"])
		assert(filled.properties.출석.relation.length === 30 && filled.properties.출석.has_more === false)
		const same = { id: "x", properties: { 출석: { relation: [{ id: "a" }], has_more: false } } }
		assert(await withFullRelations(same, ["출석"]) === same, "잘리지 않으면 그대로")
	} finally { t.restore() }
})

Deno.test("v2.6.32 출석 삭제: 30명 반 전체 기록에서 이 학생만 빼고 나머지 29명 연결은 지키기", async () => {
	const atts = ids(30, "att"), regs = ids(30, "reg")
	const pages: Record<string, any> = {
		att0: { id: "att0", parent: { data_source_id: "attendance" }, archived: false, properties: { 출석: { title: [] }, 등록: { relation: [{ id: "reg0" }] } } },
		rec: { id: "rec", parent: { data_source_id: "records" }, archived: false, properties: { 학습: { title: [] }, 출석: truncated("p-att", atts), 등록: truncated("p-reg", regs), 수업: { relation: [] }, 진도교재: { relation: [] } } },
	}
	const writes: any[] = []
	const saved = globalThis.fetch
	globalThis.fetch = (async (input: any, init: any = {}) => {
		const url = new URL(String(input)), body = init.body ? JSON.parse(init.body) : {}
		if (url.origin === "https://mock.supabase") return new Response("[]")
		const prop = url.pathname.match(/\/pages\/[^/]+\/properties\/([^/]+)/)?.[1]
		if (prop) {
			const all = prop === "p-att" ? atts : regs
			return new Response(JSON.stringify({ results: all.map((id) => ({ relation: { id } })), has_more: false }))
		}
		const db = url.pathname.match(/\/data_sources\/([^/]+)\/query/)?.[1]
		if (db) return new Response(JSON.stringify({ results: db === "records" ? [pages.rec] : [], has_more: false }))
		const id = url.pathname.match(/\/pages\/([^/]+)/)?.[1]!
		if (init.method === "PATCH") { writes.push({ id, body }); if (body.archived) pages[id].archived = true; return new Response(JSON.stringify(pages[id])) }
		return new Response(JSON.stringify(pages[id]))
	}) as typeof fetch
	const bg: Promise<unknown>[] = []
	;(globalThis as any).EdgeRuntime = { waitUntil: (p: Promise<unknown>) => { bg.push(p.catch(() => {})) } }
	try { await cascadeDelete("att0", [], new Set()); await Promise.all(bg) } finally { globalThis.fetch = saved; delete (globalThis as any).EdgeRuntime }
	const w = writes.find((x) => x.id === "rec")
	assert(w && !w.body.archived, "기록은 남고 연결만 고침")
	assert(w.body.properties.출석.relation.length === 29 && !w.body.properties.출석.relation.some((r: any) => r.id === "att0"), "출석 29개 유지")
	assert(w.body.properties.등록.relation.length === 29 && w.body.properties.등록.relation.some((r: any) => r.id === "reg29"), "26번째 이후 등록도 유지")
})

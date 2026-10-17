// All network calls are mocked. No live Notion/Supabase writes or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_ATTENDANCE_ID: "attendance", DATA_SOURCE_STUDY_ACTIVITY_ID: "activities", DATA_SOURCE_CLASS_SESSION_ID: "sessions", DATA_SOURCE_LEARNING_RECORD_ID: "records" })) Deno.env.set(key, value)
const assert = (v: unknown, m = "assertion failed") => { if (!v) throw new Error(m) }
const { cascadeDelete } = await import("./cascadeDeleteTarget.ts")

const rel = (...ids: string[]) => ({ relation: ids.map((id) => ({ id })) })
const page = (id: string, db: string, properties: any) => ({ id, parent: { data_source_id: db }, archived: false, properties })

function world() {
	const pages: Record<string, any> = { sess: page("sess", "sessions", { 이름: { title: [{ plain_text: "수업" }] } }) }
	for (let i = 1; i <= 3; i++) {
		pages[`att${i}`] = page(`att${i}`, "attendance", { 출석: { title: [] }, 수업: rel("sess"), 등록: rel(`reg${i}`) })
		for (const k of [1, 2]) pages[`act${i}${k}`] = page(`act${i}${k}`, "activities", { 학습활동: { title: [] }, 출석: rel(`att${i}`) })
	}
	return pages
}

async function run(pages: Record<string, any>, root: string) {
	const reads: string[] = [], writes: { id: string; body: any }[] = []
	const saved = globalThis.fetch
	globalThis.fetch = (async (input: any, init: any = {}) => {
		const url = String(input), body = init.body ? JSON.parse(init.body) : {}
		if (url.startsWith("https://mock.supabase/")) return new Response("[]")
		const db = url.match(/\/data_sources\/([^/]+)\/query/)?.[1]
		if (db) {
			const f = body.filter
			return new Response(JSON.stringify({ results: Object.values(pages).filter((p: any) => p.parent.data_source_id === db && !p.archived && (p.properties[f.property]?.relation ?? []).some((r: any) => r.id === f.relation.contains)), has_more: false }))
		}
		const id = url.match(/\/pages\/([^/?]+)/)?.[1]!
		if (init.method === "PATCH") {
			writes.push({ id, body })
			if (body.archived) pages[id].archived = true
			Object.assign(pages[id].properties, body.properties ?? {})
			return new Response(JSON.stringify(pages[id]))
		}
		reads.push(id)
		return new Response(JSON.stringify(pages[id]))
	}) as typeof fetch
	const bg: Promise<unknown>[] = []
	;(globalThis as any).EdgeRuntime = { waitUntil: (p: Promise<unknown>) => { bg.push(p.catch(() => {})) } }
	try { await cascadeDelete(root, [], new Set()); await Promise.all(bg) } finally { globalThis.fetch = saved; delete (globalThis as any).EdgeRuntime }
	return { reads, writes }
}

Deno.test("v2.6.31 수업 삭제: 하위는 읽지 않고 삭제 체크·상태 없이 휴지통만, 누른 페이지는 완료와 휴지통을 한 번에", async () => {
	const pages = world()
	const { reads, writes } = await run(pages, "sess")
	assert(Object.values(pages).every((p: any) => p.archived), "모두 휴지통")
	assert(reads.length === 1 && reads[0] === "sess", "누른 페이지만 읽음: " + reads.join(","))
	assert(!writes.some((w) => w.body.properties?.["삭제 체크"]), "삭제 체크를 켜지 않음")
	const kidWrites = writes.filter((w) => w.id !== "sess")
	assert(kidWrites.length === 9 && kidWrites.every((w) => w.body.archived && !w.body.properties), "하위는 휴지통 보내기 1번씩")
	const rootWrites = writes.filter((w) => w.id === "sess")
	assert(rootWrites.length === 2, "누른 페이지: 작업중 1 + 완료·휴지통 1")
	assert(rootWrites[1].body.archived && rootWrites[1].body.properties["삭제 상태"].select.name === "✅ 완료", "완료와 휴지통을 한 번에")
})

Deno.test("v2.6.31 다시 시도: 이미 휴지통에 간 하위는 건너뛰고 남은 것만 지운다", async () => {
	const pages = world()
	pages.att1.archived = true; pages.act11.archived = true; pages.act12.archived = true
	const { writes } = await run(pages, "sess")
	assert(!writes.some((w) => ["att1", "act11", "act12"].includes(w.id)), "이미 지운 하위는 손대지 않음")
	assert(Object.values(pages).every((p: any) => p.archived), "남은 것 모두 휴지통")
})

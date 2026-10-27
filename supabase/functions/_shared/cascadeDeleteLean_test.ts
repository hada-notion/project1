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

Deno.test("v2.7.10 수업 삭제: 이 수업에만 달린 그룹 진도 학습기록과 그 학습활동도 지운다", async () => {
	const pages = world()
	pages.book = page("book", "books", { 진도방식: { select: { name: "그룹 진도" } } })
	pages.rec = page("rec", "records", { 학습: { title: [] }, 수업: rel("sess"), 진도교재: rel("book"), 출석: rel("att1", "att2", "att3") })
	pages.act13 = page("act13", "activities", { 학습활동: { title: [] }, 출석: rel("att1"), 학습기록: rel("rec") })
	await run(pages, "sess")
	assert(pages.rec.archived, "그룹 진도 학습기록도 휴지통")
	assert(pages.act13.archived, "그 학습활동도 휴지통")
	assert(!pages.book.archived, "진도교재는 남김")
})

Deno.test("v2.7.10 수업 삭제: 다른 수업에도 연결된 그룹 진도 학습기록은 이 수업 연결만 끊는다", async () => {
	const pages = world()
	pages.book = page("book", "books", { 진도방식: { select: { name: "그룹 진도" } } })
	pages.sess2 = page("sess2", "sessions", { 이름: { title: [] } })
	pages.rec = page("rec", "records", { 학습: { title: [] }, 수업: rel("sess", "sess2"), 진도교재: rel("book") })
	await run(pages, "sess")
	assert(!pages.rec.archived, "기록은 남김")
	const ids = pages.rec.properties.수업.relation.map((r: any) => r.id)
	assert(ids.length === 1 && ids[0] === "sess2", "이 수업 연결만 끊음: " + ids.join(","))
})

Deno.test("v2.6.31 다시 시도: 이미 휴지통에 간 하위는 건너뛰고 남은 것만 지운다", async () => {
	const pages = world()
	pages.att1.archived = true; pages.act11.archived = true; pages.act12.archived = true
	const { writes } = await run(pages, "sess")
	assert(!writes.some((w) => ["att1", "act11", "act12"].includes(w.id)), "이미 지운 하위는 손대지 않음")
	assert(Object.values(pages).every((p: any) => p.archived), "남은 것 모두 휴지통")
})

Deno.test("v2.8.0 보강 수업 삭제: 휴지통에 보내면서 보강 대상(결석 출석의 보강 수업)을 비운다, 없으면 건드리지 않음", async () => {
	const pages = world()
	pages.sess.properties["보강 대상"] = rel("abs1")
	const { writes } = await run(pages, "sess")
	const last = writes.filter((w) => w.id === "sess").at(-1)!
	assert(last.body.archived && Array.isArray(last.body.properties["보강 대상"]?.relation) && last.body.properties["보강 대상"].relation.length === 0, JSON.stringify(last.body))
	const plain = world()
	const r2 = await run(plain, "sess")
	assert(!("보강 대상" in (r2.writes.filter((w) => w.id === "sess").at(-1)!.body.properties ?? {})), "보강 대상이 없으면 쓰지 않음")
})

Deno.test("v2.8.0 보강 출석 삭제: 기존 결석 관계를 비우고 보강 수업 명단에서 이 학생을 뺀다(평소 수업·평소 출석은 그대로)", async () => {
	const pages = world()
	pages.sess.properties["보강"] = { checkbox: true }
	pages.sess.properties["등록"] = rel("reg1", "reg2", "reg3")
	pages.att1.properties["기존 결석"] = rel("abs1")
	const { writes } = await run(pages, "att1")
	const last = writes.filter((w) => w.id === "att1").at(-1)!
	assert(last.body.archived && last.body.properties["기존 결석"]?.relation?.length === 0, "기존 결석 비우며 휴지통: " + JSON.stringify(last.body))
	const roster = writes.filter((w) => w.id === "sess").at(-1)!
	assert(JSON.stringify(roster.body.properties["등록"].relation.map((r: any) => r.id)) === JSON.stringify(["reg2", "reg3"]), "명단에서 reg1만 뺌: " + JSON.stringify(roster.body))
	// 평소 수업이면 명단은 그대로, 기존 결석이 없는 출석은 관계를 쓰지 않는다.
	const plain = world()
	plain.sess.properties["등록"] = rel("reg1", "reg2", "reg3")
	plain.att1.properties["기존 결석"] = rel("abs1")
	const r2 = await run(plain, "att1")
	assert(!r2.writes.some((w) => w.id === "sess"), "평소 수업 명단은 건드리지 않음")
	const p3 = world()
	const r3 = await run(p3, "att2")
	assert(!("기존 결석" in (r3.writes.filter((w) => w.id === "att2").at(-1)!.body.properties ?? {})), "평소 출석은 기존 결석을 쓰지 않음")
	// 수업째 지우면 하위 보강 출석은 관계만 비우고 명단은 건드리지 않는다.
	const p4 = world()
	p4.sess.properties["보강"] = { checkbox: true }
	p4.sess.properties["등록"] = rel("reg1")
	p4.att1.properties["기존 결석"] = rel("abs1")
	const r4 = await run(p4, "sess")
	assert(r4.writes.filter((w) => w.id === "sess").every((w) => !w.body.properties?.["등록"]), "수업 삭제 중에는 명단을 고치지 않음")
	assert(r4.writes.find((w) => w.id === "att1")!.body.properties["기존 결석"].relation.length === 0, "하위 보강 출석도 관계 비움")
})

// 라이브러리 복사본(v2.5.125). Notion·Supabase 호출은 모두 가짜 응답. 실제 키·데이터 없음.
function assert(value: unknown, message = "assertion failed") { if (!value) throw new Error(message) }
for (const [k, v] of Object.entries({ NOTION_TOKEN: "test-only", DATA_SOURCE_PROGRESS_BOOK_ID: "progress" })) Deno.env.set(k, v)
const lc = await import("./libraryCopy.ts")
const tb = await import("./textbookSearch.ts")

const SB = "https://sb.test"
const BOOK = "22222222-2222-4222-8222-222222222222", BOOK2 = "11111111-1111-4111-8111-111111111111"
const tt = (s: string) => [{ plain_text: s }]
const bookPage = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, last_edited_time: "2026-10-14T00:00:00.000Z", parent: { data_source_id: "books" }, properties: { "교재명": { title: tt(title) }, "시리즈": { select: { name: "쎈" } }, "출판사": { select: null }, "북커버": { files: [{ external: { url: "https://contents.kyobobook.co.kr/x.jpg" } }] }, "사용중": { checkbox: true }, ISBN13: { rich_text: tt("9788928334858") }, "전체 페이지": { number: 264 }, ...extra } })
const unitPage = (id: string, book: string, name: string, page: number | null, exams = 0) => ({ id, last_edited_time: "2026-10-14T00:00:00.000Z", properties: { "단원명": { type: "title", title: tt(name) }, "시작페이지": { type: "number", number: page }, "라이브러리": { type: "relation", relation: [{ id: book }] }, "시험범위": { type: "relation", relation: Array.from({ length: exams }, (_, k) => ({ id: "e" + k })) } } })

function world() {
	const db: Record<string, any[]> = { lib_books: [{ id: "gone-book", title: "옛 교재" }], lib_units: [{ id: "gone-unit", book_id: BOOK, name: "옛 단원" }], sync_cursors: [] }
	const notionBooks = [bookPage(BOOK, "쎈 중등 수학 1-1"), bookPage(BOOK2, "개념원리", { "북커버": { files: [{ file: { url: "https://notion.files/expiring-1" } }] }, "시리즈": { select: null } })]
	const notionUnits = [unitPage("u2", BOOK, "1-2. 정수", 28), unitPage("u1", BOOK, "1-1. 소인수분해", 8, 1), unitPage("u3", BOOK, "부록", null)]
	const calls: string[] = []
	const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
	const fetch = async (input: any, init: any = {}) => {
		const url = String(input), method = init.method ?? "GET"; calls.push(method + " " + url)
		if (url.startsWith(SB)) {
			const u = new URL(url), table = u.pathname.split("/").pop()!, rows = db[table]
			const ids = (v: string | null) => v ? v.replace(/^in\.\(|\)$/g, "").split(",").map((x) => x.replace(/"/g, "")) : null
			if (method === "POST") { for (const r of JSON.parse(init.body)) { const key = table === "sync_cursors" ? "source" : "id"; const k = rows.findIndex((x) => x[key] === r[key]); if (k >= 0) rows[k] = { ...rows[k], ...r }; else rows.push(r) } return new Response(null, { status: 201 }) }
			if (method === "DELETE") { const del = ids(u.searchParams.get("id"))!; db[table] = rows.filter((r) => !del.includes(r.id)); return new Response(null, { status: 204 }) }
			if (method === "PATCH") { const old = u.searchParams.get("series")!.replace(/^eq\./, ""); for (const r of rows) if (r.series === old) Object.assign(r, JSON.parse(init.body)); return new Response(null, { status: 204 }) }
			let out = rows
			const src = u.searchParams.get("source"); if (src) out = out.filter((r) => r.source === src.replace(/^eq\./, ""))
			const idIn = ids(u.searchParams.get("id")); if (idIn) out = out.filter((r) => idIn.includes(r.id))
			const b = u.searchParams.get("book_id"); if (b) { const list = b.startsWith("eq.") ? [b.slice(3)] : ids(b)!; out = out.filter((r) => list.includes(r.book_id)) }
			return reply(Number(u.searchParams.get("offset") ?? 0) > 0 ? [] : out)
		}
		if (url.endsWith("/data_sources/progress")) return reply({ properties: { "라이브러리": { relation: { data_source_id: "books" } } } })
		if (url.endsWith("/data_sources/books")) return reply({ properties: { "단원목록": { relation: { data_source_id: "units" } }, "출판사": { select: { options: [] } }, "시리즈": { type: "select", select: { options: [{ id: "s1", name: "쎈" }] } } } })
		if (url.endsWith("/data_sources/units")) return reply({ properties: { "단원명": { title: {} }, "라이브러리": { relation: { data_source_id: "books" } } } })
		if (url.endsWith("/data_sources/books/query")) return reply({ results: notionBooks, has_more: false })
		if (url.endsWith("/data_sources/units/query")) {
			const f = JSON.parse(init.body ?? "{}").filter
			return reply({ results: f?.relation ? notionUnits.filter((p) => p.properties["라이브러리"].relation[0].id === f.relation.contains) : notionUnits, has_more: false })
		}
		const got = url.match(/\/pages\/([^/?]+)$/)?.[1]
		if (got && method === "GET") { const p = notionBooks.find((x) => x.id === got); return p ? reply(p) : reply({ id: got, archived: true }) }
		throw new Error("unmocked " + url)
	}
	return { db, fetch, calls, notionBooks, notionUnits }
}
async function withWorld(w: ReturnType<typeof world>, run: () => Promise<void>, env: Record<string, string> = {}) {
	const original = globalThis.fetch; globalThis.fetch = w.fetch as typeof fetch
	const keep = Object.fromEntries(["SB_URL", "SB_SERVICE_ROLE_KEY", "LIBRARY_SOURCE"].map((k) => [k, Deno.env.get(k)]))
	Deno.env.set("SB_URL", SB); Deno.env.set("SB_SERVICE_ROLE_KEY", "test-only"); Deno.env.delete("LIBRARY_SOURCE")
	for (const [k, v] of Object.entries(env)) Deno.env.set(k, v)
	lc.resetLibraryCopyReady()
	try { await run() } finally {
		globalThis.fetch = original; lc.resetLibraryCopyReady()
		for (const [k, v] of Object.entries(keep)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v)
	}
}
const SRC = { books: "books", units: "units", unitsLink: "라이브러리" }

Deno.test("reconcile: copies books and units, removes rows Notion no longer has, then marks the copy ready", async () => {
	const w = world()
	await withWorld(w, async () => {
		assert(!(await lc.libraryCopyReady()), "not ready before the first reconcile")
		lc.resetLibraryCopyReady()
		const r = await lc.reconcileLibrary(SRC)
		assert(r.books === 2 && r.units === 3 && r.deleted === 2, JSON.stringify(r))
		const b = w.db.lib_books.find((x) => x.id === BOOK), b2 = w.db.lib_books.find((x) => x.id === BOOK2)
		assert(b.title === "쎈 중등 수학 1-1" && b.series === "쎈" && b.cover.endsWith("x.jpg") && !b.cover_file && b.pages === 264 && b.used, JSON.stringify(b))
		assert(b2.cover === "" && b2.cover_file === true && b2.series === "", "uploaded Notion covers are not stored (they expire)")
		const u1 = w.db.lib_units.find((x) => x.id === "u1")
		assert(u1.book_id === BOOK && u1.start_page === 8 && u1.link_count === 1, JSON.stringify(u1))
		assert(!w.db.lib_books.some((x) => x.id === "gone-book") && !w.db.lib_units.some((x) => x.id === "gone-unit"))
		assert(await lc.libraryCopyReady(), "ready after reconcile")
	})
})

Deno.test("read: units by start page; expiring covers fetched fresh from Notion", async () => {
	const w = world()
	await withWorld(w, async () => {
		await lc.reconcileLibrary(SRC)
		assert((await lc.readUnits([BOOK])).map((u) => u.name).join("|") === "1-1. 소인수분해|1-2. 정수|부록")
		const books = await lc.readBooks([BOOK2])
		assert(books[0].cover === "https://notion.files/expiring-1", JSON.stringify(books))
		assert((await lc.readBooks([])).length === 0 && (await lc.readUnits([])).length === 0)
	})
})

Deno.test("library screen reads the copy once ready (no Notion book query); LIBRARY_SOURCE=notion turns it off", async () => {
	const w = world()
	await withWorld(w, async () => {
		await lc.reconcileLibrary(SRC)
		const before = w.calls.filter((c) => c.includes("/data_sources/books/query")).length
		const lib = await tb.libraryBooks()
		assert(lib.books.map((b) => b.title).join() === "개념원리,쎈 중등 수학 1-1" && lib.books[1].units === 3, JSON.stringify(lib.books))
		const units = await tb.bookUnits(BOOK)
		assert(units.units.map((u) => `${u.name}:${u.uses}`).join() === "1-1. 소인수분해:1,1-2. 정수:0,부록:0", JSON.stringify(units))
		assert(w.calls.filter((c) => c.includes("/data_sources/books/query")).length === before, "library list came from the copy")
	})
	const off = world()
	await withWorld(off, async () => {
		await lc.reconcileLibrary(SRC)
		await tb.libraryBooks()
		assert(!(await lc.libraryCopyReady()))
		assert(off.calls.filter((c) => c.includes("/data_sources/books/query")).length === 2, "reconcile + Notion read")
	}, { LIBRARY_SOURCE: "notion" })
})

Deno.test("write-through: one book re-synced after an edit; a trashed book leaves the copy; series rename follows", async () => {
	const w = world()
	await withWorld(w, async () => {
		await lc.reconcileLibrary(SRC)
		w.notionUnits.splice(2, 1, unitPage("u4", BOOK, "2-1. 문자", 60))
		await lc.syncBookCopy(SRC, BOOK)
		assert(w.db.lib_units.map((u) => u.id).sort().join() === "u1,u2,u4", JSON.stringify(w.db.lib_units.map((u) => u.id)))
		await lc.renameSeriesCopy("쎈", "쎈 수학")
		assert(w.db.lib_books.find((b) => b.id === BOOK).series === "쎈 수학")
		w.notionBooks.shift()
		await lc.syncBookCopy(SRC, BOOK)
		assert(!w.db.lib_books.some((b) => b.id === BOOK) && !w.db.lib_units.some((u) => u.book_id === BOOK), "trashed book removed with its units")
	})
	const early = world()
	await withWorld(early, async () => {
		await lc.syncBookCopy(SRC, BOOK)
		assert(!early.calls.some((c) => c.startsWith("POST " + SB + "/rest/v1/lib_")), "no writes before the first reconcile")
	})
})

// 교재 검색(v2.5.118). 알라딘·Notion 호출은 모두 가짜 응답. 실제 키·데이터 없음.
function assert(value: unknown, message = "assertion failed") { if (!value) throw new Error(message) }
for (const [k, v] of Object.entries({ NOTION_TOKEN: "test-only", DATA_SOURCE_PROGRESS_BOOK_ID: "progress", ALADIN_TTB_KEY: "test-only-ttb" })) Deno.env.set(k, v)
const tb = await import("./textbookSearch.ts")

const ITEM = (isbn: string, extra: Record<string, unknown> = {}) => ({ title: "쎈 중등 수학 1-1 (2026년용)", author: "홍범준", publisher: "좋은책신사고", pubDate: "2025-11-01", isbn13: isbn, priceStandard: 19000, link: "http://www.aladin.co.kr/shop/wproduct.aspx?ItemId=1", seriesInfo: { seriesName: "쎈 중등 수학" }, ...extra })
function mock(opts: { existing?: string[]; failUnitAt?: number; toc?: string } = {}) {
	const created: any[] = [], calls: string[] = []
	const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
	const fetch = async (input: any, init: any = {}) => {
		const url = String(input); calls.push(url)
		if (url.startsWith("https://www.aladin.co.kr/ttb/api/ItemSearch.aspx")) return new Response(JSON.stringify({ item: [ITEM("9788928334858"), ITEM("9788928334865", { title: "라이트쎈 중등 수학 1-1" }), { title: "ISBN 없음", isbn13: "" }] }) + ";")
		if (url.startsWith("https://www.aladin.co.kr/ttb/api/ItemLookUp.aspx")) {
			const isbn = new URL(url).searchParams.get("ItemId")
			return reply({ item: [{ ...ITEM(isbn!), subInfo: { itemPage: 264, toc: opts.toc ?? "<p>Ⅰ. 수와 연산</p><p>1. 소인수분해 ··· 8</p><p>2. 정수와 유리수 ··· 28</p><p>정답과 해설</p>" } }] })
		}
		if (url.endsWith("/data_sources/progress")) return reply({ properties: { "정규교재": { relation: { data_source_id: "books" } } } })
		if (url.endsWith("/data_sources/books")) return reply({ properties: { "단원목록": { relation: { data_source_id: "units" } }, "출판사": { select: { options: [{ name: "좋은책신사고" }, { name: "천재교육" }] } }, "시리즈": { select: { options: [{ name: "쎈" }, { name: "라이트쎈" }] } } } })
		if (url.endsWith("/data_sources/books/query")) {
			const isbns = (JSON.parse(init.body).filter?.or ?? []).map((f: any) => f.rich_text.equals)
			return reply({ results: (opts.existing ?? []).filter((i) => isbns.includes(i)).map((i) => ({ id: "p" + i, properties: { ISBN13: { rich_text: [{ plain_text: i }] } } })), has_more: false })
		}
		if (url.endsWith("/pages") && init.method === "POST") {
			const body = JSON.parse(init.body)
			if (body.parent.data_source_id === "units" && created.filter((c) => c.parent.data_source_id === "units").length === opts.failUnitAt) return reply({ message: "fail" }, 500)
			created.push(body); return reply({ id: "new" + created.length })
		}
		throw new Error("unmocked " + url)
	}
	return { fetch, created, calls }
}
async function withMock(m: ReturnType<typeof mock>, run: () => Promise<void>) {
	const original = globalThis.fetch; globalThis.fetch = m.fetch as typeof fetch
	try { await run() } finally { globalThis.fetch = original }
}
async function rejects(fn: () => Promise<unknown>, status: number, re?: RegExp) {
	try { await fn() } catch (e) { assert(e instanceof tb.TextbookError && e.status === status && (!re || re.test(e.message)), `expected ${status}, got ${(e as Error).message}`); return }
	throw new Error("expected rejection " + status)
}

Deno.test("matching publisher and series options only when they exist", () => {
	assert(tb.matchPublisher("(주)좋은책신사고", ["좋은책신사고", "천재교육"]) === "좋은책신사고")
	assert(tb.matchPublisher("신사고", ["좋은책신사고", "천재교육"]) === "좋은책신사고", "unique containment")
	assert(tb.matchPublisher("천재", ["천재교육", "천재교과서"]) === null, "ambiguous containment")
	assert(tb.matchPublisher("새출판사", ["천재교육"]) === null)
	assert(tb.matchSeries("라이트쎈 중등 수학", "", ["쎈", "라이트쎈"]) === "라이트쎈", "longest option first")
	assert(tb.matchSeries("중등 수학 1-1", "쎈 중등 수학", ["쎈", "라이트쎈"]) === "쎈", "Aladin series name")
	assert(tb.matchSeries("개념서", "", ["쎈"]) === null)
})

Deno.test("search: Aladin results with kyobo cover, registered by ISBN13, no ISBN dropped", async () => {
	const m = mock({ existing: ["9788928334865"] })
	await withMock(m, async () => {
		const r = await tb.searchBooks("쎈 중등 수학")
		assert(r.books.length === 2, "items without ISBN13 dropped")
		assert(r.books[0].cover === "https://contents.kyobobook.co.kr/sih/fit-in/458x0/pdt/9788928334858.jpg" && r.books[0].price === 19000 && !r.books[0].registered)
		assert(r.books[1].registered === true)
		assert(!("link" in r.books[0]), "no Aladin product link")
		await rejects(() => tb.searchBooks("쎈"), 400)
	})
})

Deno.test("detail: toc becomes units with the 1-1 rule, options matched", async () => {
	await withMock(mock(), async () => {
		const r = await tb.bookDetail("9788928334858")
		assert(r.book.pages === 264 && r.publisher === "좋은책신사고" && r.series === "쎈")
		assert(r.toc.units.filter((u) => u.include).map((u) => u.name).join("|") === "1-1. 소인수분해|1-2. 정수와 유리수")
		await rejects(() => tb.bookDetail("123"), 400)
	})
})

Deno.test("register: one textbook page with manual cover rule and units linked to it", async () => {
	const m = mock()
	await withMock(m, async () => {
		const r = await tb.registerBook({ isbn13: "9788928334858", title: " 쎈 중등 수학 1-1 ", units: [{ name: "1-1. 소인수분해", page: 8 }, { name: "1-2. 정수와 유리수", page: null }, { name: "  " }] })
		assert(r.ok && r.units === 2, JSON.stringify(r))
		const [book, u1, u2] = m.created
		const p = book.properties
		assert(book.parent.data_source_id === "books" && p["교재명"].title[0].text.content === "쎈 중등 수학 1-1" && p.ISBN13.rich_text[0].text.content === "9788928334858")
		assert(p["북커버"].files[0].external.url.endsWith("/9788928334858.jpg") && p["가격"].number === 19000 && p["전체 페이지"].number === 264 && p["사용중"].checkbox === true)
		assert(p["출판사"].select.name === "좋은책신사고" && p["시리즈"].select.name === "쎈")
		assert(u1.parent.data_source_id === "units" && u1.properties["단원명"].title[0].text.content === "1-1. 소인수분해" && u1.properties["시작페이지"].number === 8 && u1.properties["정규교재"].relation[0].id === "new1")
		assert(!("시작페이지" in u2.properties), "no page when empty")
		assert(!m.calls.some((c) => c.includes("/pages") && c.includes("test-only-ttb")), "key only goes to Aladin")
	})
})

Deno.test("register: duplicate ISBN13 refused, no cover when the image was missing, partial unit failure reported", async () => {
	await withMock(mock({ existing: ["9788928334858"] }), async () => {
		await rejects(() => tb.registerBook({ isbn13: "9788928334858", units: [] }), 409)
	})
	const m = mock()
	await withMock(m, async () => {
		await tb.registerBook({ isbn13: "9788928334858", noCover: true, units: [] })
		assert(!("북커버" in m.created[0].properties))
	})
	const f = mock({ failUnitAt: 1 })
	await withMock(f, async () => {
		const r: any = await tb.registerBook({ isbn13: "9788928334858", units: [{ name: "a" }, { name: "b" }, { name: "c" }] })
		assert(r.ok === false && r.units === 1 && r.failed === 2 && r.pageId === "new1", JSON.stringify(r))
	})
})

Deno.test("missing Aladin key is a clear 503 without calling Aladin", async () => {
	Deno.env.delete("ALADIN_TTB_KEY")
	const m = mock()
	try { await withMock(m, () => rejects(() => tb.searchBooks("쎈 중등"), 503, /ALADIN_TTB_KEY/)) } finally { Deno.env.set("ALADIN_TTB_KEY", "test-only-ttb") }
	assert(!m.calls.some((c) => c.includes("aladin")))
})

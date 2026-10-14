// 라이브러리(v2.5.118, 출처 v2.5.120). 국립중앙도서관·카카오·Notion 호출은 모두 가짜 응답. 실제 키·데이터 없음.
function assert(value: unknown, message = "assertion failed") { if (!value) throw new Error(message) }
for (const [k, v] of Object.entries({ NOTION_TOKEN: "test-only", DATA_SOURCE_PROGRESS_BOOK_ID: "progress", NL_CERT_KEY: "test-only-nl", KAKAO_REST_KEY: "test-only-kakao" })) Deno.env.set(k, v)
const tb = await import("./textbookSearch.ts")
const bs = await import("./bookSources.ts")

const TOC = "Ⅰ. 수와 연산\n1. 소인수분해 ··· 8\n2. 정수와 유리수 ··· 28\n정답과 해설"
// 국립중앙도서관 ISBN 서지정보 응답 한 건(필드 이름은 공식 출력 명세)
const NL_DOC = (isbn: string, extra: Record<string, unknown> = {}) => ({ TITLE: "쎈 중등 수학 1-1", VOL: "", SERIES_TITLE: "쎈 중등 수학", AUTHOR: "홍범준", PUBLISHER: "좋은책신사고", EA_ISBN: isbn, PRE_PRICE: "19,000", PAGE: "264 p.", PUBLISH_PREDATE: "20251101", TITLE_URL: "http://seoji.nl.go.kr/cover/x.jpg", BOOK_TB_CNT: TOC, ...extra })
// 카카오 책 검색 응답 한 건
const KAKAO_DOC = (isbn13: string, extra: Record<string, unknown> = {}) => ({ title: "Phonics Monster 1", isbn: `11${isbn13.slice(5)} ${isbn13}`, publisher: "AList", price: 5400, sale_price: 4860, authors: ["A List"], datetime: "2024-03-01T00:00:00.000+09:00", contents: "", thumbnail: "https://search1.kakaocdn.net/thumb/R120x174.q85/?fname=http%3A%2F%2Ft1.daumcdn.net%2Flbook%2Fimage%2F123", ...extra })
const NL_BOOKS = ["9788928334858", "9788928334865"]
const tt = (s: string) => [{ plain_text: s }]
const LIB = [
	{ id: "22222222-2222-4222-8222-222222222222", properties: { "교재명": { title: tt("쎈 중등 수학 1-2") }, "시리즈": { select: { name: "쎈" } }, "출판사": { select: { name: "좋은책신사고" } }, "북커버": { files: [{ external: { url: "https://contents.kyobobook.co.kr/x.jpg" } }] }, "사용중": { checkbox: true }, ISBN13: { rich_text: tt("9788928334001") }, "단원목록": { relation: [{ id: "u1" }, { id: "u2" }], has_more: false } } },
	{ id: "11111111-1111-4111-8111-111111111111", properties: { "교재명": { title: tt("개념원리 수학 1-1") }, "시리즈": { select: null }, "북커버": { files: [] }, "사용중": { checkbox: false }, "단원목록": { relation: [], has_more: false } } },
]
const UNITS = [{ id: "u2", book: "22222222-2222-4222-8222-222222222222", name: "1-2. 일차부등식", page: 30 }, { id: "u1", book: "22222222-2222-4222-8222-222222222222", name: "1-1. 다항식", page: 8 }, { id: "u3", book: "22222222-2222-4222-8222-222222222222", name: "부록", page: null, exams: 1 }]
function mock(opts: { existing?: string[]; failUnitAt?: number; nlFail?: boolean; kakaoFail?: boolean; schemaFail?: boolean; seriesOpts?: any[] } = {}) {
	const created: any[] = [], calls: string[] = [], headers: Record<string, string>[] = [], patched: any[] = [], schema: any[] = []
	let seriesOpts: any[] = opts.seriesOpts ?? [{ id: "s1", name: "쎈", color: "red" }, { id: "s2", name: "라이트쎈", color: "blue" }]
	const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
	const fetch = async (input: any, init: any = {}) => {
		const url = String(input); calls.push(url); headers.push({ ...(init.headers ?? {}) })
		if (url.startsWith("https://www.nl.go.kr/seoji/SearchApi.do")) {
			if (opts.nlFail) return reply({ message: "down" }, 500)
			const q = new URL(url).searchParams, isbn = q.get("isbn")
			if (isbn) return reply({ TOTAL_COUNT: "1", docs: NL_BOOKS.includes(isbn) ? [NL_DOC(isbn)] : [] })
			return reply({ TOTAL_COUNT: "3", docs: [NL_DOC("9788928334858"), NL_DOC("9788928334865", { TITLE: "라이트쎈 중등 수학 1-1", BOOK_TB_CNT: "" }), { TITLE: "ISBN 없음", EA_ISBN: "" }] })
		}
		if (url.startsWith("https://dapi.kakao.com/v3/search/book")) {
			if (opts.kakaoFail) return reply({ message: "down" }, 500)
			const q = new URL(url).searchParams
			const docs = [KAKAO_DOC("9788928334858", { title: "쎈 중등수학 1-1(카카오)", price: 20000 }), KAKAO_DOC("9791169513371")]
			return reply({ documents: q.get("target") === "isbn" ? docs.filter((d) => d.isbn.endsWith(q.get("query")!)) : docs, meta: { total_count: 2 } })
		}
		if (url.endsWith("/data_sources/progress")) return reply({ properties: { "라이브러리": { relation: { data_source_id: "books" } } } })
		if (url.endsWith("/data_sources/units")) return reply({ properties: { "단원명": { title: {} }, "라이브러리": { relation: { data_source_id: "books" } } } })
		if (url.endsWith("/data_sources/books") && init.method === "PATCH") {
			if (opts.schemaFail) return reply({ object: "error", code: "validation_error", message: "Invalid select option, duplicates not allowed: X" }, 400)
			const next = JSON.parse(init.body).properties["시리즈"].select.options; schema.push(next)
			seriesOpts = next.map((o: any, k: number) => ({ id: o.id ?? "new" + k, name: o.name, color: o.color })); return reply({})
		}
		if (url.endsWith("/data_sources/books")) return reply({ properties: { "단원목록": { relation: { data_source_id: "units" } }, "출판사": { type: "select", select: { options: [{ name: "좋은책신사고" }, { name: "천재교육" }] } }, "시리즈": { type: "select", select: { options: seriesOpts } } } })
		if (url.endsWith("/data_sources/books/query")) {
			const filter = JSON.parse(init.body).filter
			if (!filter) return reply({ results: LIB, has_more: false })
			if (filter.property === "시리즈") return reply({ results: LIB.filter((p: any) => p.properties["시리즈"].select?.name === filter.select.equals), has_more: false })
			const isbns = (filter.or ?? []).map((f: any) => f.rich_text.equals)
			return reply({ results: (opts.existing ?? []).filter((i) => isbns.includes(i)).map((i) => ({ id: "p" + i, properties: { ISBN13: { rich_text: [{ plain_text: i }] } } })), has_more: false })
		}
		if (url.endsWith("/data_sources/units/query")) {
			const id = JSON.parse(init.body).filter.relation.contains
			return reply({ results: UNITS.filter((u) => u.book === id).map((u: any) => ({ id: u.id, properties: { "단원명": { type: "title", title: [{ plain_text: u.name }] }, "시작페이지": { type: "number", number: u.page }, "라이브러리": { type: "relation", relation: [{ id: u.book }] }, "시험범위": { type: "relation", relation: Array.from({ length: u.exams ?? 0 }, (_, k) => ({ id: "exam" + k })) } } })), has_more: false })
		}
		const got = url.match(/\/pages\/([^/?]+)$/)?.[1]
		if (got && init.method === "PATCH") { patched.push({ id: got, body: JSON.parse(init.body) }); return reply({ id: got }) }
		if (got && !init.method) return got === "11111111-1111-4111-8111-111111111111" || got === "22222222-2222-4222-8222-222222222222" ? reply({ id: got, parent: { data_source_id: "books" } }) : got === "33333333-3333-4333-8333-333333333333" ? reply({ id: got, parent: { data_source_id: "elsewhere" } }) : reply({ message: "missing" }, 404)
		if (url.endsWith("/pages") && init.method === "POST") {
			const body = JSON.parse(init.body)
			if (body.parent.data_source_id === "units" && created.filter((c) => c.parent.data_source_id === "units").length === opts.failUnitAt) return reply({ message: "fail" }, 500)
			created.push(body); return reply({ id: "new" + created.length })
		}
		throw new Error("unmocked " + url)
	}
	return { fetch, created, calls, headers, patched, schema }
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
	assert(tb.matchSeries("중등 수학 1-1", "쎈 중등 수학", ["쎈", "라이트쎈"]) === "쎈", "source series name")
	assert(tb.matchSeries("개념서", "", ["쎈"]) === null)
})

Deno.test("search: NL and Kakao merged by ISBN13 (NL first), kyobo cover plus alternative cover, registered marked", async () => {
	const m = mock({ existing: ["9788928334865"] })
	await withMock(m, async () => {
		const r = await tb.searchBooks("쎈 중등 수학")
		assert(r.books.map((b) => b.isbn13).join() === "9788928334858,9788928334865,9791169513371", "no-ISBN dropped, duplicates once: " + r.books.map((b) => b.isbn13).join())
		const [a, b, c] = r.books
		assert(a.title === "쎈 중등 수학 1-1" && a.price === 19000 && a.pages === 264 && a.pubDate === "2025-11-01" && a.sources.join() === "국립중앙도서관,카카오", "NL values win: " + JSON.stringify(a))
		assert(a.cover === "https://contents.kyobobook.co.kr/sih/fit-in/458x0/pdt/9788928334858.jpg" && a.altCover === "https://seoji.nl.go.kr/cover/x.jpg", "kyobo cover, NL cover as https alternative")
		assert(!("toc" in a), "toc only in detail")
		assert(b.registered === true && !a.registered)
		assert(c.title === "Phonics Monster 1" && c.publisher === "AList" && c.pages === null && c.altCover === "https://t1.daumcdn.net/lbook/image/123" && c.sources.join() === "카카오", "Kakao-only book with original cover: " + JSON.stringify(c))
		await rejects(() => tb.searchBooks(" "), 400)
	})
	const nl = new URL(m.calls.find((c) => c.includes("nl.go.kr"))!).searchParams
	assert(nl.get("title") === "쎈 중등 수학" && nl.get("result_style") === "json" && nl.get("cert_key") === "test-only-nl")
	const k = m.calls.findIndex((c) => c.includes("kakao.com"))
	assert(new URL(m.calls[k]).searchParams.get("target") === "title" && m.headers[k].Authorization === "KakaoAK test-only-kakao")
	assert(!m.calls.some((c) => c.includes("notion") && /test-only-(nl|kakao)/.test(c)), "keys only go to their own source")
})

Deno.test("detail: NL table of contents becomes units with the 1-1 rule; no contents is tocEmpty", async () => {
	await withMock(mock(), async () => {
		const r = await tb.bookDetail("9788928334858")
		assert(r.book.pages === 264 && r.publisher === "좋은책신사고" && r.series === "쎈" && !r.tocEmpty)
		assert(r.toc.units.filter((u) => u.include).map((u) => u.name).join("|") === "1-1. 소인수분해|1-2. 정수와 유리수")
		const k = await tb.bookDetail("9791169513371")
		assert(k.tocEmpty && k.toc.units.length === 0 && k.book.altCover.startsWith("https://t1.daumcdn.net/"), JSON.stringify(k))
		await rejects(() => tb.bookDetail("123"), 400)
		await rejects(() => tb.bookDetail("9780000000002"), 404)
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
		assert(p["북커버"].files[0].external.url === "https://contents.kyobobook.co.kr/sih/fit-in/458x0/pdt/9788928334858.jpg" && p["가격"].number === 19000 && p["전체 페이지"].number === 264 && p["사용중"].checkbox === true)
		assert(p["출판사"].select.name === "좋은책신사고" && p["시리즈"].select.name === "쎈")
		assert(u1.parent.data_source_id === "units" && u1.properties["단원명"].title[0].text.content === "1-1. 소인수분해" && u1.properties["시작페이지"].number === 8 && u1.properties["라이브러리"].relation[0].id === "new1")
		assert(!("시작페이지" in u2.properties), "no page when empty")
	})
})

Deno.test("register: cover choice (alt / none / old noCover), duplicate ISBN13 refused, partial unit failure reported", async () => {
	await withMock(mock({ existing: ["9788928334858"] }), async () => {
		await rejects(() => tb.registerBook({ isbn13: "9788928334858", units: [] }), 409)
	})
	const m = mock()
	await withMock(m, async () => {
		await tb.registerBook({ isbn13: "9788928334858", cover: "alt", units: [] })
		await tb.registerBook({ isbn13: "9791169513371", cover: "alt", units: [] })
		await tb.registerBook({ isbn13: "9788928334858", cover: "none", units: [] })
		await tb.registerBook({ isbn13: "9788928334858", noCover: true, units: [] })
		const covers = m.created.map((c) => c.properties["북커버"]?.files[0].external.url ?? "")
		assert(covers.join("|") === "https://seoji.nl.go.kr/cover/x.jpg|https://t1.daumcdn.net/lbook/image/123||", covers.join("|"))
		assert(m.created[1].properties["가격"].number === 5400 && !("전체 페이지" in m.created[1].properties), "Kakao-only book has price, no pages")
	})
	const f = mock({ failUnitAt: 1 })
	await withMock(f, async () => {
		const r: any = await tb.registerBook({ isbn13: "9788928334858", units: [{ name: "a" }, { name: "b" }, { name: "c" }] })
		assert(r.ok === false && r.units === 1 && r.failed === 2 && r.pageId === "new1", JSON.stringify(r))
	})
})

Deno.test("keys: none is a clear 503 without calls; one key uses only that source", async () => {
	Deno.env.delete("NL_CERT_KEY"); Deno.env.delete("KAKAO_REST_KEY")
	try {
		const m = mock()
		await withMock(m, () => rejects(() => tb.searchBooks("쎈 중등"), 503, /NL_CERT_KEY.*KAKAO_REST_KEY/))
		assert(m.calls.length === 0, m.calls.join())
		Deno.env.set("KAKAO_REST_KEY", "test-only-kakao")
		const k = mock()
		await withMock(k, async () => {
			const r = await tb.searchBooks("쎈 중등")
			assert(r.books.length === 2 && r.books.every((b) => b.sources.join() === "카카오"))
		})
		assert(!k.calls.some((c) => c.includes("nl.go.kr")), "no NL call without its key")
	} finally { Deno.env.set("NL_CERT_KEY", "test-only-nl"); Deno.env.set("KAKAO_REST_KEY", "test-only-kakao") }
})

Deno.test("sources: one failing source still shows the other; both failing is 502", async () => {
	await withMock(mock({ nlFail: true }), async () => {
		const r = await tb.searchBooks("쎈 중등")
		assert(r.books.map((b) => b.isbn13).join() === "9788928334858,9791169513371", "Kakao results when NL fails")
	})
	await withMock(mock({ nlFail: true, kakaoFail: true }), () => rejects(() => tb.searchBooks("쎈 중등"), 502))
	assert(bs.kakaoCover("https://search1.kakaocdn.net/thumb/x?fname=http%3A%2F%2Ft1.daumcdn.net%2Fa.jpg") === "https://t1.daumcdn.net/a.jpg")
	assert(bs.kakaoCover("") === "" && bs.kakaoCover("javascript:alert(1)") === "", "only http(s) covers")
	assert(bs.nlBook({ EA_ISBN: "978-89-283-3485-8", TITLE: "수학", VOL: "1", PAGE: "" })?.title === "수학 1", "VOL appended, hyphens removed")
})

Deno.test("library: all books with series, cover, in-use and unit counts", async () => {
	await withMock(mock(), async () => {
		const r = await tb.libraryBooks()
		assert(r.books.map((b) => b.id).join() === "11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222", "sorted by title")
		const b = r.books[1]
		assert(b.series === "쎈" && b.cover.endsWith("x.jpg") && b.used && b.units === 2 && !b.unitsMore && b.isbn13 === "9788928334001", JSON.stringify(b))
		assert(r.books[0].series === "" && r.books[0].cover === "" && r.seriesOrder.join() === "쎈,라이트쎈")
	})
})

Deno.test("units: units of one book by start page; pages of other DBs refused", async () => {
	await withMock(mock(), async () => {
		const r = await tb.bookUnits("22222222-2222-4222-8222-222222222222")
		assert(r.units.map((u) => u.name).join("|") === "1-1. 다항식|1-2. 일차부등식|부록", JSON.stringify(r))
		await rejects(() => tb.bookUnits("33333333-3333-4333-8333-333333333333"), 403)
		await rejects(() => tb.bookUnits("../x"), 400)
	})
})

Deno.test("add-units: new names only, linked to the book, existing units untouched", async () => {
	const m = mock()
	await withMock(m, async () => {
		const r = await tb.addUnits({ bookId: "22222222-2222-4222-8222-222222222222", units: [{ name: "1-1. 다항식", page: 8 }, { name: "1-3. 연립방정식", page: 44 }, { name: "" }] })
		assert(r.ok && r.created === 1 && r.skipped === 1, JSON.stringify(r))
		assert(m.created.length === 1 && m.created[0].properties["단원명"].title[0].text.content === "1-3. 연립방정식" && m.created[0].properties["라이브러리"].relation[0].id === "22222222-2222-4222-8222-222222222222")
		assert(!m.calls.some((c) => /\/pages\/u\d/.test(c)), "existing unit pages are not touched")
		await rejects(() => tb.addUnits({ bookId: "22222222-2222-4222-8222-222222222222", units: [] }), 400)
		await rejects(() => tb.addUnits({ bookId: "33333333-3333-4333-8333-333333333333", units: [{ name: "x" }] }), 403)
	})
})

// ---------- v2.5.119: ISBN 검색, 직접 추가 ----------
Deno.test("search: ISBN query looks the book up in both sources", async () => {
	const m = mock()
	await withMock(m, async () => {
		const one = await tb.searchBooks("979-11-6951-337-1")
		assert(one.books.length === 1 && one.books[0].isbn13 === "9791169513371" && one.books[0].sources.join() === "카카오", JSON.stringify(one))
		const none = await tb.searchBooks("9780000000002")
		assert(none.books.length === 0)
	})
	assert(new URL(m.calls.find((c) => c.includes("nl.go.kr"))!).searchParams.get("isbn") === "9791169513371")
	assert(new URL(m.calls.find((c) => c.includes("kakao.com"))!).searchParams.get("target") === "isbn")
	assert(tb.isbnQuery("쎈 1-1") === null && tb.isbnQuery("9791169513371") === "9791169513371")
})

Deno.test("register-custom: title required, optional ISBN/cover/price, https cover only, duplicate ISBN refused", async () => {
	const m = mock()
	await withMock(m, async () => {
		const r: any = await tb.registerCustom({ title: " 학원 자체 교재 ", units: [{ name: "1. 소개" }] })
		const p = m.created[0].properties
		assert(r.ok && r.units === 1 && p["교재명"].title[0].text.content === "학원 자체 교재" && !("ISBN13" in p) && !("북커버" in p) && !("가격" in p), JSON.stringify(p))
		await tb.registerCustom({ title: "Phonics Monster 1 WB", isbn13: "979-11-6951-337-1", cover: "https://ecimg.cafe24img.com/a/big/1/abc.jpg", price: 5400, publisher: "", units: [] })
		const q = m.created[2].properties
		assert(q.ISBN13.rich_text[0].text.content === "9791169513371" && q["북커버"].files[0].external.url.endsWith("abc.jpg") && q["가격"].number === 5400 && !("출판사" in q), JSON.stringify(q))
		await rejects(() => tb.registerCustom({ title: "", units: [] }), 400)
		await rejects(() => tb.registerCustom({ title: "x", publisher: "AList", units: [] }), 400, /출판사 선택지에 없는/)
		await rejects(() => tb.registerCustom({ title: "x", isbn13: "123", units: [] }), 400)
		await rejects(() => tb.registerCustom({ title: "x", cover: "http://a/b.jpg", units: [] }), 400)
		await rejects(() => tb.registerCustom({ title: "x", cover: "javascript:alert(1)", units: [] }), 400)
	})
	await withMock(mock({ existing: ["9791169513371"] }), async () => {
		await rejects(() => tb.registerCustom({ title: "x", isbn13: "9791169513371", units: [] }), 409)
	})
})

// ---------- v2.5.121: 단원 편집·북커버 수정 ----------
const BOOK = "22222222-2222-4222-8222-222222222222"
Deno.test("units: uses counts links other than the library relation", async () => {
	await withMock(mock(), async () => {
		const r = await tb.bookUnits(BOOK)
		assert(r.units.map((u) => u.uses).join() === "0,0,1", JSON.stringify(r.units))
	})
})

Deno.test("edit-units: update, trash and add in one save; linked units are kept", async () => {
	const m = mock()
	await withMock(m, async () => {
		const r: any = await tb.editUnits({ bookId: BOOK, update: [{ id: "u1", name: "1-1. 다항식의 연산", page: 9 }, { id: "u2", name: "1-2. 일차부등식", page: 30 }], remove: ["u2", "u3"], add: [{ name: "1-3. 연립방정식", page: 44 }, { name: "1-1. 다항식의 연산" }] })
		assert(r.ok && r.updated === 1 && r.removed === 1 && r.added === 1 && r.skipped === 1 && r.blocked.join() === "부록", JSON.stringify(r))
		const [up, del] = m.patched
		assert(up.id === "u1" && up.body.properties["단원명"].title[0].text.content === "1-1. 다항식의 연산" && up.body.properties["시작페이지"].number === 9, JSON.stringify(up))
		assert(del.id === "u2" && del.body.archived === true && m.patched.length === 2, "only the unlinked unit goes to trash, unchanged rows not patched")
		assert(m.created.length === 1 && m.created[0].properties["라이브러리"].relation[0].id === BOOK)
	})
})

Deno.test("edit-units: refuses units of other books, empty names, bad pages, nothing to do", async () => {
	await withMock(mock(), async () => {
		await tb.editUnits({ bookId: BOOK, update: [{ id: "u1", name: "x", page: "" }] })
		await rejects(() => tb.editUnits({ bookId: BOOK, remove: ["zzz"] }), 400, /이 교재의 단원이 아닌/)
		await rejects(() => tb.editUnits({ bookId: BOOK, update: [{ id: "u1", name: " " }] }), 400, /단원명/)
		await rejects(() => tb.editUnits({ bookId: BOOK, update: [{ id: "u1", name: "x", page: 0 }] }), 400, /시작쪽/)
		await rejects(() => tb.editUnits({ bookId: BOOK }), 400)
		await rejects(() => tb.editUnits({ bookId: "33333333-3333-4333-8333-333333333333", add: [{ name: "x" }] }), 403)
	})
})

Deno.test("set-cover: https image or empty, only on library books", async () => {
	const m = mock()
	await withMock(m, async () => {
		await tb.setCover({ bookId: BOOK, cover: "https://contents.kyobobook.co.kr/sih/fit-in/458x0/pdt/9788928334858.jpg" })
		await tb.setCover({ bookId: BOOK, cover: "" })
		assert(m.patched[0].body.properties["북커버"].files[0].external.url.endsWith("9788928334858.jpg") && m.patched[1].body.properties["북커버"].files.length === 0, JSON.stringify(m.patched))
		await rejects(() => tb.setCover({ bookId: BOOK, cover: "http://a/b.jpg" }), 400)
		await rejects(() => tb.setCover({ bookId: BOOK, cover: "javascript:alert(1)" }), 400)
		await rejects(() => tb.setCover({ bookId: "33333333-3333-4333-8333-333333333333", cover: "" }), 403)
	})
})

// ---------- v2.5.122: 시리즈·출판사 고르기, 교재 정보 고치기, 시리즈 관리 ----------
Deno.test("register: series and publisher picked on screen override the automatic match", async () => {
	const m = mock()
	await withMock(m, async () => {
		await tb.registerBook({ isbn13: "9788928334858", series: "라이트쎈", publisher: "천재교육", units: [] })
		await tb.registerBook({ isbn13: "9788928334858", series: "", publisher: "", units: [] })
		await tb.registerBook({ isbn13: "9788928334858", units: [] })
		const [a, b, c] = m.created.map((x) => x.properties)
		assert(a["시리즈"].select.name === "라이트쎈" && a["출판사"].select.name === "천재교육", JSON.stringify(a))
		assert(!("시리즈" in b) && !("출판사" in b), "empty pick leaves them blank")
		assert(c["시리즈"].select.name === "쎈" && c["출판사"].select.name === "좋은책신사고", "no pick keeps the automatic match")
		await rejects(() => tb.registerBook({ isbn13: "9788928334858", series: "없는 시리즈", units: [] }), 400, /시리즈 선택지에 없는/)
	})
})

Deno.test("set-book: cover, series and publisher only when sent; empty clears", async () => {
	const m = mock()
	await withMock(m, async () => {
		await tb.updateBook({ bookId: BOOK, series: "라이트쎈", publisher: "" })
		const p = m.patched[0].body.properties
		assert(p["시리즈"].select.name === "라이트쎈" && p["출판사"].select === null && !("북커버" in p), JSON.stringify(p))
		await rejects(() => tb.updateBook({ bookId: BOOK }), 400)
		await rejects(() => tb.updateBook({ bookId: BOOK, publisher: "새 출판사" }), 400)
	})
})

Deno.test("edit-series: add, rename, order and remove keep option ids; used or duplicate refused", async () => {
	const m = mock()
	await withMock(m, async () => {
		assert((await tb.seriesList()).series.map((x) => x.name).join() === "쎈,라이트쎈")
		const added = await tb.editSeries({ op: "add", name: " 개념원리 " })
		assert(added.series.map((x) => x.name).join() === "쎈,라이트쎈,개념원리", JSON.stringify(added))
		assert(JSON.stringify(m.schema[0]) === JSON.stringify([{ id: "s1", name: "쎈" }, { id: "s2", name: "라이트쎈" }, { name: "개념원리", color: "default" }]), JSON.stringify(m.schema[0]))
		await rejects(() => tb.editSeries({ op: "add", name: "쎈 " }), 409)
		await rejects(() => tb.editSeries({ op: "add", name: "a,b" }), 400)
		await tb.editSeries({ op: "rename", id: "s2", name: "라이트 쎈" })
		assert(m.schema[1][1].id === "s2" && m.schema[1][1].name === "라이트 쎈")
		await rejects(() => tb.editSeries({ op: "rename", id: "s2", name: "쎈" }), 409)
		await tb.editSeries({ op: "order", order: ["new2", "s1", "s2"] })
		assert(m.schema[2].map((o: any) => o.id).join() === "new2,s1,s2")
		await rejects(() => tb.editSeries({ op: "order", order: ["s1"] }), 409)
		await rejects(() => tb.editSeries({ op: "remove", id: "s1" }), 409, /교재 1권/)
		const removed = await tb.editSeries({ op: "remove", id: "s2" })
		assert(removed.series.map((x) => x.name).join() === "개념원리,쎈", JSON.stringify(removed))
		await rejects(() => tb.editSeries({ op: "remove", id: "zzz" }), 404)
		await rejects(() => tb.editSeries({ op: "drop" }), 400)
	})
	await withMock(mock({ schemaFail: true }), () => rejects(() => tb.editSeries({ op: "add", name: "새 시리즈" }), 502, /duplicates not allowed: X\)\. Notion/))
})

// ---------- v2.5.123: id가 겹친 시리즈 선택지 ----------
Deno.test("edit-series: options sharing an id are left out (unused) so Notion accepts the list; used ones stop with a clear message", async () => {
	const dup = [{ id: "s1", name: "쎈" }, { id: "s2", name: "완자" }, { id: "s3", name: "디딤돌" }, { id: "s2", name: "EBS 수능특강" }]
	const m = mock({ seriesOpts: dup })
	await withMock(m, async () => {
		const list = await tb.seriesList()
		assert(list.series.map((x) => x.name).join() === "쎈,완자,디딤돌" && list.duplicates.join() === "EBS 수능특강", JSON.stringify(list))
		const r = await tb.editSeries({ op: "remove", id: "s3" })
		assert(JSON.stringify(m.schema[0]) === JSON.stringify([{ id: "s1", name: "쎈" }, { id: "s2", name: "완자" }]), JSON.stringify(m.schema[0]))
		assert(r.cleaned.join() === "EBS 수능특강" && r.series.map((x) => x.name).join() === "쎈,완자" && r.duplicates.length === 0, JSON.stringify(r))
	})
	const used = mock({ seriesOpts: [{ id: "s9", name: "개념" }, { id: "s9", name: "쎈" }] })
	await withMock(used, () => rejects(() => tb.editSeries({ op: "add", name: "새것" }), 409, /"쎈".*교재 1권/))
	assert(used.schema.length === 0, "nothing sent when a duplicate is in use")
})

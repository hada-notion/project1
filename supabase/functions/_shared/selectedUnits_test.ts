// 학습기록 단원(v2.5.126~127)·범위 해석. Notion 호출은 모두 가짜 응답. 실제 키·데이터 없음.
function assert(value: unknown, message = "assertion failed") { if (!value) throw new Error(message) }
for (const [k, v] of Object.entries({ NOTION_TOKEN: "test-only", DATA_SOURCE_LEARNING_RECORD_ID: "records" })) if (!Deno.env.get(k)) Deno.env.set(k, v)
const ur = await import("./unitRange.ts")
const su = await import("./selectedUnits.ts")
const { DS_LEARNING_RECORD } = await import("./constants.ts")

const U = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`
const REC = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", BOOK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const units = [{ id: U(1), name: "1-1. 소인수분해", page: 8 }, { id: U(2), name: "1-2. 정수", page: 28 }, { id: U(3), name: "2-1. 문자", page: 60 }, { id: U(4), name: "부록", page: null }]

Deno.test("range: comma separated segments, each from its first to last number", () => {
	assert(JSON.stringify(ur.rangeSegments("p.31-35, 40-42")) === JSON.stringify([{ from: 31, to: 35 }, { from: 40, to: 42 }]))
	assert(JSON.stringify(ur.rangeSegments("p.45~40")) === JSON.stringify([{ from: 40, to: 45 }]), "reversed numbers")
	assert(ur.rangeSegments("").length === 0 && ur.rangeSegments("Ⅲ단원").length === 0)
	const names = (r: string) => ur.unitsForRange(units, r).map((u) => u.name).join("|")
	assert(names("p.10-12") === "1-1. 소인수분해")
	assert(names("p.20-30") === "1-1. 소인수분해|1-2. 정수", "spans two units")
	assert(names("p.10, 61") === "1-1. 소인수분해|2-1. 문자", "skips the unit between two segments")
	assert(names("p.100") === "2-1. 문자", "the last unit runs to the end")
	assert(names("p.1-5") === "" && names("") === "", "before the first unit / empty range")
	assert(ur.unitsForRange([{ id: "x", page: null }], "p.3").length === 0, "units without start pages")
})

function notion(opts: { relationName?: string | null; book?: string | null; range?: string } = {}) {
	const patches: any[] = []
	const rel = opts.relationName === undefined ? "단원" : opts.relationName
	const schema: Record<string, unknown> = { "단원(수식)": { type: "formula" } }
	if (rel) schema[rel] = { type: "relation" }
	const unitPages = units.map((u) => ({ id: u.id, properties: { "단원명": { type: "title", title: [{ plain_text: u.name }] }, "시작페이지": { type: "number", number: u.page }, "라이브러리": { type: "relation", relation: [{ id: BOOK }] } } }))
	const fetch = async (input: any, init: any = {}) => {
		const url = String(input)
		const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
		if (url.endsWith(`/data_sources/${DS_LEARNING_RECORD}`)) return reply({ properties: schema })
		if (url.endsWith("/data_sources/units/query")) return reply({ results: unitPages, has_more: false })
		if (url.includes(`/pages/${REC}`) && init.method === "PATCH") { patches.push(JSON.parse(init.body)); return reply({ id: REC }) }
		if (url.includes(`/pages/${REC}`)) return reply({ id: REC, properties: { "범위": { type: "rich_text", rich_text: [{ plain_text: opts.range ?? "p.20-30, 61" }] }, "교재": { type: "relation", relation: opts.book === null ? [] : [{ id: opts.book ?? BOOK }] } } })
		throw new Error("unmocked " + url)
	}
	return { fetch, patches }
}
async function withNotion(n: ReturnType<typeof notion>, run: () => Promise<void>) {
	const original = globalThis.fetch; globalThis.fetch = n.fetch as typeof fetch; su.resetSelectedUnitsEnabled()
	try { await run() } finally { globalThis.fetch = original; su.resetSelectedUnitsEnabled() }
}
const SRC = { books: "books", units: "units", unitsLink: "라이브러리" }

Deno.test("[단원 입력]: replaces the unit relation with the units of the current range (renamed 단원 relation)", async () => {
	const n = notion()
	await withNotion(n, async () => {
		const r = await su.fillRecordUnits(REC, SRC)
		assert(r.units.join("|") === "1-1. 소인수분해|1-2. 정수|2-1. 문자" && r.note === "", JSON.stringify(r))
		assert(JSON.stringify(n.patches[0]) === JSON.stringify({ properties: { "단원": { relation: [{ id: U(1) }, { id: U(2) }, { id: U(3) }] } } }), JSON.stringify(n.patches[0]))
	})
	const empty = notion({ range: "", relationName: "선택 단원" })
	await withNotion(empty, async () => {
		const r = await su.fillRecordUnits(REC, SRC)
		assert(r.units.length === 0 && /비웠/.test(r.note) && JSON.stringify(empty.patches[0]) === JSON.stringify({ properties: { "선택 단원": { relation: [] } } }), "empty range clears (old property name)")
	})
})

Deno.test("[단원 입력]: no book or no unit relation property is a clear message, nothing written", async () => {
	const noBook = notion({ book: null })
	await withNotion(noBook, async () => {
		try { await su.fillRecordUnits(REC, SRC); throw new Error("expected") } catch (e) { assert(e instanceof su.FillUnitsError && e.status === 409 && /교재/.test(e.message), (e as Error).message) }
		assert(noBook.patches.length === 0)
	})
	const noProp = notion({ relationName: null })
	await withNotion(noProp, async () => {
		try { await su.fillRecordUnits(REC, SRC); throw new Error("expected") } catch (e) { assert(e instanceof su.FillUnitsError && e.status === 409 && /단원 관계/.test(e.message), (e as Error).message) }
	})
	try { await su.fillRecordUnits("x", SRC); throw new Error("expected") } catch (e) { assert(e instanceof su.FillUnitsError && e.status === 400) }
})

Deno.test("unit text: picked units first, then the 단원 formula under either name", () => {
	const names = new Map([[U(1), "1-1. 소인수분해"], [U(2), "1-2. 정수"]])
	const relPage = (name: string) => ({ properties: { [name]: { type: "relation", relation: [{ id: U(1) }, { id: U(2) }] }, "단원(수식)": { type: "formula", formula: { type: "string", string: "수식" } } } })
	assert(su.unitTextOf(relPage("단원"), names) === "1-1. 소인수분해 1-2. 정수" && su.unitTextOf(relPage("선택 단원"), names) === "1-1. 소인수분해 1-2. 정수")
	assert(su.unitTextOf({ properties: { "단원": { type: "relation", relation: [] }, "단원(수식)": { type: "formula", formula: { type: "string", string: "수식 단원" } } } }, names) === "수식 단원", "renamed formula fallback")
	assert(su.unitTextOf({ properties: { "단원": { type: "formula", formula: { type: "string", string: "옛 수식" } } } }, names) === "옛 수식", "before the rename")
	assert(su.unitIdsOf(relPage("단원")).join() === U(1) + "," + U(2) && su.unitIdsOf({ properties: { "단원": { type: "formula" } } }).length === 0)
	assert(JSON.stringify(su.cleanUnitIds([U(1), "x", U(1)])) === JSON.stringify([U(1)]) && su.cleanUnitIds("x") === null)
})

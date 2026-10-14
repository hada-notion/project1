// 라이브러리 관계 속성 이름(v2.5.118): 새 이름 "라이브러리"를 먼저, 없으면 옛 이름 "정규교재". 네트워크는 가짜 응답.
function assert(value: unknown, message = "assertion failed") { if (!value) throw new Error(message) }
Deno.env.set("NOTION_TOKEN", "test-only")
const lib = await import("./libraryProp.ts")
const rel = (...ids: string[]) => ({ type: "relation", relation: ids.map((id) => ({ id })) })

Deno.test("reads the new name first, falls back to the old one", () => {
	assert(lib.libraryIds({ properties: { "라이브러리": rel("a"), "정규교재": rel("b") } }).join() === "a")
	assert(lib.libraryIds({ properties: { "정규교재": rel("b") } }).join() === "b")
	assert(lib.libraryIds({ "라이브러리": rel("c") }).join() === "c", "properties object works too")
	assert(lib.libraryIds({ properties: {} }).length === 0 && lib.libraryKey({ properties: {} }) === null)
	assert(lib.libraryKey({ properties: { "정규교재": rel() } }) === "정규교재")
})

Deno.test("data source name is read once from the schema; missing relation is an error", async () => {
	const original = globalThis.fetch
	let calls = 0
	globalThis.fetch = (async (input: any) => {
		calls++
		const id = String(input).split("/").pop()
		const props = id === "old" ? { "정규교재": {} } : id === "new" ? { "라이브러리": {}, "정규교재": {} } : {}
		return new Response(JSON.stringify({ properties: props }))
	}) as typeof fetch
	try {
		lib.clearLibraryPropCache()
		assert(await lib.libraryPropOf("old") === "정규교재")
		assert(await lib.libraryPropOf("new") === "라이브러리")
		assert(await lib.libraryPropOf("old") === "정규교재" && calls === 2, "cached")
		let failed = false
		try { await lib.libraryPropOf("none") } catch { failed = true }
		assert(failed, "no relation → error")
	} finally { globalThis.fetch = original; lib.clearLibraryPropCache() }
})

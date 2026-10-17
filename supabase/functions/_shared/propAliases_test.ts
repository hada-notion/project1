// All network calls are mocked. No live Notion/Supabase writes or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const { updatePageProperties, createPage, queryAllPages, getPage, normalizeProps, pickProp } = await import("./notionClient.ts")

// 예전 이름만 있는 운영 Notion 흉내: 없는 이름을 쓰면 400 "… is not a property that exists."
function mockNotion(existing: string[]) {
	const sent: any[] = []
	const saved = globalThis.fetch
	globalThis.fetch = (async (input: any, init: any = {}) => {
		const url = String(input), body = init.body ? JSON.parse(init.body) : {}
		sent.push({ url, body })
		const names: string[] = []
		if (body.properties) names.push(...Object.keys(body.properties))
		const walk = (f: any) => { if (!f) return; if (f.property) names.push(f.property); for (const k of ["and", "or"]) (f[k] ?? []).forEach(walk) }
		walk(body.filter)
		const bad = names.find((n) => !existing.includes(n))
		if (bad) return new Response(JSON.stringify({ object: "error", status: 400, code: "validation_error", message: `${bad} is not a property that exists.` }), { status: 400 })
		if (url.includes("/query")) return new Response(JSON.stringify({ results: [{ id: "p1", properties: { "출석조정 상태": { select: { name: "⚪ 대기" } } } }], has_more: false }))
		return new Response(JSON.stringify({ id: "p1", properties: { "출석조정 상태": { select: { name: "✅ 완료" } } } }))
	}) as typeof fetch
	return { sent, restore: () => { globalThis.fetch = saved } }
}

Deno.test("v2.7 이름 규칙: 새 이름이 없는 운영은 예전 이름으로 다시 써서 성공(이름이 맞으면 한 번)", async () => {
	let m = mockNotion(["출석조정 상태", "마지막 오류"])
	try {
		await updatePageProperties("p1", { "출석 조정 상태": { select: { name: "✅ 완료" } }, "마지막 오류": { rich_text: [] } })
		eq(m.sent.length, 2)
		eq(Object.keys(m.sent[1].body.properties), ["출석조정 상태", "마지막 오류"])
	} finally { m.restore() }
	m = mockNotion(["출석 조정 상태", "마지막 오류"])
	try {
		await updatePageProperties("p1", { "출석 조정 상태": { select: { name: "✅ 완료" } }, "마지막 오류": { rich_text: [] } })
		eq(m.sent.length, 1)
	} finally { m.restore() }
})

Deno.test("v2.7 이름 규칙: 두 속성이 다 예전 이름이면 차례로 바꿔 쓰고, 만들기·조회도 같은 방식", async () => {
	let m = mockNotion(["학습활동 생성 상태", "활동 생성 시작 시각"])
	try {
		await updatePageProperties("p1", { "학습활동 생성 상태": { select: { name: "🔄 작업중" } }, "학습활동 생성 시작 시각": { date: null } })
		eq(Object.keys(m.sent.at(-1).body.properties), ["학습활동 생성 상태", "활동 생성 시작 시각"])
	} finally { m.restore() }
	m = mockNotion(["이름", "출석조정 상태"])
	try {
		await createPage("sessions", { 이름: { title: [] }, "출석 조정 상태": { select: { name: "⚪ 대기" } } })
		eq(m.sent.length, 2)
		eq("출석조정 상태" in m.sent[1].body.properties, true)
	} finally { m.restore() }
	m = mockNotion(["출석조정 상태"])
	try {
		const rows = await queryAllPages("sessions", { property: "출석 조정 상태", select: { equals: "⚪ 대기" } })
		eq(m.sent.at(-1).body.filter.property, "출석조정 상태")
		eq(rows[0].properties["출석 조정 상태"].select.name, "⚪ 대기")
	} finally { m.restore() }
})

Deno.test("v2.7 이름 규칙: 읽을 때 예전 이름 값을 새 이름으로도 보여 주고, 이름이 아닌 400은 다시 보내지 않음", async () => {
	const page: any = normalizeProps<any>({ properties: { "담기 상태": { select: { name: "✅ 완료" } }, "전송 상태": { select: { name: "⚪ 대기" } } } })
	eq(page.properties["진도교재 담기 상태"].select.name, "✅ 완료")
	eq(page.properties["보고서 전송 상태"].select.name, "⚪ 대기")
	eq(pickProp({ "수업추가 정보": { formula: { string: "x" } } }, "수업 추가 정보").formula.string, "x")
	const m = mockNotion(["출석조정 상태"])
	try {
		const p = await getPage("p1")
		eq(p.properties["출석 조정 상태"].select.name, "✅ 완료")
		let threw = false
		try { await updatePageProperties("p1", { "없는 속성": { checkbox: true } }) } catch { threw = true }
		eq(threw, true)
		eq(m.sent.filter((s: any) => s.body.properties).length, 1)
	} finally { m.restore() }
})

// All network calls are mocked. No live Notion/Supabase writes or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_STUDY_ACTIVITY_ID: "activities", DATA_SOURCE_REPORT_ID: "reports" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const { buildRegistrationDetail, reportModeOf, standaloneEvalIso } = await import("./reportCacheBuilder.ts")

Deno.test("v2.8.0 출석 없는 평가 날짜: 평가 기간 끝(하루면 그날), 서울 자정 ISO", () => {
	eq(standaloneEvalIso("2026-10-12", "2026-10-18"), "2026-10-18T00:00:00+09:00")
	eq(standaloneEvalIso("2026-10-14", null), "2026-10-14T00:00:00+09:00")
	eq(standaloneEvalIso("2026-10-14T23:30:00+09:00", null), "2026-10-14T00:00:00+09:00")
	eq(standaloneEvalIso(null, null), null)
})

Deno.test("v2.8.0 리포트 구성: 평가만이면 tests_only, 비었거나 칸이 없으면 all", () => {
	eq(reportModeOf({ properties: { "리포트 구성": { type: "select", select: { name: "평가만" } } } }), "tests_only")
	eq(reportModeOf({ properties: { "리포트 구성": { type: "select", select: { name: "전체" } } } }), "all")
	eq(reportModeOf({ properties: { "리포트 구성": { type: "select", select: null } } }), "all")
	eq(reportModeOf({ properties: {} }), "all")
})

// 서울 기준 n일 전 날짜(YYYY-MM-DD). 리포트는 최근 몇 달·오늘까지만 싣는다.
const daysAgo = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(Date.now() - n * 86400000))

Deno.test("v2.8.0 리포트 캐시: 출석 없는 평가가 평가 기간 끝 날짜로 들어가고, 평가 구분·기간·리포트 구성을 싣는다", async () => {
	const REG = "reg-1", CLS = "cls-1", REC = "rec-1", ACT = "act-1", REC2 = "rec-2", ACT2 = "act-2"
	const start = daysAgo(9), end = daysAgo(3)
	const sel = (name: string) => ({ type: "select", select: { name } })
	const pages: Record<string, any> = {
		[CLS]: { id: CLS, properties: { "리포트 구성": sel("평가만"), "반 평균 숨김": { type: "checkbox", checkbox: false }, "담당강사": { type: "relation", relation: [] } } },
		[REC]: { id: REC, properties: { "구분": sel("평가"), "평가 구분": sel("주간 평가"), "평가 기간": { type: "date", date: { start, end } }, "학습": { type: "title", title: [{ plain_text: "[평가] 중3 B 주간" }] }, "학습활동": { type: "relation", relation: [{ id: ACT }] } } },
		// 평가 기간 끝이 아직 안 온 평가(이번 주)는 끝 날짜가 지나야 실린다.
		[REC2]: { id: REC2, properties: { "구분": sel("평가"), "평가 구분": sel("주간 평가"), "평가 기간": { type: "date", date: { start: daysAgo(0), end: daysAgo(-6) } }, "학습활동": { type: "relation", relation: [{ id: ACT2 }] } } },
	}
	const activity = (id: string, rec: string) => ({ id, properties: { "구분": sel("평가"), "학습기록": { type: "relation", relation: [{ id: rec }] }, "출석": { type: "relation", relation: [] }, "정답 문항": { type: "number", number: 17 }, "전체 문항": { type: "number", number: 20 } } })
	const realFetch = globalThis.fetch
	globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input)
		const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } })
		if (url.startsWith("https://mock.supabase")) return json([])
		if (url.includes("/data_sources/activities/query")) return json({ results: [activity(ACT, REC), activity(ACT2, REC2)], has_more: false })
		if (url.includes("/query")) return json({ results: [], has_more: false })
		if (url.includes("/blocks/")) return json({ results: [], has_more: false })
		throw new Error(`unexpected fetch ${url} ${init?.method ?? "GET"}`)
	}) as typeof fetch
	try {
		const reg = { id: REG, properties: { "클래스": { type: "relation", relation: [{ id: CLS }] } } }
		const detail: any = await buildRegistrationDetail(reg, async (id: string) => pages[id] ?? { id, properties: {} })
		eq(detail.report_mode, "tests_only")
		eq(detail.tests.length, 1)
		const t = detail.tests[0]
		eq(t.iso, `${end}T00:00:00+09:00`)
		eq(t.eval_type, "주간 평가")
		eq([t.eval_start, t.eval_end], [start, end])
		eq(t.standalone, true)
		eq([t.correct, t.total], [17, 20])
	} finally {
		globalThis.fetch = realFetch
	}
})

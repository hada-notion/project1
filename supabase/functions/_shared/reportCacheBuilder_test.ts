// All network calls are mocked. No live Notion/Supabase writes or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_STUDY_ACTIVITY_ID: "activities", DATA_SOURCE_REPORT_ID: "reports", DATA_SOURCE_ATTENDANCE_ID: "attendance" })) Deno.env.set(key, value)
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

Deno.test("v2.8.0 리포트 캐시: 평가는 구분마다 최근 6개씩(일일 평가가 많아도 주간 평가가 밀리지 않음)", async () => {
	const { testKindOf } = await import("./reportCacheBuilder.ts")
	eq([testKindOf("주간 평가"), testKindOf("월간 평가"), testKindOf("종합 평가"), testKindOf("일일 평가"), testKindOf("기타"), testKindOf("")], ["주간 평가", "월간 평가", "종합 평가", "일일 평가", "일일 평가", "일일 평가"])
	const sel = (name: string) => ({ type: "select", select: { name } })
	const pages: Record<string, any> = { "cls-1": { id: "cls-1", properties: { "담당강사": { type: "relation", relation: [] } } } }
	const acts: any[] = []
	for (let i = 1; i <= 8; i++) {
		const rec = `d-rec-${i}`, att = `att-${i}`
		pages[rec] = { id: rec, properties: { "구분": sel("평가"), "평가 구분": sel("일일 평가"), "학습활동": { type: "relation", relation: [] } } }
		pages[att] = { id: att, properties: { "수업일시": { type: "date", date: { start: `${daysAgo(i)}T16:00:00+09:00` } } } }
		acts.push({ id: `d-act-${i}`, properties: { "구분": sel("평가"), "학습기록": { type: "relation", relation: [{ id: rec }] }, "출석": { type: "relation", relation: [{ id: att }] }, "정답 문항": { type: "number", number: 8 }, "전체 문항": { type: "number", number: 10 } } })
	}
	for (let i = 1; i <= 2; i++) {
		const rec = `w-rec-${i}`
		pages[rec] = { id: rec, properties: { "구분": sel("평가"), "평가 구분": sel("주간 평가"), "평가 기간": { type: "date", date: { start: daysAgo(7 * i + 6), end: daysAgo(7 * i) } }, "학습활동": { type: "relation", relation: [] } } }
		acts.push({ id: `w-act-${i}`, properties: { "구분": sel("평가"), "학습기록": { type: "relation", relation: [{ id: rec }] }, "출석": { type: "relation", relation: [] }, "정답 문항": { type: "number", number: 7 }, "전체 문항": { type: "number", number: 10 } } })
	}
	const realFetch = globalThis.fetch
	globalThis.fetch = (async (input: Request | URL | string) => {
		const url = String(input instanceof Request ? input.url : input)
		const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } })
		if (url.startsWith("https://mock.supabase")) return json([])
		if (url.includes("/data_sources/activities/query")) return json({ results: acts, has_more: false })
		if (url.includes("/query") || url.includes("/blocks/")) return json({ results: [], has_more: false })
		throw new Error(`unexpected fetch ${url}`)
	}) as typeof fetch
	try {
		const detail: any = await buildRegistrationDetail({ id: "reg-1", properties: { "클래스": { type: "relation", relation: [{ id: "cls-1" }] } } }, async (id: string) => pages[id] ?? { id, properties: {} })
		const kinds = detail.tests.map((t: any) => t.eval_type)
		eq(kinds.filter((k: string) => k === "일일 평가").length, 6)
		eq(kinds.filter((k: string) => k === "주간 평가").length, 2)
		eq(detail.tests[0].iso >= detail.tests[detail.tests.length - 1].iso, true)
	} finally {
		globalThis.fetch = realFetch
	}
})

Deno.test("v2.8.0 리포트 캐시: 보강 출석의 기존 수업일을 그 출석의 학습기록에 makeup_of로 붙인다(없으면 안 붙음)", async () => {
	const REG = "reg-9", ATT_MK = "att-mk", ATT_N = "att-n", LOG_MK = "log-mk", LOG_N = "log-n"
	const day = daysAgo(2), orig = daysAgo(16)
	const sel = (name: string) => ({ type: "select", select: { name } })
	const pages: Record<string, any> = {
		[LOG_MK]: { id: LOG_MK, properties: { "구분": sel("학습"), "학습": { type: "title", title: [{ plain_text: "보강" }] } } },
		[LOG_N]: { id: LOG_N, properties: { "구분": sel("학습"), "학습": { type: "title", title: [{ plain_text: "정규" }] } } },
	}
	const rows = [
		{ notion_page_id: ATT_MK, registration_id: REG, class_iso: `${day}T18:00:00+09:00`, status: "보강", check_in: "", check_out: "", teacher_comment: "", study_log_ids: [LOG_MK] },
		{ notion_page_id: ATT_N, registration_id: REG, class_iso: `${daysAgo(3)}T18:00:00+09:00`, status: "출석", check_in: "", check_out: "", teacher_comment: "", study_log_ids: [LOG_N] },
	]
	let asked = ""
	const realFetch = globalThis.fetch
	globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input)
		const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } })
		if (url.includes("/rest/v1/attendance_records")) return json(rows)
		if (url.startsWith("https://mock.supabase")) return json([])
		if (url.includes("/data_sources/attendance/query")) { asked = String(init?.body ?? ""); return json({ results: [{ id: ATT_MK, properties: { "기존 수업일": { type: "formula", formula: { type: "string", string: orig } } } }], has_more: false }) }
		if (url.includes("/query")) return json({ results: [], has_more: false })
		if (url.includes("/blocks/")) return json({ results: [], has_more: false })
		throw new Error(`unexpected fetch ${url} ${init?.method ?? "GET"}`)
	}) as typeof fetch
	try {
		const detail: any = await buildRegistrationDetail({ id: REG, properties: {} }, async (id: string) => pages[id] ?? { id, properties: {} })
		const byTitle = Object.fromEntries(detail.study_logs.map((l: any) => [l.book, l]))
		eq(byTitle["보강"].makeup_of, orig)
		eq("makeup_of" in byTitle["정규"], false)
		eq(asked.includes("기존 수업일") && asked.includes(REG), true)
	} finally {
		globalThis.fetch = realFetch
	}
})

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

Deno.test("v2.8.0 리포트 캐시: 최근 6개월 평가를 구분과 상관없이 모두 싣는다(최근 순, 10/30 일일 기록 기반)", async () => {
	const { testKindOf } = await import("./reportCacheBuilder.ts")
	eq([testKindOf("주간 평가"), testKindOf("월간 평가"), testKindOf("종합 평가"), testKindOf("단원 평가"), testKindOf("마무리 평가"), testKindOf("일일 평가"), testKindOf("기타"), testKindOf("")], ["주간 평가", "월간 평가", "일일 평가", "일일 평가", "일일 평가", "일일 평가", "일일 평가", "일일 평가"])
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
		eq(kinds.filter((k: string) => k === "일일 평가").length, 8)
		eq(kinds.filter((k: string) => k === "주간 평가").length, 2)
		eq(detail.tests[0].iso >= detail.tests[detail.tests.length - 1].iso, true)
	} finally {
		globalThis.fetch = realFetch
	}
})

Deno.test("v2.8.0 리포트 캐시: 보강 출석의 기존 결석 수업일(서울 날짜)을 그 출석의 학습기록에 makeup_of로 붙인다(없으면 안 붙음)", async () => {
	const REG = "reg-9", ATT_MK = "att-mk", ATT_N = "att-n", LOG_MK = "log-mk", LOG_N = "log-n"
	const day = daysAgo(2), orig = daysAgo(16)
	const sel = (name: string) => ({ type: "select", select: { name } })
	const ABS = "abs-1"
	const pages: Record<string, any> = {
		// 원래 결석: 오전 8시(KST) 수업 = 전날 23:00 UTC. 서울 날짜로 orig가 나와야 한다.
		[ABS]: { id: ABS, properties: { "수업일시": { type: "date", date: { start: new Date(`${orig}T08:00:00+09:00`).toISOString() } } } },
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
		if (url.includes("/data_sources/attendance/query")) { asked = String(init?.body ?? ""); return json({ results: [{ id: ATT_MK, properties: { "기존 결석": { type: "relation", relation: [{ id: ABS }] } } }], has_more: false }) }
		if (url.includes("/query")) return json({ results: [], has_more: false })
		if (url.includes("/blocks/")) return json({ results: [], has_more: false })
		throw new Error(`unexpected fetch ${url} ${init?.method ?? "GET"}`)
	}) as typeof fetch
	try {
		const detail: any = await buildRegistrationDetail({ id: REG, properties: {} }, async (id: string) => pages[id] ?? { id, properties: {} })
		const byTitle = Object.fromEntries(detail.study_logs.map((l: any) => [l.book, l]))
		eq(byTitle["보강"].makeup_of, orig)
		eq("makeup_of" in byTitle["정규"], false)
		eq(asked.includes("기존 결석") && asked.includes(REG), true)
	} finally {
		globalThis.fetch = realFetch
	}
})

Deno.test("v2.8.0 리포트 캐시: 기록마다 진도교재 ID(book_id)를 싣는다(반별교재면 학생 진도교재, 모르면 빈 값)", async () => {
	const REG = "reg-1", CLS = "cls-1", B1 = "b1", B2 = "b2", CB = "cb", X = "x"
	const sel = (name: string) => ({ type: "select", select: { name } })
	const rel = (...ids: string[]) => ({ type: "relation", relation: ids.map((id) => ({ id })) })
	const day = daysAgo(3)
	const rec = (id: string, book: string, act: string) => ({ id, properties: { "구분": sel("평가"), "평가 구분": sel("단원 평가"), "평가 기간": { type: "date", date: { start: day, end: null } }, "진도교재": rel(book), "학습활동": rel(act) } })
	const pages: Record<string, any> = {
		[CLS]: { id: CLS, properties: { "반 평균 숨김": { type: "checkbox", checkbox: false }, "담당강사": rel() } },
		[B1]: { id: B1, properties: {} }, [B2]: { id: B2, properties: { "반별교재": rel(CB) } },
		r1: rec("r1", B1, "a1"), r2: rec("r2", CB, "a2"), r3: rec("r3", X, "a3"),
	}
	const activity = (id: string, r: string) => ({ id, properties: { "구분": sel("평가"), "학습기록": rel(r), "출석": rel(), "정답 문항": { type: "number", number: 1 }, "전체 문항": { type: "number", number: 2 } } })
	const realFetch = globalThis.fetch
	globalThis.fetch = (async (input: Request | URL | string) => {
		const url = String(input instanceof Request ? input.url : input)
		const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } })
		if (url.startsWith("https://mock.supabase")) return json([])
		if (url.includes("/data_sources/activities/query")) return json({ results: [activity("a1", "r1"), activity("a2", "r2"), activity("a3", "r3")], has_more: false })
		return json({ results: [], has_more: false })
	}) as typeof fetch
	try {
		const reg = { id: REG, properties: { "클래스": rel(CLS), "진도교재": rel(B1, B2) } }
		const detail: any = await buildRegistrationDetail(reg, async (id: string) => pages[id] ?? { id, properties: {} })
		eq(detail.tests.map((t: any) => t.book_id).sort(), ["", B1, B2])
	} finally {
		globalThis.fetch = realFetch
	}
})

Deno.test("v2.8.0 작품 모아보기: 프로그램 학습기록의 사진만 수업 순서로 모은다(학생 학습활동 사진 먼저, blockId 포함)", async () => {
	const REG = "reg-g", PB = "pb1", LIB_P = "lib-p", LIB_T = "lib-t", TB = "tb1"
	const sel = (name: string) => ({ type: "select", select: { name } })
	const rel = (...ids: string[]) => ({ type: "relation", relation: ids.map((id) => ({ id })) })
	const pages: Record<string, any> = {
		[PB]: { id: PB, properties: {} },
		[TB]: { id: TB, properties: {} },
		[LIB_P]: { id: LIB_P, properties: { "교재명": { type: "title", title: [{ plain_text: "수채화" }] }, "구분": sel("프로그램") } },
		[LIB_T]: { id: LIB_T, properties: { "교재명": { type: "title", title: [{ plain_text: "수학" }] }, "구분": sel("교재") } },
		"log-1": { id: "log-1", properties: { "구분": sel("학습"), "범위": { type: "rich_text", rich_text: [{ plain_text: "1" }] }, "교재": rel(LIB_P), "진도교재": rel(PB) } },
		"log-2": { id: "log-2", properties: { "구분": sel("학습"), "범위": { type: "rich_text", rich_text: [{ plain_text: "2" }] }, "교재": rel(LIB_P), "진도교재": rel(PB) } },
		"log-t": { id: "log-t", properties: { "구분": sel("학습"), "교재": rel(LIB_T), "진도교재": rel(TB) } },
	}
	const rows = [
		{ notion_page_id: "att-1", registration_id: REG, class_iso: `${daysAgo(9)}T16:00:00+09:00`, status: "출석", check_in: "", check_out: "", teacher_comment: "", study_log_ids: ["log-1"] },
		{ notion_page_id: "att-2", registration_id: REG, class_iso: `${daysAgo(2)}T16:00:00+09:00`, status: "출석", check_in: "", check_out: "", teacher_comment: "", study_log_ids: ["log-2", "log-t"] },
	]
	const image = (id: string) => ({ id, type: "image", image: { type: "external", external: { url: `https://img.test/${id}.png` }, caption: [] } })
	const blocks: Record<string, any[]> = { "log-1": [image("i-rec-1")], "log-2": [{ id: "p", type: "paragraph", paragraph: { rich_text: [] } }, image("i-rec-2")], "log-t": [image("i-math")], "act-1": [image("i-act-1")] }
	const realFetch = globalThis.fetch
	globalThis.fetch = (async (input: Request | URL | string) => {
		const url = String(input instanceof Request ? input.url : input)
		const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } })
		if (url.includes("/rest/v1/attendance_records")) return json(rows)
		if (url.startsWith("https://mock.supabase")) return json([])
		if (url.includes("/data_sources/activities/query")) return json({ results: [{ id: "act-1", properties: { "구분": sel("학습"), "학습기록": rel("log-1"), "출석": rel("att-1") } }], has_more: false })
		if (url.includes("/query")) return json({ results: [], has_more: false })
		const m = url.match(/\/blocks\/([^/]+)\/children/)
		if (m) return json({ results: blocks[m[1]] ?? [], has_more: false })
		throw new Error(`unexpected fetch ${url}`)
	}) as typeof fetch
	try {
		const detail: any = await buildRegistrationDetail({ id: REG, properties: { "진도교재": rel(PB, TB) } }, async (id: string) => pages[id] ?? { id, properties: {} })
		eq(detail.gallery.map((g: any) => [g.book_id, g.range, g.url, g.block_id, g.mine]), [
			[PB, "1", "https://img.test/i-act-1.png", "i-act-1", true],
			[PB, "1", "https://img.test/i-rec-1.png", "i-rec-1", false],
			[PB, "2", "https://img.test/i-rec-2.png", "i-rec-2", false],
		])
	} finally {
		globalThis.fetch = realFetch
	}
})

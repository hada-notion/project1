// All network calls are mocked. No live Notion/Supabase writes or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_REPORT_ID: "reports", DATA_SOURCE_LEARNING_RECORD_ID: "records", DATA_SOURCE_STUDY_ACTIVITY_ID: "activities" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const throwsWith = (fn: () => unknown, part: string) => { try { fn() } catch (e) { if (!(e as Error).message.includes(part)) throw new Error(`message ${(e as Error).message}`); return } throw new Error("expected throw") }
const m = await import("./evaluationPlan.ts")
const { evaluationDeps: deps } = m

const B1 = "3eeba040586b81e3a977f3fb68b99d2f", B2 = "3eeba040586b81d88856f5943119f246", L1 = "3efba040586b81b2b3dceece99353437"
const R1 = "3ecba040586b8061a932dc4c4869e7a9", R2 = "3ecba040586b80a0ac75ced1c02928de", S1 = "3edba040586b8171ac98d889d3c1dfa9"
const BATCH = "405ba040586b816f8634c6a509e45bee", CLS = "3ecba040586b8047a1eaf3f6e80019df"
const planJson = (items: unknown[]) => JSON.stringify({ v: 1, items })
const rel = (...ids: string[]) => ({ type: "relation", relation: ids.map((id) => ({ id })), has_more: false })

Deno.test("v2.8.0 평가 계획: 교재·라이브러리·과목·등록·제목을 읽고, 형식이 틀리면 오류", () => {
	eq(m.evalPlanFromText(planJson([{ b: B1, l: L1, s: [S1], r: [R1, R2, R1], t: "[주간 평가] 수학 · 중2 B 10.19~10.25" }])), [
		{ book: B1, lib: L1, subjects: [S1], regs: [R1, R2], title: "[주간 평가] 수학 · 중2 B 10.19~10.25" },
	])
	eq(m.evalPlanFromText(planJson([{ b: B1, l: "", s: [], r: [R1], t: "" }])), [{ book: B1, subjects: [], regs: [R1], title: "[평가]" }])
	eq(m.evalPlanFromText(""), null)
	eq(m.evalPlanFromText("수식 아님"), null)
	throwsWith(() => m.evalPlanFromText(planJson([{ b: "bad", r: [R1] }])), "진도교재")
	throwsWith(() => m.evalPlanFromText(planJson([{ b: B1, r: ["bad"] }])), "등록")
	eq(m.evalTypeOfKind("주간 보고서"), "주간 평가")
	eq(m.evalTypeOfKind("월간 보고서"), "월간 평가")
	eq(m.evalTypeOfKind("수강료"), null)
})

type Calls = { created: any[]; updates: any[]; enqueued: any[]; marks: string[] }
function mock(data: { kind?: string; books?: Record<string, boolean>; existing?: any[]; planProp?: string; acts?: any[]; reports?: any[]; record?: any }): Calls {
	const calls: Calls = { created: [], updates: [], enqueued: [], marks: [] }
	Object.assign(deps, {
		getPage: async (id: string) => {
			if (id === BATCH) return { id, properties: { "구분": { type: "select", select: { name: data.kind ?? "주간 보고서" } }, "기간": { type: "date", date: { start: "2026-10-19", end: "2026-10-25" } }, "클래스": rel(CLS), "평가 계획": { type: "formula", formula: { string: data.planProp ?? "" } } } }
			if (id in (data.books ?? {})) return { id, properties: { "평가 대상": { type: "checkbox", checkbox: data.books![id] } } }
			if (data.record && id === data.record.id) return data.record
			throw new Error(`unexpected getPage ${id}`)
		},
		queryAllPages: async (ds: string) => ds === "records" ? (data.existing ?? []) : ds === "activities" ? (data.acts ?? []) : ds === "reports" ? (data.reports ?? []) : [],
		createPage: async (ds: string, props: any) => { calls.created.push({ ds, props }); return { id: `rec-${calls.created.length}` } },
		update: async (id: string, props: any) => { calls.updates.push({ id, props }) },
		fullRelationIds: async (page: any, name: string) => (page.properties?.[name]?.relation ?? []).map((r: any) => r.id),
		enqueue: async (target: string, payload: any) => { calls.enqueued.push({ target, payload }) },
		markRunning: async (id: string) => { calls.marks.push(`running:${id}`) },
		markDone: async (id: string) => { calls.marks.push(`done:${id}`) },
		markError: async (id: string, msg: string) => { calls.marks.push(`error:${id}:${msg}`) },
	})
	return calls
}

Deno.test("v2.8.0 발송함 평가 만들기: 체크된 교재마다 평가 학습기록, 체크 해제, 학습활동 큐", async () => {
	const calls = mock({ books: { [B1]: true, [B2]: true } })
	await m.processBatchEvaluationsQueueItem({ batchId: BATCH, plan: planJson([
		{ b: B1, l: L1, s: [S1], r: [R1, R2], t: "[주간 평가] 수학 · 중2 B 10.19~10.25" },
		{ b: B2, s: [], r: [R1], t: "[주간 평가] 영어 · 중2 B 10.19~10.25" },
	]) })
	eq(calls.created.length, 2)
	const p = calls.created[0].props
	eq(calls.created[0].ds, "records")
	eq(p["학습"].title[0].text.content, "[주간 평가] 수학 · 중2 B 10.19~10.25")
	eq(p["구분"].select.name, "평가")
	eq(p["평가 구분"].select.name, "주간 평가")
	eq(p["평가 기간"].date, { start: "2026-10-19", end: "2026-10-25" })
	eq(p["진도교재"].relation, [{ id: B1 }])
	eq(p["교재"].relation, [{ id: L1 }])
	eq(p["과목"].relation, [{ id: S1 }])
	eq(p["등록"].relation, [{ id: R1 }, { id: R2 }])
	eq(p["알림톡 발송함"].relation, [{ id: BATCH }])
	eq(p["클래스"].relation, [{ id: CLS }])
	eq(calls.created[1].props["교재"], undefined)
	eq(calls.updates, [{ id: B1, props: { "평가 대상": { checkbox: false } } }, { id: B2, props: { "평가 대상": { checkbox: false } } }])
	eq(calls.enqueued, [{ target: "create-assignment", payload: { recordId: "rec-1", plan: null } }, { target: "create-assignment", payload: { recordId: "rec-2", plan: null } }])
	eq(calls.marks, [`running:${BATCH}`, `done:${BATCH}`])
})

Deno.test("v2.8.0 발송함 평가 만들기: 체크가 풀린 교재·이미 평가가 있는 교재는 건너뛰고, 본문에 계획이 없으면 발송함 수식을 읽는다", async () => {
	const calls = mock({
		books: { [B1]: false, [B2]: true },
		existing: [{ id: "old", properties: { "진도교재": rel(B2) } }],
		planProp: planJson([{ b: B1, r: [R1] }, { b: B2, r: [R1] }]),
	})
	await m.processBatchEvaluationsQueueItem({ batchId: BATCH, plan: null })
	eq(calls.created.length, 0)
	eq(calls.updates, [{ id: B2, props: { "평가 대상": { checkbox: false } } }])
	eq(calls.enqueued.length, 0)
	eq(calls.marks, [`running:${BATCH}`, `done:${BATCH}`])
})

Deno.test("v2.8.0 발송함 평가 만들기: 수강료 발송함·체크 없음·대상 학생 없음은 만들지 않고 ⚠️ 오류(재시도 없음)", async () => {
	let calls = mock({ kind: "수강료" })
	await m.processBatchEvaluationsQueueItem({ batchId: BATCH, plan: planJson([{ b: B1, r: [R1] }]) })
	eq(calls.created.length, 0)
	eq(calls.marks[1], `error:${BATCH}:평가는 주간·월간 보고서 발송함에서만 만들 수 있습니다.`)
	calls = mock({})
	await m.processBatchEvaluationsQueueItem({ batchId: BATCH, plan: planJson([]) })
	eq(calls.marks[1].includes("'평가 대상'을 체크"), true)
	calls = mock({ books: { [B1]: true } })
	await m.processBatchEvaluationsQueueItem({ batchId: BATCH, plan: planJson([{ b: B1, r: [] }]) })
	eq(calls.created.length, 0)
	eq(calls.marks[1].includes("[보고서 생성]"), true)
})

Deno.test("v2.8.0 평가 보고서 붙이기: 학생별 학습활동과 학습기록을 그 발송함 보고서에 더하고, 이미 있으면 쓰지 않는다", async () => {
	const REC = "rec-x"
	const calls = mock({
		record: { id: REC, properties: { "알림톡 발송함": rel(BATCH), "등록": rel(R1, R2) } },
		acts: [{ id: "act-1", properties: { "등록": rel(R1) } }, { id: "act-2", properties: { "등록": rel(R2) } }],
		reports: [
			{ id: "rep-1", properties: { "등록": rel(R1), "학습기록": rel("d1"), "학습활동": rel("da1") } },
			{ id: "rep-2", properties: { "등록": rel(R2), "학습기록": rel(REC), "학습활동": rel("act-2") } },
			{ id: "rep-3", properties: { "등록": rel("other"), "학습기록": rel(), "학습활동": rel() } },
		],
	})
	eq(await m.linkRecordToBatchReports(REC), 1)
	eq(calls.updates, [{ id: "rep-1", props: { "학습기록": { relation: [{ id: "d1" }, { id: REC }] }, "학습활동": { relation: [{ id: "da1" }, { id: "act-1" }] } } }])
	// 발송함에 연결되지 않은 기록은 아무것도 하지 않는다.
	const none = mock({ record: { id: REC, properties: { "알림톡 발송함": rel() } } })
	eq(await m.linkRecordToBatchReports(REC), 0)
	eq(none.updates.length, 0)
})

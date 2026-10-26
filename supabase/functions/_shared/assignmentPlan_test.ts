// All network calls are mocked. No live Notion/Supabase writes or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_STUDY_ACTIVITY_ID: "activities", DATA_SOURCE_ATTENDANCE_ID: "attendance", DATA_SOURCE_REGISTRATION_ID: "registrations", DATA_SOURCE_LEARNING_RECORD_ID: "records" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const assertEquals = eq
const assertThrows = (fn: () => unknown) => { try { fn() } catch { return } throw new Error("expected throw") }
const { activityProps, assignmentPlanDeps, planFromText, processAssignmentQueueItem } = await import("./assignmentPlan.ts")

const A1 = "3eeba040586b81e3a977f3fb68b99d2f", R1 = "3ecba040586b8061a932dc4c4869e7a9", D1 = "3edba040586b8171ac98d889d3c1dfa9"
const A2 = "3eeba040586b81d88856f5943119f246", R2 = "3ecba040586b80a0ac75ced1c02928de"
const S = "3eeba040586b817bac7af351f961dc65", REC = "3efba040586b81b2b3dceece99353437"
const dashed = (id: string) => `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`

const planJson = (c: string, items: unknown[]) => JSON.stringify({ v: 1, c, s: S, items })

Deno.test("v2.6.22 학습활동 계획: 수식 값을 읽고, 과제만 마감을 남긴다", () => {
	const p = planFromText(planJson("과제", [{ a: A1, r: R1, d: D1, t: "[과제] 한지민 10.02(금)" }, { a: A2, r: R2, t: "[과제] 임현우 10.02(금)" }]))!
	assertEquals(p.category, "과제")
	assertEquals(p.session, S)
	assertEquals(p.items, [{ att: A1, reg: R1, due: D1, title: "[과제] 한지민 10.02(금)" }, { att: A2, reg: R2, title: "[과제] 임현우 10.02(금)" }])
	assertEquals(planFromText(planJson("학습", [{ a: A1, r: R1, d: D1, t: "x" }]))!.items[0].due, undefined)
	assertEquals(planFromText(JSON.stringify({ v: 1, skip: "구분 없음" }))!.skip, "구분 없음")
	assertEquals(planFromText(""), null)
	assertEquals(planFromText("수식 아님"), null)
	assertThrows(() => planFromText(planJson("기타", [])))
	assertThrows(() => planFromText(planJson("과제", [{ a: "bad", r: R1 }])))
	// 값이 잘려 JSON이 아니면 null → 예전 방식(서버가 직접 읽어 만든다)으로 안전하게 처리
	assertEquals(planFromText('{"v":1,"c":"과제","s":"' + S + '","items":[{"a":"' + A1), null)
})

Deno.test("v2.6.22 학습활동 속성: 과제는 미제출·마감·자동 마감 기준, 평가는 마감 없음", () => {
	const plan = planFromText(planJson("과제", [{ a: A1, r: R1, d: D1, t: "[과제] 한지민 10.02(금)" }]))!
	const props: any = activityProps(REC, plan, plan.items[0])
	assertEquals(props["학습활동"].title[0].text.content, "[과제] 한지민 10.02(금)")
	assertEquals(props["출석"].relation[0].id, A1)
	assertEquals(props["수업"].relation[0].id, S)
	assertEquals(props["과제상태"].select.name, "🔴 미제출")
	assertEquals(props["과제 마감"].relation[0].id, D1)
	assertEquals(props["자동 마감 기준"].relation[0].id, D1)
	const ev = planFromText(planJson("평가", [{ a: A1, r: R1, t: "[평가] 한지민" }]))!
	const evProps: any = activityProps(REC, ev, ev.items[0])
	assertEquals("과제상태" in evProps || "과제 마감" in evProps, false)
})

function fakeDeps(existingRegs: string[]) {
	const calls = { created: [] as any[], done: 0, errors: [] as string[], reads: 0, legacy: 0, updates: [] as any[] }
	const saved = { ...assignmentPlanDeps }
	Object.assign(assignmentPlanDeps, {
		getPage: async () => { calls.reads++; return { properties: {} } },
		createPage: async (_db: string, props: any) => { calls.created.push(props); return { id: "x" } },
		update: async (_id: string, props: any) => { calls.updates.push(props); return {} },
		queryAllPages: async () => existingRegs.map((r) => ({ properties: { 등록: { relation: [{ id: dashed(r) }] } } })),
		markDone: async () => { calls.done++ },
		markError: async (_id: string, m: string) => { calls.errors.push(m) },
		legacy: async () => { calls.legacy++ },
	})
	return { calls, restore: () => Object.assign(assignmentPlanDeps, saved) }
}

Deno.test("v2.6.22 큐: 이미 있는 학생은 건너뛰고 나머지만 만든다(두 번 눌러도 한 번)", async () => {
	const { calls, restore } = fakeDeps([R1])
	try {
		await processAssignmentQueueItem({ recordId: REC, plan: planJson("과제", [{ a: A1, r: R1, d: D1, t: "a" }, { a: A2, r: R2, t: "b" }, { a: A2, r: R2, t: "b" }]) })
		assertEquals(calls.reads, 0) // 본문에 계획이 있으면 학습기록을 읽지 않는다
		assertEquals(calls.created.length, 1)
		assertEquals(calls.created[0]["등록"].relation[0].id, R2)
		assertEquals(calls.done, 1)
	} finally { restore() }
})

Deno.test("v2.6.22 큐: 형식이 틀리면 만들지 않고 ⚠️ 오류, 계획이 없으면 예전 방식", async () => {
	let t = fakeDeps([])
	try {
		await processAssignmentQueueItem({ recordId: REC, plan: planJson("과제", [{ a: "bad", r: R1 }]) })
		assertEquals(t.calls.created.length, 0)
		assertEquals(t.calls.errors.length, 1)
		assertEquals(t.calls.done, 0)
	} finally { t.restore() }
	t = fakeDeps([])
	try {
		await processAssignmentQueueItem({ recordId: REC, plan: null }) // 수식 속성이 없는 운영, 구분도 없음
		assertEquals(t.calls.reads, 1)
		assertEquals(t.calls.created.length, 0)
		assertEquals(t.calls.done, 1)
		assertEquals(t.calls.legacy, 0)
	} finally { t.restore() }
})

Deno.test("v2.6.22 큐: 본문 값이 잘렸으면 학습기록을 한 번 읽어 수식 값으로 만든다", async () => {
	const t = fakeDeps([])
	const full = planJson("평가", [{ a: A1, r: R1, t: "a" }, { a: A2, r: R2, t: "b" }])
	assignmentPlanDeps.getPage = async () => { t.calls.reads++; return { properties: { "학습활동 계획": { type: "formula", formula: { string: full } } } } }
	try {
		await processAssignmentQueueItem({ recordId: REC, plan: full.slice(0, 80) })
		assertEquals(t.calls.reads, 2) // 계획 다시 읽기 + (v2.8.0) 출석 평가의 '평가 구분' 확인
		assertEquals(t.calls.created.length, 2)
		assertEquals(t.calls.legacy, 0)
		assertEquals(t.calls.done, 1)
	} finally { t.restore() }
})

const EVAL_TYPE_SELECT = (name: string | null) => ({ properties: { "평가 구분": { type: "select", select: name ? { name } : null } } })

Deno.test("v2.8.0 학습활동 계획: 출석 없는 평가는 등록만으로 만들고, 다른 구분은 출석이 있어야 한다", () => {
	const p = planFromText(planJson("평가", [{ a: "", r: R1, t: "[평가] 한지민 주간" }, { r: R2, t: "[평가] 임현우 주간" }]))!
	assertEquals(p.items, [{ reg: R1, title: "[평가] 한지민 주간" }, { reg: R2, title: "[평가] 임현우 주간" }])
	const props: any = activityProps(REC, p, p.items[0])
	assertEquals("출석" in props, false)
	assertEquals(props["등록"].relation[0].id, R1)
	assertThrows(() => planFromText(planJson("과제", [{ a: "", r: R1 }])))
	assertThrows(() => planFromText(planJson("학습", [{ r: R1 }])))
	assertThrows(() => planFromText(planJson("평가", [{ a: "bad", r: R1 }])))
	assertThrows(() => planFromText(planJson("평가", [{ a: "", r: "" }])))
})

Deno.test("v2.8.0 큐: 출석 평가는 비어 있는 '평가 구분'을 일일 평가로, 출석 없는 평가·값이 있으면 그대로", async () => {
	let t = fakeDeps([])
	assignmentPlanDeps.getPage = async () => { t.calls.reads++; return EVAL_TYPE_SELECT(null) }
	try {
		await processAssignmentQueueItem({ recordId: REC, plan: planJson("평가", [{ a: A1, r: R1, t: "a" }]) })
		assertEquals(t.calls.created.length, 1)
		assertEquals(t.calls.updates, [{ "평가 구분": { select: { name: "일일 평가" } } }])
		assertEquals(t.calls.done, 1)
	} finally { t.restore() }
	t = fakeDeps([])
	assignmentPlanDeps.getPage = async () => { t.calls.reads++; return EVAL_TYPE_SELECT("주간 평가") }
	try {
		await processAssignmentQueueItem({ recordId: REC, plan: planJson("평가", [{ a: A1, r: R1, t: "a" }]) })
		assertEquals(t.calls.updates.length, 0)
	} finally { t.restore() }
	t = fakeDeps([])
	assignmentPlanDeps.getPage = async () => { t.calls.reads++; return EVAL_TYPE_SELECT(null) }
	try {
		await processAssignmentQueueItem({ recordId: REC, plan: planJson("평가", [{ a: "", r: R1, t: "a" }]) })
		assertEquals(t.calls.created.length, 1)
		assertEquals(t.calls.reads, 0)
		assertEquals(t.calls.updates.length, 0)
	} finally { t.restore() }
	// 칸이 없는 운영(v2.8.0 전)·읽기 실패도 학습활동 생성은 끝난다.
	t = fakeDeps([])
	assignmentPlanDeps.getPage = async () => { throw new Error("read failed") }
	try {
		await processAssignmentQueueItem({ recordId: REC, plan: planJson("평가", [{ a: A1, r: R1, t: "a" }]) })
		assertEquals(t.calls.updates.length, 0)
		assertEquals(t.calls.done, 1)
		assertEquals(t.calls.errors.length, 0)
	} finally { t.restore() }
})

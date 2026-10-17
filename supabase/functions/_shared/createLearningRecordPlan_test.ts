// All network calls are mocked. No live Notion/Supabase writes or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_LEARNING_RECORD_ID: "records" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const { recordPlanDeps, recordPlanFromText, createLearningRecordsFromPlan } = await import("./createLearningRecordTarget.ts")

const SES = "3ecba040586b8044be66db21a8c2c7e9", B1 = "3fc8121f51254cd5a32ee6b8ccf8ca1e", B2 = "7ad0b5a15c67453cbb8ccfd195636733"
const LIB = "11111111222233334444555555555555", SUB = "aaaaaaaabbbbccccddddeeeeeeeeeeee"
const A1 = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1", R1 = "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1"
const plan = (items: unknown[], mk = false) => JSON.stringify({ v: 1, ...(mk ? { mk: 1 } : {}), items })
const item = (b: string, t = "[학습] 쎈(중3 B) 10.17(토)") => ({ b, l: LIB, s: [SUB], a: [A1], r: [R1], t })

function fake(marked: string[]) {
	const calls = { reads: [] as string[], updates: [] as any[], created: [] as any[] }
	const saved = { ...recordPlanDeps }
	Object.assign(recordPlanDeps, {
		getPage: async (id: string) => { calls.reads.push(id); return { id, properties: { "오늘 학습": { type: "checkbox", checkbox: marked.includes(id) } } } },
		update: async (id: string, props: any) => { calls.updates.push({ id, props }) },
		create: async (_db: string, props: any) => { calls.created.push(props); return { id: "rec" } },
	})
	return { calls, restore: () => Object.assign(recordPlanDeps, saved) }
}

Deno.test("v2.6.29 학습기록 계획: 수식 값을 읽고, 형식이 틀리면 오류, JSON이 아니면 null", () => {
	eq(recordPlanFromText(plan([item(B1)], true)), { makeup: true, items: [{ book: B1, lib: LIB, subjects: [SUB], atts: [A1], regs: [R1], title: "[학습] 쎈(중3 B) 10.17(토)" }] })
	eq(recordPlanFromText(plan([{ b: B1, l: "", s: [], a: [], r: [], t: "" }])), { makeup: false, items: [{ book: B1, subjects: [], atts: [], regs: [], title: "[학습]" }] })
	eq(recordPlanFromText(""), null)
	eq(recordPlanFromText("{\"v\":1,\"items\":["), null)
	let threw = false
	try { recordPlanFromText(plan([{ b: "bad" }])) } catch { threw = true }
	eq(threw, true)
	threw = false
	try { recordPlanFromText(plan([{ b: B1, a: ["bad"] }])) } catch { threw = true }
	eq(threw, true)
})

Deno.test("v2.6.29 큐: 오늘 학습이 체크된 교재만 체크 해제 후 학습기록 1개씩(명단·교재 읽기 없음)", async () => {
	const { calls, restore } = fake([B1])
	try {
		await createLearningRecordsFromPlan(SES, recordPlanFromText(plan([item(B1), item(B2)], true))!)
		eq(calls.reads, [B1, B2])
		eq(calls.updates, [{ id: B1, props: { "오늘 학습": { checkbox: false } } }])
		eq(calls.created.length, 1)
		const p = calls.created[0]
		eq(p["학습"].title[0].text.content, "[학습] 쎈(중3 B) 10.17(토)")
		eq(p["진도교재"].relation, [{ id: B1 }])
		eq(p["출석"].relation, [{ id: A1 }])
		eq(p["등록"].relation, [{ id: R1 }])
		eq(p["수업"].relation, [{ id: SES }])
		eq(p["구분"].select.name, "학습")
		eq(p["보강"].checkbox, true)
		eq(p["교재"].relation, [{ id: LIB }])
		eq(p["과목"].relation, [{ id: SUB }])
	} finally { restore() }
})

Deno.test("v2.6.29 큐: 두 번 눌러도(체크가 이미 풀림) 만들지 않고, 교재가 없으면 호출 없음", async () => {
	let t = fake([])
	try {
		await createLearningRecordsFromPlan(SES, recordPlanFromText(plan([item(B1)]))!)
		eq(t.calls.created.length, 0)
		eq(t.calls.updates.length, 0)
	} finally { t.restore() }
	t = fake([])
	try {
		await createLearningRecordsFromPlan(SES, recordPlanFromText(plan([]))!)
		eq(t.calls.reads.length, 0)
	} finally { t.restore() }
})

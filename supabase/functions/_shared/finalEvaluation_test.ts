// All network calls are mocked. No live Notion/Supabase writes or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_LEARNING_RECORD_ID: "records" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const m = await import("./finalEvaluation.ts")
const deps = m.finalEvaluationDeps

const BOOK = "3eeba040586b81e3a977f3fb68b99d2f", LIB = "3efba040586b81b2b3dceece99353437", SUB = "3edba040586b8171ac98d889d3c1dfa9", CLS = "3ecba040586b8047a1eaf3f6e80019df"
const R1 = "3ecba040586b8061a932dc4c4869e7a9", R2 = "3ecba040586b80a0ac75ced1c02928de", R3 = "3ecba040586b80a0ac75ced1c02928df"
const rel = (...ids: string[]) => ({ type: "relation", relation: ids.map((id) => ({ id })), has_more: false })
const reg = (id: string, status: string, cls = CLS) => ({ id, properties: { "수강상태": { type: "formula", formula: { string: status } }, "클래스": rel(cls) } })

type Calls = { created: any[]; enqueued: any[]; marks: string[] }
function mock(pages: Record<string, any>): Calls {
	const calls: Calls = { created: [], enqueued: [], marks: [] }
	Object.assign(deps, {
		getPage: async (id: string) => { if (id in pages) return pages[id]; throw new Error(`unexpected getPage ${id}`) },
		createPage: async (ds: string, props: any) => { calls.created.push({ ds, props }); return { id: "rec-1" } },
		enqueue: async (target: string, payload: any) => { calls.enqueued.push({ target, payload }) },
		today: () => "2026-10-29",
		markRunning: async () => { calls.marks.push("running") },
		markDone: async () => { calls.marks.push("done") },
		markError: async (_id: string, msg: string) => { calls.marks.push(`error:${msg}`) },
	})
	return calls
}
const book = (extra: Record<string, unknown>) => ({ id: BOOK, properties: { "진도교재": { type: "title", title: [{ plain_text: "쎈 공통수학1(고1 A)" }] }, "라이브러리": rel(LIB), "과목": rel(SUB), ...extra } })

Deno.test("v2.9.0 종합 평가: 반 교재는 수강 중 학생 모두로 평가 학습기록 1개 → 학습활동 큐", async () => {
	const c = mock({ [BOOK]: book({ "등록": rel(R1, R2, R3), "클래스": rel(CLS) }), [R1]: reg(R1, "🟢 수강 중"), [R2]: reg(R2, "🟢 수강 중"), [R3]: reg(R3, "🔴 퇴원") })
	await m.processFinalEvaluationQueueItem({ bookId: BOOK })
	eq(c.marks, ["running", "done"])
	const p = c.created[0].props
	eq([c.created[0].ds, p["학습"].title[0].text.content, p["구분"].select.name, p["평가 구분"].select.name, p["평가 기간"].date], ["records", "[종합 평가] 쎈 공통수학1(고1 A)", "평가", "종합 평가", { start: "2026-10-29" }])
	eq([p["등록"].relation.map((r: any) => r.id), p["진도교재"].relation[0].id, p["교재"].relation[0].id, p["과목"].relation[0].id, p["클래스"].relation[0].id], [[R1, R2], BOOK, LIB, SUB, CLS])
	eq(c.enqueued, [{ target: "create-assignment", payload: { recordId: "rec-1", plan: null } }])
})

Deno.test("v2.9.0 종합 평가: 학생 개별교재는 그 학생 한 명, 클래스는 등록에서", async () => {
	const c = mock({ [BOOK]: book({ "등록": rel(R1), "반별교재": rel("3faba040586b8011b3dacfb3f2462efe") }), [R1]: reg(R1, "🟢 수강 중") })
	await m.processFinalEvaluationQueueItem({ bookId: BOOK })
	const p = c.created[0].props
	eq([p["등록"].relation.map((r: any) => r.id), p["클래스"].relation[0].id, c.marks], [[R1], CLS, ["running", "done"]])
})

Deno.test("v2.9.0 종합 평가: 개별 진도 반 교재(템플릿)·수강 중 학생 없음은 만들지 않고 안내", async () => {
	const a = mock({ [BOOK]: book({ "등록": rel(), "개별교재": rel(R2) }) })
	await m.processFinalEvaluationQueueItem({ bookId: BOOK })
	eq([a.created.length, a.marks[1].includes("개별교재")], [0, true])
	const b = mock({ [BOOK]: book({ "등록": rel(R3) }), [R3]: reg(R3, "🔴 퇴원") })
	await m.processFinalEvaluationQueueItem({ bookId: BOOK })
	eq([b.created.length, b.marks[1].includes("수강 중인 학생이 없습니다")], [0, true])
})

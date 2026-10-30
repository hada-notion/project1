// All network calls are mocked. No live Notion/Supabase writes or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_LEARNING_RECORD_ID: "records", DATA_SOURCE_REPORT_ID: "reports", DATA_SOURCE_STUDY_ACTIVITY_ID: "activities" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const m = await import("./completionReport.ts")
const deps = m.completionDeps

const rel = (...ids: string[]) => ({ type: "relation", relation: ids.map((id) => ({ id })), has_more: false })
const title = (s: string) => ({ type: "title", title: [{ plain_text: s }] })
const txt = (s: string) => ({ type: "rich_text", rich_text: s ? [{ plain_text: s }] : [] })
const reg = (id: string, status: string) => ({ id, properties: { "수강상태": { type: "formula", formula: { string: status } }, "클래스": rel("cls"), "학생이름(등록)": { type: "rollup", rollup: { type: "array", array: [{ type: "title", title: [{ plain_text: `학생${id}` }] }] } } } })
const B = "book1", L = "lib1", C = "cls", R1 = "r1", R2 = "r2", R3 = "r3"
const rec = (id: string, day: string) => ({ id, properties: { "수업일": { type: "formula", formula: { type: "date", date: { start: day } } } } })

type Calls = { created: any[]; updates: any[]; enqueued: any[]; marks: string[] }
function mock(pages: Record<string, any>, q: (ds: string, filter: any) => any[] = () => []): Calls {
	const calls: Calls = { created: [], updates: [], enqueued: [], marks: [] }
	Object.assign(deps, {
		getPage: async (id: string) => { if (id in pages) return pages[id]; throw new Error(`unexpected getPage ${id}`) },
		createPage: async (ds: string, props: any) => { calls.created.push({ ds, props }); return { id: `new${calls.created.length}` } },
		queryAllPages: async (ds: string, filter: any) => q(ds, filter),
		query: async () => ({ results: [] }),
		update: async (id: string, props: any) => { calls.updates.push({ id, props }) },
		enqueue: async (target: string, payload: any) => { calls.enqueued.push({ target, payload }) },
		batchDataSourceId: async () => "batches",
		today: () => "2026-10-30",
		markRunning: async () => { calls.marks.push("running") },
		markDone: async () => { calls.marks.push("done") },
		markError: async (_id: string, msg: string) => { calls.marks.push(`error:${msg}`) },
	})
	return calls
}
const base = (): Record<string, any> => ({
	[B]: { id: B, created_time: "2026-09-01T00:00:00Z", properties: { "진도교재": title("수채화 1((테스트) 미술반)"), "주제": txt("기억에 남는 풍경 그리기"), "라이브러리": rel(L), "클래스": rel(C), "등록": rel(R1, R2, R3) } },
	[L]: { id: L, properties: { "교재명": title("수채화 1") } },
	[C]: { id: C, properties: { "클래스명": title("(테스트) 미술반") } },
	[R1]: reg(R1, "🟢 수강 중"), [R2]: reg(R2, "🟢 수강 중"), [R3]: reg(R3, "🔴 퇴원"),
})

Deno.test("v2.8.0 수료: 수강 중 학생마다 큐, 진도교재 완료·수료일, 수료 보고서 발송함(주제 이름·첫 학습일~오늘)", async () => {
	const c = mock(base(), (ds) => ds === "records" ? [rec("x1", "2026-10-20"), rec("x2", "2026-10-01")] : [])
	await m.processCompletionQueueItem({ bookId: B })
	eq(c.updates[0], { id: B, props: { "진행상태": { status: { name: "완료" } }, "수료일": { date: { start: "2026-10-30" } } } })
	const batch = c.created[0].props
	eq([c.created[0].ds, batch["이름"].title[0].text.content, batch["구분"].select.name, batch["기간"].date, batch["진도교재"].relation[0].id], ["batches", "(테스트) 미술반 수료 보고서 기억에 남는 풍경 그리기 10.01~10.30", "수료 보고서", { start: "2026-10-01", end: "2026-10-30" }, B])
	eq(c.enqueued.map((e) => [e.target, e.payload.regId, !!e.payload.last]), [["completion-report", R1, false], ["completion-report", R2, true]])
	eq([c.enqueued[0].payload.start, c.enqueued[0].payload.end, c.enqueued[0].payload.bookName], ["2026-10-01", "2026-10-30", "기억에 남는 풍경 그리기"])
})

Deno.test("v2.8.0 수료: 다시 누르면 발송함·수료일은 그대로, 이미 있는 학생 보고서는 건너뜀", async () => {
	const pages = base()
	pages[B].properties["수료일"] = { type: "date", date: { start: "2026-10-29" } }
	const c = mock(pages, (ds) => ds === "batches" ? [{ id: "batch-old", properties: {} }] : ds === "reports" ? [{ properties: { "등록": rel(R1) } }] : [])
	await m.processCompletionQueueItem({ bookId: B })
	eq([c.created.length, c.updates[0].props["수료일"].date.start, c.enqueued.map((e) => e.payload.regId), c.enqueued[0].payload.batchId], [0, "2026-10-29", [R2], "batch-old"])
})

Deno.test("v2.8.0 수료: 발송함 구분에 \"수료 보고서\" 선택지가 없어 조회가 거절돼도 새 발송함을 만든다", async () => {
	const c = mock(base(), (ds) => {
		if (ds === "batches") throw new Error(`query batches failed: 400 select option "수료 보고서" not found for property "구분"`)
		return []
	})
	await m.processCompletionQueueItem({ bookId: B })
	eq([c.created.length, c.created[0].props["구분"].select.name, c.enqueued.length, c.marks.some((x) => x.startsWith("error"))], [1, "수료 보고서", 2, false])
})

Deno.test("v2.8.0 수료: 학생이 없거나 개별 진도 반 교재면 만들지 않고 안내", async () => {
	const a = base(); a[B].properties["등록"] = rel(); a[B].properties["개별교재"] = rel("ind1")
	const ca = mock(a)
	await m.processCompletionQueueItem({ bookId: B })
	eq([ca.created.length, ca.updates.length, ca.marks[1].includes("개별교재")], [0, 0, true])
	const b = base(); b[B].properties["등록"] = rel(R3)
	const cb = mock(b)
	await m.processCompletionQueueItem({ bookId: B })
	eq([cb.created.length, cb.marks[1].includes("수강 중인 학생이 없습니다")], [0, true])
})

Deno.test("v2.8.0 수료 학생 1건: 이 교재 기록·학습활동·출석만 연결한 수료 보고서, 마지막이면 완료", async () => {
	const pages = base()
	const c = mock(pages, (ds) => {
		if (ds === "records") return [{ id: "rec1", properties: {} }]
		if (ds === "activities") return [
			{ id: "act1", properties: { "학습기록": rel("rec1"), "출석": rel("att1") } },
			{ id: "act-other", properties: { "학습기록": rel("rec-other"), "출석": rel("att9") } },
		]
		return []
	})
	pages[B].properties["마지막 오류"] = txt("")
	await m.processCompletionReportQueueItem({ bookId: B, batchId: "bt", regId: R1, start: "2026-10-01", end: "2026-10-30", bookName: "기억에 남는 풍경 그리기", last: true })
	const p = c.created[0].props
	eq([c.created[0].ds, p["보고서"].title[0].text.content, p["보고서 구분"].select.name, p["보고서 기간"].date, p["진도교재"].relation[0].id], ["reports", "학생r1 수료 보고서 기억에 남는 풍경 그리기", "수료 보고서", { start: "2026-10-01", end: "2026-10-30" }, B])
	eq([p["학습기록"].relation.map((r: any) => r.id), p["학습활동"].relation.map((r: any) => r.id), p["출석"].relation.map((r: any) => r.id), p["일괄전송 선택"].checkbox], [["rec1"], ["act1"], ["att1"], true])
	eq(c.marks, ["done"])
})

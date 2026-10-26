// All network calls are mocked. No live Notion/Supabase writes or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_REGISTRATION_ID: "registrations", DATA_SOURCE_REPORT_ID: "reports", DATA_SOURCE_ATTENDANCE_ID: "attendance", DATA_SOURCE_LEARNING_RECORD_ID: "records", DATA_SOURCE_STUDY_ACTIVITY_ID: "activities", DATA_SOURCE_PROGRESS_BOOK_ID: "books" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const throwsWith = (fn: () => unknown, part: string) => { try { fn() } catch (e) { if (!(e as Error).message.includes(part)) throw new Error(`message ${(e as Error).message}`); return } throw new Error("expected throw") }
const m = await import("./classReportPlan.ts")
const { classReportDeps: deps } = m

const sel = (name: string | null) => ({ type: "select", select: name ? { name } : null })
const range = (start: string | null, end: string | null) => ({ type: "date", date: start ? { start, end } : null })
const title = (s: string) => ({ type: "title", title: [{ plain_text: s }] })
const rel = (...ids: string[]) => ({ type: "relation", relation: ids.map((id) => ({ id })), has_more: false })

Deno.test("v2.8.0 반별 보고서: 클래스 보고서 구분·기간 검사(고칠 곳을 문장으로)", () => {
	const ok = m.reportRequestFromProps({ "보고서 구분": sel("주간 보고서"), "보고서 기간": range("2026-10-19", "2026-10-25"), "클래스명": title("중2 A") })
	eq(ok, { kind: "주간 보고서", start: "2026-10-19", end: "2026-10-25", className: "중2 A" })
	throwsWith(() => m.reportRequestFromProps({ "보고서 구분": sel(null), "보고서 기간": range("2026-10-19", "2026-10-25") }), "보고서 구분")
	throwsWith(() => m.reportRequestFromProps({ "보고서 구분": sel("주간 평가"), "보고서 기간": range("2026-10-19", "2026-10-25") }), "보고서 구분")
	throwsWith(() => m.reportRequestFromProps({ "보고서 구분": sel("월간 보고서"), "보고서 기간": range("2026-10-01", null) }), "종료일")
	throwsWith(() => m.reportRequestFromProps({ "보고서 구분": sel("월간 보고서"), "보고서 기간": range("2026-10-31", "2026-10-01") }), "늦습니다")
	eq(m.batchTitle(ok), "중2 A 주간 보고서 10.19~10.25")
	eq(m.reportTitle(ok, "강민호"), "26.10 강민호 주간 보고서")
	// 시각이 있는 값은 서울 날짜로(UTC 15시 = 서울 다음 날 0시)
	eq(m.seoulDay("2026-10-25T15:00:00.000Z"), "2026-10-26")
	eq(m.seoulDay("2026-10-25T23:30:00+09:00"), "2026-10-25")
})

Deno.test("v2.8.0 반별 보고서: 기간 안에 다니는 등록, 학생 이름", () => {
	const req = { kind: "주간 보고서", start: "2026-10-19", end: "2026-10-25", className: "" }
	const reg = (start: string | null, end: string | null) => ({ properties: { "등록일": range(start, null), "종료일": range(end, null) } })
	eq(m.inPeriodRegistration(reg("2026-10-01", null), req), true)
	eq(m.inPeriodRegistration(reg("2026-10-25", null), req), true)
	eq(m.inPeriodRegistration(reg("2026-10-26", null), req), false)
	eq(m.inPeriodRegistration(reg("2026-09-01", "2026-10-18"), req), false)
	eq(m.inPeriodRegistration(reg("2026-09-01", "2026-10-19"), req), true)
	eq(m.inPeriodRegistration(reg(null, null), req), false)
	eq(m.studentNameOf({ properties: { "학생이름(등록)": { type: "rollup", rollup: { array: [{ type: "title", title: [{ plain_text: "강민호" }] }] } }, "이름": title("강민호 고2 A") } }), "강민호")
	eq(m.studentNameOf({ properties: { "이름": title("강민호 고2 A") } }), "강민호 고2 A")
})

type Calls = { created: any[]; updates: any[]; enqueued: any[]; marks: string[] }
function mock(data: { books?: any[]; batches?: any[]; regs?: any[]; reports?: any[]; atts?: any[]; evals?: any[]; evalActs?: any[]; classError?: string; createFails?: boolean }): Calls {
	const calls: Calls = { created: [], updates: [], enqueued: [], marks: [] }
	Object.assign(deps, {
		batchDataSourceId: async () => "batches",
		queryAllPages: async (ds: string, filter: any) => {
			if (ds === "batches") return data.batches ?? []
			if (ds === "books") return data.books ?? []
			if (ds === "registrations") return data.regs ?? []
			if (ds === "reports") return data.reports ?? []
			if (ds === "attendance") return data.atts ?? []
			if (ds === "records") return data.evals ?? []
			if (ds === "activities") return data.evalActs ?? []
			throw new Error(`unexpected query ${ds} ${JSON.stringify(filter)}`)
		},
		query: async (ds: string) => ({ results: ds === "reports" ? (data.reports ?? []) : [] }),
		getPage: async (id: string) => id === "cls" ? { id, properties: { "마지막 오류": { type: "rich_text", rich_text: data.classError ? [{ plain_text: data.classError }] : [] } } } : { id, properties: { "이름": title(`학생-${id}`) } },
		createPage: async (ds: string, props: any) => { if (data.createFails) throw new Error("create failed: 502"); calls.created.push({ ds, props }); return { id: `new-${calls.created.length}` } },
		update: async (id: string, props: any) => { calls.updates.push({ id, props }) },
		fullRelationIds: async (page: any, name: string) => (page.properties?.[name]?.relation ?? []).map((r: any) => r.id),
		enqueue: async (target: string, payload: any) => { calls.enqueued.push({ target, payload }) },
		markRunning: async (id: string) => { calls.marks.push(`running:${id}`) },
		markDone: async (id: string) => { calls.marks.push(`done:${id}`) },
		markError: async (id: string, msg: string) => { calls.marks.push(`error:${id}:${msg}`) },
	})
	return calls
}

const P = { classId: "cls", kind: "주간 보고서", start: "2026-10-19", end: "2026-10-25", className: "중2 A" }
const regPage = (id: string, start: string, end: string | null = null) => ({ id, properties: { "등록일": range(start, null), "종료일": range(end, null) } })

Deno.test("v2.8.0 반별 보고서: 같은 반·구분·기간 발송함을 다시 쓰고, 보고서 없는 기간 안 학생만 큐에 넣는다", async () => {
	const calls = mock({
		batches: [
			{ id: "b-old", properties: { "기간": range("2026-10-12", "2026-10-18") } },
			{ id: "b-same", properties: { "기간": range("2026-10-19", "2026-10-25"), "진도교재": rel("bk0") } },
		],
		books: [{ id: "bk0" }, { id: "bk1" }],
		regs: [regPage("r1", "2026-09-01"), regPage("r2", "2026-09-01"), regPage("r3", "2026-10-27"), regPage("r4", "2026-09-01", "2026-10-10")],
		reports: [{ id: "rep", properties: { "등록": rel("r2") } }],
	})
	await m.processClassReportsQueueItem(P)
	eq(calls.created.length, 0)
	// (v2.8.0) 반의 진행 중 진도교재를 발송함에 더한다(이미 있던 bk0은 그대로, bk1만 추가).
	eq(calls.updates, [
		{ id: "b-same", props: { "진도교재": { relation: [{ id: "bk0" }, { id: "bk1" }] } } },
		{ id: "cls", props: { "보고서 생성 대상": { relation: [{ id: "b-same" }] } } },
	])
	eq(calls.enqueued, [{ target: "registration-report", payload: { ...P, batchId: "b-same", regId: "r1", last: true } }])
	eq(calls.marks, ["running:cls"])
})

Deno.test("v2.8.0 반별 보고서: 발송함이 없으면 반·구분·기간으로 만들고, 만들 학생이 없으면 바로 완료", async () => {
	const calls = mock({ batches: [], regs: [regPage("r3", "2026-10-27")] })
	await m.processClassReportsQueueItem(P)
	eq(calls.created, [{ ds: "batches", props: {
		"이름": { title: [{ text: { content: "중2 A 주간 보고서 10.19~10.25" } }] },
		"구분": { select: { name: "주간 보고서" } },
		"기간": { date: { start: "2026-10-19", end: "2026-10-25" } },
		"클래스": { relation: [{ id: "cls" }] },
	} }])
	eq(calls.updates[0].props["보고서 생성 대상"].relation[0].id, "new-1")
	eq(calls.enqueued.length, 0)
	eq(calls.marks, ["running:cls", "done:cls"])
})

Deno.test("v2.8.0 반별 보고서: 학생 1건은 기간 안 출석(서울 날짜)·그 기록·출석 없는 평가로 보고서를 만들고, 마지막이면 반을 완료", async () => {
	const calls = mock({
		atts: [
			{ id: "a-in", properties: { "수업일시": range("2026-10-21T16:00:00+09:00", null), "학습기록": rel("rec1"), "학습활동": rel("act1", "act2") } },
			{ id: "a-before", properties: { "수업일시": range("2026-10-18T23:30:00+09:00", null), "학습기록": rel("rec0"), "학습활동": rel("act0") } },
			{ id: "a-after", properties: { "수업일시": range("2026-10-25T15:30:00.000Z", null), "학습기록": rel("rec9"), "학습활동": rel("act9") } },
		],
		evals: [
			{ id: "ev-week", properties: { "평가 기간": range("2026-10-19", "2026-10-25") } },
			{ id: "ev-last", properties: { "평가 기간": range("2026-10-12", "2026-10-18") } },
		],
		evalActs: [{ id: "ev-act" }],
	})
	await m.processRegistrationReportQueueItem({ ...P, batchId: "b1", regId: "r1", last: true })
	eq(calls.created.length, 1)
	const props = calls.created[0].props
	eq(calls.created[0].ds, "reports")
	eq(props["보고서"].title[0].text.content, "26.10 학생-r1 주간 보고서")
	eq(props["보고서 기간"].date, { start: "2026-10-19", end: "2026-10-25" })
	eq(props["보고서 구분"].select.name, "주간 보고서")
	eq(props["등록"].relation, [{ id: "r1" }])
	eq(props["알림톡 발송함"].relation, [{ id: "b1" }])
	eq(props["일괄전송 선택"].checkbox, true)
	eq(props["출석"].relation, [{ id: "a-in" }])
	eq(props["학습기록"].relation, [{ id: "rec1" }, { id: "ev-week" }])
	eq(props["학습활동"].relation, [{ id: "act1" }, { id: "act2" }, { id: "ev-act" }])
	eq(calls.marks, ["done:cls"])
})

Deno.test("v2.8.0 반별 보고서: 이 등록·이 발송함 보고서가 있으면 건너뛰고, 중간 실패가 남아 있으면 반은 ⚠️ 오류", async () => {
	const calls = mock({ reports: [{ id: "rep" }], classError: "보고서 생성 실패(다시 누르면 빠진 학생만 만듭니다): x" })
	await m.processRegistrationReportQueueItem({ ...P, batchId: "b1", regId: "r1", last: true })
	eq(calls.created.length, 0)
	eq(calls.marks, ["error:cls:보고서 생성 실패(다시 누르면 빠진 학생만 만듭니다): x"])
})

Deno.test("v2.8.0 반별 보고서: 학생 1건이 실패하면 반 '마지막 오류'에 남기고 큐가 다시 하도록 던진다(마지막이 아니면 상태는 그대로)", async () => {
	const calls = mock({ createFails: true })
	let thrown = false
	try { await m.processRegistrationReportQueueItem({ ...P, batchId: "b1", regId: "r1" }) } catch { thrown = true }
	eq(thrown, true)
	eq(calls.updates.length, 1)
	eq(calls.updates[0].id, "cls")
	eq(calls.marks, [])
})

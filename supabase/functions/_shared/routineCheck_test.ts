// All network calls are mocked. No live Notion/Supabase writes or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_CLASS_SESSION_ID: "sessions", DATA_SOURCE_REGISTRATION_ID: "registrations" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const m = await import("./routineCheck.ts")
const deps = m.routineCheckDeps

const rel = (...ids: string[]) => ({ type: "relation", relation: ids.map((id) => ({ id })), has_more: false })
const title = (s: string) => ({ type: "title", title: [{ plain_text: s }] })
const S = "s1", C = "c1", R1 = "r1", R2 = "r2", R3 = "r3", A1 = "a1", A2 = "a2", G1 = "g1", G2 = "g2"
const routine = (id: string, name: string, order: number, rest = false) => ({ id, properties: { "이름": title(name), "순서": { type: "number", number: order }, "쉬기": { type: "checkbox", checkbox: rest } } })

function mock(pages: Record<string, any>, existing: any[] = []) {
	const calls = { created: [] as any[], marks: [] as string[] }
	Object.assign(deps, {
		getPage: async (id: string) => { if (id in pages) return pages[id]; throw new Error(`unexpected ${id}`) },
		fullRelationIds: async (page: any, prop: string) => (page.properties?.[prop]?.relation ?? []).map((r: any) => r.id),
		checkDs: async () => "checks",
		queryAllPages: async () => existing,
		createPage: async (ds: string, props: any) => { calls.created.push({ ds, props }); return { id: `n${calls.created.length}` } },
		markRunning: async () => { calls.marks.push("running") },
		markDone: async () => { calls.marks.push("done") },
		markError: async (_id: string, msg: string) => { calls.marks.push(`error:${msg}`) },
	})
	return calls
}
const base = () => ({
	[S]: { id: S, properties: { "클래스": rel(C), "출석": rel(A1, A2) } },
	[C]: { id: C, properties: { "루틴": rel(R2, R1, R3) } },
	[R1]: routine(R1, "단어 암기", 1), [R2]: routine(R2, "일기", 2), [R3]: routine(R3, "연산 연습", 3, true),
	[A1]: { id: A1, properties: { "출석": title("강하을 10.30(금)"), "등록": rel(G1) } },
	[A2]: { id: A2, properties: { "출석": title("이서윤 10.30(금)"), "등록": rel(G2) } },
})

Deno.test("v2.8.0 루틴: 반 루틴(쉬기 제외, 순서대로) × 출석마다 체크 행", async () => {
	const c = mock(base())
	await m.processRoutineChecksQueueItem({ sessionId: S })
	eq(c.marks, ["running", "done"])
	eq(c.created.map((x) => x.props["이름"].title[0].text.content), ["단어 암기 · 강하을 10.30(금)", "일기 · 강하을 10.30(금)", "단어 암기 · 이서윤 10.30(금)", "일기 · 이서윤 10.30(금)"])
	const p = c.created[0].props
	eq([c.created[0].ds, p["루틴"].relation[0].id, p["출석"].relation[0].id, p["수업"].relation[0].id, p["등록"].relation[0].id, p["했음"].checkbox], ["checks", R1, A1, S, G1, false])
})

Deno.test("v2.8.0 루틴: 이미 있는 (출석, 루틴)은 건너뛴다(두 번 눌러도 빠진 것만)", async () => {
	const have = { properties: { "출석": rel(A1), "루틴": rel(R1) } }
	const c = mock(base(), [have])
	await m.processRoutineChecksQueueItem({ sessionId: S })
	eq(c.created.length, 3)
})

Deno.test("v2.8.0 루틴: 루틴이 없거나 출석이 없으면 만들지 않고 안내", async () => {
	const a = base(); a[C].properties["루틴"] = rel(R3)
	const ca = mock(a)
	await m.processRoutineChecksQueueItem({ sessionId: S })
	eq([ca.created.length, ca.marks[1].includes("쓰는 루틴이 없습니다")], [0, true])
	const b = base(); b[S].properties["출석"] = rel()
	const cb = mock(b)
	await m.processRoutineChecksQueueItem({ sessionId: S })
	eq([cb.created.length, cb.marks[1].includes("출석이 없습니다")], [0, true])
})

Deno.test("v2.8.0 루틴 리포트: 등록의 체크 → 이름·날짜(출석 수업일시, 없으면 수업)·했음, DB 없으면 빈 목록", async () => {
	const rows = [
		{ properties: { "루틴": rel(R1), "출석": rel(A1), "수업": rel(S), "했음": { checkbox: true } } },
		{ properties: { "루틴": rel(R2), "출석": rel("gone"), "수업": rel(S), "했음": { checkbox: false } } },
		{ in_trash: true, properties: { "루틴": rel(R1), "출석": rel(A1), "했음": { checkbox: true } } },
	]
	const pages: Record<string, any> = { [R1]: routine(R1, "단어 암기", 1), [R2]: routine(R2, "일기", 2), [S]: { id: S, properties: { "수업일시": { date: { start: "2026-10-29T16:00:00+09:00" } } } } }
	const get = async (id: string) => pages[id]
	const toDay = (iso: string | null) => (iso ? iso.slice(0, 10) : null)
	const out = await m.routineRowsForRegistration("g1", get, new Map([[A1, "2026-10-30T16:00:00+09:00"]]), toDay, { checkDs: async () => "checks", queryAllPages: async () => rows })
	eq(out, [{ name: "일기", date: "2026-10-29", done: false }, { name: "단어 암기", date: "2026-10-30", done: true }])
	eq(await m.routineRowsForRegistration("g1", get, new Map(), toDay, { checkDs: async () => null, queryAllPages: async () => rows }), [])
})

Deno.test("v2.8.0 루틴 일일 보고서: 출석의 체크 → 루틴 순서대로 이름·했음, 칸이 없으면 빈 목록", async () => {
	const att = { properties: { "루틴 체크": rel("k1", "k2") } }
	const pages: Record<string, any> = {
		k1: { properties: { "루틴": rel(R2), "했음": { checkbox: false } } },
		k2: { properties: { "루틴": rel(R1), "했음": { checkbox: true } } },
		[R1]: routine(R1, "단어 암기", 1), [R2]: routine(R2, "영어 일기", 2),
	}
	const d = { getPage: async (id: string) => pages[id], fullRelationIds: async (p: any, prop: string) => (p.properties?.[prop]?.relation ?? []).map((r: any) => r.id) } as any
	eq(await m.routineItemsForAttendance(att, d), [{ name: "단어 암기", done: true }, { name: "영어 일기", done: false }])
	eq(await m.routineItemsForAttendance({ properties: {} }, d), [])
})

Deno.test("v2.8.0 루틴 일일 보고서 #{학습내용} 대체 값: 시안 A 구역(빈 줄로 띄움), 결석이면 붙이지 않음, 루틴만 있으면 구역만", async () => {
	const b = await import("./noticeBlocks.ts")
	const items = [{ name: "단어 암기", done: true }, { name: "영어 일기", done: false }]
	eq(b.studyWithRoutines("📐 수학\nRPM (p.34~41)", "출석", items), "📐 수학\nRPM (p.34~41)\n\n☑️ 루틴\n  • 단어 암기  했어요\n  • 영어 일기  안 했어요")
	eq(b.studyContentOrDefault(b.studyWithRoutines("", "결석", items), "결석"), "결석으로 이날 학습 기록이 없습니다.")
	eq(b.studyWithRoutines("", "출석", items), "☑️ 루틴\n  • 단어 암기  했어요\n  • 영어 일기  안 했어요")
	eq(b.studyWithRoutines("📐 수학", "출석", []), "📐 수학")
})

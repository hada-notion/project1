// All network calls are mocked. No live Notion/Solapi/Supabase calls or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const m = await import("./timetableNotice.ts")
const { timetableNoticeDeps: deps } = m

const rt = (s: string) => ({ type: "rich_text", rich_text: s ? [{ plain_text: s }] : [] })
const tt = (id: string, day: string, start: string, end: string, cls = "cls-1") => ({
	id,
	properties: { "요일": { type: "select", select: { name: day } }, "등원시간(HH:mm)": rt(start), "하원시간(HH:mm)": rt(end), "클래스": { type: "relation", relation: [{ id: cls }] } },
})
const reg = (o: { sent?: string; tts?: string[]; status?: string } = {}) => ({
	id: "reg-1",
	properties: {
		"학생이름(등록)": { type: "rollup", rollup: { array: [{ title: [{ plain_text: "김하윤" }] }] } },
		"시간표": { type: "relation", relation: (o.tts ?? ["t1", "t2"]).map((id) => ({ id })) },
		"안내한 시간표": rt(o.sent ?? ""),
		"수강상태": { type: "formula", formula: { string: o.status ?? "🟢 수강 중" } },
	},
})
const cls = (o: { apply?: string; memo?: string; error?: string } = {}) => ({
	id: "cls-1",
	properties: {
		"클래스명": { type: "title", title: [{ plain_text: "중1 A 수학" }] },
		"시간표 적용일": { type: "date", date: o.apply ? { start: o.apply } : null },
		"시간표 안내 메모": rt(o.memo ?? ""),
		"마지막 오류": rt(o.error ?? ""),
	},
})

Deno.test("v2.8.0 시간표 변경 안내: 시간표 글자는 요일 순, 같은 시각끼리 묶음", () => {
	eq(m.timetableText([{ day: "수", start: "16:00", end: "18:00" }, { day: "월", start: "16:00", end: "18:00" }]), "월·수 16:00~18:00")
	eq(m.timetableText([{ day: "수", start: "17:00", end: "19:00" }, { day: "월", start: "16:00", end: "18:00" }]), "월 16:00~18:00 / 수 17:00~19:00")
	eq(m.timetableText([{ day: "토", start: "10:00", end: "" }, { day: "토", start: "10:00", end: "" }]), "토 10:00")
	eq(m.timetableText([]), "")
})

Deno.test("v2.8.0 시간표 변경 안내: 블록은 기존(있고 다를 때)·변경·적용일(있을 때)", () => {
	eq(m.timetableInfoBlock({ after: "화·목 17:00~19:00" }), "🕒 변경  화·목 17:00~19:00")
	eq(m.timetableInfoBlock({ before: "월·수 16:00~18:00", after: "화·목 17:00~19:00", applyOn: "11.03(화)" }), "🔁 기존  월·수 16:00~18:00\n🕒 변경  화·목 17:00~19:00\n📅 적용  11.03(화)부터")
	eq(m.shortDay("2026-11-03"), "11.03(화)")
	eq(m.shortDay(""), "")
})

Deno.test("v2.8.0 시간표 변경 안내: 계획 — 변수, 이미 안내한 학생 건너뛰기, 시간표 없음", () => {
	const tts = [tt("t1", "화", "17:00", "19:00"), tt("t2", "목", "17:00", "19:00")]
	const p: any = m.planTimetableNotice(reg({ sent: "월·수 16:00~18:00" }), tts, cls({ apply: "2026-11-03", memo: "새 시간표로 안내드립니다." }))
	eq(p.now, "화·목 17:00~19:00")
	eq(p.variables, {
		"#{학생이름}": "김하윤",
		"#{클래스}": "중1 A 수학",
		"#{시간표정보}": "🔁 기존  월·수 16:00~18:00\n🕒 변경  화·목 17:00~19:00\n📅 적용  11.03(화)부터",
		"#{전달사항}": "새 시간표로 안내드립니다.",
	})
	eq(m.planTimetableNotice(reg({ sent: "화·목 17:00~19:00" }), tts, cls()), { skip: "" })
	eq(m.planTimetableNotice(reg({ tts: [] }), [], cls()), { skip: "등록에 연결된 시간표가 없습니다." })
	const first: any = m.planTimetableNotice(reg(), tts, cls())
	eq([first.variables["#{시간표정보}"], first.variables["#{전달사항}"]], ["🕒 변경  화·목 17:00~19:00", "없음"])
})

Deno.test("v2.8.0 시간표 변경 안내: 수강 중 판단(수식 우선, 없으면 종료일)", () => {
	eq(m.activeRegistration(reg(), "2026-10-31"), true)
	eq(m.activeRegistration(reg({ status: "⚫ 종료" }), "2026-10-31"), false)
	eq(m.activeRegistration({ properties: { "종료일": { date: { start: "2026-10-01" } } } }, "2026-10-31"), false)
	eq(m.activeRegistration({ properties: {} }, "2026-10-31"), true)
	eq(m.activeRegistration({ in_trash: true, properties: {} }, "2026-10-31"), false)
})

Deno.test("v2.8.0 시간표 변경 안내: 학생 1건 — 보내고 안내한 시간표를 적고, 마지막이면 반 ✅ 완료", async () => {
	const saved = { ...deps }
	const pages: Record<string, any> = { "reg-1": reg({ sent: "월·수 16:00~18:00" }), "cls-1": cls({ apply: "2026-11-03" }), t1: tt("t1", "화", "17:00", "19:00"), t2: tt("t2", "목", "17:00", "19:00", "other-class") }
	const sent: any[] = [], updates: any[] = [], logs: any[] = [], marks: string[] = []
	Object.assign(deps, {
		getPage: async (id: string) => pages[id],
		send: async (...a: any[]) => { sent.push(a); return [] },
		log: async (a: any) => { logs.push(a) },
		update: async (id: string, props: any) => { updates.push([id, props]) },
		botUser: async () => "bot",
		markDone: async (id: string) => { marks.push("done:" + id) },
		markError: async (id: string, msg: string) => { marks.push("error:" + id + ":" + msg) },
	})
	try {
		await m.processTimetableNoticeQueueItem({ classId: "cls-1", regId: "reg-1", last: true })
		// 다른 반 시간표(t2)는 빼고 이 반 것만
		eq(sent[0][0], "시간표 변경 안내")
		eq(sent[0][3]["#{시간표정보}"], "🔁 기존  월·수 16:00~18:00\n🕒 변경  화 17:00~19:00\n📅 적용  11.03(화)부터")
		eq(logs.map((l) => [l.category, l.status]), [["시간표 변경 안내", "성공"]])
		eq(updates, [["reg-1", { "안내한 시간표": { rich_text: [{ text: { content: "화 17:00~19:00" } }] } }]])
		eq(marks, ["done:cls-1"])
	} finally {
		Object.assign(deps, saved)
	}
})

Deno.test("v2.8.0 시간표 변경 안내: 발송 실패는 반 마지막 오류에 모으고 마지막에 ⚠️", async () => {
	const saved = { ...deps }
	const pages: Record<string, any> = { "reg-1": reg(), "cls-1": cls(), t1: tt("t1", "화", "17:00", "19:00"), t2: tt("t2", "목", "17:00", "19:00") }
	const marks: string[] = []
	Object.assign(deps, {
		getPage: async (id: string) => pages[id],
		send: async () => { throw new Error("연락처 오류: 우선 연락처가 비어 있습니다.") },
		log: async () => { throw new Error("should not log config errors") },
		update: async (id: string, props: any) => { if (id === "cls-1") pages["cls-1"] = cls({ error: props["마지막 오류"].rich_text[0]?.text?.content ?? "" }) },
		botUser: async () => "bot",
		markDone: async (id: string) => { marks.push("done:" + id) },
		markError: async (id: string, msg: string) => { marks.push("error:" + msg) },
	})
	try {
		await m.processTimetableNoticeQueueItem({ classId: "cls-1", regId: "reg-1", last: true })
		eq(marks, ["error:김하윤: 연락처 오류: 우선 연락처가 비어 있습니다."])
	} finally {
		Object.assign(deps, saved)
	}
})

Deno.test("v2.8.0 시간표 변경 안내: 반 1건 — 수강 중 학생만 넣고 마지막 표시, 없으면 ⚠️", async () => {
	const saved = { ...deps }
	const queued: any[] = [], marks: string[] = []
	Object.assign(deps, {
		markRunning: async () => {},
		update: async () => {},
		today: () => "2026-10-31",
		queryAllPages: async () => [{ ...reg(), id: "r1" }, { ...reg({ status: "⚫ 종료" }), id: "r2" }, { ...reg(), id: "r3" }],
		enqueue: async (target: string, p: any) => { queued.push([target, p.regId, p.last ?? false]) },
		markError: async (_id: string, msg: string) => { marks.push(msg) },
	})
	try {
		await m.processClassTimetableNoticeQueueItem({ classId: "cls-1" })
		eq(queued, [["timetable-notice", "r1", false], ["timetable-notice", "r3", true]])
		deps.queryAllPages = async () => []
		await m.processClassTimetableNoticeQueueItem({ classId: "cls-1" })
		eq(marks, ["이 반에 수강 중인 학생이 없습니다."])
	} finally {
		Object.assign(deps, saved)
	}
})

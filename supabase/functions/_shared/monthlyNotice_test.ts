// All network calls are mocked. No live Notion/Solapi/Supabase calls or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_REGISTRATION_ID: "registrations", DATA_SOURCE_SCHEDULE_EVENT_ID: "events", DATA_SOURCE_TUITION_ID: "tuitions", REPORT_PATH: "/r.html" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const m = await import("./monthlyNotice.ts")
const { monthlyDeps: deps } = m
const { LessonConfigError } = await import("./lessonNotice.ts")

const rel = (...ids: string[]) => ({ type: "relation", relation: ids.map((id) => ({ id })), has_more: false })
const title = (s: string) => ({ type: "title", title: [{ plain_text: s }] })
const rt = (s: string) => ({ type: "rich_text", rich_text: s ? [{ plain_text: s }] : [] })
const date = (start: string | null, end: string | null = null) => ({ type: "date", date: start ? { start, end } : null })
const fx = (s: string) => ({ type: "formula", formula: { type: "string", string: s } })
const fn = (n: number) => ({ type: "formula", formula: { type: "number", number: n } })
const roll = (s: string) => ({ type: "rollup", rollup: { type: "array", array: [{ type: "rich_text", rich_text: [{ plain_text: s }] }] } })
const reg = (id: string, o: { student: string; name: string; cls: string; clsName: string; since?: string; until?: string }) => ({ id, properties: {
	"학생정보": rel(o.student), "클래스": rel(o.cls), "등록일": date(o.since ?? "2026-03-02"), "종료일": date(o.until ?? null),
	"학생이름(등록)": { type: "rollup", rollup: { array: [{ type: "title", title: [{ plain_text: o.name }] }] } }, "클래스명(등록)": roll(o.clsName),
} })
const ev = (id: string, o: { name: string; cat?: string; start: string; end?: string; cls?: string[]; stu?: string[]; school?: string[]; grade?: string[] }) => ({ id, properties: {
	"이름": title(o.name), "구분": { type: "select", select: { name: o.cat ?? "📆 학원 일정" } }, "날짜": date(o.start, o.end ?? null),
	"학부모 공개": { type: "checkbox", checkbox: true }, "숨김": { type: "checkbox", checkbox: false },
	"클래스": rel(...(o.cls ?? [])), "학생": rel(...(o.stu ?? [])), "학교": rel(...(o.school ?? [])), "학년": rel(...(o.grade ?? [])),
} })
const letter = (id: string, o: { student?: string; tuitions?: string[]; tuitionSent?: string; scheduleSent?: string; pickTuition?: boolean; pickSchedule?: boolean; name?: string } = {}) => ({ id, properties: {
	"이름": title(o.name ?? "26.12 이도윤 가정통신문"), "기간": date("2026-12-01", "2026-12-31"),
	"학생": rel(...(o.student ? [o.student] : [])), "수강료": rel(...(o.tuitions ?? [])), "발송함": rel(), "마지막 오류": rt(""),
	"수강료 안내 일시": date(o.tuitionSent ?? null), "일정 안내 일시": date(o.scheduleSent ?? null),
	"수강료 전송 선택": { type: "checkbox", checkbox: o.pickTuition ?? true }, "일정 전송 선택": { type: "checkbox", checkbox: o.pickSchedule ?? true },
} })
const mailbox = (id: string, o: { kind?: string; cls?: string; letters?: string[] } = {}) => ({ id, properties: {
	"이름": title("26.12 중1 A 가정통신문"), "구분": { type: "select", select: { name: o.kind ?? "가정통신문" } }, "기간": date("2026-12-01", "2026-12-31"),
	"클래스": rel(...(o.cls ? [o.cls] : [])), "가정통신문": rel(...(o.letters ?? [])), "마지막 오류": rt(""),
} })
const tuition = (id: string, regId: string, clsName: string, amount: number) => ({ id, properties: {
	"등록": rel(regId), "청구기간": date("2026-12-01", "2026-12-31"), "클래스(수강료)": roll(clsName), "청구금액": fn(amount),
	"청구금액(표시)": fx(`${amount.toLocaleString("en-US")}원`), "학생정보": fx("이도윤"), "청구년월(보고서)": fx("12월"), "학부모 연락처": roll("010-0000-0000"), "알림톡 발송함": rel(),
} })

type Calls = { enq: any[]; created: any[]; updates: any[]; sends: any[]; logs: any[]; marks: string[] }
function mock(pages: Record<string, any>, q: (ds: string, filter: any) => any[] = () => [], o: { sendThrows?: Error } = {}): Calls {
	const c: Calls = { enq: [], created: [], updates: [], sends: [], logs: [], marks: [] }
	let n = 0
	Object.assign(deps, {
		getPage: async (id: string) => { if (!(id in pages)) throw new Error(`unexpected page ${id}`); return pages[id] },
		createPage: async (ds: string, props: any) => { const id = `new${++n}`; c.created.push({ ds, props }); pages[id] = { id, properties: props }; return pages[id] },
		queryAllPages: async (ds: string, filter: any) => q(ds, filter),
		// 쓴 값을 페이지에 반영한다(다른 발송함에서 다시 읽을 때 보낸 일시·체크가 보이게).
		update: async (id: string, props: any) => {
			c.updates.push({ id, props })
			if (!pages[id]) return
			for (const [k, v] of Object.entries<any>(props)) pages[id].properties[k] = v?.rich_text ? { type: "rich_text", rich_text: v.rich_text.map((t: any) => ({ plain_text: t.text.content })) } : v
		},
		fullRelationIds: async (page: any, name: string) => (page.properties?.[name]?.relation ?? []).map((r: any) => r.id),
		enqueue: async (target: string, payload: any) => { c.enq.push({ target, payload }) },
		batchDataSourceId: async () => "batches",
		letterDataSourceId: async () => "letters",
		config: async () => ({ pfId: "pf", templateId: "tpl", senderNumber: "", notice: "계좌번호\n하다은행", recipientTarget: "우선 연락 대상" }),
		tuitionConfigRow: async () => "cfg-row",
		send: async (code: string, regId: string, phone: string, vars: any) => { if (o.sendThrows) throw o.sendThrows; c.sends.push({ code, regId, phone, vars }) },
		log: async (a: any) => { c.logs.push({ cat: a.category, status: a.status, reg: a.registrationId, tuition: a.tuitionId }) },
		botUser: async () => null,
		token: async () => "tok",
		today: () => "2026-11-28",
		markRunning: async (id: string) => { c.marks.push(`running:${id}`) },
		markDone: async (id: string) => { c.marks.push(`done:${id}`) },
		markError: async (id: string, _spec: any, msg: string) => { c.marks.push(`error:${id}:${msg}`) },
	})
	return c
}
const relFilter = (filter: any) => {
	const f = filter?.relation ? filter : filter?.and?.find((x: any) => x.relation)
	return f ? `${f.property}:${f.relation.contains}` : ""
}

Deno.test("v2.8.0 가정통신문: 달 범위·이름", () => {
	eq(m.monthRange("2026-12"), { start: "2026-12-01", end: "2026-12-31" })
	eq(m.monthRange("2027-02"), { start: "2027-02-01", end: "2027-02-28" })
	eq(m.letterTitle("2026-12", "이도윤"), "26.12 이도윤 가정통신문")
	eq(m.mailboxTitle("2026-12", "중1 A 수학"), "26.12 중1 A 수학 가정통신문")
	eq(m.tuitionTitle("2026-12", "이도윤"), "26.12 이도윤 수강료")
	// 클래스 '안내 기간': 비면 다음 달, 있으면 시작일의 달, 두 달에 걸치면 고칠 곳을 알림
	eq(m.monthFromClass({ properties: {} }, new Date("2026-11-27T03:00:00Z")), "2026-12")
	eq(m.monthFromClass({ properties: { "안내 기간": date("2026-11-01", "2026-11-30") } }), "2026-11")
	let msg = ""
	try { m.monthFromClass({ properties: { "안내 기간": date("2026-11-20", "2026-12-05") } }) } catch (e) { msg = (e as Error).message }
	eq(msg.includes("한 달 안"), true)
})

Deno.test("v2.8.0 [월 수강료 생성]: 월간 수업 총량이 없으면 ⚠️, 반 수강료 발송함을 찾거나 만들어 클래스에 잇고 그 달 다니는 등록마다 큐", async () => {
	const c0 = mock({ cls: { id: "cls", properties: { "월간 수업 총량": { type: "number", number: null } } } })
	await m.processMonthlyCreateClassItem({ classId: "cls", month: "2026-12" })
	eq(c0.marks[1].includes("월간 수업 총량"), true)
	const regs = [
		reg("r1", { student: "s1", name: "이도윤", cls: "cls", clsName: "중1 A 수학" }),
		reg("r2", { student: "s2", name: "박서준", cls: "cls", clsName: "중1 A 수학", until: "2026-11-20" }), // 11월에 끝남
		reg("r3", { student: "s3", name: "김하윤", cls: "cls", clsName: "중1 A 수학", since: "2026-12-15" }),
	]
	const cls = { id: "cls", properties: { "클래스명": title("중1 A 수학"), "월간 수업 총량": { type: "number", number: 8 }, "수강료 생성 대상": rel() } }
	let boxes: any[] = []
	const c = mock({ cls }, (ds, filter) => ds === "registrations" ? regs : ds === "batches" ? (JSON.stringify(filter).includes("수강료") ? boxes : []) : [])
	await m.processMonthlyCreateClassItem({ classId: "cls", month: "2026-12" })
	eq(c.created.map((x) => [x.ds, x.props["이름"].title[0].text.content, x.props["구분"].select.name, x.props["기간"].date, x.props["클래스"].relation]), [["batches", "26.12 중1 A 수학 수강료", "수강료", { start: "2026-12-01", end: "2026-12-31" }, [{ id: "cls" }]]])
	eq(c.updates[0], { id: "cls", props: { "수강료 생성 대상": { relation: [{ id: "new1" }] } } })
	eq(c.enq.map((e) => [e.target, e.payload.regId, e.payload.amount, e.payload.mailboxId, e.payload.last ?? false]), [["monthly-create-reg", "r1", 8, "new1", false], ["monthly-create-reg", "r3", 8, "new1", true]])
	// 다시 누르면 같은 달 수강료 발송함을 쓴다(다른 달 발송함은 무시, 이미 이어져 있으면 클래스를 다시 쓰지 않음).
	boxes = [{ id: "box-nov", properties: { "기간": date("2026-11-01", "2026-11-30") } }, { id: "box-dec", properties: { "기간": date("2026-12-01", "2026-12-31") } }]
	const cls2 = { id: "cls", properties: { ...cls.properties, "수강료 생성 대상": rel("box-dec") } }
	const c2 = mock({ cls: cls2 }, (ds, filter) => ds === "registrations" ? regs : ds === "batches" ? (JSON.stringify(filter).includes("수강료") ? boxes : []) : [])
	await m.processMonthlyCreateClassItem({ classId: "cls", month: "2026-12" })
	eq([c2.created.length, c2.updates.length, c2.enq[0].payload.mailboxId], [0, 0, "box-dec"])
	// 대상 달은 클래스 '수강료 기간'(비면 다음 달, 두 달에 걸치면 고칠 곳)
	eq(m.tuitionMonthFromClass({ properties: { "수강료 기간": date("2026-11-01", "2026-11-30"), "안내 기간": date("2027-01-01", "2027-01-31") } }), "2026-11")
	eq(m.tuitionMonthFromClass({ properties: {} }, new Date("2026-11-27T03:00:00Z")), "2026-12")
	let msg = ""
	try { m.tuitionMonthFromClass({ properties: { "수강료 기간": date("2026-11-20", "2026-12-05") } }) } catch (e) { msg = (e as Error).message }
	eq(msg.includes("'수강료 기간'은 한 달 안"), true)
})

Deno.test("v2.8.0 [월 수강료 생성] 등록 1건: 수강료를 만들어 반 발송함에 잇고, 같은 학생의 그 달 다른 반 수강료와 '같은 달 수강료'로 서로 잇는다(세 반)", async () => {
	const rA = reg("rA", { student: "s1", name: "테스트학생", cls: "cA", clsName: "수학반" })
	const rB = reg("rB", { student: "s1", name: "테스트학생", cls: "cB", clsName: "영어반" })
	const rC = reg("rC", { student: "s1", name: "테스트학생", cls: "cC", clsName: "국어반" })
	const pages: Record<string, any> = { rA, rB, rC, cA: { id: "cA", properties: { "마지막 오류": rt("") } }, cB: { id: "cB", properties: { "마지막 오류": rt("") } }, cC: { id: "cC", properties: { "마지막 오류": rt("") } } }
	const tByReg: Record<string, any[]> = { rA: [], rB: [], rC: [] }
	const q = (ds: string, filter: any) => {
		if (ds === "registrations") return [rA, rB, rC]
		if (ds === "tuitions") return tByReg[filter?.relation?.contains] ?? []
		return []
	}
	const tuitionPage = (id: string, regId: string, month = "2026-12") => ({ id, properties: { "청구기간": date(`${month}-01`, `${month}-28`), "등록": rel(regId), "알림톡 발송함": rel(), "같은 달 수강료": rel() } })
	// 1) 수학반: 혼자라 수강료만 만들고 잇지 않음
	const c1 = mock(pages, q)
	await m.processMonthlyCreateRegItem({ classId: "cA", month: "2026-12", regId: "rA", amount: 8, mailboxId: "box-A", last: true })
	const tA = c1.created[0]
	eq(tA.ds, "tuitions")
	eq([tA.props["청구명"].title[0].text.content, tA.props["실제 수업량"].number, tA.props["알림톡 발송함"].relation, tA.props["알림톡 설정"].relation, tA.props["일괄전송 선택"].checkbox, "가정통신문" in tA.props], ["26.12 테스트학생 수강료", 8, [{ id: "box-A" }], [{ id: "cfg-row" }], false, false])
	eq([c1.updates.filter((u) => u.props["같은 달 수강료"]).length, c1.marks], [0, ["done:cA"]])
	tByReg.rA = [tuitionPage("tA", "rA")]
	// 2) 영어반: 새 수강료(new1)와 수학반 수강료(tA)를 서로 잇는다
	const c2 = mock(pages, q)
	await m.processMonthlyCreateRegItem({ classId: "cB", month: "2026-12", regId: "rB", amount: 8, mailboxId: "box-B" })
	const sib2 = new Map(c2.updates.filter((u) => u.props["같은 달 수강료"]).map((u) => [u.id, u.props["같은 달 수강료"].relation.map((r: any) => r.id)]))
	eq([sib2.size, sib2.get("new1"), sib2.get("tA")], [2, ["tA"], ["new1"]])
	tByReg.rA = [{ ...tuitionPage("tA", "rA"), properties: { ...tuitionPage("tA", "rA").properties, "같은 달 수강료": rel("tB") } }]
	tByReg.rB = [{ ...tuitionPage("tB", "rB"), properties: { ...tuitionPage("tB", "rB").properties, "같은 달 수강료": rel("tA") } }]
	// 3) 국어반: 세 장이 서로 모두를 가진다(다른 달 수강료는 빼고)
	tByReg.rC = []
	tByReg.rA.push(tuitionPage("tA-nov", "rA", "2026-11"))
	const c3 = mock(pages, q)
	await m.processMonthlyCreateRegItem({ classId: "cC", month: "2026-12", regId: "rC", amount: 8, mailboxId: "box-C" })
	const sib3 = new Map(c3.updates.filter((u) => u.props["같은 달 수강료"]).map((u) => [u.id, u.props["같은 달 수강료"].relation.map((r: any) => r.id).sort()]))
	eq([sib3.get("new1"), sib3.get("tA"), sib3.get("tB"), sib3.has("tA-nov")], [["tA", "tB"], ["new1", "tB"], ["new1", "tA"], false])
	// 4) 다시 눌러도 늘지 않음: 국어반 수강료가 이미 있고 셋이 이미 서로 이어져 있으면 아무것도 쓰지 않음(빈 발송함만 연결)
	tByReg.rA = [{ ...tuitionPage("tA", "rA"), properties: { ...tuitionPage("tA", "rA").properties, "같은 달 수강료": rel("tB", "tC"), "알림톡 발송함": rel("box-A") } }]
	tByReg.rB = [{ ...tuitionPage("tB", "rB"), properties: { ...tuitionPage("tB", "rB").properties, "같은 달 수강료": rel("tA", "tC"), "알림톡 발송함": rel("box-B") } }]
	tByReg.rC = [{ ...tuitionPage("tC", "rC"), properties: { ...tuitionPage("tC", "rC").properties, "같은 달 수강료": rel("tA", "tB") } }]
	const c4 = mock(pages, q)
	await m.processMonthlyCreateRegItem({ classId: "cC", month: "2026-12", regId: "rC", amount: 8, mailboxId: "box-C" })
	eq([c4.created.length, c4.updates], [0, [{ id: "tC", props: { "알림톡 발송함": { relation: [{ id: "box-C" }] } } }]])
})

Deno.test("v2.8.0 가정통신문 [수강료 안내]: 반별 금액 줄·합계 한 통, 수강료마다 로그·✅, 보낸 일시·체크 해제, 빠진 반·이미 보냄은 안 보냄", async () => {
	const pages: Record<string, any> = {
		l1: letter("l1", { student: "s1", tuitions: ["t2", "t1"] }),
		t1: tuition("t1", "r1", "중1 A 수학", 250000), t2: tuition("t2", "r2", "중1 영어 B", 100000),
		r1: reg("r1", { student: "s1", name: "이도윤", cls: "c1", clsName: "중1 A 수학" }),
		r2: reg("r2", { student: "s1", name: "이도윤", cls: "c2", clsName: "중1 영어 B", since: "2026-12-15" }),
	}
	const both = (ds: string) => ds === "registrations" ? [pages.r1, pages.r2] : []
	const c = mock(pages, both)
	await m.processMonthlySendLetterItem({ kind: "tuition", letterId: "l1" })
	eq(c.sends.length, 1)
	eq(c.sends[0].code, "수강료 안내")
	eq(c.sends[0].vars, {
		"#{청구년월}": "12월", "#{학생이름}": "이도윤", "#{청구기간}": "26.12.01~26.12.31",
		"#{수강내역}": "• 중1 A 수학: 250,000원\n• 중1 영어 B(12.15~): 100,000원", "#{청구금액}": "350,000원", "#{안내멘트}": "계좌번호\n하다은행",
	})
	eq(c.logs.map((l) => [l.tuition, l.status]), [["t2", "성공"], ["t1", "성공"]])
	eq(c.updates.filter((u) => u.props["안내문 전송 상태"]).map((u) => [u.id, u.props["안내문 전송 상태"].select.name, u.props["일괄전송 선택"].checkbox]), [["t2", "✅ 완료", false], ["t1", "✅ 완료", false]])
	eq(c.updates.at(-1), { id: "l1", props: { "수강료 안내 일시": { date: { start: "2026-11-28" } }, "수강료 전송 선택": { checkbox: false }, "마지막 오류": { rich_text: [] } } })
	eq(c.marks, ["running:l1", "done:l1"])
	// 가정통신문의 (수강료안내) 수식이 있으면 그 값을 쓴다.
	pages.l1 = letter("l1", { student: "s1", tuitions: ["t2", "t1"] })
	pages.l1.properties["수강내역(수강료안내)"] = fx("수식 내역")
	const cf = mock(pages, both)
	await m.processMonthlySendLetterItem({ kind: "tuition", letterId: "l1" })
	eq(cf.sends[0].vars["#{수강내역}"], "수식 내역")
	// 이미 보냄
	const c2 = mock({ ...pages, l1: letter("l1", { student: "s1", tuitions: ["t1"], tuitionSent: "2026-11-27" }) })
	await m.processMonthlySendLetterItem({ kind: "tuition", letterId: "l1" })
	eq(c2.sends.length, 0)
	eq(c2.marks[1].includes("이미 수강료 안내를 보냈습니다"), true)
	// 그 달 다니는 반의 수강료가 빠졌으면 보내지 않음(체크·보낸 일시 그대로)
	const cm = mock({ ...pages, l1: letter("l1", { student: "s1", tuitions: ["t1"] }) }, both)
	await m.processMonthlySendLetterItem({ kind: "tuition", letterId: "l1" })
	eq([cm.sends.length, cm.updates.length, cm.marks[1].includes("중1 영어 B 12월 수강료가 아직 없어")], [0, 0, true])
	// 수강료가 없거나 설정이 꺼져 있으면 ⚠️(큐 재시도 없음)
	const c3 = mock({ l1: letter("l1", { student: "s1" }) })
	await m.processMonthlySendLetterItem({ kind: "tuition", letterId: "l1" })
	eq(c3.marks[1].includes("[월 수강료 생성]"), true)
	const c4 = mock({ ...pages, l1: letter("l1", { student: "s1", tuitions: ["t1"] }) }, () => [], { sendThrows: new LessonConfigError("설정 꺼짐") })
	await m.processMonthlySendLetterItem({ kind: "tuition", letterId: "l1" })
	eq([c4.marks[1], c4.logs.length], ["error:l1:설정 꺼짐", 0])
	// 발송 실패: 수강료마다 실패 로그·⚠️, 다시 보내지 않음(예외를 던지지 않음), 가정통신문 체크는 그대로
	const c5 = mock({ ...pages, l1: letter("l1", { student: "s1", tuitions: ["t1"] }) }, () => [], { sendThrows: new Error("solapi 500") })
	await m.processMonthlySendLetterItem({ kind: "tuition", letterId: "l1" })
	eq([c5.logs.map((l) => l.status), c5.updates.find((u) => u.id === "t1")?.props["안내문 전송 상태"].select.name, c5.updates.some((u) => u.id === "l1"), c5.marks[1]], [["실패"], "⚠️ 오류", false, "error:l1:solapi 500"])
})

Deno.test("v2.8.0 가정통신문 [일정 안내]: 학생 개인·두 반·학원 전체·학교 일정을 세 구역으로, 다른 학교 일정은 뺌, 0건이면 안 보냄", async () => {
	const regs = [reg("r1", { student: "s1", name: "이도윤", cls: "c1", clsName: "중1 A 수학" }), reg("r2", { student: "s1", name: "이도윤", cls: "c2", clsName: "중1 영어 B" })]
	const pages: Record<string, any> = { l1: letter("l1", { student: "s1" }), s1: { id: "s1", properties: { "학교": rel("sch"), "학년": rel("g1") } }, c1: { id: "c1", properties: { "안내 메모": rt("") } }, c2: { id: "c2", properties: { "안내 메모": rt("기말 대비 보충이 있습니다.") } } }
	const byLink: Record<string, any[]> = {
		"학생:s1": [ev("e-own", { name: "보충 수업", start: "2026-12-08", stu: ["s1"] })],
		"클래스:c1": [ev("e-c1", { name: "겨울 휴원", cat: "💤 휴원", start: "2026-12-24", end: "2026-12-26", cls: ["c1"] })],
		"클래스:c2": [ev("e-c1", { name: "겨울 휴원", cat: "💤 휴원", start: "2026-12-24", end: "2026-12-26", cls: ["c1", "c2"] })],
		"학교:sch": [ev("e-sch", { name: "기말고사", cat: "🏫 학사 일정", start: "2026-12-10", end: "2026-12-12", school: ["sch"], grade: ["g1"] }), ev("e-g2", { name: "2학년 체험", cat: "🏫 학사 일정", start: "2026-12-15", school: ["sch"], grade: ["g2"] })],
	}
	const academy = [ev("e-all", { name: "학부모 설명회", start: "2026-12-20" }), ev("e-other", { name: "다른 반", start: "2026-12-21", cls: ["c9"] })]
	const q = (ds: string, filter: any) => ds === "registrations" ? regs : ds === "events" ? (relFilter(filter) ? byLink[relFilter(filter)] ?? [] : academy) : []
	const c = mock(pages, q)
	await m.processMonthlySendLetterItem({ kind: "schedule", letterId: "l1" })
	eq(c.sends[0].code, "월간 일정 안내")
	eq(c.sends[0].vars, {
		"#{학생이름}": "이도윤", "#{클래스}": "중1 A 수학 · 중1 영어 B", "#{안내월}": "12월",
		"#{휴원일정}": "12/24(목)~26(토) 겨울 휴원", "#{학원일정}": "12/8(화) 보충 수업\n12/20(일) 학부모 설명회", "#{학사일정}": "12/10(목)~12(토) 기말고사",
		"#{전달사항}": "기말 대비 보충이 있습니다.",
		"#{페이지ID}": "/r.html?token=tok",
	})
	eq(c.updates.find((u) => u.props["일정"])?.props["일정"].relation.map((r: any) => r.id), ["e-own", "e-sch", "e-all", "e-c1"])
	eq(c.updates.at(-1), { id: "l1", props: { "일정 안내 일시": { date: { start: "2026-11-28" } }, "일정 전송 선택": { checkbox: false }, "마지막 오류": { rich_text: [] } } })
	eq(c.logs, [{ cat: "월간 일정 안내", status: "성공", reg: "r1", tuition: undefined }])
	// 가정통신문 메모가 있으면 클래스 안내 메모보다 먼저, 발송함 일괄은 그 발송함의 반 메모
	pages.l1 = letter("l1", { student: "s1" }); pages.l1.properties["가정통신문 메모"] = rt("하윤이는 12/8 보충에 꼭 와 주세요.")
	const cm = mock(pages, q)
	await m.processMonthlySendLetterItem({ kind: "schedule", letterId: "l1" })
	eq(cm.sends[0].vars["#{전달사항}"], "하윤이는 12/8 보충에 꼭 와 주세요.")
	const p2: any = { ...pages, l1: letter("l1", { student: "s1" }) }
	const cc = mock(p2, q)
	await m.sendScheduleNotice(p2.l1, "c1")
	eq(cc.sends[0].vars["#{전달사항}"], "없음")
	const c2 = mock({ l1: letter("l1", { student: "s1" }), s1: pages.s1 }, (ds) => ds === "registrations" ? regs : [])
	await m.processMonthlySendLetterItem({ kind: "schedule", letterId: "l1" })
	eq([c2.sends.length, c2.marks[1].includes("공개 일정이 없어")], [0, true])
})

Deno.test("v2.8.0 가정통신문 발송함 일괄 전송: 체크되고 안 보낸 가정통신문만, 구분이 다르거나 0건이면 ⚠️", async () => {
	const pages: Record<string, any> = {
		boxA: mailbox("boxA", { cls: "c1", letters: ["l1", "l2", "l3", "l4"] }),
		l1: letter("l1", { student: "s1", name: "26.12 이도윤 가정통신문" }),
		l2: letter("l2", { student: "s2", tuitionSent: "2026-11-27" }), // 이미 받음
		l3: letter("l3", { student: "s3", pickTuition: false }), // 체크 해제
		l4: letter("l4", { student: "s4", name: "26.12 김하윤 가정통신문" }),
	}
	const c = mock(pages)
	await m.processMonthlySendMailboxItem({ kind: "tuition", mailboxId: "boxA" })
	eq(c.enq.map((e) => [e.target, e.payload.letterId, e.payload.mailboxId, e.payload.classId, e.payload.studentName, e.payload.last ?? false]), [
		["monthly-send-student", "l1", "boxA", "c1", "26.12 이도윤 가정통신문", false],
		["monthly-send-student", "l4", "boxA", "c1", "26.12 김하윤 가정통신문", true],
	])
	// 일정은 일정 체크·일정 보낸 일시로 따로 고른다(수강료를 보냈어도 일정은 대상).
	const cs = mock(pages)
	await m.processMonthlySendMailboxItem({ kind: "schedule", mailboxId: "boxA" })
	eq(cs.enq.map((e) => e.payload.letterId), ["l1", "l2", "l3", "l4"])
	const ck = mock({ boxR: mailbox("boxR", { kind: "월간 보고서", letters: ["l1"] }), l1: pages.l1 })
	await m.processMonthlySendMailboxItem({ kind: "tuition", mailboxId: "boxR" })
	eq([ck.enq.length, ck.marks[1].includes("구분이 '가정통신문'인 발송함")], [0, true])
	const c0 = mock({ boxE: mailbox("boxE", { letters: ["l2"] }), l2: pages.l2 })
	await m.processMonthlySendMailboxItem({ kind: "tuition", mailboxId: "boxE" })
	eq([c0.enq.length, c0.marks[1].includes("보낼 가정통신문이 없습니다")], [0, true])
})

Deno.test("v2.8.0 가정통신문 두 반 발송함: 영어 B에서 먼저 보내면 수학 A에서는 건너뜀, 막히면 발송함 오류에 남기고 마지막에 ⚠️", async () => {
	const pages: Record<string, any> = {
		boxA: mailbox("boxA", { cls: "cA", letters: ["l1"] }), boxB: mailbox("boxB", { cls: "cB", letters: ["l1"] }),
		l1: letter("l1", { student: "s1", tuitions: ["t1", "t2"] }),
		t1: tuition("t1", "r1", "수학 A", 250000), t2: tuition("t2", "r2", "영어 B", 100000),
		r1: reg("r1", { student: "s1", name: "이도윤", cls: "cA", clsName: "수학 A" }), r2: reg("r2", { student: "s1", name: "이도윤", cls: "cB", clsName: "영어 B" }),
	}
	const q = (ds: string) => ds === "registrations" ? [pages.r1, pages.r2] : []
	const c = mock(pages, q)
	await m.processMonthlySendStudentItem({ kind: "tuition", mailboxId: "boxB", classId: "cB", letterId: "l1", studentName: "이도윤", last: true })
	eq([c.sends.length, c.marks], [1, ["done:boxB"]])
	eq([pages.l1.properties["수강료 전송 선택"].checkbox, pages.l1.properties["수강료 안내 일시"].date.start], [false, "2026-11-28"])
	// 수학 A 발송함: 같은 가정통신문이라 이미 보냄·체크 해제 → 대상 0건, 줄에 남은 건이 있어도 보내지 않고 ✅
	const cA = mock(pages, q)
	await m.processMonthlySendMailboxItem({ kind: "tuition", mailboxId: "boxA" })
	eq([cA.enq.length, cA.marks[1].includes("보낼 가정통신문이 없습니다")], [0, true])
	const cA2 = mock(pages, q)
	await m.processMonthlySendStudentItem({ kind: "tuition", mailboxId: "boxA", classId: "cA", letterId: "l1", studentName: "이도윤", last: true })
	eq([cA2.sends.length, cA2.marks], [0, ["done:boxA"]])
	// 영어 B 수강료가 아직 없으면: 발송함 오류에 한 줄, 마지막 건에서 ⚠️, 가정통신문 체크는 그대로
	const p2: Record<string, any> = { ...pages, boxA: mailbox("boxA", { cls: "cA", letters: ["l9"] }), l9: letter("l9", { student: "s1", tuitions: ["t1"] }) }
	const c2 = mock(p2, (ds) => ds === "registrations" ? [pages.r1, pages.r2] : [])
	await m.processMonthlySendStudentItem({ kind: "tuition", mailboxId: "boxA", classId: "cA", letterId: "l9", studentName: "이도윤", last: true })
	eq([c2.sends.length, c2.marks.length, c2.marks[0].startsWith("error:boxA:이도윤: 영어 B 12월 수강료가 아직 없어"), p2.l9.properties["수강료 전송 선택"].checkbox], [0, 1, true, true])
	eq(p2.l9.properties["마지막 오류"].rich_text[0].plain_text.startsWith("영어 B 12월 수강료가 아직 없어"), true)
})

Deno.test("v2.8.0 가정통신문 발송함 일정 일괄: 그 달 학부모 공개 일정이 0건이면 보내지 않고 사유를 발송함·가정통신문에 남김(10/28 원본 실테스트)", async () => {
	const regs = [reg("r1", { student: "s1", name: "강준혁", cls: "cB", clsName: "중1 B" })]
	const pages: Record<string, any> = {
		boxB: mailbox("boxB", { cls: "cB", letters: ["l1"] }), l1: letter("l1", { student: "s1" }),
		s1: { id: "s1", properties: { "학교": rel(), "학년": rel() } }, cB: { id: "cB", properties: { "안내 메모": rt("") } },
	}
	const c = mock(pages, (ds) => ds === "registrations" ? regs : [])
	await m.processMonthlySendStudentItem({ kind: "schedule", mailboxId: "boxB", classId: "cB", letterId: "l1", studentName: "강준혁", last: true })
	eq(c.sends.length, 0)
	eq(c.marks, ["error:boxB:강준혁: 이 달 이 학생의 학부모 공개 일정이 없어 보내지 않았습니다."])
	eq([pages.l1.properties["마지막 오류"].rich_text[0].plain_text, pages.l1.properties["일정 전송 선택"].checkbox, pages.l1.properties["일정 안내 일시"].date], ["이 달 이 학생의 학부모 공개 일정이 없어 보내지 않았습니다.", true, null])
})

Deno.test("v2.8.0 월간 일정 안내: 반 이름은 이름순, 두 반 이상 학생에게 일부 반에만 걸린 일정은 반 이름을 붙임(10/28 사용자)", async () => {
	const names = new Map([["ca", "중1 A"], ["cb", "중1 B"]])
	const ev1 = { properties: { "클래스": rel("cb") } }
	eq(m.withClassPrefix("11/14(토) 보충 수업", ev1, names), "11/14(토) 중1 B 보충 수업")
	eq(m.withClassPrefix("12/24(목)~12/26(토) 겨울 휴원", { properties: { "클래스": rel("cb") } }, names), "12/24(목)~12/26(토) 중1 B 겨울 휴원")
	// 두 반 모두·반 없음(학생·학원 전체)·한 반만 다니는 학생은 그대로
	eq(m.withClassPrefix("11/14(토) 보충", { properties: { "클래스": rel("ca", "cb") } }, names), "11/14(토) 보충")
	eq(m.withClassPrefix("11/14(토) 설명회", { properties: { "클래스": rel() } }, names), "11/14(토) 설명회")
	eq(m.withClassPrefix("11/14(토) 보충", ev1, new Map([["cb", "중1 B"]])), "11/14(토) 보충")
	// 실제 보내기: 등록 순서가 B, A여도 #{클래스}는 이름순, 중1 B 일정 앞에 반 이름
	const regs = [reg("r2", { student: "s1", name: "강준혁", cls: "cb", clsName: "중1 B" }), reg("r1", { student: "s1", name: "강준혁", cls: "ca", clsName: "중1 A" })]
	const pages: Record<string, any> = { l1: letter("l1", { student: "s1" }), s1: { id: "s1", properties: { "학교": rel(), "학년": rel() } }, ca: { id: "ca", properties: { "안내 메모": rt("") } }, cb: { id: "cb", properties: { "안내 메모": rt("") } } }
	const q = (ds: string, filter: any) => ds === "registrations" ? regs : ds === "events" && relFilter(filter) === "클래스:cb" ? [ev("e-b", { name: "(테스트) 보충 수업", start: "2026-12-12", cls: ["cb"] })] : []
	const c = mock(pages, q)
	await m.processMonthlySendLetterItem({ kind: "schedule", letterId: "l1" })
	eq([c.sends[0].vars["#{클래스}"], c.sends[0].vars["#{학원일정}"]], ["중1 A · 중1 B", "12/12(토) 중1 B (테스트) 보충 수업"])
})

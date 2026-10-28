// All network calls are mocked. No live Notion/Solapi/Supabase calls or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_REGISTRATION_ID: "registrations", DATA_SOURCE_SCHEDULE_EVENT_ID: "events", DATA_SOURCE_TUITION_ID: "tuitions", REPORT_PATH: "/r.html" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const m = await import("./monthlyNotice.ts")
const { monthlyDeps: deps } = m

const rel = (...ids: string[]) => ({ type: "relation", relation: ids.map((id) => ({ id })), has_more: false })
const title = (s: string) => ({ type: "title", title: [{ plain_text: s }] })
const rt = (s: string) => ({ type: "rich_text", rich_text: s ? [{ plain_text: s }] : [] })
const date = (start: string | null, end: string | null = null) => ({ type: "date", date: start ? { start, end } : null })
const roll = (s: string) => ({ type: "rollup", rollup: { type: "array", array: [{ type: "rich_text", rich_text: [{ plain_text: s }] }] } })
const reg = (id: string, o: { student: string; name: string; cls: string; clsName: string; since?: string; until?: string }) => ({ id, properties: {
	"학생정보": rel(o.student), "클래스": rel(o.cls), "등록일": date(o.since ?? "2026-03-02"), "종료일": date(o.until ?? null),
	"학생이름(등록)": { type: "rollup", rollup: { array: [{ type: "title", title: [{ plain_text: o.name }] }] } }, "클래스명(등록)": roll(o.clsName),
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

Deno.test("v2.8.0 월 수강료: 달 범위·이름", () => {
	eq(m.monthRange("2026-12"), { start: "2026-12-01", end: "2026-12-31" })
	eq(m.monthRange("2027-02"), { start: "2027-02-01", end: "2027-02-28" })
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

Deno.test("v2.8.0 월간 일정 안내: 반 이름은 이름순, 두 반 이상 학생에게 일부 반에만 걸린 일정은 반 이름을 붙임(10/28 사용자)", async () => {
	const names = new Map([["ca", "중1 A"], ["cb", "중1 B"]])
	const ev1 = { properties: { "클래스": rel("cb") } }
	eq(m.withClassPrefix("11/14(토) 보충 수업", ev1, names), "11/14(토) 중1 B 보충 수업")
	eq(m.withClassPrefix("12/24(목)~12/26(토) 겨울 휴원", { properties: { "클래스": rel("cb") } }, names), "12/24(목)~12/26(토) 중1 B 겨울 휴원")
	// 두 반 모두·반 없음(학생·학원 전체)·한 반만 다니는 학생은 그대로
	eq(m.withClassPrefix("11/14(토) 보충", { properties: { "클래스": rel("ca", "cb") } }, names), "11/14(토) 보충")
	eq(m.withClassPrefix("11/14(토) 설명회", { properties: { "클래스": rel() } }, names), "11/14(토) 설명회")
	eq(m.withClassPrefix("11/14(토) 보충", ev1, new Map([["cb", "중1 B"]])), "11/14(토) 보충")
})

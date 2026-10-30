// All network calls are mocked. No live Notion/Supabase/Solapi calls or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const { noticeDeps, processNoticeQueueItem } = await import("./noticeQueue.ts")

const REG = "3ecba040586b8061a932dc4c4869e7a9"
const text = (s: string) => ({ type: "rich_text", rich_text: [{ plain_text: s }] })
const formula = (s: string) => ({ type: "formula", formula: { string: s } })
const rollup = (s: string) => ({ type: "rollup", rollup: { type: "array", array: [text(s)] } })
const rel = (id: string) => ({ relation: [{ id }] })
const select = (name: string) => ({ select: { name } })

function fake(page: any, opts: { sendFails?: boolean; refreshFails?: boolean; pages?: Record<string, any> } = {}) {
	const calls = { reads: 0, patched: [] as any[], patches: [] as any[], sent: [] as any[], logs: [] as any[], refresh: [] as any[], recipients: [] as any[], config: [] as unknown[][] }
	const saved = { ...noticeDeps }
	Object.assign(noticeDeps, {
		config: async (...args: any[]) => { calls.config.push(args.filter((x) => typeof x === "string" || Array.isArray(x))); return { pfId: "pf", templateId: "tpl", senderNumber: "0200000000", notice: "안내", recipientTarget: "우선 연락 대상" } },
		getPage: async (id: string) => { calls.reads++; return opts.pages?.[id] ?? page },
		patch: async (id: string, props: any) => { calls.patches.push(props); calls.patched.push({ id, props }) },
		refresh: async (reg: string, o: any) => { calls.refresh.push({ reg, ...o }); if (opts.refreshFails) throw new Error("최신화 실패"); return { access_token: "tok", cacheRow: { registration_detail: { report_comments: [] } } } },
		recipients: async (a: any) => { calls.recipients.push(a); return [{ label: "우선 연락 대상", phone: "01000000000" }] },
		send: async (to: string, vars: any) => { if (opts.sendFails) throw new Error("발송 실패"); calls.sent.push({ to, vars }) },
		log: async (a: any) => { calls.logs.push(a) },
		botUserId: async () => "bot",
		now: () => 0,
	})
	return { calls, restore: () => Object.assign(noticeDeps, saved) }
}

const reportPage = (status = "⚪ 대기") => ({
	id: "report-1",
	properties: {
		"보고서 전송 상태": select(status),
		"보고서 구분": select("월간 보고서"),
		등록: rel(REG),
		"알림톡 발송함": rel("batch-1"),
		"리포트 토큰": rollup("raw-token"),
		"학생이름(보고서)": formula("한지민"),
		"학부모 연락처(보고서)": formula("010-0000-0000"),
		"보고서기간(보고서)": formula("10월"),
		"보고서 기간": { date: { start: "2026-10-01", end: "2026-10-31" } },
	},
})

Deno.test("v2.6.24 보고서: 한 번 읽고 공용 캐시·토큰 롤업으로 최신화, 보낸 뒤 쓰기 1번(✅·일괄전송 선택 해제)", async () => {
	const { calls, restore } = fake(reportPage())
	try {
		await processNoticeQueueItem({ kind: "report", pageId: "report-1", clickerUserId: "teacher" })
		// 보고서 1번 + (v2.8.0 구역) 예체능인지 보려고 등록 1번.
		eq(calls.reads, 2)
		eq(calls.refresh, [{ reg: REG, sharedRunKey: "notice:batch-1:0", tokenRaw: "raw-token" }])
		eq(calls.recipients[0].primaryPhone, "010-0000-0000")
		eq(calls.config, [["월간 보고서", ["보고서"]]])
		eq(calls.sent.length, 1)
		eq(calls.sent[0].vars["#{페이지ID}"].endsWith("?token=tok"), true)
		eq(calls.logs.map((l) => [l.status, l.reportId, l.senderUserId, l.category]), [["성공", "report-1", "teacher", "월간 보고서"]])
		eq(calls.patches.length, 1)
		eq(calls.patches[0]["보고서 전송 상태"].select.name, "✅ 완료")
		eq(calls.patches[0]["일괄전송 선택"].checkbox, false)
	} finally { restore() }
})

Deno.test("v2.6.24 이미 처리된 건(전송 상태가 ⚪ 대기 아님)은 건너뛴다 — 두 번 눌러도 한 번", async () => {
	const { calls, restore } = fake(reportPage("✅ 완료"))
	try {
		await processNoticeQueueItem({ kind: "report", pageId: "report-1" })
		eq(calls.sent.length, 0)
		eq(calls.patches.length, 0)
		eq(calls.refresh.length, 0)
	} finally { restore() }
})

Deno.test("v2.6.24 발송 전 실패 → 오류만 적고 예외(큐 재시도, 상태는 ⚪ 대기 그대로)", async () => {
	const { calls, restore } = fake(reportPage(), { refreshFails: true })
	try {
		let threw = false
		try { await processNoticeQueueItem({ kind: "report", pageId: "report-1" }) } catch { threw = true }
		eq(threw, true)
		eq(calls.sent.length, 0)
		eq(calls.patches.length, 1)
		eq("보고서 전송 상태" in calls.patches[0], false)
		eq(calls.patches[0]["마지막 오류"].rich_text[0].text.content, "최신화 실패")
	} finally { restore() }
})

Deno.test("v2.6.24 발송 단계 실패 → 다시 보내지 않고 ⚠️ 오류·실패 로그", async () => {
	const tuition = { id: "tuition-1", properties: { "안내문 전송 상태": select("⚪ 대기"), 등록: rel(REG), 학생정보: formula("임현우"), "학부모 연락처": rollup("010-1111-1111"), 청구기간: { date: { start: "2026-10-01", end: "2026-10-31" } } } }
	const { calls, restore } = fake(tuition, { sendFails: true })
	try {
		await processNoticeQueueItem({ kind: "tuition", pageId: "tuition-1" })
		eq(calls.logs.map((l) => [l.status, l.tuitionId, l.category, l.senderUserId]), [["실패", "tuition-1", "수강료 안내", "bot"]])
		eq(calls.patches[0]["안내문 전송 상태"].select.name, "⚠️ 오류")
		eq(calls.patches[0]["마지막 오류"].rich_text[0].text.content, "발송 실패")
		eq(calls.recipients[0].primaryPhone, "010-1111-1111")
	} finally { restore() }
})

Deno.test("v2.6.24 교재비 안내문: 안내문 전송 상태, 일괄전송 선택은 건드리지 않음, 안내멘트는 알림톡 설정", async () => {
	const cart = { id: "cart-1", properties: { "안내문 전송 상태": select("⚪ 대기"), 등록: rel(REG), "학생이름(표시)": rollup("조하은"), "클래스명(표시)": rollup("중1 B"), 미납교재: formula("쎈 1권") } }
	const { calls, restore } = fake(cart)
	try {
		await processNoticeQueueItem({ kind: "textbook", pageId: "cart-1" })
		eq(calls.sent[0].vars, { "#{학생이름}": "조하은", "#{클래스}": "중1 B", "#{교재내역}": "📚 교재 내역\n쎈 1권", "#{교재비안내}": "쎈 1권", "#{안내멘트}": "안내" })
		eq(calls.logs[0].textbookCartId, "cart-1")
		eq(calls.patches[0]["안내문 전송 상태"].select.name, "✅ 완료")
		eq("일괄전송 선택" in calls.patches[0], false)
	} finally { restore() }
})

const tuitionPage = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, properties: { "안내문 전송 상태": select(status), 등록: rel(REG), 학생정보: formula("테스트학생"), "학부모 연락처": rollup("010-1111-1111"), 청구기간: { date: { start: "2026-11-01", end: "2026-11-30" } }, ...extra } })
const sibs = (...ids: string[]) => ({ relation: ids.map((id) => ({ id })) })

Deno.test("v2.8.0 수강료: 같은 달 수강료를 한 통으로(수강료안내 수식 사용) 보내고 같은 달 수강료 모두 ✅·성공 로그", async () => {
	const me = tuitionPage("t-math", "⚪ 대기", {
		"같은 달 수강료": sibs("t-eng", "t-kor"),
		"청구년월(수강료안내)": formula("26년 11월"), "학생이름(수강료안내)": formula("테스트학생"), "청구기간(수강료안내)": formula("11/1~11/30"),
		"수강내역(수강료안내)": formula("• 수학반 150,000원\n• 영어반 200,000원\n• 국어반 120,000원"), "청구금액(수강료안내)": formula("470,000원"),
	})
	const pages = { "t-math": me, "t-eng": tuitionPage("t-eng", ""), "t-kor": tuitionPage("t-kor", "⚪ 대기") }
	const { calls, restore } = fake(me, { pages })
	try {
		await processNoticeQueueItem({ kind: "tuition", pageId: "t-math" })
		eq(calls.sent.length, 1)
		eq([calls.sent[0].vars["#{청구년월}"], calls.sent[0].vars["#{청구금액}"], calls.sent[0].vars["#{수강내역}"].split("\n").length, calls.sent[0].vars["#{안내멘트}"]], ["26년 11월", "470,000원", 3, "안내"])
		eq(calls.sent[0].vars["#{수강정보}"], "📚 수강 내역\n• 수학반 150,000원\n• 영어반 200,000원\n• 국어반 120,000원")
		// (v2.8.0 구역) 수강목록(알림톡) 수식이 없으면 이 장 하나로 "🏛 반  금액" + 합계.
		eq(calls.sent[0].vars["#{수강목록}"].split("\n").pop(), "🧾 합계  470,000원")
		eq(calls.patched.map((p) => [p.id, p.props["안내문 전송 상태"].select.name]), [["t-math", "✅ 완료"], ["t-eng", "✅ 완료"], ["t-kor", "✅ 완료"]])
		eq(calls.logs.map((l) => [l.status, l.tuitionId]), [["성공", "t-math"], ["성공", "t-eng"], ["성공", "t-kor"]])
	} finally { restore() }
})

Deno.test("v2.8.0 수강료 일괄: 같은 달 수강료 하나라도 이미 보냈으면 보내지 않고 ⚠️ 사유, 개별 전송은 잠금 무시", async () => {
	const sent = tuitionPage("t-eng", "✅ 완료", { "클래스(수강료)": rollup("영어반") })
	const locked = tuitionPage("t-math", "⚪ 대기", { "같은 달 수강료": sibs("t-eng") })
	const a = fake(locked, { pages: { "t-math": locked, "t-eng": sent } })
	try {
		await processNoticeQueueItem({ kind: "tuition", pageId: "t-math" })
		eq(a.calls.sent.length, 0)
		eq(a.calls.patched.map((p) => [p.id, p.props["안내문 전송 상태"].select.name, p.props["일괄전송 선택"].checkbox]), [["t-math", "⚠️ 오류", false]])
		eq(a.calls.patched[0].props["마지막 오류"].rich_text[0].text.content.startsWith("같은 달 수강료 안내(다른 반 포함)를 이미 보냈습니다"), true)
	} finally { a.restore() }
	const forced = tuitionPage("t-math", "⚪ 대기", { "같은 달 수강료": sibs("t-eng"), "개별 전송": { checkbox: true } })
	const b = fake(forced, { pages: { "t-math": forced, "t-eng": sent } })
	try {
		await processNoticeQueueItem({ kind: "tuition", pageId: "t-math" })
		eq(b.calls.sent.length, 1)
		eq(b.calls.patched.map((p) => [p.id, p.props["안내문 전송 상태"].select.name, p.props["개별 전송"]?.checkbox]), [["t-math", "✅ 완료", false], ["t-eng", "✅ 완료", undefined]])
	} finally { b.restore() }
})

Deno.test("v2.8.0 가정통신문(letter): 같은 달 가정통신문을 한 통으로, 모두 ✅·로그, 잠금·개별 전송, 일정 0건이면 재시도 없이 ⚠️", async () => {
	const letterPage = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, properties: { "안내문 전송 상태": select(status), "이름": { type: "title", title: [{ plain_text: `26.11 테스트학생 ${id} 가정통신문` }] }, 등록: rel(`reg-${id}`), ...extra } })
	const me = letterPage("lA", "⚪ 대기", { "같은 달 가정통신문": sibs("lB") })
	const built = { registrationId: "reg-lA", title: "테스트학생", period: { start: "2026-11-01", end: "2026-11-30" }, variables: { "#{학원일정}": "11/14(토) 학원 설명회" } }
	const a = fake(me, { pages: { lA: me, lB: letterPage("lB", "") } })
	noticeDeps.letter = async () => built
	try {
		await processNoticeQueueItem({ kind: "letter", pageId: "lA" })
		eq(a.calls.sent.map((s) => s.vars["#{학원일정}"]), ["11/14(토) 학원 설명회"])
		eq(a.calls.patched.map((p) => [p.id, p.props["안내문 전송 상태"].select.name, "일괄전송 선택" in p.props]), [["lA", "✅ 완료", false], ["lB", "✅ 완료", false]])
		eq(a.calls.logs.map((l) => [l.status, l.category, l.registrationId, l.letterId]), [["성공", "월간 일정 안내", "reg-lA", "lA"], ["성공", "월간 일정 안내", "reg-lB", "lB"]])
	} finally { a.restore() }
	// 잠금: 같은 달 장을 이미 보냈으면 일괄은 ⚠️(그 장 이름), 개별 전송은 보냄
	const locked = letterPage("lA", "⚪ 대기", { "같은 달 가정통신문": sibs("lB") })
	const b = fake(locked, { pages: { lA: locked, lB: letterPage("lB", "✅ 완료") } })
	noticeDeps.letter = async () => built
	try {
		await processNoticeQueueItem({ kind: "letter", pageId: "lA" })
		eq(b.calls.sent.length, 0)
		eq(b.calls.patched[0].props["마지막 오류"].rich_text[0].text.content.startsWith("같은 달 가정통신문(다른 반 포함)을 이미 보냈습니다"), true)
	} finally { b.restore() }
	// 일정 0건: 보내지 않고 ⚠️, 예외 없음(큐 재시도 안 함), 개별 전송은 끔
	const { LetterBlocked } = await import("./monthlyNotice.ts")
	const forced = letterPage("lA", "⚪ 대기", { "개별 전송": { checkbox: true } })
	const d = fake(forced)
	noticeDeps.letter = async () => { throw new LetterBlocked("11월 학부모 공개 일정이 없어 보내지 않았습니다.") }
	try {
		await processNoticeQueueItem({ kind: "letter", pageId: "lA" })
		eq(d.calls.sent.length, 0)
		eq([d.calls.patched[0].props["안내문 전송 상태"].select.name, d.calls.patched[0].props["개별 전송"].checkbox], ["⚠️ 오류", false])
	} finally { d.restore() }
})

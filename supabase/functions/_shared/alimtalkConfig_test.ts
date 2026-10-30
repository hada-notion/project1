// All network calls are mocked. No live Notion/Solapi/Supabase calls or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", NOTION_ALIMTALK_CONFIG_DB_ID: "config-db" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const { getAlimtalkConfig, withConfigFallback } = await import("./adminShared.ts")

const rt = (s: string) => ({ rich_text: s ? [{ plain_text: s }] : [] })

Deno.test("v2.8.0 알림톡 설정 캐시: 행 값만 저장하고 기본값은 부를 때마다 채운다(빈 기본값으로 먼저 읽어도 다음 발송의 발신번호가 비지 않음)", async () => {
	let queries = 0
	const realFetch = globalThis.fetch
	globalThis.fetch = (async () => {
		queries++
		return new Response(JSON.stringify({ results: [{ id: "row", properties: {
			"활성 여부": { checkbox: true }, "카카오 채널 ID (pfId)": rt("pf-row"), "템플릿 ID": rt("tpl-row"), "발신번호": rt(""), "안내멘트": rt("계좌번호"),
		} }] }), { status: 200, headers: { "Content-Type": "application/json" } })
	}) as typeof fetch
	try {
		// 가정통신문 수강료 안내: 안내멘트를 읽으려고 빈 기본값으로 먼저 부른다.
		const first = await getAlimtalkConfig("수강료 안내", { pfId: "", templateId: "", senderNumber: "" })
		eq([first.pfId, first.templateId, first.senderNumber, first.notice], ["pf-row", "tpl-row", "", "계좌번호"])
		// 같은 함수 안 발송: Secrets 발신번호를 기본값으로 다시 부른다 → 캐시를 써도 발신번호가 채워져야 한다.
		const second = await getAlimtalkConfig("수강료 안내", { pfId: "", templateId: "", senderNumber: "0212345678" })
		eq([second.pfId, second.senderNumber, second.notice, queries], ["pf-row", "0212345678", "계좌번호", 1])
	} finally {
		globalThis.fetch = realFetch
	}
	// 행에 값이 있으면 행이 먼저
	eq(withConfigFallback({ pfId: "a", templateId: "", senderNumber: "0101", notice: "", recipientTarget: ["우선 연락 대상"] }, { pfId: "x", templateId: "y", senderNumber: "z" }).senderNumber, "0101")
})

Deno.test("v2.8.0 주간·월간 보고서 행이 없으면 옛 보고서 행을 쓴다(fallbackCategory)", async () => {
	const asked: string[] = []
	const realFetch = globalThis.fetch
	globalThis.fetch = (async (_url: string, init: any) => {
		const code = JSON.parse(init.body).filter.rich_text.equals
		asked.push(code)
		const results = code === "보고서" ? [{ id: "row", properties: { "활성 여부": { checkbox: true }, "템플릿 ID": rt("tpl-report"), "알림 수신 대상": { select: { name: "어머니" } } } }] : []
		return new Response(JSON.stringify({ results }), { status: 200, headers: { "Content-Type": "application/json" } })
	}) as typeof fetch
	try {
		const c = await getAlimtalkConfig("주간 보고서", { pfId: "", templateId: "env", senderNumber: "" }, "보고서")
		eq([c.templateId, c.recipientTarget, asked], ["tpl-report", ["어머니"], ["주간 보고서", "보고서"]])
	} finally {
		globalThis.fetch = realFetch
	}
})

Deno.test("v2.8.0 구역: 예체능 활동 보고서 행이 없으면 주간 보고서 → 보고서 순으로 넘어간다", async () => {
	const asked: string[] = []
	const realFetch = globalThis.fetch
	globalThis.fetch = (async (_url: string, init: any) => {
		const code = JSON.parse(init.body).filter.rich_text.equals
		asked.push(code)
		const results = code === "보고서" ? [{ id: "row", properties: { "활성 여부": { checkbox: true }, "템플릿 ID": rt("tpl-old") } }] : []
		return new Response(JSON.stringify({ results }), { status: 200, headers: { "Content-Type": "application/json" } })
	}) as typeof fetch
	try {
		const c = await getAlimtalkConfig("월간 활동 보고서", { pfId: "", templateId: "env", senderNumber: "" }, ["월간 보고서", "보고서"])
		// "보고서" 행은 앞 테스트가 캐시에 넣어 두어 다시 묻지 않는다(tpl-report).
		eq([c.templateId, asked], ["tpl-report", ["월간 활동 보고서", "월간 보고서"]])
	} finally {
		globalThis.fetch = realFetch
	}
})

Deno.test("v2.8.0 알림 수신 대상: 다중 선택(학생 포함)·예전 단일 선택·빈 값은 우선 연락 대상", async () => {
	const { recipientTargetsOf } = await import("./adminShared.ts")
	eq(recipientTargetsOf({ type: "multi_select", multi_select: [{ name: "학생" }, { name: "우선 연락 대상" }] }), ["우선 연락 대상", "학생"])
	eq(recipientTargetsOf({ type: "select", select: { name: "어머니" } }), ["어머니"])
	eq(recipientTargetsOf({ type: "multi_select", multi_select: [] }), ["우선 연락 대상"])
	eq(recipientTargetsOf(undefined), ["우선 연락 대상"])
})

Deno.test("v2.8.0 알림 수신 대상: 여럿이면 없는 번호는 건너뛰고 같은 번호는 한 번, 하나만이면 없을 때 오류", async () => {
	const { resolveAlimtalkRecipients } = await import("./alimtalkShared.ts")
	const phone = (v: string) => ({ type: "phone_number", phone_number: v })
	const pages: Record<string, any> = {
		reg: { id: "reg", properties: { "학생정보": { type: "relation", relation: [{ id: "stu" }] } } },
		stu: { id: "stu", properties: { "어머니 연락처": phone("010-1111-2222"), "아버지 연락처": phone(""), "기타 보호자 연락처": phone(""), "학생 연락처": phone("010-1111-2222") } },
		reg2: { id: "reg2", properties: { "학생정보": { type: "relation", relation: [{ id: "stu2" }] } } },
		stu2: { id: "stu2", properties: { "학생 연락처": phone("010-3333-4444") } },
	}
	const realFetch = globalThis.fetch
	globalThis.fetch = (async (input: Request | URL | string) => {
		const id = String(input instanceof Request ? input.url : input).split("/pages/")[1]?.split(/[/?]/)[0] ?? ""
		return new Response(JSON.stringify(pages[id] ?? {}), { status: 200, headers: { "Content-Type": "application/json" } })
	}) as typeof fetch
	try {
		// 우선 연락처 + 학생: 학생 번호가 다르면 두 통
		eq((await resolveAlimtalkRecipients({ registrationId: "reg2", primaryPhone: "010-9999-8888", recipientTarget: ["우선 연락 대상", "학생"] })).map((r) => r.label), ["우선 연락 대상", "학생"])
		// 학생 번호가 어머니와 같으면 한 번, 아버지 번호가 없으면 건너뜀
		eq((await resolveAlimtalkRecipients({ registrationId: "reg", recipientTarget: ["어머니", "아버지", "학생"] })).map((r) => r.label), ["어머니"])
		// 하나만 골랐는데 번호가 없으면 예전처럼 오류
		let err = ""
		try { await resolveAlimtalkRecipients({ registrationId: "reg", recipientTarget: ["아버지"] }) } catch (e) { err = (e as Error).message }
		eq(err, "연락처 오류: 아버지 연락처가 비어 있습니다.")
		// 예전 값 "모든 연락처"
		eq((await resolveAlimtalkRecipients({ registrationId: "reg", recipientTarget: "모든 연락처" })).map((r) => r.label), ["어머니"])
	} finally {
		globalThis.fetch = realFetch
	}
})

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
	eq(withConfigFallback({ pfId: "a", templateId: "", senderNumber: "0101", notice: "", recipientTarget: "우선 연락 대상" }, { pfId: "x", templateId: "y", senderNumber: "z" }).senderNumber, "0101")
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
		eq([c.templateId, c.recipientTarget, asked], ["tpl-report", "어머니", ["주간 보고서", "보고서"]])
	} finally {
		globalThis.fetch = realFetch
	}
})

// All network calls are mocked. No live Notion/Supabase writes or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_GRADE_ID: "grades" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const { examScopeDeps, queryGradesOfScope } = await import("./examScopeTarget.ts")

function fake(names: string[], fail?: Error) {
	const asked: string[] = []
	const saved = { ...examScopeDeps }
	Object.assign(examScopeDeps, {
		queryAllPages: async (_ds: string, filter: any) => {
			asked.push(filter.property)
			if (fail) throw fail
			if (!names.includes(filter.property)) throw new Error(`Could not find property with name or id: ${filter.property}`)
			return [{ id: "g1" }]
		},
	})
	return { asked, restore: () => Object.assign(examScopeDeps, saved) }
}

Deno.test("v2.6.30 성적의 시험정보 관계: 새 이름을 먼저, 없으면 예전 이름 시험범위", async () => {
	let t = fake(["시험정보"])
	try {
		eq((await queryGradesOfScope("s")).prop, "시험정보")
		eq(t.asked, ["시험정보"])
	} finally { t.restore() }
	t = fake(["시험범위"])
	try {
		eq((await queryGradesOfScope("s")).prop, "시험범위")
		eq(t.asked, ["시험정보", "시험범위"])
	} finally { t.restore() }
})

Deno.test("v2.6.30 속성 오류가 아닌 실패는 예전 이름으로 다시 묻지 않는다", async () => {
	const t = fake([], new Error("rate limited"))
	let threw = false
	try { await queryGradesOfScope("s") } catch { threw = true }
	finally { t.restore() }
	eq(threw, true)
	eq(t.asked, ["시험정보"])
})

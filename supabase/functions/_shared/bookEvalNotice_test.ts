// All network calls are mocked. No live Notion/Supabase/Solapi calls or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only", DATA_SOURCE_STUDY_ACTIVITY_ID: "activities" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const m = await import("./bookEvalNotice.ts")
const b = await import("./noticeBlocks.ts")
const deps = m.bookEvalDeps

const rel = (...ids: string[]) => ({ type: "relation", relation: ids.map((id) => ({ id })), has_more: false })
const sel = (name: string) => ({ type: "select", select: { name } })
const txt = (s: string) => ({ type: "rich_text", rich_text: s ? [{ plain_text: s }] : [] })
const n = (v: number | null) => ({ type: "number", number: v })
const REC = "3eeba040586b81e3a977f3fb68b99d50", LIB = "3eeba040586b81e3a977f3fb68b99d51", CLS = "3eeba040586b81e3a977f3fb68b99d52", REG = "3eeba040586b81e3a977f3fb68b99d53", U1 = "3eeba040586b81e3a977f3fb68b99d54"
const act = (id: string, correct: number | null, total: number | null, comment = "", status = "") => ({ id, properties: { "등록": rel(REG), "학습기록": rel(REC), "정답 문항": n(correct), "전체 문항": n(total), "선생님 한마디": txt(comment), "진도 평가 안내 상태": status ? sel(status) : { type: "select", select: null } } })

Deno.test("v2.8.0 교재 평가 알림톡 블록: 평가정보·평가결과(점수/수료, 반 평균, 한마디)", () => {
	eq(b.bookEvalInfoBlock({ evalType: "단원 평가", range: "p.10~20", units: ["1-2. 정수와 유리수"] }), "📝 단원 평가  p.10~20\n  • 1-2. 정수와 유리수")
	eq(b.bookEvalInfoBlock({ evalType: "마무리 평가" }), "📝 마무리 평가")
	eq(b.bookEvalResultBlock({ correct: 22, total: 25, classAvg: 81, comment: "도형 단원이 많이 좋아졌어요." }), "📊 결과  88점 (22/25)\n👥 반 평균  81점\n\n🗨️ 선생님 한마디\n도형 단원이 많이 좋아졌어요.")
	eq(b.bookEvalResultBlock({ correct: null, total: null, classAvg: null }), "🎓 결과  수료")
})

Deno.test("v2.8.0 교재 평가 알림톡 내용: 단원 평가는 범위·단원, 반 평균은 점수 3명 이상", async () => {
	const A1 = "a1", A2 = "a2", A3 = "a3"
	const pages: Record<string, any> = {
		[REC]: { id: REC, properties: { "구분": sel("평가"), "평가 구분": sel("단원 평가"), "교재": rel(LIB), "클래스": rel(CLS), "범위": txt("p.10~20"), "선택 단원": rel(U1), "학습활동": rel(A1, A2, A3), "학습": { type: "title", title: [{ plain_text: "[단원 평가] 쎈 공통수학1(고1 A)" }] } } },
		[LIB]: { id: LIB, properties: { "교재명": { type: "title", title: [{ plain_text: "쎈 공통수학1" }] } } },
		[CLS]: { id: CLS, properties: { "반 평균 숨김": { type: "checkbox", checkbox: false } } },
		[REG]: { id: REG, properties: { "학생이름(등록)": { type: "rollup", rollup: { type: "array", array: [{ type: "title", title: [{ plain_text: "강하을" }] }] } } } },
		[A1]: act(A1, 22, 25, "도형 단원이 많이 좋아졌어요."), [A2]: act(A2, 20, 25), [A3]: act(A3, 19, 25),
	}
	Object.assign(deps, { getPage: async (id: string) => { if (id in pages) return pages[id]; throw new Error(`unexpected ${id}`) }, unitNames: async () => new Map([[U1, "1-2. 정수와 유리수"]]) })
	const c = await m.bookEvalContent(pages[A1])
	eq([c.registrationId, c.evalType, c.variables["#{학생이름}"], c.variables["#{교재명}"], c.variables["#{평가정보}"]], [REG, "단원 평가", "강하을", "쎈 공통수학1", "📝 단원 평가  p.10~20\n  • 1-2. 정수와 유리수"])
	eq(c.variables["#{평가결과}"], "📊 결과  88점 (22/25)\n👥 반 평균  81.3점\n\n🗨️ 선생님 한마디\n도형 단원이 많이 좋아졌어요.")
	pages[REC].properties["평가 구분"] = sel("주간 평가")
	let err = ""
	try { await m.bookEvalContent(pages[A1]) } catch (e) { err = (e as Error).message }
	eq(err.includes("진도 평가"), true)
	// 학습 기록에 평가 구분을 잘못 골라 둔 경우도 보내지 않는다.
	pages[REC].properties["평가 구분"] = sel("단원 평가")
	pages[REC].properties["구분"] = sel("학습")
	err = ""
	try { await m.bookEvalContent(pages[A1]) } catch (e) { err = (e as Error).message }
	eq(err.includes("구분이 평가인"), true)
})

Deno.test("v2.8.0 교재 평가 일괄: 이미 받은 학생은 건너뛰고 나머지만 ⚪ 대기·큐", async () => {
	const updates: string[] = [], queued: any[] = []
	Object.assign(deps, {
		queryAllPages: async () => [act("x1", 1, 2, "", "✅ 완료"), act("x2", 1, 2), act("x3", 1, 2, "", "⚠️ 오류")],
		update: async (id: string) => { updates.push(id) },
		enqueue: async (target: string, payload: any) => { queued.push([target, payload.kind, payload.pageId]) },
	})
	await m.processBookEvalBatchItem({ recordId: REC })
	eq([updates, queued], [["x2", "x3"], [["notice", "bookEval", "x2"], ["notice", "bookEval", "x3"]]])
})

Deno.test("v2.8.0 예체능: 진도교재 주제가 있으면 #{교재명}은 주제(교재명)", async () => {
	const PB = "3eeba040586b81e3a977f3fb68b99d60", A1 = "a1"
	const pages: Record<string, any> = {
		[REC]: { id: REC, properties: { "구분": sel("평가"), "평가 구분": sel("마무리 평가"), "교재": rel(LIB), "진도교재": rel(PB), "학습활동": rel(A1) } },
		[LIB]: { id: LIB, properties: { "교재명": { type: "title", title: [{ plain_text: "수채화 1" }] } } },
		[PB]: { id: PB, properties: { "주제": txt("기억에 남는 풍경 그리기") } },
		[REG]: { id: REG, properties: {} },
		[A1]: act(A1, null, null),
	}
	Object.assign(deps, { getPage: async (id: string) => { if (id in pages) return pages[id]; throw new Error(`unexpected ${id}`) }, unitNames: async () => new Map() })
	eq((await m.bookEvalContent(pages[A1])).variables["#{교재명}"], "기억에 남는 풍경 그리기(수채화 1)")
	pages[PB].properties["주제"] = txt("")
	eq((await m.bookEvalContent(pages[A1])).variables["#{교재명}"], "수채화 1")
})

// All network calls are mocked. No live Notion/Solapi/Supabase calls or secret values are used.
for (const [key, value] of Object.entries({ NOTION_TOKEN: "test-only", ADMIN_SECRET: "test-only", SB_URL: "https://mock.supabase", SB_SERVICE_ROLE_KEY: "test-only" })) Deno.env.set(key, value)
const eq = (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const b = await import("./noticeBlocks.ts")
const fit = await import("./templateFit.ts")
const formula = (s: string) => ({ type: "formula", formula: { type: "string", string: s } })

Deno.test("v2.8.0 통일안 블록: 기존·전달사항은 있을 때만, 일정 구역은 있는 것만, 결석 기본 문구, 두 칸 표기", () => {
	eq(b.lessonInfoBlock({ classTime: "26.11.04(수) 18:00", note: "없음" }), "📅 일시  26.11.04(수) 18:00")
	eq(b.lessonInfoBlock({ classTime: "26.10.31(토) 18:00", makeupOf: "26.10.12(월)", note: "교재 지참" }), "🔁 기존  26.10.12(월) 결석\n📅 일시  26.10.31(토) 18:00\n\n📝 전달사항\n교재 지참")
	eq(b.eventInfoBlock({ time: "26.11.05(목) 18:00", note: "" }), "📅 일시  26.11.05(목) 18:00")
	eq(b.classListBlock(["중2 B"]), "  중2 B")
	eq([b.classInfoBlock(["중2 B"]), b.classInfoBlock(["중2 B 수학", "중2 영어 A"]), b.tuitionInfoBlock("  • 수학반  150,000원")], ["🏛 클래스  중2 B", "🏛 클래스\n  • 중2 B 수학\n  • 중2 영어 A", "📚 수강 내역\n  • 수학반  150,000원"])
	eq(b.classListBlock(["중2 B 수학", "중2 영어 A"]), "\n  • 중2 B 수학\n  • 중2 영어 A")
	eq(b.letterScheduleBlock({ 휴원: "없음", 학원: "11/13(금)\n· 보충", 학사: "11/9(월)~11(수)\n· 기말고사", note: "교재 지참" }), "📆 학원 일정\n11/13(금)\n· 보충\n\n🏫 학사 일정\n11/9(월)~11(수)\n· 기말고사\n\n📝 전달사항\n교재 지참")
	eq(b.letterScheduleBlock({ 휴원: "12/31(목)\n· 연말 휴원", 학원: "없음", 학사: "", note: "없음" }), "💤 휴원 일정\n12/31(목)\n· 연말 휴원")
	eq(b.arrivalBlock({ classDate: "26.10.31(토)", status: "🟢 출석", makeupOf: "26.10.12(월)" }), "🔁 기존  26.10.12(월) 결석\n📅 수업일  26.10.31(토)\n✅ 출결  출석")
	eq(b.arrivalBlock({ classDate: "26.10.29(목)", status: "🔵 보강" }), "📅 수업일  26.10.29(목)\n✅ 출결  출석(보강)")
	eq(b.arrivalBlock({ classDate: "26.10.28(수)", status: "결석" }), "📅 수업일  26.10.28(수)\n✅ 출결  결석")
	eq(b.studyContentOrDefault("  ", "🔴 결석"), "결석으로 이날 학습 기록이 없습니다.")
	eq(b.studyContentOrDefault("", "🟢 출석"), "이날 학습 기록이 없습니다.")
	eq(b.studyContentOrDefault("📐 수학", "결석"), "📐 수학")
	eq(b.reportStatusBlock("✅ 출석: 100% (3/3)\n📝 과제: 과제 없음\n\n🗨️ 선생님 한마디\n오늘 숙제: 복습"), "✅ 출석  100% (3/3)\n📝 과제  과제 없음\n\n🗨️ 선생님 한마디\n오늘 숙제: 복습")
	eq(b.textbookBlock("📘 RPM 1-2 : 15,000원\n📘 쎈 1-2 : 16,000원\n\n📚 청구 금액 : 31,000원"), "📚 교재 내역\n  • RPM 1-2  15,000원\n  • 쎈 1-2  16,000원\n\n🧾 합계  31,000원")
	eq(b.inquiryBlock({ studentName: "이도윤", school: "하다중학교", grade: "중1" }), "👤 학생  이도윤\n🏫 학교  하다중학교\n🎓 학년  중1")
	eq(b.inquiryBlock({ studentName: "김하윤", school: "미입력", grade: "" }), "👤 학생  김하윤")
	eq(b.inquiryInfoBlock({ studentName: "강하을", school: "우리중", grade: "중1" }), "📋 접수 내용\n  • 학생  강하을\n  • 학교  우리중\n  • 학년  중1")
	eq(b.inquiryInfoBlock({ studentName: "김하윤", school: "미입력", grade: "" }), "📋 접수 내용\n  • 학생  김하윤")
	eq(b.dateOnly("26.10.12(월) 18:00"), "26.10.12(월)")
	// 변수 값: "이름(알림톡)" → 옛 이름 → 계산값
	const page = { properties: { "학생이름(알림톡)": formula("새"), "학생이름(보고서)": formula("옛"), "클래스(보고서)": formula("옛반") } }
	eq([b.alimtalkVar(page, "학생이름", "계산", "학생이름(보고서)"), b.alimtalkVar(page, "클래스", "계산", "클래스(보고서)"), b.alimtalkVar(page, "학습기간", "계산")], ["새", "옛반", "계산"])
	// 앞 공백(목록 첫 줄 "  • ", 반 하나 "  수학반")은 남기고 뒤 공백만 지운다. 공백뿐이면 비어 있는 것으로 본다.
	const lead = { properties: { "전달사항(일정안내)": formula("  • (수학반) 문구\n  • 개인 메모\n"), "클래스목록(알림톡)": formula("  수학반"), "학습기간(알림톡)": formula("   ") } }
	eq([b.alimtalkVar(lead, "전달사항", "계산", "전달사항(일정안내)"), b.alimtalkVar(lead, "클래스목록", "계산"), b.alimtalkVar(lead, "학습기간", "계산")], ["  • (수학반) 문구\n  • 개인 메모", "  수학반", "계산"])
})

Deno.test("v2.8.0 통일안 템플릿 맞춤: 본문·제목·버튼에 있는 변수만 남김, 변수 칸·검수 의견은 보지 않음, 못 읽으면 그대로", async () => {
	fit.clearTemplateFitCache()
	const vars = { "#{학생이름}": "김하윤", "#{수업정보}": "📅 일시  …", "#{수업일시}": "26.10.30(금)", "#{전달사항}": "없음" }
	let reads = 0
	const reader = { getKakaoAlimtalkTemplate: async (_id: string) => { reads++; return { content: "👤 학생  #{학생이름}\n#{수업정보}", emphasizeTitle: "#{수업구분} 안내", variables: [{ name: "#{수업일시}" }], comments: [{ content: "#{전달사항} 예시" }] } } }
	eq(await fit.fitVariablesToTemplate(reader, "T1", vars), { "#{학생이름}": "김하윤", "#{수업정보}": "📅 일시  …" })
	await fit.fitVariablesToTemplate(reader, "T1", vars)
	eq(reads, 1) // 10분 캐시
	const broken = { getKakaoAlimtalkTemplate: async () => { throw new Error("401") } }
	eq(await fit.fitVariablesToTemplate(broken, "T2", vars), vars)
	eq(await fit.fitVariablesToTemplate(reader, "", vars), vars)
	const withButton = { getKakaoAlimtalkTemplate: async () => ({ content: "#{학습내용}", buttons: [{ linkMo: "https://x/#{페이지ID}" }] }) }
	eq(await fit.fitVariablesToTemplate(withButton, "T3", { "#{학습내용}": "a", "#{페이지ID}": "b", "#{수업일}": "c" }), { "#{학습내용}": "a", "#{페이지ID}": "b" })
})

Deno.test("v2.8.0 구역: 일일 구역 변수는 (알림톡) 수식을 따르고, 비면 기본 문구(결석은 결석 문구)", () => {
	const page = { properties: { "학습준비(알림톡)": formula("📋 과제\n#개념원리 공통수학1\n  • 제출  제출"), "학습기록(알림톡)": formula(""), "학습결과(알림톡)": formula("") } }
	eq(b.dailySectionVars(page, "출석"), {
		"#{학습준비}": "📋 과제\n#개념원리 공통수학1\n  • 제출  제출",
		"#{학습기록}": "이날 학습 기록이 없습니다.",
		"#{학습결과}": "오늘은 평가와 새 과제가 없습니다.",
	})
	eq(b.dailySectionVars({ properties: {} }, "🔴 결석")["#{학습기록}"], "결석으로 이날 학습 기록이 없습니다.")
	eq(b.dailySectionVars({ properties: {} }, "출석")["#{학습준비}"], "확인한 과제·루틴이 없습니다.")
})

Deno.test("v2.8.0 구역: 1,000자를 넘으면 세부 줄을 학습기록부터 빼고 리포트 안내를 붙인다", () => {
	const short = { "#{학생이름}": "이도윤", "#{학습기록}": "📗 공통수학1\n#개념원리\n  • 1-2. 나머지정리" }
	eq(b.fitDailyLength(short), short)
	const detail = Array.from({ length: 60 }, (_, i) => `  • ${i}번 문제 풀이 정리`).join("\n")
	const long = { "#{학생이름}": "이도윤", "#{학습준비}": "🎯 루틴\n  • 단어 시험  O", "#{학습기록}": `📗 공통수학1\n#개념원리 공통수학1 (p.40-52)\n${detail}`, "#{학습결과}": "💬 선생님 한마디\n잘했어요." }
	const out = b.fitDailyLength(long)
	eq(out["#{학습기록}"], `📗 공통수학1\n#개념원리 공통수학1 (p.40-52)\n${b.DAILY_TRIM_NOTE}`)
	eq([out["#{학습준비}"], out["#{학습결과}"]], [long["#{학습준비}"], long["#{학습결과}"]])
	eq(b.fitDailyLength({ "#{학습내용}": detail + detail }), { "#{학습내용}": detail + detail })
})

Deno.test("v2.8.0 구역: 클래스 알림톡 구분이 예체능이면 일일 활동 보고서, 아니면 일일 보고서", async () => {
	const att = { properties: { "클래스": { type: "rollup", rollup: { type: "array", array: [{ type: "relation", relation: [{ id: "cls" }] }] } } } }
	const cls = (v: string | null) => async () => ({ properties: { "알림톡 구분": { select: v ? { name: v } : null } } })
	eq(await b.dailyConfigCategory(att, cls("예체능")), "일일 활동 보고서")
	eq(await b.dailyConfigCategory(att, cls("교과")), "일일 보고서")
	eq(await b.dailyConfigCategory(att, cls(null)), "일일 보고서")
	eq(await b.dailyConfigCategory({ properties: {} }, cls("예체능")), "일일 보고서")
	eq(await b.dailyConfigCategory(att, async () => { throw new Error("x") }), "일일 보고서")
})

Deno.test("v2.8.0 구역: 주간·월간 구역 변수는 (알림톡) 수식을 따르고, 예체능 반은 활동 보고서 행부터", async () => {
	eq(b.reportSectionVars({ properties: { "학습기록(알림톡)": formula("📗 공통수학1\n#개념원리 공통수학1 (~73%)") } }), {
		"#{학습기록}": "📗 공통수학1\n#개념원리 공통수학1 (~73%)",
		"#{학습요약}": "이 기간 출석 기록이 없습니다.",
		"#{교재명}": "-",
		"#{수료출석}": "-",
		"#{수료요약}": "이 과정을 모두 마쳤습니다.",
	})
	const pages: Record<string, any> = {
		reg: { properties: { "클래스": { relation: [{ id: "art" }] } } },
		reg2: { properties: { "클래스": { relation: [{ id: "math" }] } } },
		art: { properties: { "알림톡 구분": { select: { name: "예체능" } } } },
		math: { properties: { "알림톡 구분": { select: null } } },
	}
	const get = async (id: string) => { if (id in pages) return pages[id]; throw new Error("no") }
	eq(await b.reportConfigChain("주간 보고서", "reg", get), { category: "주간 활동 보고서", fallback: ["주간 보고서", "보고서"] })
	eq(await b.reportConfigChain("월간 보고서", "reg2", get), { category: "월간 보고서", fallback: ["보고서"] })
	eq(await b.reportConfigChain("월간 보고서", "missing", get), { category: "월간 보고서", fallback: ["보고서"] })
})

Deno.test("v2.8.0 구역: 길이는 이모지를 2자로 세는 UTF-16 길이로 잰다", () => {
	const emoji = "🎯".repeat(470)
	const out = b.fitDailyLength({ "#{학습기록}": "📗 a\n  • b", "#{학습결과}": emoji })
	eq(out["#{학습기록}"], `📗 a\n${b.DAILY_TRIM_NOTE}`)
})

Deno.test("v2.8.0 수료: 교재·프로그램 수료 보고서 행만 쓰고(기본 템플릿 없음), 교재명은 수식 → 제목", async () => {
	const pages: Record<string, any> = {
		reg: { properties: { "클래스": { relation: [{ id: "art" }] } } },
		reg2: { properties: { "클래스": { relation: [] } } },
		art: { properties: { "알림톡 구분": { select: { name: "예체능" } } } },
	}
	const get = async (id: string) => { if (id in pages) return pages[id]; throw new Error("no") }
	eq(await b.reportConfigChain("수료 보고서", "reg", get), { category: "프로그램 수료 보고서", fallback: [], noEnvTemplate: true })
	eq(await b.reportConfigChain("수료 보고서", "reg2", get), { category: "교재 수료 보고서", fallback: [], noEnvTemplate: true })
	const page = { properties: { "보고서": { title: [{ plain_text: "이도윤 수료 보고서 개념원리 중학수학 1-1" }] }, "수료출석(알림톡)": formula("17/18회") } }
	const v = b.reportSectionVars(page)
	eq([v["#{교재명}"], v["#{수료출석}"]], ["개념원리 중학수학 1-1", "17/18회"])
	eq(b.reportSectionVars({ properties: { ...page.properties, "교재명(알림톡)": formula("정물화 그리기") } })["#{교재명}"], "정물화 그리기")
})

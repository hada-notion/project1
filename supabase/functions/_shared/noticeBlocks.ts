// (v2.8.0 알림톡 통일안) 템플릿의 "상황 블록 변수"를 만든다. 늘 들어가는 줄을 바탕에 두고, 있을 때만 붙는 줄·구역
// (🔁 기존, 📝 전달사항, 일정 구역 등)은 여기서 붙인다. 한 줄 항목은 "이모지 라벨  값"(두 칸).
// 변수 값은 그 알림톡을 보내는 페이지의 "변수이름(알림톡)" 수식 속성을 먼저 쓰고(alimtalkVar), 없거나 비면 옛 이름,
// 그것도 없으면 서버 계산값. 날짜·시각이 든 블록은 수식을 읽지 않는다(Notion API가 수식의 날짜를 UTC로 계산한다).
import { getFormulaText } from "./alimtalkShared.ts"

export const NO_NOTE = "없음"

// 템플릿 변수 하나의 값: "이름(알림톡)" → 옛 이름(있으면) → 계산값.
// 앞 공백은 남긴다: 목록 블록 첫 줄 "  • …"·반 하나 "  수학반"의 두 칸이 값의 맨 앞이다(10/29 실발송에서 첫 줄 들여쓰기가 빠짐).
const keepLead = (v: string) => (v.trim() ? v.replace(/\s+$/, "") : "")
export function alimtalkVar(page: any, name: string, fallback: string, legacy?: string): string {
	const own = keepLead(getFormulaText(page, `${name}(알림톡)`))
	if (own) return own
	const old = legacy ? keepLead(getFormulaText(page, legacy)) : ""
	return old || fallback
}

const line = (emoji: string, label: string, value: string) => `${emoji} ${label}  ${value}`

// "26.10.12(월) 18:00" → "26.10.12(월)"
export const dateOnly = (text: string) => text.replace(/ \d{2}:\d{2}$/, "")

// 전달사항 구역(있을 때만). 비었거나 "없음"이면 붙이지 않는다.
export function noteSection(note: string | null | undefined): string {
	const t = String(note ?? "").trim()
	return t && t !== NO_NOTE ? `\n\n📝 전달사항\n${t}` : ""
}

// 수업 안내 #{수업정보}: [🔁 기존 결석한 날] + 📅 일시 + [📝 전달사항]. makeupOf는 보강 출석의 기존 결석 날짜("26.10.12(월)").
export function lessonInfoBlock(o: { classTime: string; makeupOf?: string; note?: string }): string {
	const lines = [
		...(o.makeupOf ? [line("🔁", "기존", `${o.makeupOf} 결석`)] : []),
		line("📅", "일시", o.classTime),
	]
	return lines.join("\n") + noteSection(o.note)
}

// 일정 안내 #{일정정보}: 📅 일시 + [📝 전달사항].
export function eventInfoBlock(o: { time: string; note?: string }): string {
	return line("📅", "일시", o.time) + noteSection(o.note)
}

// 가정통신문 #{클래스목록}: 반 하나면 "  중2 B"(템플릿 "🏛 클래스" 바로 뒤에 붙음), 둘 이상이면 줄바꿈 + "· 반" 목록.
// (10/29 사용자) 알림톡 목록 줄은 모두 두 칸 들여 "  • 내용"(일일 보고서 학습내용·Notion 텍스트 목록과 같은 모양).
export const BULLET = "  • "
// (10/29) 솔라피는 변수 값 맨 앞의 공백(폭 없는 공백까지)을 지운다. 그래서 목록이 든 블록 변수는 머리줄로 시작한다.
// 가정통신문 #{클래스정보}: 반 하나면 "🏛 클래스  수학반", 둘 이상이면 "🏛 클래스" 아래 "  • 반" 목록.
export const classInfoBlock = (names: string[]) =>
	names.length <= 1 ? `🏛 클래스  ${names[0] ?? NO_NOTE}` : ["🏛 클래스", ...names.map((n) => `${BULLET}${n}`)].join("\n")
// 수강료 #{수강정보}: "📚 수강 내역" 머리줄 + "  • 반  금액" 줄.
export const tuitionInfoBlock = (lines: string) => `📚 수강 내역\n${lines}`
export const classListBlock = (names: string[]) => (names.length <= 1 ? `  ${names[0] ?? NO_NOTE}` : "\n" + names.map((n) => `${BULLET}${n}`).join("\n"))

// 가정통신문 #{일정목록}: 일정이 있는 구역만(휴원 → 학원 → 학사) + [📝 전달사항]. 구역 값이 비었거나 "없음"이면 뺀다.
export function letterScheduleBlock(o: { 휴원: string; 학원: string; 학사: string; note?: string }): string {
	const sections: [string, string][] = [["💤 휴원 일정", o.휴원], ["📆 학원 일정", o.학원], ["🏫 학사 일정", o.학사]]
	const body = sections.filter(([, v]) => v.trim() && v.trim() !== NO_NOTE).map(([h, v]) => `${h}\n${v.trim()}`).join("\n\n")
	return body + (body ? noteSection(o.note) : noteSection(o.note).trimStart())
}

// 일일 보고서 #{등원정보}: [🔁 기존 결석한 날] + 📅 수업일 + ✅ 출결상태.
// (10/29 사용자) 출석 상태 "보강"은 "출석(보강)"으로 쓴다("출결 보강"은 뜻이 바로 안 읽힌다).
export function arrivalBlock(o: { classDate: string; status: string; makeupOf?: string }): string {
	return [
		...(o.makeupOf ? [line("🔁", "기존", `${o.makeupOf} 결석`)] : []),
		line("📅", "수업일", o.classDate),
		// 출석 상태 앞의 색 이모지("🟢 출석")는 뺀다. 줄 머리가 이미 ✅다.
		line("✅", "출결상태", attendanceLabel(o.status)),
	].join("\n")
}

function attendanceLabel(status: string): string {
	const s = status.trim().replace(/^[^\p{L}\p{N}\s]+\s*/u, "")
	return s === "보강" ? "출석(보강)" : s || "-"
}

// 일일 보고서 #{학습내용}: 그날 기록이 하나도 없을 때(결석 등) 대신 넣는 한 줄.
export function studyContentOrDefault(content: string, status: string): string {
	const t = content.trim()
	if (t) return t
	return status.includes("결석") ? "결석으로 이날 학습 기록이 없습니다." : "이날 학습 기록이 없습니다."
}

// (v2.8.0 루틴, 항목 18 · 10/30 사용자 시안 A) 일일 보고서 #{학습내용} 끝에 붙는 루틴 구역.
// "☑️ 루틴" + "  • 단어 암기  했어요" 줄. 그날 루틴 체크가 없으면 빈 값(구역 없음).
export function routineBlock(items: { name: string; done: boolean }[]): string {
	const rows = items.filter((i) => i.name)
	if (!rows.length) return ""
	return ["☑️ 루틴", ...rows.map((i) => `${BULLET}${i.name}  ${i.done ? "했어요" : "안 했어요"}`)].join("\n")
}

// #{학습내용}의 서버 대체 값(출석 '학습내용(알림톡)' 수식이 없거나 빌 때만 쓴다 — 계산은 원래 그 수식 안에서 한다).
// 수식과 같은 모양: 구역 사이 빈 줄, 루틴 구역은 학습·과제 뒤. 결석이면 루틴을 붙이지 않는다.
export function studyWithRoutines(content: string, status: string, items: { name: string; done: boolean }[]): string {
	const routines = status.includes("결석") ? "" : routineBlock(items)
	const t = content.trim()
	return t && routines ? `${t}\n\n${routines}` : t || routines
}

// 주간·월간 보고서 #{학습현황}: 보고서요약(보고서)의 "✅ 출석: 100% (3/3)" 같은 줄을 "✅ 출석  100% (3/3)"로.
// 출석·과제·평가·학습 줄만 바꾼다(선생님 한마디 본문의 콜론은 그대로).
export function reportStatusBlock(summary: string): string {
	return summary.trim().replace(/^(\S+ (?:출석|과제|평가|학습)):\s*/gmu, "$1  ")
}

// 교재비 #{교재내역}: 미납교재 수식("📘 교재 : 15,000원" 줄들 + "📚 청구 금액 : 31,000원")을
// "📚 교재 내역" + "  • 교재  15,000원" 줄들 + "🧾 합계  31,000원"으로.
export function textbookBlock(unpaid: string): string {
	const items: string[] = []
	let total = ""
	for (const raw of unpaid.split("\n")) {
		const l = raw.trim()
		if (!l) continue
		const sum = l.match(/^📚\s*청구 금액\s*:\s*(.+)$/u)
		if (sum) { total = sum[1].trim(); continue }
		const item = l.match(/^📘\s*(.+?)\s*:\s*(.+)$/u)
		items.push(item ? `${BULLET}${item[1]}  ${item[2].trim()}` : l)
	}
	return ["📚 교재 내역", ...(items.length ? items : [`${BULLET}없음`])].join("\n") + (total ? `\n\n🧾 합계  ${total}` : "")
}

// 상담 신청 접수 안내 #{접수내용}: 👤 학생(항상) + [🏫 학교] + [🎓 학년]. "미입력"·빈 값은 뺀다.
export function inquiryBlock(o: { studentName: string; school?: string; grade?: string }): string {
	const keep = (v?: string) => { const t = String(v ?? "").trim(); return t && t !== "미입력" ? t : "" }
	return [
		line("👤", "학생", o.studentName),
		...(keep(o.school) ? [line("🏫", "학교", keep(o.school))] : []),
		...(keep(o.grade) ? [line("🎓", "학년", keep(o.grade))] : []),
	].join("\n")
}

// (10/29 다시 신청한 본문) 상담 신청 접수 안내 #{접수정보}: 머리줄 "📋 접수 내용" + "  • 학생  이름"(항상)
// + 적은 경우만 학교·학년 줄. 본문에서 이 아래에 "  • 연락처  #{학부모연락처}"가 이어진다.
export function inquiryInfoBlock(o: { studentName: string; school?: string; grade?: string }): string {
	const keep = (v?: string) => { const t = String(v ?? "").trim(); return t && t !== "미입력" ? t : "" }
	return [
		"📋 접수 내용",
		`${BULLET}학생  ${o.studentName}`,
		...(keep(o.school) ? [`${BULLET}학교  ${keep(o.school)}`] : []),
		...(keep(o.grade) ? [`${BULLET}학년  ${keep(o.grade)}`] : []),
	].join("\n")
}

// (v2.8.0 진도 평가, 항목 16) 진도 평가 결과 안내 #{평가정보}: "📝 단원 평가  p.10~20" + 단원마다 "  • 1-2. 정수와 유리수",
// 마무리 평가는 "📝 마무리 평가" 한 줄. 머리줄로 시작한다(솔라피가 값 맨 앞 공백을 지우므로).
export function bookEvalInfoBlock(o: { evalType: string; range?: string; units?: string[] }): string {
	const head = `📝 ${o.evalType}${o.range ? `  ${o.range}` : ""}`
	return [head, ...(o.units ?? []).filter(Boolean).map((u) => `${BULLET}${u}`)].join("\n")
}

// #{평가결과}: "📊 결과  88점 (22/25)"(점수가 없으면 "🎓 결과  수료") + [👥 반 평균] + [빈 줄 · 🗨️ 선생님 한마디 · 내용].
export function bookEvalResultBlock(o: { correct: number | null; total: number | null; classAvg: number | null; comment?: string }): string {
	const total = o.total ?? 0
	const lines = [total > 0 ? `📊 결과  ${Math.round(((o.correct ?? 0) / total) * 100)}점 (${o.correct ?? 0}/${total})` : "🎓 결과  수료"]
	if (typeof o.classAvg === "number") lines.push(`👥 반 평균  ${o.classAvg}점`)
	const comment = String(o.comment ?? "").trim()
	if (comment) lines.push("", "🗨️ 선생님 한마디", comment)
	return lines.join("\n")
}

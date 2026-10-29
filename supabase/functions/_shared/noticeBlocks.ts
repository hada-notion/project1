// (v2.8.0 알림톡 통일안) 템플릿의 "상황 블록 변수"를 만든다. 늘 들어가는 줄을 바탕에 두고, 있을 때만 붙는 줄·구역
// (🔁 기존, 📝 전달사항, 일정 구역 등)은 여기서 붙인다. 한 줄 항목은 "이모지 라벨  값"(두 칸).
// 변수 값은 그 알림톡을 보내는 페이지의 "변수이름(알림톡)" 수식 속성을 먼저 쓰고(alimtalkVar), 없거나 비면 옛 이름,
// 그것도 없으면 서버 계산값. 날짜·시각이 든 블록은 수식을 읽지 않는다(Notion API가 수식의 날짜를 UTC로 계산한다).
import { getFormulaText } from "./alimtalkShared.ts"

export const NO_NOTE = "없음"

// 템플릿 변수 하나의 값: "이름(알림톡)" → 옛 이름(있으면) → 계산값.
export function alimtalkVar(page: any, name: string, fallback: string, legacy?: string): string {
	const own = getFormulaText(page, `${name}(알림톡)`).trim()
	if (own) return own
	const old = legacy ? getFormulaText(page, legacy).trim() : ""
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
export const classListBlock = (names: string[]) => (names.length <= 1 ? `  ${names[0] ?? NO_NOTE}` : "\n" + names.map((n) => `${BULLET}${n}`).join("\n"))

// 가정통신문 #{일정목록}: 일정이 있는 구역만(휴원 → 학원 → 학사) + [📝 전달사항]. 구역 값이 비었거나 "없음"이면 뺀다.
export function letterScheduleBlock(o: { 휴원: string; 학원: string; 학사: string; note?: string }): string {
	const sections: [string, string][] = [["💤 휴원 일정", o.휴원], ["📆 학원 일정", o.학원], ["🏫 학사 일정", o.학사]]
	const body = sections.filter(([, v]) => v.trim() && v.trim() !== NO_NOTE).map(([h, v]) => `${h}\n${v.trim()}`).join("\n\n")
	return body + (body ? noteSection(o.note) : noteSection(o.note).trimStart())
}

// 일일 보고서 #{등원정보}: [🔁 기존 결석한 날] + 📅 수업일 + ✅ 출결.
export function arrivalBlock(o: { classDate: string; status: string; makeupOf?: string }): string {
	return [
		...(o.makeupOf ? [line("🔁", "기존", `${o.makeupOf} 결석`)] : []),
		line("📅", "수업일", o.classDate),
		// 출석 상태 앞의 색 이모지("🟢 출석")는 뺀다. 줄 머리가 이미 ✅다.
		line("✅", "출결", o.status.trim().replace(/^[^\p{L}\p{N}\s]+\s*/u, "") || "-"),
	].join("\n")
}

// 일일 보고서 #{학습내용}: 그날 기록이 하나도 없을 때(결석 등) 대신 넣는 한 줄.
export function studyContentOrDefault(content: string, status: string): string {
	const t = content.trim()
	if (t) return t
	return status.includes("결석") ? "결석으로 이날 학습 기록이 없습니다." : "이날 학습 기록이 없습니다."
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

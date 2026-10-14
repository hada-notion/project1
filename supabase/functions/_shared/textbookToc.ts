// _shared/textbookToc.ts
//
// 교재 목차(알라딘 책소개 목차 또는 붙여넣은 글)를 단원목록 후보로 나눈다(v2.5.118, 교재 검색).
// 단원명 규칙(사용자 지정, 기존 단원목록 데이터와 같음):
//   - 대단원이 있으면 "대단원번호-중단원번호. 중단원명"(예: "1-2. 정수와 유리수"). 중단원 번호는 대단원마다 1부터.
//   - 대단원이 없으면 "중단원번호. 중단원명"(예: "2. 정수와 유리수").
//   - 대단원 이름과 소단원은 단원으로 만들지 않는다. 중단원 시작 쪽이 없으면 첫 소단원의 쪽을 쓴다.
//   - 정답·해설·머리말·차례 같은 줄은 처음부터 빼 둔다(include=false). 화면에서 다시 넣거나 고칠 수 있다.
// 쪽수는 줄 끝 숫자(점선·가운뎃점 뒤, "쪽"·"p" 포함)가 있을 때만 읽는다.

export type TocUnit = { name: string; page: number | null; include: boolean; big: string }
export type TocResult = { units: TocUnit[]; hasBig: boolean }

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", hellip: "…" }
export function tocLines(raw: string): string[] {
	const text = String(raw ?? "")
		.replace(/<\s*br\s*\/?>/gi, "\n")
		.replace(/<\/(p|li|div|tr|h\d)>/gi, "\n")
		.replace(/<[^>]*>/g, "")
		.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
			if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "" }
			return ENTITIES[e.toLowerCase()] ?? m
		})
	return text.split(/\r?\n/).map((l) => l.replace(/[\s 　]+/g, " ").trim()).filter(Boolean)
}

const ROMAN = "ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ"
const BIG = [
	new RegExp(`^[${ROMAN}]+\\s*[.)]?\\s*`),
	/^(?:[IVX]+)\s*[.)]\s*/,
	/^(?:제\s*)?\d+\s*(?:단원|장|부)\s*[.):]?\s*/,
	/^(?:part|chapter|unit)\s*\d+\s*[.):]?\s*/i,
]
const SMALL = [/^\d+(?:\s*-\s*\d+|\.\d+)+\s*[.)]?\s+/, /^[①-⑳]\s*/, /^\(\d+\)\s*/, /^[가-하]\s*[.)]\s+/]
// 중단원 번호 모양: 목차에서 처음 나온 모양을 중단원으로 보고, 다른 모양의 번호 줄("1." 아래 "01" 등)은 소단원으로 본다
const MID: [string, RegExp][] = [["zero", /^0\d\s*[.)]?\s*/], ["num", /^\d{1,2}\s*[.)]\s*/], ["num", /^\d{1,2}\s+(?=\S)/], ["word", /^(?:lesson|section)\s*\d+\s*[.):]?\s*/i]]
const SKIP = /(정답|해설|머리말|차례|목차|부록|이\s*책의|구성과\s*특징|찾아보기|학습\s*계획|index)/i

// 줄 끝 쪽수: "소인수분해 ········ 8", "소인수분해 / 8", "소인수분해 8쪽", "소인수분해 p.8"
function splitPage(line: string): { text: string; page: number | null } {
	const m = line.match(/^(.*?\S)(?:\s*[.·…‥_\-/|]{2,}\s*|\s*[/|]\s*|\s+)(?:p\.?\s*)?(\d{1,4})\s*(?:쪽|p)?$/i)
	if (!m) return { text: line, page: null }
	const page = Number(m[2])
	// "1. 소인수분해"처럼 숫자만 남는 줄이나 연도("2022 개정")는 쪽수가 아니다
	if (!/[가-힣a-z]/i.test(m[1]) || page < 1 || page > 2000) return { text: line, page: null }
	return { text: m[1].replace(/[\s.·…‥_\-/|]+$/, ""), page }
}
const strip = (text: string, rules: RegExp[]) => { for (const r of rules) if (r.test(text)) return text.replace(r, "").trim(); return null }

export function parseToc(raw: string): TocResult {
	type Line = { kind: "big" | "mid" | "small" | "plain"; name: string; page: number | null; skip: boolean }
	let midStyle = ""
	const lines: Line[] = tocLines(raw).map((l) => {
		const { text, page } = splitPage(l)
		const skip = SKIP.test(text)
		let name = strip(text, BIG)
		if (name !== null) return { kind: "big", name: name || text, page, skip }
		if ((name = strip(text, SMALL)) !== null) return { kind: "small", name: name || text, page, skip }
		const mid = MID.find(([, r]) => r.test(text))
		if (mid) {
			name = text.replace(mid[1], "").trim() || text
			if (!skip && !midStyle) midStyle = mid[0]
			return { kind: !midStyle || midStyle === mid[0] ? "mid" : "small", name, page, skip }
		}
		return { kind: "plain", name: text, page, skip }
	})
	// 중단원 없이 "1-1 …"만 있으면 그 줄을 중단원으로, 번호 없는 목록뿐이면 각 줄을 중단원으로 본다
	if (!lines.some((l) => l.kind === "mid")) {
		const promote = lines.some((l) => l.kind === "small") ? "small" : "plain"
		for (const l of lines) if (l.kind === promote) l.kind = "mid"
	}
	const hasBig = lines.some((l) => l.kind === "big" && !l.skip)
	const units: TocUnit[] = []
	let b = 0, m = 0, big = "", current: TocUnit | null = null
	for (const l of lines) {
		if (l.kind === "big") {
			if (l.skip) { current = null; continue }
			b++; m = 0; big = l.name; current = null
			continue
		}
		if (l.kind === "small") { if (current && current.page === null && l.page !== null) current.page = l.page; continue }
		if (l.kind !== "mid") continue
		const before = hasBig && b === 0
		const include = !l.skip && !before
		if (include) m++
		const num = include ? (hasBig ? `${b}-${m}` : `${m}`) : ""
		current = { name: num ? `${num}. ${l.name}` : l.name, page: l.page, include, big }
		units.push(current)
	}
	return { units, hasBig }
}

// 화면에서 고친 단원 목록을 저장 전에 다시 확인한다(빈 이름·너무 긴 이름·이상한 쪽수 제거).
export function cleanUnits(input: unknown, max = 80): { name: string; page: number | null }[] {
	if (!Array.isArray(input)) return []
	return input.slice(0, max).map((u: any) => {
		const name = String(u?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 100)
		const p = Number(u?.page)
		return { name, page: u?.page === null || u?.page === "" || u?.page === undefined || !Number.isInteger(p) || p < 1 || p > 2000 ? null : p }
	}).filter((u) => u.name)
}

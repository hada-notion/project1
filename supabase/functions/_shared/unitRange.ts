// _shared/unitRange.ts
//
// 범위 글자 → 단원(v2.5.127). 수업 관리 화면(class_room.js unitsInRange)과 같은 규칙이다.
//   - 쉼표로 구간을 나눈다: "p.31-35, 40-42" → [31~35], [40~42]. 구간 안에서는 숫자의 처음~끝(작은 수~큰 수).
//   - 단원 i는 그 시작쪽부터 다음 단원 시작쪽 앞까지. 어느 구간이든 걸치면 그 단원.
//   - 시작쪽이 없는 단원은 범위로 찾지 않는다.

export type Segment = { from: number; to: number }
export function rangeSegments(range: unknown): Segment[] {
	return String(range ?? "").split(/[,，]/).map((part) => {
		const n = (part.match(/\d+/g) ?? []).map(Number).filter((x) => x > 0 && x <= 5000)
		return n.length ? { from: Math.min(...n), to: Math.max(...n) } : null
	}).filter(Boolean) as Segment[]
}
// units는 시작쪽 순(쪽 없는 단원은 뒤)이어야 한다.
export function unitsForRange<T extends { page: number | null }>(units: T[], range: unknown): T[] {
	const segs = rangeSegments(range), paged = units.filter((u) => u.page !== null && u.page !== undefined)
	if (!segs.length || !paged.length) return []
	return paged.filter((u, i) => {
		const next = paged[i + 1]?.page
		const end = next === undefined || next === null ? Infinity : next - 1
		return segs.some((s) => (u.page as number) <= s.to && end >= s.from)
	})
}

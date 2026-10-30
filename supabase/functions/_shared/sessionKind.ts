// (v2.8.0 구역, 10/30 사용자) 수업의 종류. 수업 DB 선택 속성 `수업 구분`(보강·휴강)을 먼저 보고,
// 옮기는 동안에는 예전 `보강` 체크박스도 보강으로 본다(체크박스는 Notion 쪽을 다 옮긴 뒤 지운다).
export type SessionKind = "보강" | "휴강" | ""

export function sessionKind(session: any): SessionKind {
	const p = session?.properties ?? {}
	const sel = String(p["수업 구분"]?.select?.name ?? "").trim()
	if (sel === "보강" || sel === "휴강") return sel
	return p["보강"]?.checkbox === true ? "보강" : ""
}

export const isMakeupSession = (session: any) => sessionKind(session) === "보강"

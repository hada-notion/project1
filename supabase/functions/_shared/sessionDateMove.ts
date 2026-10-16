// _shared/sessionDateMove.ts
//
// (v2.6.18) 수업 날짜 이동: 수업 DB 자동화("수업일시" 편집 → 웹훅 fix-attendance/session-date)가 부르면,
// 그 수업의 출석 날짜를 수업과 같게 맞추고 학습기록·학습활동 제목 안의 날짜(MM.DD(요일))를 새 날짜로 바꾼다.
//
// 왜 서버인가: Notion 자동화가 바꾼 변경으로는 다른 자동화가 돌지 않는다(2026-10-16 원본 확인 — 수업 자동화가
// 출석 날짜를 바꿔도 출석 "이름 조정" 자동화가 돌지 않았다). 서버(API)가 출석 날짜를 바꾸면 출석 이름 자동화가
// 출석마다 돌아 "학생 이름 + 새 날짜"로 제목을 다시 만든다. 학습기록·학습활동은 날짜가 출석을 보는 수식이라
// 따라오지만 제목은 만들 때 붙인 글자라, 날짜 부분만 바꿔 쓴다.
// 원칙: 수업에 연결된 출석은 항상 수업과 날짜가 같다(수업 중심, v2.6.17).
import { getPage, queryAllPages, updatePageProperties, mapWithConcurrency } from "./notionClient.ts"
import { DS_ATTENDANCE, DS_LEARNING_RECORD, DS_STUDY_ACTIVITY } from "./constants.ts"

const WEEKDAY_KR = ["일", "월", "화", "수", "목", "금", "토"]
const DATE_TOKEN = /\d{2}\.\d{2}\([일월화수목금토]\)/g

// 수업 시작 시각(ISO) → 한국 날짜 "MM.DD(요일)"
export function koreanDateLabel(startIso: string): string {
	const t = new Date(Date.parse(startIso) + 9 * 3600_000)
	const mm = String(t.getUTCMonth() + 1).padStart(2, "0")
	const dd = String(t.getUTCDate()).padStart(2, "0")
	return `${mm}.${dd}(${WEEKDAY_KR[t.getUTCDay()]})`
}

// 제목의 마지막 날짜 표시만 바꾼다. 날짜 표시가 없으면 그대로(null).
export function retitle(title: string, label: string): string | null {
	const matches = [...title.matchAll(DATE_TOKEN)]
	if (!matches.length) return null
	const last = matches[matches.length - 1]
	const next = title.slice(0, last.index!) + label + title.slice(last.index! + last[0].length)
	return next === title ? null : next
}

const plainTitle = (p: any, prop: string): string =>
	(p?.properties?.[prop]?.title ?? []).map((t: any) => t.plain_text ?? t.text?.content ?? "").join("")

const sameInstant = (a: string | null | undefined, b: string | null | undefined) =>
	(a ? Date.parse(a) : NaN) === (b ? Date.parse(b) : NaN) || (!a && !b)

export async function processSessionDateQueueItem(payload: { pageId: string }): Promise<void> {
	const log: string[] = []
	try {
		// 여러 번 끌어 옮겨도 마지막 날짜로 맞추도록 본문 대신 수업을 새로 읽는다.
		const session = await getPage(payload.pageId)
		if (session.archived || session.in_trash) return void log.push("[skip] 삭제된 수업")
		const start: string | undefined = session.properties?.["수업일시"]?.date?.start
		if (!start) return void log.push("[skip] 수업일시 없음")
		const end: string = session.properties?.["수업일시"]?.date?.end ?? start
		const label = koreanDateLabel(start)
		const byRel = { property: "수업", relation: { contains: payload.pageId } }
		const [atts, records, activities] = await Promise.all([
			queryAllPages(DS_ATTENDANCE, byRel),
			queryAllPages(DS_LEARNING_RECORD, byRel),
			queryAllPages(DS_STUDY_ACTIVITY, byRel),
		])
		// 1) 출석 날짜(서버가 바꾸면 출석 "이름 조정" 자동화가 제목을 다시 만든다)
		const moveAtts = atts.filter((a: any) => {
			const d = a.properties?.["수업일시"]?.date
			return !sameInstant(d?.start, start) || !sameInstant(d?.end ?? d?.start, end)
		})
		await mapWithConcurrency(moveAtts, 3, (a: any) => updatePageProperties(a.id, { 수업일시: { date: { start, end } } }))
		// 2) 학습기록·학습활동 제목의 날짜
		const renames: { id: string; prop: string; title: string }[] = []
		for (const [pages, prop] of [[records, "학습"], [activities, "학습활동"]] as const) {
			for (const p of pages) {
				const next = retitle(plainTitle(p, prop), label)
				if (next) renames.push({ id: p.id, prop, title: next })
			}
		}
		await mapWithConcurrency(renames, 3, (r) => updatePageProperties(r.id, { [r.prop]: { title: [{ text: { content: r.title } }] } }))
		log.push(`[moved] ${payload.pageId} → ${label}: 출석 ${moveAtts.length}/${atts.length}건 날짜, 학습기록·학습활동 ${renames.length}건 제목`)
	} finally {
		console.log("[session-date] finished:", payload.pageId, log.join(" "))
	}
}

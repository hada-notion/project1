// (v2.6.14, 웹훅 재정리) 시간표 수식 "수업추가 정보"로 수업 페이지를 Notion 호출 1번(만들기)으로 만든다.
// 수식이 기준일·등원/하원 시간·클래스·클래스 이름·담당강사·그날 수강 중인 명단을 JSON 한 줄로 계산하므로,
// 서버는 시간표·클래스 페이지 읽기와 등록 조회를 하지 않는다. 메뉴 일괄 생성은 시간표 DB를 한 번 조회할 때
// 수식 값이 함께 오므로 그 값을 큐 항목에 담고, 워커는 그 값으로 바로 만든다. 출석은 출석 조정 큐가 만든다.
import { createPage, pickProp, relIds } from "./notionClient.ts"
import { DS_CLASS_SESSION } from "./constants.ts"
import { STATUS_DONE } from "./statusTracking.ts"

export const PROP_SESSION_PLAN = "수업 추가 정보"

export type SessionPlan = {
	date: string // YYYY-MM-DD (기준일)
	start: string // HH:mm
	end: string // HH:mm
	classId: string
	className: string
	teacherIds: string[]
	regIds: string[]
}

const ID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i
const cleanId = (v: unknown): string | null => (typeof v === "string" && ID_RE.test(v.trim()) ? v.trim() : null)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}$/

// 수식 결과 글자 → 계획. 형식이 하나라도 어긋나면 null(호출부는 예전 방식으로 시간표를 읽어 만든다).
export function sessionPlanFromText(text: unknown): SessionPlan | null {
	if (typeof text !== "string" || !text.trim()) return null
	let raw: any
	try { raw = JSON.parse(text) } catch { return null }
	if (!raw || raw.v !== 1) return null
	if (typeof raw.date !== "string" || !DATE_RE.test(raw.date)) return null
	const start = typeof raw.start === "string" && TIME_RE.test(raw.start) ? raw.start : "09:00"
	const end = typeof raw.end === "string" && TIME_RE.test(raw.end) ? raw.end : "10:00"
	const classId = cleanId(raw.cls)
	if (!classId) return null
	const ids = (v: unknown): string[] | null => {
		if (!Array.isArray(v)) return null
		const out = v.map(cleanId)
		return out.some((x) => !x) ? null : out as string[]
	}
	const teacherIds = ids(raw.tch ?? [])
	const regIds = ids(raw.reg)
	if (!teacherIds || !regIds) return null
	const className = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "class"
	return { date: raw.date, start, end, classId, className, teacherIds, regIds }
}

const propText = (p: any): string => {
	if (!p) return ""
	if (p.type === "formula" || p.formula) return String(p.formula?.string ?? "")
	if (Array.isArray(p.rich_text)) return p.rich_text.map((t: any) => t.plain_text ?? t.text?.content ?? "").join("")
	return ""
}

// 시간표 속성(조회 결과·페이지·웹훅 본문)에서 계획을 읽는다. 기준일 수식 값이 함께 있으면 날짜가 같아야 쓴다.
export function sessionPlanFromTimetable(props: any): SessionPlan | null {
	const plan = sessionPlanFromText(propText(pickProp(props, PROP_SESSION_PLAN)))
	if (!plan) return null
	const base = props?.["기준일"]?.formula?.date?.start ?? props?.["기준일"]?.date?.start
	if (typeof base === "string" && base.slice(0, 10) !== plan.date) return null
	// 수식의 클래스가 시간표 클래스와 다르면(수식이 잘못 붙은 경우) 쓰지 않는다.
	const cls = relIds(props?.["클래스"])
	if (cls.length && cls[0].replace(/-/g, "") !== plan.classId.replace(/-/g, "")) return null
	return plan
}

const WEEKDAY_KR = ["일", "월", "화", "수", "목", "금", "토"]

// "<클래스 이름> MM.DD(요일)" — generate-classes와 같은 이름
export function sessionTitle(className: string, date: string): string {
	const wd = WEEKDAY_KR[new Date(`${date}T00:00:00Z`).getUTCDay()]
	return `${className} ${date.slice(5, 7)}.${date.slice(8, 10)}(${wd})`
}

// 수업 페이지를 명단과 함께 ✅ 완료로 만든다(출석 조정 큐 적재는 호출부 — 만들기 성공 뒤 실패를 따로 다루려고).
export async function createSessionFromPlan(timetableId: string, plan: SessionPlan): Promise<string> {
	const page = await createPage(DS_CLASS_SESSION, {
		이름: { title: [{ text: { content: sessionTitle(plan.className, plan.date) } }] },
		수업일시: { date: { start: `${plan.date}T${plan.start}:00+09:00`, end: `${plan.date}T${plan.end}:00+09:00` } },
		클래스: { relation: [{ id: plan.classId }] },
		시간표: { relation: [{ id: timetableId }] },
		등록: { relation: plan.regIds.map((id) => ({ id })) },
		...(plan.teacherIds.length ? { 담당강사: { relation: plan.teacherIds.map((id) => ({ id })) } } : {}),
		"생성 상태": { select: { name: STATUS_DONE } },
	})
	return page.id
}

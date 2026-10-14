// _shared/classRoom.ts
//
// 수업방(class_room.html)이 부르는 class-room 함수의 실제 로직(v2.5.66). 업무 데이터는 모두 Notion에
// 읽고 쓴다(웹 전용 저장소 없음). 값을 고칠 때마다 "학습정보 수정일"을 함께 적어 학부모 리포트의
// 다시 만들기 대상에 들어가게 한다(Notion 자동화가 API 수정에도 도는지와 상관없이).
//
// 학생 연결 규칙은 [학습기록 생성] 버튼(createLearningRecordTarget.ts)과 같다:
//   - 그룹 진도 교재는 수업의 학생 전체, 개별 진도 교재는 그 교재를 가진 학생만.
//   - 보강 수업("보강" 체크)은 그룹 교재도 가진 학생만 연결하고 기록에 "보강"을 체크한다.
// 학습활동(출제)은 기존 create-assignment와 같은 공용 코드(finishCreateAssignment)를 쓴다.

import {
	getPage,
	queryAllPages,
	createPage,
	updatePageProperties,
	archivePage,
	mapWithConcurrency,
	relIds as relIdsFromProp,
	selectName,
	statusName,
	formulaString,
	dateStart,
	checkboxValue,
	anyTitleText,
	fetchWithRetry,
	notionHeaders,
	queryDataSource,
} from "./notionClient.ts"
import {
	DS_CLASS_SESSION,
	DS_ATTENDANCE,
	DS_LEARNING_RECORD,
	DS_STUDY_ACTIVITY,
} from "./constants.ts"
import {
	ASSIGNMENT_GEN_STATUS_SPEC,
	finishCreateAssignment,
	setAssignmentGenRunning,
	setAssignmentGenDone,
	setAssignmentGenError,
} from "./createAssignmentTarget.ts"
import { isRunning } from "./statusTracking.ts"
import { text as propText, numberOf as propNumber, fileUrlOf, dateStartOf } from "./reportCacheShared.ts"
import { readPageBodyBlocks } from "./feedBody.ts"
import { libraryCopyReady, readBooks, readUnits, sortUnits } from "./libraryCopy.ts"
import { textbookSources } from "./textbookSearch.ts"
import { SELECTED_UNITS, cleanUnitIds, selectedUnitsEnabled, unitNamesOf, unitTextOf, unitIdsOf } from "./selectedUnits.ts"
import { runInBackground } from "./backgroundTask.ts"
import { mirrorJobs, mirrorPageIds, mirrorSaved, removePages } from "./classRoomCopy.ts"
import { libraryIds } from "./libraryProp.ts"

type Page = Record<string, any>

export class ClassRoomError extends Error {
	constructor(public status: number, message: string) {
		super(message)
	}
}

export const KINDS = ["학습", "과제", "평가"] as const
export const ATTENDANCE_STATUSES = ["🟢 출석", "🔴 결석", "🔵 보강"] as const
export const HOMEWORK_SUBMITTED = "🔵 제출"
const HOMEWORK_MISSING = "🔴 미제출"
const GROUP_PROGRESS = "그룹 진도"
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"]
const MAX_ITEMS = 60

// ---------- 작은 도우미 ----------
const rel = (page: Page, prop: string): string[] => relIdsFromProp(page?.properties?.[prop])
const relation = (ids: string[]) => ({ relation: ids.map((id) => ({ id })) })
const richText = (value: string) => ({ rich_text: value ? [{ text: { content: value.slice(0, 2000) } }] : [] })
function plain(page: Page, prop: string): string {
	const p = page?.properties?.[prop]
	return (p?.title ?? p?.rich_text ?? []).map((t: any) => t.plain_text ?? t.text?.content ?? "").join("")
}
function numberOf(page: Page, prop: string): number | null {
	const v = page?.properties?.[prop]?.number
	return typeof v === "number" ? v : null
}
const nowStamp = () => ({ date: { start: new Date().toISOString() } })
const touched = () => ({ "학습정보 수정일": nowStamp() })
function dedupe(ids: string[]): string[] {
	return Array.from(new Set(ids.filter(Boolean)))
}
export function isId(v: unknown): v is string {
	return typeof v === "string" && /^[0-9a-z-]{1,64}$/i.test(v) // Notion 페이지 id(하이픈 있는/없는 hex). 경로 문자는 막는다
}
function ids(v: unknown, max = MAX_ITEMS): string[] {
	if (!Array.isArray(v) || v.length > max || !v.every(isId)) throw new ClassRoomError(400, "요청 형식이 올바르지 않습니다.")
	return dedupe(v)
}

// 서울 날짜 하루 범위와 "10.13(화)" 꼴 날짜 표시(기존 학습기록 제목과 같은 모양).
export function seoulDayRange(date: string): { start: string; end: string } {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ClassRoomError(400, "날짜 형식이 올바르지 않습니다.")
	const start = new Date(`${date}T00:00:00+09:00`)
	const end = new Date(start.getTime() + 86_400_000)
	return { start: start.toISOString(), end: end.toISOString() }
}
export function seoulLabel(iso: string | null): string {
	if (!iso) return ""
	const d = new Date(new Date(iso).getTime() + 9 * 3_600_000)
	const mm = String(d.getUTCMonth() + 1).padStart(2, "0")
	const dd = String(d.getUTCDate()).padStart(2, "0")
	return `${mm}.${dd}(${WEEKDAYS[d.getUTCDay()]})`
}
export function seoulTime(iso: string | null): string {
	if (!iso || !iso.includes("T")) return ""
	const d = new Date(new Date(iso).getTime() + 9 * 3_600_000)
	return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`
}
// 학습기록 제목 규칙: [구분] 교재명 또는 주제(클래스) 날짜
export function recordTitle(kind: string, subject: string, className: string, dateIso: string | null): string {
	const classPart = className ? `(${className})` : ""
	return [`[${kind}]`, `${subject}${classPart}`, seoulLabel(dateIso)].filter(Boolean).join(" ").trim()
}

async function getPages(pageIds: string[]): Promise<Page[]> {
	return await mapWithConcurrency(dedupe(pageIds), 6, (id) => getPage(id)) as Page[]
}
function studentName(attendance: Page): string {
	return formulaString(attendance, "학생이름(보고서)") || plain(attendance, "출석")
}

// ---------- 조회 ----------
let teacherDsCache = ""
async function teacherDataSourceId(): Promise<string> {
	if (teacherDsCache) return teacherDsCache
	const res = await fetchWithRetry(`https://api.notion.com/v1/data_sources/${DS_CLASS_SESSION}`, { headers: notionHeaders() })
	if (!res.ok) throw new Error(`수업 DB 정보를 읽지 못했습니다: ${res.status}`)
	const ds = await res.json()
	const id = ds?.properties?.["담당강사"]?.relation?.data_source_id
	if (!id) throw new Error('수업 DB "담당강사" 관계의 대상 DB를 찾지 못했습니다.')
	teacherDsCache = id
	return id
}

export async function listTeachers() {
	const pages = await queryAllPages(await teacherDataSourceId())
	return pages
		.map((p: Page) => ({ id: p.id as string, name: anyTitleText(p), role: selectName(p, "직책") ?? "" }))
		.filter((t) => t.name)
		.sort((a, b) => a.name.localeCompare(b.name, "ko"))
}

function sessionSummary(p: Page) {
	const when = p.properties?.["수업일시"]?.date ?? {}
	return {
		id: p.id as string,
		name: anyTitleText(p),
		start: when.start ?? null,
		end: when.end ?? null,
		time: [seoulTime(when.start), seoulTime(when.end)].filter(Boolean).join("–"),
		teacherIds: rel(p, "담당강사"),
		classIds: rel(p, "클래스"),
		makeup: checkboxValue(p, "보강"),
		students: rel(p, "출석").length,
		records: rel(p, "학습기록").length,
		attendanceSummary: formulaString(p, "출석현황") ?? "",
	}
}

// 서울 날짜(YYYY-MM-DD). 날짜만 있는 값은 그대로.
export function seoulDate(iso: string | null): string {
	if (!iso) return ""
	if (!iso.includes("T")) return iso.slice(0, 10)
	return new Date(new Date(iso).getTime() + 9 * 3_600_000).toISOString().slice(0, 10)
}
export function teacherFilter(teacherId?: string) {
	if (teacherId !== undefined && teacherId !== "" && !isId(teacherId)) throw new ClassRoomError(400, "강사 형식이 올바르지 않습니다.")
	return teacherId ? [{ property: "담당강사", relation: { contains: teacherId } }] : []
}
// 클래스 이모지·이름. 리포트처럼 클래스 DB "이모지"를 쓰고(글·선택·수식 어느 형식이든), 없으면 페이지 아이콘. 비면 화면이 색 이모지를 정한다.
function textOf(page: Page, prop: string): string {
	const p = page?.properties?.[prop]
	return (plain(page, prop) || p?.select?.name || p?.formula?.string || "").trim()
}
async function classInfo(classIds: string[]): Promise<Map<string, { name: string; emoji: string }>> {
	const pages = await getPages(classIds)
	return new Map(pages.map((c: Page) => [c.id as string, { name: anyTitleText(c), emoji: textOf(c, "이모지") || (c.icon?.type === "emoji" ? c.icon.emoji : "") }]))
}

// 하루의 수업(클래스 이모지·이름, 등원한 학생 수)과 보강 대기실(수업에 연결되지 않은 그날의 🔵 보강 출석). 강사를 고르면 그 강사의 수업만.
export async function loadDay(date: string, teacherId?: string) {
	const { start, end } = seoulDayRange(date)
	const range = [
		{ property: "수업일시", date: { on_or_after: start } },
		{ property: "수업일시", date: { before: end } },
	]
	const [sessions, attendances] = await Promise.all([
		queryAllPages(DS_CLASS_SESSION, { and: [...range, ...teacherFilter(teacherId)] }),
		queryAllPages(DS_ATTENDANCE, { and: range }),
	])
	const classes = await classInfo(sessions.map((p: Page) => rel(p, "클래스")[0]).filter(Boolean))
	const arrived = new Map<string, number>()
	for (const a of attendances) if (dateStart(a, "등원스템프")) for (const sid of rel(a, "수업")) arrived.set(sid, (arrived.get(sid) ?? 0) + 1)
	const waiting = attendances.filter((a: Page) => !rel(a, "수업").length && selectName(a, "출석 상태") === "🔵 보강")
	return {
		date,
		sessions: sessions.map((p: Page) => {
			const c = classes.get(rel(p, "클래스")[0])
			return { ...sessionSummary(p), className: c?.name ?? "", classEmoji: c?.emoji ?? "", arrived: arrived.get(p.id as string) ?? 0 }
		}).sort((a, b) => String(a.start).localeCompare(String(b.start))),
		makeupWaiting: waiting.map((a: Page) => ({
			attendanceId: a.id as string,
			registrationId: rel(a, "등록")[0] ?? null,
			name: studentName(a),
			className: formulaString(a, "클래스(보고서)") ?? "",
			start: a.properties?.["수업일시"]?.date?.start ?? null,
		})),
	}
}

// 달력 표시용: 기간(최대 6주) 안에서 수업이 있는 서울 날짜.
export async function loadDays(from: string, to: string, teacherId?: string) {
	const start = seoulDayRange(from).start, end = seoulDayRange(to).end
	const span = Date.parse(end) - Date.parse(start)
	if (span <= 0 || span > 42 * 86_400_000) throw new ClassRoomError(400, "기간이 올바르지 않습니다.")
	const sessions = await queryAllPages(DS_CLASS_SESSION, {
		and: [{ property: "수업일시", date: { on_or_after: start } }, { property: "수업일시", date: { before: end } }, ...teacherFilter(teacherId)],
	})
	return { dates: dedupe(sessions.map((p: Page) => seoulDate(p.properties?.["수업일시"]?.date?.start ?? null)).filter(Boolean)).sort() }
}

// ≡ 클래스 목록(v2.5.80): 고른 강사의 수업(기준일 4주 전 ~ 4주 뒤, 보강 제외)을 반별로 묶는다.
// 반마다 오늘 수업(시간순), 오늘 뒤 첫 수업, 오늘 전 마지막 수업을 돌려주고, 화면이 오늘 → 다음 → 마지막 순으로 연다.
export async function loadClasses(date: string, teacherId?: string) {
	const { start, end } = seoulDayRange(date)
	const t = Date.parse(start)
	const sessions = (await queryAllPages(DS_CLASS_SESSION, {
		and: [
			{ property: "수업일시", date: { on_or_after: new Date(t - 28 * 86_400_000).toISOString() } },
			{ property: "수업일시", date: { before: new Date(t + 29 * 86_400_000).toISOString() } },
			...teacherFilter(teacherId),
		],
	})).filter((p: Page) => !checkboxValue(p, "보강") && rel(p, "클래스").length)
		.sort((a: Page, b: Page) => String(a.properties?.["수업일시"]?.date?.start).localeCompare(String(b.properties?.["수업일시"]?.date?.start)))
	const byClass = new Map<string, Page[]>()
	for (const p of sessions) { const c = rel(p, "클래스")[0]; byClass.set(c, [...(byClass.get(c) ?? []), p]) }
	const info = await classInfo([...byClass.keys()])
	const brief = (p?: Page) => p ? { id: p.id as string, date: seoulDate(p.properties?.["수업일시"]?.date?.start ?? null), time: sessionSummary(p).time } : null
	// 주간 시간표(v2.5.87): 기준일이 있는 주(월~일)의 수업. 학생 수는 기준일에 가장 가까운 수업(오늘 → 다음 → 지난)의 출석 수.
	const dow = (Date.parse(start) / 86_400_000 + 3.375) % 7 // 1970-01-01(목) 기준, 서울 자정 = UTC 15시
	const monday = t - Math.floor(dow) * 86_400_000, sunday = monday + 7 * 86_400_000
	return {
		classes: [...byClass].map(([classId, list]) => {
			const when = (p: Page) => String(p.properties?.["수업일시"]?.date?.start ?? "")
			const today = list.filter((p) => when(p) >= start && when(p) < end)
			return {
				classId,
				name: info.get(classId)?.name ?? "",
				emoji: info.get(classId)?.emoji ?? "",
				today: today.map((p) => { const s = sessionSummary(p); return { id: s.id, start: s.start, end: s.end, time: s.time } }),
				next: brief(list.find((p) => when(p) >= end)),
				last: brief(list.filter((p) => when(p) < start).at(-1)),
				week: list.filter((p) => Date.parse(when(p)) >= monday && Date.parse(when(p)) < sunday).map((p) => { const s = sessionSummary(p); return { id: s.id, date: seoulDate(s.start), time: s.time } }),
				students: (today[0] ?? list.find((p) => when(p) >= end) ?? list.filter((p) => when(p) < start).at(-1))?.properties?.["출석"]?.relation?.length ?? 0,
			}
		}),
	}
}

// 같은 반의 앞뒤 수업(기준 9주 전 ~ 5주 뒤, 보강 수업 제외, 날짜순 최대 90개). 반이 없는 보강 수업은 빈 목록.
async function classSessionPages(session: Page, around?: string) {
	const classId = rel(session, "클래스")[0]
	const anchor = around ? seoulDayRange(around).start : session.properties?.["수업일시"]?.date?.start
	if (!classId || !anchor) return { sessions: [] as Page[], range: [] }
	const t = Date.parse(anchor)
	const range = [
		{ property: "수업일시", date: { on_or_after: new Date(t - 63 * 86_400_000).toISOString() } },
		{ property: "수업일시", date: { before: new Date(t + 36 * 86_400_000).toISOString() } },
	]
	const sessions = (await queryAllPages(DS_CLASS_SESSION, { and: [{ property: "클래스", relation: { contains: classId } }, ...range] }))
		.filter((p: Page) => !checkboxValue(p, "보강"))
		.sort((a: Page, b: Page) => String(a.properties?.["수업일시"]?.date?.start).localeCompare(String(b.properties?.["수업일시"]?.date?.start)))
		.slice(0, 90)
	return { sessions, range }
}

// 수업들의 출석(같은 기간 안, 수업 90개씩 나눠 조회)
async function sessionAttendances(sessions: Page[], range: unknown[]) {
	const attendances: Page[] = []
	for (let i = 0; i < sessions.length; i += 90) {
		const part = sessions.slice(i, i + 90)
		if (!part.length) continue
		attendances.push(...await queryAllPages(DS_ATTENDANCE, { and: [...range, { or: part.map((p: Page) => ({ property: "수업", relation: { contains: p.id } })) }] }))
	}
	return attendances
}
// 수업들의 학습기록(수업 90개씩 나눠 조회, 중복 제거)
async function sessionRecords(sessions: Page[]) {
	const found = new Map<string, Page>()
	for (let i = 0; i < sessions.length; i += 90) {
		const part = sessions.slice(i, i + 90)
		for (const r of await queryAllPages(DS_LEARNING_RECORD, { or: part.map((p: Page) => ({ property: "수업", relation: { contains: p.id } })) })) found.set(r.id as string, r)
	}
	return [...found.values()]
}

// 반 요약(v2.5.94, 기준 v2.5.96): 학생 탭 위 반 요약과 학생별 출석률·최근 평가 점수. 범위는 캘린더·반 학습기록과 같은 같은 반 앞뒤 수업(9주 전 ~ 5주 뒤, 보강 제외).
// 출석률 = 학부모 리포트 월간 보고서와 같은 기준(v2.5.96): (출석 + 보강, 또는 상태 없이 등원) ÷ 확인된 출석(출석·보강·결석). 아직 아무것도 입력되지 않은 출석과 앞으로의 수업은 뺀다.
// 과제이행률(v2.5.96) = 그 달에 마감인 과제 학습활동(과제 마감일 기준) 중 제출 비율. 아직 마감일이 오지 않은 과제는 뺀다.
// 월은 보고 있는 수업 날짜의 달(학생별 출석률도 그 달). 반이 없는 보강 수업은 그 수업만 센다.
// 평가 = 같은 범위 "평가" 학습기록의 학습활동 점수(정답 문항 ÷ 전체 문항 × 100, 전체 문항이 있는 것만). 반 평균(소수 한 자리, 리포트 평가 추이와 같음)은 최근 5개, 학생별은 가장 최근 점수.
export async function loadClassStats(sessionId: string, now = Date.now()) {
	if (!isId(sessionId)) throw new ClassRoomError(400, "수업 형식이 올바르지 않습니다.")
	const session = await getPage(sessionId) as Page
	let { sessions, range } = await classSessionPages(session)
	const attendances = sessions.length ? await sessionAttendances(sessions, range) : await getPages(rel(session, "출석"))
	if (!sessions.length) sessions = [session]
	const startOf = (p?: Page) => p?.properties?.["수업일시"]?.date?.start ?? null
	const byId = new Map(sessions.map((p) => [p.id as string, p]))
	const ym = seoulDate(startOf(session)).slice(0, 7), today = seoulDate(new Date(now).toISOString())
	const month = { present: 0, counted: 0 }, hw = { done: 0, total: 0 }
	const students: Record<string, { present: number; counted: number; score: number | null; scoreDate: string | null }> = {}
	const student = (id: string) => (students[id] ??= { present: 0, counted: 0, score: null, scoreDate: null })
	for (const a of attendances) {
		const start = startOf(byId.get(rel(a, "수업").find((id) => byId.has(id)) ?? ""))
		if (!start || Date.parse(start) > now || seoulDate(start).slice(0, 7) !== ym) continue
		const status = selectName(a, "출석 상태") ?? ""
		const present = status === "🟢 출석" || status === "🔵 보강" || (!status && !!dateStart(a, "등원스템프"))
		if (!present && status !== "🔴 결석") continue
		month.counted++
		if (present) month.present++
		const reg = rel(a, "등록")[0]
		if (reg) { const s = student(reg); s.counted++; if (present) s.present++ }
	}
	// 과제이행률·평가 점수: 같은 범위의 과제·평가 학습기록과 그 학습활동
	const records = (await sessionRecords(sessions)).filter((r) => ["과제", "평가"].includes(selectName(r, "구분") ?? ""))
	const acts: Page[] = []
	for (let i = 0; i < records.length; i += 90) {
		const part = records.slice(i, i + 90)
		acts.push(...await queryAllPages(DS_STUDY_ACTIVITY, { or: part.map((r) => ({ property: "학습기록", relation: { contains: r.id } })) }))
	}
	const homeworkIds = new Set(records.filter((r) => selectName(r, "구분") === "과제").map((r) => r.id as string))
	for (const a of acts) {
		if (!rel(a, "학습기록").some((id) => homeworkIds.has(id))) continue
		const due = seoulDate(dateStartOf(a.properties?.["과제 마감일"]) ?? null)
		if (!due || due.slice(0, 7) !== ym || due > today) continue
		hw.total++
		if (selectName(a, "과제상태") === HOMEWORK_SUBMITTED) hw.done++
	}
	const tests0 = records.filter((r) => selectName(r, "구분") === "평가")
	const summaries = new Map((await withSubjects(tests0)).map((r) => [r.id, r]))
	const tests = tests0.map((r) => {
		const start = startOf(byId.get(rel(r, "수업").find((id) => byId.has(id)) ?? ""))
		const scored = acts.filter((a) => rel(a, "학습기록").includes(r.id as string)).map((a) => ({ reg: rel(a, "등록")[0] ?? "", correct: numberOf(a, "정답 문항"), total: numberOf(a, "전체 문항") }))
			.filter((x) => x.total && x.total > 0 && typeof x.correct === "number").map((x) => ({ reg: x.reg, pct: (x.correct as number) / (x.total as number) * 100 }))
		const s = summaries.get(r.id as string)
		return { id: r.id as string, subject: s?.subject ?? "", range: s?.range ?? "", date: seoulDate(start), start: start ?? "", scored }
	}).filter((t) => t.scored.length && t.start && Date.parse(t.start) <= now).sort((a, b) => a.start.localeCompare(b.start))
	for (const t of tests) for (const x of t.scored) if (x.reg) { const s = student(x.reg); s.score = Math.round(x.pct); s.scoreDate = t.date }
	const pct = (n: number, d: number) => d ? Math.round(n / d * 100) : null
	return {
		month: { ym, ...month, rate: pct(month.present, month.counted) },
		homework: { ym, ...hw, rate: pct(hw.done, hw.total) },
		tests: tests.slice(-5).map((t) => ({ id: t.id, subject: t.subject, range: t.range, date: t.date, avg: Math.round(t.scored.reduce((n, x) => n + x.pct, 0) / t.scored.length * 10) / 10, count: t.scored.length })),
		students: Object.fromEntries(Object.entries(students).map(([id, s]) => [id, { ...s, rate: pct(s.present, s.counted) }])),
	}
}

// 반 학습기록(v2.5.89): 같은 반 앞뒤 수업(위 범위)의 학습기록을 수업 날짜·시각과 함께, 최근 수업부터.
// 반이 없는 보강 수업은 그 수업의 기록만. 학습기록 탭 날짜별 목록·교재 상세의 그 교재 기록에 쓴다.
export async function loadClassRecords(sessionId: string) {
	if (!isId(sessionId)) throw new ClassRoomError(400, "수업 형식이 올바르지 않습니다.")
	const session = await getPage(sessionId) as Page
	let { sessions } = await classSessionPages(session)
	if (!sessions.length) sessions = [session]
	const byId = new Map(sessions.map((p) => [p.id as string, p]))
	const pages = await sessionRecords(sessions), summaries = await withSubjects(pages)
	const startOfRecord = (r: Page) => { const sid = rel(r, "수업").find((id) => byId.has(id)); return sid ? byId.get(sid)?.properties?.["수업일시"]?.date?.start ?? "" : "" }
	// (v2.5.111 속도) 본문은 카드를 펼칠 때 record-body로 따로 읽는다
	const extra = await cardExtras(pages, [])
	const records = pages.map((r, i) => {
		const sid = rel(r, "수업").find((id) => byId.has(id)) ?? null
		const start = sid ? byId.get(sid)?.properties?.["수업일시"]?.date?.start ?? null : null
		return { ...summaries[i], ...extra(r), sessionId: sid, date: seoulDate(start), start }
	})
	records.sort((a, b) => String(b.start ?? "").localeCompare(String(a.start ?? "")) || a.title.localeCompare(b.title, "ko"))
	return { records: records.map(({ start, ...r }) => ({ ...r, time: seoulTime(start) })) }
}

// 반 주간 캘린더: 같은 반의 앞뒤 수업(9주 전 ~ 5주 뒤, 보강 수업 제외)과 수업별 출석 요약.
// present = 출석 처리됐거나 등원한 학생, absent = 결석·보강, missing = 상태도 등원도 없는 학생. 반이 없는 보강 수업은 빈 목록.
export async function loadClassSessions(sessionId: string, around?: string) {
	if (!isId(sessionId)) throw new ClassRoomError(400, "수업 형식이 올바르지 않습니다.")
	if (around !== undefined && around !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(around)) throw new ClassRoomError(400, "날짜 형식이 올바르지 않습니다.")
	const session = await getPage(sessionId) as Page
	const { sessions, range } = await classSessionPages(session, around)
	if (!sessions.length) return { sessions: [] }
	const attendances = await sessionAttendances(sessions, range)
	// 과제 현황(v2.5.103): 같은 범위 과제 학습기록의 학습활동을 "과제 마감일"(서울 날짜)로 모아, 수업 날짜마다 그날 마감 과제의 제출 수/전체.
	const homeworkRecords = (await sessionRecords(sessions)).filter((r) => selectName(r, "구분") === "과제")
	const dueByDate = new Map<string, { done: number; total: number }>()
	for (let i = 0; i < homeworkRecords.length; i += 90) {
		const part = homeworkRecords.slice(i, i + 90)
		for (const a of await queryAllPages(DS_STUDY_ACTIVITY, { or: part.map((r) => ({ property: "학습기록", relation: { contains: r.id } })) })) {
			const due = seoulDate(dateStartOf(a.properties?.["과제 마감일"]) ?? null)
			if (!due) continue
			const d = dueByDate.get(due) ?? { done: 0, total: 0 }
			d.total++
			if (selectName(a, "과제상태") === HOMEWORK_SUBMITTED) d.done++
			dueByDate.set(due, d)
		}
	}
	return {
		sessions: sessions.map((p: Page) => {
			const mine = attendances.filter((a) => rel(a, "수업").includes(p.id as string))
			const status = (a: Page) => selectName(a, "출석 상태") ?? ""
			const start = p.properties?.["수업일시"]?.date?.start ?? null
			return {
				id: p.id as string,
				date: seoulDate(start),
				time: [seoulTime(start), seoulTime(p.properties?.["수업일시"]?.date?.end ?? null)].filter(Boolean).join("–"),
				total: rel(p, "출석").length,
				present: mine.filter((a) => status(a) === "🟢 출석" || (!status(a) && dateStart(a, "등원스템프"))).length,
				absent: mine.filter((a) => status(a) === "🔴 결석" || status(a) === "🔵 보강").length,
				missing: mine.filter((a) => !status(a) && !dateStart(a, "등원스템프")).length,
				hwDone: dueByDate.get(seoulDate(start))?.done ?? 0,
				hwTotal: dueByDate.get(seoulDate(start))?.total ?? 0,
			}
		}),
	}
}

// unitNames(v2.5.126): 학습기록 "선택 단원" 이름 — 고른 단원이 있으면 unit은 그 이름들(unitTextOf).
function recordSummary(r: Page, unitNames: Map<string, string> = new Map()) {
	return {
		id: r.id as string,
		title: anyTitleText(r),
		kind: selectName(r, "구분") ?? "",
		bookId: rel(r, "진도교재")[0] ?? null,
		topic: plain(r, "주제"),
		range: plain(r, "범위"),
		unit: unitTextOf(r, unitNames),
		unitIds: unitIdsOf(r),
		content: plain(r, "내용"),
		makeup: checkboxValue(r, "보강"),
		registrationIds: rel(r, "등록"),
		activities: rel(r, "학습활동").length,
		activityStatus: selectName(r, "활동 생성 상태") ?? "",
	}
}

// 기록 카드(v2.5.95, 학부모 리포트 학습기록 카드와 같은 규칙): 과제는 제출 수·마감일, 평가는 평균 점수, 그리고 페이지 본문(블록).
// 본문은 bodyIds(화면에 먼저 보이는 최근 기록)만 읽는다(리포트처럼 최근 것만, 동시 6개). 읽기 실패는 빈 본문.
async function cardExtras(records: Page[], bodyIds: string[]) {
	const graded = records.filter((r) => ["과제", "평가"].includes(selectName(r, "구분") ?? ""))
	const acts: Page[] = []
	for (let i = 0; i < graded.length; i += 90) {
		const part = graded.slice(i, i + 90)
		acts.push(...await queryAllPages(DS_STUDY_ACTIVITY, { or: part.map((r) => ({ property: "학습기록", relation: { contains: r.id } })) }))
	}
	const bodies = new Map(await mapWithConcurrency(dedupe(bodyIds), 6, async (id: string) => [id, await readPageBodyBlocks(id)] as const) as [string, unknown[]][])
	return (r: Page) => {
		const kind = selectName(r, "구분") ?? "", mine = acts.filter((a) => rel(a, "학습기록").includes(r.id as string))
		const scored = mine.map((a) => ({ c: numberOf(a, "정답 문항"), t: numberOf(a, "전체 문항") })).filter((x) => x.t && x.t > 0 && typeof x.c === "number")
		return {
			homework: kind === "과제" && mine.length ? {
				submitted: mine.filter((a) => selectName(a, "과제상태") === HOMEWORK_SUBMITTED).length,
				total: mine.length,
				due: seoulDate(mine.map((a) => dateStartOf(a.properties?.["과제 마감일"])).find(Boolean) ?? null) || null,
			} : null,
			score: kind === "평가" && scored.length ? { avg: Math.round(scored.reduce((n, x) => n + (x.c as number) / (x.t as number) * 100, 0) / scored.length), count: scored.length } : null,
			body: bodies.get(r.id as string) ?? [],
		}
	}
}

// 기록 카드 제목용 교재 이름(v2.5.89, 리포트 학습기록 카드 "교재 · 범위"): 라이브러리(교재) 이름 → 진도교재 이름(괄호 앞) → 주제.
async function withSubjects(records: Page[]) {
	const ids = dedupe(records.flatMap((r) => [rel(r, "교재")[0], rel(r, "진도교재")[0]].filter(Boolean) as string[]))
	const names = new Map((await getPages(ids)).map((b) => [b.id as string, anyTitleText(b)]))
	const unitNames = await unitNamesOf(records)
	return records.map((r) => {
		const regular = names.get(rel(r, "교재")[0] ?? ""), progress = names.get(rel(r, "진도교재")[0] ?? "")
		return { ...recordSummary(r, unitNames), subject: regular || (progress ?? "").replace(/\(.*\)$/, "").trim() || plain(r, "주제") }
	})
}

// 수업 상세: 학생(출석)·오늘 마감 과제·학습기록.
export async function loadSession(sessionId: string) {
	if (!isId(sessionId)) throw new ClassRoomError(400, "수업 형식이 올바르지 않습니다.")
	const session = await getPage(sessionId) as Page
	const attendances = await getPages(rel(session, "출석"))
	const students = attendances
		.map((a) => ({
			attendanceId: a.id as string,
			registrationId: rel(a, "등록")[0] ?? null,
			name: studentName(a),
			status: selectName(a, "출석 상태") ?? "",
			arrivedAt: dateStart(a, "등원스템프"),
			leftAt: dateStart(a, "하원스템프"),
			memo: plain(a, "메모"),
			comment: plain(a, "선생님 한마디"),
			dueActivityIds: rel(a, "과제"),
		}))
		.sort((x, y) => x.name.localeCompare(y.name, "ko"))
	// 오늘 마감 과제: 출석의 "과제" 관계(이 출석이 마감인 학습활동). 학습기록별로 묶는다.
	const dueIds = dedupe(students.flatMap((s) => s.dueActivityIds))
	const dueActivities = await getPages(dueIds)
	const dueRecordIds = dedupe(dueActivities.flatMap((a) => rel(a, "학습기록")))
	const dueRecords = await getPages(dueRecordIds)
	const attendanceByActivity = new Map<string, string>()
	for (const s of students) for (const id of s.dueActivityIds) attendanceByActivity.set(id, s.attendanceId)
	const homeworkDue = dueRecords.map((r) => {
		const items = dueActivities
			.filter((a) => rel(a, "학습기록").includes(r.id))
			.map((a) => ({
				activityId: a.id as string,
				attendanceId: attendanceByActivity.get(a.id) ?? null,
				registrationId: rel(a, "등록")[0] ?? null,
				submitted: selectName(a, "과제상태") === HOMEWORK_SUBMITTED,
			}))
		return { recordId: r.id as string, title: anyTitleText(r), range: plain(r, "범위"), items }
	})
	const recordPages = await getPages(rel(session, "학습기록"))
	const extra = await cardExtras(recordPages, []) // (v2.5.111 속도) 본문은 펼칠 때 record-body로
	const records = (await withSubjects(recordPages)).map((r, i) => ({ ...r, ...extra(recordPages[i]) }))
	return {
		session: await (async () => { const c = (await classInfo(rel(session, "클래스").slice(0, 1))).get(rel(session, "클래스")[0]); return { ...sessionSummary(session), className: c?.name ?? "", classEmoji: c?.emoji ?? "" } })(),
		students: students.map(({ dueActivityIds: _drop, ...s }) => s),
		homeworkDue,
		records,
	}
}

// 학생 명부(v2.5.93): 이 수업 학생의 학교·학년·연락처와 학생 보고서 주소용 토큰. 학생 탭을 열 때만 읽는다(읽기만).
// 학교·학년·학생 연락처는 등록의 "학생정보"(원생) 페이지에서 리포트와 같은 속성으로, 우선 연락처는 등록의 "학부모 연락처"
// (알림톡 "우선 연락 대상"과 같은 값). 보고서 토큰이 꺼져 있으면("disabled:", adminShared.parseTokenValue와 같은 규칙) 주소를 주지 않는다.
export async function loadRoster(sessionId: string) {
	if (!isId(sessionId)) throw new ClassRoomError(400, "수업 형식이 올바르지 않습니다.")
	const session = await getPage(sessionId) as Page
	const attendances = await getPages(rel(session, "출석"))
	const regs = new Map((await getPages(dedupe(attendances.map((a) => rel(a, "등록")[0]).filter(Boolean) as string[]))).map((r) => [r.id as string, r]))
	const people = new Map((await getPages(dedupe([...regs.values()].map((r) => rel(r, "학생정보")[0]).filter(Boolean) as string[]))).map((p) => [p.id as string, p]))
	const students = attendances.map((a) => {
		const reg = regs.get(rel(a, "등록")[0] ?? ""), person = reg ? people.get(rel(reg, "학생정보")[0] ?? "") : undefined
		const raw = reg ? propText(reg.properties?.["토큰"]).trim() : "", off = raw.startsWith("disabled:")
		const of = (p: Page | undefined, name: string) => p ? propText(p.properties?.[name]).trim() : ""
		return {
			attendanceId: a.id as string,
			registrationId: reg?.id as string ?? null,
			name: studentName(a),
			school: of(person, "학교(설문)"),
			grade: of(person, "학년(설문)"),
			studentPhone: of(person, "학생 연락처"),
			parentPhone: of(reg, "학부모 연락처"),
			reportToken: raw && !off ? raw : null,
			reportOff: off,
		}
	}).sort((x, y) => x.name.localeCompare(y.name, "ko"))
	return { students }
}

async function className(session: Page): Promise<string> {
	const classId = rel(session, "클래스")[0]
	if (!classId) return ""
	return anyTitleText(await getPage(classId) as Page)
}

// 이 수업 학생들의 진도교재(상태·진도방식·템플릿·가진 학생). 화면이 반 교재 / 템플릿 묶음 / 학생별로 나눈다.
export async function loadBooks(sessionId: string) {
	if (!isId(sessionId)) throw new ClassRoomError(400, "수업 형식이 올바르지 않습니다.")
	const session = await getPage(sessionId) as Page
	const registrations = await getPages(rel(session, "등록"))
	const owners = new Map<string, string[]>()
	for (const r of registrations) for (const b of rel(r, "진도교재")) owners.set(b, [...(owners.get(b) ?? []), r.id])
	const books = await getPages(Array.from(owners.keys()))
	// 교재 카드(v2.5.80): 리포트 교재 카드처럼 표지(라이브러리 "북커버")·쪽수·진행도·최근 학습 범위를 함께 준다.
	// v2.5.125: 라이브러리 교재의 단원(이름·시작쪽)도 함께 준다 — 기록 만들기에서 범위를 넣으면 화면이 바로 단원을 찾는다.
	// 라이브러리 복사본이 준비됐으면 표지·쪽수·단원을 Supabase에서 읽는다.
	const { regulars, unitsBy } = await libraryInfo(dedupe(books.flatMap((b) => libraryIds(b))))
	return {
		registrations: registrations.map((r) => ({ id: r.id as string, name: plain(r, "이름") || anyTitleText(r) })),
		books: books
			.map((b) => ({
				id: b.id as string,
				name: anyTitleText(b),
				status: statusName(b, "진행상태") ?? "",
				mode: selectName(b, "진도방식") ?? "",
				templateId: rel(b, "반별교재")[0] ?? null,
				ownerIds: owners.get(b.id) ?? [],
				...(() => {
					const libId = libraryIds(b)[0] ?? null, rp = libId ? regulars.get(libId) : undefined
					const progress = propNumber(b.properties?.["진행도"])
					return {
						libraryId: libId,
						units: (libId && unitsBy.get(libId)) || [],
						cover: rp?.cover ?? "",
						pages: rp?.pages ?? null,
						progress: progress === null ? null : Math.round(progress * 100),
						recent: propText(b.properties?.["최근 학습 범위"]),
					}
				})(),
			}))
			.sort((a, b) => a.name.localeCompare(b.name, "ko")),
	}
}

// 라이브러리 교재들의 표지·쪽수와 단원(v2.5.125). 복사본이 없으면 Notion에서 읽는다(단원은 실패해도 빈 목록).
type LibUnit = { id: string; name: string; page: number | null }
async function libraryInfo(ids: string[]): Promise<{ regulars: Map<string, { cover: string; pages: number | null }>; unitsBy: Map<string, LibUnit[]> }> {
	const regulars = new Map<string, { cover: string; pages: number | null }>(), unitsBy = new Map<string, LibUnit[]>()
	if (!ids.length) return { regulars, unitsBy }
	const push = (bookId: string | null, u: LibUnit) => { if (bookId) unitsBy.set(bookId, [...(unitsBy.get(bookId) ?? []), u]) }
	if (await libraryCopyReady()) {
		const [rows, units] = await Promise.all([readBooks(ids), readUnits(ids)])
		for (const r of rows) regulars.set(r.id, { cover: r.cover, pages: r.pages })
		for (const u of units) push(u.book_id, { id: u.id, name: u.name, page: u.start_page })
		return { regulars, unitsBy }
	}
	for (const r of await getPages(ids)) regulars.set(r.id as string, { cover: fileUrlOf(r.properties?.["북커버"]) ?? "", pages: propNumber(r.properties?.["전체 페이지"]) })
	try {
		const src = await textbookSources()
		const pages = await queryAllPages(src.units, { or: ids.map((id) => ({ property: src.unitsLink, relation: { contains: id } })) })
		const rows = sortUnits(pages.map((p: Page) => ({ id: p.id as string, name: propText(p.properties?.["단원명"]).trim(), start_page: propNumber(p.properties?.["시작페이지"]), book: rel(p, src.unitsLink) })))
		for (const u of rows) for (const b of u.book.filter((x: string) => ids.includes(x))) push(b, { id: u.id, name: u.name, page: u.start_page })
	} catch (err) {
		console.error("[class-room] 단원목록 읽기 실패(단원 미리 보기 없음):", (err as Error).message)
	}
	return { regulars, unitsBy }
}

// 한 학습기록의 학생별 학습활동(제출 상태·점수).
export async function loadActivities(recordId: string) {
	if (!isId(recordId)) throw new ClassRoomError(400, "기록 형식이 올바르지 않습니다.")
	const record = await getPage(recordId) as Page
	const activities = await getPages(rel(record, "학습활동"))
	const attendances = await getPages(dedupe(activities.flatMap((a) => rel(a, "출석"))))
	const nameByAttendance = new Map(attendances.map((a) => [a.id as string, studentName(a)]))
	return {
		record: recordSummary(record, await unitNamesOf([record])),
		activities: activities
			.map((a) => {
				const attendanceId = rel(a, "출석")[0] ?? null
				return {
					id: a.id as string,
					attendanceId,
					registrationId: rel(a, "등록")[0] ?? null,
					name: (attendanceId && nameByAttendance.get(attendanceId)) || anyTitleText(a),
					submitted: selectName(a, "과제상태") === HOMEWORK_SUBMITTED,
					correct: numberOf(a, "정답 문항"),
					total: numberOf(a, "전체 문항"),
				}
			})
			.sort((x, y) => x.name.localeCompare(y.name, "ko")),
	}
}

// 학생 공간: 이 등록(반)의 최근 과제·평가와 지난 메모. 학습활동의 "구분"은 학습기록에서 가져온 롤업이다.
function rollupSelect(page: Page, prop: string): string {
	const arr = page?.properties?.[prop]?.rollup?.array ?? []
	return arr.map((x: any) => x?.select?.name).find(Boolean) ?? ""
}
function formulaDate(page: Page, prop: string): string | null {
	const f = page?.properties?.[prop]?.formula
	return f?.date?.start ?? (typeof f?.string === "string" && /^d{4}-d{2}-d{2}/.test(f.string) ? f.string : null)
}
export async function loadStudent(registrationId: string) {
	if (!isId(registrationId)) throw new ClassRoomError(400, "학생 형식이 올바르지 않습니다.")
	const [acts, memos] = await Promise.all([
		queryDataSource(DS_STUDY_ACTIVITY, { filter: { property: "등록", relation: { contains: registrationId } }, sorts: [{ timestamp: "created_time", direction: "descending" }], page_size: 40 }),
		queryDataSource(DS_ATTENDANCE, {
			filter: { and: [{ property: "등록", relation: { contains: registrationId } }, { property: "메모", rich_text: { is_not_empty: true } }] },
			sorts: [{ property: "수업일시", direction: "descending" }],
			page_size: 10,
		}),
	])
	const activities = ((acts as any).results ?? []) as Page[]
	const recordIds = dedupe(activities.flatMap((a) => rel(a, "학습기록")))
	const records = new Map((await getPages(recordIds)).map((r) => [r.id as string, r]))
	const named = (a: Page) => { const r = records.get(rel(a, "학습기록")[0]); return r ? { title: anyTitleText(r), range: plain(r, "범위") } : { title: anyTitleText(a), range: "" } }
	const kindOf = (a: Page) => rollupSelect(a, "구분") || (records.get(rel(a, "학습기록")[0]) ? selectName(records.get(rel(a, "학습기록")[0])!, "구분") ?? "" : "")
	return {
		homework: activities.filter((a) => kindOf(a) === "과제").slice(0, 8).map((a) => ({ id: a.id as string, ...named(a), due: formulaDate(a, "과제 마감일"), submitted: selectName(a, "과제상태") === HOMEWORK_SUBMITTED })),
		tests: activities.filter((a) => kindOf(a) === "평가" && numberOf(a, "전체 문항")).slice(0, 5).map((a) => ({ id: a.id as string, ...named(a), correct: numberOf(a, "정답 문항"), total: numberOf(a, "전체 문항") })),
		memos: (((memos as any).results ?? []) as Page[]).map((m) => ({ attendanceId: m.id as string, date: dateStart(m, "수업일시"), memo: plain(m, "메모") })),
	}
}

// ---------- 저장 (편집 모드의 [저장]) ----------
export async function saveAttendance(items: unknown) {
	if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) throw new ClassRoomError(400, "저장할 내용이 없습니다.")
	const updates = items.map((it: any) => {
		if (!isId(it?.attendanceId)) throw new ClassRoomError(400, "출석 형식이 올바르지 않습니다.")
		const props: Record<string, unknown> = { ...touched() }
		if (it.status !== undefined) {
			if (it.status !== "" && !(ATTENDANCE_STATUSES as readonly string[]).includes(it.status)) throw new ClassRoomError(400, "출석 상태가 올바르지 않습니다.")
			props["출석 상태"] = { select: it.status ? { name: it.status } : null }
		}
		if (it.memo !== undefined) props["메모"] = richText(String(it.memo))
		if (it.comment !== undefined) props["선생님 한마디"] = richText(String(it.comment))
		return { id: it.attendanceId as string, props }
	})
	const saved = await mapWithConcurrency(updates, 3, (u) => updatePageProperties(u.id, u.props)) as Page[]
	await mirrorSaved("cr_attendance", saved) // 복사본 함께 쓰기(v2.5.115, v2.5.116부터 Notion 수정 응답을 그대로)
	return { saved: updates.length }
}

export async function saveActivities(items: unknown) {
	if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) throw new ClassRoomError(400, "저장할 내용이 없습니다.")
	const updates = items.map((it: any) => {
		if (!isId(it?.activityId)) throw new ClassRoomError(400, "학습활동 형식이 올바르지 않습니다.")
		const props: Record<string, unknown> = { ...touched() }
		if (it.submitted !== undefined) props["과제상태"] = { select: { name: it.submitted ? HOMEWORK_SUBMITTED : HOMEWORK_MISSING } }
		for (const [key, prop] of [["correct", "정답 문항"], ["total", "전체 문항"]] as const) {
			if (it[key] === undefined) continue
			const v = it[key]
			if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1000)) throw new ClassRoomError(400, "점수가 올바르지 않습니다.")
			props[prop] = { number: v }
		}
		if (typeof it.correct === "number" && typeof it.total === "number" && it.correct > it.total) throw new ClassRoomError(400, "맞힌 문항이 전체 문항보다 많습니다.")
		return { id: it.activityId as string, props }
	})
	const saved = await mapWithConcurrency(updates, 3, (u) => updatePageProperties(u.id, u.props)) as Page[]
	await mirrorSaved("cr_activities", saved) // 복사본 함께 쓰기(v2.5.115, v2.5.116부터 Notion 수정 응답을 그대로)
	return { saved: updates.length }
}

// ---------- 학습기록 만들기·고치기 ----------
type SessionContext = { session: Page; attendances: Page[]; regToAttendance: Map<string, string[]>; className: string; makeup: boolean; date: string | null }
async function sessionContext(sessionId: string): Promise<SessionContext> {
	if (!isId(sessionId)) throw new ClassRoomError(400, "수업 형식이 올바르지 않습니다.")
	const session = await getPage(sessionId) as Page
	const attendances = await getPages(rel(session, "출석"))
	const regToAttendance = new Map<string, string[]>()
	for (const a of attendances) for (const r of rel(a, "등록")) regToAttendance.set(r, [...(regToAttendance.get(r) ?? []), a.id])
	return { session, attendances, regToAttendance, className: await className(session), makeup: checkboxValue(session, "보강"), date: dateStart(session, "수업일시") }
}

// 교재 기준 대상 등록: 직접 고른 학생이 있으면 그 학생들(수업 학생 중), 아니면
// 그룹 진도(보강 수업 제외)는 수업 학생 전체, 그 밖에는 그 교재를 가진 수업 학생.
function targetRegistrations(ctx: SessionContext, book: Page | null, chosen: string[] | null, registrations: Page[]): string[] {
	const sessionRegs = rel(ctx.session, "등록")
	if (chosen && chosen.length) {
		const picked = chosen.filter((r) => sessionRegs.includes(r))
		if (!picked.length) throw new ClassRoomError(400, "이 수업의 학생을 골라 주세요.")
		return picked
	}
	if (!book) return sessionRegs
	if (selectName(book, "진도방식") === GROUP_PROGRESS && !ctx.makeup) return sessionRegs
	const owners = registrations.filter((r) => rel(r, "진도교재").includes(book.id)).map((r) => r.id as string)
	if (!owners.length) throw new ClassRoomError(400, "이 교재를 가진 학생이 이 수업에 없습니다.")
	return owners
}

// 기록을 만든다. books가 있으면 교재마다 하나씩(템플릿 묶음 일괄 생성 포함), 없으면 교재 없는 기록 하나.
// 같은 수업에 같은 구분·같은 교재(교재 없으면 같은 주제) 기록이 이미 있으면 새로 만들지 않고 그 기록을 돌려준다.
export async function createRecords(body: any) {
	const kind = body?.kind
	if (!(KINDS as readonly string[]).includes(kind)) throw new ClassRoomError(400, "학습·과제·평가 중에서 골라 주세요.")
	const bookIds = body?.bookIds === undefined ? [] : ids(body.bookIds, 30)
	const chosen = body?.registrationIds === undefined ? null : ids(body.registrationIds)
	const topic = typeof body?.topic === "string" ? body.topic.trim().slice(0, 200) : ""
	// 기록 만들기 창(v2.5.79)은 범위·내용을 처음부터 함께 보낸다. 새로 만드는 기록에만 넣는다.
	for (const key of ["range", "content"]) if (body?.[key] !== undefined && typeof body[key] !== "string") throw new ClassRoomError(400, "입력 형식이 올바르지 않습니다.")
	const range = typeof body?.range === "string" ? body.range.trim().slice(0, 200) : ""
	const content = typeof body?.content === "string" ? body.content.trim().slice(0, 2000) : ""
	// 고른 단원(v2.5.126): unitBookId(라이브러리 교재)가 같은 기록에만 넣는다. 학습기록 DB에 "선택 단원"이 없으면 넣지 않는다.
	const unitIds = cleanUnitIds(body?.unitIds), unitBookId = typeof body?.unitBookId === "string" ? body.unitBookId : null
	const unitsOn = !!(unitIds?.length && unitBookId) && await selectedUnitsEnabled()
	const ctx = await sessionContext(body?.sessionId)
	const registrations = await getPages(rel(ctx.session, "등록"))
	const existing = await getPages(rel(ctx.session, "학습기록"))
	const results: { id: string; title: string; created: boolean }[] = []
	const targets: (Page | null)[] = bookIds.length ? await getPages(bookIds) : [null]
	for (const book of targets) {
		const same = existing.find((r) => selectName(r, "구분") === kind && (book ? rel(r, "진도교재")[0] === book.id : !rel(r, "진도교재").length && plain(r, "주제") === topic))
		if (same && !chosen) {
			results.push({ id: same.id, title: anyTitleText(same), created: false })
			continue
		}
		const regs = targetRegistrations(ctx, book, chosen, registrations)
		const attendanceIds = dedupe(regs.flatMap((r) => ctx.regToAttendance.get(r) ?? []))
		const regularBookId = book ? libraryIds(book)[0] ?? null : null
		const regularBook = regularBookId ? await getPage(regularBookId) as Page : null
		const subjectIds = regularBook ? rel(regularBook, "과목") : []
		const subject = book ? (regularBook ? anyTitleText(regularBook) : anyTitleText(book)) : topic || kind
		const props: Record<string, unknown> = {
			"학습": { title: [{ text: { content: recordTitle(kind, subject, ctx.className, ctx.date) } }] },
			"구분": { select: { name: kind } },
			"출석": relation(attendanceIds),
			"등록": relation(regs),
			"수업": relation([ctx.session.id]),
			...touched(),
		}
		if (book) props["진도교재"] = relation([book.id])
		if (regularBookId) props["교재"] = relation([regularBookId])
		if (subjectIds.length) props["과목"] = relation(subjectIds)
		if (topic) props["주제"] = richText(topic)
		if (range) props["범위"] = richText(range)
		if (content) props["내용"] = richText(content)
		if (ctx.makeup) props["보강"] = { checkbox: true }
		if (unitsOn && regularBookId === unitBookId) props[SELECTED_UNITS] = relation(unitIds!)
		const page = await createPage(DS_LEARNING_RECORD, props) as Page
		existing.push(page)
		results.push({ id: page.id as string, title: anyTitleText(page) || String((props["학습"] as any).title[0].text.content), created: true })
	}
	// 복사본 함께 쓰기(v2.5.115): 새 기록과, "학습기록" 관계가 바뀐 수업
	await mirrorJobs([["cr_records", results.map((r) => r.id)], ["cr_sessions", [ctx.session.id as string]]])
	return { records: results, unitsSaved: unitIds?.length ? unitsOn : undefined }
}

export async function updateRecord(body: any) {
	if (!isId(body?.recordId)) throw new ClassRoomError(400, "기록 형식이 올바르지 않습니다.")
	const record = await getPage(body.recordId) as Page
	const props: Record<string, unknown> = { ...touched() }
	for (const [key, prop] of [["topic", "주제"], ["range", "범위"], ["content", "내용"]] as const) {
		if (body[key] === undefined) continue
		if (typeof body[key] !== "string") throw new ClassRoomError(400, "입력 형식이 올바르지 않습니다.")
		props[prop] = richText(body[key].trim())
	}
	// 고른 단원(v2.5.126): unitIds를 보내면(빈 배열이면 지움) "선택 단원"을 그대로 바꾼다. 속성이 없는 학원은 건너뛴다.
	const unitIds = cleanUnitIds(body?.unitIds)
	const unitsOn = unitIds !== null && await selectedUnitsEnabled()
	if (unitsOn) props[SELECTED_UNITS] = relation(unitIds!)
	let bookId = rel(record, "진도교재")[0] ?? null
	let regularBook: Page | null = null
	if (body.bookId !== undefined) {
		if (body.bookId !== null && !isId(body.bookId)) throw new ClassRoomError(400, "교재 형식이 올바르지 않습니다.")
		bookId = body.bookId
		props["진도교재"] = relation(bookId ? [bookId] : [])
		const book = bookId ? await getPage(bookId) as Page : null
		const regularBookId = book ? libraryIds(book)[0] ?? null : null
		regularBook = regularBookId ? await getPage(regularBookId) as Page : null
		props["교재"] = relation(regularBookId ? [regularBookId] : [])
		props["과목"] = relation(regularBook ? rel(regularBook, "과목") : [])
	}
	// 교재나 주제가 바뀌면 제목도 규칙대로 다시 짓는다.
	if (body.bookId !== undefined || body.topic !== undefined) {
		const sessionId = rel(record, "수업")[0]
		const session = sessionId ? await getPage(sessionId) as Page : null
		const topic = body.topic !== undefined ? String(body.topic).trim() : plain(record, "주제")
		let subject = topic || (selectName(record, "구분") ?? "")
		if (bookId) {
			if (!regularBook && body.bookId === undefined) {
				const book = await getPage(bookId) as Page
				const rb = libraryIds(book)[0]
				regularBook = rb ? await getPage(rb) as Page : null
				subject = regularBook ? anyTitleText(regularBook) : anyTitleText(book)
			} else subject = regularBook ? anyTitleText(regularBook) : anyTitleText(await getPage(bookId) as Page)
		}
		const kind = selectName(record, "구분") ?? "학습"
		props["학습"] = { title: [{ text: { content: recordTitle(kind, subject, session ? await className(session) : "", session ? dateStart(session, "수업일시") : null) } }] }
	}
	await mirrorSaved("cr_records", [await updatePageProperties(record.id, props) as Page]) // 복사본 함께 쓰기(v2.5.115)
	return { ok: true, unitsSaved: unitIds?.length ? unitsOn : undefined }
}

// 기존 [학습활동 생성] 버튼과 같은 처리. 같은 기록을 두 번 눌러도 처리 중이면 새로 만들지 않는다.
export async function createActivities(recordId: string) {
	if (!isId(recordId)) throw new ClassRoomError(400, "기록 형식이 올바르지 않습니다.")
	const record = await getPage(recordId) as Page
	const kind = selectName(record, "구분")
	if (!kind || !(KINDS as readonly string[]).includes(kind)) throw new ClassRoomError(400, "구분이 학습·과제·평가인 기록만 학습활동을 만들 수 있습니다.")
	if (isRunning(record, ASSIGNMENT_GEN_STATUS_SPEC)) return { status: "already_processing" }
	const registrationIds = dedupe(rel(record, "등록"))
	if (!registrationIds.length) throw new ClassRoomError(400, "이 기록에 연결된 학생이 없습니다.")
	await setAssignmentGenRunning(recordId)
	runInBackground(async () => {
		try {
			await finishCreateAssignment(recordId, kind, registrationIds)
			await setAssignmentGenDone(recordId)
			// 복사본 함께 쓰기(v2.5.115): 기록·새 학습활동·마감 과제가 붙은 출석
			try {
				const [rec] = await mirrorPageIds("cr_records", [recordId])
				const acts = await mirrorPageIds("cr_activities", rel(rec ?? {}, "학습활동"))
				await mirrorPageIds("cr_attendance", acts.flatMap((a) => rel(a, "출석")))
			} catch (err) { console.error("[classRoom] 복사본 함께 쓰기 실패(다음 증분이 맞춤):", (err as Error).message) }
		} catch (err) {
			await setAssignmentGenError(recordId, (err as Error).message)
		}
	})
	return { status: "started", students: registrationIds.length }
}

// ---------- 보강 대기실 ----------
// 고른 보강 출석들로 보강 수업을 만든다(1명=1:1, 여러 명=그룹). 시간표·클래스는 비워 두고 "보강"을 체크한다.
export async function createMakeupSession(body: any) {
	const attendanceIds = ids(body?.attendanceIds, 30)
	if (!attendanceIds.length) throw new ClassRoomError(400, "보강 학생을 골라 주세요.")
	if (!isId(body?.teacherId)) throw new ClassRoomError(400, "담당강사를 골라 주세요.")
	const start = typeof body?.start === "string" && !Number.isNaN(Date.parse(body.start)) ? body.start : null
	const end = typeof body?.end === "string" && !Number.isNaN(Date.parse(body.end)) ? body.end : null
	if (!start) throw new ClassRoomError(400, "보강 시각을 정해 주세요.")
	const attendances = await getPages(attendanceIds)
	for (const a of attendances) {
		if (rel(a, "수업").length) throw new ClassRoomError(409, `${studentName(a)} 학생은 이미 수업에 연결돼 있습니다.`)
		if (selectName(a, "출석 상태") !== "🔵 보강") throw new ClassRoomError(409, `${studentName(a)} 학생은 보강 출석이 아닙니다.`)
	}
	const regs = dedupe(attendances.flatMap((a) => rel(a, "등록")))
	const label = `${seoulLabel(start)} ${seoulTime(start)}`.trim()
	const session = await createPage(DS_CLASS_SESSION, {
		"이름": { title: [{ text: { content: `보강 ${label}` } }] },
		"수업일시": { date: { start, ...(end ? { end } : {}) } },
		"담당강사": relation([body.teacherId]),
		"보강": { checkbox: true },
		"등록": relation(regs),
		"출석": relation(attendanceIds),
	}) as Page
	await mapWithConcurrency(attendanceIds, 3, (id) =>
		updatePageProperties(id, { "수업": relation([session.id]), "담당강사": relation([body.teacherId]), ...touched() }))
	await mirrorJobs([["cr_sessions", [session.id as string]], ["cr_attendance", attendanceIds]]) // 복사본 함께 쓰기(v2.5.115)
	return { sessionId: session.id as string }
}

// 보강 출석 하나를 보강 수업에서 떼어 대기실로 돌린다(담당강사도 비움).
export async function unlinkMakeup(attendanceId: string) {
	if (!isId(attendanceId)) throw new ClassRoomError(400, "출석 형식이 올바르지 않습니다.")
	const attendance = await getPage(attendanceId) as Page
	const sessionId = rel(attendance, "수업")[0]
	if (!sessionId) return { ok: true }
	const session = await getPage(sessionId) as Page
	if (!checkboxValue(session, "보강")) throw new ClassRoomError(409, "정규 수업의 출석은 여기서 뗄 수 없습니다.")
	const regs = rel(attendance, "등록")
	await updatePageProperties(attendanceId, { "수업": relation([]), "담당강사": relation([]), ...touched() })
	await updatePageProperties(sessionId, {
		"출석": relation(rel(session, "출석").filter((id) => id !== attendanceId)),
		"등록": relation(rel(session, "등록").filter((id) => !regs.includes(id))),
	})
	await mirrorJobs([["cr_attendance", [attendanceId]], ["cr_sessions", [sessionId]]]) // 복사본 함께 쓰기(v2.5.115)
	return { ok: true }
}

// 보강 수업을 지운다(휴지통). 학습기록이 있으면 막고, 연결된 출석은 먼저 떼어 대기실로 돌린다.
// 기존 [삭제] 버튼(cascade-delete)은 출석까지 지우므로 쓰지 않는다.
export async function deleteMakeupSession(sessionId: string) {
	if (!isId(sessionId)) throw new ClassRoomError(400, "수업 형식이 올바르지 않습니다.")
	const session = await getPage(sessionId) as Page
	if (!checkboxValue(session, "보강")) throw new ClassRoomError(409, "보강 수업만 여기서 지울 수 있습니다.")
	if (rel(session, "학습기록").length) throw new ClassRoomError(409, "이 보강 수업에 학습기록이 있어요. 기록을 먼저 지워 주세요.")
	const attendanceIds = rel(session, "출석")
	await mapWithConcurrency(attendanceIds, 3, (id) => updatePageProperties(id, { "수업": relation([]), "담당강사": relation([]), ...touched() }))
	await archivePage(sessionId)
	await removePages([sessionId]) // 복사본 함께 쓰기(v2.5.115)
	await mirrorJobs([["cr_attendance", attendanceIds]])
	return { ok: true, released: attendanceIds.length }
}

// ---------- 요청 처리 ----------
// 기록 카드 본문(v2.5.111): 카드를 펼칠 때 그 기록 한 장의 Notion 본문만 읽는다(feedBody.ts와 같은 블록 목록).
export async function loadRecordBody(recordId: string) {
	if (!isId(recordId)) throw new ClassRoomError(400, "기록 형식이 올바르지 않습니다.")
	return { recordId, body: await readPageBodyBlocks(recordId) }
}

export async function handleClassRoom(body: any): Promise<unknown> {
	switch (body?.action) {
		case "teachers": return { teachers: await listTeachers() }
		case "day": return await loadDay(String(body.date ?? ""), body.teacherId)
		case "days": return await loadDays(String(body.from ?? ""), String(body.to ?? ""), body.teacherId)
		case "session": return await loadSession(body.sessionId)
		case "classes": return await loadClasses(String(body.date ?? ""), body.teacherId)
		case "class-sessions": return await loadClassSessions(body.sessionId, body.around)
		case "class-records": return await loadClassRecords(body.sessionId)
		case "roster": return await loadRoster(body.sessionId)
		case "class-stats": return await loadClassStats(body.sessionId)
		case "books": return await loadBooks(body.sessionId)
		case "activities": return await loadActivities(body.recordId)
		case "record-body": return await loadRecordBody(body.recordId)
		case "student": return await loadStudent(body.registrationId)
		case "save-attendance": return await saveAttendance(body.items)
		case "save-activities": return await saveActivities(body.items)
		case "create-records": return await createRecords(body)
		case "update-record": return await updateRecord(body)
		case "create-activities": return await createActivities(body.recordId)
		case "create-makeup-session": return await createMakeupSession(body)
		case "unlink-makeup": return await unlinkMakeup(body.attendanceId)
		case "delete-makeup-session": return await deleteMakeupSession(body.sessionId)
		default: throw new ClassRoomError(400, "지원하지 않는 작업입니다.")
	}
}

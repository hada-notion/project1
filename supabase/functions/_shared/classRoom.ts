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
import { runInBackground } from "./backgroundTask.ts"

type Page = Record<string, any>

export class ClassRoomError extends Error {
	constructor(public status: number, message: string) {
		super(message)
	}
}

export const KINDS = ["학습", "과제", "평가"] as const
export const ATTENDANCE_STATUSES = ["🟢 출석", "🔴 결석", "🔵 보강"] as const
const HOMEWORK_SUBMITTED = "🔵 제출"
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
function isId(v: unknown): v is string {
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
function seoulTime(iso: string | null): string {
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
function seoulDate(iso: string | null): string {
	if (!iso) return ""
	if (!iso.includes("T")) return iso.slice(0, 10)
	return new Date(new Date(iso).getTime() + 9 * 3_600_000).toISOString().slice(0, 10)
}
function teacherFilter(teacherId?: string) {
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

function recordSummary(r: Page) {
	return {
		id: r.id as string,
		title: anyTitleText(r),
		kind: selectName(r, "구분") ?? "",
		bookId: rel(r, "진도교재")[0] ?? null,
		topic: plain(r, "주제"),
		range: plain(r, "범위"),
		content: plain(r, "내용"),
		makeup: checkboxValue(r, "보강"),
		registrationIds: rel(r, "등록"),
		activities: rel(r, "학습활동").length,
		activityStatus: selectName(r, "활동 생성 상태") ?? "",
	}
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
	const records = (await getPages(rel(session, "학습기록"))).map(recordSummary)
	return {
		session: { ...sessionSummary(session), className: await className(session) },
		students: students.map(({ dueActivityIds: _drop, ...s }) => s),
		homeworkDue,
		records,
	}
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
			}))
			.sort((a, b) => a.name.localeCompare(b.name, "ko")),
	}
}

// 한 학습기록의 학생별 학습활동(제출 상태·점수).
export async function loadActivities(recordId: string) {
	if (!isId(recordId)) throw new ClassRoomError(400, "기록 형식이 올바르지 않습니다.")
	const record = await getPage(recordId) as Page
	const activities = await getPages(rel(record, "학습활동"))
	const attendances = await getPages(dedupe(activities.flatMap((a) => rel(a, "출석"))))
	const nameByAttendance = new Map(attendances.map((a) => [a.id as string, studentName(a)]))
	return {
		record: recordSummary(record),
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
	await mapWithConcurrency(updates, 3, (u) => updatePageProperties(u.id, u.props))
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
	await mapWithConcurrency(updates, 3, (u) => updatePageProperties(u.id, u.props))
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
		const regularBookId = book ? rel(book, "정규교재")[0] ?? null : null
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
		if (ctx.makeup) props["보강"] = { checkbox: true }
		const page = await createPage(DS_LEARNING_RECORD, props) as Page
		existing.push(page)
		results.push({ id: page.id as string, title: anyTitleText(page) || String((props["학습"] as any).title[0].text.content), created: true })
	}
	return { records: results }
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
	let bookId = rel(record, "진도교재")[0] ?? null
	let regularBook: Page | null = null
	if (body.bookId !== undefined) {
		if (body.bookId !== null && !isId(body.bookId)) throw new ClassRoomError(400, "교재 형식이 올바르지 않습니다.")
		bookId = body.bookId
		props["진도교재"] = relation(bookId ? [bookId] : [])
		const book = bookId ? await getPage(bookId) as Page : null
		const regularBookId = book ? rel(book, "정규교재")[0] ?? null : null
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
				const rb = rel(book, "정규교재")[0]
				regularBook = rb ? await getPage(rb) as Page : null
				subject = regularBook ? anyTitleText(regularBook) : anyTitleText(book)
			} else subject = regularBook ? anyTitleText(regularBook) : anyTitleText(await getPage(bookId) as Page)
		}
		const kind = selectName(record, "구분") ?? "학습"
		props["학습"] = { title: [{ text: { content: recordTitle(kind, subject, session ? await className(session) : "", session ? dateStart(session, "수업일시") : null) } }] }
	}
	await updatePageProperties(record.id, props)
	return { ok: true }
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
	return { ok: true, released: attendanceIds.length }
}

// ---------- 요청 처리 ----------
export async function handleClassRoom(body: any): Promise<unknown> {
	switch (body?.action) {
		case "teachers": return { teachers: await listTeachers() }
		case "day": return await loadDay(String(body.date ?? ""), body.teacherId)
		case "days": return await loadDays(String(body.from ?? ""), String(body.to ?? ""), body.teacherId)
		case "session": return await loadSession(body.sessionId)
		case "books": return await loadBooks(body.sessionId)
		case "activities": return await loadActivities(body.recordId)
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

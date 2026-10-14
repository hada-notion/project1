// _shared/classRoomRead.ts
//
// 수업 관리 읽기 전환(v2.5.116, 설계 docs/설계-수업관리-복사본.md 5단계). 함수 설정값 CLASS_ROOM_SOURCE가 정한다.
//   - notion(기본·값 없음): 지금처럼 Notion을 읽는다.
//   - shadow: Notion 결과를 보여 주고, 뒤에서 같은 요청을 복사본으로 읽어 다르면 함수 로그에 남긴다.
//   - copy: 아래 동작은 복사본(cr_*)을 읽는다. 복사본에 없는 수업·기록이 있거나 읽기에 실패하면 그 요청만 Notion으로 읽는다.
// 복사본으로 읽는 동작: day, days, classes, session, class-sessions, class-records, class-stats.
// 그대로 Notion: teachers, roster, books, activities, record-body, student(복사본에 없는 교재·등록·원생·본문을 읽음)와 모든 저장.
// 결과 모양은 classRoom.ts의 같은 이름 함수와 같아야 한다(classRoomRead_test.ts가 같은 자료로 둘을 비교).
//
// Notion에서 지운 학습기록·학습활동은 복사본에 남는다(매일 밤 대조도 지우지 않음). 그래서 기록은 수업의 "학습기록" 관계
// (cr_sessions.record_ids)에 있는 것만, 학습활동은 그 기록에 붙은 것만 쓴다.

import {
	ClassRoomError,
	HOMEWORK_SUBMITTED,
	handleClassRoom,
	isId,
	seoulDate,
	seoulDayRange,
	seoulTime,
	teacherFilter,
} from "./classRoom.ts"
import { classRoomSource, copyTime, incrementalTable, COPY_TABLES, selectCopy, selectCopyByIds } from "./classRoomCopy.ts"
import { runInBackground } from "./backgroundTask.ts"

type Row = Record<string, any>
const DAY = 86_400_000

// 복사본에 아직 없는 수업·기록(방금 Notion에서 만든 것 등). 이 요청은 Notion으로 읽는다.
export class CopyMiss extends Error {}

const dedupe = (ids: string[]) => Array.from(new Set(ids.filter(Boolean)))
const arr = (v: unknown): string[] => (Array.isArray(v) ? v : [])
const inList = (ids: string[]) => ids.map((id) => `"${id}"`).join(",")
const teacherQuery = (teacherId?: string) => (teacherFilter(teacherId).length ? `&teacher_ids=cs.{${teacherId}}` : "")
const between = (col: string, from: string, to: string) => `${col}=gte.${copyTime(from)}&${col}=lt.${copyTime(to)}`
const byStart = (a: Row, b: Row) => String(a.start_text).localeCompare(String(b.start_text))

async function sessionById(sessionId: string): Promise<Row> {
	const [s] = await selectCopyByIds("cr_sessions", [sessionId])
	if (!s) throw new CopyMiss(`수업 ${sessionId}`)
	return s
}
// 행 전부가 있어야 하는 목록(없으면 Notion으로)
async function allByIds(table: "cr_attendance" | "cr_records", ids: string[]): Promise<Row[]> {
	const want = dedupe(ids), rows = await selectCopyByIds(table, want)
	if (rows.length !== want.length) throw new CopyMiss(`${table} ${want.length - rows.length}건`)
	return rows
}

function sessionSummary(s: Row) {
	return {
		id: s.id as string,
		name: s.name as string,
		start: s.start_text ?? null,
		end: s.end_text ?? null,
		time: [seoulTime(s.start_text ?? null), seoulTime(s.end_text ?? null)].filter(Boolean).join("–"),
		teacherIds: arr(s.teacher_ids),
		classIds: arr(s.class_ids),
		makeup: !!s.is_makeup,
		students: arr(s.attendance_ids).length,
		records: arr(s.record_ids).length,
		attendanceSummary: s.attendance_summary ?? "",
	}
}

function recordSummary(r: Row) {
	return {
		id: r.id as string,
		title: r.title as string,
		kind: r.kind as string,
		bookId: r.progress_book_id ?? null,
		topic: r.topic as string,
		range: r.range as string,
		unit: r.unit as string,
		unitIds: (r.unit_ids as string[] | null) ?? [],
		content: r.content as string,
		makeup: !!r.is_makeup,
		registrationIds: arr(r.registration_ids),
		activities: arr(r.activity_ids).length,
		activityStatus: r.activity_status as string,
		subject: r.subject as string,
	}
}

// ---------- 날짜·반 목록 ----------
export async function loadDay(date: string, teacherId?: string) {
	const { start, end } = seoulDayRange(date)
	const [sessions, attendances] = await Promise.all([
		selectCopy("cr_sessions", `${between("starts_at", start, end)}${teacherQuery(teacherId)}&order=starts_at,id`),
		selectCopy("cr_attendance", `${between("class_at", start, end)}&order=class_at,id`),
	])
	const arrived = new Map<string, number>()
	for (const a of attendances) if (a.arrived_at) for (const sid of arr(a.session_ids)) arrived.set(sid, (arrived.get(sid) ?? 0) + 1)
	return {
		date,
		sessions: sessions.map((s) => ({ ...sessionSummary(s), className: s.class_name ?? "", classEmoji: s.class_emoji ?? "", arrived: arrived.get(s.id) ?? 0 }))
			.sort((a, b) => String(a.start).localeCompare(String(b.start))),
		makeupWaiting: attendances.filter((a) => !arr(a.session_ids).length && a.status === "🔵 보강").map((a) => ({
			attendanceId: a.id as string,
			registrationId: a.registration_id ?? null,
			name: a.student_name as string,
			className: a.class_label ?? "",
			start: a.class_start_text ?? null,
		})),
	}
}

export async function loadDays(from: string, to: string, teacherId?: string) {
	const start = seoulDayRange(from).start, end = seoulDayRange(to).end
	const span = Date.parse(end) - Date.parse(start)
	if (span <= 0 || span > 42 * DAY) throw new ClassRoomError(400, "기간이 올바르지 않습니다.")
	const sessions = await selectCopy("cr_sessions", `${between("starts_at", start, end)}${teacherQuery(teacherId)}&order=starts_at,id`)
	return { dates: dedupe(sessions.map((s) => seoulDate(s.start_text ?? null))).sort() }
}

export async function loadClasses(date: string, teacherId?: string) {
	const { start, end } = seoulDayRange(date)
	const t = Date.parse(start)
	const sessions = (await selectCopy("cr_sessions", `${between("starts_at", new Date(t - 28 * DAY).toISOString(), new Date(t + 29 * DAY).toISOString())}${teacherQuery(teacherId)}&order=starts_at,id`))
		.filter((s) => !s.is_makeup && arr(s.class_ids).length).sort(byStart)
	const byClass = new Map<string, Row[]>()
	for (const s of sessions) { const c = arr(s.class_ids)[0]; byClass.set(c, [...(byClass.get(c) ?? []), s]) }
	const brief = (s?: Row) => s ? { id: s.id as string, date: seoulDate(s.start_text ?? null), time: sessionSummary(s).time } : null
	const dow = (Date.parse(start) / DAY + 3.375) % 7
	const monday = t - Math.floor(dow) * DAY, sunday = monday + 7 * DAY
	return {
		classes: [...byClass].map(([classId, list]) => {
			const when = (s: Row) => String(s.start_text ?? "")
			const today = list.filter((s) => when(s) >= start && when(s) < end)
			return {
				classId,
				name: list[0].class_name ?? "",
				emoji: list[0].class_emoji ?? "",
				today: today.map((s) => { const x = sessionSummary(s); return { id: x.id, start: x.start, end: x.end, time: x.time } }),
				next: brief(list.find((s) => when(s) >= end)),
				last: brief(list.filter((s) => when(s) < start).at(-1)),
				week: list.filter((s) => Date.parse(when(s)) >= monday && Date.parse(when(s)) < sunday).map((s) => { const x = sessionSummary(s); return { id: x.id, date: seoulDate(x.start), time: x.time } }),
				students: arr((today[0] ?? list.find((s) => when(s) >= end) ?? list.filter((s) => when(s) < start).at(-1))?.attendance_ids).length,
			}
		}),
	}
}

// ---------- 같은 반 앞뒤 수업(9주 전 ~ 5주 뒤, 보강 제외, 최대 90개) ----------
async function classSessionRows(session: Row, around?: string) {
	const classId = arr(session.class_ids)[0]
	const anchor = around ? seoulDayRange(around).start : session.start_text
	if (!classId || !anchor) return { sessions: [] as Row[], from: "", to: "" }
	const t = Date.parse(anchor)
	const from = new Date(t - 63 * DAY).toISOString(), to = new Date(t + 36 * DAY).toISOString()
	const sessions = (await selectCopy("cr_sessions", `class_ids=cs.{${classId}}&${between("starts_at", from, to)}&order=starts_at,id`))
		.filter((s) => !s.is_makeup).sort(byStart).slice(0, 90)
	return { sessions, from, to }
}
async function sessionAttendances(sessions: Row[], from: string, to: string) {
	const out = new Map<string, Row>()
	for (let i = 0; i < sessions.length; i += 90) {
		const part = sessions.slice(i, i + 90).map((s) => s.id as string)
		for (const a of await selectCopy("cr_attendance", `session_ids=ov.{${part.join(",")}}&${between("class_at", from, to)}&order=class_at,id`)) out.set(a.id, a)
	}
	return [...out.values()]
}
// 수업들의 학습기록 = 수업의 "학습기록" 관계에 있는 기록(지운 기록은 관계에서 빠진다)
async function sessionRecords(sessions: Row[]) {
	return await selectCopyByIds("cr_records", dedupe(sessions.flatMap((s) => arr(s.record_ids))))
}
async function recordActivities(records: Row[]) {
	const out: Row[] = []
	const ids = records.map((r) => r.id as string)
	for (let i = 0; i < ids.length; i += 100) out.push(...await selectCopy("cr_activities", `record_id=in.(${inList(ids.slice(i, i + 100))})&order=id`))
	return out
}

export async function loadClassStats(sessionId: string, now = Date.now()) {
	if (!isId(sessionId)) throw new ClassRoomError(400, "수업 형식이 올바르지 않습니다.")
	const session = await sessionById(sessionId)
	let { sessions, from, to } = await classSessionRows(session)
	const attendances = sessions.length ? await sessionAttendances(sessions, from, to) : await allByIds("cr_attendance", arr(session.attendance_ids))
	if (!sessions.length) sessions = [session]
	const byId = new Map(sessions.map((s) => [s.id as string, s]))
	const startOf = (s?: Row) => s?.start_text ?? null
	const ym = seoulDate(startOf(session)).slice(0, 7), today = seoulDate(new Date(now).toISOString())
	const month = { present: 0, counted: 0 }, hw = { done: 0, total: 0 }
	const students: Record<string, { present: number; counted: number; score: number | null; scoreDate: string | null }> = {}
	const student = (id: string) => (students[id] ??= { present: 0, counted: 0, score: null, scoreDate: null })
	for (const a of attendances) {
		const start = startOf(byId.get(arr(a.session_ids).find((id) => byId.has(id)) ?? ""))
		if (!start || Date.parse(start) > now || seoulDate(start).slice(0, 7) !== ym) continue
		const status = a.status ?? ""
		const present = status === "🟢 출석" || status === "🔵 보강" || (!status && !!a.arrived_at)
		if (!present && status !== "🔴 결석") continue
		month.counted++
		if (present) month.present++
		const reg = a.registration_id
		if (reg) { const s = student(reg); s.counted++; if (present) s.present++ }
	}
	const records = (await sessionRecords(sessions)).filter((r) => ["과제", "평가"].includes(r.kind))
	const acts = await recordActivities(records)
	const homeworkIds = new Set(records.filter((r) => r.kind === "과제").map((r) => r.id as string))
	for (const a of acts) {
		if (!homeworkIds.has(a.record_id)) continue
		const due = a.due_on ?? ""
		if (!due || due.slice(0, 7) !== ym || due > today) continue
		hw.total++
		if (a.homework_status === HOMEWORK_SUBMITTED) hw.done++
	}
	const tests = records.filter((r) => r.kind === "평가").map((r) => {
		const start = startOf(byId.get(arr(r.session_ids).find((id) => byId.has(id)) ?? ""))
		const scored = acts.filter((a) => a.record_id === r.id).map((a) => ({ reg: a.registration_id ?? "", correct: a.correct, total: a.total }))
			.filter((x) => x.total && x.total > 0 && typeof x.correct === "number").map((x) => ({ reg: x.reg, pct: x.correct / x.total * 100 }))
		return { id: r.id as string, subject: r.subject ?? "", range: r.range ?? "", date: seoulDate(start), start: start ?? "", scored }
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

// 기록 카드의 과제 제출·평가 점수(classRoom.ts cardExtras와 같은 규칙, 본문은 펼칠 때 record-body로)
function cardExtras(acts: Row[]) {
	return (r: Row) => {
		const mine = acts.filter((a) => a.record_id === r.id)
		const scored = mine.filter((a) => a.total && a.total > 0 && typeof a.correct === "number")
		return {
			homework: r.kind === "과제" && mine.length ? {
				submitted: mine.filter((a) => a.homework_status === HOMEWORK_SUBMITTED).length,
				total: mine.length,
				due: mine.map((a) => a.due_on).find(Boolean) ?? null,
			} : null,
			score: r.kind === "평가" && scored.length ? { avg: Math.round(scored.reduce((n, a) => n + a.correct / a.total * 100, 0) / scored.length), count: scored.length } : null,
			body: [] as unknown[],
		}
	}
}
const gradedActivities = (records: Row[]) => recordActivities(records.filter((r) => ["과제", "평가"].includes(r.kind)))

export async function loadClassRecords(sessionId: string) {
	if (!isId(sessionId)) throw new ClassRoomError(400, "수업 형식이 올바르지 않습니다.")
	const session = await sessionById(sessionId)
	let { sessions } = await classSessionRows(session)
	if (!sessions.length) sessions = [session]
	const byId = new Map(sessions.map((s) => [s.id as string, s]))
	const rows = await sessionRecords(sessions), extra = cardExtras(await gradedActivities(rows))
	const records = rows.map((r) => {
		const sid = arr(r.session_ids).find((id) => byId.has(id)) ?? null
		const start = sid ? byId.get(sid)?.start_text ?? null : null
		return { ...recordSummary(r), ...extra(r), sessionId: sid, date: seoulDate(start), start }
	})
	records.sort((a, b) => String(b.start ?? "").localeCompare(String(a.start ?? "")) || a.title.localeCompare(b.title, "ko"))
	return { records: records.map(({ start, ...r }) => ({ ...r, time: seoulTime(start) })) }
}

export async function loadClassSessions(sessionId: string, around?: string) {
	if (!isId(sessionId)) throw new ClassRoomError(400, "수업 형식이 올바르지 않습니다.")
	if (around !== undefined && around !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(around)) throw new ClassRoomError(400, "날짜 형식이 올바르지 않습니다.")
	const session = await sessionById(sessionId)
	const { sessions, from, to } = await classSessionRows(session, around)
	if (!sessions.length) return { sessions: [] }
	const attendances = await sessionAttendances(sessions, from, to)
	const homework = (await sessionRecords(sessions)).filter((r) => r.kind === "과제")
	const dueByDate = new Map<string, { done: number; total: number }>()
	for (const a of await recordActivities(homework)) {
		if (!a.due_on) continue
		const d = dueByDate.get(a.due_on) ?? { done: 0, total: 0 }
		d.total++
		if (a.homework_status === HOMEWORK_SUBMITTED) d.done++
		dueByDate.set(a.due_on, d)
	}
	return {
		sessions: sessions.map((s) => {
			const mine = attendances.filter((a) => arr(a.session_ids).includes(s.id))
			const start = s.start_text ?? null, date = seoulDate(start)
			return {
				id: s.id as string,
				date,
				time: [seoulTime(start), seoulTime(s.end_text ?? null)].filter(Boolean).join("–"),
				total: arr(s.attendance_ids).length,
				present: mine.filter((a) => a.status === "🟢 출석" || (!a.status && a.arrived_at)).length,
				absent: mine.filter((a) => a.status === "🔴 결석" || a.status === "🔵 보강").length,
				missing: mine.filter((a) => !a.status && !a.arrived_at).length,
				hwDone: dueByDate.get(date)?.done ?? 0,
				hwTotal: dueByDate.get(date)?.total ?? 0,
			}
		}),
	}
}

// 수업 상세: 학생(출석)·오늘 마감 과제·학습기록
export async function loadSession(sessionId: string) {
	if (!isId(sessionId)) throw new ClassRoomError(400, "수업 형식이 올바르지 않습니다.")
	const session = await sessionById(sessionId)
	const [attendances, recordRows] = await Promise.all([allByIds("cr_attendance", arr(session.attendance_ids)), allByIds("cr_records", arr(session.record_ids))])
	const students = attendances.map((a) => ({
		attendanceId: a.id as string,
		registrationId: a.registration_id ?? null,
		name: a.student_name as string,
		status: a.status as string,
		arrivedAt: a.arrived_at ?? null,
		leftAt: a.left_at ?? null,
		memo: a.memo as string,
		comment: a.comment as string,
		dueActivityIds: arr(a.due_activity_ids),
	})).sort((x, y) => x.name.localeCompare(y.name, "ko"))
	const dueActivities = await selectCopyByIds("cr_activities", dedupe(students.flatMap((s) => s.dueActivityIds)))
	const dueRecords = await selectCopyByIds("cr_records", dedupe(dueActivities.map((a) => a.record_id)))
	const attendanceByActivity = new Map<string, string>()
	for (const s of students) for (const id of s.dueActivityIds) attendanceByActivity.set(id, s.attendanceId)
	const homeworkDue = dueRecords.map((r) => ({
		recordId: r.id as string,
		title: r.title as string,
		range: r.range as string,
		items: dueActivities.filter((a) => a.record_id === r.id).map((a) => ({
			activityId: a.id as string,
			attendanceId: attendanceByActivity.get(a.id) ?? null,
			registrationId: a.registration_id ?? null,
			submitted: a.homework_status === HOMEWORK_SUBMITTED,
		})),
	}))
	const extra = cardExtras(await gradedActivities(recordRows))
	return {
		session: { ...sessionSummary(session), className: session.class_name ?? "", classEmoji: session.class_emoji ?? "" },
		students: students.map(({ dueActivityIds: _drop, ...s }) => s),
		homeworkDue,
		records: recordRows.map((r) => ({ ...recordSummary(r), ...extra(r) })),
	}
}

// ---------- 출처 스위치 ----------
const READERS: Record<string, (b: any) => Promise<unknown>> = {
	"day": (b) => loadDay(String(b.date ?? ""), b.teacherId),
	"days": (b) => loadDays(String(b.from ?? ""), String(b.to ?? ""), b.teacherId),
	"classes": (b) => loadClasses(String(b.date ?? ""), b.teacherId),
	"session": (b) => loadSession(b.sessionId),
	"class-sessions": (b) => loadClassSessions(b.sessionId, b.around),
	"class-records": (b) => loadClassRecords(b.sessionId),
	"class-stats": (b) => loadClassStats(b.sessionId),
}

// ⟳ 새로고침: Notion에서 직접 고친 것을 바로 보이도록 네 표의 바뀐 것만 맞춘다(복사본을 읽을 때만).
async function syncCopyNow() {
	if (classRoomSource() === "notion") return { synced: false }
	try {
		const results = await Promise.all(COPY_TABLES.map((t) => incrementalTable(t)))
		return { synced: true, changed: results.reduce((n, r) => n + r.upserted, 0) }
	} catch (err) {
		console.warn("[class-room] 새로고침 동기화 실패:", (err as Error).message)
		return { synced: false }
	}
}

export async function handleClassRoomWithSource(body: any): Promise<unknown> {
	if (body?.action === "sync-copy") return await syncCopyNow()
	const read = READERS[body?.action]
	const source = classRoomSource()
	if (!read || source === "notion") return await handleClassRoom(body)
	if (source === "copy") {
		try {
			return { ...(await read(body) as object), _source: "copy" }
		} catch (err) {
			if (err instanceof ClassRoomError) throw err
			console.warn(`[class-room] 복사본 ${err instanceof CopyMiss ? "없음" : "읽기 실패"} → Notion (${body.action}):`, (err as Error).message)
			return { ...(await handleClassRoom(body) as object), _source: "notion" }
		}
	}
	const result = await handleClassRoom(body)
	runInBackground(async () => {
		try {
			const diffs = compareResults(result, await read(body))
			if (diffs.length) console.warn(`[class-room shadow] ${body.action} 다름 ${diffs.length}건: ${diffs.slice(0, 5).join(" | ")}`)
			else console.log(`[class-room shadow] ${body.action} 같음`)
		} catch (err) {
			console.warn(`[class-room shadow] ${body.action} 복사본 ${err instanceof CopyMiss ? "없음" : "읽기 실패"}:`, (err as Error).message)
		}
	})
	return result
}

// ---------- 그림자 비교 ----------
// 같은 시각을 다른 형식으로 적은 값(Notion "+09:00" ↔ 복사본 UTC)은 같은 것으로 본다. 값은 40자까지만 로그에 남긴다.
const IS_TIME = /^\d{4}-\d{2}-\d{2}T/
function same(a: unknown, b: unknown): boolean {
	if (typeof a === "string" && typeof b === "string" && IS_TIME.test(a) && IS_TIME.test(b)) return Date.parse(a) === Date.parse(b)
	return a === b
}
function canon(v: unknown): unknown {
	if (typeof v === "string" && IS_TIME.test(v)) return new Date(Date.parse(v)).toISOString()
	if (Array.isArray(v)) return v.map(canon).map((x) => JSON.stringify(x)).sort().map((x) => JSON.parse(x))
	if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).filter((k) => !k.startsWith("_")).sort().map((k) => [k, canon((v as Row)[k])]))
	return v
}
function walk(a: unknown, b: unknown, path: string, out: string[]) {
	if (out.length >= 20) return
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) { out.push(`${path}.length ${a.length}≠${b.length}`); return }
		a.forEach((x, i) => walk(x, b[i], `${path}[${i}]`, out))
		return
	}
	if (a && b && typeof a === "object" && typeof b === "object") {
		for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!k.startsWith("_")) walk((a as Row)[k], (b as Row)[k], path ? `${path}.${k}` : k, out)
		return
	}
	if (!same(a, b)) out.push(`${path} notion=${JSON.stringify(a)?.slice(0, 40)} copy=${JSON.stringify(b)?.slice(0, 40)}`)
}
// 다른 곳 목록(경로와 두 값). 순서만 다르면 "순서만 다름" 한 줄.
export function compareResults(notion: unknown, copy: unknown): string[] {
	const out: string[] = []
	walk(notion, copy, "", out)
	if (!out.length) return out
	const ordered: string[] = []
	walk(canon(notion), canon(copy), "", ordered)
	return ordered.length ? out : ["순서만 다름"]
}

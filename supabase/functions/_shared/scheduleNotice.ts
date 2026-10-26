// _shared/scheduleNotice.ts
//
// (v2.8.0) 일정 안내 알림톡 두 가지.
//   1) 월간 일정 안내(반별): 클래스 [월간 일정 안내] → send-schedule-notice/class → 큐. 다음 달(서울) 일정을 그 반 수강 중
//      학생마다 한 통으로. 담는 일정 = 그 반에 연결된 공개 일정 + 학원 전체 공개 일정(클래스·학생·학교·학년이 모두 빈 것)
//      + 그 학생 학교·학년의 공개 일정(리포트와 같은 규칙: 일정의 학교·학년이 비었거나 학생 것과 같을 때). 일정 "구분"으로
//      휴원·학원·학교 세 구역(변수)으로 나눠 보내고, 빈 구역은 "없음". 학원 전체·학교 일정은 학생 기준이라 그 학생이 이미
//      받았으면 뺀다(Supabase schedule_notice_sent, 두 반 수강생 중복 방지). 보낼 일정이 0건인 학생은 보내지 않는다.
//      같은 달을 다시 누르면 보내지 않는다(클래스 "일정 안내 월"). 다시 보내려면 비우고 누른다.
//   2) 일정 안내(한 건): 일정 [일정 안내 전송] → send-schedule-notice/event → 큐. 일정에 연결된 학생, 연결된 클래스의 수강 중
//      학생에게. 일정구분 = 일정 "안내 구분"(비면 구분에서: 💤 휴원 → 휴원, 📆 → 학원 일정, 🏫 → 학사 일정). 참고사항 = 메모.
//      보낸 뒤 일정 "일정 안내 일시" = 그때 날짜. 다시 누르면 날짜가 바뀌었을 때만 보낸다.
// 큐 모양은 반별 보고서와 같다: 반(일정) 1건이 학생 1건씩을 다시 넣고, 마지막 학생이 상태를 마친다(✅, 중간 실패가 있으면 ⚠️).
// 발송 규칙은 수업 안내와 같다(설정 행이 꺼졌거나 비면 ⚠️, 연락처 없음 ⚠️, 발송 단계 실패는 다시 보내지 않음). 전송로그는 등록에.
import { createSendLogEntry, extractErrorMessage, getBotUserId } from "./adminShared.ts"
import { syncStudentReport } from "./alimtalkShared.ts"
import { fullRelationIds, getPage, queryAllPages, relIds, updatePageProperties } from "./notionClient.ts"
import { DS_REGISTRATION, DS_SCHEDULE_EVENT, PROP_LAST_ERROR } from "./constants.ts"
import { enqueueSync } from "./syncQueue.ts"
import { markDone, markError, markRunning, type StatusSpec } from "./statusTracking.ts"
import { isParentPublicEvent } from "./scheduleVisibility.ts"
import { seoulDay } from "./classReportPlan.ts"
import { formatLessonTime, LessonConfigError, noteText, sameInstant, sendConfiguredAlimtalk } from "./lessonNotice.ts"
import { fetchSupabaseWithRetry } from "./reportCacheShared.ts"

export const SCHEDULE_NOTICE_STATUS_SPEC: StatusSpec = {
	statusProp: "일정 안내 상태",
	errorProp: PROP_LAST_ERROR,
	startedAtProp: "일정 안내 처리 시작 시각",
}
export const TARGET_SCHEDULE_MONTH_CLASS = "schedule-month-class"
export const TARGET_SCHEDULE_MONTH_STUDENT = "schedule-month-student"
export const TARGET_SCHEDULE_EVENT = "schedule-event"
export const TARGET_SCHEDULE_EVENT_STUDENT = "schedule-event-student"
const PROP_CLASS_MONTH = "일정 안내 월"
const PROP_EVENT_SENT = "일정 안내 일시"
const PROP_EVENT_LABEL = "안내 구분"
const SUMMARY_LINES = 5
const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"]

const textOf = (arr: any): string => (Array.isArray(arr) ? arr.map((t: any) => t?.plain_text ?? t?.text?.content ?? "").join("") : "")
const key = (id: string) => String(id ?? "").replace(/-/g, "").toLowerCase()

// 서울 기준 다음 달 "YYYY-MM".
export function nextMonthKey(now = new Date()): string {
	const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(now)
	let y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)) + 1
	if (m > 12) { m = 1; y++ }
	return `${y}-${String(m).padStart(2, "0")}`
}
const monthLabel = (month: string) => `${Number(month.slice(5, 7))}월`
// 그 달 일정만 읽는 조회 조건(공개·숨김 해제·그 달 안).
function monthFilter(month: string): Record<string, unknown>[] {
	let y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7)) + 1
	if (m > 12) { m = 1; y++ }
	return [
		{ property: "학부모 공개", checkbox: { equals: true } },
		{ property: "숨김", checkbox: { equals: false } },
		{ property: "날짜", date: { on_or_after: `${month}-01` } },
		{ property: "날짜", date: { before: `${y}-${String(m).padStart(2, "0")}-01` } },
	]
}
const inMonth = (day: string | null, month: string) => !!day && day.slice(0, 7) === month

function shortDay(day: string): string {
	// 서울 정오는 같은 날 UTC 03시라 요일이 그대로다.
	return `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}(${WEEKDAY[new Date(`${day}T12:00:00+09:00`).getUTCDay()]})`
}

// 일정 한 줄: "11/3(월) 휴원", 기간이면 "11/3(월)~11/5(수) 시험 대비". 이름이 비면 구분.
export function eventLine(event: any): { day: string; line: string } | null {
	const p = event?.properties ?? {}
	const start = seoulDay(p["날짜"]?.date?.start)
	if (!start) return null
	const end = seoulDay(p["날짜"]?.date?.end)
	const name = textOf(p["이름"]?.title).trim() || String(p["구분"]?.select?.name ?? "").replace(/^\S+\s/, "")
	return { day: start, line: `${shortDay(start)}${end && end !== start ? `~${shortDay(end)}` : ""} ${name}`.trim() }
}

// 일정 요약: 날짜순 최대 5줄, 넘치면 "외 N건".
export function summarize(lines: { day: string; line: string }[]): string {
	const sorted = lines.slice().sort((a, b) => a.day.localeCompare(b.day))
	const shown = sorted.slice(0, SUMMARY_LINES).map((l) => l.line)
	if (sorted.length > SUMMARY_LINES) shown.push(`외 ${sorted.length - SUMMARY_LINES}건`)
	return shown.join("\n")
}

// 학원 전체 일정: 클래스·학생·학교·학년이 모두 빈 공개 일정.
export function isAcademyWide(event: any): boolean {
	const p = event?.properties ?? {}
	return ["클래스", "학생", "학교", "학년"].every((n) => relIds(p[n]).length === 0)
}

// 일정 안내의 구분 줄: "안내 구분" 칸 → 없으면 구분으로(템플릿 본문 "📌 구분: …"이라 "안내"를 붙이지 않는다).
export function eventLabel(event: any): string {
	const p = event?.properties ?? {}
	const custom = textOf(p[PROP_EVENT_LABEL]?.rich_text).trim()
	if (custom) return custom
	const cat = String(p["구분"]?.select?.name ?? "")
	if (cat.includes("휴원")) return "휴원"
	if (cat.includes("학사")) return "학사 일정"
	if (cat.includes("학원 일정")) return "학원 일정"
	return "일정"
}

// 월간 일정 안내의 구역: 💤 휴원 → 휴원, 🏫 학사 일정 → 학교, 그 밖(📆 학원 일정) → 학원.
export type Section = "휴원" | "학원" | "학교"
export function sectionOf(event: any): Section {
	const cat = String(event?.properties?.["구분"]?.select?.name ?? "")
	return cat.includes("휴원") ? "휴원" : cat.includes("학사") ? "학교" : "학원"
}

// 한 구역 목록(최대 5줄 + 외 N건), 비면 "없음".
export function sectionText(lines: { day: string; line: string; sec: Section }[], sec: Section): string {
	const own = lines.filter((l) => l.sec === sec)
	return own.length ? summarize(own) : "없음"
}

// 일정일시: 하루면 "11월 3일(월)"(시각이 있으면 "오후 2:00"까지), 기간이면 "11월 3일(월) ~ 11월 5일(수)".
export function eventTimeText(event: any): string {
	const d = event?.properties?.["날짜"]?.date
	if (!d?.start) return ""
	const start = formatLessonTime(d.start)
	if (!d.end) return start
	const end = formatLessonTime(d.end)
	// 같은 날 시각 범위면 끝은 시각만("11월 3일(화) 오후 2:00 ~ 오후 4:00").
	if (seoulDay(d.end) === seoulDay(d.start)) return /T/.test(String(d.end)) ? `${start} ~ ${end.split(") ")[1] ?? end}` : start
	return `${start} ~ ${end}`
}

const isActiveReg = (r: any) => {
	const p = r?.properties?.["수강상태"]
	const name = p?.status?.name ?? p?.select?.name ?? (p?.formula?.string ?? "")
	return !r?.in_trash && !r?.archived && String(name).includes("수강 중")
}

// Supabase 기록(학원 전체 일정 중복 방지).
const SB_URL = Deno.env.get("SB_URL") ?? ""
const SB_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
const sbHeaders = () => ({ apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" })
async function sentAcademyEvents(studentId: string, eventIds: string[]): Promise<Set<string>> {
	if (!eventIds.length) return new Set()
	const res = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/schedule_notice_sent?select=event_id&student_id=eq.${encodeURIComponent(studentId)}&event_id=in.(${eventIds.map(encodeURIComponent).join(",")})`, { headers: sbHeaders() })
	if (!res.ok) throw new Error(`schedule_notice_sent 읽기 실패: ${res.status}`)
	return new Set(((await res.json()) as any[]).map((r) => key(r.event_id)))
}
async function markAcademyEventsSent(studentId: string, eventIds: string[], month: string): Promise<void> {
	if (!eventIds.length) return
	const res = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/schedule_notice_sent`, {
		method: "POST",
		headers: { ...sbHeaders(), Prefer: "resolution=ignore-duplicates" },
		body: JSON.stringify(eventIds.map((event_id) => ({ student_id: studentId, event_id, month }))),
	})
	if (!res.ok) throw new Error(`schedule_notice_sent 쓰기 실패: ${res.status}`)
}

// 테스트에서 Notion·발송·기록을 바꿔 끼울 수 있게 한다.
export const scheduleDeps = {
	getPage,
	queryAllPages,
	update: updatePageProperties,
	fullRelationIds,
	enqueue: enqueueSync,
	send: sendConfiguredAlimtalk,
	log: createSendLogEntry,
	botUser: getBotUserId,
	token: async (regId: string) => (await syncStudentReport(regId)).access_token,
	sentAcademy: sentAcademyEvents,
	markSent: markAcademyEventsSent,
	markRunning: (id: string) => markRunning(id, SCHEDULE_NOTICE_STATUS_SPEC),
	markDone: (id: string) => markDone(id, SCHEDULE_NOTICE_STATUS_SPEC),
	markError: (id: string, message: string) => markError(id, SCHEDULE_NOTICE_STATUS_SPEC, message),
}

type Line = { id: string; day: string; line: string; sec: Section }

async function activeRegsOfClass(classId: string): Promise<any[]> {
	return (await scheduleDeps.queryAllPages(DS_REGISTRATION, { property: "클래스", relation: { contains: classId } })).filter(isActiveReg)
}

// ── 1) 월간 일정 안내 ─────────────────────────────────────────────────────────
export type MonthClassPayload = { classId: string; month: string }
// academyEvents = 학원 전체 + 그 학생 학교·학년 일정(학생 기준, 이미 받은 것은 학생 단계에서 뺀다).
export type MonthStudentPayload = { classId: string; className: string; month: string; regId: string; classEvents: Line[]; academyEvents: Line[]; last?: boolean }

// 학생의 학교·학년 공개 일정(그 달). 같은 학교·학년은 한 번만 조회한다(cache).
async function schoolLines(studentId: string, month: string, cache: Map<string, Promise<any[]>>, toLines: (pages: any[]) => Line[]): Promise<Line[]> {
	const deps = scheduleDeps
	const st: any = studentId ? await deps.getPage(studentId).catch(() => null) : null
	const schoolId = relIds(st?.properties?.["학교"])[0]
	const gradeId = relIds(st?.properties?.["학년"])[0]
	const fetch = (prop: "학교" | "학년", id: string) => {
		const k = `${prop}:${key(id)}`
		if (!cache.has(k)) cache.set(k, deps.queryAllPages(DS_SCHEDULE_EVENT, { and: [{ property: prop, relation: { contains: id } }, ...monthFilter(month)] }))
		return cache.get(k)!
	}
	const pages = [...(schoolId ? await fetch("학교", schoolId) : []), ...(gradeId ? await fetch("학년", gradeId) : [])]
	const byId = new Map<string, any>()
	for (const e of pages) {
		const sch = relIds(e?.properties?.["학교"]).map(key), grd = relIds(e?.properties?.["학년"]).map(key)
		if (!sch.length && !grd.length) continue
		if (sch.length && !(schoolId && sch.includes(key(schoolId)))) continue
		if (grd.length && !(gradeId && grd.includes(key(gradeId)))) continue
		byId.set(String(e.id), e)
	}
	return toLines(Array.from(byId.values()))
}

export async function processScheduleMonthClassItem(p: MonthClassPayload): Promise<void> {
	const deps = scheduleDeps
	try {
		await deps.markRunning(p.classId)
		const cls: any = await deps.getPage(p.classId)
		const sentMonth = textOf(cls?.properties?.[PROP_CLASS_MONTH]?.rich_text).trim()
		if (sentMonth === p.month) return await deps.markError(p.classId, `이미 ${monthLabel(p.month)} 일정 안내를 보냈습니다. 다시 보내려면 '${PROP_CLASS_MONTH}'을 비우고 누르세요.`)
		const className = textOf(cls?.properties?.["클래스명"]?.title).trim()
		const toLines = (pages: any[]): Line[] => pages
			.filter((e) => isParentPublicEvent(e))
			.map((e) => ({ id: String(e.id), ...eventLine(e)!, sec: sectionOf(e) }))
			.filter((l) => l.line && inMonth(l.day, p.month))
		const classEventPages = await Promise.all((await deps.fullRelationIds(cls, "일정")).map((id: string) => deps.getPage(id)))
		const classEvents = toLines(classEventPages)
		const academyPages = (await deps.queryAllPages(DS_SCHEDULE_EVENT, { and: monthFilter(p.month) })).filter(isAcademyWide)
		const academyEvents = toLines(academyPages)
		const regs = await activeRegsOfClass(p.classId)
		if (!regs.length) return await deps.markError(p.classId, "수강 중인 학생이 없습니다.")
		// 학생마다 학교·학년 일정을 더한다(반·학원 전체 일정과 겹치면 뺀다).
		const known = new Set([...classEvents, ...academyEvents].map((l) => key(l.id)))
		const cache = new Map<string, Promise<any[]>>()
		const items: MonthStudentPayload[] = []
		for (const r of regs) {
			const school = (await schoolLines(relIds(r.properties?.["학생정보"])[0] ?? "", p.month, cache, toLines)).filter((l) => !known.has(key(l.id)))
			items.push({ classId: p.classId, className, month: p.month, regId: String(r.id), classEvents, academyEvents: [...academyEvents, ...school] })
		}
		console.log(`[schedule-month] class=${p.classId} ${p.month} 반 일정 ${classEvents.length}, 학원 전체 ${academyEvents.length}, 학생 ${regs.length}`)
		if (!items.some((it) => it.classEvents.length || it.academyEvents.length)) return await deps.markError(p.classId, `${monthLabel(p.month)}에 이 반·학원 전체·학생 학교의 학부모 공개 일정이 없습니다.`)
		for (let i = 0; i < items.length; i++) await deps.enqueue(TARGET_SCHEDULE_MONTH_STUDENT, { ...items[i], ...(i === items.length - 1 ? { last: true } : {}) })
	} catch (err) {
		await deps.markError(p.classId, (err as Error).message).catch(() => {})
		throw err
	}
}

async function appendError(pageId: string, line: string): Promise<void> {
	const deps = scheduleDeps
	const page: any = await deps.getPage(pageId).catch(() => null)
	const prev = textOf(page?.properties?.[PROP_LAST_ERROR]?.rich_text).trim()
	const next = (prev ? `${prev}\n${line}` : line).slice(0, 1900)
	await deps.update(pageId, { [PROP_LAST_ERROR]: { rich_text: [{ text: { content: next } }] } }).catch(() => {})
}

async function finishParent(pageId: string, extra: Record<string, unknown>): Promise<void> {
	const deps = scheduleDeps
	const page: any = await deps.getPage(pageId)
	const err = textOf(page?.properties?.[PROP_LAST_ERROR]?.rich_text).trim()
	await deps.update(pageId, extra)
	if (err) await deps.markError(pageId, err)
	else await deps.markDone(pageId)
}

// 한 학생에게 보내기. 설정·연락처로 막히면 그 학생만 기록하고 넘어간다(다시 해도 같음). 발송 실패도 다시 보내지 않는다.
async function sendOne(code: "월간 일정 안내" | "일정 안내", parentId: string, regId: string, studentName: string, variables: Record<string, string>): Promise<boolean> {
	const deps = scheduleDeps
	const senderUserId = (await deps.botUser().catch(() => null)) ?? undefined
	try {
		await deps.send(code, regId, "", variables)
	} catch (err) {
		const reason = extractErrorMessage(err)
		if (!(err instanceof LessonConfigError) && !/연락처 오류/.test(reason)) {
			await deps.log({ registrationId: regId, senderUserId, title: studentName || code, category: code, status: "실패", failReason: reason })
		}
		await appendError(parentId, `${studentName || regId}: ${reason}`)
		return false
	}
	await deps.log({ registrationId: regId, senderUserId, title: studentName || code, category: code, status: "성공" })
	return true
}

const studentNameOf = (reg: any): string => {
	for (const item of reg?.properties?.["학생이름(등록)"]?.rollup?.array ?? []) {
		const s = textOf(item?.title ?? item?.rich_text).trim()
		if (s) return s
	}
	return ""
}

export async function processScheduleMonthStudentItem(p: MonthStudentPayload): Promise<void> {
	const deps = scheduleDeps
	const reg: any = await deps.getPage(p.regId)
	const studentId = relIds(reg?.properties?.["학생정보"])[0] ?? p.regId
	const studentName = studentNameOf(reg)
	const already = await deps.sentAcademy(studentId, p.academyEvents.map((e) => e.id))
	const academy = p.academyEvents.filter((e) => !already.has(key(e.id)))
	const lines = [...p.classEvents, ...academy]
	if (lines.length) {
		const REPORT_PATH = Deno.env.get("REPORT_PATH") ?? "/project1/student_report.html"
		const token = await deps.token(p.regId)
		const ok = await sendOne("월간 일정 안내", p.classId, p.regId, studentName, {
			"#{학생이름}": studentName,
			"#{클래스}": p.className,
			"#{안내월}": monthLabel(p.month),
			"#{휴원일정}": sectionText(lines, "휴원"),
			"#{학원일정}": sectionText(lines, "학원"),
			"#{학교일정}": sectionText(lines, "학교"),
			"#{페이지ID}": `${REPORT_PATH}?token=${token}`,
		})
		if (ok) await deps.markSent(studentId, academy.map((e) => e.id), p.month).catch((err) => console.warn("[schedule-month] 기록 실패:", (err as Error).message))
	}
	if (p.last) await finishParent(p.classId, { [PROP_CLASS_MONTH]: { rich_text: [{ text: { content: p.month } }] } })
}

// ── 2) 일정 안내(한 건) ───────────────────────────────────────────────────────
export type EventPayload = { eventId: string }
export type EventStudentPayload = { eventId: string; regId: string; vars: Record<string, string>; dateStart: string; last?: boolean }

export async function processScheduleEventItem(p: EventPayload): Promise<void> {
	const deps = scheduleDeps
	try {
		await deps.markRunning(p.eventId)
		const ev: any = await deps.getPage(p.eventId)
		const dateStart = String(ev?.properties?.["날짜"]?.date?.start ?? "")
		if (!dateStart) return await deps.markError(p.eventId, "일정의 날짜가 비어 있습니다.")
		const sentAt = String(ev?.properties?.[PROP_EVENT_SENT]?.date?.start ?? "")
		if (sentAt && sameInstant(sentAt, dateStart)) return await deps.markError(p.eventId, `이미 이 날짜로 안내했습니다. 다시 보내려면 '${PROP_EVENT_SENT}'을 비우고 누르세요.`)
		// 대상: 연결된 학생의 수강 중 등록(학생마다 하나) + 연결된 클래스의 수강 중 등록. 학생이 겹치면 한 번만.
		const regs: any[] = []
		for (const sid of await deps.fullRelationIds(ev, "학생")) {
			const st: any = await deps.getPage(sid)
			const own = await Promise.all((await deps.fullRelationIds(st, "등록")).map((id: string) => deps.getPage(id)))
			const active = own.filter(isActiveReg)
			if (active[0]) regs.push(active[0])
		}
		for (const cid of await deps.fullRelationIds(ev, "클래스")) regs.push(...await activeRegsOfClass(cid))
		const seen = new Set<string>(), targets: any[] = []
		for (const r of regs) {
			const sk = key(relIds(r.properties?.["학생정보"])[0] ?? r.id)
			if (seen.has(sk)) continue
			seen.add(sk)
			targets.push(r)
		}
		if (!targets.length) return await deps.markError(p.eventId, "일정에 학생이나 클래스를 연결해 주세요(수강 중인 학생이 없습니다).")
		const vars = {
			"#{일정구분}": eventLabel(ev),
			"#{일정명}": textOf(ev.properties?.["이름"]?.title).trim() || eventLabel(ev),
			"#{일정일시}": eventTimeText(ev),
			"#{참고사항}": noteText(textOf(ev.properties?.["메모"]?.rich_text)),
		}
		console.log(`[schedule-event] event=${p.eventId} 대상 ${targets.length}`)
		for (let i = 0; i < targets.length; i++) {
			const item: EventStudentPayload = { eventId: p.eventId, regId: String(targets[i].id), vars, dateStart, ...(i === targets.length - 1 ? { last: true } : {}) }
			await deps.enqueue(TARGET_SCHEDULE_EVENT_STUDENT, item)
		}
	} catch (err) {
		await deps.markError(p.eventId, (err as Error).message).catch(() => {})
		throw err
	}
}

export async function processScheduleEventStudentItem(p: EventStudentPayload): Promise<void> {
	const deps = scheduleDeps
	const reg: any = await deps.getPage(p.regId)
	const studentName = studentNameOf(reg)
	await sendOne("일정 안내", p.eventId, p.regId, studentName, { ...p.vars, "#{학생이름}": studentName })
	if (p.last) await finishParent(p.eventId, { [PROP_EVENT_SENT]: { date: { start: p.dateStart } } })
}

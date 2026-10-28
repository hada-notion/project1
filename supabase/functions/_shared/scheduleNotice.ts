// _shared/scheduleNotice.ts
//
// (v2.8.0) 일정 안내(한 건): 일정 [일정 안내 전송] → send-schedule-notice/event → 큐. 일정에 연결된 학생, 연결된 클래스의 수강 중
// 학생에게. 일정구분 = 일정 "안내 구분"(선택: 상담·테스트·휴강·휴원, 비면 구분에서: 💤 휴원 → 휴원, 🏫 → 학사, 그 밖 → 학원).
// 본문 첫 문장 "… 학생의 #{일정구분} 일정을 안내드립니다."에 들어간다. 전달사항 = 메모(50자, 비면 "없음").
// 보낸 뒤 일정 "일정 안내 일시" = 그때 날짜. 다시 누르면 날짜가 바뀌었을 때만 보낸다.
// 월간 일정 안내는 학생 단위다(학생 월간 안내, _shared/monthlyNotice.ts). 이 파일의 한 줄·구역 함수를 같이 쓴다.
// 큐 모양은 반별 보고서와 같다: 일정 1건이 학생 1건씩을 다시 넣고, 마지막 학생이 상태를 마친다(✅, 중간 실패가 있으면 ⚠️).
// 발송 규칙은 수업 안내와 같다(설정 행이 꺼졌거나 비면 ⚠️, 연락처 없음 ⚠️, 발송 단계 실패는 다시 보내지 않음). 전송로그는 등록에.
import { createSendLogEntry, extractErrorMessage, getBotUserId } from "./adminShared.ts"
import { getFormulaText } from "./alimtalkShared.ts"
import { fullRelationIds, getPage, queryAllPages, relIds, updatePageProperties } from "./notionClient.ts"
import { DS_REGISTRATION, PROP_LAST_ERROR } from "./constants.ts"
import { enqueueSync } from "./syncQueue.ts"
import { markDone, markError, markRunning, type StatusSpec } from "./statusTracking.ts"
import { seoulDay } from "./classReportPlan.ts"
import { formatClassTime, LessonConfigError, noteText, sameInstant, sendConfiguredAlimtalk } from "./lessonNotice.ts"
import { alimtalkVar, eventInfoBlock } from "./noticeBlocks.ts"

export const SCHEDULE_NOTICE_STATUS_SPEC: StatusSpec = {
	statusProp: "일정 안내 상태",
	errorProp: PROP_LAST_ERROR,
	startedAtProp: "일정 안내 처리 시작 시각",
}
export const TARGET_SCHEDULE_EVENT = "schedule-event"
export const TARGET_SCHEDULE_EVENT_STUDENT = "schedule-event-student"
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
export const monthLabel = (month: string) => `${Number(month.slice(5, 7))}월`
// 그 달 일정만 읽는 조회 조건(공개·숨김 해제·그 달 안).
export function monthFilter(month: string): Record<string, unknown>[] {
	let y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7)) + 1
	if (m > 12) { m = 1; y++ }
	return [
		{ property: "학부모 공개", checkbox: { equals: true } },
		{ property: "숨김", checkbox: { equals: false } },
		{ property: "날짜", date: { on_or_after: `${month}-01` } },
		{ property: "날짜", date: { before: `${y}-${String(m).padStart(2, "0")}-01` } },
	]
}
export const inMonth = (day: string | null, month: string) => !!day && day.slice(0, 7) === month

function shortDay(day: string): string {
	// 서울 정오는 같은 날 UTC 03시라 요일이 그대로다.
	return `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}(${WEEKDAY[new Date(`${day}T12:00:00+09:00`).getUTCDay()]})`
}

// 일정 한 줄: "11/3(월) 휴원", 기간이면 "11/3(월)~11/5(수) 시험 대비". 이름이 비면 구분.
// (10/28 사용자) 같은 달 기간은 끝의 "월/"을 빼 "11/3(월)~5(수)"로 줄인다(카톡에서 줄이 덜 꺾이게). 달이 넘어가면 그대로.
export function eventLine(event: any): { day: string; line: string } | null {
	const p = event?.properties ?? {}
	const start = seoulDay(p["날짜"]?.date?.start)
	if (!start) return null
	const end = seoulDay(p["날짜"]?.date?.end)
	const name = textOf(p["이름"]?.title).trim() || String(p["구분"]?.select?.name ?? "").replace(/^\S+\s/, "")
	const tail = end && end !== start ? `~${end.slice(0, 7) === start.slice(0, 7) ? shortDay(end).replace(/^\d+\//, "") : shortDay(end)}` : ""
	return { day: start, line: `${shortDay(start)}${tail} ${name}`.trim() }
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

// 일정 안내의 구분: "안내 구분"(선택) → 없으면 구분으로. 본문이 "학생의 #{일정구분} 일정을"이라 "일정"을 붙이지 않는다.
export function eventLabel(event: any): string {
	const p = event?.properties ?? {}
	const custom = String(p[PROP_EVENT_LABEL]?.select?.name ?? textOf(p[PROP_EVENT_LABEL]?.rich_text)).trim()
	if (custom) return custom
	const cat = String(p["구분"]?.select?.name ?? "")
	if (cat.includes("휴원")) return "휴원"
	if (cat.includes("학사")) return "학사"
	return "학원"
}

// 월간 일정 안내의 구역: 💤 휴원 → 휴원, 🏫 학사 일정 → 학교, 그 밖(📆 학원 일정) → 학원.
export type Section = "휴원" | "학원" | "학교"
export function sectionOf(event: any): Section {
	const cat = String(event?.properties?.["구분"]?.select?.name ?? "")
	return cat.includes("휴원") ? "휴원" : cat.includes("학사") ? "학교" : "학원"
}

// 월간 일정 안내 한 구역의 일정 수 한도(넘치면 "외 N건"). 날짜로 묶으면 줄이 늘어 알림톡 1,000자를 넘지 않게 한다.
const SECTION_EVENTS = 8
// (10/28 사용자, A안) 한 구역 목록: 날짜 한 줄 아래 그날 일정을 "· 이름"으로 모은다(같은 날짜 표기는 한 번). 비면 "없음".
//   11/7(토)
//   · 중1 영어 보충 수업
//   11/14(토)
//   · 학원 설명회
//   · 중1 수학 보강
// 한 줄(eventLine·반 이름 붙임)의 첫 칸이 날짜 표기("11/9(월)~11(수)"처럼 기간이어도 공백 없음)이고 나머지가 일정이다.
export function sectionText(lines: { day: string; line: string; sec: Section }[], sec: Section): string {
	const own = lines.filter((l) => l.sec === sec).sort((a, b) => a.day.localeCompare(b.day))
	if (!own.length) return "없음"
	const out: string[] = []
	let prev = ""
	for (const l of own.slice(0, SECTION_EVENTS)) {
		const cut = l.line.indexOf(" ")
		const date = cut < 0 ? l.line : l.line.slice(0, cut)
		const what = cut < 0 ? "" : l.line.slice(cut + 1).trim()
		if (date !== prev) out.push(date)
		prev = date
		if (what) out.push(`· ${what}`)
	}
	if (own.length > SECTION_EVENTS) out.push(`외 ${own.length - SECTION_EVENTS}건`)
	return out.join("\n")
}

// 일정일시(수업 안내와 같은 표기): 하루면 "26.11.03(화)", 시각이 있으면 "26.11.03(화) 14:00~16:00",
// 기간이면 "26.11.09(월)~26.11.11(수)"(시각이 있으면 각 끝에 시각). (10/28) 시각 없는 같은 달 기간은 "26.11.09(월)~11(수)".
export function eventTimeText(event: any): string {
	const d = event?.properties?.["날짜"]?.date
	if (!d?.start) return ""
	const start = formatClassTime(d.start)
	if (!d.end) return start
	const end = formatClassTime(d.end)
	if (seoulDay(d.end) === seoulDay(d.start)) return /T/.test(String(d.end)) ? `${start}~${end.split(" ")[1] ?? end}` : start
	if (!/T/.test(String(d.start)) && !/T/.test(String(d.end)) && seoulDay(d.end)?.slice(0, 7) === seoulDay(d.start)?.slice(0, 7)) return `${start}~${end.slice(6)}`
	return `${start}~${end}`
}

export const isActiveReg = (r: any) => {
	const p = r?.properties?.["수강상태"]
	const name = p?.status?.name ?? p?.select?.name ?? (p?.formula?.string ?? "")
	return !r?.in_trash && !r?.archived && String(name).includes("수강 중")
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
	markRunning: (id: string) => markRunning(id, SCHEDULE_NOTICE_STATUS_SPEC),
	markDone: (id: string) => markDone(id, SCHEDULE_NOTICE_STATUS_SPEC),
	markError: (id: string, message: string) => markError(id, SCHEDULE_NOTICE_STATUS_SPEC, message),
}

async function activeRegsOfClass(classId: string): Promise<any[]> {
	return (await scheduleDeps.queryAllPages(DS_REGISTRATION, { property: "클래스", relation: { contains: classId } })).filter(isActiveReg)
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
async function sendOne(code: "일정 안내", parentId: string, regId: string, studentName: string, variables: Record<string, string>): Promise<boolean> {
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

// ── 일정 안내(한 건) ───────────────────────────────────────────────────────
// 보낼 학생이 없을 때 이유. 학교·학년만 연결된 일정(NEIS 학사 일정 등)은 가정통신문 학사일정 구역으로 보낸다.
export const noTargetMessage = (ev: any, linked: boolean): string => {
	if (linked) return "연결된 학생·클래스에 수강 중인 학생이 없습니다."
	const p = ev?.properties ?? {}
	if (relIds(p["학교"]).length || relIds(p["학년"]).length) return "학교·학년 일정은 일정 안내로 보내지 않습니다(가정통신문 학사일정에 들어갑니다). 학생이나 클래스를 연결한 일정에서 누르세요."
	return "일정에 학생이나 클래스를 연결해 주세요(수강 중인 학생이 없습니다)."
}

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
		const linkedStudents = await deps.fullRelationIds(ev, "학생"), linkedClasses = await deps.fullRelationIds(ev, "클래스")
		for (const sid of linkedStudents) {
			const st: any = await deps.getPage(sid)
			const own = await Promise.all((await deps.fullRelationIds(st, "등록")).map((id: string) => deps.getPage(id)))
			const active = own.filter(isActiveReg)
			if (active[0]) regs.push(active[0])
		}
		for (const cid of linkedClasses) regs.push(...await activeRegsOfClass(cid))
		const seen = new Set<string>(), targets: any[] = []
		for (const r of regs) {
			const sk = key(relIds(r.properties?.["학생정보"])[0] ?? r.id)
			if (seen.has(sk)) continue
			seen.add(sk)
			targets.push(r)
		}
		if (!targets.length) return await deps.markError(p.eventId, noTargetMessage(ev, linkedStudents.length + linkedClasses.length > 0))
		// 다른 알림톡처럼 일정 페이지의 "변수(알림톡)" 수식 값을 보낸다(없으면 옛 (일정안내) 수식, 그것도 비면 같은 규칙으로 계산).
		// (v2.8.0 통일안) 새 템플릿의 #{일정정보}와 옛 템플릿의 #{일정일시}·#{전달사항}을 함께 만든다. 보낼 때 템플릿에 있는 것만 남는다.
		const note = getFormulaText(ev, "전달사항(일정안내)").trim() || noteText(textOf(ev.properties?.["메모"]?.rich_text))
		// 일시는 수식을 읽지 않는다(API의 수식 날짜는 UTC라 시각이 9시간 어긋남). 서버가 서울 시각으로.
		const time = eventTimeText(ev)
		const vars = {
			"#{일정구분}": alimtalkVar(ev, "일정구분", eventLabel(ev), "일정구분(일정안내)"),
			"#{일정명}": alimtalkVar(ev, "일정명", textOf(ev.properties?.["이름"]?.title).trim() || `${eventLabel(ev)} 일정`, "일정명(일정안내)"),
			"#{일정정보}": eventInfoBlock({ time, note }),
			"#{일정일시}": time,
			"#{전달사항}": note,
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

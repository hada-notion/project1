// _shared/timetableNotice.ts
//
// (v2.8.0, 10/31) 시간표 변경 안내 알림톡. 반의 수업 시간표가 바뀌었을 때 그 반 수강 중 학생마다 한 통씩 보낸다.
// 클래스 [시간표 변경 안내] 버튼 → send-lesson-notice/timetable(웹훅) → 큐 "반 1건" → 학생 1건씩.
//
// 한 건(학생) 처리:
//   - 지금 시간표는 등록의 `시간표` 관계(요일·등원·하원 시각)로 서버가 만든다("월·수 16:00~18:00").
//     Notion에 `시간표(알림톡)` 수식이 있으면 그 값을 먼저 쓴다.
//   - 기존 시간표는 등록 `안내한 시간표`(서버가 보낸 뒤 적는 글자). 처음 보내는 학생은 비어 있어 🔁 기존 줄 없이 보낸다.
//     `안내한 시간표`가 지금 시간표와 같으면 이미 안내한 학생이라 건너뛴다(다시 눌러도 두 번 가지 않음).
//     같은 시간표로 다시 보내려면 그 학생의 `안내한 시간표`를 비운다.
//   - 적용일은 클래스 `시간표 적용일`(날짜, 비면 그 줄 없음), 전달사항은 클래스 `시간표 안내 메모`(50자, 비면 "없음").
//     날짜는 Notion 수식이 UTC로 계산하는 문제가 있어 서버가 서울 날짜로 만든다(알림톡 기준 3장).
//   - 알림톡 설정의 "시간표 변경 안내" 행이 꺼져 있거나 템플릿 ID가 비면 보내지 않는다(다른 템플릿으로 잘못 나가지 않게).
//   - 학생마다 실패 사유는 클래스 `마지막 오류`에 이어 적고, 마지막 학생 뒤에 반 상태를 ✅ 완료 / ⚠️ 오류로 정한다.
import { createSendLogEntry, extractErrorMessage, getBotUserId } from "./adminShared.ts"
import { getFormulaText } from "./alimtalkShared.ts"
import { getPage, queryAllPages, relIds, updatePageProperties } from "./notionClient.ts"
import { DS_REGISTRATION, PROP_LAST_ERROR, PROP_TIMETABLE } from "./constants.ts"
import { enqueueSync } from "./syncQueue.ts"
import { markDone, markError, markRunning, type StatusSpec } from "./statusTracking.ts"
import { alimtalkVar } from "./noticeBlocks.ts"
import { LessonConfigError, noteText, sendConfiguredAlimtalk } from "./lessonNotice.ts"
import { seoulDay, studentNameOf } from "./classReportPlan.ts"

export const TIMETABLE_NOTICE_STATUS_SPEC: StatusSpec = {
	statusProp: "시간표 안내 상태",
	errorProp: PROP_LAST_ERROR,
	startedAtProp: "시간표 안내 처리 시작 시각",
}
export const TARGET_CLASS_TIMETABLE_NOTICE = "class-timetable-notice"
export const TARGET_TIMETABLE_NOTICE = "timetable-notice"
export const TIMETABLE_SENT_PROP = "안내한 시간표" // 등록(학원) DB, 서버가 적는 글자
export const TIMETABLE_APPLY_PROP = "시간표 적용일" // 클래스(학원) DB
export const TIMETABLE_MEMO_PROP = "시간표 안내 메모" // 클래스(학원) DB

export type ClassTimetablePayload = { classId: string; clickerUserId?: string | null }
export type TimetablePayload = ClassTimetablePayload & { regId: string; last?: boolean }

const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"]
const WEEKDAY_OF_DATE = ["일", "월", "화", "수", "목", "금", "토"]
const textOf = (arr: any): string => (Array.isArray(arr) ? arr.map((t: any) => t?.plain_text ?? t?.text?.content ?? "").join("") : "")
const gone = (p: any) => p?.in_trash || p?.archived

export type Slot = { day: string; start: string; end: string }

// 시간표 페이지 → 요일·시각. 요일이 없으면 빼고, 시각이 비면 그 자리만 비운다.
export function slotOf(page: any): Slot | null {
	const p = page?.properties ?? {}
	const day = String(p["요일"]?.select?.name ?? "").trim()
	if (!day) return null
	return { day, start: textOf(p["등원시간(HH:mm)"]?.rich_text).trim(), end: textOf(p["하원시간(HH:mm)"]?.rich_text).trim() }
}

// "월·수 16:00~18:00". 시각이 다른 요일은 묶음을 나눠 " / "로 잇는다("월 16:00~18:00 / 수 17:00~19:00").
// 요일은 월→일 순서. 같은 요일·시각이 두 번이면 한 번만.
export function timetableText(slots: Slot[]): string {
	const order = (d: string) => { const i = WEEKDAYS.indexOf(d); return i < 0 ? 99 : i }
	const sorted = [...slots].sort((a, b) => order(a.day) - order(b.day) || a.start.localeCompare(b.start))
	const groups: { time: string; days: string[] }[] = []
	for (const s of sorted) {
		const time = s.start && s.end ? `${s.start}~${s.end}` : s.start || s.end
		const g = groups.find((x) => x.time === time)
		if (!g) groups.push({ time, days: [s.day] })
		else if (!g.days.includes(s.day)) g.days.push(s.day)
	}
	return groups.map((g) => `${g.days.join("·")}${g.time ? " " + g.time : ""}`).join(" / ")
}

// 목록 안 날짜 "11.03(화)"(알림톡 기준 1장).
export function shortDay(value: string | null | undefined): string {
	const d = seoulDay(value)
	if (!d) return ""
	const t = new Date(`${d}T00:00:00Z`)
	return `${d.slice(5, 7)}.${d.slice(8, 10)}(${WEEKDAY_OF_DATE[t.getUTCDay()]})`
}

// [변경 정보] 구역 변수. 🕒 변경 줄은 늘 있다(지금 시간표가 비면 보내지 않음).
export function timetableInfoBlock(o: { before?: string; after: string; applyOn?: string }): string {
	return [
		...(o.before && o.before !== o.after ? [`🔁 기존  ${o.before}`] : []),
		`🕒 변경  ${o.after}`,
		...(o.applyOn ? [`📅 적용  ${o.applyOn}부터`] : []),
	].join("\n")
}

export type TimetablePlan = { skip: string } | { now: string; variables: Record<string, string> }

// 등록·시간표·클래스 페이지로 무엇을 보낼지 정한다(네트워크 없음). skip이 빈 글자면 이미 안내한 학생.
export function planTimetableNotice(reg: any, timetables: any[], cls: any): TimetablePlan {
	const now = getFormulaText(reg, "시간표(알림톡)").trim() || timetableText(timetables.map(slotOf).filter((s): s is Slot => !!s))
	if (!now) return { skip: "등록에 연결된 시간표가 없습니다." }
	const before = textOf(reg?.properties?.[TIMETABLE_SENT_PROP]?.rich_text).trim()
	if (before && before === now) return { skip: "" }
	const cp = cls?.properties ?? {}
	const className = textOf(cp["클래스명"]?.title).trim()
	return {
		now,
		variables: {
			"#{학생이름}": alimtalkVar(reg, "학생이름", studentNameOf(reg)),
			"#{클래스}": alimtalkVar(reg, "클래스", className),
			"#{시간표정보}": timetableInfoBlock({ before, after: now, applyOn: shortDay(cp[TIMETABLE_APPLY_PROP]?.date?.start) }),
			"#{전달사항}": noteText(textOf(cp[TIMETABLE_MEMO_PROP]?.rich_text)),
		},
	}
}

// 수강 중인 등록: '수강상태' 수식에 "수강 중"이 있으면. 수식이 없는 운영이면 종료일이 비었거나 오늘 이후.
export function activeRegistration(reg: any, today: string): boolean {
	if (gone(reg)) return false
	const status = String(reg?.properties?.["수강상태"]?.formula?.string ?? "")
	if (status) return status.includes("수강 중")
	const ended = seoulDay(reg?.properties?.["종료일"]?.date?.start)
	return !ended || ended >= today
}

// 테스트에서 Notion·발송·큐를 바꿔 끼울 수 있게 한다.
export const timetableNoticeDeps = {
	getPage,
	queryAllPages,
	update: updatePageProperties,
	enqueue: enqueueSync,
	send: sendConfiguredAlimtalk,
	log: createSendLogEntry,
	botUser: getBotUserId,
	markRunning: (id: string) => markRunning(id, TIMETABLE_NOTICE_STATUS_SPEC),
	markDone: (id: string) => markDone(id, TIMETABLE_NOTICE_STATUS_SPEC),
	markError: (id: string, message: string) => markError(id, TIMETABLE_NOTICE_STATUS_SPEC, message),
	today: () => seoulDay(new Date().toISOString()) ?? "",
}

// 큐 "반 1건": 수강 중 학생마다 한 건씩 넣는다. 반의 '마지막 오류'는 비우고 시작한다(학생 실패를 모으려고).
export async function processClassTimetableNoticeQueueItem(payload: ClassTimetablePayload): Promise<void> {
	const deps = timetableNoticeDeps
	const p = payload
	try {
		await deps.markRunning(p.classId)
		await deps.update(p.classId, { [PROP_LAST_ERROR]: { rich_text: [] } })
		const today = deps.today()
		const regs = (await deps.queryAllPages(DS_REGISTRATION, { property: "클래스", relation: { contains: p.classId } }))
			.filter((r: any) => activeRegistration(r, today))
		console.log(`[timetable-notice] class=${p.classId} 수강 중 ${regs.length}명`)
		if (!regs.length) return await deps.markError(p.classId, "이 반에 수강 중인 학생이 없습니다.")
		for (let i = 0; i < regs.length; i++) {
			await deps.enqueue(TARGET_TIMETABLE_NOTICE, { ...p, regId: String(regs[i].id), ...(i === regs.length - 1 ? { last: true } : {}) })
		}
	} catch (err) {
		await deps.markError(p.classId, (err as Error).message).catch(() => {})
		throw err
	}
}

// 반 '마지막 오류'에 한 줄 더한다.
async function appendClassError(classId: string, line: string): Promise<void> {
	const deps = timetableNoticeDeps
	const cls: any = await deps.getPage(classId).catch(() => null)
	const prev = textOf(cls?.properties?.[PROP_LAST_ERROR]?.rich_text).trim()
	const next = (prev ? prev + "\n" : "") + line
	await deps.update(classId, { [PROP_LAST_ERROR]: { rich_text: [{ text: { content: next.slice(-1900) } }] } }).catch(() => {})
}

// 마지막 학생 뒤: 모인 오류가 있으면 ⚠️ 오류, 아니면 ✅ 완료.
async function finishClass(classId: string): Promise<void> {
	const deps = timetableNoticeDeps
	const cls: any = await deps.getPage(classId)
	const error = textOf(cls?.properties?.[PROP_LAST_ERROR]?.rich_text).trim()
	if (error) await deps.markError(classId, error)
	else await deps.markDone(classId)
}

// 큐 "학생 1건". 읽기 단계에서 실패하면 큐가 다시 한다. 발송 단계에서 실패하면 다시 보내지 않는다(이미 나갔을 수 있음).
export async function processTimetableNoticeQueueItem(payload: TimetablePayload): Promise<void> {
	const deps = timetableNoticeDeps
	const p = payload
	const reg: any = await deps.getPage(p.regId)
	const cls: any = await deps.getPage(p.classId)
	const timetables = []
	for (const id of relIds(reg?.properties?.[PROP_TIMETABLE])) {
		const t: any = await deps.getPage(id).catch(() => null)
		if (t && !gone(t) && (relIds(t.properties?.["클래스"]).length === 0 || relIds(t.properties?.["클래스"]).some((c) => c.replace(/-/g, "") === p.classId.replace(/-/g, "")))) timetables.push(t)
	}
	const plan = planTimetableNotice(reg, timetables, cls)
	const name = studentNameOf(reg) || "학생"
	if ("skip" in plan) {
		if (plan.skip) await appendClassError(p.classId, `${name}: ${plan.skip}`)
	} else {
		const senderUserId = (p.clickerUserId ?? (await deps.botUser().catch(() => null))) ?? undefined
		try {
			await deps.send("시간표 변경 안내", p.regId, "", plan.variables)
			await deps.log({ registrationId: p.regId, senderUserId, title: name, category: "시간표 변경 안내", status: "성공" })
			await deps.update(p.regId, { [TIMETABLE_SENT_PROP]: { rich_text: [{ text: { content: plan.now.slice(0, 1900) } }] } })
			console.log(`[timetable-notice] sent: reg=${p.regId}`)
		} catch (err) {
			const reason = extractErrorMessage(err)
			if (!(err instanceof LessonConfigError) && !/연락처 오류/.test(reason)) {
				await deps.log({ registrationId: p.regId, senderUserId, title: name, category: "시간표 변경 안내", status: "실패", failReason: reason }).catch(() => {})
			}
			await appendClassError(p.classId, `${name}: ${reason}`)
		}
	}
	if (p.last) await finishClass(p.classId)
}

// _shared/timetableNotice.ts
//
// (v2.8.0, 10/31) 시간표 변경 안내 알림톡. 학생(등록)마다 한 통. 그룹 수업은 반 시간표가, 개별 수업은 학생 시간표가 바뀌므로
// 보내는 단위를 등록으로 둔다(10/31 사용자).
//   - 클래스 [시간표 변경 안내]: 그 반 수강 중 등록의 `시간표 안내 상태`를 ⚪ 대기로 바꾸기만 한다(Notion 버튼, 일괄 전송과 같은 방식).
//   - 등록 [시간표 변경 안내]: 그 등록 하나를 ⚪ 대기로(개별 수업).
//   - 등록 DB 자동화 "[웹훅] 시간표 안내"(⚪ 대기가 되면) → send-lesson-notice/timetable → 큐 한 건(이 모듈).
//
// 시간표 `적용 기간`(10/31 사용자): 시간표가 바뀔 때 예전 시간표에 끝날(~11/2), 새 시간표에 시작일(11/3~)을 넣고 등록에 둘 다
// 연결해 둔다. 비면 계속, 시작일만 있으면 그날부터 계속. 그 날짜에 적용 중인 시간표만 보인다.
//
// 한 건 처리:
//   - 이 등록의 반 시간표(반이 없는 개별 시간표는 함께) 중 오늘 적용 중인 것 = 지금, 오늘 뒤에 시작하는 것 중 가장 이른 시작일에
//     적용될 것 = 새 시간표. 둘이 함께 있을 때(바뀌기 전)만 🕒 기존 · 🕒 변경 · 📅 적용(새 시간표 시작일). 새 시간표가 없으면
//     (바로 바꾼 경우) 🕒 변경 한 줄.
//   - 보낸 뒤 등록 `안내한 시간표`에 변경 후 시간표를 적는다. 같으면 이미 안내한 학생이라 보내지 않고 ✅(다시 눌러도 두 번 가지 않음).
//     같은 시간표로 다시 보내려면 그 학생의 `안내한 시간표`를 비운다.
//   - 전달사항은 등록 `안내 메모` → 없으면 클래스 `시간표 안내 메모`(50자, 비면 "없음"). 등록 메모는 보낸 뒤 비운다.
//   - 변수는 등록 수식 `학생이름(알림톡)`·`클래스(알림톡)`·`시간표정보(알림톡)`·`전달사항(시간표안내)`을 먼저 쓰고, 없거나 비면 서버가
//     같은 모양으로 만든다.
//   - 알림톡 설정의 "시간표 변경 안내" 행이 꺼져 있거나 템플릿 ID가 비면 보내지 않는다(다른 템플릿으로 잘못 나가지 않게).
//   - 상태는 등록 `시간표 안내 상태`(⏳→🔄→✅/⚠️), 실패 사유는 등록 `마지막 오류`.
import { createSendLogEntry, extractErrorMessage, getBotUserId } from "./adminShared.ts"
import { getFormulaText } from "./alimtalkShared.ts"
import { getPage, relIds, updatePageProperties } from "./notionClient.ts"
import { PROP_LAST_ERROR, PROP_TIMETABLE } from "./constants.ts"
import { markDone, markError, markRunning, type StatusSpec } from "./statusTracking.ts"
import { alimtalkVar } from "./noticeBlocks.ts"
import { LessonConfigError, noteText, sendConfiguredAlimtalk } from "./lessonNotice.ts"
import { seoulDay, studentNameOf } from "./classReportPlan.ts"

export const TIMETABLE_NOTICE_STATUS_SPEC: StatusSpec = {
	statusProp: "시간표 안내 상태",
	errorProp: PROP_LAST_ERROR,
	startedAtProp: "시간표 안내 처리 시작 시각",
}
export const TARGET_TIMETABLE_NOTICE = "timetable-notice"
export const TIMETABLE_SENT_PROP = "안내한 시간표" // 등록(학원) DB, 서버가 적는 글자
export const TIMETABLE_PERIOD_PROP = "적용 기간" // 시간표(학원) DB
export const TIMETABLE_CLASS_MEMO_PROP = "시간표 안내 메모" // 클래스(학원) DB
export const REG_MEMO_PROP = "안내 메모" // 등록(학원) DB (등록 안내·클래스 변경 안내와 함께 씀)

export type TimetablePayload = { regId: string; clickerUserId?: string | null }

const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"]
const WEEKDAY_OF_DATE = ["일", "월", "화", "수", "목", "금", "토"]
const textOf = (arr: any): string => (Array.isArray(arr) ? arr.map((t: any) => t?.plain_text ?? t?.text?.content ?? "").join("") : "")
const gone = (p: any) => p?.in_trash || p?.archived
const key = (id: string) => String(id ?? "").replace(/-/g, "").toLowerCase()

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

// 시간표 `적용 기간`. 비면 계속, 시작일만 있으면(끝이 시작과 같으면) 그날부터 계속.
export function periodOf(t: any): { start: string | null; end: string | null } {
	const d = t?.properties?.[TIMETABLE_PERIOD_PROP]?.date
	const start = seoulDay(d?.start)
	const end = seoulDay(d?.end)
	return { start, end: end && end !== start ? end : null }
}

// 그 날짜에 적용 중인 시간표인지.
export function activeOn(t: any, day: string): boolean {
	const p = periodOf(t)
	return (!p.start || p.start <= day) && (!p.end || p.end >= day)
}

export const textOn = (timetables: any[], day: string) => timetableText(timetables.filter((t) => activeOn(t, day)).map(slotOf).filter((s): s is Slot => !!s))

// [변경 정보] 구역 변수. 🕒 변경 줄은 늘 있다(시간표가 비면 보내지 않음). 🔁는 쓰지 않는다(보강 일시 전용, 10/31).
export function timetableInfoBlock(o: { before?: string; after: string; applyOn?: string }): string {
	return [
		...(o.before && o.before !== o.after ? [`🕒 기존  ${o.before}`] : []),
		`🕒 변경  ${o.after}`,
		...(o.applyOn ? [`📅 적용  ${o.applyOn}부터`] : []),
	].join("\n")
}

// 등록의 시간표 중 이 등록 반의 것(반이 없는 시간표는 함께). 반을 모르면 모두.
export function ownTimetables(timetables: any[], classId: string | undefined): any[] {
	return timetables.filter((t) => {
		if (!t || gone(t)) return false
		const cls = relIds(t.properties?.["클래스"])
		return !classId || !cls.length || cls.some((c) => key(c) === key(classId))
	})
}

// 오늘 적용 중인 시간표와, 오늘 뒤 가장 이른 시작일에 적용될 시간표.
export function timetableChange(timetables: any[], today: string): { before: string; after: string; applyOn: string } {
	const current = textOn(timetables, today)
	const nextStart = timetables.map((t) => periodOf(t).start).filter((s): s is string => !!s && s > today).sort()[0] ?? ""
	const next = nextStart ? textOn(timetables, nextStart) : ""
	if (!next) return { before: "", after: current, applyOn: "" }
	return { before: current !== next ? current : "", after: next, applyOn: nextStart }
}

export type TimetablePlan = { skip: string } | { now: string; variables: Record<string, string>; usedRegMemo: boolean }

// 등록·시간표·클래스 페이지로 무엇을 보낼지 정한다(네트워크 없음). skip이 빈 글자면 이미 안내한 학생.
export function planTimetableNotice(reg: any, timetables: any[], cls: any, today: string): TimetablePlan {
	const ch = timetableChange(timetables, today)
	if (!ch.after) return { skip: "적용 중이거나 앞으로 적용될 시간표가 없습니다." }
	const rp = reg?.properties ?? {}
	const sent = textOf(rp[TIMETABLE_SENT_PROP]?.rich_text).trim()
	if (sent && sent === ch.after) return { skip: "" }
	const cp = cls?.properties ?? {}
	const regMemo = textOf(rp[REG_MEMO_PROP]?.rich_text).trim()
	return {
		now: ch.after,
		usedRegMemo: !!regMemo,
		variables: {
			"#{학생이름}": alimtalkVar(reg, "학생이름", studentNameOf(reg)),
			"#{클래스}": alimtalkVar(reg, "클래스", textOf(cp["클래스명"]?.title).trim()),
			"#{시간표정보}": alimtalkVar(reg, "시간표정보", timetableInfoBlock({ before: ch.before, after: ch.after, applyOn: shortDay(ch.applyOn) })),
			// 등록 안내의 전달사항(알림톡)과 값이 달라(클래스 메모로 넘어감) 따로 둔 수식.
			"#{전달사항}": getFormulaText(reg, "전달사항(시간표안내)").trim() || noteText(regMemo || textOf(cp[TIMETABLE_CLASS_MEMO_PROP]?.rich_text)),
		},
	}
}

// 테스트에서 Notion·발송을 바꿔 끼울 수 있게 한다.
export const timetableNoticeDeps = {
	getPage,
	update: updatePageProperties,
	send: sendConfiguredAlimtalk,
	log: createSendLogEntry,
	botUser: getBotUserId,
	today: () => seoulDay(new Date().toISOString()) ?? "",
	markRunning: (id: string) => markRunning(id, TIMETABLE_NOTICE_STATUS_SPEC),
	markDone: (id: string) => markDone(id, TIMETABLE_NOTICE_STATUS_SPEC),
	markError: (id: string, message: string) => markError(id, TIMETABLE_NOTICE_STATUS_SPEC, message),
}

// 큐 한 건(등록 하나). 읽기 단계 실패는 큐가 다시 한다. 발송 단계 실패는 다시 보내지 않고 ⚠️(이미 나갔을 수 있음).
export async function processTimetableNoticeQueueItem(payload: TimetablePayload): Promise<void> {
	const deps = timetableNoticeDeps
	const p = payload
	await deps.markRunning(p.regId)
	const reg: any = await deps.getPage(p.regId)
	if (gone(reg)) return
	const classId = relIds(reg?.properties?.["클래스"])[0]
	const cls: any = classId ? await deps.getPage(classId).catch(() => null) : null
	const all = []
	for (const id of relIds(reg?.properties?.[PROP_TIMETABLE])) all.push(await deps.getPage(id).catch(() => null))
	const plan = planTimetableNotice(reg, ownTimetables(all, classId), cls, deps.today())
	if ("skip" in plan) return plan.skip ? await deps.markError(p.regId, plan.skip) : await deps.markDone(p.regId)
	const name = studentNameOf(reg) || "학생"
	const senderUserId = (p.clickerUserId ?? (await deps.botUser().catch(() => null))) ?? undefined
	try {
		await deps.send("시간표 변경 안내", p.regId, "", plan.variables)
	} catch (err) {
		const reason = extractErrorMessage(err)
		if (!(err instanceof LessonConfigError) && !/연락처 오류/.test(reason)) {
			await deps.log({ registrationId: p.regId, senderUserId, title: name, category: "시간표 변경 안내", status: "실패", failReason: reason }).catch(() => {})
		}
		return await deps.markError(p.regId, reason)
	}
	await deps.log({ registrationId: p.regId, senderUserId, title: name, category: "시간표 변경 안내", status: "성공" })
	await deps.update(p.regId, {
		[TIMETABLE_SENT_PROP]: { rich_text: [{ text: { content: plan.now.slice(0, 1900) } }] },
		...(plan.usedRegMemo ? { [REG_MEMO_PROP]: { rich_text: [] } } : {}),
	}).catch(() => {})
	await deps.markDone(p.regId)
	console.log(`[timetable-notice] sent: reg=${p.regId}`)
}

// _shared/registrationNotice.ts
//
// (v2.8.0, 10/31) 등록 안내·클래스 변경 안내 알림톡. 상담 → 등록 → 시간표·클래스 변경으로 이어지는 안내 중 등록 단계.
// 등록 페이지 [등록 안내]·[클래스 변경 안내] → send-lesson-notice/registration · /class-change → 큐 한 건(이 모듈).
//
//   - 등록 안내: [기본 정보] 👤 학생 · 🏫 학교 · 🎓 학년(학생정보, 비면 "-") / [등록 정보] 🏛 클래스 · 📅 시작(등록일) · 🕒 시간(등록 시간표)
//     / [전달 사항] 등록 `안내 메모`
//     / 버튼 학부모 리포트(토큰이 없으면 만든다).
//   - 클래스 변경 안내: 반을 옮기면 예전 등록을 종료하고 새 반 등록을 만든다(등록 = 학생 × 클래스). 새 등록에서 누르면
//     같은 학생의 다른 반 등록 중 종료일이 이 등록일 이전(또는 같은 날)이고 가장 늦은 것을 "기존"으로 찾는다.
//     [변경 정보] 🔁 기존 반 · 🏛 변경 반 · 🕒 시간 · 📅 적용(등록일). 못 찾으면 보내지 않는다.
//   - 보낸 뒤 등록 `안내한 시간표`에 지금 시간표를 적고(다음 시간표 변경 안내의 🔁 기존 줄, _shared/timetableNotice.ts),
//     한 번 쓰는 `안내 메모`는 비운다.
//   - 변수는 등록의 `이름(알림톡)` 수식(학생이름·학교·학년·클래스·등록정보·변경정보·전달사항)을 먼저 쓰고, 수식이 없거나 비면
//     서버가 같은 모양으로 만든다(등록일은 날짜만이라 수식의 UTC 문제가 없다). 설정 행이 꺼져 있으면 보내지 않는다.
//   - 상태는 등록 `안내 상태`(⏳→🔄→✅/⚠️), 실패 사유는 등록 `마지막 오류`.
import { createSendLogEntry, extractErrorMessage, getBotUserId, type SendLogCategory } from "./adminShared.ts"
import { syncStudentReport } from "./alimtalkShared.ts"
import { getPage, queryAllPages, relIds, updatePageProperties } from "./notionClient.ts"
import { DS_REGISTRATION, PROP_LAST_ERROR, PROP_TIMETABLE } from "./constants.ts"
import { markDone, markError, markRunning, type StatusSpec } from "./statusTracking.ts"
import { alimtalkVar } from "./noticeBlocks.ts"
import { LessonConfigError, noteText, sendConfiguredAlimtalk } from "./lessonNotice.ts"
import { seoulDay, studentNameOf } from "./classReportPlan.ts"
import { ownTimetables, REG_MEMO_PROP, shortDay, slotOf, timetableText, TIMETABLE_SENT_PROP, type Slot } from "./timetableNotice.ts"

export const REGISTRATION_NOTICE_STATUS_SPEC: StatusSpec = {
	statusProp: "안내 상태",
	errorProp: PROP_LAST_ERROR,
	startedAtProp: "안내 처리 시작 시각",
}
export const TARGET_REGISTRATION_NOTICE = "registration-notice"
export const REGISTRATION_MEMO_PROP = REG_MEMO_PROP // 등록(학원) DB, 보낸 뒤 비운다(시간표 변경 안내와 함께 씀)

export type RegistrationNoticeKind = "등록 안내" | "클래스 변경 안내"
export type RegistrationNoticePayload = { regId: string; kind: RegistrationNoticeKind; clickerUserId?: string | null }

const REPORT_PATH = Deno.env.get("REPORT_PATH") ?? "/project1/student_report.html"
const textOf = (arr: any): string => (Array.isArray(arr) ? arr.map((t: any) => t?.plain_text ?? t?.text?.content ?? "").join("") : "")
const gone = (p: any) => p?.in_trash || p?.archived
const key = (id: string) => String(id ?? "").replace(/-/g, "").toLowerCase()

export function classNameOf(cls: any): string {
	return textOf(cls?.properties?.["클래스명"]?.title).trim()
}

// 페이지 제목(학교·학년 페이지). 제목 속성 이름이 DB마다 달라 종류로 찾는다.
export function titleOf(page: any): string {
	for (const v of Object.values(page?.properties ?? {}) as any[]) if (v?.type === "title") return textOf(v.title).trim()
	return ""
}

// [등록 정보] 등록 안내 블록(🏛 클래스 줄 다음). 📅 시작은 늘 있다(등록일이 비면 보내지 않음).
export function enrollInfoBlock(o: { startOn: string; time?: string }): string {
	return [`📅 시작  ${o.startOn}부터`, ...(o.time ? [`🕒 시간  ${o.time}`] : [])].join("\n")
}

// [변경 정보] 클래스 변경 안내 블록.
export function classChangeBlock(o: { before: string; after: string; time?: string; applyOn: string }): string {
	return [`🔁 기존  ${o.before}`, `🏛 변경  ${o.after}`, ...(o.time ? [`🕒 시간  ${o.time}`] : []), `📅 적용  ${o.applyOn}부터`].join("\n")
}

// 같은 학생의 다른 반 등록 중 "직전 반": 종료일이 이 등록일 이전(같은 날 포함)인 것 중 가장 늦게 끝난 것.
export function previousRegistration(reg: any, others: any[]): any | null {
	const start = seoulDay(reg?.properties?.["등록일"]?.date?.start)
	if (!start) return null
	const myClass = relIds(reg?.properties?.["클래스"])[0] ?? ""
	let best: any = null, bestEnd = ""
	for (const o of others) {
		if (gone(o) || key(o.id) === key(reg.id)) continue
		const cls = relIds(o?.properties?.["클래스"])[0] ?? ""
		if (!cls || key(cls) === key(myClass)) continue
		const end = seoulDay(o?.properties?.["종료일"]?.date?.start)
		if (!end || end > start) continue
		if (end > bestEnd) { best = o; bestEnd = end }
	}
	return best
}

export type RegistrationPlan = { error: string } | { variables: Record<string, string>; timetable: string }

// 등록·반·시간표(·직전 반) 페이지로 무엇을 보낼지 정한다(네트워크 없음). reportLink는 버튼 #{페이지ID} 값.
export function planRegistrationNotice(kind: RegistrationNoticeKind, reg: any, cls: any, timetables: any[], prevClass: any | null, reportLink: string, student: { school?: string; grade?: string } = {}): RegistrationPlan {
	const startOn = shortDay(reg?.properties?.["등록일"]?.date?.start)
	if (!startOn) return { error: "등록일이 비어 있습니다." }
	const className = classNameOf(cls)
	if (!className) return { error: "등록의 클래스가 비어 있습니다." }
	const time = timetableText(timetables.map(slotOf).filter((s): s is Slot => !!s))
	const common = {
		"#{학생이름}": alimtalkVar(reg, "학생이름", studentNameOf(reg)),
		"#{전달사항}": alimtalkVar(reg, "전달사항", noteText(textOf(reg?.properties?.[REGISTRATION_MEMO_PROP]?.rich_text))),
		"#{페이지ID}": reportLink,
	}
	if (kind === "등록 안내") {
		return { timetable: time, variables: {
			...common,
			"#{학교}": alimtalkVar(reg, "학교", student.school || "-"),
			"#{학년}": alimtalkVar(reg, "학년", student.grade || "-"),
			"#{클래스}": alimtalkVar(reg, "클래스", className),
			"#{등록정보}": alimtalkVar(reg, "등록정보", enrollInfoBlock({ startOn, time })),
		} }
	}
	// 등록 `변경정보(알림톡)` 수식이 있으면 그 값(수식이 직전 반을 찾는다), 없으면 서버가 찾은 직전 반으로.
	const own = alimtalkVar(reg, "변경정보", "")
	if (own) return { timetable: time, variables: { ...common, "#{변경정보}": own } }
	const before = classNameOf(prevClass)
	if (!before) return { error: "직전 반 등록을 찾지 못했습니다. 같은 학생의 예전 반 등록에 종료일(이 등록일 이전)이 있어야 합니다." }
	return { timetable: time, variables: { ...common, "#{변경정보}": classChangeBlock({ before, after: className, time, applyOn: startOn }) } }
}

// 테스트에서 Notion·발송을 바꿔 끼울 수 있게 한다.
export const registrationNoticeDeps = {
	getPage,
	queryAllPages,
	update: updatePageProperties,
	send: sendConfiguredAlimtalk,
	log: createSendLogEntry,
	botUser: getBotUserId,
	reportToken: async (regId: string) => (await syncStudentReport(regId)).access_token,
	markRunning: (id: string) => markRunning(id, REGISTRATION_NOTICE_STATUS_SPEC),
	markDone: (id: string) => markDone(id, REGISTRATION_NOTICE_STATUS_SPEC),
	markError: (id: string, message: string) => markError(id, REGISTRATION_NOTICE_STATUS_SPEC, message),
}

// 큐 한 건. 읽기 단계 실패는 큐가 다시 한다. 발송 단계 실패는 다시 보내지 않고 ⚠️(이미 나갔을 수 있음).
export async function processRegistrationNoticeQueueItem(payload: RegistrationNoticePayload): Promise<void> {
	const deps = registrationNoticeDeps
	const p = payload
	await deps.markRunning(p.regId)
	const reg: any = await deps.getPage(p.regId)
	const classId = relIds(reg?.properties?.["클래스"])[0]
	const cls: any = classId ? await deps.getPage(classId) : null
	const all = []
	for (const id of relIds(reg?.properties?.[PROP_TIMETABLE])) all.push(await deps.getPage(id).catch(() => null))
	const timetables = ownTimetables(all, classId)
	let prevClass: any = null
	const studentId = relIds(reg?.properties?.["학생정보"])[0]
	const student: { school?: string; grade?: string } = {}
	if (p.kind === "등록 안내" && studentId) {
		// 학교·학년은 학생정보의 관계(학교·학년 페이지 제목). 못 읽으면 "-".
		const st: any = await deps.getPage(studentId).catch(() => null)
		const schoolId = relIds(st?.properties?.["학교"])[0], gradeId = relIds(st?.properties?.["학년"])[0]
		if (schoolId) student.school = titleOf(await deps.getPage(schoolId).catch(() => null))
		if (gradeId) student.grade = titleOf(await deps.getPage(gradeId).catch(() => null))
	}
	if (p.kind === "클래스 변경 안내") {
		const others = studentId ? await deps.queryAllPages(DS_REGISTRATION, { property: "학생정보", relation: { contains: studentId } }) : []
		const prev = previousRegistration(reg, others)
		const prevClassId = prev ? relIds(prev.properties?.["클래스"])[0] : ""
		prevClass = prevClassId ? await deps.getPage(prevClassId) : null
	}
	const token = await deps.reportToken(p.regId)
	const plan = planRegistrationNotice(p.kind, reg, cls, timetables, prevClass, REPORT_PATH + "?token=" + token, student)
	if ("error" in plan) return await deps.markError(p.regId, plan.error)
	const name = studentNameOf(reg) || p.kind
	const category = p.kind as SendLogCategory
	const senderUserId = (p.clickerUserId ?? (await deps.botUser().catch(() => null))) ?? undefined
	try {
		await deps.send(category, p.regId, "", plan.variables)
	} catch (err) {
		const reason = extractErrorMessage(err)
		if (!(err instanceof LessonConfigError) && !/연락처 오류/.test(reason)) {
			await deps.log({ registrationId: p.regId, senderUserId, title: name, category, status: "실패", failReason: reason }).catch(() => {})
		}
		return await deps.markError(p.regId, reason)
	}
	await deps.log({ registrationId: p.regId, senderUserId, title: name, category, status: "성공" })
	// 안내한 시간표를 적고(다음 시간표 변경 안내의 🔁 기존 줄), 한 번 쓰는 안내 메모는 비운다.
	await deps.update(p.regId, {
		...(plan.timetable ? { [TIMETABLE_SENT_PROP]: { rich_text: [{ text: { content: plan.timetable.slice(0, 1900) } }] } } : {}),
		[REGISTRATION_MEMO_PROP]: { rich_text: [] },
	}).catch(() => {})
	await deps.markDone(p.regId)
	console.log(`[registration-notice] ${p.kind} sent: reg=${p.regId}`)
}

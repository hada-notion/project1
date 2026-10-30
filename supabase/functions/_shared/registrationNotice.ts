// _shared/registrationNotice.ts
//
// (v2.8.0, 10/31) 등록 안내·클래스 변경 안내 알림톡. 상담 → 등록 → 시간표·클래스 변경으로 이어지는 안내 중 등록 단계.
// 등록 페이지 [등록 안내]·[클래스 변경 안내] → send-lesson-notice/registration · /class-change → 큐 한 건(이 모듈).
//
//   - 등록 안내: [기본 정보] 👤 학생 · 🏫 학교 · 🎓 학년(학생정보, 비면 "-") / [등록 정보] 🏛 클래스 · 📅 시작(등록일) · 🕒 시간(등록 시간표)
//     / [전달 사항] 등록 `안내 메모`
//     / 버튼 학부모 리포트(토큰이 없으면 만든다).
//   - 클래스 변경 안내(10/31 사용자): 반을 옮기면 예전 등록을 종료하고 새 반 등록을 만든다(등록 = 학생 × 클래스). 새 등록에서
//     누르며, 본문·변수는 등록 안내와 같고 제목만 다르다. 예전 반·옮기는 이유는 안내 메모(전달사항)에 적는다.
//   - 시간은 등록일에 적용되는 시간표(시간표 `적용 기간`, 등록일이 지났으면 오늘). 새 반 등록이면 새 반 시간표가 나온다.
//   - 보낸 뒤 등록 `안내한 시간표`에 그 시간표를 적고(다음 시간표 변경 안내의 중복 확인, _shared/timetableNotice.ts),
//     한 번 쓰는 `안내 메모`는 비운다.
//   - 변수는 등록의 `이름(알림톡)` 수식(학생이름·학교·학년·클래스·등록정보·전달사항)을 먼저 쓰고, 수식이 없거나 비면
//     서버가 같은 모양으로 만든다(등록일은 날짜만이라 수식의 UTC 문제가 없다). 설정 행이 꺼져 있으면 보내지 않는다.
//   - 상태는 등록 `안내 상태`(⏳→🔄→✅/⚠️), 실패 사유는 등록 `마지막 오류`.
import { createSendLogEntry, extractErrorMessage, getBotUserId, type SendLogCategory } from "./adminShared.ts"
import { syncStudentReport } from "./alimtalkShared.ts"
import { getPage, relIds, updatePageProperties } from "./notionClient.ts"
import { PROP_LAST_ERROR, PROP_TIMETABLE } from "./constants.ts"
import { markDone, markError, markRunning, type StatusSpec } from "./statusTracking.ts"
import { alimtalkVar } from "./noticeBlocks.ts"
import { LessonConfigError, noteText, sendConfiguredAlimtalk } from "./lessonNotice.ts"
import { seoulDay, studentNameOf } from "./classReportPlan.ts"
import { ownTimetables, REG_MEMO_PROP, shortDay, textOn, TIMETABLE_SENT_PROP } from "./timetableNotice.ts"

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

export type RegistrationPlan = { error: string } | { variables: Record<string, string>; timetable: string }

// 등록·반·시간표 페이지로 무엇을 보낼지 정한다(네트워크 없음). 등록 안내·클래스 변경 안내가 같은 변수를 쓴다.
// reportLink는 버튼 #{페이지ID} 값, today는 서울 날짜(등록일이 지났으면 오늘 적용 중인 시간표).
export function planRegistrationNotice(reg: any, cls: any, timetables: any[], reportLink: string, today: string, student: { school?: string; grade?: string } = {}): RegistrationPlan {
	const startDay = seoulDay(reg?.properties?.["등록일"]?.date?.start)
	if (!startDay) return { error: "등록일이 비어 있습니다." }
	const className = classNameOf(cls)
	if (!className) return { error: "등록의 클래스가 비어 있습니다." }
	const time = textOn(timetables, startDay > today ? startDay : today)
	return { timetable: time, variables: {
		"#{학생이름}": alimtalkVar(reg, "학생이름", studentNameOf(reg)),
		"#{학교}": alimtalkVar(reg, "학교", student.school || "-"),
		"#{학년}": alimtalkVar(reg, "학년", student.grade || "-"),
		"#{클래스}": alimtalkVar(reg, "클래스", className),
		"#{등록정보}": alimtalkVar(reg, "등록정보", enrollInfoBlock({ startOn: shortDay(startDay), time })),
		"#{전달사항}": alimtalkVar(reg, "전달사항", noteText(textOf(reg?.properties?.[REGISTRATION_MEMO_PROP]?.rich_text))),
		"#{페이지ID}": reportLink,
	} }
}

// 테스트에서 Notion·발송을 바꿔 끼울 수 있게 한다.
export const registrationNoticeDeps = {
	getPage,
	update: updatePageProperties,
	send: sendConfiguredAlimtalk,
	log: createSendLogEntry,
	botUser: getBotUserId,
	reportToken: async (regId: string) => (await syncStudentReport(regId)).access_token,
	today: () => seoulDay(new Date().toISOString()) ?? "",
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
	const studentId = relIds(reg?.properties?.["학생정보"])[0]
	const student: { school?: string; grade?: string } = {}
	if (studentId) {
		// 학교·학년은 학생정보의 관계(학교·학년 페이지 제목). 못 읽으면 "-".
		const st: any = await deps.getPage(studentId).catch(() => null)
		const schoolId = relIds(st?.properties?.["학교"])[0], gradeId = relIds(st?.properties?.["학년"])[0]
		if (schoolId) student.school = titleOf(await deps.getPage(schoolId).catch(() => null))
		if (gradeId) student.grade = titleOf(await deps.getPage(gradeId).catch(() => null))
	}
	const token = await deps.reportToken(p.regId)
	const plan = planRegistrationNotice(reg, cls, timetables, REPORT_PATH + "?token=" + token, deps.today(), student)
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
	// 안내한 시간표를 적고(다음 시간표 변경 안내의 중복 확인), 한 번 쓰는 안내 메모는 비운다.
	await deps.update(p.regId, {
		...(plan.timetable ? { [TIMETABLE_SENT_PROP]: { rich_text: [{ text: { content: plan.timetable.slice(0, 1900) } }] } } : {}),
		[REGISTRATION_MEMO_PROP]: { rich_text: [] },
	}).catch(() => {})
	await deps.markDone(p.regId)
	console.log(`[registration-notice] ${p.kind} sent: reg=${p.regId}`)
}

// _shared/monthlyNotice.ts
//
// (v2.8.0) 가정통신문: 수강료와 월간 일정은 학생 단위로 보낸다(보고서는 등록 단위 반 발송함 그대로).
// 알림톡 발송함 DB의 구분 "가정통신문" 페이지 = 학생 × 달. 그 학생의 그 달 수강료(반마다 한 장)와 그 달 학부모 공개 일정을 묶는다.
//   1) 클래스 [월 수강료 생성] → send-monthly-notice/create → 큐. 클래스 `안내 기간`의 달(비면 누른 날의 다음 달, 서울)에 그 반을 다니는 등록마다: 그 학생의 가정통신문을
//      찾거나 만들고, 그 등록의 그 달 수강료가 없으면 만들어 연결한다(v2.7 등록 자동화 [생성] 수강료를 대신한다, 값은 같다).
//      그 달 일정도 가정통신문 `일정`에 묶어 둔다(미리보기용). 두 반을 듣는 학생은 두 반 수강료가 같은 가정통신문에 모인다.
//   2) 보내기: 가정통신문 [수강료 안내]·[월간 일정 안내] → /tuition·/schedule(그 학생 한 명),
//      클래스 [수강료 안내 일괄]·[월간 일정 안내] → /class-tuition·/class-schedule(그 반 학생들의 그 달 가정통신문, 달은 위와 같음).
//      이미 보낸 것은 건너뛴다(가정통신문 `수강료 안내 일시`·`일정 안내 일시`). 다시 보내려면 그 칸을 비우고 누른다.
//      그래서 두 반을 듣는 학생은 두 반에서 눌러도 한 번만 받는다.
//   수강료 안내 = 한 통에 반별 금액 줄(#{수강내역})과 합계(#{청구금액}). 다른 알림톡처럼 가정통신문 페이지의 (수강료안내) 수식 값을
//   먼저 쓰고, 없거나 비면 같은 규칙으로 계산한다. 보낸 뒤 각 수강료의 안내문 전송 상태를 ✅로, 전송로그는 수강료마다 하나.
//   월간 일정 안내 = 학생 개인·그 달 다니는 반 전부·학교·학년·학원 전체 공개 일정을 휴원·학원·학교 세 구역으로(리포트와 같은 규칙).
//   보낼 때 일정을 다시 묶는다(묶은 뒤 생긴 일정도 들어간다). 그 달 일정이 0건이면 보내지 않는다.
//   전달사항 = 가정통신문 메모, 비면 클래스 안내 메모, 둘 다 비면 "없음"(50자).
// 발송 규칙은 수업 안내와 같다(설정 행이 꺼졌거나 비면 ⚠️, 연락처 없음 ⚠️, 발송 단계 실패는 다시 보내지 않음).
import { createSendLogEntry, extractErrorMessage, getAlimtalkConfig, getBotUserId, getScheduleConfig } from "./adminShared.ts"
import { getFormulaText, getRollupText, syncStudentReport } from "./alimtalkShared.ts"
import { createPage, fullRelationIds, getPage, queryAllPages, relIds, updatePageProperties } from "./notionClient.ts"
import { DS_REGISTRATION, DS_SCHEDULE_EVENT, DS_TUITION, PROP_LAST_ERROR } from "./constants.ts"
import { enqueueSync } from "./syncQueue.ts"
import { markDone, markError, markRunning, type StatusSpec } from "./statusTracking.ts"
import { isParentPublicEvent } from "./scheduleVisibility.ts"
import { inPeriodRegistration, resolveBatchDataSourceId, seoulDay, studentNameOf } from "./classReportPlan.ts"
import { LessonConfigError, noteText, sendConfiguredAlimtalk } from "./lessonNotice.ts"
import { eventLine, inMonth, isAcademyWide, monthFilter, monthLabel, nextMonthKey, SCHEDULE_NOTICE_STATUS_SPEC, type Section, sectionOf, sectionText } from "./scheduleNotice.ts"

export const KIND_MONTHLY = "가정통신문"
// 가정통신문(발송함) 한 명 보내기
export const MONTHLY_STATUS_SPEC: StatusSpec = { statusProp: "가정통신문 상태", errorProp: PROP_LAST_ERROR, startedAtProp: "가정통신문 처리 시작 시각" }
// 클래스 [월 수강료 생성]
export const CLASS_TUITION_GEN_STATUS_SPEC: StatusSpec = { statusProp: "수강료 생성 상태", errorProp: PROP_LAST_ERROR, startedAtProp: "수강료 생성 처리 시작 시각" }
// 클래스 [수강료 안내 일괄]. 클래스 [월간 일정 안내]는 일정 안내 상태(SCHEDULE_NOTICE_STATUS_SPEC)를 쓴다.
export const CLASS_TUITION_NOTICE_STATUS_SPEC: StatusSpec = { statusProp: "수강료 안내 상태", errorProp: PROP_LAST_ERROR, startedAtProp: "수강료 안내 처리 시작 시각" }
export const TARGET_MONTHLY_CREATE_CLASS = "monthly-create-class"
export const TARGET_MONTHLY_CREATE_REG = "monthly-create-reg"
export const TARGET_MONTHLY_SEND_CLASS = "monthly-send-class"
export const TARGET_MONTHLY_SEND_STUDENT = "monthly-send-student"
export const TARGET_MONTHLY_SEND_BATCH = "monthly-send-batch"

// 알림톡 발송함(학원) DB
const PROP_BATCH_TITLE = "이름"
const PROP_BATCH_KIND = "구분"
const PROP_BATCH_PERIOD = "기간"
const PROP_BATCH_STUDENT = "학생"
const PROP_BATCH_EVENTS = "일정"
const PROP_BATCH_TUITION = "수강료"
const PROP_TUITION_SENT = "수강료 안내 일시"
const PROP_SCHEDULE_SENT = "일정 안내 일시"
const PROP_BATCH_NOTE = "가정통신문 메모"
// 클래스(학원) DB: 월간 일정 안내 전달사항(반 학생 모두). 학생 가정통신문 메모가 있으면 그것이 먼저.
const PROP_CLASS_NOTE = "안내 메모"
// 수강료(학원) DB
const PROP_TUITION_BATCH = "알림톡 발송함"
// 클래스(학원) DB: 가정통신문의 달(1일~말일). 비면 누른 날의 다음 달.
export const PROP_CLASS_NOTICE_PERIOD = "안내 기간"

export type NoticeKind = "tuition" | "schedule"
export type CreateClassPayload = { classId: string; month: string }
export type CreateRegPayload = { classId: string; month: string; regId: string; amount: number | null; last?: boolean }
export type SendClassPayload = { kind: NoticeKind; classId: string; month: string }
export type SendStudentPayload = { kind: NoticeKind; classId: string; month: string; studentId: string; studentName: string; last?: boolean }
export type SendBatchPayload = { kind: NoticeKind; batchId: string }
type Line = { id: string; day: string; line: string; sec: Section }

const textOf = (arr: any): string => (Array.isArray(arr) ? arr.map((t: any) => t?.plain_text ?? t?.text?.content ?? "").join("") : "")
const key = (id: string) => String(id ?? "").replace(/-/g, "").toLowerCase()
const alive = (p: any) => !!p && !p.in_trash && !p.archived
const won = (n: number) => `${Math.round(n).toLocaleString("en-US")}원`

// 클래스 버튼의 대상 달: 클래스 '안내 기간'의 시작일이 있는 달, 비면 누른 날의 다음 달(서울).
// 시작과 끝이 다른 달이면 고칠 곳을 문장으로 알린다(보고서 기간과 같은 방식).
export function monthFromClass(cls: any, now = new Date()): string {
	const d = cls?.properties?.[PROP_CLASS_NOTICE_PERIOD]?.date
	const start = seoulDay(d?.start)
	if (!start) return nextMonthKey(now)
	const end = seoulDay(d?.end)
	if (end && end.slice(0, 7) !== start.slice(0, 7)) throw new Error(`클래스 '${PROP_CLASS_NOTICE_PERIOD}'은 한 달 안(1일~말일)으로 넣어 주세요. 비우면 다음 달입니다.`)
	return start.slice(0, 7)
}

// "2026-12" → { start: "2026-12-01", end: "2026-12-31" }
export function monthRange(month: string): { start: string; end: string } {
	const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7))
	const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
	return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, "0")}` }
}
const yymmdd = (day: string) => `${day.slice(2, 4)}.${day.slice(5, 7)}.${day.slice(8, 10)}`
// 가정통신문 이름: "26.12 김하윤 가정통신문"(발송함 이름 자동화가 덮어쓰면 그 이름을 따른다)
export const batchTitle = (month: string, studentName: string) => `${month.slice(2, 4)}.${month.slice(5, 7)} ${studentName} ${KIND_MONTHLY}`
// 수강료 이름: "26.12 김하윤 수강료"(v2.7 [생성] 수강료 자동화의 청구명과 같다)
export const tuitionTitle = (month: string, studentName: string) => `${month.slice(2, 4)}.${month.slice(5, 7)} ${studentName} 수강료`

// 보내기 전에 막힌 경우(이미 보냄 제외). 다시 해도 같으므로 큐 재시도 없이 ⚠️.
export class MonthlyBlocked extends Error {}
// 발송 단계 실패(이미 전송로그를 남김). 다시 보내지 않는다.
export class MonthlySendFailed extends Error {}

// 테스트에서 Notion·발송을 바꿔 끼울 수 있게 한다.
export const monthlyDeps = {
	getPage,
	createPage,
	queryAllPages,
	update: updatePageProperties,
	fullRelationIds,
	enqueue: enqueueSync,
	batchDataSourceId: resolveBatchDataSourceId,
	config: getAlimtalkConfig,
	tuitionConfigRow: async () => (await getScheduleConfig("수강료 안내"))?.rowId ?? null,
	send: sendConfiguredAlimtalk,
	log: createSendLogEntry,
	botUser: getBotUserId,
	token: async (regId: string) => (await syncStudentReport(regId)).access_token,
	today: () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date()),
	markRunning: (id: string, spec: StatusSpec) => markRunning(id, spec),
	markDone: (id: string, spec: StatusSpec) => markDone(id, spec),
	markError: (id: string, spec: StatusSpec, message: string) => markError(id, spec, message),
}

const inMonthReg = (reg: any, month: string) => alive(reg) && inPeriodRegistration(reg, { kind: "", className: "", ...monthRange(month) })

async function appendError(pageId: string, line: string): Promise<void> {
	const deps = monthlyDeps
	const page: any = await deps.getPage(pageId).catch(() => null)
	const prev = textOf(page?.properties?.[PROP_LAST_ERROR]?.rich_text).trim()
	const next = (prev ? `${prev}\n${line}` : line).slice(0, 1900)
	await deps.update(pageId, { [PROP_LAST_ERROR]: { rich_text: [{ text: { content: next } }] } }).catch(() => {})
}

// 마지막 학생 뒤: 중간 실패가 '마지막 오류'에 남아 있으면 ⚠️ 오류, 아니면 ✅ 완료.
async function finishParent(pageId: string, spec: StatusSpec): Promise<void> {
	const deps = monthlyDeps
	const page: any = await deps.getPage(pageId)
	const err = textOf(page?.properties?.[PROP_LAST_ERROR]?.rich_text).trim()
	if (err) await deps.markError(pageId, spec, err)
	else await deps.markDone(pageId, spec)
}

// 그 학생의 그 달 가정통신문을 찾고, create면 없을 때 만든다. 발송함 DB에 '학생' 관계가 없으면 알아볼 수 있는 오류로.
export async function findStudentBatch(studentId: string, month: string, create: { studentName: string } | null): Promise<any | null> {
	const deps = monthlyDeps
	const ds = await deps.batchDataSourceId()
	const range = monthRange(month)
	let found: any[]
	try {
		found = await deps.queryAllPages(ds, {
			and: [
				{ property: PROP_BATCH_STUDENT, relation: { contains: studentId } },
				{ property: PROP_BATCH_KIND, select: { equals: KIND_MONTHLY } },
			],
		})
	} catch (err) {
		const msg = (err as Error).message
		if (/400/.test(msg)) throw new Error(`알림톡 발송함 DB에 '${PROP_BATCH_STUDENT}' 관계(학생 DB)와 구분 '${KIND_MONTHLY}'을 먼저 만들어 주세요. (${msg.slice(0, 200)})`)
		throw err
	}
	const same = found.find((b: any) => alive(b) && seoulDay(b?.properties?.[PROP_BATCH_PERIOD]?.date?.start) === range.start)
	if (same || !create) return same ?? null
	return await deps.createPage(ds, {
		[PROP_BATCH_TITLE]: { title: [{ text: { content: batchTitle(month, create.studentName) } }] },
		[PROP_BATCH_KIND]: { select: { name: KIND_MONTHLY } },
		[PROP_BATCH_PERIOD]: { date: { start: range.start, end: range.end } },
		[PROP_BATCH_STUDENT]: { relation: [{ id: studentId }] },
	})
}

// 그 달에 다니는 그 학생의 등록들.
async function studentRegsInMonth(studentId: string, month: string): Promise<any[]> {
	return (await monthlyDeps.queryAllPages(DS_REGISTRATION, { property: "학생정보", relation: { contains: studentId } })).filter((r: any) => inMonthReg(r, month))
}

const classNameOfReg = (reg: any) => getRollupText(reg, "클래스명(등록)").trim()

// 그 학생의 그 달 학부모 공개 일정(리포트와 같은 규칙): 학생 개인 + 다니는 반 전부 + 학원 전체 + 학교·학년(일정의 학교·학년이
// 비었거나 학생 것과 같을 때). 같은 일정은 한 번만, 날짜순.
export async function studentMonthEvents(studentId: string, month: string, classIds: string[]): Promise<Line[]> {
	const deps = monthlyDeps
	const st: any = await deps.getPage(studentId).catch(() => null)
	const schoolId = relIds(st?.properties?.["학교"])[0]
	const gradeId = relIds(st?.properties?.["학년"])[0]
	const q = (link: { prop: string; id: string } | null) =>
		deps.queryAllPages(DS_SCHEDULE_EVENT, { and: [...(link ? [{ property: link.prop, relation: { contains: link.id } }] : []), ...monthFilter(month)] })
	const [own, cls, academy, school, grade] = await Promise.all([
		q({ prop: "학생", id: studentId }),
		Promise.all(classIds.map((id) => q({ prop: "클래스", id }))).then((l) => l.flat()),
		q(null).then((rows) => rows.filter(isAcademyWide)),
		schoolId ? q({ prop: "학교", id: schoolId }) : Promise.resolve([]),
		gradeId ? q({ prop: "학년", id: gradeId }) : Promise.resolve([]),
	])
	const schoolOk = (e: any) => {
		const sch = relIds(e?.properties?.["학교"]).map(key), grd = relIds(e?.properties?.["학년"]).map(key)
		if (sch.length && !(schoolId && sch.includes(key(schoolId)))) return false
		if (grd.length && !(gradeId && grd.includes(key(gradeId)))) return false
		return true
	}
	const byId = new Map<string, any>()
	for (const e of [...own, ...cls, ...academy, ...[...school, ...grade].filter(schoolOk)]) if (alive(e)) byId.set(key(e.id), e)
	return Array.from(byId.values())
		.filter((e) => isParentPublicEvent(e))
		.map((e) => ({ id: String(e.id), ...(eventLine(e) ?? { day: "", line: "" }), sec: sectionOf(e) }))
		.filter((l) => l.line && inMonth(l.day, month))
		.sort((a, b) => a.day.localeCompare(b.day))
}

// 가정통신문 `일정`을 그 학생의 그 달 일정으로 다시 묶는다.
async function bundleEvents(batchId: string, studentId: string, month: string, classIds: string[]): Promise<Line[]> {
	const lines = await studentMonthEvents(studentId, month, classIds)
	await monthlyDeps.update(batchId, { [PROP_BATCH_EVENTS]: { relation: lines.slice(0, 100).map((l) => ({ id: l.id })) } })
	return lines
}

// ── 1) 클래스 [월 수강료 생성] ────────────────────────────────────────────────
const amountOf = (cls: any): number | null => {
	const p = cls?.properties?.["월간 수업 총량"]
	const n = p?.number ?? p?.formula?.number ?? p?.rollup?.number
	return typeof n === "number" ? n : null
}

export async function processMonthlyCreateClassItem(p: CreateClassPayload): Promise<void> {
	const deps = monthlyDeps
	const spec = CLASS_TUITION_GEN_STATUS_SPEC
	try {
		await deps.markRunning(p.classId, spec)
		const cls: any = await deps.getPage(p.classId)
		const amount = amountOf(cls)
		if (amount === null) return await deps.markError(p.classId, spec, "클래스 '월간 수업 총량'을 넣어 주세요(수강료 청구 기준).")
		const regs = (await deps.queryAllPages(DS_REGISTRATION, { property: "클래스", relation: { contains: p.classId } })).filter((r: any) => inMonthReg(r, p.month))
		console.log(`[monthly-create] class=${p.classId} ${p.month} 대상 등록 ${regs.length}`)
		if (!regs.length) return await deps.markError(p.classId, spec, `${monthLabel(p.month)}에 이 반을 다니는 학생이 없습니다.`)
		for (let i = 0; i < regs.length; i++) {
			const item: CreateRegPayload = { classId: p.classId, month: p.month, regId: String(regs[i].id), amount, ...(i === regs.length - 1 ? { last: true } : {}) }
			await deps.enqueue(TARGET_MONTHLY_CREATE_REG, item)
		}
	} catch (err) {
		await deps.markError(p.classId, spec, (err as Error).message).catch(() => {})
		throw err
	}
}

// 등록 1건: 가정통신문를 찾거나 만들고, 그 등록의 그 달 수강료가 없으면 만든다(있으면 가정통신문에 연결만). 다시 해도 같다.
export async function processMonthlyCreateRegItem(p: CreateRegPayload): Promise<void> {
	const deps = monthlyDeps
	try {
		const reg: any = await deps.getPage(p.regId)
		const studentId = relIds(reg?.properties?.["학생정보"])[0]
		const studentName = studentNameOf(reg)
		if (!studentId) {
			await appendError(p.classId, `${studentName || p.regId}: 등록에 학생이 연결되어 있지 않아 건너뜀`)
		} else {
			const batch = await findStudentBatch(studentId, p.month, { studentName })
			const range = monthRange(p.month)
			const existing = (await deps.queryAllPages(DS_TUITION, { property: "등록", relation: { contains: p.regId } }))
				.filter((t: any) => alive(t) && seoulDay(t?.properties?.["청구기간"]?.date?.start)?.slice(0, 7) === p.month)
			if (existing.length) {
				for (const t of existing) if (!relIds(t?.properties?.[PROP_TUITION_BATCH]).length) await deps.update(String(t.id), { [PROP_TUITION_BATCH]: { relation: [{ id: String(batch.id) }] } })
			} else {
				const rowId = await deps.tuitionConfigRow().catch(() => null)
				await deps.createPage(DS_TUITION, {
					"청구명": { title: [{ text: { content: tuitionTitle(p.month, studentName) } }] },
					"청구기간": { date: { start: range.start, end: range.end } },
					"등록": { relation: [{ id: p.regId }] },
					"실제 수업량": { number: p.amount },
					[PROP_TUITION_BATCH]: { relation: [{ id: String(batch.id) }] },
					...(rowId ? { "알림톡 설정": { relation: [{ id: rowId }] } } : {}),
					"일괄전송 선택": { checkbox: true },
				})
			}
			const classIds = (await studentRegsInMonth(studentId, p.month)).flatMap((r: any) => relIds(r?.properties?.["클래스"]))
			await bundleEvents(String(batch.id), studentId, p.month, classIds).catch((err) => console.warn("[monthly-create] 일정 묶기 건너뜀:", (err as Error).message))
		}
		if (p.last) await finishParent(p.classId, CLASS_TUITION_GEN_STATUS_SPEC)
	} catch (err) {
		// 반 상태는 마지막 학생에서 정한다. 여기서는 오류 문장만 남기고 큐가 다시 시도한다(다시 해도 이미 만든 것은 건너뜀).
		const message = `수강료 생성 실패(다시 누르면 빠진 학생만 만듭니다): ${(err as Error).message}`
		await appendError(p.classId, message)
		if (p.last) await deps.markError(p.classId, CLASS_TUITION_GEN_STATUS_SPEC, message).catch(() => {})
		throw err
	}
}

// ── 2) 보내기 ────────────────────────────────────────────────────────────────
type SendResult = "sent" | "skipped" | "empty"

async function senderId(): Promise<string | undefined> {
	return (await monthlyDeps.botUser().catch(() => null)) ?? undefined
}

// 수강료 안내 한 통(그 학생의 그 달 수강료 전부). 이미 보냈으면 skipped.
export async function sendTuitionNotice(batch: any): Promise<SendResult> {
	const deps = monthlyDeps
	if (batch?.properties?.[PROP_TUITION_SENT]?.date?.start) return "skipped"
	const month = String(seoulDay(batch?.properties?.[PROP_BATCH_PERIOD]?.date?.start) ?? "").slice(0, 7)
	if (!month) throw new MonthlyBlocked("가정통신문 '기간'이 비어 있습니다.")
	const range = monthRange(month)
	const tuitions = (await Promise.all((await deps.fullRelationIds(batch, PROP_BATCH_TUITION)).map((id: string) => deps.getPage(id)))).filter(alive)
	if (!tuitions.length) throw new MonthlyBlocked("이 가정통신문에 수강료가 없습니다. 클래스 [월 수강료 생성]을 먼저 누르세요.")
	const rows: { name: string; line: string; amount: number; regId: string }[] = []
	for (const t of tuitions) {
		const regId = relIds(t?.properties?.["등록"])[0] ?? ""
		const reg: any = regId ? await deps.getPage(regId).catch(() => null) : null
		const name = getRollupText(t, "클래스(수강료)").trim() || classNameOfReg(reg) || "수강료"
		const since = seoulDay(reg?.properties?.["등록일"]?.date?.start)
		const suffix = since && since > range.start && since <= range.end ? `(${since.slice(5, 7)}.${since.slice(8, 10)}~)` : ""
		const amount = Number(t?.properties?.["청구금액"]?.formula?.number ?? 0) || 0
		const shown = getFormulaText(t, "청구금액(표시)").trim() || won(amount)
		rows.push({ name, line: `• ${name}${suffix}: ${shown}`, amount, regId })
	}
	rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
	const first = tuitions[0]
	const regId = rows.find((r) => r.regId)?.regId ?? ""
	const studentName = getFormulaText(first, "학생정보").trim()
	const config = await deps.config("수강료 안내", { pfId: "", templateId: "", senderNumber: "" })
	// 다른 알림톡처럼 가정통신문 페이지의 (수강료안내) 수식 값을 먼저 쓰고, 없거나 비면 같은 규칙으로 계산한다.
	const f = (name: string, fallback: string) => getFormulaText(batch, name).trim() || fallback
	const variables = {
		"#{청구년월}": f("청구년월(수강료안내)", getFormulaText(first, "청구년월(보고서)").trim() || monthLabel(month)),
		"#{학생이름}": f("학생이름(수강료안내)", studentName),
		"#{청구기간}": f("청구기간(수강료안내)", `${yymmdd(range.start)}~${yymmdd(range.end)}`),
		"#{수강내역}": f("수강내역(수강료안내)", rows.map((r) => r.line).join("\n")),
		"#{청구금액}": f("청구금액(수강료안내)", won(rows.reduce((s, r) => s + r.amount, 0))),
		"#{안내멘트}": config.notice ?? "",
	}
	const sender = await senderId()
	const logAll = (status: "성공" | "실패", failReason?: string) => Promise.all(tuitions.map((t, i) => deps.log({
		registrationId: relIds(t?.properties?.["등록"])[0] ?? regId, senderUserId: sender, tuitionId: String(t.id),
		title: studentName || "수강료 안내", category: "수강료 안내", status, periodStart: range.start, periodEnd: range.end, ...(failReason ? { failReason } : {}),
	}).catch((err: unknown) => console.error("[monthly-tuition] 전송 로그 실패:", i, extractErrorMessage(err)))))
	const markTuitions = (status: "✅ 완료" | "⚠️ 오류", message: string | null) => Promise.all(tuitions.map((t) => deps.update(String(t.id), {
		"안내문 전송 상태": { select: { name: status } },
		"일괄전송 선택": { checkbox: false },
		[PROP_LAST_ERROR]: { rich_text: message ? [{ text: { content: message.slice(0, 1900) } }] : [] },
	}).catch(() => {})))
	try {
		await deps.send("수강료 안내", regId, getRollupText(first, "학부모 연락처"), variables)
	} catch (err) {
		const reason = extractErrorMessage(err)
		if (err instanceof LessonConfigError || /연락처 오류/.test(reason)) throw new MonthlyBlocked(reason)
		await logAll("실패", reason)
		await markTuitions("⚠️ 오류", reason)
		throw new MonthlySendFailed(reason)
	}
	await logAll("성공")
	await markTuitions("✅ 완료", null)
	// 이미 보냈으므로 여기서 실패해도 다시 보내지 않는다(큐 재시도 금지).
	await deps.update(String(batch.id), { [PROP_TUITION_SENT]: { date: { start: deps.today() } } }).catch((err: unknown) => console.error("[monthly] 보낸 일시 쓰기 실패:", batch.id, extractErrorMessage(err)))
	return "sent"
}

// 월간 일정 안내의 전달사항: 가정통신문 메모 → 클래스 안내 메모(반 일괄은 누른 반, 한 명 버튼은 그 달 다니는 반 중
// 메모가 있는 첫 반, 반 이름순) → "없음". 50자까지(수업 안내와 같은 규칙).
async function scheduleNote(batch: any, regs: any[], classId?: string): Promise<string> {
	const own = textOf(batch?.properties?.[PROP_BATCH_NOTE]?.rich_text).trim()
	if (own) return noteText(own)
	const ids = classId ? [classId] : Array.from(new Set(regs.slice().sort((a, b) => (classNameOfReg(a) < classNameOfReg(b) ? -1 : 1)).flatMap((r: any) => relIds(r?.properties?.["클래스"]))))
	for (const id of ids) {
		const cls: any = await monthlyDeps.getPage(id).catch(() => null)
		const memo = textOf(cls?.properties?.[PROP_CLASS_NOTE]?.rich_text).trim()
		if (memo) return noteText(memo)
	}
	return noteText("")
}

// 월간 일정 안내 한 통. 이미 보냈으면 skipped, 그 달 일정이 없으면 empty(보내지 않음).
// classId = 반 일괄로 보낼 때 누른 반(전달사항의 클래스 안내 메모를 그 반에서 읽는다).
export async function sendScheduleNotice(batch: any, classId?: string): Promise<SendResult> {
	const deps = monthlyDeps
	if (batch?.properties?.[PROP_SCHEDULE_SENT]?.date?.start) return "skipped"
	const month = String(seoulDay(batch?.properties?.[PROP_BATCH_PERIOD]?.date?.start) ?? "").slice(0, 7)
	if (!month) throw new MonthlyBlocked("가정통신문 '기간'이 비어 있습니다.")
	const studentId = relIds(batch?.properties?.[PROP_BATCH_STUDENT])[0]
	if (!studentId) throw new MonthlyBlocked("가정통신문에 '학생'이 연결되어 있지 않습니다.")
	const regs = await studentRegsInMonth(studentId, month)
	if (!regs.length) throw new MonthlyBlocked(`${monthLabel(month)}에 다니는 등록이 없습니다.`)
	const lines = await bundleEvents(String(batch.id), studentId, month, regs.flatMap((r: any) => relIds(r?.properties?.["클래스"])))
	if (!lines.length) return "empty"
	const regId = String(regs[0].id)
	const studentName = studentNameOf(regs[0])
	const classNames = Array.from(new Set(regs.map(classNameOfReg).filter(Boolean)))
	const REPORT_PATH = Deno.env.get("REPORT_PATH") ?? "/project1/student_report.html"
	const variables = {
		"#{학생이름}": studentName,
		"#{클래스}": classNames.join(" · "),
		"#{안내월}": monthLabel(month),
		"#{휴원일정}": sectionText(lines, "휴원"),
		"#{학원일정}": sectionText(lines, "학원"),
		"#{학사일정}": sectionText(lines, "학교"),
		"#{전달사항}": await scheduleNote(batch, regs, classId),
		"#{페이지ID}": `${REPORT_PATH}?token=${await deps.token(regId)}`,
	}
	const sender = await senderId()
	try {
		await deps.send("월간 일정 안내", regId, "", variables)
	} catch (err) {
		const reason = extractErrorMessage(err)
		if (err instanceof LessonConfigError || /연락처 오류/.test(reason)) throw new MonthlyBlocked(reason)
		await deps.log({ registrationId: regId, senderUserId: sender, title: studentName || "월간 일정 안내", category: "월간 일정 안내", status: "실패", failReason: reason }).catch(() => {})
		throw new MonthlySendFailed(reason)
	}
	await deps.log({ registrationId: regId, senderUserId: sender, title: studentName || "월간 일정 안내", category: "월간 일정 안내", status: "성공" }).catch((err: unknown) => console.error("[monthly-schedule] 전송 로그 실패:", extractErrorMessage(err)))
	// 이미 보냈으므로 여기서 실패해도 다시 보내지 않는다(큐 재시도 금지).
	await deps.update(String(batch.id), { [PROP_SCHEDULE_SENT]: { date: { start: deps.today() } } }).catch((err: unknown) => console.error("[monthly] 보낸 일시 쓰기 실패:", batch.id, extractErrorMessage(err)))
	return "sent"
}

const sendOf = (kind: NoticeKind) => (kind === "tuition" ? (b: any, _classId?: string) => sendTuitionNotice(b) : sendScheduleNotice)
const sentProp = (kind: NoticeKind) => (kind === "tuition" ? PROP_TUITION_SENT : PROP_SCHEDULE_SENT)
const kindLabel = (kind: NoticeKind) => (kind === "tuition" ? "수강료 안내" : "월간 일정 안내")
export const classSpecOf = (kind: NoticeKind) => (kind === "tuition" ? CLASS_TUITION_NOTICE_STATUS_SPEC : SCHEDULE_NOTICE_STATUS_SPEC)

// 가정통신문 [수강료 안내]·[월간 일정 안내] — 그 학생 한 명.
export async function processMonthlySendBatchItem(p: SendBatchPayload): Promise<void> {
	const deps = monthlyDeps
	const spec = MONTHLY_STATUS_SPEC
	try {
		await deps.markRunning(p.batchId, spec)
		const batch: any = await deps.getPage(p.batchId)
		const r = await sendOf(p.kind)(batch)
		if (r === "skipped") return await deps.markError(p.batchId, spec, `이미 ${kindLabel(p.kind)}를 보냈습니다. 다시 보내려면 '${sentProp(p.kind)}'을 비우고 누르세요.`)
		if (r === "empty") return await deps.markError(p.batchId, spec, "이 달 이 학생의 학부모 공개 일정이 없어 보내지 않았습니다.")
		await deps.markDone(p.batchId, spec)
	} catch (err) {
		await deps.markError(p.batchId, spec, (err as Error).message).catch(() => {})
		if (err instanceof MonthlyBlocked || err instanceof MonthlySendFailed) return
		throw err
	}
}

// 클래스 [수강료 안내 일괄]·[월간 일정 안내] — 그 반에 그 달 다니는 학생마다 1건.
export async function processMonthlySendClassItem(p: SendClassPayload): Promise<void> {
	const deps = monthlyDeps
	const spec = classSpecOf(p.kind)
	try {
		await deps.markRunning(p.classId, spec)
		const regs = (await deps.queryAllPages(DS_REGISTRATION, { property: "클래스", relation: { contains: p.classId } })).filter((r: any) => inMonthReg(r, p.month))
		const seen = new Set<string>(), items: SendStudentPayload[] = []
		for (const r of regs) {
			const sid = relIds(r?.properties?.["학생정보"])[0]
			if (!sid || seen.has(key(sid))) continue
			seen.add(key(sid))
			items.push({ kind: p.kind, classId: p.classId, month: p.month, studentId: sid, studentName: studentNameOf(r) })
		}
		console.log(`[monthly-send] class=${p.classId} ${p.kind} ${p.month} 학생 ${items.length}`)
		if (!items.length) return await deps.markError(p.classId, spec, `${monthLabel(p.month)}에 이 반을 다니는 학생이 없습니다.`)
		for (let i = 0; i < items.length; i++) await deps.enqueue(TARGET_MONTHLY_SEND_STUDENT, { ...items[i], ...(i === items.length - 1 ? { last: true } : {}) })
	} catch (err) {
		await deps.markError(p.classId, spec, (err as Error).message).catch(() => {})
		throw err
	}
}

// 반 일괄의 학생 1건. 이미 보냈거나 일정이 없으면 조용히 건너뛰고, 막히거나 실패하면 클래스 '마지막 오류'에 한 줄 남긴다.
export async function processMonthlySendStudentItem(p: SendStudentPayload): Promise<void> {
	const deps = monthlyDeps
	const spec = classSpecOf(p.kind)
	try {
		const batch = await findStudentBatch(p.studentId, p.month, p.kind === "schedule" ? { studentName: p.studentName } : null)
		if (!batch) await appendError(p.classId, `${p.studentName}: ${monthLabel(p.month)} 가정통신문이 없습니다(클래스 [월 수강료 생성]을 먼저).`)
		else {
			try {
				await sendOf(p.kind)(batch, p.classId)
			} catch (err) {
				if (!(err instanceof MonthlyBlocked || err instanceof MonthlySendFailed)) throw err
				await appendError(p.classId, `${p.studentName}: ${(err as Error).message}`)
			}
		}
		if (p.last) await finishParent(p.classId, spec)
	} catch (err) {
		await appendError(p.classId, `${p.studentName}: ${(err as Error).message}`)
		if (p.last) await deps.markError(p.classId, spec, (err as Error).message).catch(() => {})
		throw err
	}
}

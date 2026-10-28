// _shared/monthlyNotice.ts
//
// (v2.8.0) 클래스 [월 수강료 생성](send-monthly-notice/create → 큐). 보고서 생성과 같은 모양이다.
//   클래스 `수강료 기간`의 달(비면 누른 날의 다음 달, 서울)의 반 수강료 발송함(구분 "수강료", 반 × 달)을 찾거나 만들어 클래스
//   `수강료 생성 대상`에 잇고, 그 반을 다니는 등록마다 그 달 수강료가 없으면 만들어 발송함에 연결한다. 같은 학생의 그 달 다른 반
//   수강료와 `같은 달 수강료`로 서로 잇는다. 보내기는 수강료 DB 큐(_shared/noticeQueue.ts)가 같은 달 수강료를 한 통으로 보낸다.
// (10/28) 가정통신문(월간 일정 안내)도 같은 모양이다: 클래스 [가정통신문 생성](send-monthly-notice/create-letter) → 클래스 `안내 기간`의
//   달의 반 가정통신문 발송함(구분 "가정통신문") → 등록마다 가정통신문 한 장 → 같은 학생의 그 달 다른 반 가정통신문과 `같은 달 가정통신문`.
//   학생·반에 연결된 일정은 Notion 수식이 모으고, 연결 안 된 일정(학원 전체, 학생의 학교·학년)은 서버가 `학원 일정`에 넣는다
//   (만들 때 한 번, 보내기 직전에 다시). 보내기는 수강료와 같은 큐(_shared/noticeQueue.ts, kind "letter")다.
import { getScheduleConfig } from "./adminShared.ts"
import { getFormulaText, getRollupText, syncStudentReport } from "./alimtalkShared.ts"
import { anyTitleText, createPage, fetchWithRetry, fullRelationIds, getPage, notionHeaders, queryAllPages, relIds, updatePageProperties } from "./notionClient.ts"
import { DS_REGISTRATION, DS_SCHEDULE_EVENT, DS_TUITION, NOTION_API, PROP_LAST_ERROR } from "./constants.ts"
import { enqueueSync } from "./syncQueue.ts"
import { markDone, markError, markRunning, type StatusSpec } from "./statusTracking.ts"
import { isParentPublicEvent } from "./scheduleVisibility.ts"
import { inPeriodRegistration, resolveBatchDataSourceId, seoulDay, studentNameOf } from "./classReportPlan.ts"
import { eventLine, inMonth, isAcademyWide, monthFilter, monthLabel, nextMonthKey, type Section, sectionOf, sectionText } from "./scheduleNotice.ts"
import { noteText } from "./lessonNotice.ts"

export const KIND_MONTHLY = "가정통신문"
// (10/28) 수강료 생성은 보고서처럼 반 발송함(구분 "수강료", 반 × 달)을 만든다.
export const KIND_TUITION = "수강료"
// 클래스 [월 수강료 생성]
export const CLASS_TUITION_GEN_STATUS_SPEC: StatusSpec = { statusProp: "수강료 생성 상태", errorProp: PROP_LAST_ERROR, startedAtProp: "수강료 생성 처리 시작 시각" }
export const TARGET_MONTHLY_CREATE_CLASS = "monthly-create-class"
export const TARGET_MONTHLY_CREATE_REG = "monthly-create-reg"
// 클래스 [가정통신문 생성]
export const CLASS_LETTER_GEN_STATUS_SPEC: StatusSpec = { statusProp: "가정통신문 생성 상태", errorProp: PROP_LAST_ERROR, startedAtProp: "가정통신문 생성 처리 시작 시각" }
export const TARGET_LETTER_CREATE_CLASS = "letter-create-class"
export const TARGET_LETTER_CREATE_REG = "letter-create-reg"

// 알림톡 발송함(학원) DB: 반 × 달 × 구분
const PROP_MAILBOX_TITLE = "이름"
const PROP_MAILBOX_KIND = "구분"
const PROP_MAILBOX_PERIOD = "기간"
const PROP_MAILBOX_CLASS = "클래스"
// 수강료(학원) DB
const PROP_TUITION_MAILBOX = "알림톡 발송함"
// 클래스(학원) DB: 가정통신문의 달(1일~말일). 비면 누른 날의 다음 달.
export const PROP_CLASS_NOTICE_PERIOD = "안내 기간"
// 클래스(학원) DB: 수강료의 달(1일~말일, 보고서 기간과 같은 방식). 비면 누른 날의 다음 달.
export const PROP_CLASS_TUITION_PERIOD = "수강료 기간"
// 클래스(학원) DB: [월 수강료 생성]이 만든(또는 찾은) 이 반의 수강료 발송함(보고서 생성 대상과 같은 방식).
const PROP_CLASS_TUITION_MAILBOX = "수강료 생성 대상"
// 수강료(학원) DB: 같은 학생의 같은 달 다른 반 수강료(한쪽 자기 관계, 서로 모두 잇는다).
const PROP_TUITION_SIBLINGS = "같은 달 수강료"
// 클래스(학원) DB: [가정통신문 생성]이 만든(또는 찾은) 이 반의 가정통신문 발송함. 월간 일정 안내 전달사항(반 학생 모두).
const PROP_CLASS_LETTER_MAILBOX = "가정통신문 생성 대상"
const PROP_CLASS_NOTE = "안내 메모"
// 알림톡 발송함(학원) DB: 이 발송함의 가정통신문(가정통신문 DB '알림톡 발송함'의 짝). 가정통신문 DB id를 여기서 찾는다.
const PROP_MAILBOX_LETTERS = "가정통신문"
// 가정통신문(학원) DB: 등록 × 달 한 장
const PROP_LETTER_TITLE = "이름"
const PROP_LETTER_PERIOD = "기간"
const PROP_LETTER_REG = "등록"
const PROP_LETTER_MAILBOX = "알림톡 발송함"
export const PROP_LETTER_SIBLINGS = "같은 달 가정통신문"
const PROP_LETTER_EVENTS = "학원 일정"
const PROP_LETTER_NOTE = "가정통신문 메모"

export type CreateClassPayload = { classId: string; month: string }
export type CreateRegPayload = { classId: string; month: string; regId: string; amount: number | null; mailboxId?: string; last?: boolean }
type Line = { id: string; day: string; line: string; sec: Section }

const textOf = (arr: any): string => (Array.isArray(arr) ? arr.map((t: any) => t?.plain_text ?? t?.text?.content ?? "").join("") : "")
const key = (id: string) => String(id ?? "").replace(/-/g, "").toLowerCase()
const alive = (p: any) => !!p && !p.in_trash && !p.archived

// 클래스 버튼의 대상 달: 클래스 '안내 기간'의 시작일이 있는 달, 비면 누른 날의 다음 달(서울).
// 시작과 끝이 다른 달이면 고칠 곳을 문장으로 알린다(보고서 기간과 같은 방식).
export function monthFromClass(cls: any, now = new Date(), prop = PROP_CLASS_NOTICE_PERIOD): string {
	const d = cls?.properties?.[prop]?.date
	const start = seoulDay(d?.start)
	if (!start) return nextMonthKey(now)
	const end = seoulDay(d?.end)
	if (end && end.slice(0, 7) !== start.slice(0, 7)) throw new Error(`클래스 '${prop}'은 한 달 안(1일~말일)으로 넣어 주세요. 비우면 다음 달입니다.`)
	return start.slice(0, 7)
}
// 클래스 [월 수강료 생성]의 달: 클래스 '수강료 기간'(비면 다음 달).
export const tuitionMonthFromClass = (cls: any, now = new Date()) => monthFromClass(cls, now, PROP_CLASS_TUITION_PERIOD)
// 클래스 [가정통신문 생성]의 달: 클래스 '안내 기간'(비면 다음 달).
export const letterMonthFromClass = (cls: any, now = new Date()) => monthFromClass(cls, now, PROP_CLASS_NOTICE_PERIOD)

// "2026-12" → { start: "2026-12-01", end: "2026-12-31" }
export function monthRange(month: string): { start: string; end: string } {
	const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7))
	const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
	return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, "0")}` }
}
// 수강료·가정통신문 이름: "26.12 김하윤 (중1) 수학반 수강료"(등록 이름, Notion 이름 자동화와 같다. 등록 이름이 비면 학생 이름)
const yymm = (month: string) => `${month.slice(2, 4)}.${month.slice(5, 7)}`
export const tuitionTitle = (month: string, regName: string) => `${yymm(month)} ${regName} 수강료`
export const letterTitle = (month: string, regName: string) => `${yymm(month)} ${regName} 가정통신문`
const regNameOf = (reg: any) => anyTitleText(reg).trim() || studentNameOf(reg)

// 테스트에서 Notion·발송을 바꿔 끼울 수 있게 한다.
export const monthlyDeps = {
	getPage,
	createPage,
	queryAllPages,
	update: updatePageProperties,
	fullRelationIds,
	enqueue: enqueueSync,
	batchDataSourceId: resolveBatchDataSourceId,
	letterDataSourceId: () => resolveLetterDataSourceId(),
	token: async (regId: string) => (await syncStudentReport(regId)).access_token,
	tuitionConfigRow: async () => (await getScheduleConfig("수강료 안내"))?.rowId ?? null,
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

// 가정통신문(학원) DB 데이터소스 id. 전용 Secret 없이 발송함 DB '가정통신문' 관계가 가리키는 곳을 읽는다.
let letterDsCache: string | null = null
export async function resolveLetterDataSourceId(): Promise<string> {
	if (letterDsCache) return letterDsCache
	const res = await fetchWithRetry(`${NOTION_API}/data_sources/${await resolveBatchDataSourceId()}`, { headers: notionHeaders() })
	if (!res.ok) throw new Error(`알림톡 발송함 DB 정보 읽기 실패: ${res.status} ${await res.text()}`)
	const id = (await res.json())?.properties?.[PROP_MAILBOX_LETTERS]?.relation?.data_source_id
	if (!id) throw new Error(`알림톡 발송함 DB에 '${PROP_MAILBOX_LETTERS}' 관계(가정통신문 DB)가 없습니다.`)
	letterDsCache = String(id)
	return letterDsCache
}

const samePeriod = (page: any, prop: string, range: { start: string }) => alive(page) && seoulDay(page?.properties?.[prop]?.date?.start) === range.start

// 그 반의 그 달 발송함(구분 kind)을 찾고, create면 없을 때 만든다.
export async function findClassMailbox(classId: string, month: string, create: { className: string } | null, kind = KIND_MONTHLY): Promise<any | null> {
	const deps = monthlyDeps
	const ds = await deps.batchDataSourceId()
	const range = monthRange(month)
	const found = await deps.queryAllPages(ds, {
		and: [
			{ property: PROP_MAILBOX_CLASS, relation: { contains: classId } },
			{ property: PROP_MAILBOX_KIND, select: { equals: kind } },
		],
	})
	const same = found.find((b: any) => samePeriod(b, PROP_MAILBOX_PERIOD, range))
	if (same || !create) return same ?? null
	return await deps.createPage(ds, {
		[PROP_MAILBOX_TITLE]: { title: [{ text: { content: `${month.slice(2, 4)}.${month.slice(5, 7)} ${create.className} ${kind}` } }] },
		[PROP_MAILBOX_KIND]: { select: { name: kind } },
		[PROP_MAILBOX_PERIOD]: { date: { start: range.start, end: range.end } },
		[PROP_MAILBOX_CLASS]: { relation: [{ id: classId }] },
	})
}

// 그 달에 다니는 그 학생의 등록들.
export async function studentRegsInMonth(studentId: string, month: string): Promise<any[]> {
	return (await monthlyDeps.queryAllPages(DS_REGISTRATION, { property: "학생정보", relation: { contains: studentId } })).filter((r: any) => inMonthReg(r, month))
}

const classNameOfReg = (reg: any) => getRollupText(reg, "클래스명(등록)").trim()

// 두 반 이상 다니는 학생에게 일부 반에만 걸린 일정은 날짜 뒤에 그 반 이름을 붙인다("11/14(토) 중1 B 보충 수업").
// 다니는 반 모두에 걸린 일정·학생 개인·학원 전체·학교 일정과 한 반만 다니는 학생은 그대로.
export function withClassPrefix(line: string, event: any, classNameById: Map<string, string>): string {
	if (classNameById.size < 2) return line
	const names = relIds(event?.properties?.["클래스"]).map((id) => classNameById.get(key(id))).filter((n): n is string => !!n)
	const unique = Array.from(new Set(names)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
	if (!unique.length || unique.length >= new Set(classNameById.values()).size) return line
	// 일정 이름에 반 이름이 이미 있으면 붙이지 않는다("영어반 영어반 보충 수업" 방지).
	if (unique.every((n) => line.includes(n))) return line
	return line.replace(/^(\S+) /, `$1 ${unique.join(" · ")} `)
}

const eventQuery = (month: string) => (link: { prop: string; id: string } | null) =>
	monthlyDeps.queryAllPages(DS_SCHEDULE_EVENT, { and: [...(link ? [{ property: link.prop, relation: { contains: link.id } }] : []), ...monthFilter(month)] })
const showable = (e: any, month: string) => alive(e) && isParentPublicEvent(e) && inMonth(eventLine(e)?.day ?? null, month)

// 학생·반에 연결되지 않은 그 달 학부모 공개 일정: 학원 전체 + 학교·학년(일정의 학교·학년이 비었거나 학생 것과 같을 때).
// 가정통신문 '학원 일정'에 서버가 넣는 일정이다(학생·반 일정은 Notion 수식이 모은다).
export async function unlinkedMonthEvents(studentId: string, month: string): Promise<any[]> {
	const st: any = await monthlyDeps.getPage(studentId).catch(() => null)
	const schoolId = relIds(st?.properties?.["학교"])[0]
	const gradeId = relIds(st?.properties?.["학년"])[0]
	const q = eventQuery(month)
	const [academy, school, grade] = await Promise.all([
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
	for (const e of [...academy, ...[...school, ...grade].filter(schoolOk)]) if (showable(e, month)) byId.set(key(e.id), e)
	return Array.from(byId.values())
}

// 그 학생의 그 달 학부모 공개 일정(리포트와 같은 규칙): 학생 개인 + 다니는 반 전부 + 연결 안 된 일정(위). 같은 일정은 한 번만,
// 날짜순. regs = 그 달 다니는 그 학생의 등록들. unlinked를 주면 다시 읽지 않는다.
export async function studentMonthEvents(studentId: string, month: string, regs: any[], unlinked?: any[]): Promise<Line[]> {
	const classNameById = new Map<string, string>()
	for (const r of regs) for (const id of relIds(r?.properties?.["클래스"])) classNameById.set(key(id), classNameOfReg(r) || "반")
	const classIds = Array.from(new Set(regs.flatMap((r: any) => relIds(r?.properties?.["클래스"]))))
	const q = eventQuery(month)
	const [own, cls, rest] = await Promise.all([
		q({ prop: "학생", id: studentId }),
		Promise.all(classIds.map((id) => q({ prop: "클래스", id }))).then((l) => l.flat()),
		unlinked ? Promise.resolve(unlinked) : unlinkedMonthEvents(studentId, month),
	])
	const byId = new Map<string, any>()
	for (const e of [...own, ...cls, ...rest]) if (showable(e, month)) byId.set(key(e.id), e)
	return Array.from(byId.values())
		.map((e) => {
			const base = eventLine(e) ?? { day: "", line: "" }
			return { id: String(e.id), day: base.day, line: base.line ? withClassPrefix(base.line, e, classNameById) : "", sec: sectionOf(e) }
		})
		.filter((l) => l.line)
		.sort((a, b) => a.day.localeCompare(b.day))
}

// 그 등록의 그 달(청구기간 시작이 그 달) 수강료.
async function monthTuitionsOfReg(regId: string, month: string): Promise<any[]> {
	return (await monthlyDeps.queryAllPages(DS_TUITION, { property: "등록", relation: { contains: regId } }))
		.filter((t: any) => alive(t) && seoulDay(t?.properties?.["청구기간"]?.date?.start)?.slice(0, 7) === month)
}

// 같은 학생의 그 달 수강료·가정통신문(듣는 반마다 한 장)을 서로 잇는다(prop = '같은 달 수강료'·'같은 달 가정통신문').
// 각 장에는 자기를 뺀 나머지 전부가 들어간다. 방금 만든 장은 조회에 늦게 잡힐 수 있어 mine으로 직접 넣는다. 이미 같으면 쓰지 않는다.
async function linkSiblings(prop: string, ofReg: (regId: string, month: string) => Promise<any[]>, studentId: string, month: string, regId: string, mine: any[]): Promise<void> {
	const deps = monthlyDeps
	const others = (await studentRegsInMonth(studentId, month)).filter((r: any) => key(r.id) !== key(regId))
	const group = new Map<string, any>()
	for (const t of mine) if (t?.id) group.set(key(t.id), t)
	for (const r of others) for (const t of await ofReg(String(r.id), month)) group.set(key(t.id), t)
	if (group.size < 2) return
	for (const [k, t] of group) {
		const want = Array.from(group.keys()).filter((x) => x !== k).sort()
		const have = relIds(t?.properties?.[prop]).map(key).sort()
		if (want.join(",") === have.join(",")) continue
		await deps.update(String(t.id), { [prop]: { relation: Array.from(group.values()).filter((x) => key(x.id) !== k).map((x) => ({ id: String(x.id) })) } })
	}
}
export const linkSiblingTuitions = (studentId: string, month: string, regId: string, mine: any[]) => linkSiblings(PROP_TUITION_SIBLINGS, monthTuitionsOfReg, studentId, month, regId, mine)

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
		const mailbox = await findClassMailbox(p.classId, p.month, { className: anyTitleText(cls).trim() || "클래스" }, KIND_TUITION)
		const mailboxId = String(mailbox.id)
		// 보고서 생성 대상처럼 클래스에서 이 달 수강료 발송함을 바로 열 수 있게 잇는다(칸이 없는 운영은 건너뜀).
		if (!relIds(cls?.properties?.[PROP_CLASS_TUITION_MAILBOX]).some((id: string) => key(id) === key(mailboxId))) {
			await deps.update(p.classId, { [PROP_CLASS_TUITION_MAILBOX]: { relation: [{ id: mailboxId }] } }).catch((err: unknown) => console.warn("[monthly-create] 수강료 생성 대상 연결 건너뜀:", (err as Error).message))
		}
		for (let i = 0; i < regs.length; i++) {
			const item: CreateRegPayload = { classId: p.classId, month: p.month, regId: String(regs[i].id), amount, mailboxId, ...(i === regs.length - 1 ? { last: true } : {}) }
			await deps.enqueue(TARGET_MONTHLY_CREATE_REG, item)
		}
	} catch (err) {
		await deps.markError(p.classId, spec, (err as Error).message).catch(() => {})
		throw err
	}
}

// 등록 1건: 그 등록의 그 달 수강료가 없으면 만들어 반 수강료 발송함에 잇는다(있으면 빈 발송함만 연결). 다시 해도 같다.
// 그 뒤 같은 학생의 그 달 다른 반 수강료와 '같은 달 수강료'로 서로 잇는다(두 반·세 반 학생의 합산 안내용).
// 수강료의 '일괄전송 선택'은 켜지 않는다(보내기는 학생 단위로 따로 만든다).
export async function processMonthlyCreateRegItem(p: CreateRegPayload): Promise<void> {
	const deps = monthlyDeps
	try {
		const reg: any = await deps.getPage(p.regId)
		const studentId = relIds(reg?.properties?.["학생정보"])[0]
		const studentName = studentNameOf(reg)
		if (!studentId) {
			await appendError(p.classId, `${studentName || p.regId}: 등록에 학생이 연결되어 있지 않아 건너뜀`)
		} else {
			const range = monthRange(p.month)
			const existing = (await monthTuitionsOfReg(p.regId, p.month))
			let mine: any[] = existing
			if (existing.length) {
				for (const t of existing) {
					if (p.mailboxId && !relIds(t?.properties?.[PROP_TUITION_MAILBOX]).length) await deps.update(String(t.id), { [PROP_TUITION_MAILBOX]: { relation: [{ id: p.mailboxId }] } })
				}
			} else {
				const rowId = await deps.tuitionConfigRow().catch(() => null)
				const created = await deps.createPage(DS_TUITION, {
					"청구명": { title: [{ text: { content: tuitionTitle(p.month, regNameOf(reg)) } }] },
					"청구기간": { date: { start: range.start, end: range.end } },
					"등록": { relation: [{ id: p.regId }] },
					"실제 수업량": { number: p.amount },
					...(p.mailboxId ? { [PROP_TUITION_MAILBOX]: { relation: [{ id: p.mailboxId }] } } : {}),
					...(rowId ? { "알림톡 설정": { relation: [{ id: rowId }] } } : {}),
					"일괄전송 선택": { checkbox: false },
				})
				mine = [created]
			}
			await linkSiblingTuitions(studentId, p.month, p.regId, mine)
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

// ── 2) 클래스 [가정통신문 생성] ─────────────────────────────────────────────────
// 수강료와 같은 모양: 반 가정통신문 발송함을 찾거나 만들어 클래스 '가정통신문 생성 대상'에 잇고, 그 달 다니는 등록마다 큐.
export async function processLetterCreateClassItem(p: CreateClassPayload): Promise<void> {
	const deps = monthlyDeps
	const spec = CLASS_LETTER_GEN_STATUS_SPEC
	try {
		await deps.markRunning(p.classId, spec)
		const cls: any = await deps.getPage(p.classId)
		const regs = (await deps.queryAllPages(DS_REGISTRATION, { property: "클래스", relation: { contains: p.classId } })).filter((r: any) => inMonthReg(r, p.month))
		console.log(`[letter-create] class=${p.classId} ${p.month} 대상 등록 ${regs.length}`)
		if (!regs.length) return await deps.markError(p.classId, spec, `${monthLabel(p.month)}에 이 반을 다니는 학생이 없습니다.`)
		const mailbox = await findClassMailbox(p.classId, p.month, { className: anyTitleText(cls).trim() || "클래스" }, KIND_MONTHLY)
		const mailboxId = String(mailbox.id)
		if (!relIds(cls?.properties?.[PROP_CLASS_LETTER_MAILBOX]).some((id: string) => key(id) === key(mailboxId))) {
			await deps.update(p.classId, { [PROP_CLASS_LETTER_MAILBOX]: { relation: [{ id: mailboxId }] } }).catch((err: unknown) => console.warn("[letter-create] 가정통신문 생성 대상 연결 건너뜀:", (err as Error).message))
		}
		for (let i = 0; i < regs.length; i++) {
			const item: CreateRegPayload = { classId: p.classId, month: p.month, regId: String(regs[i].id), amount: null, mailboxId, ...(i === regs.length - 1 ? { last: true } : {}) }
			await deps.enqueue(TARGET_LETTER_CREATE_REG, item)
		}
	} catch (err) {
		await deps.markError(p.classId, spec, (err as Error).message).catch(() => {})
		throw err
	}
}

// 그 등록의 그 달(기간 시작이 그 달) 가정통신문.
async function monthLettersOfReg(regId: string, month: string): Promise<any[]> {
	const ds = await monthlyDeps.letterDataSourceId()
	return (await monthlyDeps.queryAllPages(ds, { property: PROP_LETTER_REG, relation: { contains: regId } }))
		.filter((t: any) => alive(t) && seoulDay(t?.properties?.[PROP_LETTER_PERIOD]?.date?.start)?.slice(0, 7) === month)
}

// 가정통신문 '학원 일정'을 연결 안 된 그 달 일정으로 맞춘다(같으면 쓰지 않음). 넣은 일정을 돌려준다. events를 주면 다시 읽지 않는다.
async function bundleUnlinked(letter: any, studentId: string, month: string, given?: any[]): Promise<any[]> {
	const events = given ?? await unlinkedMonthEvents(studentId, month)
	const want = events.map((e: any) => key(e.id)).sort()
	const have = relIds(letter?.properties?.[PROP_LETTER_EVENTS]).map(key).sort()
	if (want.join(",") !== have.join(",")) {
		await monthlyDeps.update(String(letter.id), { [PROP_LETTER_EVENTS]: { relation: events.slice(0, 100).map((e: any) => ({ id: String(e.id) })) } })
	}
	return events
}

// 등록 1건: 그 등록의 그 달 가정통신문이 없으면 만들어 반 발송함에 잇고(있으면 빈 발송함만 연결), 같은 학생의 그 달 다른 반
// 가정통신문과 '같은 달 가정통신문'으로 서로 잇고, '학원 일정'을 넣는다. 다시 해도 같다.
export async function processLetterCreateRegItem(p: CreateRegPayload): Promise<void> {
	const deps = monthlyDeps
	try {
		const reg: any = await deps.getPage(p.regId)
		const studentId = relIds(reg?.properties?.["학생정보"])[0]
		if (!studentId) {
			await appendError(p.classId, `${studentNameOf(reg) || p.regId}: 등록에 학생이 연결되어 있지 않아 건너뜀`)
		} else {
			const range = monthRange(p.month)
			let mine = await monthLettersOfReg(p.regId, p.month)
			if (mine.length) {
				for (const t of mine) {
					if (p.mailboxId && !relIds(t?.properties?.[PROP_LETTER_MAILBOX]).length) await deps.update(String(t.id), { [PROP_LETTER_MAILBOX]: { relation: [{ id: p.mailboxId }] } })
				}
			} else {
				mine = [await deps.createPage(await deps.letterDataSourceId(), {
					[PROP_LETTER_TITLE]: { title: [{ text: { content: letterTitle(p.month, regNameOf(reg)) } }] },
					[PROP_LETTER_PERIOD]: { date: { start: range.start, end: range.end } },
					[PROP_LETTER_REG]: { relation: [{ id: p.regId }] },
					...(p.mailboxId ? { [PROP_LETTER_MAILBOX]: { relation: [{ id: p.mailboxId }] } } : {}),
				})]
			}
			await linkSiblings(PROP_LETTER_SIBLINGS, monthLettersOfReg, studentId, p.month, p.regId, mine)
			for (const t of mine) await bundleUnlinked(t, studentId, p.month)
		}
		if (p.last) await finishParent(p.classId, CLASS_LETTER_GEN_STATUS_SPEC)
	} catch (err) {
		const message = `가정통신문 생성 실패(다시 누르면 빠진 학생만 만듭니다): ${(err as Error).message}`
		await appendError(p.classId, message)
		if (p.last) await deps.markError(p.classId, CLASS_LETTER_GEN_STATUS_SPEC, message).catch(() => {})
		throw err
	}
}

// ── 3) 가정통신문 보내기(noticeQueue kind "letter"가 부른다) ──────────────────────────
// 보내기 전에 막힌 경우(일정 0건 등). 다시 해도 같으므로 큐 재시도 없이 ⚠️.
export class LetterBlocked extends Error {}

// 같은 학생의 그 달 반 이름(이름순, 같은 이름은 한 번). #{클래스}에 쓴다.
const classNamesOf = (regs: any[]) => Array.from(new Set(regs.map(classNameOfReg).filter(Boolean))).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

// 전달사항: 가정통신문 메모 → 다니는 반의 클래스 '안내 메모'(반 이름순 첫 번째) → 없음.
async function letterNote(letter: any, regs: any[]): Promise<string> {
	const own = textOf(letter?.properties?.[PROP_LETTER_NOTE]?.rich_text).trim()
	if (own) return noteText(own)
	const ids = Array.from(new Set(regs.slice().sort((a, b) => (classNameOfReg(a) < classNameOfReg(b) ? -1 : 1)).flatMap((r: any) => relIds(r?.properties?.["클래스"]))))
	for (const id of ids) {
		const cls: any = await monthlyDeps.getPage(id).catch(() => null)
		const memo = textOf(cls?.properties?.[PROP_CLASS_NOTE]?.rich_text).trim()
		if (memo) return noteText(memo)
	}
	return noteText("")
}

// 월간 일정 안내 한 통의 변수. 보내기 직전에 '학원 일정'을 다시 넣고 페이지를 다시 읽어 (일정안내) 수식 값을 먼저 쓴다.
// 수식이 없거나 비면 서버가 같은 규칙으로 계산한 값(학생·다니는 반 전부·연결 안 된 일정). 그 달 일정이 0건이면 LetterBlocked.
export async function buildLetterNotice(letter: any): Promise<{ registrationId: string; title: string; period: { start: string; end: string }; variables: Record<string, string> }> {
	const deps = monthlyDeps
	const registrationId = relIds(letter?.properties?.[PROP_LETTER_REG])[0]
	if (!registrationId) throw new LetterBlocked("이 가정통신문에 연결된 등록이 없습니다.")
	const month = String(seoulDay(letter?.properties?.[PROP_LETTER_PERIOD]?.date?.start) ?? "").slice(0, 7)
	if (!month) throw new LetterBlocked("가정통신문 '기간'이 비어 있습니다.")
	const reg: any = await deps.getPage(registrationId)
	const studentId = relIds(reg?.properties?.["학생정보"])[0]
	if (!studentId) throw new LetterBlocked("등록에 학생이 연결되어 있지 않습니다.")
	const regs = await studentRegsInMonth(studentId, month)
	if (!regs.length) throw new LetterBlocked(`${monthLabel(month)}에 다니는 등록이 없습니다.`)
	const unlinked = await bundleUnlinked(letter, studentId, month)
	// 같은 묶음의 다른 반 가정통신문도 미리보기가 맞게 같은 '학원 일정'으로 맞춘다(실패해도 보내기는 계속).
	for (const id of relIds(letter?.properties?.[PROP_LETTER_SIBLINGS])) {
		const sib: any = await deps.getPage(id).catch(() => null)
		if (alive(sib)) await bundleUnlinked(sib, studentId, month, unlinked).catch((err: unknown) => console.warn("[letter] 같은 달 가정통신문 학원 일정 건너뜀:", id, (err as Error).message))
	}
	const lines = await studentMonthEvents(studentId, month, regs, unlinked)
	if (!lines.length) throw new LetterBlocked(`${monthLabel(month)} 학부모 공개 일정이 없어 보내지 않았습니다. 일정을 넣은 뒤 [안내문 전송]을 누르세요.`)
	const fresh: any = await deps.getPage(String(letter.id)).catch(() => letter)
	const f = (name: string, fallback: string) => getFormulaText(fresh, name).trim() || fallback
	const studentName = studentNameOf(reg)
	return {
		registrationId,
		title: studentName || "월간 일정 안내",
		period: monthRange(month),
		variables: {
			"#{학생이름}": f("학생이름(일정안내)", studentName),
			"#{클래스}": f("클래스(일정안내)", classNamesOf(regs).join(" · ")),
			"#{안내월}": f("안내월(일정안내)", monthLabel(month)),
			"#{휴원일정}": f("휴원일정(일정안내)", sectionText(lines, "휴원")),
			"#{학원일정}": f("학원일정(일정안내)", sectionText(lines, "학원")),
			"#{학사일정}": f("학사일정(일정안내)", sectionText(lines, "학교")),
			"#{전달사항}": f("전달사항(일정안내)", await letterNote(fresh, regs)),
			"#{페이지ID}": `${Deno.env.get("REPORT_PATH") ?? "/project1/student_report.html"}?token=${await deps.token(registrationId)}`,
		},
	}
}

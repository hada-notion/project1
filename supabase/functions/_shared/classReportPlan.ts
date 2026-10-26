// _shared/classReportPlan.ts
//
// (v2.8.0) 클래스 [보고서 생성] → create-class-reports 웹훅 → 큐. 반마다 발송함을 만들고 그 반 학생 보고서를 만든다.
// 예전(v2.7)에는 사람이 발송함을 먼저 만들어 클래스 '보고서 생성 대상'에 고른 뒤, 버튼이 등록을 ⚪ 대기로 바꾸고
// 등록 DB 자동화 [생성] 보고서가 보고서를 만들었다. 이제 클래스에 '보고서 구분'·'보고서 기간'만 넣고 누르면
// 서버가 발송함까지 만든다. 순서를 서버 한 곳에서 지키므로 임시로 값을 맡겨 둘 속성이 필요 없다.
//
// 흐름(큐는 전체에서 한 번에 한 건씩, 쌓인 순서대로):
//   1) 웹훅: 누른 순간의 구분·기간·클래스명을 검사해 큐에 "반 1건"을 넣는다(클래스 '보고서 생성 상태' ⏳ 대기열).
//   2) 반 1건: 같은 반·구분·기간 발송함을 찾고 없으면 만든다 → 클래스 '보고서 생성 대상'을 그 발송함으로 →
//      기간 안에 다니는 등록 중 이 발송함 보고서가 없는 학생마다 "학생 1건"을 큐에 넣는다.
//      발송함이 생긴 뒤에야 학생 작업이 들어가므로 순서가 뒤집히지 않는다.
//   3) 학생 1건: 이 등록·이 발송함 보고서가 이미 있으면 건너뛰고, 없으면 보고서 한 페이지를 한 번에 만든다.
//      마지막 학생이 끝나면 클래스 상태를 ✅ 완료(중간에 실패가 있었으면 ⚠️ 오류)로 바꾼다.
// 반 1건을 학생 1건들로 나누는 까닭: 큰 반을 한 작업에서 다 만들면 함수 실행시간 한도에 걸려 중간에 끊긴다
// (예전 generate-report가 그랬다, process-sync-queue/index.ts 주석). 학생 1건은 Notion 호출 몇 번이면 끝난다.
// 건너뛰기: 큐 재시도·다시 누르기·같은 학생 작업이 두 번 들어와도 이 등록·이 발송함 보고서는 하나만 남는다.
import { createPage, fetchWithRetry, fullRelationIds, getPage, notionHeaders, queryAllPages, queryDataSource, relIds, updatePageProperties } from "./notionClient.ts"
import { DS_ATTENDANCE, DS_LEARNING_RECORD, DS_REGISTRATION, DS_REPORT, DS_STUDY_ACTIVITY, NOTION_API, PROP_LAST_ERROR } from "./constants.ts"
import { enqueueSync } from "./syncQueue.ts"
import { markDone, markError, markRunning, type StatusSpec } from "./statusTracking.ts"

export const CLASS_REPORT_GEN_STATUS_SPEC: StatusSpec = {
	statusProp: "보고서 생성 상태",
	errorProp: PROP_LAST_ERROR,
	startedAtProp: "보고서 생성 처리 시작 시각",
}

export const TARGET_CLASS_REPORTS = "class-reports"
export const TARGET_REGISTRATION_REPORT = "registration-report"

export const REPORT_KINDS = ["주간 보고서", "월간 보고서"]
// 클래스(학원) DB
const PROP_CLASS_KIND = "보고서 구분"
const PROP_CLASS_PERIOD = "보고서 기간"
const PROP_CLASS_NAME = "클래스명"
const PROP_CLASS_BATCH = "보고서 생성 대상"
// 알림톡 발송함(학원) DB
const PROP_BATCH_TITLE = "이름"
const PROP_BATCH_KIND = "구분"
const PROP_BATCH_PERIOD = "기간"
const PROP_BATCH_CLASS = "클래스"
// 보고서(학원) DB
const PROP_REPORT_BATCH = "알림톡 발송함"

export type ReportRequest = { kind: string; start: string; end: string; className: string }
export type ClassReportsPayload = ReportRequest & { classId: string }
export type RegistrationReportPayload = ReportRequest & { classId: string; batchId: string; regId: string; last?: boolean }

const DAY = /^\d{4}-\d{2}-\d{2}$/
const textOf = (arr: any): string => (Array.isArray(arr) ? arr.map((t: any) => t?.plain_text ?? t?.text?.content ?? "").join("") : "")
const key = (id: string) => String(id ?? "").replace(/-/g, "").toLowerCase()

// 서울 날짜(YYYY-MM-DD). 날짜만 있는 값은 그대로, 시각이 있는 값은 서울 시각으로 바꿔 날짜를 뗀다.
export function seoulDay(value: string | null | undefined): string | null {
	const v = String(value ?? "")
	if (!v) return null
	if (DAY.test(v)) return v
	const t = new Date(v)
	if (Number.isNaN(t.getTime())) return null
	return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(t)
}

function shiftDay(day: string, days: number): string {
	const t = new Date(`${day}T00:00:00Z`)
	t.setUTCDate(t.getUTCDate() + days)
	return t.toISOString().slice(0, 10)
}

// 클래스 페이지 속성(웹훅 본문에 실린 것 또는 서버가 읽은 페이지)에서 구분·기간·클래스명을 꺼내 검사한다.
// 문제가 있으면 선생님이 고칠 수 있는 문장으로 Error를 던진다(만들지 않고 ⚠️ 오류).
export function reportRequestFromProps(props: any): ReportRequest {
	const kind = String(props?.[PROP_CLASS_KIND]?.select?.name ?? "").trim()
	if (!REPORT_KINDS.includes(kind)) throw new Error(`클래스 '${PROP_CLASS_KIND}'를 주간 보고서나 월간 보고서로 골라 주세요.`)
	const date = props?.[PROP_CLASS_PERIOD]?.date
	const start = seoulDay(date?.start), end = seoulDay(date?.end)
	if (!start || !end) throw new Error(`클래스 '${PROP_CLASS_PERIOD}'에 시작일과 종료일을 모두 넣어 주세요(주간은 월~일, 월간은 1일~말일).`)
	if (start > end) throw new Error(`클래스 '${PROP_CLASS_PERIOD}'의 시작일이 종료일보다 늦습니다.`)
	const className = textOf(props?.[PROP_CLASS_NAME]?.title).trim()
	return { kind, start, end, className }
}

const mmdd = (day: string) => `${day.slice(5, 7)}.${day.slice(8, 10)}`

// 발송함 이름: "중2 A 주간 보고서 10.20~10.26"
export function batchTitle(req: ReportRequest): string {
	return `${req.className ? req.className + " " : ""}${req.kind} ${mmdd(req.start)}~${mmdd(req.end)}`
}

// 보고서 이름: "26.10 강민호 주간 보고서" (v2.7 등록 자동화 [생성] 보고서의 제목 수식과 같다)
export function reportTitle(req: ReportRequest, studentName: string): string {
	return `${req.start.slice(2, 4)}.${req.start.slice(5, 7)} ${studentName} ${req.kind}`
}

// 기간 안에 다니는 등록: 등록일이 있고 기간 끝 이전, 종료일이 비었거나 기간 시작 이후(v2.7 버튼 변수 '대상등록'과 같다).
export function inPeriodRegistration(reg: any, req: ReportRequest): boolean {
	const enrolled = seoulDay(reg?.properties?.["등록일"]?.date?.start)
	if (!enrolled || enrolled > req.end) return false
	const ended = seoulDay(reg?.properties?.["종료일"]?.date?.start)
	return !ended || ended >= req.start
}

// 등록의 학생 이름: '학생이름(등록)' 롤업 → 없으면 등록 제목.
export function studentNameOf(reg: any): string {
	const prop = reg?.properties?.["학생이름(등록)"]
	for (const item of prop?.rollup?.array ?? []) {
		const s = textOf(item?.title ?? item?.rich_text).trim() || String(item?.formula?.string ?? "").trim()
		if (s) return s
	}
	if (prop?.formula?.string) return String(prop.formula.string).trim()
	for (const p of Object.values(reg?.properties ?? {}) as any[]) {
		if (p?.type === "title") return textOf(p.title).trim()
	}
	return ""
}

// Notion 생성 요청은 관계 한 칸에 100개까지. 넘는 것은 만든 뒤 이어 붙인다.
const REL_LIMIT = 100
const rel = (ids: string[]) => ({ relation: ids.slice(0, REL_LIMIT).map((id) => ({ id })) })

export function reportProps(req: ReportRequest, p: { batchId: string; regId: string; studentName: string; attendance: string[]; records: string[]; activities: string[] }): Record<string, unknown> {
	return {
		"보고서": { title: [{ text: { content: reportTitle(req, p.studentName) } }] },
		"보고서 기간": { date: { start: req.start, end: req.end } },
		"보고서 구분": { select: { name: req.kind } },
		"등록": rel([p.regId]),
		[PROP_REPORT_BATCH]: rel([p.batchId]),
		"일괄전송 선택": { checkbox: true },
		"출석": rel(p.attendance),
		"학습기록": rel(p.records),
		"학습활동": rel(p.activities),
	}
}

// 테스트에서 Notion·큐 호출을 바꿔 끼울 수 있게 한다.
export const classReportDeps = {
	getPage,
	createPage,
	queryAllPages,
	query: queryDataSource,
	update: updatePageProperties,
	fullRelationIds,
	enqueue: enqueueSync,
	batchDataSourceId: resolveBatchDataSourceId,
	markRunning: (id: string) => markRunning(id, CLASS_REPORT_GEN_STATUS_SPEC),
	markDone: (id: string) => markDone(id, CLASS_REPORT_GEN_STATUS_SPEC),
	markError: (id: string, message: string) => markError(id, CLASS_REPORT_GEN_STATUS_SPEC, message),
}

// 알림톡 발송함 DB 데이터소스 id. 전용 Secret을 두지 않고 보고서 DB '알림톡 발송함' 관계가 가리키는 곳을 읽는다
// (운영마다 id가 달라도 Secret을 하나 더 넣지 않아도 된다). 함수 인스턴스 안에서는 한 번만 읽는다.
let batchDsCache: string | null = null
export async function resolveBatchDataSourceId(): Promise<string> {
	if (batchDsCache) return batchDsCache
	const res = await fetchWithRetry(`${NOTION_API}/data_sources/${DS_REPORT}`, { headers: notionHeaders() })
	if (!res.ok) throw new Error(`보고서 DB 정보 읽기 실패: ${res.status} ${await res.text()}`)
	const data = await res.json()
	const id = data?.properties?.[PROP_REPORT_BATCH]?.relation?.data_source_id
	if (!id) throw new Error(`보고서 DB에 '${PROP_REPORT_BATCH}' 관계가 없습니다.`)
	batchDsCache = String(id)
	return batchDsCache
}

// 같은 반·구분·기간 발송함을 찾고, 없으면 만든다. 발송함 DB에 '클래스' 관계가 없으면 알아볼 수 있는 오류로.
async function findOrCreateBatch(p: ClassReportsPayload): Promise<{ id: string; created: boolean }> {
	const deps = classReportDeps
	const ds = await deps.batchDataSourceId()
	let found: any[]
	try {
		// 기간 비교는 아래에서 서울 날짜로 한다(기간 범위 값에 대한 Notion 날짜 필터 기준이 애매하다). 반·구분이 같은 발송함은 몇 개뿐이다.
		found = await deps.queryAllPages(ds, {
			and: [
				{ property: PROP_BATCH_CLASS, relation: { contains: p.classId } },
				{ property: PROP_BATCH_KIND, select: { equals: p.kind } },
			],
		})
	} catch (err) {
		const msg = (err as Error).message
		if (/400/.test(msg) && msg.includes(PROP_BATCH_CLASS)) throw new Error(`알림톡 발송함 DB에 '${PROP_BATCH_CLASS}' 관계(클래스 DB)를 먼저 만들어 주세요.`)
		throw err
	}
	const same = found.find((b: any) => {
		const d = b?.properties?.[PROP_BATCH_PERIOD]?.date
		return !b?.in_trash && !b?.archived && seoulDay(d?.start) === p.start && seoulDay(d?.end) === p.end
	})
	if (same) return { id: String(same.id), created: false }
	const page: any = await deps.createPage(ds, {
		[PROP_BATCH_TITLE]: { title: [{ text: { content: batchTitle(p) } }] },
		[PROP_BATCH_KIND]: { select: { name: p.kind } },
		[PROP_BATCH_PERIOD]: { date: { start: p.start, end: p.end } },
		[PROP_BATCH_CLASS]: { relation: [{ id: p.classId }] },
	})
	return { id: String(page.id), created: true }
}

// 큐 "반 1건".
export async function processClassReportsQueueItem(payload: ClassReportsPayload): Promise<void> {
	const deps = classReportDeps
	const p = payload
	try {
		await deps.markRunning(p.classId)
		const batch = await findOrCreateBatch(p)
		// 클래스 화면의 '해당기간 보고서 생성 내역' 수식이 이 발송함으로 누락·중복을 보여 주도록 연결해 둔다.
		await deps.update(p.classId, { [PROP_CLASS_BATCH]: { relation: [{ id: batch.id }] } })
		const regs = (await deps.queryAllPages(DS_REGISTRATION, { property: "클래스", relation: { contains: p.classId } }))
			.filter((r: any) => !r?.in_trash && !r?.archived && inPeriodRegistration(r, p))
		const existing = await deps.queryAllPages(DS_REPORT, { property: PROP_REPORT_BATCH, relation: { contains: batch.id } })
		const done = new Set(existing.flatMap((r: any) => relIds(r?.properties?.["등록"])).map(key))
		const todo = regs.filter((r: any) => !done.has(key(r.id)))
		console.log(`[create-class-reports] class=${p.classId} ${p.kind} ${p.start}~${p.end} 발송함 ${batch.created ? "새로 만듦" : "있음"}, 대상 ${regs.length}, 이미 있음 ${regs.length - todo.length}, 만들 것 ${todo.length}`)
		if (todo.length === 0) return await deps.markDone(p.classId)
		for (let i = 0; i < todo.length; i++) {
			const item: RegistrationReportPayload = { ...p, batchId: batch.id, regId: String(todo[i].id), ...(i === todo.length - 1 ? { last: true } : {}) }
			await deps.enqueue(TARGET_REGISTRATION_REPORT, item)
		}
	} catch (err) {
		// 큐가 다시 시도한다. 다시 해도 발송함은 찾아 쓰고, 이미 있는 학생 보고서는 건너뛴다.
		await deps.markError(p.classId, (err as Error).message).catch(() => {})
		throw err
	}
}

// 기간 안 이 등록의 출석과 그 학습기록·학습활동, 그리고 출석 없는 평가(평가 기간 끝, 하루면 그날이 기간 안).
async function collectReportRelations(regId: string, req: ReportRequest): Promise<{ attendance: string[]; records: string[]; activities: string[] }> {
	const deps = classReportDeps
	// 수업일시는 시각이 있어 Notion 날짜 필터의 기준 시간대가 애매하다. 하루씩 넓혀 읽고 서울 날짜로 다시 거른다.
	const atts = (await deps.queryAllPages(DS_ATTENDANCE, {
		and: [
			{ property: "등록", relation: { contains: regId } },
			{ property: "수업일시", date: { on_or_after: shiftDay(req.start, -1) } },
			{ property: "수업일시", date: { on_or_before: shiftDay(req.end, 1) } },
		],
	})).filter((a: any) => {
		const d = seoulDay(a?.properties?.["수업일시"]?.date?.start)
		return !a?.in_trash && !a?.archived && !!d && d >= req.start && d <= req.end
	})
	const attendance: string[] = [], records = new Set<string>(), activities = new Set<string>()
	for (const a of atts) {
		attendance.push(String(a.id))
		for (const id of await deps.fullRelationIds(a, "학습기록")) records.add(id)
		for (const id of await deps.fullRelationIds(a, "학습활동")) activities.add(id)
	}
	// (v2.8.0) 출석 없이 만든 평가(주간·월간 평가). 이 등록이 들어 있는 평가 학습기록 중 평가 기간이 이 보고서 기간 안인 것.
	const evals = (await deps.queryAllPages(DS_LEARNING_RECORD, {
		and: [
			{ property: "등록", relation: { contains: regId } },
			{ property: "구분", select: { equals: "평가" } },
			{ property: "평가 기간", date: { is_not_empty: true } },
		],
	})).filter((r: any) => {
		const d = r?.properties?.["평가 기간"]?.date
		const day = seoulDay(d?.end) ?? seoulDay(d?.start)
		return !r?.in_trash && !r?.archived && !!day && day >= req.start && day <= req.end
	})
	for (const r of evals) {
		records.add(String(r.id))
		const acts = await deps.queryAllPages(DS_STUDY_ACTIVITY, {
			and: [
				{ property: "학습기록", relation: { contains: String(r.id) } },
				{ property: "등록", relation: { contains: regId } },
			],
		})
		for (const a of acts) if (!a?.in_trash && !a?.archived) activities.add(String(a.id))
	}
	return { attendance, records: [...records], activities: [...activities] }
}

// 큐 "학생 1건".
export async function processRegistrationReportQueueItem(payload: RegistrationReportPayload): Promise<void> {
	const deps = classReportDeps
	const p = payload
	try {
		const dup = await deps.query(DS_REPORT, {
			filter: { and: [
				{ property: PROP_REPORT_BATCH, relation: { contains: p.batchId } },
				{ property: "등록", relation: { contains: p.regId } },
			] },
			page_size: 1,
		})
		if ((dup?.results ?? []).length === 0) {
			const reg: any = await deps.getPage(p.regId)
			const rels = await collectReportRelations(p.regId, p)
			const page: any = await deps.createPage(DS_REPORT, reportProps(p, { batchId: p.batchId, regId: p.regId, studentName: studentNameOf(reg), ...rels }))
			// 100개를 넘는 관계(한 달 학습활동이 많은 학생)는 만든 뒤 전체로 다시 쓴다.
			const over: Record<string, unknown> = {}
			for (const [name, ids] of [["출석", rels.attendance], ["학습기록", rels.records], ["학습활동", rels.activities]] as const) {
				if (ids.length > REL_LIMIT) over[name] = { relation: ids.map((id) => ({ id })) }
			}
			if (Object.keys(over).length) await deps.update(String(page.id), over)
		}
		if (p.last) await finishClass(p.classId)
	} catch (err) {
		// 반 상태는 마지막 학생에서 정한다. 여기서는 오류 문장만 남기고(⚠️로 바꾸지 않아 다시 누르기를 막아 둠), 큐가 다시 시도한다.
		const message = `보고서 생성 실패(다시 누르면 빠진 학생만 만듭니다): ${(err as Error).message}`
		await deps.update(p.classId, { [PROP_LAST_ERROR]: { rich_text: [{ text: { content: message.slice(0, 1900) } }] } }).catch(() => {})
		if (p.last) await deps.markError(p.classId, message).catch(() => {})
		throw err
	}
}

// 마지막 학생 뒤: 중간 실패가 '마지막 오류'에 남아 있으면 ⚠️ 오류, 아니면 ✅ 완료.
async function finishClass(classId: string): Promise<void> {
	const deps = classReportDeps
	const cls: any = await deps.getPage(classId)
	const error = textOf(cls?.properties?.[PROP_LAST_ERROR]?.rich_text).trim()
	if (error) await deps.markError(classId, error)
	else await deps.markDone(classId)
}

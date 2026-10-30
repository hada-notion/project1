// _shared/completionReport.ts
//
// (v2.8.0 수료, 10/30 사용자 결정) 진도교재 [수료] → create-class-reports/completion → 큐.
// 평가는 수업(일일 기록)에서만 만든다. [수료]는 "이 교재(프로그램)를 끝냈다"를 표시하고, 주간·월간 보고서와 같은 길로
// 발송함(구분 "수료 보고서", 이 진도교재)과 학생마다 수료 보고서를 만든다. 선생님은 보고서에 한마디를 쓰고 발송함 [일괄 전송]으로 보낸다.
//
// 흐름(큐는 한 번에 한 건씩):
//   1) 교재 1건: 진도교재를 읽어 수강 중 학생을 고르고, 기간(이 교재 첫 학습일 ~ 오늘)을 정한다 →
//      진도교재 `진행상태` 완료·`수료일` 오늘 → 같은 진도교재의 "수료 보고서" 발송함을 찾거나 만든다 →
//      이 발송함 보고서가 없는 학생마다 "학생 1건"을 큐에 넣는다.
//   2) 학생 1건: 이 등록·이 발송함 보고서가 있으면 건너뛰고, 없으면 이 교재 학습기록·학습활동·출석만 연결한 보고서를 만든다.
//      마지막 학생이 끝나면 진도교재 `수료 상태`를 ✅(중간 실패가 있었으면 ⚠️).
// 두 번 눌러도 발송함은 하나, 학생 보고서도 하나씩만 남는다.
import { createPage, getPage, queryAllPages, queryDataSource, relIds, todaySeoulDate, updatePageProperties } from "./notionClient.ts"
import { DS_LEARNING_RECORD, DS_REPORT, DS_STUDY_ACTIVITY, PROP_LAST_ERROR } from "./constants.ts"
import { enqueueSync } from "./syncQueue.ts"
import { markDone, markError, markRunning, type StatusSpec } from "./statusTracking.ts"
import { reportProps, resolveBatchDataSourceId, seoulDay, studentNameOf } from "./classReportPlan.ts"

export const COMPLETION_STATUS_SPEC: StatusSpec = {
	statusProp: "수료 상태",
	errorProp: PROP_LAST_ERROR,
	startedAtProp: "수료 처리 시작 시각",
}
export const TARGET_COMPLETION = "completion"
export const TARGET_COMPLETION_REPORT = "completion-report"
export const COMPLETION_KIND = "수료 보고서"
export const COMPLETION_BUTTON = "[수료]"

export type CompletionPayload = { bookId: string }
export type CompletionReportPayload = { bookId: string; batchId: string; regId: string; start: string; end: string; bookName: string; last?: boolean }

const plain = (prop: any): string => (prop?.title ?? prop?.rich_text ?? []).map((t: any) => t.plain_text ?? t.text?.content ?? "").join("").trim()
const key = (id: unknown) => String(id ?? "").replace(/-/g, "").toLowerCase()
const gone = (p: any) => !p || p.in_trash || p.archived
const isActive = (reg: any) => !gone(reg) && String(reg?.properties?.["수강상태"]?.formula?.string ?? "").includes("수강 중")
const mmdd = (day: string) => `${day.slice(5, 7)}.${day.slice(8, 10)}`

// 보고서·발송함에 보이는 교재 이름: 진도교재 `주제` → 라이브러리 교재명 → 진도교재 제목.
export function bookDisplayName(book: any, library: any): string {
	return plain(book?.properties?.["주제"]) || plain(library?.properties?.["교재명"]) || plain(book?.properties?.["진도교재"]) || "교재"
}

// 이 교재 학습기록 중 가장 이른 수업일(서울 날짜). 없으면 null.
export function earliestRecordDay(records: any[]): string | null {
	const days = records
		.filter((r) => !gone(r))
		.map((r) => seoulDay(r?.properties?.["수업일"]?.formula?.date?.start ?? r?.properties?.["수업일"]?.date?.start ?? null))
		.filter((d): d is string => !!d)
		.sort()
	return days[0] ?? null
}

export const completionDeps = {
	getPage,
	createPage,
	queryAllPages,
	query: queryDataSource,
	update: updatePageProperties,
	enqueue: enqueueSync,
	batchDataSourceId: resolveBatchDataSourceId,
	today: todaySeoulDate,
	markRunning: (id: string) => markRunning(id, COMPLETION_STATUS_SPEC),
	markDone: (id: string) => markDone(id, COMPLETION_STATUS_SPEC),
	markError: (id: string, message: string) => markError(id, COMPLETION_STATUS_SPEC, message),
}

// 큐 "교재 1건".
export async function processCompletionQueueItem(payload: CompletionPayload): Promise<void> {
	const deps = completionDeps
	const bookId = payload.bookId
	let book: any, regs: any[], classId: string | null
	try {
		await deps.markRunning(bookId)
		book = await deps.getPage(bookId)
		if (gone(book)) return
		const linked = relIds(book?.properties?.["등록"])
		if (!linked.length) {
			if (relIds(book?.properties?.["개별교재"]).length) throw new Error(`개별 진도 교재는 학생의 개별교재(학생 페이지의 진도교재)에서 ${COMPLETION_BUTTON}를 눌러 주세요.`)
			throw new Error("이 진도교재에 연결된 등록(학생)이 없습니다.")
		}
		regs = (await Promise.all(linked.map((id) => deps.getPage(id).catch(() => null)))).filter(isActive)
		if (!regs.length) throw new Error("이 진도교재에 수강 중인 학생이 없습니다.")
		classId = relIds(book.properties?.["클래스"])[0] ?? relIds(regs[0]?.properties?.["클래스"])[0] ?? null
	} catch (err) {
		// 설정 문제는 다시 해도 같다 → ⚠️ 오류만 남기고 큐 재시도 없음.
		await deps.markError(bookId, (err as Error).message).catch(() => {})
		return
	}
	try {
		const end = deps.today()
		const records = await deps.queryAllPages(DS_LEARNING_RECORD, { property: "진도교재", relation: { contains: bookId } })
		const start = earliestRecordDay(records) ?? seoulDay(book.created_time) ?? end
		const libId = relIds(book.properties?.["라이브러리"])[0]
		const bookName = bookDisplayName(book, libId ? await deps.getPage(libId).catch(() => null) : null)
		// 진도교재는 누르는 순간 완료(사용자 결정). 수료일은 처음 누른 날을 지킨다(다시 눌러도 바꾸지 않음).
		const firstDay = seoulDay(book.properties?.["수료일"]?.date?.start) ?? end
		await deps.update(bookId, { "진행상태": { status: { name: "완료" } }, "수료일": { date: { start: firstDay } } })
		const batch = await findOrCreateBatch({ bookId, classId, start, end: firstDay, bookName })
		const existing = await deps.queryAllPages(DS_REPORT, { property: "알림톡 발송함", relation: { contains: batch.id } })
		const done = new Set(existing.flatMap((r: any) => relIds(r?.properties?.["등록"])).map(key))
		const todo = regs.filter((r: any) => !done.has(key(r.id)))
		console.log(`[completion] book=${bookId} ${start}~${firstDay} 발송함 ${batch.created ? "새로 만듦" : "있음"}, 학생 ${regs.length}, 만들 것 ${todo.length}`)
		if (!todo.length) return await deps.markDone(bookId)
		for (let i = 0; i < todo.length; i++) {
			const item: CompletionReportPayload = { bookId, batchId: batch.id, regId: String(todo[i].id), start, end: firstDay, bookName, ...(i === todo.length - 1 ? { last: true } : {}) }
			await deps.enqueue(TARGET_COMPLETION_REPORT, item)
		}
	} catch (err) {
		await deps.markError(bookId, (err as Error).message).catch(() => {})
		throw err
	}
}

// 같은 진도교재의 "수료 보고서" 발송함. 없으면 만든다(이름 "반 수료 보고서 교재 10.01~10.30").
async function findOrCreateBatch(o: { bookId: string; classId: string | null; start: string; end: string; bookName: string }): Promise<{ id: string; created: boolean }> {
	const deps = completionDeps
	const ds = await deps.batchDataSourceId()
	const found = (await deps.queryAllPages(ds, {
		and: [
			{ property: "진도교재", relation: { contains: o.bookId } },
			{ property: "구분", select: { equals: COMPLETION_KIND } },
		],
	})).filter((b: any) => !gone(b))
	if (found.length) return { id: String(found[0].id), created: false }
	let className = ""
	if (o.classId) className = plain((await deps.getPage(o.classId).catch(() => null))?.properties?.["클래스명"])
	const page: any = await deps.createPage(ds, {
		"이름": { title: [{ text: { content: `${className ? className + " " : ""}${COMPLETION_KIND} ${o.bookName} ${mmdd(o.start)}~${mmdd(o.end)}` } }] },
		"구분": { select: { name: COMPLETION_KIND } },
		"기간": { date: { start: o.start, end: o.end } },
		...(o.classId ? { "클래스": { relation: [{ id: o.classId }] } } : {}),
		"진도교재": { relation: [{ id: o.bookId }] },
	})
	return { id: String(page.id), created: true }
}

// 이 등록의 이 교재 학습기록·학습활동·출석. 학습활동이 학생별이라 학습활동에서 출석을 모은다.
export async function collectBookRelations(regId: string, bookId: string): Promise<{ attendance: string[]; records: string[]; activities: string[] }> {
	const deps = completionDeps
	const records = (await deps.queryAllPages(DS_LEARNING_RECORD, {
		and: [
			{ property: "진도교재", relation: { contains: bookId } },
			{ property: "등록", relation: { contains: regId } },
		],
	})).filter((r: any) => !gone(r))
	const recordIds = new Set(records.map((r: any) => key(r.id)))
	const acts = (await deps.queryAllPages(DS_STUDY_ACTIVITY, { property: "등록", relation: { contains: regId } }))
		.filter((a: any) => !gone(a) && relIds(a?.properties?.["학습기록"]).some((id) => recordIds.has(key(id))))
	const attendance = new Set<string>()
	for (const a of acts) for (const id of relIds(a?.properties?.["출석"])) attendance.add(id)
	return { attendance: [...attendance], records: records.map((r: any) => String(r.id)), activities: acts.map((a: any) => String(a.id)) }
}

// 큐 "학생 1건".
export async function processCompletionReportQueueItem(p: CompletionReportPayload): Promise<void> {
	const deps = completionDeps
	try {
		const dup = await deps.query(DS_REPORT, {
			filter: { and: [
				{ property: "알림톡 발송함", relation: { contains: p.batchId } },
				{ property: "등록", relation: { contains: p.regId } },
			] },
			page_size: 1,
		})
		if ((dup?.results ?? []).length === 0) {
			const reg: any = await deps.getPage(p.regId)
			const rels = await collectBookRelations(p.regId, p.bookId)
			const studentName = studentNameOf(reg)
			const props = reportProps({ kind: COMPLETION_KIND, start: p.start, end: p.end, className: "" }, { batchId: p.batchId, regId: p.regId, studentName, ...rels })
			props["보고서"] = { title: [{ text: { content: `${studentName} ${COMPLETION_KIND} ${p.bookName}` } }] }
			props["진도교재"] = { relation: [{ id: p.bookId }] }
			await deps.createPage(DS_REPORT, props)
		}
		if (p.last) await finishBook(p.bookId)
	} catch (err) {
		const message = `수료 보고서 생성 실패(다시 누르면 빠진 학생만 만듭니다): ${(err as Error).message}`
		await deps.update(p.bookId, { [PROP_LAST_ERROR]: { rich_text: [{ text: { content: message.slice(0, 1900) } }] } }).catch(() => {})
		if (p.last) await deps.markError(p.bookId, message).catch(() => {})
		throw err
	}
}

async function finishBook(bookId: string): Promise<void> {
	const deps = completionDeps
	const book: any = await deps.getPage(bookId)
	const error = plain(book?.properties?.[PROP_LAST_ERROR])
	if (error) await deps.markError(bookId, error)
	else await deps.markDone(bookId)
}

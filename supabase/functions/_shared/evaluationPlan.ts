// _shared/evaluationPlan.ts
//
// (v2.8.0) 발송함 [평가 만들기] → create-class-reports/evaluations 웹훅 → 큐. 수업 [학습기록 생성]과 같은 짝이다:
//   수업 `오늘 학습` 체크 + [학습기록 생성]  ↔  발송함(반·구분·기간) 진도교재 `평가 대상` 체크 + [평가 만들기]
// 무엇을 만들지는 발송함 수식 "평가 계획"이 계산한다(체크된 교재마다 평가 학습기록 1개, 대상 학생 = 이 발송함에 보고서가 있는 학생):
//   {"v":1,"items":[{"b":"진도교재","l":"라이브러리","s":["과목"],"r":["등록"],"t":"[주간 평가] 교재 · 중2 B 10.19~10.25"}]}
// 평가 구분·평가 기간·클래스는 서버가 발송함 페이지에서 읽는다(구분이 주간·월간 보고서가 아니면 ⚠️ 오류, 수강료 발송함 보호).
// 교재마다: `평가 대상`이 이미 풀려 있거나 이 발송함·이 교재 평가가 이미 있으면 건너뛴다(두 번 클릭·큐 재시도) → 체크를 풀고
// 평가 학습기록을 만든다 → 학습활동은 기존 [학습활동 생성] 큐(create-assignment)에 넣는다. 그 큐가 학습기록 수식
// "학습활동 계획"(출석 없는 평가는 등록마다)으로 학생별 학습활동을 만들고, 아래 linkRecordToBatchReports로
// 그 학생의 이 발송함 보고서에 학습기록·학습활동을 붙인다. 기록에서 [학습활동 생성]을 다시 눌러도 똑같이 붙는다.
import { createPage, fullRelationIds, getPage, queryAllPages, relIds, updatePageProperties } from "./notionClient.ts"
import { DS_LEARNING_RECORD, DS_REPORT, DS_STUDY_ACTIVITY, PROP_LAST_ERROR } from "./constants.ts"
import { enqueueSync } from "./syncQueue.ts"
import { markDone, markError, markRunning, type StatusSpec } from "./statusTracking.ts"
import { REPORT_KINDS, seoulDay } from "./classReportPlan.ts"

export const BATCH_EVAL_STATUS_SPEC: StatusSpec = {
	statusProp: "평가 생성 상태",
	errorProp: PROP_LAST_ERROR,
	startedAtProp: "평가 생성 처리 시작 시각",
}
export const TARGET_BATCH_EVALUATIONS = "batch-evaluations"
export const EVAL_PLAN_PROP = "평가 계획"

// 진도교재(학원) DB
const PROP_BOOK_EVAL = "평가 대상"
// 학습기록(학원) DB
const PROP_RECORD_BATCH = "알림톡 발송함"

export type EvalPlanItem = { book: string; lib?: string; subjects: string[]; regs: string[]; title: string }
export type BatchEvaluationsPayload = { batchId: string; plan?: string | null }

const ID = /^[0-9a-f]{32}$/
const cleanId = (v: unknown): string | null => {
	const s = String(v ?? "").replace(/-/g, "").toLowerCase()
	return ID.test(s) ? s : null
}
const key = (id: string) => String(id ?? "").replace(/-/g, "").toLowerCase()
const ids = (v: unknown, what: string): string[] => {
	if (!Array.isArray(v)) throw new Error(`평가 계획의 ${what} 값이 올바르지 않습니다.`)
	const out = v.map(cleanId)
	if (out.some((x) => !x)) throw new Error(`평가 계획의 ${what} 값이 올바르지 않습니다.`)
	return Array.from(new Set(out as string[]))
}

// 수식 값이 아니면 null(발송함을 읽어 수식 값을 다시 받는다). 형식이 틀리면 Error(만들지 않고 ⚠️ 오류).
export function evalPlanFromText(text: unknown): EvalPlanItem[] | null {
	if (typeof text !== "string" || !text.trim()) return null
	let raw: any
	try { raw = JSON.parse(text) } catch { return null }
	if (!raw || raw.v !== 1) return null
	if (!Array.isArray(raw.items)) throw new Error("평가 계획에 items가 없습니다. 수식 값이 잘렸을 수 있어요.")
	return raw.items.map((it: any) => {
		const book = cleanId(it?.b)
		if (!book) throw new Error("평가 계획의 진도교재 값이 올바르지 않습니다.")
		return {
			book,
			...(cleanId(it?.l) ? { lib: cleanId(it?.l)! } : {}),
			subjects: ids(it?.s ?? [], "과목"),
			regs: ids(it?.r ?? [], "등록"),
			title: String(it?.t ?? "").trim() || "[평가]",
		}
	})
}

export const evalPlanText = (p: any): string => (p?.type === "formula" || p?.formula ? String(p.formula?.string ?? "") : "")

// 발송함 구분 → 평가 구분
export function evalTypeOfKind(kind: string): string | null {
	return kind === "주간 보고서" ? "주간 평가" : kind === "월간 보고서" ? "월간 평가" : null
}

export function evalRecordProps(item: EvalPlanItem, b: { batchId: string; classId: string | null; evalType: string; start: string; end: string }): Record<string, unknown> {
	return {
		"학습": { title: [{ text: { content: item.title } }] },
		"구분": { select: { name: "평가" } },
		"평가 구분": { select: { name: b.evalType } },
		"평가 기간": { date: { start: b.start, end: b.end } },
		"진도교재": { relation: [{ id: item.book }] },
		"등록": { relation: item.regs.slice(0, 100).map((id) => ({ id })) },
		[PROP_RECORD_BATCH]: { relation: [{ id: b.batchId }] },
		...(b.classId ? { "클래스": { relation: [{ id: b.classId }] } } : {}),
		...(item.lib ? { "교재": { relation: [{ id: item.lib }] } } : {}),
		...(item.subjects.length ? { "과목": { relation: item.subjects.map((id) => ({ id })) } } : {}),
	}
}

// 테스트에서 Notion·큐 호출을 바꿔 끼울 수 있게 한다.
export const evaluationDeps = {
	getPage,
	createPage,
	queryAllPages,
	update: updatePageProperties,
	fullRelationIds,
	enqueue: enqueueSync,
	markRunning: (id: string) => markRunning(id, BATCH_EVAL_STATUS_SPEC),
	markDone: (id: string) => markDone(id, BATCH_EVAL_STATUS_SPEC),
	markError: (id: string, message: string) => markError(id, BATCH_EVAL_STATUS_SPEC, message),
}

// 큐 "발송함 평가 만들기".
export async function processBatchEvaluationsQueueItem(payload: BatchEvaluationsPayload): Promise<void> {
	const deps = evaluationDeps
	const batchId = payload.batchId
	let items: EvalPlanItem[] | null
	let batch: any
	try {
		await deps.markRunning(batchId)
		batch = await deps.getPage(batchId)
		const kind = String(batch?.properties?.["구분"]?.select?.name ?? "")
		if (!REPORT_KINDS.includes(kind)) throw new Error("평가는 주간·월간 보고서 발송함에서만 만들 수 있습니다.")
		items = evalPlanFromText(payload.plan ?? "") ?? evalPlanFromText(evalPlanText(batch?.properties?.[EVAL_PLAN_PROP]))
		if (!items) throw new Error(`발송함 수식 '${EVAL_PLAN_PROP}'을 읽을 수 없습니다.`)
		if (!items.length) throw new Error("평가할 진도교재에 '평가 대상'을 체크한 뒤 눌러 주세요.")
		// 대상 학생이 없는 교재(개별 교재인데 이 발송함에 보고서가 있는 학생이 없음 등)는 건너뛴다. 모두 없으면 보고서부터.
		items = items.filter((it) => it.regs.length)
		if (!items.length) throw new Error("평가할 학생이 없습니다. 클래스 [보고서 생성]으로 이 발송함 보고서를 먼저 만들어 주세요.")
	} catch (err) {
		// 설정 문제는 다시 해도 같다 → ⚠️ 오류만 남기고 큐 재시도 없음.
		await deps.markError(batchId, (err as Error).message).catch(() => {})
		return
	}
	try {
		const d = batch.properties["기간"]?.date
		const start = seoulDay(d?.start), end = seoulDay(d?.end) ?? start
		if (!start || !end) throw new Error("발송함 '기간'이 비어 있습니다.")
		const evalType = evalTypeOfKind(String(batch.properties["구분"].select.name))!
		const classId = relIds(batch.properties["클래스"])[0] ?? null
		// 이 발송함으로 이미 만든 평가의 교재(한 번 조회). 같은 교재는 하나만.
		const existing = await deps.queryAllPages(DS_LEARNING_RECORD, { property: PROP_RECORD_BATCH, relation: { contains: batchId } })
		const doneBooks = new Set(existing.filter((r: any) => !r?.in_trash && !r?.archived).flatMap((r: any) => relIds(r.properties?.["진도교재"])).map(key))
		let made = 0, skipped = 0
		for (const it of items) {
			const book: any = await deps.getPage(it.book)
			if (!book?.properties?.[PROP_BOOK_EVAL]?.checkbox) { skipped++; continue }
			// 체크 해제를 만들기보다 먼저(수업 [학습기록 생성]과 같은 순서): 큐가 다시 해도 두 번 만들지 않는다.
			await deps.update(it.book, { [PROP_BOOK_EVAL]: { checkbox: false } })
			if (doneBooks.has(key(it.book))) { skipped++; continue }
			const rec: any = await deps.createPage(DS_LEARNING_RECORD, evalRecordProps(it, { batchId, classId, evalType, start, end }))
			doneBooks.add(key(it.book))
			await deps.enqueue("create-assignment", { recordId: String(rec.id), plan: null })
			made++
		}
		console.log(`[batch-evaluations] batch=${batchId} ${evalType} ${start}~${end} 만듦 ${made}, 건너뜀 ${skipped}`)
		await deps.markDone(batchId)
	} catch (err) {
		await deps.markError(batchId, (err as Error).message).catch(() => {})
		throw err
	}
}

// 출석 없는 평가 학습기록이 발송함에 연결돼 있으면, 그 기록의 학습활동을 학생별로 그 발송함 보고서에 붙인다.
// [학습활동 생성](create-assignment 큐)이 만들고 난 뒤 부른다. 이미 붙어 있으면 쓰지 않는다(다시 눌러도 안전).
export async function linkRecordToBatchReports(recordId: string, recordPage?: any): Promise<number> {
	const deps = evaluationDeps
	const rec = recordPage ?? await deps.getPage(recordId)
	const batchIds = relIds(rec?.properties?.[PROP_RECORD_BATCH])
	if (!batchIds.length) return 0
	const acts = await deps.queryAllPages(DS_STUDY_ACTIVITY, { property: "학습기록", relation: { contains: recordId } })
	const actsByReg = new Map<string, string[]>()
	for (const a of acts) {
		if (a?.in_trash || a?.archived) continue
		for (const r of relIds(a.properties?.["등록"])) actsByReg.set(key(r), [...(actsByReg.get(key(r)) ?? []), String(a.id)])
	}
	const recRegs = new Set(relIds(rec?.properties?.["등록"]).map(key))
	let linked = 0
	for (const batchId of batchIds) {
		const reports = await deps.queryAllPages(DS_REPORT, { property: "알림톡 발송함", relation: { contains: batchId } })
		for (const rep of reports) {
			const reg = key(relIds(rep.properties?.["등록"])[0] ?? "")
			const addActs = actsByReg.get(reg) ?? []
			if (!reg || (!recRegs.has(reg) && !addActs.length)) continue
			const curRecs = await deps.fullRelationIds(rep, "학습기록")
			const curActs = await deps.fullRelationIds(rep, "학습활동")
			const has = (list: string[], id: string) => list.some((x) => key(x) === key(id))
			const props: Record<string, unknown> = {}
			if (!has(curRecs, recordId)) props["학습기록"] = { relation: [...curRecs, recordId].map((id) => ({ id })) }
			const newActs = addActs.filter((id) => !has(curActs, id))
			if (newActs.length) props["학습활동"] = { relation: [...curActs, ...newActs].map((id) => ({ id })) }
			if (Object.keys(props).length) { await deps.update(String(rep.id), props); linked++ }
		}
	}
	return linked
}

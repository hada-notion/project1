// _shared/assignmentPlan.ts
//
// (v2.6.22) 학습활동 생성을 큐로, 서버는 만들기만. 학습기록 [학습활동 생성] 버튼은 "활동 생성 상태"를 ⚪ 대기로만
// 바꾸고, 학습기록 DB 자동화가 create-assignment/queue로 웹훅을 보낸다. 무엇을 만들지는 학습기록 수식
// "학습활동 계획"이 계산한다(출석마다 학생 1명):
//   {"v":1,"c":"과제","s":"수업","items":[{"a":"출석","r":"등록","d":"다음 출석(과제만)","t":"[과제] 학생 MM.DD(요일)"}]}
// 서버가 학생마다 하던 출석 읽기·등록 읽기(이름)·다음 출석 찾기가 없어지고, 학습활동 만들기만 남는다.
// 원칙: 학습활동은 출석 기준(학생 한 명·출석 한 건). 과제 마감도 그 학생 등록의 다음 출석이다.
// (v2.8.0) 예외: 출석 없이 만든 평가(클래스 [평가 만들기], 평가 전용 반)는 "a"가 비어 있고 등록만 있다.
//   그런 학습활동은 출석 없이 만들고, 리포트는 학습기록 '평가 기간'으로 날짜를 잡는다.
//   출석·수업으로 만든 평가는 학습기록 '평가 구분'이 비어 있으면 '일일 평가'로 채운다.
//
// 두 번 만들기 막기: 만들기 전에 학습활동 DB를 "이 학습기록"으로 한 번 조회해 이미 있는 등록은 건너뛴다.
// 그래서 버튼을 두 번 눌러 같은 계획이 두 번 들어오거나, 큐가 다시 시도해도 학생마다 하나만 남는다.
import { createPage, getPage, mapWithConcurrency, queryAllPages, relIds, updatePageProperties } from "./notionClient.ts"
import { DS_STUDY_ACTIVITY } from "./constants.ts"
import { markDone, markError } from "./statusTracking.ts"
import { AUTO_DEADLINE_PROP } from "./assignmentDeadline.ts"
import { linkRecordToBatchReports } from "./evaluationPlan.ts"
import {
	ASSIGNMENT_GEN_STATUS_SPEC,
	CATEGORY_ASSIGNMENT,
	CATEGORY_EVALUATION,
	CATEGORY_LEARNING,
	dedupe,
	finishCreateAssignment,
	selectValue,
} from "./createAssignmentTarget.ts"

export const PLAN_PROP = "학습활동 계획"

export type AssignmentPlanItem = { att?: string; reg: string; due?: string; title: string }
export type AssignmentPlan = { v: 1; skip?: string; category?: string; session?: string; items: AssignmentPlanItem[] }

const ID = /^[0-9a-f]{32}$/
const cleanId = (v: unknown): string | null => {
	const s = String(v ?? "").replace(/-/g, "").toLowerCase()
	return ID.test(s) ? s : null
}
const CATEGORIES = [CATEGORY_LEARNING, CATEGORY_ASSIGNMENT, CATEGORY_EVALUATION]

// 수식 값이 아니면(속성이 없거나 JSON이 아니면) null → 예전 방식. 형식이 틀리면 Error(만들지 않고 ⚠️ 오류).
export function planFromText(text: unknown): AssignmentPlan | null {
	if (typeof text !== "string" || !text.trim()) return null
	let raw: any
	try { raw = JSON.parse(text) } catch { return null }
	if (!raw || raw.v !== 1) return null
	if (typeof raw.skip === "string" && raw.skip) return { v: 1, skip: raw.skip, items: [] }
	if (!CATEGORIES.includes(raw.c)) throw new Error(`학습활동 계획의 구분이 학습·과제·평가가 아닙니다: ${raw.c}`)
	if (!Array.isArray(raw.items)) throw new Error("학습활동 계획에 items가 없습니다. 수식 값이 잘렸을 수 있어요.")
	const items: AssignmentPlanItem[] = []
	for (const it of raw.items) {
		const att = cleanId(it?.a), reg = cleanId(it?.r)
		// 출석이 비어도 되는 것은 평가뿐이다(출석 없는 평가). 값이 있는데 형식이 틀리면 오류.
		const noAtt = !it?.a && raw.c === CATEGORY_EVALUATION
		if (!reg || (!att && !noAtt)) throw new Error("학습활동 계획의 출석·등록 값이 올바르지 않습니다.")
		const due = it?.d ? cleanId(it.d) : null
		if (it?.d && !due) throw new Error("학습활동 계획의 과제 마감 값이 올바르지 않습니다.")
		items.push({ ...(att ? { att } : {}), reg, ...(due && raw.c === CATEGORY_ASSIGNMENT ? { due } : {}), title: String(it?.t ?? "").trim() || `[${raw.c}]` })
	}
	return { v: 1, category: raw.c, session: cleanId(raw.s) ?? undefined, items }
}

export const planText = (p: any): string => {
	if (!p) return ""
	if (p.type === "formula" || p.formula) return String(p.formula?.string ?? "")
	if (Array.isArray(p.rich_text)) return p.rich_text.map((t: any) => t.plain_text ?? t.text?.content ?? "").join("")
	return ""
}

// 학습활동 페이지 속성(지금 서버가 만들던 것과 같은 모양)
export function activityProps(recordId: string, plan: AssignmentPlan, item: AssignmentPlanItem): Record<string, unknown> {
	const props: Record<string, unknown> = {
		학습활동: { title: [{ text: { content: item.title } }] },
		학습기록: { relation: [{ id: recordId }] },
		등록: { relation: [{ id: item.reg }] },
	}
	if (item.att) props["출석"] = { relation: [{ id: item.att }] }
	if (plan.session) props["수업"] = { relation: [{ id: plan.session }] }
	if (plan.category === CATEGORY_ASSIGNMENT) {
		props["과제상태"] = { select: { name: "🔴 미제출" } }
		if (item.due) {
			props["과제 마감"] = { relation: [{ id: item.due }] }
			props[AUTO_DEADLINE_PROP] = { relation: [{ id: item.due }] }
		}
	}
	return props
}

// 테스트에서 Notion 호출을 바꿔 끼울 수 있게 한다.
export const assignmentPlanDeps = {
	getPage,
	createPage,
	queryAllPages,
	update: updatePageProperties,
	markDone: (id: string) => markDone(id, ASSIGNMENT_GEN_STATUS_SPEC),
	markError: (id: string, message: string) => markError(id, ASSIGNMENT_GEN_STATUS_SPEC, message),
	legacy: finishCreateAssignment,
	// (v2.8.0) 발송함 [평가 만들기]로 만든 출석 없는 평가 → 학생별 학습활동을 그 발송함 보고서에 붙인다(_shared/evaluationPlan.ts).
	linkBatch: (recordId: string) => linkRecordToBatchReports(recordId),
}

const key = (id: string) => id.replace(/-/g, "").toLowerCase()

export const EVAL_TYPE_PROP = "평가 구분"
export const EVAL_TYPE_DAILY = "일일 평가"

// (v2.8.0) 출석·수업으로 만든 평가는 '평가 구분'이 비어 있으면 '일일 평가'로 채운다. 이미 값이 있으면(선생님이
// 주간 평가 등으로 고른 경우) 그대로 둔다. 칸이 없는 운영(v2.8.0 전)이나 쓰기 실패는 학습활동 생성을 막지 않는다.
async function fillDailyEvalType(recordId: string, page: any): Promise<void> {
	const prop = page?.properties?.[EVAL_TYPE_PROP]
	if (!prop || prop.type !== "select" || prop.select?.name) return
	try {
		await assignmentPlanDeps.update(recordId, { [EVAL_TYPE_PROP]: { select: { name: EVAL_TYPE_DAILY } } })
	} catch (err) {
		console.warn(`[create-assignment] ${recordId} 평가 구분 채우기 실패: ${(err as Error).message}`)
	}
}

export async function processAssignmentQueueItem(payload: { recordId: string; plan?: string | null }): Promise<void> {
	const deps = assignmentPlanDeps
	const recordId = payload.recordId
	let plan: AssignmentPlan | null
	try {
		// 본문에 수식 값이 없으면(자동화가 여러 DB를 거치는 수식을 웹훅에 싣지 못하는 경우 등) 학습기록을 한 번 읽는다.
		let page: any = null
		let text = payload.plan ?? ""
		let source = "body"
		const bodyChars = text.length
		// (v2.6.22 후속) 본문 값이 없거나 읽을 수 없으면(잘림 등) 학습기록을 한 번 읽어 수식 값을 다시 받는다.
		if (!text || !planFromText(text)) {
			page = await deps.getPage(recordId)
			if (page?.archived || page?.in_trash) return
			text = planText(page?.properties?.[PLAN_PROP])
			source = bodyChars ? "page(본문 값 읽기 실패)" : "page"
		}
		plan = planFromText(text)
		// 어디서 받은 계획인지·길이만 남긴다(학생 이름·ID는 남기지 않는다). 큰 반 잘림 확인용.
		console.log(`[create-assignment] plan source=${source} bodyChars=${bodyChars} chars=${text.length} items=${plan?.items.length ?? "-"}`)
		if (!plan) {
			// 수식을 아직 안 넣은 운영 → 예전 방식(서버가 학습기록·출석·등록을 읽어 만든다).
			page ??= await deps.getPage(recordId)
			const category = selectValue(page, "구분")
			if (!category || !CATEGORIES.includes(category)) return await deps.markDone(recordId)
			if (category === CATEGORY_EVALUATION && relIds(page.properties?.["출석"]).length) await fillDailyEvalType(recordId, page)
			return await deps.legacy(recordId, category, dedupe(relIds(page.properties?.["등록"])))
		}
	} catch (err) {
		// 계획 형식 오류는 다시 해도 같다 → 만들지 않고 ⚠️ 오류로 남긴다(큐 재시도 없음).
		await deps.markError(recordId, (err as Error).message).catch(() => {})
		return
	}
	if (plan.skip) return await deps.markDone(recordId)

	try {
		// 이미 이 학습기록으로 만든 학습활동의 등록(한 번 조회). 버튼 두 번·큐 재시도에도 학생마다 하나만.
		const existing = await deps.queryAllPages(DS_STUDY_ACTIVITY, { property: "학습기록", relation: { contains: recordId } })
		const done = new Set(existing.flatMap((p: any) => relIds(p.properties?.["등록"])).map(key))
		const seen = new Set<string>()
		const todo = plan.items.filter((it) => {
			if (done.has(it.reg) || seen.has(it.reg)) return false
			seen.add(it.reg)
			return true
		})
		await mapWithConcurrency(todo, 3, (it) => deps.createPage(DS_STUDY_ACTIVITY, activityProps(recordId, plan!, it)))
		if (plan.category === CATEGORY_EVALUATION && plan.items.some((it) => it.att)) {
			await fillDailyEvalType(recordId, await deps.getPage(recordId).catch(() => null))
		}
		// 출석 없는 평가만 발송함에 연결돼 있을 수 있다(일일 학습활동 생성에는 호출이 늘지 않는다).
		if (plan.category === CATEGORY_EVALUATION && plan.items.some((it) => !it.att)) await deps.linkBatch(recordId)
		await deps.markDone(recordId)
		console.log(`[create-assignment] ${recordId} ${plan.category}: 만듦 ${todo.length}, 이미 있음 ${plan.items.length - todo.length}`)
	} catch (err) {
		// 큐가 다시 시도한다. 다시 할 때도 위 조회로 이미 만든 학생은 건너뛴다.
		await deps.markError(recordId, (err as Error).message).catch(() => {})
		throw err
	}
}

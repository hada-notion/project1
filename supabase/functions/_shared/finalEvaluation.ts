// _shared/finalEvaluation.ts
//
// (v2.8.0 진도 평가, 항목 16) 진도교재 [진도 평가 생성] → create-class-reports/progress-evaluation 웹훅 → 큐 "final-evaluation"
// (kind auto). 진도교재 `진행상태`가 완료면 마무리 평가, 아니면 단원 평가로 만든다. 다르면 선생님이 학습기록 `평가 구분`만 바꾼다
// (리포트·알림톡은 보낼 때 평가 구분을 다시 읽는다). 예전 버튼 경로 /unit-evaluation·/final-evaluation(kind unit|final)도 그대로 받는다.
// 교재에 묶인 평가다. 일일·주간·월간 보고서와는 별개로, 학부모 리포트에서 그 교재를 열었을 때 "진도 평가" 구역에 보인다.
// (10/30 사용자) 이름 "교재 평가" → "진도 평가": 예체능(교재 없는 진도)까지 같은 말로 쓴다. 수업 중에 본 평가는 수업에서
// [학습기록 생성] 뒤 구분 평가·평가 구분 단원/마무리로 바꾸면 같은 진도 평가가 된다.
//   - 단원 평가: 단원을 하나 끝냈을 때(여러 번). 이 교재 학습기록 중 `범위`나 `선택 단원`이 들어 있는 가장 최근 것의 값을
//     미리 채운다(빈 기록은 건너뜀, 선생님이 고친다).
//   - 마무리 평가: 교재를 다 끝냈을 때. 범위·단원 없음. (예전 이름 "종합 평가" — 선택지 이름을 바꿔도 옛 값은 마무리 평가로 읽는다.)
//   - 대상: 누른 진도교재에 연결된 등록 중 수강 중인 학생. 그룹 진도 교재(반 교재)는 반 학생 모두, 학생의 개별교재는 그 학생.
//     개별 진도 반 교재(템플릿, 아래에 개별교재가 달림)에는 등록이 없다 → 학생의 개별교재에서 누르라고 ⚠️ 오류.
//   - 만드는 것: 평가 학습기록 1개(구분 평가, 평가 구분, 평가 기간 = 누른 날, 진도교재·교재·과목·클래스·등록).
//     학생별 학습활동(점수 칸)은 기존 [학습활동 생성] 큐(create-assignment)가 학습기록 수식 "학습활동 계획"으로 만든다.
//   - 같은 교재로 다시 공부하면 새 진도교재 페이지를 만들므로 횟수를 막지 않는다. 두 번 누름은 상태 칸(⏳ 대기열·🔄 작업중)이 막는다.
//   - 점수가 없는 평가(예체능 수료)는 점수를 비워 두면 된다(리포트·알림톡에 "수료").
import { createPage, getPage, relIds } from "./notionClient.ts"
import { DS_LEARNING_RECORD, PROP_LAST_ERROR } from "./constants.ts"
import { enqueueSync } from "./syncQueue.ts"
import { markDone, markError, markRunning, type StatusSpec } from "./statusTracking.ts"
import { seoulDay } from "./classReportPlan.ts"
import { unitIdsOf, unitRelationNameOf } from "./selectedUnits.ts"

// (10/30 사용자) 진도교재 버튼이 [수료]로 바뀌며 상태 칸 이름도 `수료 상태`·`수료 처리 시작 시각`이 됐다(completionReport.ts).
// 예전 경로(/progress-evaluation 등)는 남겨 두되 같은 칸을 쓴다.
export const FINAL_EVAL_STATUS_SPEC: StatusSpec = {
	statusProp: "수료 상태",
	errorProp: PROP_LAST_ERROR,
	startedAtProp: "수료 처리 시작 시각",
}
export const TARGET_FINAL_EVALUATION = "final-evaluation"
export const UNIT_EVAL_TYPE = "단원 평가"
export const FINAL_EVAL_TYPE = "마무리 평가"

export type BookEvalKind = "unit" | "final"
export type FinalEvaluationPayload = { bookId: string; kind?: BookEvalKind | "auto" }
export const PROGRESS_EVAL_BUTTON = "[진도 평가 생성]"

// 진도교재 `진행상태`(상태·선택·수식 어느 것이든)가 완료면 마무리 평가, 그 밖(진행 중·빈 값)은 단원 평가.
export function autoEvalKindOf(book: any): BookEvalKind {
	const prop = book?.properties?.["진행상태"]
	const name = String(prop?.status?.name ?? prop?.select?.name ?? prop?.formula?.string ?? "")
	return name.includes("완료") ? "final" : "unit"
}

const plain = (prop: any): string => (prop?.title ?? prop?.rich_text ?? []).map((t: any) => t.plain_text ?? t.text?.content ?? "").join("").trim()
const isActive = (reg: any) => !reg?.in_trash && !reg?.archived && String(reg?.properties?.["수강상태"]?.formula?.string ?? "").includes("수강 중")
const LATEST_LOOKUP = 20

export function finalRecordProps(o: { kind: BookEvalKind; bookId: string; title: string; day: string; regs: string[]; classId: string | null; libId: string | null; subjects: string[]; range?: string; units?: string[]; unitProp?: string | null }): Record<string, unknown> {
	return {
		"학습": { title: [{ text: { content: o.title } }] },
		"구분": { select: { name: "평가" } },
		"평가 구분": { select: { name: o.kind === "unit" ? UNIT_EVAL_TYPE : FINAL_EVAL_TYPE } },
		"평가 기간": { date: { start: o.day } },
		"진도교재": { relation: [{ id: o.bookId }] },
		"등록": { relation: o.regs.slice(0, 100).map((id) => ({ id })) },
		...(o.classId ? { "클래스": { relation: [{ id: o.classId }] } } : {}),
		...(o.libId ? { "교재": { relation: [{ id: o.libId }] } } : {}),
		...(o.subjects.length ? { "과목": { relation: o.subjects.map((id) => ({ id })) } } : {}),
		...(o.range ? { "범위": { rich_text: [{ text: { content: o.range } }] } } : {}),
		// 단원 관계 속성 이름은 학원마다 "단원" 또는 "선택 단원"(_shared/selectedUnits.ts). 최근 학습기록에서 찾은 이름으로 쓴다.
		...(o.units?.length && o.unitProp ? { [o.unitProp]: { relation: o.units.map((id) => ({ id })) } } : {}),
	}
}

// 이 교재 학습 기록(구분 학습) 중 범위나 선택 단원이 들어 있는 가장 최근 것의 범위·선택 단원. 관계 끝쪽 몇 개만 읽는다
// (최근 기록이 뒤에 붙는다). 범위·단원을 적지 않은 기록(10/29 원본: 최근 2건이 빈 기록)은 건너뛴다. 없으면 빈 값.
async function latestStudyOf(book: any, getPageFn: (id: string) => Promise<any>): Promise<{ range: string; units: string[]; unitProp: string | null }> {
	const ids = relIds(book?.properties?.["학습기록"]).slice(-LATEST_LOOKUP)
	const pages = (await Promise.all(ids.map((id) => getPageFn(id).catch(() => null))))
		.filter((p: any) => p && !p.in_trash && !p.archived && p.properties?.["구분"]?.select?.name === "학습")
		.sort((a: any, b: any) => String(b.created_time ?? "").localeCompare(String(a.created_time ?? "")))
	const last = pages.find((pg: any) => plain(pg.properties?.["범위"]) || unitIdsOf(pg).length)
	return { range: plain(last?.properties?.["범위"]), units: last ? unitIdsOf(last) : [], unitProp: last ? unitRelationNameOf(last) : null }
}

// 테스트에서 Notion·큐 호출을 바꿔 끼울 수 있게 한다.
export const finalEvaluationDeps = {
	getPage,
	createPage,
	enqueue: enqueueSync,
	today: () => seoulDay(new Date().toISOString())!,
	markRunning: (id: string) => markRunning(id, FINAL_EVAL_STATUS_SPEC),
	markDone: (id: string) => markDone(id, FINAL_EVAL_STATUS_SPEC),
	markError: (id: string, message: string) => markError(id, FINAL_EVAL_STATUS_SPEC, message),
}

// 큐 "진도 평가 생성"(단원·마무리, kind auto면 진행상태로).
export async function processFinalEvaluationQueueItem(payload: FinalEvaluationPayload): Promise<void> {
	const deps = finalEvaluationDeps
	const bookId = payload.bookId
	let kind: BookEvalKind = payload.kind === "unit" || payload.kind === "final" ? payload.kind : "unit"
	let book: any
	let regs: string[]
	try {
		await deps.markRunning(bookId)
		book = await deps.getPage(bookId)
		if (book?.in_trash || book?.archived) return
		if (payload.kind !== "unit" && payload.kind !== "final") kind = autoEvalKindOf(book)
		const linked = relIds(book?.properties?.["등록"])
		if (!linked.length) {
			if (relIds(book?.properties?.["개별교재"]).length) throw new Error(`개별 진도 교재는 학생의 개별교재(학생 페이지의 진도교재)에서 ${PROGRESS_EVAL_BUTTON}을 눌러 주세요.`)
			throw new Error("이 진도교재에 연결된 등록(학생)이 없습니다.")
		}
		const pages = await Promise.all(linked.map((id) => deps.getPage(id).catch(() => null)))
		regs = pages.filter(isActive).map((p: any) => String(p.id))
		if (!regs.length) throw new Error("이 진도교재에 수강 중인 학생이 없습니다.")
	} catch (err) {
		// 설정 문제는 다시 해도 같다 → ⚠️ 오류만 남기고 큐 재시도 없음.
		await deps.markError(bookId, (err as Error).message).catch(() => {})
		return
	}
	const label = kind === "unit" ? UNIT_EVAL_TYPE : FINAL_EVAL_TYPE
	try {
		const p = book.properties ?? {}
		const libId = relIds(p["라이브러리"])[0] ?? null
		// 반 교재는 교재의 클래스, 학생 개별교재는 클래스가 비어 있어 등록의 클래스를 쓴다.
		let classId = relIds(p["클래스"])[0] ?? null
		if (!classId) {
			const reg = await deps.getPage(regs[0]).catch(() => null)
			classId = relIds(reg?.properties?.["클래스"])[0] ?? null
		}
		const latest = kind === "unit" ? await latestStudyOf(book, deps.getPage) : { range: "", units: [] as string[], unitProp: null }
		const day = deps.today()
		const name = plain(p["진도교재"]) || "교재"
		const rec: any = await deps.createPage(DS_LEARNING_RECORD, finalRecordProps({
			kind, bookId, title: `[${label}] ${name}`, day, regs, classId, libId, subjects: relIds(p["과목"]), range: latest.range, units: latest.units, unitProp: latest.unitProp,
		}))
		await deps.enqueue("create-assignment", { recordId: String(rec.id), plan: null })
		console.log(`[progress-evaluation] ${kind} book=${bookId} ${day} 학생 ${regs.length}명 → 학습기록 ${rec.id}`)
		await deps.markDone(bookId)
	} catch (err) {
		await deps.markError(bookId, (err as Error).message).catch(() => {})
		throw err
	}
}

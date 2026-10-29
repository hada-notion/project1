// _shared/finalEvaluation.ts
//
// (v2.8.0 종합 평가, 항목 16) 진도교재 [종합 평가 만들기] → create-class-reports/final-evaluation 웹훅 → 큐 "final-evaluation".
// 교재 하나를 끝냈을 때 보는 평가다. 일일·주간·월간 보고서와는 별개로, 학부모 리포트에서 그 교재를 열었을 때 보인다.
//   - 대상: 누른 진도교재에 연결된 등록 중 수강 중인 학생. 그룹 진도 교재(반 교재)는 반 학생 모두, 학생의 개별교재는 그 학생.
//     개별 진도 반 교재(템플릿, 아래에 개별교재가 달림)에는 등록이 없다 → 학생의 개별교재에서 누르라고 ⚠️ 오류.
//   - 만드는 것: 평가 학습기록 1개(구분 평가, 평가 구분 종합 평가, 평가 기간 = 누른 날, 진도교재·교재·과목·클래스·등록).
//     학생별 학습활동(점수 칸)은 기존 [학습활동 생성] 큐(create-assignment)가 학습기록 수식 "학습활동 계획"으로 만든다.
//   - 같은 교재로 다시 공부하면 새 진도교재 페이지를 만들므로(라이브러리에서 같은 교재 선택) 교재마다 여러 번 막지 않는다.
//     두 번 누름은 상태 칸(⏳ 대기열·🔄 작업중이면 받지 않음)이 막는다.
//   - 점수가 없는 평가(예체능 수료)는 점수를 비워 두면 된다(리포트·알림톡에 "수료").
import { createPage, getPage, relIds } from "./notionClient.ts"
import { DS_LEARNING_RECORD, PROP_LAST_ERROR } from "./constants.ts"
import { enqueueSync } from "./syncQueue.ts"
import { markDone, markError, markRunning, type StatusSpec } from "./statusTracking.ts"
import { seoulDay } from "./classReportPlan.ts"

export const FINAL_EVAL_STATUS_SPEC: StatusSpec = {
	statusProp: "종합 평가 상태",
	errorProp: PROP_LAST_ERROR,
	startedAtProp: "종합 평가 처리 시작 시각",
}
export const TARGET_FINAL_EVALUATION = "final-evaluation"
export const FINAL_EVAL_TYPE = "종합 평가"

export type FinalEvaluationPayload = { bookId: string }

const plain = (prop: any): string => (prop?.title ?? prop?.rich_text ?? []).map((t: any) => t.plain_text ?? t.text?.content ?? "").join("").trim()
const isActive = (reg: any) => !reg?.in_trash && !reg?.archived && String(reg?.properties?.["수강상태"]?.formula?.string ?? "").includes("수강 중")

export function finalRecordProps(o: { bookId: string; title: string; day: string; regs: string[]; classId: string | null; libId: string | null; subjects: string[] }): Record<string, unknown> {
	return {
		"학습": { title: [{ text: { content: o.title } }] },
		"구분": { select: { name: "평가" } },
		"평가 구분": { select: { name: FINAL_EVAL_TYPE } },
		"평가 기간": { date: { start: o.day } },
		"진도교재": { relation: [{ id: o.bookId }] },
		"등록": { relation: o.regs.slice(0, 100).map((id) => ({ id })) },
		...(o.classId ? { "클래스": { relation: [{ id: o.classId }] } } : {}),
		...(o.libId ? { "교재": { relation: [{ id: o.libId }] } } : {}),
		...(o.subjects.length ? { "과목": { relation: o.subjects.map((id) => ({ id })) } } : {}),
	}
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

// 큐 "종합 평가 만들기".
export async function processFinalEvaluationQueueItem(payload: FinalEvaluationPayload): Promise<void> {
	const deps = finalEvaluationDeps
	const bookId = payload.bookId
	let book: any
	let regs: string[]
	try {
		await deps.markRunning(bookId)
		book = await deps.getPage(bookId)
		if (book?.in_trash || book?.archived) return
		const linked = relIds(book?.properties?.["등록"])
		if (!linked.length) {
			if (relIds(book?.properties?.["개별교재"]).length) throw new Error("개별 진도 교재는 학생의 개별교재(학생 페이지의 진도교재)에서 [종합 평가 만들기]를 눌러 주세요.")
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
	try {
		const p = book.properties ?? {}
		const libId = relIds(p["라이브러리"])[0] ?? null
		// 반 교재는 교재의 클래스, 학생 개별교재는 클래스가 비어 있어 등록의 클래스를 쓴다.
		let classId = relIds(p["클래스"])[0] ?? null
		if (!classId) {
			const reg = await deps.getPage(regs[0]).catch(() => null)
			classId = relIds(reg?.properties?.["클래스"])[0] ?? null
		}
		const day = deps.today()
		const name = plain(p["진도교재"]) || "교재"
		const rec: any = await deps.createPage(DS_LEARNING_RECORD, finalRecordProps({
			bookId, title: `[종합 평가] ${name}`, day, regs, classId, libId, subjects: relIds(p["과목"]),
		}))
		await deps.enqueue("create-assignment", { recordId: String(rec.id), plan: null })
		console.log(`[final-evaluation] book=${bookId} ${day} 학생 ${regs.length}명 → 학습기록 ${rec.id}`)
		await deps.markDone(bookId)
	} catch (err) {
		await deps.markError(bookId, (err as Error).message).catch(() => {})
		throw err
	}
}

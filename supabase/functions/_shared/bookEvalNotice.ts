// _shared/bookEvalNotice.ts
//
// (v2.8.0 진도 평가, 항목 16) 진도 평가 결과 안내 알림톡(단원 평가·마무리 평가 공용 템플릿 "진도 평가 결과 안내").
// (10/30) 이름 "교재 평가" → "진도 평가". 코드 안 이름(bookEval·book-evaluation 경로)은 버튼 웹훅이 쓰므로 그대로 둔다.
//   - 학습활동(학생 한 명) [진도 평가 안내 전송] → send-report/book-evaluation → 그 학습활동 ⚪ 대기 + 큐 notice(kind bookEval).
//     개별 전송이라 이미 보냈어도 다시 보낸다.
//   - 학습기록(평가 한 건) [진도 평가 안내 일괄 전송] → send-report/book-evaluation-batch → 큐 "book-eval-batch" →
//     그 기록의 학습활동 중 아직 ✅ 완료가 아닌 것만 ⚪ 대기 + 큐 notice. 이미 받은 학생은 건너뛴다.
//   - 한 건 처리는 _shared/noticeQueue.ts(kind bookEval): 리포트 최신화 → 변수 → 발송 → 전송 로그 → ✅ 완료·안내 일시.
// 변수: #{학생이름}·#{교재명}·#{평가정보}(📝 구분 [범위] + 단원 줄)·#{평가결과}(📊 결과 / 🎓 수료 + 반 평균 + 선생님 한마디)·#{페이지ID}.
import { getRollupText } from "./alimtalkShared.ts"
import { DS_STUDY_ACTIVITY } from "./constants.ts"
import { getPage, queryAllPages, relIds, updatePageProperties } from "./notionClient.ts"
import { bookEvalInfoBlock, bookEvalResultBlock } from "./noticeBlocks.ts"
import { unitIdsOf, unitNamesOf } from "./selectedUnits.ts"
import { enqueueSync } from "./syncQueue.ts"

export const BOOK_EVAL_NOTICE_STATUS_PROP = "진도 평가 안내 상태"
export const BOOK_EVAL_NOTICE_SENT_PROP = "진도 평가 안내 일시"
export const TARGET_BOOK_EVAL_BATCH = "book-eval-batch"
export const BOOK_EVAL_LOG_CATEGORY = "진도 평가 안내"
const WAITING = "⚪ 대기"
const DONE = "✅ 완료"

const plain = (prop: any): string => (prop?.title ?? prop?.rich_text ?? []).map((t: any) => t.plain_text ?? t.text?.content ?? "").join("").trim()
const num = (prop: any): number | null => (typeof prop?.number === "number" ? prop.number : null)
// 단원 평가·마무리 평가만 진도 평가다. 예전 이름 "종합 평가"는 마무리 평가로 읽는다.
export function bookEvalTypeOf(evalType: string): string | null {
	if (evalType === "종합 평가" || evalType === "마무리 평가") return "마무리 평가"
	if (evalType === "단원 평가") return "단원 평가"
	return null
}

export const bookEvalDeps = { getPage, queryAllPages, update: updatePageProperties, enqueue: enqueueSync, unitNames: unitNamesOf }

// 반 평균: 같은 평가 기록의 학습활동 점수 평균. 점수가 있는 학생 3명 이상일 때만(2명이면 다른 학생 점수를 알 수 있다).
async function classAverageOf(record: any): Promise<number | null> {
	const ids = relIds(record?.properties?.["학습활동"])
	const pages = await Promise.all(ids.map((id) => bookEvalDeps.getPage(id).catch(() => null)))
	const pcts = pages
		.map((p: any) => ({ c: num(p?.properties?.["정답 문항"]), t: num(p?.properties?.["전체 문항"]) }))
		.filter((x) => x.c !== null && x.t && x.t > 0)
		.map((x) => (x.c as number) / (x.t as number) * 100)
	if (pcts.length < 3) return null
	return Math.round(pcts.reduce((n, v) => n + v, 0) / pcts.length * 10) / 10
}

// 학습활동 한 장 → 보낼 내용(페이지ID 빼고). 진도 평가가 아니면 Error.
export async function bookEvalContent(activity: any): Promise<{ registrationId: string; studentName: string; evalType: string; variables: Record<string, string> }> {
	const deps = bookEvalDeps
	const ap = activity?.properties ?? {}
	const registrationId = relIds(ap["등록"])[0]
	if (!registrationId) throw new Error("이 학습활동에 연결된 등록이 없습니다.")
	const recordId = relIds(ap["학습기록"])[0]
	if (!recordId) throw new Error("이 학습활동에 연결된 학습기록이 없습니다.")
	const record = await deps.getPage(recordId)
	const rp = record?.properties ?? {}
	// 학습·과제 기록에 평가 구분을 잘못 골라 둔 경우는 보내지 않는다(공용 보기에서 실수로 고를 수 있다).
	if (String(rp["구분"]?.select?.name ?? "") !== "평가") throw new Error("구분이 평가인 학습기록에서만 진도 평가 안내를 보낼 수 있습니다.")
	const evalType = bookEvalTypeOf(String(rp["평가 구분"]?.select?.name ?? ""))
	if (!evalType) throw new Error("진도 평가(단원 평가·마무리 평가) 학습활동에서만 보낼 수 있습니다.")
	const libId = relIds(rp["교재"])[0]
	const lib = libId ? await deps.getPage(libId).catch(() => null) : null
	const libName = plain(lib?.properties?.["교재명"]) || plain(rp["학습"]).replace(/^\[[^\]]*\]\s*/, "").replace(/\s*·.*$/, "") || "교재"
	// (v2.8.0 예체능) 진도교재 `주제`가 있으면 "주제(교재명)"(예: "기억에 남는 풍경 그리기(수채화 1)").
	const progressBookId = relIds(rp["진도교재"])[0]
	const progressBook = progressBookId ? await deps.getPage(progressBookId).catch(() => null) : null
	const topic = plain(progressBook?.properties?.["주제"])
	const bookName = topic ? `${topic}(${libName})` : libName
	const names = evalType === "단원 평가" ? await deps.unitNames([record]) : new Map<string, string>()
	const units = evalType === "단원 평가" ? unitIdsOf(record).map((id) => names.get(id) ?? "").filter(Boolean) : []
	const classId = relIds(rp["클래스"])[0]
	const cls = classId ? await deps.getPage(classId).catch(() => null) : null
	const hideAvg = cls?.properties?.["반 평균 숨김"]?.checkbox === true
	const reg = await deps.getPage(registrationId)
	const studentName = getRollupText(reg, "학생이름(등록)") || "학생"
	return {
		registrationId,
		studentName,
		evalType,
		variables: {
			"#{학생이름}": studentName,
			"#{교재명}": bookName,
			"#{평가정보}": bookEvalInfoBlock({ evalType, range: evalType === "단원 평가" ? plain(rp["범위"]) : "", units }),
			"#{평가결과}": bookEvalResultBlock({ correct: num(ap["정답 문항"]), total: num(ap["전체 문항"]), classAvg: hideAvg ? null : await classAverageOf(record), comment: plain(ap["선생님 한마디"]) }),
		},
	}
}

// 큐 "book-eval-batch": 그 평가 기록의 학습활동 중 아직 안 보낸 것만 ⚪ 대기로 바꾸고 한 건씩 큐에 넣는다.
export async function processBookEvalBatchItem(payload: { recordId: string; clickerUserId?: string | null }): Promise<void> {
	const deps = bookEvalDeps
	const acts = await deps.queryAllPages(DS_STUDY_ACTIVITY, { property: "학습기록", relation: { contains: payload.recordId } })
	let queued = 0, skipped = 0
	for (const a of acts) {
		if (a?.in_trash || a?.archived) continue
		if (a?.properties?.[BOOK_EVAL_NOTICE_STATUS_PROP]?.select?.name === DONE) { skipped++; continue }
		await deps.update(String(a.id), { [BOOK_EVAL_NOTICE_STATUS_PROP]: { select: { name: WAITING } } })
		await deps.enqueue("notice", { kind: "bookEval", pageId: String(a.id), clickerUserId: payload.clickerUserId ?? null })
		queued++
	}
	console.log(`[book-eval-batch] record=${payload.recordId} 보냄 ${queued}, 이미 받음 ${skipped}`)
}

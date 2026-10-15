// (v2.6.12, 웹훅 재정리 3단계) 시간표 자동화 → generate-classes/queue → sync_queue → 이 처리(워커가 한 건씩).
// generate-classes는 진입 파일(Deno.serve)이라 처리 함수를 가져올 수 없어, 같은 함수의 버튼 경로를 내부 키로 불러
// 끝날 때까지 기다린다(waitForResult). 메뉴 [다음주 수업 일괄 생성]이 시간표 여러 개를 한꺼번에 대기로 바꿔도
// 시간표 하나씩 차례로 처리돼 Notion 호출이 몰리지 않는다. 출석은 그 뒤 출석 조정 큐가 만든다.
import { getCurrentAdminKey } from "./adminShared.ts"
import { enqueueSync } from "./syncQueue.ts"
import { createSessionFromPlan, type SessionPlan } from "./timetableSessionPlan.ts"

// date: 일괄 생성이 판단한 그 시간표의 기준일. 재시도 때 기준일이 이미 지났으면(수업이 실제로는 만들어짐) 건너뛴다.
// plan(v2.6.14): 시간표 수식 "수업추가 정보" 값. 있으면 Notion 호출은 수업 만들기 1번뿐이다(시간표·클래스 읽기, 등록 조회,
// 시간표 상태 쓰기 없음). 만들기가 실패하면 같은 값으로 다시 하지 않고(이미 만들어졌을 수 있음) plan 없는 항목으로 다시
// 넣는다 — 그때는 시간표를 새로 읽어 기준일이 이미 지났으면(수업이 실제로 만들어짐) 건너뛴다.
export async function processGenerateClassesQueueItem(payload: { timetableId: string; date?: string; plan?: SessionPlan }): Promise<void> {
	const plan = payload.plan
	if (plan && (!payload.date || payload.date === plan.date)) {
		let pageId: string
		try {
			pageId = await createSessionFromPlan(payload.timetableId, plan)
		} catch (err) {
			console.error("[generate-classes] 수업추가 정보로 만들기 실패 → 시간표를 새로 읽는 항목으로 다시 넣음:", payload.timetableId, (err as Error).message)
			await enqueueSync("generate-classes", { timetableId: payload.timetableId, date: plan.date })
			return
		}
		console.log("[generate-classes] 수업추가 정보로 수업 생성:", payload.timetableId, plan.date, "명단", plan.regIds.length)
		// 수업은 이미 만들어졌으므로 여기서 실패해도 이 항목을 다시 돌리지 않는다(다시 돌리면 수업이 하나 더 생김).
		if (plan.regIds.length > 0) {
			await enqueueSync("fix-attendance", { pageId }).catch((err) =>
				console.error("[generate-classes] 출석 조정 큐 적재 실패(수업의 [출석 조정]으로 맞추세요):", pageId, (err as Error).message))
		}
		return
	}
	const base = Deno.env.get("SB_URL")
	if (!base) throw new Error("SB_URL이 없어 수업을 만들 수 없어요.")
	const key = await getCurrentAdminKey()
	const res = await fetch(`${base}/functions/v1/generate-classes`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-admin-key": key },
		body: JSON.stringify({ timetableId: payload.timetableId, waitForResult: true, ...(payload.date ? { expectedDate: payload.date } : {}) }),
		signal: AbortSignal.timeout(90_000),
	})
	const text = await res.text().catch(() => "")
	if (!res.ok) throw new Error(`수업 생성 실패(${res.status}): ${text.slice(0, 300)}`)
}

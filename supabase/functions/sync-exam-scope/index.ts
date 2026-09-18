// Supabase Edge Function: sync-exam-scope
//
// 시험범위(학원) DB의 "응시학생 등록"·"시험일정 추가" 두 버튼이 공통으로 호출한다.
// 노션 수식이던 "응시학생 현황"이 학생 DB에 없는 "상태"/"수강중" 값을 참조하고 있던 버그를
// 계기로, 응시학생 현황과 시험일 계산을 한때 이 함수로 옥겨다 (로드맵 4-5, 2026-09-16).
// 같은 날, "응시학생 현황"은 정확한 속성명("등록상태" == "🟢 등록 중")을 쓰는 노션 수식으로
// 다시 전환했다. "시험일" 자동 계산은 요청한 적 없는 기능이라 같은 날 삭제했다 — "시험일"은
// 이제 사용자가 직접 입력하는 수동 날짜 속성이다. 이 함수는 이제 응시 대상 학생을 찾아 아직
// 없는 성적 행을 만드는 것만 한다.
//
//   1. (응시 대상 학생 찾기) 시험범위와 같은 학년이면서, 학교가 지정돼 있으면 같은 학교인
//      "등록상태 = 🟢 등록 중" 학생 중 아직 이 시험범위에 성적 행이 없는 학생을 찾아 성적 행을
//      만든다. 이미 성적 행이 있는 학생은 건드리지 않는다 (점수 등 기존 입력값 보존).
//
// 호출 방식: body에 { pageId: "시험범위 페이지 id" } 를 담아 호출 ("응시학생 등록"/"시험일정 추가" 버튼용).
//
// (2026-09-18, 큐 기반 순차 처리 도입, Phase 3) 실제 처리 로직은 _shared/examScopeTarget.ts로 옮겼다.
// 이 파일은 웹훅 body 파싱과 잠금 선체크만 하고, 실제 처리는 큐에 적재한다.

import { PROP_SCOPE_RUNNING } from "../_shared/constants.ts"
import { getPage, extractPageId, checkboxValue } from "../_shared/notionClient.ts"
import { respondAccepted } from "../_shared/backgroundTask.ts"
import { enqueueSync, wakeSyncQueueWorker } from "../_shared/syncQueue.ts"
import { setExamScopeStatus } from "../_shared/examScopeTarget.ts"

Deno.serve(async (req: Request) => {
	if (req.method !== "POST") {
		return new Response("Use POST", { status: 405 })
	}
	const log: string[] = []
	let pageId: string | null = null
	try {
		let body: Record<string, unknown> = {}
		try {
			body = await req.json()
		} catch {
			body = {}
		}
		console.log("[sync-exam-scope] received body:", JSON.stringify(body))

		pageId = extractPageId(body)
		if (!pageId) {
			return new Response(JSON.stringify({ error: "pageId를 찾을 수 없음" }), { status: 400 })
		}

		// 이미 처리 중이면 새로 시작하지 않고 즉시 반환 -- 처리 중 재클릭으로 인한 중복 처리 방지.
		const scopeForLock = await getPage(pageId)
		if (checkboxValue(scopeForLock, PROP_SCOPE_RUNNING)) {
			return new Response(JSON.stringify({ ok: true, message: "already_processing", pageId }, null, 2), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})
		}

		await setExamScopeStatus(pageId, "처리중")

		// 큐에 적재만 하고 즉시 응답한다 -- 실제 처리는 process-sync-queue 워커가 순서대로
		// 처리한다 (2026-09-18, Phase 3). 진행 상황은 시험범위의 "처리중"/"마지막 오류"로 확인할 수 있다.
		await enqueueSync("sync-exam-scope", { pageId })
		wakeSyncQueueWorker()

		return respondAccepted({ pageId })
	} catch (err) {
		console.error("[sync-exam-scope] ERROR:", (err as Error).message, (err as Error).stack)
		if (pageId) {
			await setExamScopeStatus(pageId, "오류", (err as Error).message)
		}
		return new Response(JSON.stringify({ ok: false, error: (err as Error).message, log }, null, 2), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		})
	}
})

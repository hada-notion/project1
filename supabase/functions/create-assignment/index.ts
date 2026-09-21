// create-assignment v5
// Trigger: 학습기록(학원) DB의 "출제" 버튼 웹훅
//
// v5 변경 사항 (2026-09-21, PART N: 관리자 키 인증 추가):
//   - 이 함수를 호출하는 "출제" 버튼 웹훅에 x-admin-key 커스텀 헤더를 미리 추가해둔 뒤, 함수
//     쪽에도 동일한 검증을 추가한다. adminShared.ts의 resolveAdminKeyFromRequest/
//     getCurrentAdminKey를 그대로 사용(다른 관리자 함수들과 동일한 패턴). 헤더가 없으면
//     body.adminKey도 확인한다.
//
// v4 변경 사항 (2026-09-20, 웹훅 코드 정리 1단계):
//   - 자체적으로 들고 있던 extractPageId/findUuid/normalizeUuid/findPageObjectId(페이지 id 추출용
//     함수 4개, create-learning-record와 거의 동일한 코드를 각자 복붙해서 갖고 있었음)를 지우고
//     _shared/notionClient.ts의 공용 extractPageId로 교체했다. 이 함수와 create-learning-record/
//     cascade-delete/fix-attendance 네 곳이 각자 비슷한 id 추출 로직을 들고 있었는데, 공용 버전만
//     "문자열 끝에서만 UUID를 찾도록" 버그 수정(2026-09-09)이 반영돼 있었다. candidate 필드
//     확인(data.id 우선 → pageId/pageUrl/url/id → 재귀 탐색) 동작 자체는 그대로 유지된다.
//
// v3 변경 사항 (2026-09-18, 큐 기반 순차 처리 도입, Phase 2):
//   - 실제 학습활동 생성 로직(finishCreateAssignment 등)을 _shared/createAssignmentTarget.ts로
//     옮겼다. 이제 버튼 클릭 시 이 함수는 웹훅 payload 파싱 + "이미 처리중" 락 확인 + "출제 처리중"
//     체크박스 표시까지만 동기적으로 하고, 실제 무거운 작업은 sync_queue에 한 건 적재한 뒤
//     process-sync-queue 워커가 순서대로(다른 웹훅 요청과 뒤섞이지 않고) 처리하게 한다.
//     여러 학습기록에서 동시에 "출제" 버튼이 눌려도 Notion API 요청이 서로 겹치지 않는다.
//
// v2에서 추가됨: "출제 처리중" 체크박스를 처리 중 락(lock)으로 사용한다. 같은 학습기록에 대해
// 버튼이 짧은 시간 안에 여러 번(더블클릭, 웹훅 타임아웃 후 재시도 등) 눌려도, 이미 처리 중인
// 요청이 있으면 새 요청은 아무 작업도 하지 않고 즉시 반환한다 — 즉 항상 순차적으로만 실행된다.
//
// 구분별 처리(자세한 내용은 _shared/createAssignmentTarget.ts 참고):
// - 과제: 그 학생의 "다음 수업" 출석을 찾아 학습활동의 "과제 마감"에 자동으로 연결하고,
//   "과제상태"는 🔴 미제출로 시작한다.
// - 평가: 마감/점수 관련 필드는 비워두고 선생님이 학습활동 페이지에서 나중에 직접 입력한다.

import { getPage, relIds as relIdsFromProp, extractPageId } from "../_shared/notionClient.ts"
import { respondAccepted } from "../_shared/backgroundTask.ts"
import { enqueueSync, wakeSyncQueueWorker } from "../_shared/syncQueue.ts"
import { resolveAdminKeyFromRequest, getCurrentAdminKey } from "../_shared/adminShared.ts"
import {
	CATEGORY_ASSIGNMENT,
	CATEGORY_EVALUATION,
	PROP_ASSIGNMENT_GEN_RUNNING,
	selectValue,
	dedupe,
	setAssignmentGenRunning,
	setAssignmentGenDone,
	setAssignmentGenError,
} from "../_shared/createAssignmentTarget.ts"

type JsonRecord = Record<string, unknown>

const PROP_RECORD_CATEGORY = "구분"
const PROP_RECORD_REGISTRATION = "등록"

function relIds(page: JsonRecord, propName: string): string[] {
	return relIdsFromProp((page.properties as JsonRecord)?.[propName])
}

function checkboxValue(page: JsonRecord, propName: string): boolean {
	return (page.properties as JsonRecord)?.[propName]
		? ((page.properties as JsonRecord)[propName] as JsonRecord)?.checkbox === true
		: false
}

async function handleRequest(req: Request): Promise<Response> {
	if (req.method === "OPTIONS") {
		return new Response("ok", {
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Headers": "*",
			},
		})
	}

	let body: JsonRecord = {}
	try {
		const text = await req.text()
		console.log("create-assignment raw body:", text)
		body = text ? (JSON.parse(text) as JsonRecord) : {}
	} catch (err) {
		console.error("Failed to parse request body", err)
		return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 })
	}

	const adminKey = resolveAdminKeyFromRequest(req, body)
	const currentAdminKey = await getCurrentAdminKey()
	if (!adminKey || adminKey !== currentAdminKey) {
		return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } })
	}

	const recordId = extractPageId(body)
	if (!recordId) {
		console.error("Could not extract 학습기록 pageId from payload", body)
		return new Response(JSON.stringify({ error: "missing_page_id" }), { status: 400 })
	}

	try {
		const recordPage = await getPage(recordId)
		const category = selectValue(recordPage, PROP_RECORD_CATEGORY)

		if (category !== CATEGORY_ASSIGNMENT && category !== CATEGORY_EVALUATION) {
			// "학습"이거나 구분이 비어있으면 출제 대상이 아니다.
			return new Response(
				JSON.stringify({ message: "category_not_assignable", recordId, category }),
				{ status: 200 },
			)
		}

		// 같은 학습기록에 대해 버튼이 짧은 시간에 여러 번(더블클릭, 웹훅 타임아웃 후 재시도 등) 눌려도
		// 학습활동이 중복 생성되지 않도록, 이미 처리 중이면 새 요청은 아무 것도 하지 않고 즉시 반환한다.
		if (checkboxValue(recordPage, PROP_ASSIGNMENT_GEN_RUNNING)) {
			return new Response(
				JSON.stringify({ message: "already_processing", recordId }),
				{ status: 200 },
			)
		}
		await setAssignmentGenRunning(recordId, true)

		const registrationIds = dedupe(relIds(recordPage, PROP_RECORD_REGISTRATION))
		if (registrationIds.length === 0) {
			await setAssignmentGenDone(recordId)
			return new Response(
				JSON.stringify({ message: "record_has_no_registrations", recordId }),
				{ status: 200 },
			)
		}

		// Notion의 "웹훅 보내기" 버튼 액션은 이 응답을 동기적으로 기다린다. 실제 생성 작업은
		// sync_queue에 적재해 process-sync-queue 워커가 순서대로 처리하게 하고, 이 함수는 즉시
		// 202로 응답한다. 진행 상황은 학습기록의 "출제 처리중"(이미 켜져 있음) 체크박스로 확인할 수 있다.
		await enqueueSync("create-assignment", { recordId, category, registrationIds })
		wakeSyncQueueWorker()

		return respondAccepted({ recordId, category })
	} catch (err) {
		console.error("create-assignment failed", err)
		await setAssignmentGenError(recordId, (err as Error)?.message ?? String(err))
		return new Response(
			JSON.stringify({ error: "internal_error", message: String(err) }),
			{ status: 500 },
		)
	}
}

Deno.serve(handleRequest)

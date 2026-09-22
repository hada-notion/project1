// create-learning-record v6
// Trigger: 수업(세션) DB 또는 출석(학원) DB의 "학습기록 생성" 버튼 웹훅
//
// v6 변경 사항 (2026-09-21, PART N: 관리자 키 인증 추가):
//   - 이 함수를 호출하는 "학습기록 생성" 버튼 웹훅(수업/출석 두 DB)에 x-admin-key 커스텀 헤더를
//     미리 추가해둔 뒤, 함수 쪽에도 동일한 검증을 추가한다. adminShared.ts의
//     resolveAdminKeyFromRequest/getCurrentAdminKey를 그대로 사용(다른 관리자 함수들과 동일한
//     패턴). 헤더가 없으면 body.adminKey도 확인한다.
//
// v5 변경 사항 (2026-09-20, 웹훅 코드 정리 1단계):
//   - 자체적으로 들고 있던 extractPageId/findUuid/normalizeUuid/findPageObjectId(페이지 id 추출용
//     함수 4개, create-assignment와 거의 동일한 코드를 각자 복붙해서 갖고 있었음)를 지우고
//     _shared/notionClient.ts의 공용 extractPageId로 교체했다 (create-assignment v4와 동일한
//     이유 -- 상세 설명은 그 파일 주석 참고. 동작은 그대로, 더 안전한 버전으로 교체).
//
// v4 변경 사항 (2026-09-18, 큐 기반 순차 처리 도입, Phase 2):
//   - 실제 학습기록 생성 로직(finishCreateLearningRecord 등)을 _shared/createLearningRecordTarget.ts로
//     옮겼다. 이제 버튼 클릭 시 이 함수는 웹훅 payload 파싱 + 출석→수업 치환 + "처리중" 표시까지만
//     동기적으로 하고, 실제 무거운 작업은 sync_queue에 한 건 적재한 뒤 process-sync-queue 워커가
//     순서대로(다른 웹훅 요청과 뒤섞이지 않고) 처리하게 한다. 여러 수업/출석에서 동시에 버튼이 눌려도
//     Notion API 요청이 서로 겹치지 않는다.
//
// v3에서 바뀜: 출석 페이지에서도 같은 버튼/같은 웹훅으로 호출할 수 있다.
// 클릭된 페이지를 한 번 읽어서 parent.data_source_id로 수업 페이지인지 출석 페이지인지 구분하고,
// 출석 페이지면 그 출석의 "수업" 관계(limit 1)를 따라가 실제 수업(세션) 페이지 id로 바꿔치기한다.
// 그 다음부터는 항상 수업 페이지 기준으로 기존 로직(v2)을 그대로 수행하므로, 수업/출석 어느 쪽
// 버튼을 눌러도 결과(그 수업의 모든 등록/출석에 대한 학습기록 생성)은 동일하다.
//
// 흐름(자세한 내용은 _shared/createLearningRecordTarget.ts 참고):
// 0. 클릭된 페이지 id를 추출하고, 그 페이지가 출석 페이지면 연결된 수업 페이지 id로 치환한다.
// 1~4. (지연된) 수업 기준으로 등록/출석/진도교재를 읽어 학습기록을 생성하는 무거운 작업은 process-sync-queue
//    워커가 processCreateLearningRecordQueueItem을 통해 수행한다.

import { getPage, relIds as relIdsFromProp, extractPageId } from "../_shared/notionClient.ts"
import { respondAccepted } from "../_shared/backgroundTask.ts"
import { enqueueSync, wakeSyncQueueWorker } from "../_shared/syncQueue.ts"
import { DS_ATTENDANCE } from "../_shared/constants.ts"
import { resolveAdminKeyFromRequest, getCurrentAdminKey } from "../_shared/adminShared.ts"
import {
	PROP_ATTENDANCE_SESSION,
	dedupe,
	setRecordGenQueued,
} from "../_shared/createLearningRecordTarget.ts"

type JsonRecord = Record<string, unknown>

function relIds(page: JsonRecord, propName: string): string[] {
	return relIdsFromProp((page.properties as JsonRecord)?.[propName])
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
		console.log("create-learning-record raw body:", text)
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

	const clickedId = extractPageId(body)
	if (!clickedId) {
		console.error("Could not extract clicked pageId from payload", body)
		return new Response(JSON.stringify({ error: "missing_page_id" }), { status: 400 })
	}

	// 클릭된 페이지가 출석 페이지면, 그 출석이 연결된 수업(세션) 페이지 id로 바꿔치기한다.
	// 수업 페이지가 클릭된 경우(기존 동작)나 parent 조회가 실패한 경우는 그대로 sessionId로 사용한다.
	let sessionId = clickedId
	try {
		const clickedPage = await getPage(clickedId)
		const parentDataSourceId = (clickedPage as JsonRecord | undefined)?.parent
			? ((clickedPage.parent as JsonRecord).data_source_id as string | undefined)
			: undefined
		if (parentDataSourceId === DS_ATTENDANCE) {
			const linkedSessionIds = relIds(clickedPage, PROP_ATTENDANCE_SESSION)
			if (linkedSessionIds.length === 0) {
				console.error("Attendance page has no linked session", clickedId)
				return new Response(
					JSON.stringify({ error: "attendance_missing_session", pageId: clickedId }),
					{ status: 400 },
				)
			}
			sessionId = linkedSessionIds[0]
		}
	} catch (err) {
		// 클릭된 페이지 조회에 실패해도, 원래 id를 수업 페이지로 간주하고 계속 진행한다 (기존 동작 유지).
		console.error(`Failed to resolve session from clicked page ${clickedId}, falling back to it directly`, err)
	}

	// 출석 페이지에서 버튼을 눌렀을 때도 그 출석 페이지 자신의 "학습기록 생성중" 체크박스가 갱신되도록,
	// 클릭된 페이지와 (치환된) 수업 페이지 둘 다에 상태를 표시한다. 같은 페이지면 한 번만 호출된다.
	// (2026-09-22, Phase 6) 여기서는 markQueued("⏳ 대기열")만 표시한다 -- 실제 markRunning은
	// processCreateLearningRecordQueueItem이 이 항목을 집어서 처리를 시작할 때 호출한다.
	const statusTargetIds = dedupe([clickedId, sessionId])
	await Promise.all(statusTargetIds.map((id) => setRecordGenQueued(id)))

	// Notion의 "웹훅 보내기" 버튼 액션은 이 응답을 동기적으로 기다린다. 실제 생성 작업은
	// sync_queue에 적재해 process-sync-queue 워커가 순서대로 처리하게 하고, 이 함수는 즉시 202로 응답한다.
	// 진행 상황은 수업/출석의 "학습기록 생성중" 체크박스(이미 켜져 있음)로 확인할 수 있다.
	await enqueueSync("create-learning-record", { sessionId, statusTargetIds })
	wakeSyncQueueWorker()

	return respondAccepted({ sessionId })
}

Deno.serve(handleRequest)

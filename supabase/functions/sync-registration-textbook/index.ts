// sync-registration-textbook
//
// 등록 DB "개별교재 생성" 버튼 하나로 그룹/개별 진도 모두 처리한다 (등록일/종료일 편집
// 웹훅에는 더 이상 반응하지 않음 - 그 자동화는 삭제됨, 클래스 세팅은 완전 수동).
//
// 클래스 세팅(수동): 담당자가 진도교재(학원) DB에 "반별교재"(템플릿) 행을 직접 만들어
// 클래스에 연결해둔다. 템플릿은 정규교재/클래스/진도방식(그룹 진도 | 개별 진도)를 가진다.
//
// "개별교재 생성" 버튼(등록 페이지)을 누르면:
//   1. 등록의 클래스에 연결된 반별교재(템플릿)를 모두 확인한다.
//   2. 그룹 진도는 템플릿 페이지 자체를 반 전체가 공유하고, 해당 등록 관계만 추가한다.
//   3. 개별 진도는 학생(등록)별 인스턴스를 생성해 템플릿과 연결한다.
//   4. 결과 교재들을 등록의 "진도교재" 관계에 한 번에 반영한다.
//   5. 이미 연결되거나 생성된 조합은 건너뛰므로 재실행해도 중복되지 않는다.
//   6. 등록일이 없어도 수강 시작 전 교재 준비를 위해 실행할 수 있다.
//
// 종료 처리 시 교재 정리(사용자가 확정한 규칙 - 무조건 삭제/연결해제 아님):
//   진행상태가 "다음 교재"이고 학습기록이 하나도 없는 인스턴스만 정리 대상이다.
//   (진행 중/완료 상태이거나 학습기록이 있으면 실제 학습 흔적이므로 절대 건드리지 않는다.)
//     - 진도방식 = 그룹 진도: 등록의 "진도교재"에서 연결만 해제한다 (인스턴스 페이지 자체는
//       보존 - 반에서 공유되는 템플릿에 딸린 자원이라 삭제하지 않음).
//     - 진도방식 = 개별 진도: 인스턴스 페이지 자체를 아카이브(삭제)한다.
//
// 라우트:
//   POST /sync-registration-textbook/create-individual  <- 등록 DB "개별교재 생성" 버튼
//   POST /sync-registration-textbook/create-class        <- 클래스(학원) DB "교재 생성" 버튼
//   POST /sync-registration-textbook/cleanup-on-end      <- sync-registration-timetable이 등록
//                                                            종료 확정 시 내부적으로 호출
//
// (2026-09-18, 큐 기반 순차 처리 도입, Phase 3) create-individual 라우트만 큐로 옮겨서
// process-sync-queue 워커가 순서대로 처리하도록 바꿨다 (_shared/registrationTextbookTarget.ts). cleanup-on-end
// 는 sync-registration-timetable/sync-registration-end의 registrationSync.ts가 내부적으로 동기 호출(fetch)해서
// 즉시 결과를 받아야 하므로 큐를 거치지 않고 그대로 동기 처리된다.
//
// (2026-09-20, 웹훅 코드 정리 4단계) create-individual 라우트의 "락 확인 -> 처리중 표시 -> 큐 적재 ->
// 202 응답" 흐름을 _shared/webhookIngest.ts의 공용 헬퍼로 옮겼다. 3단계에서 다른 등록/시험범위/
// 클래스 버튼 웹훅들을 옮길 때 이 함수는 이름이 sync-textbook-distribution과 비슷해서 빠뜨렸었다.
//
// (2026-09-21, PART N-2) 두 라우트 모두에 관리자 키 인증을 추가한다. create-individual은 등록(학원)
// DB "개별교재 생성" 버튼 자동화에 이미 x-admin-key 헤더를 추가해두었다. cleanup-on-end는 Notion
// 자동화가 직접 부르지 않고 _shared/registrationSync.ts의 callTextbookCleanup()이 내부적으로만
// 호출하는데, 그 호출도 이번에 x-admin-key 헤더를 보내도록 함께 고쳤으므로(같은 커밋) 여기서
// cleanup-on-end까지 막아도 그 내부 호출은 깨지지 않는다. 두 라우트 모두 pageId 추출 이전에
// 공통으로 검사한다.
//
// (2026-09-22, PART N-4: 개별 트리거 버튼 동기화 전환) create-individual도 등록 페이지 1건만
// 대상으로 하는 개별 트리거라 sync_queue를 거칠 필요가 없다. runLockedQueueWebhookForPage(큐 적재)
// 대신 runSyncWebhookForPage를 써서 버튼 클릭과 동시에 끝나도록 한다. cleanup-on-end 라우트는
// 원래부터 동기 처리였으므로 그대로 둔다.
//
// (2026-09-22, PART N-8: 클래스 "교재 생성" 버튼 라우트 누락 수정) 클래스(학원) DB "교재 생성" 버튼
// 자동화가 실제로 이 함수의 create-class 라우트를 호출하고 있었는데, 그런 라우트가 애초에 구현된
// 적이 없어서 항상 404("알 수 없는 경로: create-class")로 끝났다 (Supabase 로그로 실제 운영 클래스
// "고1 A반"에서도 확인됨 - 사용자 화면에는 그냥 아무 반응 없음으로만 보였다). create-class 라우트를
// 추가한다. 클래스 페이지 자신이 클릭 대상이라 pageId 자리에 classId가 그대로 들어오고,
// createBooksForClass(_shared/registrationTextbookTarget.ts)가 클래스의 활성 등록 전체에 대해
// createIndividualBooksForRegistration을 실행한다. 현재는 create-individual과 동일하게
// runSyncWebhookForPage를 사용해 즉시 응답 후 백그라운드에서 처리한다. 잠금/상태 속성만
// setClassTextbookStatus(클래스 DB의 "교재 생성중"/"마지막 오류")로 바뀔 뿐 흐름은 동일하다.

import { extractPageId } from "../_shared/notionClient.ts"
import {
	TEXTBOOK_STATUS_SPEC,
	cleanupUnusedBooksOnEnd,
	createIndividualBooksForRegistration,
	CLASS_TEXTBOOK_STATUS_SPEC,
	createBooksForClass,
} from "../_shared/registrationTextbookTarget.ts"
import { runSyncWebhookForPage } from "../_shared/webhookIngest.ts"
import { resolveAdminKeyFromRequest, getCurrentAdminKey } from "../_shared/adminShared.ts"

async function processPage(pageId: string): Promise<void> {
	const result = await createIndividualBooksForRegistration(pageId)
	console.log("[sync-registration-textbook] create-individual finished:", pageId, result)
}

// (2026-09-22, PART N-8) create-class 라우트 전용 얇은 래퍼. runSyncWebhookForPage의
// process(pageId) 시그니처(Promise<void>)에 맞추기 위해 createBooksForClass의 결과를 로그로만 남긴다.
async function processClassPage(classId: string): Promise<void> {
	const result = await createBooksForClass(classId)
	console.log("[sync-registration-textbook] create-class finished:", classId, result)
}

Deno.serve(async (req: Request) => {
	const url = new URL(req.url)
	const route = url.pathname.split("/").pop()
	let body: unknown = {}
	try {
		body = await req.json()
	} catch {
		// 빈 바디 허용하지 않음 - 아래에서 pageId 누락으로 에러 처리
	}
	console.log("sync-registration-textbook payload:", route, JSON.stringify(body))

	const adminKey = resolveAdminKeyFromRequest(req, body)
	const currentAdminKey = await getCurrentAdminKey()
	if (!adminKey || adminKey !== currentAdminKey) {
		return new Response(JSON.stringify({ error: "unauthorized" }), {
			status: 401,
			headers: { "Content-Type": "application/json" },
		})
	}

	const pageId = extractPageId(body)
	if (!pageId) {
		return new Response(JSON.stringify({ error: "pageId를 찾을 수 없음" }), { status: 400 })
	}

	try {
		if (route === "create-individual") {
			return await runSyncWebhookForPage(pageId, {
				functionName: "sync-registration-textbook",
				statusSpec: TEXTBOOK_STATUS_SPEC,
				process: processPage,
			})
		} else if (route === "create-class") {
			// 클래스(학원) DB "교재 생성" 버튼 -- 클릭 대상(pageId)이 클래스 페이지 자신이다.
			return await runSyncWebhookForPage(pageId, {
				functionName: "sync-registration-textbook:create-class",
				statusSpec: CLASS_TEXTBOOK_STATUS_SPEC,
				process: processClassPage,
			})
		} else if (route === "cleanup-on-end") {
			// 다른 함수(registrationSync.ts의 callTextbookCleanup)가 내부적으로 동기 호출해서 즉시
			// 결과를 받아야 하므로, 이 라우트는 큐를 거치지 않고 그대로 동기 처리된다.
			const result = await cleanupUnusedBooksOnEnd(pageId)
			return new Response(JSON.stringify({ ok: true, result }), { status: 200 })
		} else {
			return new Response(JSON.stringify({ error: `알 수 없는 경로: ${route}` }), { status: 404 })
		}
	} catch (err) {
		console.error(err)
		return new Response(JSON.stringify({ error: String(err) }), { status: 400 })
	}
})

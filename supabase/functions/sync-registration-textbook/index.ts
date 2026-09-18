// sync-registration-textbook
//
// 등록 DB "개별교재 생성" 버튼 하나로 그룹/개별 진도 모두 처리한다 (등록일/종료일 편집
// 웹훅에는 더 이상 반응하지 않음 - 그 자동화는 삭제됨, 클래스 세팅은 완전 수동).
//
// 클래스 세팅(수동): 담당자가 진도교재(학원) DB에 "반별교재"(템플릿) 행을 직접 만들어
// 클래스에 연결해둔다. 템플릿은 정규교재/클래스/진도방식(그룹 진도 | 개별 진도)를 가진다.
//
// "개별교재 생성" 버튼(등록 페이지)을 누르면:
//   1. 등록에 연결된 클래스를 찾고, 그 클래스에 연결된 반별교재(템플릿) 전체를 확인한다.
//   2. 템플릿마다, 이 등록용 "개별교재" 인스턴스를 만든다 (반별교재 self-relation으로 템플릿과
//      연결, 정규교재/클래스/진도방식은 템플릿에서 그대로 복사, 진행상태는 "다음 교재"로 시작).
//      그룹 진도든 개별 진도든 학생마다 자기 진행상태/학습기록을 갖도록 항상 인스턴스를 만든다.
//   3. 새로 만든 인스턴스를 등록의 "진도교재" relation에 연결한다.
//   4. 이미 이 등록 + 이 템플릿 조합의 인스턴스가 있으면 건너뛴다 (재실행 안전 - 버튼을
//      여러 번 누러도, 나중에 클래스에 템플릿이 추가된 뒤 다시 눌러도 중복 생성되지 않음).
//   5. 등록일이 없어도 진행 가능 (교재 준비는 수강 시작 전에도 할 수 있어야 함).
//
// 종료 처리 시 교재 정리(사용자가 확정한 규칙 - 무조건 삭제/연결해제 아님):
//   진행상태가 "다음 교재"이고 학습기록이 하나도 없는 인스턴스만 정리 대상이다.
//   (진행 중/완료 상태이거나 학습기록이 있으면 실제 학습 흔적이므로 절대 건드리지 않는다.)
//     - 진도방식 = 그룹 진도: 등록의 "진도교재"에서 연결만 해제한다 (인스턴스 페이지 자체는
//       보존 - 반에서 공유되는 템플릿에 딧린 자원이라 삭제하지 않음).
//     - 진도방식 = 개별 진도: 인스턴스 페이지 자체를 아카이브(삭제)한다.
//
// 라우트:
//   POST /sync-registration-textbook/create-individual  <- 등록 DB "개별교재 생성" 버튼
//   POST /sync-registration-textbook/cleanup-on-end      <- sync-registration-timetable이 등록
//                                                            종료 확정 시 내부적으로 호출
//
// (2026-09-18, 큐 기반 순차 처리 도입, Phase 3) create-individual 라우트만 큐로 옮겨서
// process-sync-queue 워커가 순서대로 처리하도록 바꿔다 (_shared/registrationTextbookTarget.ts). cleanup-on-end
// 는 sync-registration-timetable/sync-registration-end의 registrationSync.ts가 내부적으로 동기 호출(fetch)해서
// 즉시 결과를 받아야 하므로 큐를 거치지 않고 그대로 동기 처리된다.

import { PROP_SYNC_TEXTBOOK_RUNNING } from "../_shared/constants.ts"
import { getPage, extractPageId, checkboxValue } from "../_shared/notionClient.ts"
import { respondAccepted } from "../_shared/backgroundTask.ts"
import { enqueueSync, wakeSyncQueueWorker } from "../_shared/syncQueue.ts"
import { setTextbookSyncStatus, cleanupUnusedBooksOnEnd } from "../_shared/registrationTextbookTarget.ts"

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

	const pageId = extractPageId(body)
	if (!pageId) {
		return new Response(JSON.stringify({ error: "pageId를 찾을 수 없음" }), { status: 400 })
	}

	try {
		if (route === "create-individual") {
			// 이미 처리 중이면 새로 시작하지 않고 즉시 반환 -- 처리 중 재클릭으로 인한 중복 개별교재 생성 방지.
			const regPageForLock = await getPage(pageId)
			if (checkboxValue(regPageForLock, PROP_SYNC_TEXTBOOK_RUNNING)) {
				return new Response(JSON.stringify({ ok: true, message: "already_processing", pageId, route }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
			}
			await setTextbookSyncStatus(pageId, "처리중")

			// 큐에 적재만 하고 즉시 응답한다 -- 실제 처리는 process-sync-queue 워커가 순서대로
			// 처리한다 (2026-09-18, Phase 3). 진행 상황은 등록의 "동기화 상태"(이미 처리중으로
			// 설정됨)로 확인할 수 있다.
			await enqueueSync("sync-registration-textbook:create-individual", { pageId })
			wakeSyncQueueWorker()

			return respondAccepted({ pageId, route })
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

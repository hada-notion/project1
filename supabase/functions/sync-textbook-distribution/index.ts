// sync-textbook-distribution
//
// 교재뱄 기능(로드맵 5-37): 진도교재 담기(교재배부 생성) + 필요 시 교재비(카트) 자동 생성.
// 결제(교재배부 "결재" 버튼 → 미납/결제완료 전환)는 기존 노션 자동화를 그대로 사용하야 이 함수는 건드리지 않는다.
//
// (아래 2026-09-16 ~ 2026-09-21 사이의 배경 설명은 이전과 동일하게 유지 — from-class-carts 라우트의
// 히스토리, 웹훅 주소 오류/체크박스 고착 수정 경위, 관리자 키 인증 도입 등.)
//
// (2026-09-16) 교재비(카트) 페이지를 새로 만들 때 "알림톡 설정" 관계(표시 전용)도 함께 채운다.
//
// (2026-09-17) from-class(반 전체 일괄 배부)는 구조적 한계로 포기했고, 그 대신 반 전체 "교재비"
// 일괄 생성만 하는 from-class-carts를 다시 도입했다. 실제 교재 배부(청구)는 여전히 교재비 페이지의
// "진도교재 담기" 버튼(from-cart)으로 학생별로 개별 진행한다.
//
// (2026-09-18, 큐 기반 순차 처리 도입, Phase 2) 실제 담기/생성 로직은 _shared/textbookDistributionTarget.ts로
// 옮겼다.
//
// (2026-09-20, 웹훅 코드 정리 3단계) from-cart 라우트의 "잠금 확인 -> 처리중 표시 -> 큐 적재 -> 202
// 응답" 부분만 _shared/webhookIngest.ts의 runLockedQueueWebhookForPage로 옮겼다. from-class-carts
// 라우트는 실행 전에 실제 데이터(활성 등록 중 교재비 누락 여부)부터 계산해서 즉시완료/이어서진행을
// 판단하는 고유 로직이 있어 공용 헬퍼로 단순화하지 않고 그대로 뒀다.
//
// (2026-09-21, PART N-2) 두 라우트 모두에 관리자 키 인증을 추가한다. 교재비(학원) DB "진도교재 담기"
// (from-cart)와 클래스(학원) DB "교재비 생성"(from-class-carts) 버튼 자동화에 이미 x-admin-key
// 헤더를 추가해두었다. route 분기 전에 공통으로 한 번만 검사한다.
//
// (2026-09-22, PART N-4: 개별 트리거 버튼 동기화 전환) from-cart는 교재비 페이지 1건만 대상으로
// 하는 개별 트리거라 sync_queue를 거칠 필요가 없다. runLockedQueueWebhookForPage(큐 적재) 대신
// runSyncWebhookForPage를 써서 버튼 클릭과 동시에 끝나도록 한다. from-class-carts는 반 전체(여러
// 등록)를 대상으로 하는 명시적인 일괄 버튼이라 계속 큐를 쓴다 (변경 없음).
//
// 라우트:
//   POST /sync-textbook-distribution/from-cart         <- 교재비(학원) DB "진도교재 담기" 버튼 (학생 1명, 담기까지 수행)
//   POST /sync-textbook-distribution/from-class-carts   <- 클래스(학원) DB "교재비 생성" 버튼 (반 전체, 교재비 페이지만 일괄 생성 - 교재 배부는 하지 않음)

import { getPage, extractPageId, checkboxValue, relationIds } from "../_shared/notionClient.ts"
import { respondAccepted } from "../_shared/backgroundTask.ts"
import { enqueueSync, wakeSyncQueueWorker } from "../_shared/syncQueue.ts"
import { runSyncWebhookForPage } from "../_shared/webhookIngest.ts"
import { resolveAdminKeyFromRequest, getCurrentAdminKey } from "../_shared/adminShared.ts"
import {
	PROP_CART_RUNNING,
	PROP_CLASS_CART_RUNNING,
	setCartStatus,
	setClassCartStatus,
	getActiveRegistrationsForCarts,
	distributeFromCartPage,
} from "../_shared/textbookDistributionTarget.ts"

// 등록(학원) DB 속성: from-class-carts 사전 확인(활성 등록 중 교재비 누락 여부 판정)에서만 쓴다.
const PROP_REGISTRATION_CART = "교재비" // relation -> 교재비(학원) DB

Deno.serve(async (req: Request) => {
	const url = new URL(req.url)
	// (2026-09-17) 트레일링 슬래시가 붙어오면 기존 split("/").pop()은 빈 문자열을 반환했다 --
	// filter(Boolean)으로 빈 조각을 걸러내서 트레일링 슬래시가 있어도 라우트가 정확히 잡히도록 한다.
	const route = url.pathname.split("/").filter(Boolean).pop()
	const rawBodyText = await req.text()
	let body: unknown = {}
	try {
		body = rawBodyText ? JSON.parse(rawBodyText) : {}
	} catch {
		// 빈 바디 허용하지 않음 - 아래에서 pageId 누락으로 에러 처리
	}
	console.log("sync-textbook-distribution payload:", route, JSON.stringify(body))

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
		if (route === "from-cart") {
			// 교재비 페이지 자신이 클릭 대상. 개별 트리거라 큐를 거치지 않고 바로 처리한다.
			return await runSyncWebhookForPage(pageId, {
				functionName: "sync-textbook-distribution:from-cart",
				lockProp: PROP_CART_RUNNING,
				setStatus: setCartStatus,
				process: distributeFromCartPage,
			})
		} else if (route === "from-class-carts") {
			// 클래스 페이지 자신이 클릭 대상.
			// 먼저 실제 데이터(활성 등록 중 교재비 누락 여부)부터 계산한다. 체크박스 값만 보고 바로
			// 처리중/거부를 판단하지 않고, 항상 실제 상태를 기준으로 판단한다 (2차 수정).
			const classForLock = await getPage(pageId)
			const activeRegistrations = await getActiveRegistrationsForCarts(pageId)
			const missingRegistrations = activeRegistrations.filter(
				(reg: any) => relationIds(reg, PROP_REGISTRATION_CART).length === 0,
			)

			if (missingRegistrations.length === 0) {
				// (2026-09-17, 즉시 완료 단축 경로) 만들 게 하나도 없다 -- 이미 실수로 두 번 눌렀거나,
				// 이전 실행이 실제로는 다 끝났는데 체크박스만 고착된 경우다. 큐에 전혀 적재하지 않고
				// 이 요청 자체에서 바로 응답한다: 켜져 있었으면 그 자리에서 꺼주고, 이미 꺼져
				// 있었으면 아무 쓰기도 하지 않고 즉시 반환한다 (고착될 여지 자체가 없다).
				if (checkboxValue(classForLock, PROP_CLASS_CART_RUNNING)) {
					await setClassCartStatus(pageId, "완료")
					return new Response(
						JSON.stringify({ ok: true, message: "recovered_already_completed", pageId, route }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					)
				}
				return new Response(JSON.stringify({ ok: true, message: "already_completed", pageId, route }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
			}

			// 아직 누락이 있다: 체크박스가 켜져 있어도(진짜 처리 중이든 멈춘 것이든) 거부하지 않고
			// 안전하게 새로 이어서 진행한다 -- ensureCartForRegistration은 이미 카트가 있는 학생은
			// 건드리지 않는 멱등 작업이라 중복 생성 위험이 없다.
			await setClassCartStatus(pageId, "처리중")

			// 대상 등록 목록은 대기열에 쉬는 동안 바뀔 수 있으니, 워커가 실행 시점에 다시 조회한다
			// (processFromClassCartsQueueItem 참고) -- 여기서 이미 계산한 activeRegistrations는
			// 잠금 판단에만 쓰고, payload에는 classId만 넘긴다.
			await enqueueSync("sync-textbook-distribution:from-class-carts", { classId: pageId })
			wakeSyncQueueWorker()

			return respondAccepted({ pageId, route })
		} else {
			return new Response(JSON.stringify({ error: `알 수 없는 경로: ${route}` }), { status: 404 })
		}
	} catch (err) {
		console.error(err)
		return new Response(JSON.stringify({ error: String(err) }), { status: 400 })
	}
})
// sync-textbook-distribution
//
// 교재뱄 기능(로드맵 5-37): 진도교재 담기(교재배부 생성) + 필요 시 교재비(카트) 자동 생성.
// 결제(교재배부 "결재" 버튼 → 미납/결제완료 전환)는 기존 노션 자동화를 그대로 사용하야 이 함수는 건드리지 않는다.
//
// 담기 대상 판정 규식:
//   진도교재(학원) DB의 "진행상태"가 정확히 "진행 중"(실제로 지금 쓰고 있는 교재)인 것만 담는다.
//   - "다음 교재"는 아직 시작 전이며, 다음 학기에나 쓰게 될 수도 있는 "진짜 다음" 교재라 아직 청구하지 않는다.
//   - "완료"/"미사용"은 이미 지난 교재라 제외 (이미 예전에 배부(청구)됐을 가능성이 높음).
//   추가로, 이미 이 등록의 기존 교재배부에 실려 있는 정규교재는(재클릭 등으로) 중복으로 다시 담기지 않도록 별도로 거른다.
//
// 교재배부 1건 = 정규교재 1개. 새로 담을 정규교재가 여러 개이면, 한 번의 버튼 호출에서도
// 교재배부 페이지를 교재당 1건씩 여러 개 만든다 (교재비의 "정규교재" 관계는 1건만 가리킨다는 가정).
//
// (2026-09-16) 교재비(카트) 페이지를 새로 만들 때 "알림톡 설정" 관계(표시 전용)도 함께 채운다.
// send-textbook-notice는 여전히 발송 시점에 "발송 구분" 문자열로 알림톡 설정 DB를 조회하므로,
// 실제 발송 동작에는 영향이 없다 -- Notion 화면에서 이 카트가 어떤 발송 설정과 연결되는지
// 직관적으로 보이도록 하기 위한 것뿐이다 (조회 실패 시 조용히 건너뜀).
//
// (2026-09-17) 이전에는 클래스(학원) DB "교재 일괄 배부" 버튼으로 반 전체 활성 등록을 한 번에
// 처리하는 일괄 생성 경로(from-class)도 함께 제공했었다. 하지만 여러 차례(1~7차) 동시성/조회
// 구조를 수정해도 "교재배부 처리중" 체크박스가 간헐적으로 자동 해제되지 않는 문제가 반복 재현됐고,
// 근본 원인이 "학생 수만큼 학생별 Notion API 호출을 한 배치 실행 안에서 처리해야 하는" 구조적
// 한계로 파악되어, 반 전체 일괄 생성/배포 기능 자체를 포기했었다.
//
// (2026-09-17, 같은 날 재도입) 다만 반 전체 "교재비" 일괄 생성만 다시 필요해졌다. 위에서 포기한
// from-class는 학생 1명당 진도교재 조회 + 기존 교재배부 조회 + 교재배부 페이지 생성(여러 건)까지
// 묶어서 처리했기 때문에 학생 수에 비례해 호출 부담이 커졌던 것이 문제였다. 아래 from-class-carts는
// 그 무거운 배부(청구) 단계를 전혀 하지 않고, 학생별로 "교재비 페이지가 없으면 1건만 생성"하는
// 단순 작업만 반복한다 -- 학생 수만큼 늘어나는 건 맞지만 각 건이 가벼운 단일 페이지 생성 정도라 같은
// 구조적 한계에 해당하지 않는다고 판단했다. 실제 교재 배부(청구)는 여전히 교재비 페이지의
// "진도교재 담기" 버튼(from-cart)으로 학생별로 개별 진행한다.
//
// (2026-09-17, 웹훅 주소 오류 수정) from-class-carts가 계속 실패했던 진짜 원인은 코드가 아니라
// 이 함수를 가리키는 웹훅 URL에 잘못된 Supabase 프로젝트 참조가 쓰여 있었던 것이었다 (DNS 자체가
// 실패). 웹훅 URL을 올바른 프로젝트 주소로 수정한 뒤에는 요청이 정상적으로 이 함수까지 도달한다.
//
// (2026-09-17, 체크박스 고착 수정 1차) 웹훅 주소를 고친 뒤에도, 실제로는 카트 생성이 전부 성공했는데
// ("교재비 생성 여부" 수식이 "완료"로 표시됨) 마지막에 "교재비 생성중" 체크박스를 다시 꺼주는
// 쓰기 한 번만 조용히 실패해서 체크박스가 영원히 켜진 채로 남는 사례가 실제로 발생했다 (고2 A반).
// 이 체크박스가 켜져 있으면 재클릭도 막혀 있어서(아래 already_processing 분기) 사용자가 스스로
// 풀 방법이 없었다. 아래에서 이 잠금 분기를 무조건 거부가 아니라 "실제 데이터로 다시 계산해서
// 판단"하도록 바꿔서, 이미 다 끝나 있었으면 고착된 체크박스만 정리하고, 아직 누락이 있으면(진짜
// 처리 중이든 멈춘 것이든) 안전하게 새로 이어서 진행하게 했다.
//
// (2026-09-17, 체크박스 고착 수정 2차) 1차 수정 이후에도 다른 반(고1 A반, 고2 B반)에서 같은 현상이
// 새로 발생했다. generate-tuition/generate-report(사용자가 "체크박스가 금방금방 잘 꺼진다"고 지목한
// 다른 두 함수)와 나란히 비교해서, 등록 처리 동시성(mapWithConcurrency)을 없애고 순차(for 루프)로
// 통일했다 -- Notion API 레이트리밋 위험을 줄이는 유효한 개선이라 그대로 유지하지만, 아래 3차에서
// 확인했듯 체크박스 고착의 진짜 원인은 아니었다.
//
// (2026-09-17, 체크박스 고착 수정 3차 -- 진짜 근본 원인) 실제 Supabase 함수 로그를 확인해서 마지막
// 원인을 찾았다: 매번 아래와 같은 오류로 마지막 쓰기가 조용히 실패하고 있었다.
//   "마지막 동기화 is not a property that exists."
// setClassCartStatus가 (등록 DB 전용으로 설계된) makeSyncStatusSetter를 그대로 썼는데, 그 헬퍼는
// 항상 "마지막 동기화" 속성도 함께 쓰려고 시도한다. 그런데 클래스(학원) DB에는 그 속성 자체가 없다.
// Notion API는 요청에 포함된 속성 중 하나라도 존재하지 않으면 PATCH 요청 전체를 400으로 거부하므로,
// 같은 요청에 함께 실려 있던 체크박스 끄기(checkbox: false)까지 통째로 실패해버린 것이다 -- 동시성이나
// 타임아웃과는 무관하게, 성공/실패 여부와 상관없이 100% 매번 이 마지막 쓰기가 실패하고 있었다.
// generate-tuition/generate-report가 쓰는 makeClassStatusSetter(_shared/generateShared.ts)는 애초에
// "마지막 동기화"를 쓰지 않도록 만들어져 있어서 이 문제가 전혀 없었다 -- 그래서 그 두 함수만 체크박스가
// 금방금방 잘 꺼졌던 것. 아래에서 setClassCartStatus도 같은 헬퍼(makeClassStatusSetter)로 바꿔서
// 근본 원인을 제거한다. (교재비 DB 쪽 setCartStatus는 그대로 둔다 -- 교재비(학원) DB에는 "마지막
// 동기화" 속성이 실제로 존재하므로 makeSyncStatusSetter를 쓰는 것이 맞다.)
//
// (2026-09-18, 큐 기반 순차 처리 도입, Phase 2) 실제 담기/생성 로직(ensureCartForRegistration,
// distributeForRegistration, getActiveRegistrationsForCarts, setCartStatus, setClassCartStatus)은
// _shared/textbookDistributionTarget.ts로 옮겼다. 이 파일은 이제 웹훅 payload 파싱 + 사전 잠금
// 확인 + sync_queue에 작업 적재까지만 담당하고, 실제 무거운 작업은 process-sync-queue 워커가
// 순차적으로(다른 웹훅 요청과 뒤섞이지 않고) 처리한다. 기존에 배치 작업이 응답 없이 멈추는 경우를
// 대비해 두었던 runWithSafetyTimeout/BATCH_TIMEOUT_MS 안전장치는 더 이상 필요하지 않아 제거했다 --
// 큐에 적재된 작업은 sync_queue 행에 영속적으로 남아있어서, 함수 실행이 중단돼도 다음 워커 실행에서
// 이어서 처리되기 때문이다.
//
// (2026-09-20, 웹훅 코드 정리 3단계) from-cart 라우트의 "잠금 확인 -> 처리중 표시 -> 큐 적재 -> 202
// 응답" 부분만 _shared/webhookIngest.ts의 runLockedQueueWebhookForPage로 옮겼다. from-class-carts
// 라우트는 실행 전에 실제 데이터(활성 등록 중 교재비 누락 여부)부터 계산해서 즉시완료/이어서진행을
// 판단하는 고유 로직이 있어 공용 헬퍼로 단순화하지 않고 그대로 뒀다.
//
// 라우트:
//   POST /sync-textbook-distribution/from-cart         <- 교재비(학원) DB "진도교재 담기" 버튼 (학생 1명, 담기까지 수행)
//   POST /sync-textbook-distribution/from-class-carts   <- 클래스(학원) DB "교재비 생성" 버튼 (반 전체, 교재비 페이지만 일괄 생성 - 교재 배부는 하지 않음)

import { getPage, createPage, extractPageId, checkboxValue, relationIds } from "../_shared/notionClient.ts"
import { respondAccepted } from "../_shared/backgroundTask.ts"
import { enqueueSync, wakeSyncQueueWorker } from "../_shared/syncQueue.ts"
import { runLockedQueueWebhookForPage } from "../_shared/webhookIngest.ts"
import {
	PROP_CART_RUNNING,
	PROP_CLASS_CART_RUNNING,
	setCartStatus,
	setClassCartStatus,
	getActiveRegistrationsForCarts,
} from "../_shared/textbookDistributionTarget.ts"

// 등록(학원) DB 속성: from-class-carts 사전 확인(활성 등록 중 교재비 누락 여부 판정)에서만 쓴다.
const PROP_REGISTRATION_CART = "교재비" // relation -> 교재비(학원) DB

// [TEMP DEBUG] from-class-carts 실패 원인 진단용 임시 로그 DB ("🔧 웹훅 디버그 로그 (임시)", 교재비 관리
// 페이지 하위). 민감 정보가 아니라 데이타소스 ID를 그대로 하드코딩한다. 원인 파악(웹훅 주소 오류로 확인됨) 후
// 정리 예정 -- 당장 동작에는 영향 없으므로 이번 수정에서는 그대로 둔다.
const DATA_SOURCE_DEBUG_LOG = "65bd92de36864b57be320cb4b8b5a3c8"

// [TEMP DEBUG] 실제로 들어온 요샕을 노션의 임시 로그 DB에 기록한다 (fire-and-forget, 절대 메인 응답을
// 막거나 실패시키지 않음). 원인 파악(웹훅 주소 오류로 확인됨) 후 정리 예정.
async function logDebugWebhookCall(
	route: string | undefined,
	method: string,
	rawBody: string,
	pageId: string | null,
): Promise<void> {
	try {
		const nowIso = new Date().toISOString()
		await createPage(DATA_SOURCE_DEBUG_LOG, {
			["이름"]: { title: [{ text: { content: `${nowIso} ${route ?? "(no route)"}` } }] },
			["라우트"]: { rich_text: [{ text: { content: route ?? "" } }] },
			["메소드"]: { rich_text: [{ text: { content: method } }] },
			["pageId 추출 결과"]: { rich_text: [{ text: { content: pageId ?? "(추출 실패 - null)" } }] },
			["원본 바디"]: { rich_text: [{ text: { content: rawBody.slice(0, 1900) } }] },
			["수신시각(KST)"]: { rich_text: [{ text: { content: nowIso } }] },
		})
	} catch (err) {
		console.error("[sync-textbook-distribution] (debug) logDebugWebhookCall 실패:", err)
	}
}

Deno.serve(async (req: Request) => {
	const url = new URL(req.url)
	// [TEMP DEBUG 수정] 쉐랑시(trailing slash)가 붙어오면 기존 split("/").pop()은 빈 문자열을 맞럈 -
	// filter(Boolean)으로 빈 조각을 거륩내서 언제도 뜻바릑이 담기가 정확히 잡히도록 한다.
	const route = url.pathname.split("/").filter(Boolean).pop()
	const rawBodyText = await req.text()
	let body: unknown = {}
	try {
		body = rawBodyText ? JSON.parse(rawBodyText) : {}
	} catch {
		// 빈 바디 허용하지 않음 - 아래에서 pageId 누락으로 에러 처리
	}
	console.log("sync-textbook-distribution payload:", route, JSON.stringify(body))

	const pageId = extractPageId(body)

	// [TEMP DEBUG 수정] 이전에는 route === "from-class-carts"일 떄만 로그를 둘얈다. 그런데 실제로는
	// 로그가 0건이었다 - route가 기대한 것과 다르게 들어온 것일 수도 있다도 보기 위해, route가 뭐땜대
	// 상관없이 모든 요샕을 대상으로 무조거 남겨 범위를 늘마다 (fire-and-forget, 응답에는 영향 없음).
	logDebugWebhookCall(route, req.method, rawBodyText, pageId).catch(() => {})

	if (!pageId) {
		return new Response(JSON.stringify({ error: "pageId를 찾을 수 없음" }), { status: 400 })
	}

	try {
		if (route === "from-cart") {
			// 교재비 페이지 자신이 클릭 대상.
			return await runLockedQueueWebhookForPage(pageId, {
				functionName: "sync-textbook-distribution:from-cart",
				lockProp: PROP_CART_RUNNING,
				target: "sync-textbook-distribution:from-cart",
				setStatus: setCartStatus,
				buildPayload: (id) => ({ cartId: id }),
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

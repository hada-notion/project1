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
//
// (2026-10-04, PART N-11: 클래스 "교재 생성" 순차 이어달리기 재설계) PART N-8의 create-class는
// runSyncWebhookForPage -> createBooksForClass로 등록 여러 건을 동시에(concurrency 4) 처리했다.
// 그룹 진도 모드는 반별교재(템플릿) 하나를 반 전체 등록이 공유하는데, 그 템플릿의 "등록" relation을
// 읽고-고치고-다시 쓰는(read-modify-write) 과정이 원자적이지 않아서 등록끼리 동시에 같은 템플릿을
// 건드리면 경쟁(race)이 생겨 일부 등록의 연결이 조용히 유실됐다 (실제로 "고1 A" 클래스에서 6명 x
// 템플릿 4개 = 24쌍 중 일부가 빠지거나 단방향으로만 연결되는 현상으로 재현/확인됨 -- 자세한 설명은
// _shared/registrationTextbookTarget.ts의 PART N-11 주석 참고). 여기서는 send-selected-notifications
// (알림톡 발송함 "일괄 전송")와 같은 "고정 청크(등록 1건) + 자기 호출 이어달리기" 패턴으로 create-class
// 라우트를 다시 짰다 -- 등록을 절대 동시에 처리하지 않아 경쟁이 구조적으로 사라지고, 등록 1건마다
// 등록(학원) DB의 "교재 상태"를 markRunning/markDone/markError로 갱신해 실시간 진행 상황도 보인다
// (사용자 요청 2번째 항목). 체인 안에서 한 번 시도한 등록은(성공/실패 불문) 같은 체인에서 다시
// 시도하지 않는다(accAttemptedIds) -- 그래야 데이터 문제로 항상 실패하는 등록이 하나 있어도 그
// 등록만 반복 재시도하며 체인 전체(30분 한도)를 붙잡아 다른 등록들의 처리를 막는 일이 없다. 이미
// "완료"로 표시된 등록은 getPendingClassTextbookRegistrations가 애초에 대상에서 뺀다 -- 다음에
// 버튼을 다시 누르면 그때는 완료된 학생은 건너뛰고 실패했던 학생만 자연스럽게 재시도된다.

import { extractPageId, getPage } from "../_shared/notionClient.ts"
import {
	TEXTBOOK_STATUS_SPEC,
	cleanupUnusedBooksOnEnd,
	createIndividualBooksForRegistration,
	CLASS_TEXTBOOK_STATUS_SPEC,
	getPendingClassTextbookRegistrations,
	createBooksForOneRegistrationWithStatus,
} from "../_shared/registrationTextbookTarget.ts"
import { runSyncWebhookForPage } from "../_shared/webhookIngest.ts"
import { resolveAdminKeyFromRequest, getCurrentAdminKey } from "../_shared/adminShared.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"
import { isRunning, markRunning, markDone, markError } from "../_shared/statusTracking.ts"

async function processPage(pageId: string): Promise<void> {
	const result = await createIndividualBooksForRegistration(pageId)
	console.log("[sync-registration-textbook] create-individual finished:", pageId, result)
}

// (PART N-11) 클래스 "교재 생성" 이어달리기가 자기 자신을 다시 호출할 때 붙이는 표시. true면
// 사용자가 새로 누른 게 아니라 체인의 다음 한 건임을 뜻한다 (중복 실행 검사를 건너뛰고, 누적
// 진행 상황을 body로 이어받는다). send-selected-notifications와 동일한 이름을 그대로 맞췄다.
const CONTINUATION_FLAG = "isContinuation"
// 체인 전체(여러 번의 이어달리기 합산) 시간 한도. 극단적으로 대량이거나 뭔가 잘못돼 계속
// 이어지는 경우의 최후 안전장치 -- send-selected-notifications와 동일한 값.
const CLASS_TEXTBOOK_TOTAL_CHAIN_BUDGET_MS = 30 * 60 * 1000
// 자기 자신을 호출하는 fetch에 타임아웃이 없으면, 그 fetch 하나가 응답 없이 멈출 때 체인 전체가
// 영원히 멈출 수 있다. send-selected-notifications와 동일하게 60초 제한을 건다.
const FETCH_TIMEOUT_MS = 60_000
// 이식성 정리 - 다른 함수들과 동일하게 SB_URL 환경변수로 조립한다 (특정 프로젝트 URL 하드코딩 없음).
const FUNCTIONS_BASE = `${Deno.env.get("SB_URL") ?? ""}/functions/v1`

function nowKstLabel(): string {
	const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
	return `${kst.toISOString().slice(0, 10)} ${String(kst.getUTCHours()).padStart(2, "0")}:${String(kst.getUTCMinutes()).padStart(2, "0")}`
}

async function callSelfForNextHop(body: Record<string, unknown>, adminKey: string): Promise<Response> {
	const controller = new AbortController()
	const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
	try {
		return await fetch(`${FUNCTIONS_BASE}/sync-registration-textbook/create-class`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
			body: JSON.stringify(body),
			signal: controller.signal,
		})
	} finally {
		clearTimeout(timeoutId)
	}
}

// 처리 종료(성공/실패)를 한 번에 기록한다. message가 있으면 "⚠️ 오류"로, 없으면 "✅ 완료"로 남긴다.
async function finishClassBatch(classId: string, message: string | null): Promise<void> {
	try {
		if (message) {
			await markError(classId, CLASS_TEXTBOOK_STATUS_SPEC, message)
		} else {
			await markDone(classId, CLASS_TEXTBOOK_STATUS_SPEC)
		}
	} catch (err) {
		console.error("[sync-registration-textbook] 클래스 교재 생성 상태 기록 실패:", classId, (err as Error).message)
	}
}

// 실패 이력을 이름(사유) 형태로 최대 maxShown건까지 나열한 완료 메시지를 만든다. 실패가 하나도
// 없으면 null(=성공)을 돌려준다.
function buildClassFinalMessage(success: number, failed: number, failureDetails: string[]): string | null {
	if (failed === 0) return null
	const maxShown = 15
	const shown = failureDetails.slice(0, maxShown)
	const more = failureDetails.length > maxShown ? ` 외 ${failureDetails.length - maxShown}건` : ""
	return `${nowKstLabel()} - 완료: 성공 ${success}건, 실패 ${failed}건. 실패: ${shown.join(", ")}${more}`
}

// (PART N-11) 클래스(학원) DB "교재 생성" 버튼의 실제 처리 전체. 등록 1건씩만 처리하고(동시 처리
// 없음, _shared/registrationTextbookTarget.ts의 PART N-11 주석 참고), 아직 더 처리할 등록이
// 남아있으면 자기 자신을 다시 호출해서 이어간다. 매 호출은 자기 자신의 202 응답만 기다리므로
// (실제 처리는 그 다음 호출 자신의 백그라운드에서 진행) 호출이 쌓이지 않는다.
async function handleCreateClassRequest(body: Record<string, unknown>, adminKey: string): Promise<Response> {
	const classId = extractPageId(body)
	if (!classId) {
		return new Response(JSON.stringify({ error: "pageId를 찾을 수 없음" }), { status: 400 })
	}

	const isContinuation = body?.[CONTINUATION_FLAG] === true
	let chainStartedAt: number
	let accSuccess: number
	let accFailed: number
	let accFailureDetails: string[]
	let accAttemptedIds: string[]

	if (isContinuation) {
		// 이어달리기 호출은 사용자가 새로 누른 게 아니라 이 함수가 스스로 만든 요청이므로, 중복
		// 실행 검사(isRunning) 없이 바로 진행한다. 필요한 정보는 모두 body로 이어받는다.
		chainStartedAt = typeof body?.chainStartedAt === "number" ? (body.chainStartedAt as number) : Date.now()
		accSuccess = typeof body?.accSuccess === "number" ? (body.accSuccess as number) : 0
		accFailed = typeof body?.accFailed === "number" ? (body.accFailed as number) : 0
		accFailureDetails = Array.isArray(body?.accFailureDetails) ? (body.accFailureDetails as string[]) : []
		accAttemptedIds = Array.isArray(body?.accAttemptedIds) ? (body.accAttemptedIds as string[]) : []
	} else {
		let classPage: any
		try {
			classPage = await getPage(classId)
		} catch (err) {
			return new Response(
				JSON.stringify({ error: `클래스 페이지를 불러오지 못함: ${(err as Error).message}` }),
				{ status: 500 },
			)
		}
		if (isRunning(classPage, CLASS_TEXTBOOK_STATUS_SPEC)) {
			return new Response(JSON.stringify({ ok: true, message: "already_processing", classId }), { status: 200 })
		}
		chainStartedAt = Date.now()
		accSuccess = 0
		accFailed = 0
		accFailureDetails = []
		accAttemptedIds = []
	}

	// 매 홉(최초 실행 + 모든 이어달리기)마다 "처리 시작 시각"을 새로고침한다. 워치독(status-watchdog)
	// 은 이 값이 15분 넘게 오래됐으면 "타임아웃 복구"로 되돌리는데, 체인 전체는 최대 30분까지
	// 이어질 수 있으므로 매 홉마다 갱신해야 실제로는 계속 정상 진행 중인 배치를 죽은 것으로
	// 착각하지 않는다 (send-selected-notifications와 동일한 이유).
	await markRunning(classId, CLASS_TEXTBOOK_STATUS_SPEC)

	runInBackground(async () => {
		try {
			const pendingAll = await getPendingClassTextbookRegistrations(classId)
			const candidates = pendingAll.filter((r: any) => !accAttemptedIds.includes(r.id))

			if (candidates.length === 0) {
				// 남은 대상이 전혀 없거나(전부 완료), 남은 건 전부 이번 체인에서 이미 한 번씩 시도해본
				// 건(계속 재시도하면 체인 시간만 소모) -- 두 경우 모두 여기서 체인을 끝낸다.
				await finishClassBatch(classId, buildClassFinalMessage(accSuccess, accFailed, accFailureDetails))
				return
			}

			const target = candidates[0]
			const result = await createBooksForOneRegistrationWithStatus(target)
			const newAccSuccess = accSuccess + (result.ok ? 1 : 0)
			const newAccFailed = accFailed + (result.ok ? 0 : 1)
			const newAccFailureDetails = result.ok ? accFailureDetails : [...accFailureDetails, `${result.label}(${result.note})`]
			const newAccAttemptedIds = [...accAttemptedIds, target.id]

			console.log(
				"[sync-registration-textbook] create-class 1건 처리:",
				classId,
				result.label,
				result.ok ? "성공" : "실패",
				`(누적 성공 ${newAccSuccess}, 실패 ${newAccFailed}, 이번 체인에서 남은 ${candidates.length - 1}건)`,
			)

			if (candidates.length <= 1) {
				await finishClassBatch(classId, buildClassFinalMessage(newAccSuccess, newAccFailed, newAccFailureDetails))
				return
			}

			const elapsedChain = Date.now() - chainStartedAt
			if (elapsedChain > CLASS_TEXTBOOK_TOTAL_CHAIN_BUDGET_MS) {
				await finishClassBatch(
					classId,
					`${nowKstLabel()} - 전체 처리 한도(${Math.round(CLASS_TEXTBOOK_TOTAL_CHAIN_BUDGET_MS / 60000)}분) 초과로 중단됨. 지금까지 성공 ${newAccSuccess}건, 실패 ${newAccFailed}건. "교재 생성"을 다시 눌러 이어서 진행하세요.`,
				)
				return
			}

			// 아직 처리할 등록이 남았고 체인 한도도 안 넘었으면, 자기 자신을 다시 호출해 다음 한 건을
			// 이어서 처리한다. 이 fetch는 호출된 쪽의 빠른 202 응답까지만 기다린다.
			const continueRes = await callSelfForNextHop(
				{
					pageId: classId,
					adminKey,
					[CONTINUATION_FLAG]: true,
					chainStartedAt,
					accSuccess: newAccSuccess,
					accFailed: newAccFailed,
					accFailureDetails: newAccFailureDetails,
					accAttemptedIds: newAccAttemptedIds,
				},
				adminKey,
			)
			if (!continueRes.ok) {
				const text = await continueRes.text().catch(() => "")
				throw new Error(`다음 이어달리기 호출 실패: ${continueRes.status} ${text}`)
			}
		} catch (err) {
			console.error(
				"[sync-registration-textbook] create-class failed:",
				classId,
				(err as Error).message,
				(err as Error).stack,
			)
			await finishClassBatch(classId, `${nowKstLabel()} - 오류: ${(err as Error).message}`)
		}
	})

	return respondAccepted({ classId, isContinuation })
}

Deno.serve(async (req: Request) => {
	const url = new URL(req.url)
	const route = url.pathname.split("/").pop()
	let body: any = {}
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

	try {
		if (route === "create-class") {
			// 클래스(학원) DB "교재 생성" 버튼 -- 클릭 대상(pageId)이 클래스 페이지 자신이다. 이 라우트는
			// 자기 호출 이어달리기(continuation) 요청도 받으므로, 다른 라우트와 달리 pageId 추출/검증을
			// 핸들러 내부(handleCreateClassRequest)에서 처리한다.
			return await handleCreateClassRequest(body, adminKey)
		}

		const pageId = extractPageId(body)
		if (!pageId) {
			return new Response(JSON.stringify({ error: "pageId를 찾을 수 없음" }), { status: 400 })
		}

		if (route === "create-individual") {
			return await runSyncWebhookForPage(pageId, {
				functionName: "sync-registration-textbook",
				statusSpec: TEXTBOOK_STATUS_SPEC,
				process: processPage,
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

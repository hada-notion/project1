// Supabase Edge Function: send-selected-notifications
//
// (2026-09-16) "알림톡 설정(학원) DB"의 '선택 일괄전송' 버튼 대신, "알림톡 발송함(학원) DB"
// 페이지("알림톡 발송함") 하나의 '일괄 전송' 버튼이 이 함수를 호출한다 (자동화 연결: 이 버튼에
// "웹훅 보내기" 액션 추가 필요 -- 아직 연결 전).
// 클릭된 발송함 페이지의 "구분"(주간 보고서/월간 보고서/수강료)에 따라 대상 DB(보고서/수강료)를
// 정하고, 그 DB에서 "알림톡 발송함" 관계가 이 발송함을 가리키면서 "일괄전송 선택" 체크박스가 켜진 건만
// 골라서 각각 send-report / send-tuition-notice를 호출해 알림톡을 발송한다. 발송에 성공하면
// 체크박스를 자동으로 끄고, 실패하면 다시 시도할 수 있도록 체크박스를 켜진 채로 둔다.
//
// 아래는 이전(알림톡 설정 DB 기반) 버전에서 그대로 가져온 안전장치들이다 (배치 구조 변경과
// 무관하게 계속 유효하다):
// - "발송자"는 실제 클릭한 사람이 아니라 발송함의 "실행자"를 함께 전달해서 기록한다.
// - 서로 다른 발송함을 거의 동시에 "일괄 전송"해도 실제 처리는 전역 잠금으로 한 번에 하나씩만
//   순차 진행한다 (Notion API 레이트리밋 보호). Deno KV를 쓸 수 있으면 그걸, 아니면 메모리 기반
//   잠금(같은 함수 인스턴스 내에서만 유효)으로 자동 대체한다.
// - 처리 건수가 많아 Edge Function 실행시간 제한에 걸릴 것 같으면 스스로 먼저 멈추고 지금까지
//   결과를 정확히 기록한다. 못 보낸 나머지는 체크가 그대로 켜져 있으므로 다음 "일괄 전송" 클릭에서
//   자동으로 이어서 처리된다.

import {
	getPage,
	updatePageProperties,
	queryAllPages,
	extractPageId,
} from "../_shared/notionClient.ts"
import { getCurrentAdminKey, resolveAdminKeyFromRequest } from "../_shared/adminShared.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"
import { SYNC_WAIT_FLAG } from "../_shared/alimtalkShared.ts"
import { DS_REPORT, DS_TUITION, PROP_NOTIFICATION_BATCH_RELATION, PROP_BATCH_TYPE } from "../_shared/generateShared.ts"
import { isRunning, markRunning, markDone, markError, type StatusSpec } from "../_shared/statusTracking.ts"

// (이식성 정리) 다른 파일들과 동일하게 SB_URL 환경변수로 조립한다. 특정 프로젝트 URL을 하드코딩하지 않는다.
const FUNCTIONS_BASE = `${Deno.env.get("SB_URL") ?? ""}/functions/v1`

const corsHeaders = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
	"Access-Control-Allow-Methods": "POST, OPTIONS",
}

const PROP_BATCH_LAST_ERROR = "마지막 오류" // 알림톡 발송함(학원) DB - "실시간 처리 상태" 수식이 이 값을 읽는다.
const PROP_BATCH_EXECUTOR = "실행자" // 알림톡 발송함(학원) DB
const PROP_BULK_SELECT = "일괄전송 선택" // 보고서(학원) DB / 수강료(학원) DB
// "구분"/발송함 relation 속성명은 generate-report, generate-tuition과 공유하므로
// _shared/generateShared.ts의 PROP_BATCH_TYPE / PROP_NOTIFICATION_BATCH_RELATION을 그대로
// 쓴다 (2026-09-16, 속성명 중복 하드코딩 정리).

// (2026-09-22, 처리 상태 관리 리팩토링 Phase 3) 기존 "일괄전송중" checkbox(설명에는 "send-report
// Edge Function이 처리 중"이라고 적혀 있었으나, 실제로 이 속성을 쓰고 읽는 함수는 이 파일
// send-selected-notifications이다 -- send-report/send-tuition-notice는 이 함수가 대상 건별로
// 호출하는 실제 발송 함수일 뿐, 발송함 페이지의 상태 속성은 건드리지 않는다. 체크리스트에 남아있던
// "연결 함수 불일치" 의심은 여기서 해소됨) + "마지막 오류" 조합을 "상태"(select) +
// "처리 시작 시각"(date)로 전환. 이 DB엔 다른 상태 플래그가 없어서(시간표/메뉴/시험범위 DB와 같은
// 단일 플래그 케이스) 접두어 없는 범용 이름 "상태"를 그대로 썼다. 마스터플랜 참고.
const BULK_SEND_STATUS_SPEC: StatusSpec = {
	statusProp: "상태",
	errorProp: PROP_BATCH_LAST_ERROR,
	startedAtProp: "처리 시작 시각",
}

async function callFn(path: string, body: Record<string, unknown>, adminKey: string): Promise<Response> {
	return fetch(`${FUNCTIONS_BASE}/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
		body: JSON.stringify(body),
	})
}

function nowKstLabel(): string {
	const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
	return `${kst.toISOString().slice(0, 10)} ${String(kst.getUTCHours()).padStart(2, "0")}:${String(kst.getUTCMinutes()).padStart(2, "0")}`
}

// 처리 종료(성공/실패)를 한 번에 기록한다. message가 있으면 "⚠️ 오류"로, 없으면 "✅ 완료"로 남긴다.
// 인증 실패/발송함 로드 실패처럼 markRunning을 거치지 않은 채 바로 실패하는 경로에서도 그대로
// 쓸 수 있다 (markError는 이전 상태와 무관하게 상태를 덮어쓴다). 기록 자체가 실패해도 원래 응답에는
// 영향을 주지 않는다.
async function finishBatch(batchId: string, message: string | null): Promise<void> {
	try {
		if (message) {
			await markError(batchId, BULK_SEND_STATUS_SPEC, message)
		} else {
			await markDone(batchId, BULK_SEND_STATUS_SPEC)
		}
	} catch (err) {
		console.error("발송함 상태 기록 실패:", batchId, (err as Error).message)
	}
}

// 서로 다른 발송함이라도 실제 발송 처리는 한 번에 하나씩만 진행되도록 하는 전역 잠금.
// Deno KV를 쓸 수 있으면(versionstamp가 null일 때만 set이 성공하는 원자적 연산으로, 먼저 온 쪽이
// 선점) 그걸 쓰고, KV를 쓸 수 없는 환경이면(이 프로젝트가 그렇다) 같은 함수 인스턴스 안에서만
// 유효한 메모리 기반 잠금(대기열)으로 자동 대체한다.
const GLOBAL_LOCK_KEY = ["send_selected_notifications_lock"]
const LOCK_TTL_MS = 5 * 60 * 1000 // 5분 - 처리 하나가 이보다 오래 걸리면 잠금이 자동 해제된다 (안전장치).
const LOCK_WAIT_TIMEOUT_MS = 10 * 60 * 1000 // 10분 넘게 기다리면 포기하고 실패로 기록한다.
const LOCK_POLL_INTERVAL_MS = 2000
// 대상 건수가 많아 Edge Function 실행 시간 제한에 걸릴 것 같으면, 중간에 강제로 끊기는 대신
// 스스로 먼저 멈춰서 지금까지 결과를 정확히 기록하고 잠금을 정상적으로 반환한다.
// [FIX, 2026-09-23] 이전 값(3분/180초)이 Supabase Edge Function의 실제 플랫폼 실행시간 한도인
// 150초(WallClockTime)보다 길어서, 이 자체 안전장치가 작동하기도 전에 플랫폼이 먼저 함수를 강제
// 종료시켰다 (Supabase 로그에서 "reason": "WallClockTime"으로 두 번 확인됨 — 처리 시작 후 정확히
// 150초 뒤 종료). 그 결과 "완료"/"오류" 상태 기록도, 에러 로그도 전혀 남기지 못한 채 배치의
// "상태"가 "🔄 작업중"에 영원히 멈춰버렸고(15분 뒤 워치독이 회수하기 전까지 재클릭도 무의미했음),
// 사용자에게는 "일괄 전송이 중간에 멈췄다"로 보였다. 150초보다 충분히 여유 있게 90초로 낮춰서,
// 플랫폼이 강제 종료하기 전에 항상 스스로 먼저 멈추고 정상적으로 finishBatch()까지 도달하도록 한다.
const PROCESSING_TIME_BUDGET_MS = 90 * 1000

// deno-lint-ignore no-explicit-any
type AnyKv = any
// undefined = 아직 확인 안 함, null = 이 환경에서 KV 사용 불가.
let kvInstance: AnyKv | null | undefined = undefined
async function getKvSafe(): Promise<AnyKv | null> {
	if (kvInstance !== undefined) return kvInstance
	try {
		kvInstance = await (Deno as AnyKv).openKv()
	} catch (_e) {
		kvInstance = null
	}
	return kvInstance
}

// KV를 못 쓰는 환경을 위한 메모리 기반 잠금(같은 함수 인스턴스 안에서만 유효).
class InMemoryMutex {
	private locked = false
	private queue: Array<() => void> = []
	acquire(): Promise<{ waited: boolean }> {
		if (!this.locked) {
			this.locked = true
			return Promise.resolve({ waited: false })
		}
		return new Promise((resolve) => {
			this.queue.push(() => resolve({ waited: true }))
		})
	}
	release(): void {
		const next = this.queue.shift()
		if (next) next()
		else this.locked = false
	}
}
const inMemoryLock = new InMemoryMutex()

async function acquireGlobalLock(): Promise<{ waited: boolean; usingKv: boolean }> {
	const kv = await getKvSafe()
	if (!kv) {
		const { waited } = await inMemoryLock.acquire()
		return { waited, usingKv: false }
	}
	const startedAt = Date.now()
	let waited = false
	while (true) {
		const res = await kv
			.atomic()
			.check({ key: GLOBAL_LOCK_KEY, versionstamp: null })
			.set(GLOBAL_LOCK_KEY, { startedAt: Date.now() }, { expireIn: LOCK_TTL_MS })
			.commit()
		if (res.ok) return { waited, usingKv: true }
		waited = true
		if (Date.now() - startedAt > LOCK_WAIT_TIMEOUT_MS) {
			throw new Error("다른 일괄전송이 끝나기를 기다리다 시간 초과(10분)되었습니다. 잠시 후 다시 시도해주세요.")
		}
		await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS))
	}
}

async function releaseGlobalLock(usingKv: boolean): Promise<void> {
	if (!usingKv) {
		inMemoryLock.release()
		return
	}
	try {
		const kv = await getKvSafe()
		if (kv) await kv.delete(GLOBAL_LOCK_KEY)
	} catch (err) {
		console.error("전역 잠금 해제 실패:", (err as Error).message)
	}
}

async function processBatch(batchId: string, adminKey: string, log: string[]): Promise<{ failed: number }> {
	const batchPage = await getPage(batchId)
	const category = batchPage.properties?.[PROP_BATCH_TYPE]?.select?.name ?? ""
	// 발송함의 "실행자"를 send-report/send-tuition-notice가 기대하는 것과 같은 모양
	// (body.data.properties.실행자)으로 함께 전달해서, 전송로그의 "발송자"가 실제 클릭한 사람으로
	// 기록되게 한다.
	const executorUserId: string | null = batchPage.properties?.[PROP_BATCH_EXECUTOR]?.people?.[0]?.id ?? null

	let dataSourceId: string
	let idField: "reportId" | "tuitionId"
	let sendPath: string
	if (category === "수강료") {
		dataSourceId = DS_TUITION
		idField = "tuitionId"
		sendPath = "send-tuition-notice"
	} else if (category === "주간 보고서" || category === "월간 보고서") {
		dataSourceId = DS_REPORT
		idField = "reportId"
		sendPath = "send-report"
	} else {
		throw new Error(`이 발송함의 '구분'이 "주간 보고서" / "월간 보고서" / "수강료" 중 하나가 아닙니다 (현재 값: "${category || "없음"}").`)
	}

	const targets = await queryAllPages(dataSourceId, {
		and: [
			{ property: PROP_NOTIFICATION_BATCH_RELATION, relation: { contains: batchId } },
			{ property: PROP_BULK_SELECT, checkbox: { equals: true } },
		],
	})
	log.push(`[${category}] 일괄전송 선택된 건 ${targets.length}건`)

	const startedAt = Date.now()
	let success = 0
	let failed = 0
	let skippedByBudget = 0
	for (let i = 0; i < targets.length; i++) {
		if (Date.now() - startedAt > PROCESSING_TIME_BUDGET_MS) {
			skippedByBudget = targets.length - i
			log.push(
				`[${category}] 처리 시간 제한(${Math.round(PROCESSING_TIME_BUDGET_MS / 1000)}초)에 도달해 ${skippedByBudget}건은 이번 실행에서 처리하지 못함 (다음 "일괄 전송" 클릭에서 자동으로 이어서 처리됨)`,
			)
			break
		}
		const page: any = targets[i]
		try {
			const res = await callFn(
				sendPath,
				{
					[idField]: page.id,
					adminKey,
					// send-report/send-tuition-notice가 개별 버튼 클릭과 달리 이 호출은 끝까지 동기로
					// 기다려서 성공/실패(res.ok)를 그대로 돌려주도록 요청한다 (아래 processBatch 주석,
					// _shared/alimtalkShared.ts의 SYNC_WAIT_FLAG 설명 참고).
					[SYNC_WAIT_FLAG]: true,
					...(executorUserId
						? { data: { properties: { "실행자": { people: [{ id: executorUserId }] } } } }
						: {}),
				},
				adminKey,
			)
			if (res.ok) {
				success++
				await updatePageProperties(page.id, { [PROP_BULK_SELECT]: { checkbox: false } })
			} else {
				failed++
				const text = await res.text().catch(() => "")
				log.push(`[${category}] ${page.id} 발송 실패: ${res.status} ${text}`)
			}
		} catch (err) {
			failed++
			log.push(`[${category}] ${page.id} 오류: ${(err as Error).message}`)
		}
	}
	log.push(
		`[${category}] 완료: 성공 ${success}건, 실패 ${failed}건, 미처리 ${skippedByBudget}건 (총 ${targets.length}건)`,
	)
	return { failed: failed + skippedByBudget }
}

Deno.serve(async (req: Request) => {
	if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

	let body: unknown
	try {
		body = await req.json()
	} catch {
		body = undefined
	}

	// 페이지 id는 인증 여부와 무관하게 먼저 추출한다. 이후 401/잠금 확인 오류가 나도
	// 어떤 발송함에서 실패했는지 "마지막 오류"에 남길 수 있도록 하기 위해서다.
	const batchId = body ? extractPageId(body) : null
	if (!batchId) {
		return new Response(JSON.stringify({ ok: false, error: "발송함 페이지 id를 찾지 못함", rawBody: body }, null, 2), {
			status: 400,
			headers: { "Content-Type": "application/json", ...corsHeaders },
		})
	}

	const adminKey = resolveAdminKeyFromRequest(req, body as any)
	const currentAdminKey = await getCurrentAdminKey()
	if (!adminKey || adminKey !== currentAdminKey) {
		await finishBatch(batchId, `${nowKstLabel()} - 인증 실패: x-admin-key가 올바르지 않습니다. Notion 자동화의 웹훅 헤더와 현재 관리자 키가 일치하는지 확인하세요.`)
		return new Response(JSON.stringify({ error: "unauthorized" }), {
			status: 401,
			headers: { "Content-Type": "application/json", ...corsHeaders },
		})
	}

	// 이미 처리 중이면 중복 실행하지 않는다.
	let batchPageForLock
	try {
		batchPageForLock = await getPage(batchId)
	} catch (err) {
		await finishBatch(batchId, `${nowKstLabel()} - 발송함을 불러오지 못함: ${(err as Error).message}`)
		return new Response(JSON.stringify({ ok: false, error: `발송함을 불러오지 못함: ${(err as Error).message}` }, null, 2), {
			status: 500,
			headers: { "Content-Type": "application/json", ...corsHeaders },
		})
	}
	if (isRunning(batchPageForLock, BULK_SEND_STATUS_SPEC)) {
		return new Response(JSON.stringify({ ok: true, message: "already_processing", batchId }, null, 2), {
			status: 200,
			headers: { "Content-Type": "application/json", ...corsHeaders },
		})
	}

	const log: string[] = []
	// markRunning이 상태를 "🔄 작업중"으로 바꾸면서 이전 오류 메시지도 함께 지운다.
	await markRunning(batchId, BULK_SEND_STATUS_SPEC)

	runInBackground(async () => {
		let lockAcquired = false
		let lockUsingKv = false
		try {
			const { waited, usingKv } = await acquireGlobalLock()
			lockAcquired = true
			lockUsingKv = usingKv
			if (waited) {
				log.push("다른 발송함의 일괄전송이 끝날 때까지 기다린 뒤 순차적으로 처리를 시작합니다.")
			}
			const { failed } = await processBatch(batchId, adminKey, log)
			console.log("send-selected-notifications finished:", batchId, "\n", log.join("\n"))
			await finishBatch(batchId, failed > 0 ? `${nowKstLabel()} - ${log[log.length - 1] ?? ""}` : null)
		} catch (err) {
			console.error(
				"send-selected-notifications failed:",
				(err as Error).message,
				"\nlog so far:",
				log.join("\n"),
				"\nstack:",
				(err as Error).stack,
			)
			const message = `${nowKstLabel()} - 오류: ${(err as Error).message}`
			await finishBatch(batchId, message)
		} finally {
			if (lockAcquired) await releaseGlobalLock(lockUsingKv)
		}
	})

	return respondAccepted({ batchId })
})

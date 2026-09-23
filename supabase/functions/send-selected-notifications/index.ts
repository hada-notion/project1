// Supabase Edge Function: send-selected-notifications
//
// (2026-09-16) "알림톡 설정(학원) DB"의 '선택 일괄전송' 버튼 대신, "알림톡 발송함(학원) DB"
// 페이지("알림톡 발송함") 하나의 '일괄 전송' 버튼이 이 함수를 호출한다.
// 클릭된 발송함 페이지의 "구분"(주간 보고서/월간 보고서/수강료)에 따라 대상 DB(보고서/수강료)를
// 정하고, 그 DB에서 "알림톡 발송함" 관계가 이 발송함을 가리키면서 "일괄전송 선택" 체크박스가 켜진
// 건만 골라서 각각 send-report / send-tuition-notice를 호출해 알림톡을 발송한다.
//
// [PART N-8, 2026-09-23, 고정 청크 재설계] 예전에는 "시간 예산 안에서 되는 만큼" 방식이었는데,
// Supabase Edge Function의 실제 플랫폼 실행시간 한도(150초, WallClockTime)에 걸려 대량 배치가
// 중간에 멈추는 문제가 있었다. 이제는 Make.com의 "시나리오 전체 시간 한도 + 여러 짧은 모듈 실행을
// 체인으로 연결" 구조를 그대로 본떠서, 이 함수 스스로 아래처럼 동작한다:
//   1) 이름순으로 정렬해서 딱 CHUNK_SIZE(10)건만 골라 처리한다 (보조 안전장치로 ~100초가 넘으면
//      10건을 다 못 채웠어도 그 자리에서 청크를 끊는다 -- 150초 강제종료보다 항상 먼저 멈추기 위함).
//   2) 청크 처리 후에도 "일괄전송 선택"이 켜진 건이 남아있으면, 자기 자신을 다시 호출해 다음
//      청크를 이어서 처리한다 (자기 호출의 빠른 202 응답만 기다리고, 실제 처리는 그 다음 호출의
//      백그라운드에서 진행된다 -- 호출이 계속 쌓이지 않는다).
//   3) 전체 체인이 TOTAL_CHAIN_BUDGET_MS(30분)를 넘으면 스스로 멈추고 "한도 초과"로 기록한다
//      (극단적으로 대량이거나 뭔가 잘못돼 계속 이어지는 경우의 최후 안전장치).
//   4) 각 건은 성공/실패와 무관하게 1회 시도 후 "일괄전송 선택"이 해제된다(send-tuition-notice/
//      send-report가 처리 -- 아래 두 파일의 PART N-8 주석 참고). 실패해도 재시도를 위해 체크박스를
//      켜둔 채로 두던 예전 방식은, 데이터 문제(예: 연락처 누락)로 항상 실패하는 건이 있으면 매
//      이어달리기마다 똑같이 다시 걸려 무한 반복될 위험이 있어서 버렸다. 실패 이력은 전송로그
//      (자동화 로그)에 그대로 남고, 배치 완료 메시지에도 이름+사유를 나열해 사용자가 직접 확인
//      후 재처리(문제 해결 후 체크박스 재선택 또는 개별 버튼 재발송)할 수 있게 한다.
//
// 아래는 이전 버전에서 그대로 가져온 안전장치들이다:
// - "발송자"는 실제 클릭한 사람이 아니라 발송함의 "실행자"를 함께 전달해서 기록한다.
// - 서로 다른 발송함을 거의 동시에 "일괄 전송"해도 실제 처리는 전역 잠금으로 한 번에 하나씩만
//   순차 진행한다 (Notion API 레이트리밋 보호). 잠금은 청크(호출) 단위로 획득/해제한다 -- 체인
//   전체를 하나의 잠금으로 묶으면, 어느 한 호출이 죽었을 때 잠금 반환 시점을 보장하기 어렵다.

import {
	getPage,
	updatePageProperties,
	queryAllPages,
	queryPagesLimited,
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
// _shared/generateShared.ts의 PROP_BATCH_TYPE / PROP_NOTIFICATION_BATCH_RELATION을 그대로 쓴다.

const BULK_SEND_STATUS_SPEC: StatusSpec = {
	statusProp: "상태",
	errorProp: PROP_BATCH_LAST_ERROR,
	startedAtProp: "처리 시작 시각",
}

// [PART N-8] 한 번에 처리할 고정 건수. 시간 예산 추측(150초 플랫폼 한도 근처를 아슬아슬하게 맞추는
// 방식) 대신, 항상 "10건 처리 -> 남았으면 이어달리기"로 단순하고 예측 가능하게 만든다.
const CHUNK_SIZE = 10
// 보조 안전장치: 10건이 유난히 느리게 처리되더라도(예: Notion API 지연) 150초 강제종료보다 항상
// 먼저 스스로 멈추기 위한 청크 내부 시간 한도.
const CHUNK_TIME_BUDGET_MS = 100 * 1000
// 체인 전체(여러 번의 이어달리기 합산) 시간 한도. Make.com의 "시나리오 전체 한도"에 대응하는
// 개념 -- 극단적으로 대량이거나 뭔가 잘못돼 계속 이어지는 경우의 최후 안전장치.
const TOTAL_CHAIN_BUDGET_MS = 30 * 60 * 1000
// 이 함수가 스스로를 다시 호출할 때 붙이는 표시. true면 사용자가 누른 새 요청이 아니라 체인의
// 다음 청크임을 뜻한다 (중복 실행 검사를 건너뛰고, 누적 진행 상황을 body로 이어받는다).
const CONTINUATION_FLAG = "isContinuation"
// [PART N-8] send-report/send-tuition-notice/자기 자신 호출(callFn)에 타임아웃이 전혀 없었다 --
// Notion API 호출(fetchWithRetry, 30초 타임아웃)과 달리 이 내부 fetch 하나가 응답 없이 멈추면
// 체인 전체가 영원히 멈출 수 있었다. AbortController로 60초 제한을 걸어서, 멈춘 호출도 반드시
// 오류로 끝나 이 함수의 기존 try/catch(실패 처리) 경로로 흘러들어가게 한다.
const FETCH_TIMEOUT_MS = 60_000

async function callFn(path: string, body: Record<string, unknown>, adminKey: string): Promise<Response> {
	const controller = new AbortController()
	const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
	try {
		return await fetch(`${FUNCTIONS_BASE}/${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
			body: JSON.stringify(body),
			signal: controller.signal,
		})
	} finally {
		clearTimeout(timeoutId)
	}
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
// [PART N-8] 잠금은 청크(이 함수의 호출 1회) 단위로만 획득/해제한다. 체인 전체를 하나의 잠금으로
// 묶지 않는 이유: 어느 한 호출이 예기치 않게 죽으면 그 잠금을 누가 언제 반환할지 보장할 수 없다.
// 대신 각 호출은 항상 100초 안팎으로 끝나므로 기존 LOCK_TTL_MS(5분)/처리 흐름과 맞물려 안전하다.
const GLOBAL_LOCK_KEY = ["send_selected_notifications_lock"]
const LOCK_TTL_MS = 5 * 60 * 1000 // 5분 - 처리 하나가 이보다 오래 걸리면 잠금이 자동 해제된다 (안전장치).
const LOCK_WAIT_TIMEOUT_MS = 10 * 60 * 1000 // 10분 넘게 기다리면 포기하고 실패로 기록한다.
const LOCK_POLL_INTERVAL_MS = 2000

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

// ---------- 대상 DB/발송 경로 결정 (발송함 "구분" 문자열만으로 결정되고, 페이지 재조회가 필요 없다 -
// 이어달리기(continuation) 호출에서는 이 문자열을 body로 그대로 이어받아 매번 발송함 페이지를
// 다시 읽지 않아도 되게 한다) ----------
type BatchConfig = {
	category: string
	dataSourceId: string
	idField: "reportId" | "tuitionId"
	sendPath: string
	// 정렬/표시에 쓰는 title 속성 이름.
	titleProp: string
}

function batchConfigForCategory(category: string): BatchConfig {
	if (category === "수강료") {
		return { category, dataSourceId: DS_TUITION, idField: "tuitionId", sendPath: "send-tuition-notice", titleProp: "청구명" }
	}
	if (category === "주간 보고서" || category === "월간 보고서") {
		return { category, dataSourceId: DS_REPORT, idField: "reportId", sendPath: "send-report", titleProp: "보고서" }
	}
	throw new Error(`이 발송함의 '구분'이 "주간 보고서" / "월간 보고서" / "수강료" 중 하나가 아닙니다 (현재 값: "${category || "없음"}").`)
}

function targetFilter(batchId: string): Record<string, unknown> {
	return {
		and: [
			{ property: PROP_NOTIFICATION_BATCH_RELATION, relation: { contains: batchId } },
			{ property: PROP_BULK_SELECT, checkbox: { equals: true } },
		],
	}
}

async function fetchNextChunk(config: BatchConfig, batchId: string): Promise<any[]> {
	return await queryPagesLimited(
		config.dataSourceId,
		targetFilter(batchId),
		[{ property: config.titleProp, direction: "ascending" }],
		CHUNK_SIZE,
	)
}

async function hasAnyRemaining(config: BatchConfig, batchId: string): Promise<boolean> {
	const rows = await queryPagesLimited(config.dataSourceId, targetFilter(batchId), undefined, 1)
	return rows.length > 0
}

// 청구명/보고서 title은 "YY.MM 이름 수강료" / "YY.MM 이름 주간 보고서" 형식이라(항상 한 발송함
// 안에서는 접두어(YY.MM)가 동일하므로 title 오름차순 정렬이 곧 이름순 정렬과 같다), 실패 목록
// 표시용으로 접두어/접미어를 떼고 이름만 뽑아낸다. 형식이 안 맞으면 원본 title을 그대로 쓴다.
function displayNameFromTitle(title: string): string {
	const m = title.match(/^\d{2}\.\d{2}\s+(.+?)\s+(수강료|주간 보고서|월간 보고서)$/)
	return m ? m[1] : title
}

function pageTitleText(page: any, titleProp: string): string {
	return (page.properties?.[titleProp]?.title ?? []).map((t: any) => t.plain_text ?? "").join("")
}

// send-tuition-notice/send-report는 실패 시 { error: "..." } JSON 본문과 함께 500을 반환한다
// (두 파일의 Deno.serve 바깥쪽 catch 참고). 파싱에 실패하면 원문 텍스트를 그대로 쓴다.
async function extractFailureReason(res: Response): Promise<string> {
	const text = await res.text().catch(() => "")
	try {
		const parsed = JSON.parse(text)
		if (parsed?.error) return String(parsed.error)
	} catch {
		// JSON이 아니면 원문을 그대로 쓴다.
	}
	return text || `HTTP ${res.status}`
}

async function processChunk(
	targets: any[],
	config: BatchConfig,
	adminKey: string,
	executorUserId: string | null,
	log: string[],
): Promise<{ success: number; failed: number; failureDetails: string[] }> {
	const startedAt = Date.now()
	let success = 0
	let failed = 0
	const failureDetails: string[] = []
	for (const page of targets) {
		if (Date.now() - startedAt > CHUNK_TIME_BUDGET_MS) {
			log.push(
				`[${config.category}] 청크 처리 중 보조 시간 제한(${Math.round(CHUNK_TIME_BUDGET_MS / 1000)}초)에 도달해 이번 청크의 나머지는 다음 이어달리기에서 처리함`,
			)
			break
		}
		const name = displayNameFromTitle(pageTitleText(page, config.titleProp))
		try {
			const res = await callFn(
				config.sendPath,
				{
					[config.idField]: page.id,
					adminKey,
					// send-report/send-tuition-notice가 개별 버튼 클릭과 달리 이 호출은 끝까지 동기로
					// 기다려서 성공/실패(res.ok)를 그대로 돌려주고, 실패해도 "일괄전송 선택"을 해제하도록
					// 요청한다 (_shared/alimtalkShared.ts의 SYNC_WAIT_FLAG 설명 및 두 파일의 PART N-8
					// 주석 참고). 체크박스는 이제 이 함수가 아니라 호출된 함수 쪽에서 직접 해제한다.
					[SYNC_WAIT_FLAG]: true,
					...(executorUserId
						? { data: { properties: { "실행자": { people: [{ id: executorUserId }] } } } }
						: {}),
				},
				adminKey,
			)
			if (res.ok) {
				success++
			} else {
				failed++
				const reason = await extractFailureReason(res)
				failureDetails.push(`${name}(${reason})`)
				log.push(`[${config.category}] ${page.id}(${name}) 발송 실패: ${res.status} ${reason}`)
			}
		} catch (err) {
			failed++
			const reason = (err as Error).message
			failureDetails.push(`${name}(${reason})`)
			log.push(`[${config.category}] ${page.id}(${name}) 오류: ${reason}`)
		}
	}
	return { success, failed, failureDetails }
}

// 실패 이력을 이름(사유) 형태로 최대 maxShown건까지 나열한 완료 메시지를 만든다. 실패가 하나도
// 없으면 null(=성공)을 돌려준다. 자동화 로그(학원) DB에 모든 시도 이력이 남으므로, 여기서는
// "요약"만 보여주고 나머지는 그쪽에서 확인하게 한다.
function buildFinalMessage(success: number, failed: number, failureDetails: string[], total: number): string | null {
	if (failed === 0) return null
	const maxShown = 15
	const shown = failureDetails.slice(0, maxShown)
	const more = failureDetails.length > maxShown ? ` 외 ${failureDetails.length - maxShown}건` : ""
	return `${nowKstLabel()} - 완료: 성공 ${success}건, 실패 ${failed}건 (총 ${total}건). 실패: ${shown.join(", ")}${more}`
}

Deno.serve(async (req: Request) => {
	if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

	let body: any
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

	const adminKey = resolveAdminKeyFromRequest(req, body)
	const currentAdminKey = await getCurrentAdminKey()
	if (!adminKey || adminKey !== currentAdminKey) {
		await finishBatch(batchId, `${nowKstLabel()} - 인증 실패: x-admin-key가 올바르지 않습니다. Notion 자동화의 웹훅 헤더와 현재 관리자 키가 일치하는지 확인하세요.`)
		return new Response(JSON.stringify({ error: "unauthorized" }), {
			status: 401,
			headers: { "Content-Type": "application/json", ...corsHeaders },
		})
	}

	const isContinuation = body?.[CONTINUATION_FLAG] === true

	let category: string
	let executorUserId: string | null
	let chainStartedAt: number
	let accSuccess: number
	let accFailed: number
	let accFailureDetails: string[]
	let totalTargetsAtStart: number | null

	if (isContinuation) {
		// 이어달리기 호출은 사용자가 새로 누른 게 아니라 이 함수가 스스로 만든 요청이므로, 중복 실행
		// 검사(isRunning) 없이 바로 진행한다. 필요한 정보는 모두 body로 이어받아 발송함 페이지를
		// 다시 읽지 않아도 된다(청크 시간 예산을 아낀다).
		category = String(body?.category ?? "")
		executorUserId = body?.executorUserId ?? null
		chainStartedAt = typeof body?.chainStartedAt === "number" ? body.chainStartedAt : Date.now()
		accSuccess = typeof body?.accSuccess === "number" ? body.accSuccess : 0
		accFailed = typeof body?.accFailed === "number" ? body.accFailed : 0
		accFailureDetails = Array.isArray(body?.accFailureDetails) ? body.accFailureDetails : []
		totalTargetsAtStart = typeof body?.totalTargetsAtStart === "number" ? body.totalTargetsAtStart : null
	} else {
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
		category = batchPageForLock.properties?.[PROP_BATCH_TYPE]?.select?.name ?? ""
		try {
			batchConfigForCategory(category) // 유효성만 검사 (구체적인 설정은 아래 runInBackground에서 다시 만든다)
		} catch (err) {
			await finishBatch(batchId, `${nowKstLabel()} - ${(err as Error).message}`)
			return new Response(JSON.stringify({ ok: false, error: (err as Error).message }, null, 2), {
				status: 400,
				headers: { "Content-Type": "application/json", ...corsHeaders },
			})
		}
		executorUserId = batchPageForLock.properties?.[PROP_BATCH_EXECUTOR]?.people?.[0]?.id ?? null
		chainStartedAt = Date.now()
		accSuccess = 0
		accFailed = 0
		accFailureDetails = []
		totalTargetsAtStart = null
	}

	// [PART N-8] 매 호출(최초 실행 + 모든 이어달리기)마다 "처리 시작 시각"을 지금으로 갱신한다.
	// 워치독(status-watchdog)은 이 값이 15분 넘게 오래됐으면 "타임아웃 복구"로 되돌리는데, 체인
	// 전체는 최대 30분(TOTAL_CHAIN_BUDGET_MS)까지 이어질 수 있으므로, 매 청크마다 이 시각을
	// 새로고침해서 실제로는 계속 정상 진행 중인 배치를 워치독이 죽은 것으로 착각하지 않게 한다.
	// (체인 전체의 경과 시간은 이 값과 별개로 chainStartedAt을 body에 실어 직접 추적한다.)
	await markRunning(batchId, BULK_SEND_STATUS_SPEC)

	const log: string[] = []

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

			const config = batchConfigForCategory(category)

			if (totalTargetsAtStart === null) {
				// 최초 실행에서만 전체 대상 건수를 한 번 세어서, 완료 메시지/진행 표시에 "전체 N건"으로
				// 함께 보여준다 (처리 자체는 여전히 매번 10건씩만 다시 조회한다).
				const allTargets = await queryAllPages(config.dataSourceId, targetFilter(batchId))
				totalTargetsAtStart = allTargets.length
			}
			log.push(`[${config.category}] 대상 ${totalTargetsAtStart}건 (전체) 중 이름순 ${CHUNK_SIZE}건씩 처리`)

			const targets = await fetchNextChunk(config, batchId)
			const { success, failed, failureDetails } = await processChunk(targets, config, adminKey, executorUserId, log)

			const newAccSuccess = accSuccess + success
			const newAccFailed = accFailed + failed
			const newAccFailureDetails = [...accFailureDetails, ...failureDetails]

			log.push(
				`[${config.category}] 이번 청크: 성공 ${success}건, 실패 ${failed}건 (누적: 성공 ${newAccSuccess}건, 실패 ${newAccFailed}건 / 전체 ${totalTargetsAtStart}건)`,
			)
			console.log("send-selected-notifications chunk finished:", batchId, "\n", log.join("\n"))

			const hasMore = await hasAnyRemaining(config, batchId)
			if (!hasMore) {
				await finishBatch(batchId, buildFinalMessage(newAccSuccess, newAccFailed, newAccFailureDetails, totalTargetsAtStart))
				return
			}

			const elapsedChain = Date.now() - chainStartedAt
			if (elapsedChain > TOTAL_CHAIN_BUDGET_MS) {
				await finishBatch(
					batchId,
					`${nowKstLabel()} - 전체 처리 한도(${Math.round(TOTAL_CHAIN_BUDGET_MS / 60000)}분) 초과로 중단됨. 지금까지 성공 ${newAccSuccess}건, 실패 ${newAccFailed}건 (전체 ${totalTargetsAtStart}건). "일괄 전송"을 다시 눌러 이어서 진행하세요.`,
				)
				return
			}

			// 아직 남은 건이 있고 체인 한도도 안 넘었으면, 진행 상황을 표시하고 다음 청크로 이어간다.
			await updatePageProperties(batchId, {
				[PROP_BATCH_LAST_ERROR]: {
					rich_text: [
						{
							text: {
								content: `🔄 진행 중... (${newAccSuccess + newAccFailed}/${totalTargetsAtStart} 처리, 성공 ${newAccSuccess}·실패 ${newAccFailed})`,
							},
						},
					],
				},
			}).catch(() => {})

			// 자기 자신을 다시 호출해 다음 청크를 이어서 처리한다. 이 fetch는 호출된 쪽의 빠른 202
			// 응답까지만 기다린다 -- 실제 다음 청크 처리는 그 호출 자신의 백그라운드에서 진행되므로,
			// 이 호출이 오래 걸릴 일은 없다(callFn의 60초 타임아웃은 그래도 안전망으로 남겨둔다).
			const continueRes = await callFn(
				"send-selected-notifications",
				{
					pageId: batchId,
					adminKey,
					[CONTINUATION_FLAG]: true,
					chainStartedAt,
					accSuccess: newAccSuccess,
					accFailed: newAccFailed,
					accFailureDetails: newAccFailureDetails,
					totalTargetsAtStart,
					category: config.category,
					executorUserId,
				},
				adminKey,
			)
			if (!continueRes.ok) {
				const text = await continueRes.text().catch(() => "")
				throw new Error(`다음 이어달리기 호출 실패: ${continueRes.status} ${text}`)
			}
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

	return respondAccepted({ batchId, isContinuation })
})

// Supabase Edge Function: backfill-attendance
//
// [PART N-11, 2026-09-23] 일괄 수업 생성("다음주 수업 일괄 생성" 버튼)의 청크+체인 재설계에서
// "출석 생성" 단계를 분리한 두 번째 체인. generate-classes(체인 1)가 어떤 한 주(週)의 수업 생성을
// 끝내면, 그 주의 출석 조정이 필요한 후보 목록과 함께 이 함수를 트리거한다 (fire-and-forget).
//
// [PART N-11, 2026-09-24, 주차 단위 재설계] 예전에는 이 함수가 스스로 "오늘 이후 전체"를 스캔해서
// 후보를 찾았지만, 이제는 generate-classes가 이미 "이번 주" 범위로 스캔해서 만든 candidateIds를
// body.pendingIds로 그대로 받는다(스캔은 호출부에서 1번만, 한 주 분량만). 이 함수는 그 후보들을
// 기존 "출석 조정" 로직(fixAttendanceForClassSession, _shared/fixAttendanceTarget.ts, "출석 조정"
// 버튼과 동일 코드)으로 처리하는 역할만 담당한다 -- send-selected-notifications(PART N-8)와 동일한
// 고정 청크 + 이어달리기(자기 자신 재호출) 패턴.
//
// body.weekReturn이 있으면(항상 generate-classes가 채워서 보냄) 이번 주 후보를 모두 처리한 뒤
// (성공/스킵 포함, pendingIds가 0이 되면) generate-classes를 다시 호출해서 "다음 주"로 전진시킨다
// (핑퐁 구조). weekReturn이 없는 호출은(과거 방식의 스탠드얼론 트리거) 그냥 처리만 하고 끝낸다 --
// 지금은 generate-classes만 이 함수를 호출하므로 항상 weekReturn이 채워져 있지만, 혹시 모를 다른
// 트리거 경로를 위해 하위호환으로 남겨둔다.
//
// 개별 세션에 대한 "출석 조정" 버튼과 동일한 로직을 쓰므로, 각 세션의 "출석조정 상태"/"마지막
// 오류" 필드에 그 세션 자신의 진행상황이 그대로 남는다 — 이 함수 자체는 전체 체인의 진행상황을
// Supabase 함수 로그(console.log)로만 남기고, 별도의 Notion 상태 필드는 두지 않았다 (기존
// status-watchdog/개별 버튼과 중복되는 새 필드를 늘리지 않기 위함).

import { relIds, withTimeout, mapWithConcurrency } from "../_shared/notionClient.ts"
import { getCurrentAdminKey, resolveAdminKeyFromRequest, CORS_HEADERS } from "../_shared/adminShared.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"
import {
  fixAttendanceForClassSession,
  markAttendanceFixRunning,
  markAttendanceFixDone,
  markAttendanceFixError,
} from "../_shared/fixAttendanceTarget.ts"

// send-selected-notifications(PART N-8)의 청크+체인 뼈대는 그대로 가져왔지만, 세션 하나 조정 비용이
// 훨씬 무거워서(등록 수만큼 Notion API 반복 호출) 청크 크기와 동시성은 실제 재현된 실패를 보고 이
// 함수에 맞게 다시 조정했다 (PART N-11 후속 3/4차).
// [PART N-11, 2026-09-24, 후속 5차] CHUNK_SIZE를 CANDIDATE_CONCURRENCY와 같게(2=2) 맞췄다 -- 이전엔
// 4/2였어서 한 워커가 이번 호출 안에서 최대 2개(=4/2)까지 순서대로("2 rounds") 처리할 수 있었고,
// 항목 하나가 ITEM_TIMEOUT_MS(60초)까지 걸리는 경우 워커 하나가 60+60=120초까지 갈 수 있어 150초
// 한도에 위험할 정도로 가까웠다(실제 로그에서 총 129초까지 관측됨). 청크 크기를 동시성과 같게 두면
// ("1-round-per-invocation") 이번 호출에서 한 워커가 처리하는 항목은 최대 1개로 보장되어, worst-case
// 시간이 ITEM_TIMEOUT_MS 1회분 + 오버헤드로 줄어든다.
const CHUNK_SIZE = 2
const CANDIDATE_CONCURRENCY = 2
// (2026-09-23, PART N-11 후속 2차/4차) 이 경계 체크는 "다음 항목을 시작하기 전"에만 일어나므로,
// 항목 하나가 끝나자마자 걸리는 시점의 경과 시간이 이미 CHUNK_TIME_BUDGET_MS를 넘어 있어야 다음
// 항목을 안 시작하고 멈춘다. CHUNK_SIZE===CANDIDATE_CONCURRENCY(위 참고)가 된 뒤로는 이번 호출에서
// 어차피 항목을 최대 1개씩만 처리하므로 이 체크가 실제로 걸릴 일은 거의 없지만, 안전망으로 유지한다.
const CHUNK_TIME_BUDGET_MS = 65_000
// 세션 하나를 조정하는 데 걸리는 시간의 상한. fetchWithRetry 자체는 개별 API 호출 하나에만
// 시간을 제한하므로(최악 약 81초), 한 세션 안에서 여러 번 순서대로 호출하면 합산 시간이 더 길어질
// 수 있다 -- 이 타임아웃은 "세션 하나 전체"에 대한 별도의 상위 한도다. 이 안에 못 끝나면 그
// 세션은 실패로 처리하고(마지막 오류에 기록됨) 다음 세션으로 넘어간다 -- 못 끝난 세션은 실패
// 카운트가 3 미만이면 이번 체인 안에서 다시 시도되고(아래 failCounts 참고), 그래도 안 되면
// 다음 스캔(다음 버튼 클릭)에서 다시 후보로 잡히므로 데이터가 누락되지 않는다.
const ITEM_TIMEOUT_MS = 60_000
// [PART N-11, 2026-09-24, 후속 5차] 사용자와 논의된 안전장치: 같은 세션이 이 체인 안에서 연속
// 3번 실패하면(타임아웃/오류 등) 더 이상 재시도하지 않고 건너뛴다. 대부분의 실패는 일시적인 Notion
// API 레이트리밋 혼잡 때문이라 재시도하면 자연스럽게 풀리는 경우가 많지만(실측: 같은 세션이 한 번은
// 60초 초과, 재시도에서는 15초에 성공), 아주 드물게 데이터 자체에 문제가 있어 구조적으로 계속
// 실패하는 항목이 있을 수 있다 -- 그런 항목이 "이번 주 출석 완료" 판정을 영원히 막아 다음 주 진행
// 전체를 블록하지 않도록, 3번까지만 재시도하고 그 이후는 스킵한다(해당 세션 자신의 "마지막 오류"
// 필드에는 그대로 남아 있어 사람이 확인/개별 "출석 조정" 버튼으로 나중에 고칠 수 있다).
const MAX_CONSECUTIVE_FAILURES = 3
const TOTAL_CHAIN_BUDGET_MS = 30 * 60 * 1000
const CONTINUATION_FLAG = "isContinuation"
const FUNCTIONS_BASE = `${Deno.env.get("SB_URL") ?? ""}/functions/v1`
const SELF_CALL_TIMEOUT_MS = 60_000

// [PART N-11, 2026-09-24] generate-classes가 "이번 주" 출석 후보와 함께 이 함수를 호출할 때 실어
// 보내는 핑퐁 복귀 정보. 이 체인이 이번 주 후보를 모두 처리하면(성공/스킵 불문, pending이 0이
// 되면) 이 정보로 generate-classes를 다시 호출해서 다음 주로 전진시킨다.
type WeekReturn = {
  menuPageId: string | null
  weekStart: string
  finalWeekStart: string
  chainStartedAt: number // generate-classes 체인 자신의 전체 시간 한도 측정 기준 (이 함수의 chainStartedAt과는 별개)
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z")
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

async function callSelf(body: Record<string, unknown>, adminKey: string): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), SELF_CALL_TIMEOUT_MS)
  try {
    return await fetch(`${FUNCTIONS_BASE}/backfill-attendance`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

// [PART N-11, 2026-09-24] 이번 주 출석 후보를 모두 처리한 뒤, generate-classes를 다시 호출해서
// weekReturn.weekStart의 "다음 주"로 전진시킨다 (fire-and-forget: 빠른 202 응답만 기다림).
async function pingBackToNextWeek(weekReturn: WeekReturn, adminKey: string, log: string[]): Promise<void> {
  try {
    const nextWeekStart = addDays(weekReturn.weekStart, 7)
    const res = await fetch(`${FUNCTIONS_BASE}/generate-classes?mode=bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
      body: JSON.stringify({
        isContinuation: true,
        menuPageId: weekReturn.menuPageId,
        weekStart: nextWeekStart,
        finalWeekStart: weekReturn.finalWeekStart,
        chainStartedAt: weekReturn.chainStartedAt,
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      log.push(`[warn] generate-classes(다음 주 전진) 호출 실패: ${res.status} ${text}`)
    } else {
      log.push(`[ok] generate-classes(다음 주 ${nextWeekStart}로 전진) 호출함`)
    }
  } catch (err) {
    log.push(`[warn] generate-classes(다음 주 전진) 호출 오류: ${(err as Error).message}`)
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })
  if (req.method !== "POST") {
    return new Response("Use POST", { status: 405, headers: CORS_HEADERS })
  }

  let body: any = {}
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const adminKey = resolveAdminKeyFromRequest(req, body)
  const currentAdminKey = await getCurrentAdminKey()
  if (!adminKey || adminKey !== currentAdminKey) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    })
  }

  const isContinuation = body?.[CONTINUATION_FLAG] === true
  const weekReturn: WeekReturn | undefined =
    body?.weekReturn && typeof body.weekReturn.weekStart === "string" ? body.weekReturn : undefined

  let pendingIds: string[]
  let chainStartedAt: number
  let accFixed: number
  let accScanned: number
  let accErrors: string[]
  let failCounts: Record<string, number>

  if (isContinuation) {
    pendingIds = Array.isArray(body?.pendingIds) ? body.pendingIds : []
    chainStartedAt = typeof body?.chainStartedAt === "number" ? body.chainStartedAt : Date.now()
    accFixed = typeof body?.accFixed === "number" ? body.accFixed : 0
    accScanned = typeof body?.accScanned === "number" ? body.accScanned : pendingIds.length
    accErrors = Array.isArray(body?.accErrors) ? body.accErrors : []
    failCounts = typeof body?.failCounts === "object" && body?.failCounts !== null ? body.failCounts : {}
  } else if (Array.isArray(body?.pendingIds)) {
    // [PART N-11, 2026-09-24] generate-classes가 "이번 주" 후보 목록을 이미 스캔해서 넘겨준
    // 최초 트리거. 이 함수 스스로 다시 스캔하지 않는다 (스캔은 호출부에서 한 주 분량만 1번).
    pendingIds = body.pendingIds
    chainStartedAt = Date.now()
    accFixed = 0
    accScanned = pendingIds.length
    accErrors = []
    failCounts = {}
    console.log(`backfill-attendance: generate-classes로부터 후보 ${pendingIds.length}건 수신 (주차 ${weekReturn?.weekStart ?? "(없음)"})`)
    if (pendingIds.length === 0) {
      if (weekReturn) {
        const log0: string[] = []
        runInBackground(async () => {
          await pingBackToNextWeek(weekReturn, adminKey, log0)
          console.log(log0.join("\n"))
        })
      }
      return new Response(JSON.stringify({ ok: true, message: "no_candidates" }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      })
    }
  } else {
    // 하위호환: pendingIds 없이 트리거된 과거 방식의 스탠드얼론 호출은 이제 이 경로를 쓰지 않지만
    // (generate-classes는 항상 주차별로 스캔한 pendingIds를 넘김), 혹시 다른 경로에서 호출될 경우
    // 아무 것도 하지 않고 안전하게 끝낸다 (전체 히스토리 재스캔은 WallClockTime 위험이 있어 다시
    // 두지 않음 -- 2026-09-24 실측 버그 참고).
    console.log("backfill-attendance: pendingIds 없이 호출됨 -- 처리할 것 없음 (generate-classes가 주차별로 후보를 넘겨야 함)")
    return new Response(JSON.stringify({ ok: true, message: "no_pending_ids_supplied" }, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    })
  }

  const log: string[] = []

  runInBackground(async () => {
    try {
      const chunk = pendingIds.slice(0, CHUNK_SIZE)
      const rest = pendingIds.slice(CHUNK_SIZE)
      const untouched: string[] = [] // 이번 라운드 보조 시간 제한에 걸려 시작도 못한 항목
      const retry: string[] = [] // 실패했지만 아직 3회 미만이라 이번 체인 안에서 재시도할 항목
      const chunkStartedAt = Date.now()

      // [2026-09-23 후속 3차] 원래는 순차 for 루프였는데, 세션 하나(fixAttendanceForClassSession)가
      // 등록 수만큼 Notion API를 여러 번 순서대로 호출하는 무거운 작업이라 5개만 순차로 처리해도
      // 150초를 넘기기 쉬웠다(실제로 재현됨). generate-classes 체인1과 동일한 패턴으로 동시성
      // (CANDIDATE_CONCURRENCY)을 주고, 시간 예산 체크도 그 패턴을 그대로 따라 "항목 시작 전에
      // 확인 -> 넘으면 손대지 않고 untouched에 넣기"로 바꿨다.
      await mapWithConcurrency(chunk, CANDIDATE_CONCURRENCY, async (sessionId) => {
        if (Date.now() - chunkStartedAt > CHUNK_TIME_BUDGET_MS) {
          untouched.push(sessionId)
          return
        }
        console.log(`backfill-attendance: 세션 처리 시작 ${sessionId}`)
        try {
          // [2026-09-23 후속] 개별 "출석 조정" 버튼(fix-attendance/index.ts)과 똑같이 처리 시작
          // 시점에 "출석조정 상태"를 진행중으로 표시한다 -- 원래는 이걸 안 해서, 일괄 생성 뒤에
          // backfill-attendance가 출석을 채우는 동안 캘린더 카드에 아무 진행 표시도 안 보인다는
          // 피드백이 있었다 (사용자가 보기엔 "그냥 멈춘 것"과 구분이 안 됨).
          await markAttendanceFixRunning(sessionId)
          // [2026-09-23 후속 2차] withTimeout으로 세션 하나 전체에 상위 시간 제한을 건다 (이유는
          // ITEM_TIMEOUT_MS 선언부 주석 참고) -- fetchWithRetry 자체의 호출별 제한만으로는
          // 부족했다(실제로 재현됨: 12초로 줄인 뒤에도 WallClockTime으로 죽는 사례 발생).
          // trustFrozenRegistrationsIfBare: 출석이 하나도 없는(방금 체인1이 막 만든) 세션이면
          // 등록 관계 재조회를 건너뛴다 (사용자 제안, PART N-11 후속 3차 -- 세션당 쿼리 1번 절약).
          await withTimeout(
            fixAttendanceForClassSession(sessionId, log, { trustFrozenRegistrationsIfBare: true }),
            ITEM_TIMEOUT_MS,
            `세션 ${sessionId} 출석 조정`,
          )
          await markAttendanceFixDone(sessionId)
          delete failCounts[sessionId]
          accFixed++
          console.log(`backfill-attendance: 세션 처리 완료 ${sessionId}`)
        } catch (err) {
          const failCount = (failCounts[sessionId] ?? 0) + 1
          failCounts[sessionId] = failCount
          const message = (err as Error).message
          log.push(`[error] ${sessionId} (연속 실패 ${failCount}회): ${message}`)
          console.error(`backfill-attendance: 세션 처리 실패 ${sessionId} (연속 실패 ${failCount}회): ${message}`)
          await markAttendanceFixError(sessionId, message)
          if (failCount < MAX_CONSECUTIVE_FAILURES) {
            // 대부분 일시적인 Notion API 레이트리밋 혼잡 때문이라 재시도하면 풀리는 경우가 많다
            // (실측 근거) -- 이번 체인 안에서 한 번 더 시도한다.
            retry.push(sessionId)
          } else {
            // 3번 연속 실패 -- 데이터 자체 문제일 가능성. 이 세션이 "이번 주 완료" 판정을 영원히
            // 막지 않도록 더 이상 재시도하지 않고 건너뛴다 (마지막 오류 필드에는 그대로 남음).
            accErrors.push(`${sessionId}: ${message} (3회 연속 실패, 건너뜀)`)
            log.push(`[circuit-breaker] ${sessionId}: 연속 ${MAX_CONSECUTIVE_FAILURES}회 실패, 이번 체인에서 건너뜀`)
          }
        }
      })

      const processedCount = chunk.length - untouched.length
      const newPending = [...untouched, ...rest, ...retry]
      console.log(
        `backfill-attendance chunk finished: 이번 청크 ${processedCount}건 처리, 누적 처리 ${accFixed}/${accScanned}건, 남음 ${newPending.length}건\n`,
        log.join("\n"),
      )

      if (newPending.length === 0) {
        console.log(
          `backfill-attendance: 전체 완료 (스캔 대상 ${accScanned}건, 처리 ${accFixed}건, 오류 ${accErrors.length}건)` +
            (accErrors.length ? `\n오류 목록: ${accErrors.join(", ")}` : ""),
        )
        if (weekReturn) {
          await pingBackToNextWeek(weekReturn, adminKey, log)
          console.log(log.join("\n"))
        }
        return
      }

      const elapsedChain = Date.now() - chainStartedAt
      if (elapsedChain > TOTAL_CHAIN_BUDGET_MS) {
        console.error(
          `backfill-attendance: 전체 처리 한도(${Math.round(TOTAL_CHAIN_BUDGET_MS / 60000)}분) 초과로 중단됨. ` +
            `지금까지 처리 ${accFixed}/${accScanned}건, 남은 ${newPending.length}건은 다음 트리거(일괄 생성 버튼 재클릭 등) 때 새로 스캔됩니다.`,
        )
        // 이번 주가 못 끝났으므로 다음 주로 전진시키지 않는다 (weekReturn을 쓰지 않고 그냥 멈춤 --
        // 사람이 버튼을 다시 눌러야 이번 주부터 다시 이어짐).
        return
      }

      const continueRes = await callSelf(
        {
          [CONTINUATION_FLAG]: true,
          pendingIds: newPending,
          chainStartedAt,
          accFixed,
          accScanned,
          accErrors,
          failCounts,
          weekReturn,
        },
        adminKey,
      )
      if (!continueRes.ok) {
        const text = await continueRes.text().catch(() => "")
        console.error(`backfill-attendance: 다음 이어달리기 호출 실패: ${continueRes.status} ${text}`)
      }
    } catch (err) {
      console.error("backfill-attendance failed:", (err as Error).message, "\nlog so far:", log.join("\n"), "\nstack:", (err as Error).stack)
    }
  })

  return respondAccepted({ scanned: accScanned, pending: pendingIds.length })
})

// Supabase Edge Function: backfill-attendance
//
// [PART N-11, 2026-09-23] 일괄 수업 생성("다음주 수업 일괄 생성" 버튼)의 청크+체인 재설계에서
// "출석 생성" 단계를 완전히 분리한 두 번째 체인. generate-classes의 수업 생성 체인(체인 1)이
// 시간표들을 horizon까지 다 채우고 나면, 이 함수를 한 번 트리거한다 (fire-and-forget).
//
// 하는 일: 수업(학원) DB 전체를 스캔해서, "등록" relation 개수와 "출석" relation 개수가 다른
// (즉 출석이 덜 채워졌거나 초과/중복된) 수업만 골라내고 — 이미 맞는 건 추가 쿼리 없이 페이지
// 속성만으로 공짜로 스킵한다 — 그 후보만 이미 있는 "출석 조정" 로직
// (fixAttendanceForClassSession, _shared/fixAttendanceTarget.ts, "출석 조정" 버튼과 동일 코드)을
// 그대로 재사용해서 4건씩(동시성 2) 처리한다. send-selected-notifications(PART N-8)와 동일한
// 고정 청크 + 이어달리기(자기 자신 재호출) 패턴 — 청크 크기/동시성 값은 이 함수의 실제 무게에
// 맞게 조정했다 (아래 CHUNK_SIZE/CANDIDATE_CONCURRENCY 선언부 주석 참고).
//
// 전체 히스토리를 매번 다시 스캔하는 이유: 실제로는 거의 항상 이미 맞아있을 것이므로(개수 비교가
// 공짜라서) 데이터가 계속 늘어나도 이 스캔 자체의 비용은 낮게 유지된다 — 실제로 무거운 조정
// 쿼리(fixAttendanceForClassSession)는 후보로 걸린 소수의 수업에만 들어간다.
//
// 개별 세션에 대한 "출석 조정" 버튼과 동일한 로직을 쓰므로, 각 세션의 "출석조정 상태"/"마지막
// 오류" 필드에 그 세션 자신의 진행상황이 그대로 남는다 — 이 함수 자체는 전체 체인의 진행상황을
// Supabase 함수 로그(console.log)로만 남기고, 별도의 Notion 상태 필드는 두지 않았다 (기존
// status-watchdog/개별 버튼과 중복되는 새 필드를 늘리지 않기 위함).

import { queryAllPages, relIds, withTimeout, mapWithConcurrency, todaySeoulDate } from "../_shared/notionClient.ts"
import { DS_CLASS_SESSION } from "../_shared/constants.ts"
import { getCurrentAdminKey, resolveAdminKeyFromRequest, CORS_HEADERS } from "../_shared/adminShared.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"
import {
  fixAttendanceForClassSession,
  markAttendanceFixRunning,
  markAttendanceFixDone,
  markAttendanceFixError,
} from "../_shared/fixAttendanceTarget.ts"

// send-selected-notifications(PART N-8)의 청크+체인 뼈대는 그대로 가져왔지만, 세션 하나 조정 비용이
// 훨씬 무거워서(등록 수만큼 Notion API 반복 호출) 청크 크기(10->4)와 처리 방식(순차->동시성)은
// 실제 재현된 실패를 보고 이 함수에 맞게 다시 조정했다 (PART N-11 후속 3차, 2026-09-23).
const CHUNK_SIZE = 4
// (2026-09-23, PART N-11 후속 4차) 실제 라이브 테스트에서 동시성 3 + 45초 제한으로 돌렸을 때도
// "시간 제한(45초) 초과" 오류가 몇 건 났다 -- 동시에 3개씩 Notion API를 두드리면 레이트리밋 대기가
// 늘어나서 개별 세션이 더 오래 걸렸을 가능성이 있다는 사용자 피드백에 따라, 동시성을 3->2로
// 낮추고 항목당 시간 제한(ITEM_TIMEOUT_MS)은 45초->60초로 늘렸다. CHUNK_SIZE도 4로 낮춰서
// 동시성 2일 때 한 워커가 최대 2개까지만(=4/2) 순서대로 처리하게 된다.
const CANDIDATE_CONCURRENCY = 2
// (2026-09-23, PART N-11 후속 2차/4차) 이 경계 체크는 "다음 항목을 시작하기 전"에만 일어나므로,
// 항목 하나가 끝나자마자 걸리는 시점의 경과 시간이 이미 CHUNK_TIME_BUDGET_MS를 넘어 있어야 다음
// 항목을 안 시작하고 멈춘다. 65초로 두면 ITEM_TIMEOUT_MS(60초, 아래)짜리 항목이 한 워커당 최대
// 2개까지만 이어지고(60+60=120초) 그 다음 항목은 시작 안 하게 되어, 플랫폼의 150초 한도까지
// 여유(약 30초)를 남긴다.
const CHUNK_TIME_BUDGET_MS = 65_000
// 세션 하나를 조정하는 데 걸리는 시간의 상한. fetchWithRetry 자체는 개별 API 호출 하나에만
// 시간을 제한하므로(최악 약 81초), 한 세션 안에서 여러 번 순서대로 호출하면 합산 시간이 더 길어질
// 수 있다 -- 이 타임아웃은 "세션 하나 전체"에 대한 별도의 상위 한도다. 이 안에 못 끝나면 그
// 세션은 실패로 처리하고(마지막 오류에 기록됨) 다음 세션으로 넘어간다 -- 못 끝난 세션은 다음
// 스캔에서 다시 후보로 잡히므로 데이터가 누락되지 않는다. 45초->60초로 늘림 (후속 4차, 등록
// 학생이 많은 세션은 정상적으로도 45초 가까이 걸릴 수 있어 너무 빡빡했다는 실측 근거).
const ITEM_TIMEOUT_MS = 60_000
const TOTAL_CHAIN_BUDGET_MS = 30 * 60 * 1000
const CONTINUATION_FLAG = "isContinuation"
const FUNCTIONS_BASE = `${Deno.env.get("SB_URL") ?? ""}/functions/v1`
const SELF_CALL_TIMEOUT_MS = 60_000

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

// 수업(학원) DB 페이지 하나가 이미 등록/출석 개수가 맞아서 손댈 필요가 없어 보이는지, 추가 쿼리
// 없이 이미 읽어온 페이지 속성만으로 판단한다 (cheap pre-filter). 개수가 같다고 100% 완벽함이
// 보장되진 않지만(예: 등록 A가 빠지고 등록 B가 새로 생긴 극단적인 경우), 실제로는 거의 항상
// 정확한 신호이고 이 정도 오차는 다음 스캔에서도 다시 걸러지므로 감내할 만하다.
function looksAlreadySynced(page: any): boolean {
  const regCount = relIds(page.properties?.["등록"]).length
  const attCount = relIds(page.properties?.["출석"]).length
  return regCount === attCount
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

  let pendingIds: string[]
  let chainStartedAt: number
  let accFixed: number
  let accScanned: number
  let accErrors: string[]

  if (isContinuation) {
    pendingIds = Array.isArray(body?.pendingIds) ? body.pendingIds : []
    chainStartedAt = typeof body?.chainStartedAt === "number" ? body.chainStartedAt : Date.now()
    accFixed = typeof body?.accFixed === "number" ? body.accFixed : 0
    accScanned = typeof body?.accScanned === "number" ? body.accScanned : pendingIds.length
    accErrors = Array.isArray(body?.accErrors) ? body.accErrors : []
  } else {
    // 최초 트리거: 수업(학원) DB를 스캔해서 후보 목록을 만든다. (2026-09-24, 실측 버그 수정)
    // 원래는 전체 히스토리를 필터 없이 다 긁어왔는데 -- "개수 비교는 공짜니까 데이터가 늘어나도
    // 이 스캔 비용은 낮게 유지된다"고 가정했었다. 실제로는 그 가정이 틀렸다: 249건을 모으려면
    // queryAllPages가 페이지네이션(100건씩) 호출을 3번 순차로 해야 하고, 오늘처럼 Notion API가
    // 레이트리밋에 걸리기 쉬운 상황에서는 이 스캔 자체가(각 호출의 재시도/백오프까지 합쳐서)
    // 100초 넘게 걸려 플랫폼의 150초 WallClockTime 한도를 스캔 단계에서 거의 다 써버렸다 (실제
    // 로그로 재현: 부팅~스캔완료 122초, 그 직후 강제종료). 게다가 이 함수는 원래 "오늘 이후
    // 수업만 신경쓴다"는 원칙 대상인데 과거 수업까지 다 스캔하고 있었다 -- 아래 필터로 오늘(KST)
    // 이후 수업만 가져오도록 좁혀서, 스캔 대상 자체를 줄인다 (과거 수업의 출석 보정은 이 자동
    // 백필의 책임 범위 밖이며, 필요하면 개별 "출석 조정" 버튼으로 처리).
    let allSessions: any[]
    try {
      allSessions = await queryAllPages(DS_CLASS_SESSION, {
        property: "수업일시",
        date: { on_or_after: todaySeoulDate() },
      })
    } catch (err) {
      console.error("backfill-attendance: 수업 DB 스캔 실패:", (err as Error).message)
      return new Response(JSON.stringify({ ok: false, error: (err as Error).message }, null, 2), {
        status: 500,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      })
    }
    const candidates = allSessions.filter((page) => !looksAlreadySynced(page))
    pendingIds = candidates.map((c) => c.id)
    chainStartedAt = Date.now()
    accFixed = 0
    accScanned = pendingIds.length
    accErrors = []
    console.log(
      `backfill-attendance: 전체 ${allSessions.length}건 스캔, 출석 조정이 필요해 보이는 후보 ${pendingIds.length}건`,
    )
    if (pendingIds.length === 0) {
      return new Response(JSON.stringify({ ok: true, message: "no_candidates", scanned: allSessions.length }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      })
    }
  }

  const log: string[] = []

  runInBackground(async () => {
    try {
      const chunk = pendingIds.slice(0, CHUNK_SIZE)
      const rest = pendingIds.slice(CHUNK_SIZE)
      const untouched: string[] = [] // 이번 라운드 보조 시간 제한에 걸려 시작도 못한 항목
      const chunkStartedAt = Date.now()

      // [2026-09-23 후속 3차] 원래는 순차 for 루프였는데, 세션 하나(fixAttendanceForClassSession)가
      // 등록 수만큼 Notion API를 여러 번 순서대로 호출하는 무거운 작업이라 5개만 순차로 처리해도
      // 150초를 넘기기 쉬웠다(실제로 재현됨). generate-classes 체인1(runBulkSessionChain)과 동일한
      // 패턴으로 동시성(CANDIDATE_CONCURRENCY)을 주고, 시간 예산 체크도 그 패턴을 그대로 따라
      // "항목 시작 전에 확인 -> 넘으면 손대지 않고 untouched에 넣기"로 바꿨다.
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
          accFixed++
          console.log(`backfill-attendance: 세션 처리 완료 ${sessionId}`)
        } catch (err) {
          accErrors.push(`${sessionId}: ${(err as Error).message}`)
          log.push(`[error] ${sessionId}: ${(err as Error).message}`)
          console.error(`backfill-attendance: 세션 처리 실패 ${sessionId}: ${(err as Error).message}`)
          await markAttendanceFixError(sessionId, (err as Error).message)
        }
      })

      const processedCount = chunk.length - untouched.length
      const newPending = [...untouched, ...rest]
      console.log(
        `backfill-attendance chunk finished: 이번 청크 ${processedCount}건 처리, 누적 처리 ${accFixed}/${accScanned}건, 남음 ${newPending.length}건\n`,
        log.join("\n"),
      )

      if (newPending.length === 0) {
        console.log(
          `backfill-attendance: 전체 완료 (스캔 대상 ${accScanned}건, 처리 ${accFixed}건, 오류 ${accErrors.length}건)` +
            (accErrors.length ? `\n오류 목록: ${accErrors.join(", ")}` : ""),
        )
        return
      }

      const elapsedChain = Date.now() - chainStartedAt
      if (elapsedChain > TOTAL_CHAIN_BUDGET_MS) {
        console.error(
          `backfill-attendance: 전체 처리 한도(${Math.round(TOTAL_CHAIN_BUDGET_MS / 60000)}분) 초과로 중단됨. ` +
            `지금까지 처리 ${accFixed}/${accScanned}건, 남은 ${newPending.length}건은 다음 트리거(일괄 생성 버튼 재클릭 등) 때 새로 스캔됩니다.`,
        )
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

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
// 그대로 재사용해서 10건씩 처리한다. send-selected-notifications(PART N-8)와 동일한 고정 청크
// (10건) + 이어달리기(자기 자신 재호출) 패턴.
//
// 전체 히스토리를 매번 다시 스캔하는 이유: 실제로는 거의 항상 이미 맞아있을 것이므로(개수 비교가
// 공짜라서) 데이터가 계속 늘어나도 이 스캔 자체의 비용은 낮게 유지된다 — 실제로 무거운 조정
// 쿼리(fixAttendanceForClassSession)는 후보로 걸린 소수의 수업에만 들어간다.
//
// 개별 세션에 대한 "출석 조정" 버튼과 동일한 로직을 쓰므로, 각 세션의 "출석조정 상태"/"마지막
// 오류" 필드에 그 세션 자신의 진행상황이 그대로 남는다 — 이 함수 자체는 전체 체인의 진행상황을
// Supabase 함수 로그(console.log)로만 남기고, 별도의 Notion 상태 필드는 두지 않았다 (기존
// status-watchdog/개별 버튼과 중복되는 새 필드를 늘리지 않기 위함).

import { queryAllPages, relIds } from "../_shared/notionClient.ts"
import { DS_CLASS_SESSION } from "../_shared/constants.ts"
import { getCurrentAdminKey, resolveAdminKeyFromRequest, CORS_HEADERS } from "../_shared/adminShared.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"
import { fixAttendanceForClassSession } from "../_shared/fixAttendanceTarget.ts"

// send-selected-notifications(PART N-8)와 동일한 상수 선택 이유: 이미 실전에서 두 번 검증된 값.
const CHUNK_SIZE = 10
const CHUNK_TIME_BUDGET_MS = 100_000
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
    // 최초 트리거: 수업(학원) DB 전체를 한 번 스캔해서 후보 목록을 만든다 (264건 기준 API 호출
    // 몇 번 -- queryAllPages가 커서를 따라가며 알아서 다 모아온다).
    let allSessions: any[]
    try {
      allSessions = await queryAllPages(DS_CLASS_SESSION)
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
      const chunkStartedAt = Date.now()
      let processedCount = 0
      for (const sessionId of chunk) {
        if (Date.now() - chunkStartedAt > CHUNK_TIME_BUDGET_MS) {
          log.push(`청크 처리 중 보조 시간 제한(${Math.round(CHUNK_TIME_BUDGET_MS / 1000)}초)에 도달, 나머지는 다음 이어달리기에서 처리`)
          break
        }
        try {
          await fixAttendanceForClassSession(sessionId, log)
          accFixed++
        } catch (err) {
          accErrors.push(`${sessionId}: ${(err as Error).message}`)
          log.push(`[error] ${sessionId}: ${(err as Error).message}`)
        }
        processedCount++
      }

      const newPending = [...chunk.slice(processedCount), ...pendingIds.slice(CHUNK_SIZE)]
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

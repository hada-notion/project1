// 수업(학원) 페이지의 출석 학생에게 일일 보고서를 순차 전송한다.
//
// 2026-09-25 안정화:
// - 학생 1명당 Edge Function 호출 1회로 체이닝해 Notion API 부하와 150초 실행 한도를 분산한다.
// - 토큰 발급 -> 출석 원본 동기화 -> 학습기록/학습활동 포함 report_cache 생성이 성공한 뒤에만 발송한다.
// - 같은 체인의 학생들은 report_source_cache를 공유해 그룹 공통 학습기록/교재/클래스 페이지를
//   Notion에서 학생마다 다시 읽지 않는다. 체인이 끝나면 실행 캐시를 삭제한다.
// - 한 학생이 실패해도 이름과 오류를 남기고 다음 학생을 계속 처리한다.

import { createSendLogEntry, getBotUserId, notionGetPage, resolveAdminKeyFromRequest } from "../_shared/adminShared.ts"
import {
  getFormulaText,
  getEffectiveAdminKey,
  resolveParentPhone,
  sendDailyReportAlimtalk,
  appendSendLog,
  setAttendanceReportSendingFlag,
  setAttendanceReportLastError,
  setAttendanceReportCompleteFlag,
} from "../_shared/alimtalkShared.ts"
import { refreshDailyReportForSend } from "../_shared/dailyReportRefresh.ts"
import {
  cleanupExpiredReportPageCache,
  clearPersistentReportPageCache,
} from "../_shared/persistentReportPageCache.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"
import { isRunning, markRunning, markDone, markError, type StatusSpec } from "../_shared/statusTracking.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

const FUNCTIONS_BASE = `${Deno.env.get("SB_URL") ?? ""}/functions/v1`
const CONTINUATION_FLAG = "isContinuation"
const CHAIN_BUDGET_MS = 30 * 60 * 1000
const CONTINUATION_TIMEOUT_MS = 30_000

const CLASS_BULK_SEND_STATUS_SPEC: StatusSpec = {
  statusProp: "보고서 일괄전송 상태",
  errorProp: "마지막 오류",
  startedAtProp: "보고서 일괄전송 처리 시작 시각",
}

async function finishClassBulkSend(classId: string, message: string | null): Promise<void> {
  try {
    if (message) await markError(classId, CLASS_BULK_SEND_STATUS_SPEC, message)
    else await markDone(classId, CLASS_BULK_SEND_STATUS_SPEC)
  } catch (_e) {
    // 상태 표시 실패가 이미 완료된 개별 발송 결과를 바꾸지는 않는다.
  }
}

async function sendOneStudentReport(
  attendanceId: string,
  sharedRunKey: string,
  clickerUserId?: string | null,
): Promise<{ studentName: string; skipped?: boolean }> {
  await setAttendanceReportSendingFlag(attendanceId, true)

  try {
    const attendancePage = await notionGetPage(attendanceId)
    const registrationId = attendancePage.properties?.["등록"]?.relation?.[0]?.id ?? null
    const studentName = getFormulaText(attendancePage, "학생이름(보고서)") || "(이름 미상)"

    if (!registrationId) throw new Error("등록 관계가 비어 있습니다.")

    // 이미 보낸 학생은 토큰/출석/캐시 작업 없이 건너뛴다. 재발송은 기존 정책대로
    // 출석 페이지의 '전송완료 체크'를 해제한 뒤 버튼을 다시 누르면 된다.
    const alreadySent = attendancePage.properties?.["전송완료 체크"]?.checkbox === true
    if (alreadySent) {
      await setAttendanceReportSendingFlag(attendanceId, false)
      return { studentName, skipped: true }
    }

    const { access_token } = await refreshDailyReportForSend(registrationId, { sharedRunKey })

    const className = getFormulaText(attendancePage, "클래스(보고서)")
    const classDate = getFormulaText(attendancePage, "수업일(보고서)")
    const attendanceStatus = getFormulaText(attendancePage, "출석상태(보고서)")
    const studyContent = getFormulaText(attendancePage, "학습 내용(보고서)")
    const parentPhone = await resolveParentPhone(attendancePage, registrationId)

    const REPORT_PATH = Deno.env.get("REPORT_PATH") ?? "/project1/student_report.html"
    const tokenQueryString = REPORT_PATH + "?token=" + access_token
    const variables: Record<string, string> = {
      "#{학생이름}": studentName,
      "#{클래스}": className,
      "#{수업일}": classDate,
      "#{출석상태}": attendanceStatus,
      "#{학습내용}": studyContent,
      "#{페이지ID}": tokenQueryString,
    }

    const botUserId =
      clickerUserId ??
      attendancePage.properties?.["실행자"]?.people?.[0]?.id ??
      (await getBotUserId().catch(() => null))

    try {
      await sendDailyReportAlimtalk({ to: parentPhone, variables })
    } catch (sendErr) {
      await createSendLogEntry({
        registrationId,
        attendanceId,
        senderUserId: botUserId ?? undefined,
        title: studentName || "일일 보고서",
        category: "일일 보고서",
        status: "실패",
        failReason: String((sendErr as any)?.message ?? sendErr),
      })
      throw sendErr
    }

    await appendSendLog(attendancePage)
    await createSendLogEntry({
      registrationId,
      attendanceId,
      senderUserId: botUserId ?? undefined,
      title: studentName || "일일 보고서",
      category: "일일 보고서",
      status: "성공",
    })

    await setAttendanceReportLastError(attendanceId, null)
    await setAttendanceReportCompleteFlag(attendanceId, true)
    await setAttendanceReportSendingFlag(attendanceId, false)
    return { studentName }
  } catch (err) {
    await setAttendanceReportLastError(attendanceId, String((err as any)?.message ?? err))
    await setAttendanceReportSendingFlag(attendanceId, false)
    throw err
  }
}

type ChainState = {
  classSessionId: string
  remainingAttendanceIds: string[]
  clickerUserId: string | null
  runKey: string
  chainStartedAt: number
  successCount: number
  failedNames: string[]
  skippedNames: string[]
}

function finalMessage(state: ChainState): string | null {
  const messages: string[] = []
  if (state.failedNames.length) {
    messages.push(`${state.failedNames.length}명 실패: ${state.failedNames.join(", ")}`)
  }
  if (state.skippedNames.length) {
    messages.push(`${state.skippedNames.length}명은 이미 전송 완료되어 건너뜀: ${state.skippedNames.join(", ")}`)
  }
  return messages.length ? messages.join("\n") : null
}

async function callNext(state: ChainState, adminKey: string): Promise<void> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), CONTINUATION_TIMEOUT_MS)
  try {
    const res = await fetch(`${FUNCTIONS_BASE}/send-class-daily-reports`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
      body: JSON.stringify({ ...state, [CONTINUATION_FLAG]: true }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`다음 학생 호출 실패: ${res.status} ${await res.text()}`)
  } finally {
    clearTimeout(timeoutId)
  }
}

async function finishChain(state: ChainState, message: string | null): Promise<void> {
  await clearPersistentReportPageCache(state.runKey).catch((err) => {
    console.error("반별 보고서 실행 캐시 정리 실패:", state.runKey, (err as Error).message)
  })
  await finishClassBulkSend(state.classSessionId, message)
}

async function processOneAndContinue(state: ChainState, adminKey: string): Promise<void> {
  if (Date.now() - state.chainStartedAt > CHAIN_BUDGET_MS) {
    await finishChain(
      state,
      `전체 처리 한도(${Math.round(CHAIN_BUDGET_MS / 60000)}분)를 초과했습니다. 완료 ${state.successCount}명, 실패 ${state.failedNames.length}명. 버튼을 다시 눌러 남은 학생을 이어서 처리하세요.`,
    )
    return
  }

  const attendanceId = state.remainingAttendanceIds.shift()
  if (!attendanceId) {
    await finishChain(state, finalMessage(state))
    return
  }

  try {
    const result = await sendOneStudentReport(attendanceId, state.runKey, state.clickerUserId)
    if (result.skipped) state.skippedNames.push(result.studentName)
    else state.successCount++
  } catch (_err) {
    let name = "(알 수 없음)"
    try {
      const page = await notionGetPage(attendanceId)
      name = getFormulaText(page, "학생이름(보고서)") || name
    } catch (_e) {
      // 이름을 못 읽어도 다음 학생 처리는 계속한다.
    }
    state.failedNames.push(name)
  }

  if (!state.remainingAttendanceIds.length) {
    await finishChain(state, finalMessage(state))
    return
  }

  // 다음 호출이 시작될 때 markRunning으로 시작 시각을 갱신한다. 여기서도 중복 갱신하면
  // 학생마다 Notion PATCH가 두 번 발생하므로 호출 접수 시점의 한 번만 사용한다.
  try {
    await callNext(state, adminKey)
  } catch (err) {
    await finishChain(state, `체인 중단: ${(err as Error).message}. 버튼을 다시 누르면 전송 완료 학생은 건너뛰고 이어서 처리합니다.`)
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

  let body: any
  try {
    body = await req.json()
  } catch (_e) {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }

  const adminKey = resolveAdminKeyFromRequest(req, body)
  const effectiveAdminKey = await getEffectiveAdminKey()
  if (!adminKey || adminKey !== effectiveAdminKey) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }

  const isContinuation = body?.[CONTINUATION_FLAG] === true
  if (isContinuation) {
    const state: ChainState = {
      classSessionId: String(body?.classSessionId ?? ""),
      remainingAttendanceIds: Array.isArray(body?.remainingAttendanceIds) ? body.remainingAttendanceIds : [],
      clickerUserId: body?.clickerUserId ?? null,
      runKey: String(body?.runKey ?? ""),
      chainStartedAt: Number(body?.chainStartedAt ?? Date.now()),
      successCount: Number(body?.successCount ?? 0),
      failedNames: Array.isArray(body?.failedNames) ? body.failedNames : [],
      skippedNames: Array.isArray(body?.skippedNames) ? body.skippedNames : [],
    }
    if (!state.classSessionId || !state.runKey) {
      return new Response(JSON.stringify({ error: "invalid continuation state" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }
    await markRunning(state.classSessionId, CLASS_BULK_SEND_STATUS_SPEC)
    runInBackground(() => processOneAndContinue(state, adminKey))
    return respondAccepted({ classSessionId: state.classSessionId, remaining: state.remainingAttendanceIds.length })
  }

  const classSessionId: string | null = body?.data?.id ?? body?.classSessionId ?? null
  if (!classSessionId) {
    return new Response(JSON.stringify({ error: "classSessionId required" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }

  try {
    const classPage = await notionGetPage(classSessionId)
    if (isRunning(classPage, CLASS_BULK_SEND_STATUS_SPEC)) {
      return new Response(JSON.stringify({ ok: true, message: "already_processing", classSessionId }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    await markRunning(classSessionId, CLASS_BULK_SEND_STATUS_SPEC)

    const attendanceRelation = body?.data?.properties?.["출석"]?.relation ?? classPage.properties?.["출석"]?.relation ?? []
    const attendanceIds: string[] = attendanceRelation.map((r: any) => r.id).filter(Boolean)
    if (!attendanceIds.length) {
      await finishClassBulkSend(classSessionId, "이 수업에 연결된 출석 학생이 없습니다.")
      return new Response(JSON.stringify({ started: false, total: 0, message: "no attendance rows" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    }

    const clickerUserId: string | null =
      body?.data?.properties?.["실행자"]?.people?.[0]?.id ??
      classPage.properties?.["실행자"]?.people?.[0]?.id ??
      null

    const state: ChainState = {
      classSessionId,
      remainingAttendanceIds: [...new Set(attendanceIds)],
      clickerUserId,
      runKey: `${classSessionId}:${crypto.randomUUID()}`,
      chainStartedAt: Date.now(),
      successCount: 0,
      failedNames: [],
      skippedNames: [],
    }

    // 비정상 종료로 남은 오래된 실행 캐시는 다음 정상 실행 시작 때 정리한다.
    await cleanupExpiredReportPageCache().catch((err) => {
      console.error("만료된 보고서 실행 캐시 정리 실패:", (err as Error).message)
    })

    runInBackground(() => processOneAndContinue(state, adminKey))
    return respondAccepted({ classSessionId, total: state.remainingAttendanceIds.length })
  } catch (err) {
    await finishClassBulkSend(classSessionId, String((err as any)?.message ?? err))
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    })
  }
})

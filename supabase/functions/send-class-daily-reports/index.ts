// supabase/functions/send-class-daily-reports/index.ts (v2)
// 하나의 수업(학원) DB 페이지에 연결된 모든 출석 학생에게 일일 보고서 AlimTalk을 일괄 전송합니다.
// - send-daily-report와 동일한 syncStudentReport/발송/로그 로직을 각 출석 건마다 반복 실행합니다.
// - 개별 학생 전송 실패가 있어도 나머지 학생 전송은 계속 진행합니다 (부분 성공 허용).
// - 진행 중에는 수업 페이지의 "보고서 일괄전송 상태"를 🔄 작업중으로 바꿔서 "실시간 처리 상태" 수식에
//   표시되게 하고, 완료 후 ✅ 완료(전원 성공) 또는 ⚠️ 오류(실패/건너뜀 있음)로 반영합니다.
//   (2026-09-22, 처리 상태 관리 리팩토링 Phase 3 — 기존 "보고서 일괄전송중" checkbox 대체, 마스터플랜 참고)
// - 실패한 학생이 있으면 수업 페이지의 "마지막 오류"에 요약("N명 중 M명 실패: 이름1, 이름2")을 남기고,
//   전원 성공하면 그 필드를 비웁니다.
// - Notion 버튼의 "웹훅 보내기" 액션은 커스텀 헤더를 보낼 수 없으므로, x-admin-key 헤더가 없으면
//   요청 바디의 adminKey 필드도 확인합니다 (send-daily-report와 동일한 패턴).
// - [v2, 2026-09-16] send-daily-report와 100% 중복이던 헬퍼(getEffectiveAdminKey/getFormulaText/
//   resolveParentPhone/syncStudentReport/sendDailyReportAlimtalk/appendSendLog/출석 상태 표시 3종)를
//   _shared/alimtalkShared.ts로 옮기고 이 파일에서는 가져다 씁니다 (로드맵 5-9 공용 모듈화 후속).
//   동작은 이전과 동일합니다.

import { createSendLogEntry, getBotUserId, notionGetPage, resolveAdminKeyFromRequest } from "../_shared/adminShared.ts"
import {
  getFormulaText,
  getEffectiveAdminKey,
  resolveParentPhone,
  syncStudentReport,
  sendDailyReportAlimtalk,
  appendSendLog,
  setAttendanceReportSendingFlag,
  setAttendanceReportLastError,
  setAttendanceReportCompleteFlag,
} from "../_shared/alimtalkShared.ts"
import { markRunning, markDone, markError, type StatusSpec } from "../_shared/statusTracking.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

// --- 수업(학원) DB 페이지 단위 상태 표시 (이 함수 전용, 다른 파일과 중복되지 않음) ---
// (2026-09-22, 처리 상태 관리 리팩토링 Phase 3) 기존 "보고서 일괄전송중" checkbox +
// "마지막 오류" text 조합을 "보고서 일괄전송 상태"(select) + "보고서 일괄전송 처리 시작 시각"(date)로
// 전환. 기존 checkbox는 폐기. 마스터플랜 참고.
const CLASS_BULK_SEND_STATUS_SPEC: StatusSpec = {
  statusProp: "보고서 일괄전송 상태",
  errorProp: "마지막 오류",
  startedAtProp: "보고서 일괄전송 처리 시작 시각",
}

async function setClassBulkSendingFlag(classId: string, sending: boolean): Promise<void> {
  try {
    if (sending) {
      await markRunning(classId, CLASS_BULK_SEND_STATUS_SPEC)
    }
    // sending=false는 항상 finishClassBulkSend(아래)를 통해 처리한다 -- 완료 시점의 메세지
    // 유무에 따라 markDone/markError를 골라야 하므로, 여기서는 아무것도 하지 않는다.
  } catch (_e) {
    // 상태 표시 실패는 전송 자체를 막지 않습니다.
  }
}

// 기존 코드는 "마지막 오류 메세지 기록" + "일괄전송중 끄기"를 항상 순서대로 별도 호출했다. select
// 모델에서는 이 두 가지를 한 번에 결정해야 하므로(메세지가 있으면 ⚠️ 오류, 없으면 ✅ 완료) 하나의
// 헬퍼로 합쳤다.
async function finishClassBulkSend(classId: string, message: string | null): Promise<void> {
  try {
    if (message) {
      await markError(classId, CLASS_BULK_SEND_STATUS_SPEC, message)
    } else {
      await markDone(classId, CLASS_BULK_SEND_STATUS_SPEC)
    }
  } catch (_e) {
    // 상태 표시 실패는 전송 자체를 막지 않습니다.
  }
}

// 출석 건 하나에 대한 일일 보고서 발송을 실행합니다. send-daily-report의 핵심 로직과 동일합니다.
async function sendOneStudentReport(attendanceId: string, clickerUserId?: string | null): Promise<{ studentName: string; skipped?: boolean }> {
  await setAttendanceReportSendingFlag(attendanceId, true)

  try {
    const attendancePage = await notionGetPage(attendanceId)
    const registrationId = attendancePage.properties?.["등록"]?.relation?.[0]?.id ?? null
    const studentName = getFormulaText(attendancePage, "학생이름(보고서)") || "(이름 미상)"

    if (!registrationId) {
      throw new Error("등록 관계가 비어 있습니다.")
    }

    const alreadySent = attendancePage.properties?.["전송완료 체크"]?.checkbox === true
    if (alreadySent) {
      await setAttendanceReportSendingFlag(attendanceId, false)
      return { studentName, skipped: true }
    }

    const { access_token } = await syncStudentReport(registrationId)

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

// 실제 학생별 발송/기록 루프. Notion 버튼 자동화가 응답을 기다리다 타임아웃되지 않도록,
// 이 함수는 Deno.serve 핸들러가 응답을 반환한 뒤에도 EdgeRuntime.waitUntil로 백그라운드에서 계속 실행됩니다.
async function processClassBulkSend(classSessionId: string, attendanceIds: string[], clickerUserId?: string | null): Promise<void> {
  const failedNames: string[] = []
  const skippedNames: string[] = []
  let successCount = 0

  for (const attendanceId of attendanceIds) {
    try {
      const result = await sendOneStudentReport(attendanceId, clickerUserId)
      if (result.skipped) {
        skippedNames.push(result.studentName)
      } else {
        successCount++
      }
    } catch (err) {
      let name = "(알 수 없음)"
      try {
        const page = await notionGetPage(attendanceId)
        name = getFormulaText(page, "학생이름(보고서)") || name
      } catch (_e) {
        // 이름 조회 실패는 무시하고 계속 진행합니다.
      }
      failedNames.push(name)
    }
  }

  const failCount = failedNames.length
  const messages: string[] = []
  if (failCount > 0) {
    messages.push(attendanceIds.length + "명 중 " + failCount + "명 실패: " + failedNames.join(", "))
  }
  if (skippedNames.length > 0) {
    messages.push(skippedNames.length + "명은 이미 전송 완료되어 건너뜀: " + skippedNames.join(", "))
  }
  await finishClassBulkSend(classSessionId, messages.length > 0 ? messages.join("\n") : null)
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  let body: any
  try {
    body = await req.json()
  } catch (_e) {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }

  const adminKey = resolveAdminKeyFromRequest(req, body)
  const effectiveAdminKey = await getEffectiveAdminKey()
  if (!adminKey || adminKey !== effectiveAdminKey) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }

  let classSessionId: string | null = null
  try {
    classSessionId = body?.data?.id ?? body?.classSessionId ?? null
    if (!classSessionId) {
      return new Response(JSON.stringify({ error: "classSessionId required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    await setClassBulkSendingFlag(classSessionId, true)

    let attendanceRelation = body?.data?.properties?.["출석"]?.relation ?? null
    const classPage = await notionGetPage(classSessionId)
    if (!attendanceRelation) {
      attendanceRelation = classPage.properties?.["출석"]?.relation ?? []
    }
    const attendanceIds: string[] = (attendanceRelation ?? []).map((r: any) => r.id).filter(Boolean)

    const clickerUserId: string | null =
      body?.data?.properties?.["실행자"]?.people?.[0]?.id ??
      classPage.properties?.["실행자"]?.people?.[0]?.id ??
      null

    if (attendanceIds.length === 0) {
      await finishClassBulkSend(classSessionId, "이 수업에 연결된 출석 학생이 없습니다.")
      return new Response(JSON.stringify({ started: false, total: 0, message: "no attendance rows" }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    const backgroundWork = processClassBulkSend(classSessionId, attendanceIds, clickerUserId)
    const globalScope = globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }
    if (globalScope.EdgeRuntime?.waitUntil) {
      globalScope.EdgeRuntime.waitUntil(backgroundWork)
    } else {
      backgroundWork.catch(() => {})
    }

    return new Response(
      JSON.stringify({ started: true, total: attendanceIds.length }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
    )
  } catch (err) {
    if (classSessionId) {
      await finishClassBulkSend(classSessionId, String((err as any)?.message ?? err))
    }
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})

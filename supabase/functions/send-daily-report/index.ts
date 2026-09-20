// supabase/functions/send-daily-report/index.ts (v5)
// Sends the daily study-report Kakao AlimTalk for one class day, based on a single
// row in the attendance (출석) database.
// - [v5, 2026-09-16] send-class-daily-reports와 100% 중복이던 헬퍼(getEffectiveAdminKey/
//   getFormulaText/resolveParentPhone/syncStudentReport/sendDailyReportAlimtalk/appendSendLog/
//   출석 상태 표시 3종)를 _shared/alimtalkShared.ts로 옮기고 이 파일에서는 가져다 씁니다
//   (로드맵 5-9 공용 모듈화 후속). 동작은 이전과 동일합니다.
// - [v4] Notion 버튼의 "웹훅 보내기" 액션은 커스텀 HTTP 헤더를 보낼 수 없으므로,
//   x-admin-key 헤더가 없을 경우 요청 바디의 adminKey 필드도 확인합니다.
// - [v3] pfId/템플릿ID/발신번호는 이제 "알림톡 설정(학원) DB"에서 조회합니다 (Secrets 값은 기본값으로만 사용).
// - [v3] 출석 DB의 "전송 완료"가 이제 수식(formula) 속성이므로 더 이상 그 속성을 직접 patch하지 않습니다.
//   대신 전송로그(학원) DB 행에 "출석" 관계형과 "발송자" 인물 속성을 채워서, 출석 DB의 수식이 그 값을 읽어
//   자동으로 계산하도록 합니다.

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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

  let attendanceId: string | null = null
  try {
    attendanceId = body?.data?.id ?? body?.attendanceId ?? null
    const registrationId = body?.data?.properties?.["등록"]?.relation?.[0]?.id ?? body?.registrationId ?? null
    if (!registrationId || !attendanceId) {
      return new Response(JSON.stringify({ error: "registrationId, attendanceId required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

    await setAttendanceReportSendingFlag(attendanceId, true)

    const { access_token, reportUrl } = await syncStudentReport(registrationId)

    const attendancePage = await notionGetPage(attendanceId)
    const studentName = getFormulaText(attendancePage, "학생이름(보고서)")

    const alreadySent = attendancePage.properties?.["전송완료 체크"]?.checkbox === true
    if (alreadySent) {
      await setAttendanceReportLastError(attendanceId, "이미 전송 완료된 건입니다. 다시 보내려면 '전송완료 체크'를 해제한 뒤 버튼을 눌러주세요.")
      await setAttendanceReportSendingFlag(attendanceId, false)
      return new Response(JSON.stringify({ skipped: true, message: "already sent" }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
    }

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

    const clickerUserId =
      body?.data?.properties?.["실행자"]?.people?.[0]?.id ??
      attendancePage.properties?.["실행자"]?.people?.[0]?.id ??
      null
    const botUserId = clickerUserId ?? (await getBotUserId().catch(() => null))

    let sendResult: unknown
    try {
      sendResult = await sendDailyReportAlimtalk({ to: parentPhone, variables })
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

    return new Response(JSON.stringify({ access_token, reportUrl, sendResult }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } })
  } catch (err) {
    if (attendanceId) {
      await setAttendanceReportLastError(attendanceId, String((err as any)?.message ?? err))
      await setAttendanceReportSendingFlag(attendanceId, false)
    }
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }
})

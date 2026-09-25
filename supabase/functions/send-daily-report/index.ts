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
  sendDailyReportAlimtalk,
  appendSendLog,
  setAttendanceReportSendingFlag,
  setAttendanceReportLastError,
  setAttendanceReportCompleteFlag,
} from "../_shared/alimtalkShared.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"
import { refreshDailyReportForSend } from "../_shared/dailyReportRefresh.ts"

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

  const attendanceId: string | null = body?.data?.id ?? body?.attendanceId ?? null
  const registrationId: string | null = body?.data?.properties?.["등록"]?.relation?.[0]?.id ?? body?.registrationId ?? null
  if (!registrationId || !attendanceId) {
    return new Response(JSON.stringify({ error: "registrationId, attendanceId required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } })
  }

  await setAttendanceReportSendingFlag(attendanceId, true)

  // [NEW, 2026-09-23, PART N-7: 개별 버튼 응답 지연 해소] Notion "웹훅 보내기" 버튼이 아래 전체
  // 동기 처리(보고서 캐시 동기화 + 알림톡 발송 + 로그 기록)를 기다리다 시간 초과로 "실행 실패" 토스트를
  // 띄우는 사례가 있었다 (실제로는 끝까지 정상 완료되어 카카오 메시지가 도착함 -- fix-attendance/종료
  // 처리와 동일한 원인). 이 함수는 다른 함수가 HTTP로 호출하는 경우가 없어(개별 "보고서 전송" 버튼
  // 전용) send-report처럼 동기/비동기 분기를 둘 필요 없이 전부 백그라운드로 옮긴다. "전송중" 표시는
  // 응답 전에 이미 동기로 켜 두었으므로 그대로 진행 상황을 보여준다.
  runInBackground(async () => {
    try {
      // 이미 전송한 건은 무거운 출석/캐시 최신화 전에 먼저 걸러낸다.
      const attendancePage = await notionGetPage(attendanceId)
      const studentName = getFormulaText(attendancePage, "학생이름(보고서)")

      const alreadySent = attendancePage.properties?.["전송완료 체크"]?.checkbox === true
      if (alreadySent) {
        await setAttendanceReportLastError(attendanceId, "이미 전송 완료된 건입니다. 다시 보내려면 '전송완료 체크'를 해제한 뒤 버튼을 눌러주세요.")
        await setAttendanceReportSendingFlag(attendanceId, false)
        return
      }

      // 토큰 발급 -> 출석 원본 동기화 -> 학습기록/학습활동을 포함한 보고서 캐시 생성이
      // 모두 성공한 뒤에만 알림톡을 보낸다. 최신화 실패 시 아래 catch로 이동해 전송하지 않는다.
      const { access_token, reportUrl } = await refreshDailyReportForSend(registrationId)

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

      console.log("send-daily-report finished:", attendanceId, JSON.stringify({ access_token, reportUrl, sendResult }))
    } catch (err) {
      console.error("send-daily-report background 처리 실패:", attendanceId, (err as Error).message)
      await setAttendanceReportLastError(attendanceId, String((err as any)?.message ?? err))
      await setAttendanceReportSendingFlag(attendanceId, false)
    }
  })

  return respondAccepted({ attendanceId })
})

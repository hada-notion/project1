// _shared/dailyReportQueue.ts
//
// (v2.6.20) 일일 보고서를 큐로 한 건씩 보낸다. 출석 [보고서 전송]·수업 [보고서 일괄 전송] 버튼은 출석의
// "보고서 전송 상태"를 ⚪ 대기로만 바꾸고, 출석 DB 자동화가 send-daily-report/queue로 출석마다 웹훅을 보낸다.
// process-sync-queue 워커가 한 건씩 처리하므로 연속 클릭·일괄 30명에도 Notion 호출이 몰리지 않고, 멈춘 건은
// 큐에 남아 이어서 끝난다. 빠르게보다 끝까지 정확하게.
//
// 한 건 처리(필요한 만큼만 읽기):
//   1) 출석 1번 읽기 — 두 번 발송 막기(전송완료 체크)와 보고서 수식 값·연락처·리포트 토큰(롤업)을 한 번에.
//   2) 리포트 최신화 — 학부모가 링크를 열었을 때 오늘 기록이 보이도록 발송 전에 한다(꼭 필요한 읽기). 같은 수업
//      학생들은 공용 캐시(report_source_cache, 5분 단위 실행 키)로 반 공통 학습기록·교재 페이지를 한 번만 읽는다.
//      출석의 "리포트 토큰" 롤업이 있으면 등록을 다시 읽지 않는다.
//   3) 알림톡 설정(수신 대상·템플릿)은 adminShared 캐시로 재사용, 수신 대상이 우선 연락 대상이면 출석 연락처만 쓴다.
//   4) 발송 → 전송 로그 1건 → 출석 쓰기 1번(✅ 완료, 전송완료 체크, 오류 지움).
// 발송 전 단계에서 실패하면 큐가 다시 시도한다(아직 아무것도 안 보냄). 발송 단계에서 실패하면 다시 보내지 않고
// ⚠️ 오류로 남긴다(실제로는 나갔을 수 있어, 두 번 보내지 않게 사람이 확인 후 다시 누른다).
import {
  createSendLogEntry,
  extractErrorMessage,
  getBotUserId,
  notionGetPage,
  notionPatchPageProperties,
} from "./adminShared.ts"
import { getFormulaText, sendDailyReportAlimtalk, appendSendLog } from "./alimtalkShared.ts"
import { refreshDailyReportForSend } from "./dailyReportRefresh.ts"
import { relIds } from "./notionClient.ts"
import { cleanupExpiredReportPageCache } from "./persistentReportPageCache.ts"

export const DAILY_REPORT_STATUS_PROP = "보고서 전송 상태"
const RUN_BUCKET_MS = 5 * 60 * 1000

const plain = (prop: any): string => {
  if (!prop) return ""
  if (Array.isArray(prop.rich_text)) return prop.rich_text.map((t: any) => t.plain_text ?? t.text?.content ?? "").join("")
  if (prop.type === "formula" || prop.formula) return String(prop.formula?.string ?? "")
  if (prop.type === "rollup" || prop.rollup) {
    const arr = prop.rollup?.array ?? []
    for (const v of arr) {
      const s = plain(v)
      if (s) return s
    }
  }
  return ""
}

// 출석 속성 → 보낼 값. 버튼·자동화 본문이 아니라 출석을 한 번 새로 읽은 값으로 만든다(두 번 발송 방지와 같은 읽기).
export function dailyReportFromAttendance(page: any) {
  const p = page?.properties ?? {}
  return {
    registrationId: relIds(p["등록"])[0] ?? null,
    sessionId: relIds(p["수업"])[0] ?? null,
    alreadySent: p["전송완료 체크"]?.checkbox === true,
    studentName: getFormulaText(page, "학생이름(보고서)"),
    className: getFormulaText(page, "클래스(보고서)"),
    classDate: getFormulaText(page, "수업일(보고서)"),
    attendanceStatus: getFormulaText(page, "출석상태(보고서)"),
    studyContent: getFormulaText(page, "학습 내용(보고서)"),
    parentPhone: getFormulaText(page, "학부모 연락처"),
    clickerUserId: p["실행자"]?.people?.[0]?.id ?? null,
    tokenRaw: plain(p["리포트 토큰"]) || null,
  }
}

async function finish(attendanceId: string, status: "✅ 완료" | "⚠️ 오류", message: string | null, extra: Record<string, unknown> = {}) {
  await notionPatchPageProperties(attendanceId, {
    [DAILY_REPORT_STATUS_PROP]: { select: { name: status } },
    "마지막 오류": { rich_text: message ? [{ text: { content: message.slice(0, 1900) } }] : [] },
    ...extra,
  }).catch((err: unknown) => console.error("[daily-report] 출석 상태 쓰기 실패:", attendanceId, extractErrorMessage(err)))
}

// 테스트에서 무거운 리포트 최신화와 실제 발송을 바꿔 끼울 수 있게 한다.
export const dailyReportDeps = { refresh: refreshDailyReportForSend, send: sendDailyReportAlimtalk }

export async function processDailyReportQueueItem(payload: { attendanceId: string; clickerUserId?: string | null }): Promise<void> {
  const attendanceId = payload.attendanceId
  // 지난 실행의 공용 캐시(2일 지난 것)를 지운다(Supabase만, Notion 호출 아님).
  await cleanupExpiredReportPageCache().catch((err) => console.error("[daily-report] 공용 캐시 정리 실패:", extractErrorMessage(err)))
  const page = await notionGetPage(attendanceId)
  if (page?.archived || page?.in_trash) return
  const v = dailyReportFromAttendance(page)
  if (v.alreadySent) {
    return await finish(attendanceId, "⚠️ 오류", "이미 전송 완료된 건입니다. 다시 보내려면 '전송완료 체크'를 해제한 뒤 버튼을 눌러주세요.")
  }
  if (!v.registrationId) return await finish(attendanceId, "⚠️ 오류", "등록 관계가 비어 있습니다.")

  // 발송 전 단계: 실패하면 예외 → 큐 재시도(아직 보내지 않음).
  const runKey = `daily:${v.sessionId ?? "none"}:${Math.floor(Date.now() / RUN_BUCKET_MS)}`
  const { access_token } = await dailyReportDeps.refresh(v.registrationId, { sharedRunKey: runKey, tokenRaw: v.tokenRaw })
  const REPORT_PATH = Deno.env.get("REPORT_PATH") ?? "/project1/student_report.html"
  const variables: Record<string, string> = {
    "#{학생이름}": v.studentName,
    "#{클래스}": v.className,
    "#{수업일}": v.classDate,
    "#{출석상태}": v.attendanceStatus,
    "#{학습내용}": v.studyContent,
    "#{페이지ID}": REPORT_PATH + "?token=" + access_token,
  }
  const senderUserId = (payload.clickerUserId ?? v.clickerUserId ?? (await getBotUserId().catch(() => null))) ?? undefined
  const title = v.studentName || "일일 보고서"

  // 발송 단계: 실패해도 다시 보내지 않는다(이미 나갔을 수 있음).
  try {
    await dailyReportDeps.send({ registrationId: v.registrationId, primaryPhone: v.parentPhone, variables })
  } catch (sendErr) {
    const reason = extractErrorMessage(sendErr)
    await createSendLogEntry({ registrationId: v.registrationId, attendanceId, senderUserId, title, category: "일일 보고서", status: "실패", failReason: reason })
    return await finish(attendanceId, "⚠️ 오류", reason)
  }
  await appendSendLog(page)
  await createSendLogEntry({ registrationId: v.registrationId, attendanceId, senderUserId, title, category: "일일 보고서", status: "성공" })
  await finish(attendanceId, "✅ 완료", null, { "전송완료 체크": { checkbox: true } })
  console.log("[daily-report] sent:", attendanceId)
}

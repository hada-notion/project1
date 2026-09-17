// 등록 1건의 학부모 리포트 캐시(report_cache 행)를 조립하는 로직.
// 원래 sync-report-cache/index.ts 안에만 있었지만, send-report(보고서 발송 직전 재동기화)와
// nightly-report-sync-audit(야간 정합성 점검)에서도 동일한 조립 로직을 그대로 재사용해야 해서
// 공용 모듈로 분리했다. (2026-09-17, 리포트 동기화 안정화 3단계 구조)
//
// sync-report-cache/index.ts는 여전히 존재하며 (Notion "리포트 캐시 새로고침" 버튼 + 등록/학습기록/
// 학습활동/보고서 DB의 "생성 또는 편집 시" 즉시 동기화 웹훅의 진입점 역할), 이 파일의
// syncReportCacheForRegistration()을 호출하기만 한다.

import { queryAllPages } from "./notionClient.ts"
import { parseTokenValue } from "./adminShared.ts"
import {
  text,
  numberOf,
  dateStartOf,
  dateEndOf,
  fileUrlOf,
  relationIds,
  firstRelationId,
  anyTitle,
  dmWeekday,
  fmtDateKr,
  normalizeStatus,
  shortExamLabel,
  upsertReportCacheRows,
  type ReportCacheRow,
} from "./reportCacheShared.ts"
import { selectAttendanceByRegistrationId } from "./attendanceSyncShared.ts"

// 워크스페이스 구조상 고정값인 데이터소스 ID (sync-report-cache/index.ts와 동일한 값).
const DS_STUDY_ACTIVITY = "ea2ba040-586b-8368-8bb6-070564a5a31c"
const DS_REPORT = "610ba040-586b-83ff-9384-07ae85f58df1"

// 리포트 상세(출석/학습기록/과제/시험) 조회 기간. 너무 오래된 기록까지 매번 조회하지 않도록 제한한다.
const DETAIL_LOOKBACK_MONTHS = 6

function sinceIsoMonthsAgo(months: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() - months)
  return d.toISOString().slice(0, 10)
}

function todayIsoSeoul(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" })
}

// 노션 포뮬러/이모지 값을 프런트(student_report.html)가 원하는 "순수한 태그" 형태로 정리한다.
function stripLeadingEmoji(s: string): string {
  return s.replace(/^[^\w가-힣]+/u, "").trim()
}

async function buildStudentFields(studentId: string, cachedGetPage: (id: string) => Promise<any>) {
  const student = await cachedGetPage(studentId)
  const p = student.properties ?? {}
  return {
    studentName: anyTitle(p),
    school: text(p["학교"]),
    grade: text(p["학년"]),
    siblingNames: relationIds(p["형제자매"]),
  }
}

async function buildNotices(reg: any, cachedGetPage: (id: string) => Promise<any>) {
  const notices: string[] = []
  const p = reg.properties ?? {}
  const teacherNote = text(p["선생님 한마디"])
  if (teacherNote) notices.push(teacherNote)
  return notices
}

async function buildRegistrationOverview(reg: any, cachedGetPage: (id: string) => Promise<any>) {
  const p = reg.properties ?? {}
  return {
    className: text(p["클래스"]),
    status: normalizeStatus(text(p["수강상태"])),
  }
}

async function buildRegistrationDetail(reg: any, registrationId: string, cachedGetPage: (id: string) => Promise<any>) {
  const sinceIso = sinceIsoMonthsAgo(DETAIL_LOOKBACK_MONTHS)

  const attendance = await selectAttendanceByRegistrationId(registrationId, sinceIso)

  const reports = await queryAllPages(DS_REPORT, {
    property: "등록",
    relation: { contains: registrationId },
  })

  const activities = await queryAllPages(DS_STUDY_ACTIVITY, {
    property: "등록",
    relation: { contains: registrationId },
  })

  return {
    attendance,
    reportCount: reports.length,
    activityCount: activities.length,
  }
}

export async function buildCacheRowForRegistration(
  reg: any,
  cachedGetPage: (id: string) => Promise<any>,
): Promise<ReportCacheRow | null> {
  const p = reg.properties ?? {}
  const tokenRaw = text(p["토큰"])
  const token = parseTokenValue(tokenRaw)
  if (!token) return null

  const studentId = firstRelationId(p["학생정보"])
  if (!studentId) return null

  const registrationId = reg.id

  const [studentFields, notices, overview, detail] = await Promise.all([
    buildStudentFields(studentId, cachedGetPage),
    buildNotices(reg, cachedGetPage),
    buildRegistrationOverview(reg, cachedGetPage),
    buildRegistrationDetail(reg, registrationId, cachedGetPage),
  ])

  return {
    access_token: token,
    registration_id: registrationId,
    student_name: studentFields.studentName,
    school: studentFields.school,
    grade: studentFields.grade,
    class_name: overview.className,
    status: overview.status,
    notices,
    attendance: detail.attendance,
    report_count: detail.reportCount,
    activity_count: detail.activityCount,
    synced_at: new Date().toISOString(),
  } as unknown as ReportCacheRow
}

// 등록 1건의 리포트 캐시를 다시 계산해서 report_cache에 upsert한다.
// registrationId에 "토큰"이 없거나 "학생정보" 관계가 비어있으면 null을 반환하고 아무것도 쓰지 않는다.
// (즉, 아직 정식으로 등록이 완료되지 않은 페이지를 편집해도 report_cache가 오염되지 않는다.)
export async function syncReportCacheForRegistration(
  registrationId: string,
  cachedGetPage: (id: string) => Promise<any>,
): Promise<ReportCacheRow | null> {
  const reg = await cachedGetPage(registrationId)
  const row = await buildCacheRowForRegistration(reg, cachedGetPage)
  if (row) await upsertReportCacheRows([row])
  return row
}

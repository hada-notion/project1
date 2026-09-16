// POST /functions/v1/sync-report-cache
// body: { registrationId: string }   -- 등록 1건만 다시 계산 (등록(학원) DB의 "리포트 캐시 새로고침" 버튼 → 웹훅)
// body: { mode: "all" }              -- 토큰이 있는 모든 등록을 다시 계산 (GitHub Actions cron용, x-admin-key 헤더 필요)
//
// 등록(학원)/학생(학원)/성적(학원)/일정(학원)/진도교재(학원)/출석(학원)/학습기록(학원)/
// 학습활동(학원)/보고서(학원) DB를 읽어서 report_cache에 upsert한다.
//
// (2026-09-16, 원자료 아키텍처 1단계) 출석 데이터는 더 이상 이 함수가 Notion을 직접 조회하지 않는다.
// sync-attendance Edge Function이 미리 attendance_records(Supabase)에 증분으로 채워둔 원자료를
// attendanceSyncShared.ts로 읽어서 조립만 한다. 나머지 도메인(학습기록/과제·시험/성적/공지)은
// 다음 단계에서 같은 패턴으로 옮길 계획이며, 그전까지는 기존처럼 Notion을 직접 조회한다.
import { requireAdminKey, CORS_HEADERS as ADMIN_CORS } from "../_shared/adminShared.ts"
import { getPage, queryAllPages, mapWithConcurrency, extractPageId } from "../_shared/notionClient.ts"
import { parseTokenValue } from "../_shared/adminShared.ts"
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
  makePageCache,
  upsertReportCacheRows,
  type ReportCacheRow,
} from "../_shared/reportCacheShared.ts"
import { selectAttendanceByRegistrationId } from "../_shared/attendanceSyncShared.ts"

// 워크스페이스 구조상 고정값인 데이탅소스 ID (_shared/constants.ts 및 generateShared.ts와 동일한 값).
const DS_REGISTRATION = "16dba040-586b-838a-ae3c-876c0e9cd474"
const DS_STUDY_ACTIVITY = "ea2ba040-586b-8368-8bb6-070564a5a31c"
const DS_REPORT = "610ba040-586b-83ff-9384-07ae85f58df1"

// 리포트 상세(출석/학습기록/과제/시험) 조회 기간. 너무 오래된 기록까지 매번 쉽지 않게 6개월로 제한한다.
const DETAIL_LOOKBACK_MONTHS = 6

function sinceIsoMonthsAgo(months: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() - months)
  return d.toISOString().slice(0, 10)
}

function todayIsoSeoul(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" })
}

// 녹션 포믈럼/이모지 값을 프런트(student_report.html)가 원하는 "순순한 태그" 형태로 정리한다.
// 프런트의 mapRegistration()은 reg.status 값을 리턴적으로 "수강 종료"/"수강 대기"(간공 포함)와 정확히 버그를로 이 그대로 매지한다. (이모지만 제거하고 간공은 원문 그다로 유지해야 한다: "수강 중" / "수강 종료" / "수강 대기")
function stripLeadingEmoji(s: string): string {
  return s.replace(/^[^\w가-힣]+/u, "").trim()
}

async function buildStudentFields(studentId: string, cachedGetPage: (id: string) => Promise<any>) {
  const student = await cachedGetPage(studentId)
  const sp = student.properties
  const studentName = text(sp["학생이름"])
  const schoolText = text(sp["학교(설문)"])
  const gradeText = text(sp["학년(설문)"])
  const studentPhone = text(sp["학생 연락처"])
  const motherPhone = text(sp["어머니 연락처"])
  const fatherPhone = text(sp["아버지 연락처"])
  const primaryContact = text(sp["학부모 연락처"]) || text(sp["주요 연락처"])

  const siblingIds = relationIds(sp["형제/자매"])
  const siblings = await Promise.all(
    siblingIds.map(async (sid: string) => {
      const sib = await cachedGetPage(sid)
      const sibProps = sib.properties
      const sibName = text(sibProps["학생이름"])
      const sibRegIds = relationIds(sibProps["등록"])
      let sibRegPage: any = null
      for (const rid of sibRegIds) {
        const r = await cachedGetPage(rid)
        if (text(r.properties["수강상태"]).includes("수강 중")) {
          sibRegPage = r
          break
        }
      }
      if (!sibRegPage && sibRegIds[0]) sibRegPage = await cachedGetPage(sibRegIds[0])
      const rawToken = sibRegPage ? text(sibRegPage.properties["토큰"]) : ""
      const { accessToken } = parseTokenValue(rawToken)
      return { name: sibName, registration_id: sibRegPage?.id ?? null, access_token: accessToken }
    }),
  )

  const gradeIds = relationIds(sp["성적"])
  const gradePages = await Promise.all(gradeIds.map((id: string) => cachedGetPage(id)))
  let grades = await Promise.all(
    gradePages.map(async (gp: any) => {
      const gpr = gp.properties
      const scopeId = firstRelationId(gpr["시험범위"])
      let examTitle = "",
        gradeLabel = "",
        subject = "",
        iso: string | null = null
      if (scopeId) {
        const scope = await cachedGetPage(scopeId)
        examTitle = text(scope.properties["이름"])
        subject = text(scope.properties["과목"])
        iso = dateStartOf(scope.properties["시험일"])
        const scopeGradeId = firstRelationId(scope.properties["학년"])
        if (scopeGradeId) {
          const gradePage = await cachedGetPage(scopeGradeId)
          gradeLabel = anyTitle(gradePage)
        }
      }
      const title = shortExamLabel(examTitle, gradeLabel) || text(gpr["이름"])
      return {
        title,
        score: numberOf(gpr["점수"]),
        rank: numberOf(gpr["등수"]),
        total: numberOf(gpr["응시인원"]),
        percentile: numberOf(gpr["백분률"]),
        level: text(gpr["등급"]),
        subject,
        iso,
        date: fmtDateKr(iso),
      }
    }),
  )
  grades = grades.sort((a, b) => ((a.iso ?? "") < (b.iso ?? "") ? 1 : -1)).slice(0, 10)

  return {
    student_name: studentName,
    school_grade: `${schoolText} ${gradeText}`.trim(),
    student_phone: studentPhone,
    mother_phone: motherPhone,
    father_phone: fatherPhone,
    primary_contact: primaryContact,
    siblings,
    grades,
    issued_at: new Date().toISOString(),
  }
}

async function buildNotices(classId: string | undefined, cachedGetPage: (id: string) => Promise<any>) {
  if (!classId) return []
  const cls = await cachedGetPage(classId)
  const noticeIds = relationIds(cls.properties["일정"])
  const sinceIso = sinceIsoMonthsAgo(DETAIL_LOOKBACK_MONTHS)
  const noticePages = await Promise.all(noticeIds.map((id: string) => cachedGetPage(id)))
  return noticePages
    .filter((n: any) => {
      const category = text(n.properties["구분"])
      if (category.includes("할일")) return false
      const startIso = dateStartOf(n.properties["날짜"])
      return !!startIso && startIso >= sinceIso
    })
    .map((n: any) => {
      const np = n.properties
      const category = text(np["구분"])
      const icon = category.split(" ")[0] || "📌"
      const start = dateStartOf(np["날짜"])
      const end = dateEndOf(np["날짜"])
      const range = start ? (end && end !== start ? `${fmtDateKr(start)} ~ ${fmtDateKr(end)}` : fmtDateKr(start)) : ""
      const memo = text(np["메모"])
      return {
        icon,
        category,
        date: start,
        title: text(np["이름"]) || category,
        body: [range, memo].filter(Boolean).join(" · "),
      }
    })
    .sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")))
}

async function buildRegistrationOverview(reg: any, accessToken: string, cachedGetPage: (id: string) => Promise<any>) {
  const p = reg.properties
  // 원문 예: "🟡 수강 대기" / "🔴 수강 종료" / "🟢 수강 중" -- 이모지만 제거하고 간공은 유지해야 프런트가 정확히 인식한다.
  const status = stripLeadingEmoji(text(p["수강상태"])) || "수강 중"
  const startDate = dateStartOf(p["등록일"])
  const endDate = dateStartOf(p["종료일"])

  const classId = firstRelationId(p["클래스"])
  let className = "",
    teacherName = ""
  if (classId) {
    const cls = await cachedGetPage(classId)
    const cp = cls.properties
    className = [text(cp["이모지"]), text(cp["클래스명"])].filter(Boolean).join(" ")
    const teacherId = firstRelationId(cp["담당강사"])
    if (teacherId) {
      const teacher = await cachedGetPage(teacherId)
      teacherName = anyTitle(teacher)
    }
  }

  const scheduleIds = relationIds(p["시간표"])
  const schedulePages = await Promise.all(scheduleIds.map((id: string) => cachedGetPage(id)))
  const schedule = schedulePages.map((sp: any) => ({
    day: text(sp.properties["요일"]),
    start: text(sp.properties["등원시간(HH:mm)"]),
    end: text(sp.properties["하원시간(HH:mm)"]),
  }))

  const materialIds = relationIds(p["진도교재"])
  const materialPages = await Promise.all(materialIds.map((id: string) => cachedGetPage(id)))
  let classMode = ""
  const books = await Promise.all(
    materialPages
      .filter((mp: any) => !text(mp.properties["진행상태"]).includes("미사용"))
      .map(async (mp: any) => {
        const bp = mp.properties
        if (!classMode) classMode = text(bp["진도방식"])
        const statusText = text(bp["진행상태"])
        const progressRaw = numberOf(bp["진행도"])
        const progress = progressRaw != null ? Math.round(progressRaw * 100) : null
        const range = text(bp["최근 학습 범위"])
        const regularId = firstRelationId(bp["정규교재"])
        let title = "",
          series = "",
          pages: number | null = null,
          cover: string | undefined,
          units: string[] = []
        if (regularId) {
          const rb = await cachedGetPage(regularId)
          const rp = rb.properties
          title = text(rp["교재명"])
          series = text(rp["시리즈"])
          pages = numberOf(rp["전체 페이지"])
          cover = fileUrlOf(rp["북커버"])
          const unitIds = relationIds(rp["단원목록"])
          const unitPages = await Promise.all(unitIds.map((id: string) => cachedGetPage(id)))
          units = unitPages.map((up: any) => anyTitle(up)).filter(Boolean)
        }
        return { title, series, pages, status: statusText, progress, range, cover, units }
      }),
  )

  const notices = await buildNotices(classId, cachedGetPage)

  return {
    access_token: accessToken,
    class_name: className,
    class_mode: classMode,
    teacher_name: teacherName,
    status,
    start_date: startDate,
    end_date: endDate,
    schedule,
    books,
    notices,
  }
}

async function buildRegistrationDetail(reg: any, cachedGetPage: (id: string) => Promise<any>) {
  const registrationId = reg.id
  const sinceIso = sinceIsoMonthsAgo(DETAIL_LOOKBACK_MONTHS)
  const todayIso = todayIsoSeoul()

  const classId = firstRelationId(reg.properties["클래스"])
  let teacherName = ""
  if (classId) {
    const cls = await cachedGetPage(classId)
    const teacherId = firstRelationId(cls.properties["담당강사"])
    if (teacherId) {
      const teacher = await cachedGetPage(teacherId)
      teacherName = anyTitle(teacher)
    }
  }

  // (2026-09-16, 원자료 아키텍처 1단계) 더 이상 Notion 출석 DB를 직접 조회하지 않는다.
  // sync-attendance Edge Function이 미리 attendance_records(Supabase)에 증분으로 채워둔
  // 원자료를 읽어서 조립만 한다.
  const attendanceRows = await selectAttendanceByRegistrationId(registrationId, `${sinceIso}T00:00:00+09:00`)

  const attendanceEntries = attendanceRows
    .map((r) => {
      const iso = r.class_iso
      const { dm, wd } = dmWeekday(iso)
      return {
        id: r.notion_page_id,
        iso,
        date: dm,
        weekday: wd,
        status: r.status,
        in: r.check_in,
        out: r.check_out,
        comment: r.teacher_comment,
      }
    })
    .filter((e) => e.iso)
    .sort((a, b) => (a.iso! < b.iso! ? 1 : -1))

  const now = new Date()
  const thisMonthEntries = attendanceEntries.filter((e) => {
    const d = new Date(e.iso!)
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
  })
  const attendance_summary = {
    present: thisMonthEntries.filter((e) => e.status === "출석").length,
    makeup: thisMonthEntries.filter((e) => e.status === "보강").length,
    absent: thisMonthEntries.filter((e) => e.status === "결석").length,
  }

  const attendance_rows = attendanceEntries
    .filter((e) => (e.iso ?? "").slice(0, 10) <= todayIso)
    .slice(0, 200)
    .map((e) => ({ iso: e.iso, date: e.date, weekday: e.weekday, status: e.status, in: e.in, out: e.out }))

  const teacher_comments = attendanceEntries
    .filter((e) => e.comment && (e.iso ?? "").slice(0, 10) <= todayIso)
    .slice(0, 200)
    .map((e) => ({ text: e.comment, iso: e.iso, date: fmtDateKr(e.iso), by: teacherName }))

  const reportPages = await queryAllPages(DS_REPORT, {
    property: "등록",
    relation: { contains: registrationId },
  })
  const report_comments = reportPages
    .map((rp: any) => {
      const rpr = rp.properties
      return {
        kind: text(rpr["보고서 구분"]),
        start: dateStartOf(rpr["보고서 기간"]),
        end: dateEndOf(rpr["보고서 기간"]),
        comment: text(rpr["선생님 한마디"]),
      }
    })
    .filter((rc) => rc.comment && rc.start && rc.start >= sinceIso)

  // 학습기록: 이 등록의 출석들에 연결된 것들을 모아서 중복 제거 (attendance_records에 이미
  // study_log_ids로 저장해둔 값을 사용 -- 출석 페이지를 다시 조회할 필요가 없다)
  const logIdSet = new Set<string>()
  attendanceRows.forEach((r) => r.study_log_ids.forEach((id: string) => logIdSet.add(id)))
  const logIds = Array.from(logIdSet)
  const logPages = await Promise.all(logIds.map((id) => cachedGetPage(id)))
  const logDetails = await Promise.all(
    logPages.map(async (lp: any) => {
      const lprops = lp.properties
      const category = text(lprops["구분"])
      const iso = dateStartOf(lprops["수업일"])
      const content = text(lprops["내용"])
      const range = text(lprops["범위"])
      const bookId = firstRelationId(lprops["교재"])
      let bookTitle = ""
      if (bookId) {
        const bp = await cachedGetPage(bookId)
        bookTitle = text(bp.properties["교재명"])
      }
      return { id: lp.id, category, iso, content, range, bookTitle }
    }),
  )

  const pastLogDetails = logDetails.filter((l) => (l.iso ?? "").slice(0, 10) <= todayIso && (l.iso ?? "") >= sinceIso)

  const study_logs = pastLogDetails
    .filter((l) => l.category === "학습")
    .sort((a, b) => ((a.iso ?? "") < (b.iso ?? "") ? 1 : -1))
    .slice(0, 12)
    .map((l) => ({ iso: l.iso, date: fmtDateKr(l.iso), book: l.bookTitle, range: l.range, unit: "", note: l.content, body: [] as unknown[] }))

  // 학습활동(과제/평가): 이 등록에 직접 연결된 것들을 조회
  const activityPages = await queryAllPages(DS_STUDY_ACTIVITY, {
    property: "등록",
    relation: { contains: registrationId },
  })
  const activities = await Promise.all(
    activityPages.map(async (ap: any) => {
      const props = ap.properties
      const attendanceId = firstRelationId(props["출석"])
      let classIso: string | null = null
      if (attendanceId) {
        const att = await cachedGetPage(attendanceId)
        classIso = dateStartOf(att.properties["수업일시"])
      }
      return {
        category: text(props["구분"]),
        dueIso: dateStartOf(props["과제 마감일"]),
        classIso,
        status: normalizeStatus(text(props["과제상태"])),
        correct: numberOf(props["정답 문항"]) ?? 0,
        total: numberOf(props["전체 문항"]) ?? 0,
        content: text(props["학습활동"]),
      }
    }),
  )

  const homeworkAll = activities
    .filter((a) => a.category === "과제" && a.classIso && a.classIso >= sinceIso && a.classIso <= todayIso)
    .map((a) => ({
      title: a.content,
      book: "",
      range: "",
      unit: "",
      note: a.content,
      iso: a.classIso,
      date: fmtDateKr(a.classIso),
      due_iso: a.dueIso,
      due: a.dueIso ? fmtDateKr(a.dueIso) : "",
      status: a.status || "미제출",
    }))
  const homework = homeworkAll.slice(0, 6)

  const homeworkDayMap: Record<string, boolean[]> = {}
  homeworkAll.forEach((h) => {
    const day = (h.iso ?? "").slice(0, 10)
    if (!day) return
    if (!homeworkDayMap[day]) homeworkDayMap[day] = []
    homeworkDayMap[day].push(h.status === "제출")
  })
  const homework_days = Object.keys(homeworkDayMap)
    .sort()
    .map((day) => {
      const flags = homeworkDayMap[day]
      const total = flags.length
      const submitted = flags.filter(Boolean).length
      const status = submitted === total ? "완료" : submitted === 0 ? "미완료" : "부분완료"
      return { date: day, status, submitted, total }
    })

  const tests = activities
    .filter((a) => a.category === "평가" && a.classIso && a.classIso >= sinceIso && a.classIso <= todayIso)
    .slice(0, 6)
    .map((a) => ({
      title: a.content,
      book: "",
      range: "",
      unit: "",
      note: a.content,
      iso: a.classIso,
      date: fmtDateKr(a.classIso),
      correct: a.correct,
      total: a.total,
    }))

  return {
    attendance_summary,
    attendance_rows,
    study_logs,
    homework,
    homework_days,
    tests,
    teacher_comments,
    report_comments,
    updated_at: new Date().toISOString(),
  }
}

async function buildCacheRowForRegistration(reg: any, cachedGetPage: (id: string) => Promise<any>): Promise<ReportCacheRow | null> {
  const rawToken = text(reg.properties["토큰"])
  if (!rawToken) return null
  const { accessToken, disabled } = parseTokenValue(rawToken)
  if (!accessToken) return null
  const studentId = firstRelationId(reg.properties["학생정보"])
  if (!studentId) return null

  const [studentFields, overview, detail] = await Promise.all([
    buildStudentFields(studentId, cachedGetPage),
    buildRegistrationOverview(reg, accessToken, cachedGetPage),
    buildRegistrationDetail(reg, cachedGetPage),
  ])

  return {
    access_token: accessToken,
    registration_id: reg.id,
    student_key: studentId,
    link_disabled: !!disabled,
    student_fields: studentFields,
    registration_overview: overview,
    registration_detail: detail,
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: ADMIN_CORS })

  try {
    const body = await req.json().catch(() => ({}))
    const cachedGetPage = makePageCache()

    let registrations: any[] = []
    if (body?.mode === "all") {
      // 예약 동기화(GitHub Actions cron)만 이 경로를 쓰므로 관리자 키로 보호한다.
      const authError = await requireAdminKey(req)
      if (authError) return authError
      registrations = await queryAllPages(DS_REGISTRATION, {
        property: "토큰",
        rich_text: { is_not_empty: true },
      })
    } else {
      // Notion 버튼(웹훅 보내기)에서 호출하는 경로 -- 다른 버튼들과 동일하게 별도 인증 없이 신뢰한다.
      const registrationId = (typeof body?.registrationId === "string" && body.registrationId) || extractPageId(body)
      if (!registrationId) throw new Error("registrationId를 찾을 수 없습니다.")
      const reg = await getPage(registrationId)
      registrations = [reg]
    }

    const rows = await mapWithConcurrency(registrations, 4, (reg) => buildCacheRowForRegistration(reg, cachedGetPage))
    const validRows = rows.filter((r): r is ReportCacheRow => r !== null)

    await upsertReportCacheRows(validRows)

    return new Response(JSON.stringify({ synced: validRows.length, skipped: rows.length - validRows.length }), {
      headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500,
      headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
    })
  }
})

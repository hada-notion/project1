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
  kstDateOf,
  normalizeStatus,
  upsertReportCacheRows,
  type ReportCacheRow,
} from "./reportCacheShared.ts"
import { selectAttendanceByRegistrationId } from "./attendanceSyncShared.ts"
import { DS_STUDY_ACTIVITY, DS_REPORT } from "./constants.ts"
// (2026-09-21, 이식성 리팩토링) 위 2개도 constants.ts로 이동함 — 그 파일 상단 주석 참고.

const DETAIL_LOOKBACK_MONTHS = 6

function sinceIsoMonthsAgo(months: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() - months)
  return d.toISOString().slice(0, 10)
}

function todayIsoSeoul(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" })
}

function stripLeadingEmoji(s: string): string {
  return s.replace(/^[^\w가-힣]+/u, "").trim()
}

// 반별 전송의 영속 실행 캐시는 queryAllPages가 이미 반환한 페이지도 seed()로 공유한다.
// 일반 메모리 캐시에는 seed가 없으므로 기존처럼 원본 결과를 그대로 사용한다.
async function shareQueriedPages(pages: any[], cachedGetPage: (id: string) => Promise<any>): Promise<any[]> {
  const seed = (cachedGetPage as ((id: string) => Promise<any>) & { seed?: (page: any) => Promise<any> }).seed
  return seed ? await Promise.all(pages.map((page) => seed(page))) : pages
}

async function buildStudentNotices(
  studentId: string,
  studentProps: any,
  cachedGetPage: (id: string) => Promise<any>,
) {
  const studentNoticeIds = relationIds(studentProps["학원일정"])

  const schoolId = firstRelationId(studentProps["학교"])
  const gradeId = firstRelationId(studentProps["학년"])
  const [schoolPage, gradePage] = await Promise.all([
    schoolId ? cachedGetPage(schoolId) : Promise.resolve(null),
    gradeId ? cachedGetPage(gradeId) : Promise.resolve(null),
  ])
  const schoolNoticeIds = schoolPage ? relationIds(schoolPage.properties["일정"]) : []
  const gradeNoticeIds = gradePage ? relationIds(gradePage.properties["일정"]) : []

  const registrationIds = relationIds(studentProps["등록"])
  const registrations = await Promise.all(registrationIds.map((id: string) => cachedGetPage(id)))
  const activeClassIds = Array.from(
    new Set(
      registrations
        .filter((r: any) => text(r.properties["수강상태"]).includes("수강 중"))
        .map((r: any) => firstRelationId(r.properties["클래스"]))
        .filter((id): id is string => Boolean(id)),
    ),
  )
  const classPages = await Promise.all(activeClassIds.map((id: string) => cachedGetPage(id)))
  const classNoticeIds = classPages.flatMap((c: any) => relationIds(c.properties["일정"]))

  const directIds = new Set<string>([...studentNoticeIds, ...classNoticeIds])
  const candidateIds = Array.from(new Set<string>([...directIds, ...schoolNoticeIds, ...gradeNoticeIds]))
  if (!candidateIds.length) return []

  const sinceIso = sinceIsoMonthsAgo(DETAIL_LOOKBACK_MONTHS)
  const noticePages = await Promise.all(candidateIds.map((id: string) => cachedGetPage(id)))

  return noticePages
    .filter((n: any) => {
      const category = text(n.properties["구분"])
      if (category.includes("할일")) return false
      const startIso = dateStartOf(n.properties["날짜"])
      if (!startIso || startIso < sinceIso) return false
      if (directIds.has(n.id)) return true
      const noticeSchoolIds = relationIds(n.properties["학교"])
      const noticeGradeIds = relationIds(n.properties["학년"])
      const schoolMatch = noticeSchoolIds.length === 0 || (!!schoolId && noticeSchoolIds.includes(schoolId))
      const gradeMatch = noticeGradeIds.length === 0 || (!!gradeId && noticeGradeIds.includes(gradeId))
      return schoolMatch && gradeMatch
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

async function buildStudentFields(studentId: string, cachedGetPage: (id: string) => Promise<any>) {
  const student = await cachedGetPage(studentId)
  const sp = student.properties
  const studentName = text(sp["학생이름"])
  const schoolText = text(sp["학교(설문)"])
  const gradeText = text(sp["학년(설문)"])
  const studentPhone = text(sp["학생 연락처"])
  const motherPhone = text(sp["어머니 연락처"])
  const fatherPhone = text(sp["아버지 연락처"])
  const primaryContact = text(sp["우선 연락처"])

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

  const notices = await buildStudentNotices(studentId, sp, cachedGetPage)

  return {
    student_name: studentName,
    school_grade: `${schoolText} ${gradeText}`.trim(),
    student_phone: studentPhone,
    mother_phone: motherPhone,
    father_phone: fatherPhone,
    primary_contact: primaryContact,
    siblings,
    notices,
    issued_at: new Date().toISOString(),
  }
}

async function buildRegistrationOverview(reg: any, accessToken: string, cachedGetPage: (id: string) => Promise<any>) {
  const p = reg.properties
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

  const reportPages = await shareQueriedPages(
    await queryAllPages(DS_REPORT, {
      property: "등록",
      relation: { contains: registrationId },
    }),
    cachedGetPage,
  )
  const report_comments = reportPages
    .map((rp: any) => {
      const rpr = rp.properties
      return {
        id: rp.id,
        kind: text(rpr["보고서 구분"]),
        start: dateStartOf(rpr["보고서 기간"]),
        end: dateEndOf(rpr["보고서 기간"]),
        comment: text(rpr["선생님 한마디"]),
      }
    })
    .filter((rc) => rc.comment && rc.start && rc.start >= sinceIso)

  const logIdSet = new Set<string>()
  attendanceRows.forEach((r) => r.study_log_ids.forEach((id: string) => logIdSet.add(id)))
  const logIds = Array.from(logIdSet)
  const logPages = await Promise.all(logIds.map((id) => cachedGetPage(id)))
  const readLogDetail = async (lp: any) => {
    const lprops = lp.properties
    const category = text(lprops["구분"])
    const iso = dateStartOf(lprops["수업일"])
    const content = text(lprops["내용"])
    const range = text(lprops["범위"])
    const unit = text(lprops["단원"])
    const bookId = firstRelationId(lprops["교재"])
    let bookTitle = ""
    if (bookId) {
      const bp = await cachedGetPage(bookId)
      bookTitle = text(bp.properties["교재명"])
    }
    return { id: lp.id, category, iso, content, range, unit, bookTitle }
  }
  const logDetails = await Promise.all(logPages.map(readLogDetail))
  const logDetailById = new Map(logDetails.map((detail) => [detail.id, detail]))

  const pastLogDetails = logDetails.filter((l) => (l.iso ?? "").slice(0, 10) <= todayIso && (l.iso ?? "") >= sinceIso)

  const study_logs = pastLogDetails
    .filter((l) => l.category === "학습")
    .sort((a, b) => ((a.iso ?? "") < (b.iso ?? "") ? 1 : -1))
    .slice(0, 12)
    .map((l) => ({ iso: l.iso, date: fmtDateKr(l.iso), book: l.bookTitle, range: l.range, unit: l.unit, note: l.content, body: [] as unknown[] }))

  const activityPages = await shareQueriedPages(
    await queryAllPages(DS_STUDY_ACTIVITY, {
      property: "등록",
      relation: { contains: registrationId },
    }),
    cachedGetPage,
  )
  const activities = await Promise.all(
    activityPages.map(async (ap: any) => {
      const props = ap.properties
      const attendanceId = firstRelationId(props["출석"])
      const learningRecordId = firstRelationId(props["학습기록"])
      let classIso: string | null = null
      if (attendanceId) {
        const att = await cachedGetPage(attendanceId)
        classIso = dateStartOf(att.properties["수업일시"])
      }
      let source = learningRecordId ? logDetailById.get(learningRecordId) : undefined
      if (!source && learningRecordId) {
        source = await readLogDetail(await cachedGetPage(learningRecordId))
        logDetailById.set(learningRecordId, source)
      }
      return {
        category: text(props["구분"]),
        dueIso: dateStartOf(props["과제 마감일"]),
        classIso,
        status: normalizeStatus(text(props["과제상태"])),
        correct: numberOf(props["정답 문항"]) ?? 0,
        total: numberOf(props["전체 문항"]) ?? 0,
        bookTitle: source?.bookTitle ?? "",
        range: source?.range ?? "",
        unit: source?.unit ?? "",
        content: source?.content ?? "",
      }
    }),
  )

  const homeworkAll = activities
    .filter((a) => a.category === "과제" && a.classIso && a.classIso >= sinceIso && a.classIso <= todayIso)
    .map((a) => ({
      title: "",
      book: a.bookTitle,
      range: a.range,
      unit: a.unit,
      note: a.content,
      iso: a.classIso,
      date: fmtDateKr(a.classIso),
      due_iso: a.dueIso,
      due: a.dueIso ? fmtDateKr(a.dueIso) : "",
      status: a.status || "미제출",
    }))
  const homework = homeworkAll.slice(0, 6)

  // [FIX, 2026-09-19] 아래 slice(0, 10)는 UTC 기준 날짜라, 자정 근처(KST 00시~09시)에 만들어진
  // 출석 기록(수업일시)에 연결된 과제/평가는 하루 전 날짜의 "과제 현황" 칸에 잘못 표시됐다.
  // kstDateOf로 항상 Asia/Seoul 기준 날짜를 쓰도록 고친다 (reportCacheShared.ts dmWeekday/fmtDateKr
  // 수정과 동일한 원인/수정).
  const homeworkDayMap: Record<string, boolean[]> = {}
  homeworkAll.forEach((h) => {
    const day = kstDateOf(h.iso)
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
      title: "",
      book: a.bookTitle,
      range: a.range,
      unit: a.unit,
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

export async function buildCacheRowForRegistration(
  reg: any,
  cachedGetPage: (id: string) => Promise<any>,
): Promise<ReportCacheRow | null> {
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

export async function syncReportCacheForRegistration(
  registrationId: string,
  cachedGetPage: (id: string) => Promise<any>,
): Promise<ReportCacheRow | null> {
  const reg = await cachedGetPage(registrationId)
  const row = await buildCacheRowForRegistration(reg, cachedGetPage)
  if (row) await upsertReportCacheRows([row])
  return row
}

// 등록 페이지에서 수동 동기화할 때, 그 학생이 사용하는 그룹 공통 학습기록/학습활동의
// "등록" 관계를 따라가 같은 원본을 공유하는 학생을 찾는다. 원본 페이지는 cachedGetPage로
// 한 번만 읽고, 호출부가 반환된 등록을 한 명씩 순차 처리한다.
export async function resolveSharedLearningRegistrationIds(
  registrationId: string,
  cachedGetPage: (id: string) => Promise<any>,
): Promise<string[]> {
  const ids = new Set<string>([registrationId])
  const sinceIso = `${sinceIsoMonthsAgo(DETAIL_LOOKBACK_MONTHS)}T00:00:00+09:00`
  const attendanceRows = await selectAttendanceByRegistrationId(registrationId, sinceIso)
  const logIds = Array.from(new Set(attendanceRows.flatMap((row) => row.study_log_ids ?? [])))
  const logPages = await Promise.all(logIds.map((id) => cachedGetPage(id)))

  for (const page of logPages) {
    for (const id of relationIds(page.properties?.["등록"])) ids.add(id)
  }

  const activityPages = await queryAllPages(DS_STUDY_ACTIVITY, {
    property: "등록",
    relation: { contains: registrationId },
  })
  for (const page of activityPages) {
    for (const id of relationIds(page.properties?.["등록"])) ids.add(id)
  }

  return Array.from(ids)
}

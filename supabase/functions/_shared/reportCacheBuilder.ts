import { queryAllPages, mapWithConcurrency } from "./notionClient.ts"
import { routineRowsForRegistration, type RoutineRow } from "./routineCheck.ts"
import { readPageBodyBlocks } from "./feedBody.ts"
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
import { isParentPublicEvent, NOTICE_VISIBILITY_POLICY } from "./scheduleVisibility.ts"
import { selectAttendanceByRegistrationId } from "./attendanceSyncShared.ts"
import { DS_ATTENDANCE, DS_STUDY_ACTIVITY, DS_REPORT, DS_SCHEDULE_EVENT } from "./constants.ts"
import { libraryIds } from "./libraryProp.ts"
import { libraryCopyReady, readUnits } from "./libraryCopy.ts"
import { unitNamesOf, unitTextOf } from "./selectedUnits.ts"
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

// 학습기록 페이지 본문(블록) → 리포트 피드 부록 변환은 feedBody.ts로 옮겼다(v2.5.95, 수업 관리 기록 카드와 함께 쓴다).

function stripLeadingEmoji(s: string): string {
  return s.replace(/^[^\w가-힣]+/u, "").trim()
}

// 반별 전송의 영속 실행 캐시는 queryAllPages가 이미 반환한 페이지도 seed()로 공유한다.
// 일반 메모리 캐시에는 seed가 없으므로 기존처럼 원본 결과를 그대로 사용한다.
async function shareQueriedPages(pages: any[], cachedGetPage: (id: string) => Promise<any>): Promise<any[]> {
  const seed = (cachedGetPage as ((id: string) => Promise<any>) & { seed?: (page: any) => Promise<any> }).seed
  return seed ? await Promise.all(pages.map((page) => seed(page))) : pages
}

// (v2.8.0) 학부모 공개 일정은 연결 기준마다 일정 DB를 직접 조회한다(공개·숨김 해제·기간 안만).
// 예전에는 학생·클래스·학교·학년 페이지의 "일정" 관계를 읽었는데, Notion API는 페이지를 읽을 때 관계를 앞 25개까지만
// 주므로 학사일정을 많이 가져온 학교(예: 한 해 200건)는 최근 일정이 빠져 리포트에 나오지 않았다.
// 학원 전체 일정(클래스·학생·학교·학년이 모두 빈 공개 일정)도 여기서 함께 모은다. 같은 실행 안에서는 기준마다 한 번만 조회한다(1분).
export const noticeDeps = { query: queryAllPages }
const noticeQueryCache = new Map<string, { at: number; pages: Promise<any[]> }>()
export function clearNoticeCache() { noticeQueryCache.clear() }
function publicEvents(link: { prop: "학생" | "클래스" | "학교" | "학년"; id: string } | null, sinceIso: string): Promise<any[]> {
  const key = `${link ? `${link.prop}:${link.id}` : "academy"}:${sinceIso.slice(0, 10)}`
  const hit = noticeQueryCache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.pages
  const filters: Record<string, unknown>[] = [
    { property: "학부모 공개", checkbox: { equals: true } },
    { property: "숨김", checkbox: { equals: false } },
    { property: "날짜", date: { on_or_after: sinceIso.slice(0, 10) } },
  ]
  if (link) filters.unshift({ property: link.prop, relation: { contains: link.id } })
  const pages = noticeDeps.query(DS_SCHEDULE_EVENT, { and: filters })
    .then((rows: any[]) => link ? rows : rows.filter((n: any) => ["클래스", "학생", "학교", "학년"].every((k) => relationIds(n.properties?.[k]).length === 0)))
    .catch((err: unknown) => { console.warn(`[report-cache] 일정 조회 건너뜀(${key}):`, (err as Error).message); return [] })
  noticeQueryCache.set(key, { at: Date.now(), pages })
  return pages
}

export async function buildStudentNotices(
  studentId: string,
  studentProps: any,
  cachedGetPage: (id: string) => Promise<any>,
) {
  const schoolId = firstRelationId(studentProps["학교"])
  const gradeId = firstRelationId(studentProps["학년"])

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

  const sinceIso = sinceIsoMonthsAgo(DETAIL_LOOKBACK_MONTHS)
  // 학생·클래스에 직접 연결된 일정과 학원 전체 일정은 그대로 싣고, 학교·학년 일정은 아래에서 학생의 학교·학년과 맞춰 본다.
  const [studentEvents, classEvents, academyEvents, schoolEvents, gradeEvents] = await Promise.all([
    publicEvents({ prop: "학생", id: studentId }, sinceIso),
    Promise.all(activeClassIds.map((id) => publicEvents({ prop: "클래스", id }, sinceIso))).then((l) => l.flat()),
    publicEvents(null, sinceIso),
    schoolId ? publicEvents({ prop: "학교", id: schoolId }, sinceIso) : Promise.resolve([]),
    gradeId ? publicEvents({ prop: "학년", id: gradeId }, sinceIso) : Promise.resolve([]),
  ])
  const directIds = new Set<string>([...studentEvents, ...classEvents, ...academyEvents].map((n: any) => n.id))
  const byId = new Map<string, any>()
  for (const n of [...studentEvents, ...classEvents, ...academyEvents, ...schoolEvents, ...gradeEvents]) byId.set(n.id, n)
  const noticePages = await shareQueriedPages(Array.from(byId.values()), cachedGetPage)

  return noticePages
    .filter((n: any) => {
      if (!isParentPublicEvent(n)) return false
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
    notice_visibility_policy: NOTICE_VISIBILITY_POLICY,
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
        // (v2.8.0 예체능) 진도교재 `주제`(예: "기억에 남는 풍경 그리기"). 있으면 리포트가 교재명 대신 이 이름을 크게 보여 준다.
        const topic = text(bp["주제"])
        // (v2.8.0 수료) 진도교재 [수료]가 적는 날짜. 있으면 리포트 교재 상세가 "수료"로 보인다.
        const completedOn = dateStartOf(bp["수료일"])
        const regularId = libraryIds(bp)[0]
        let title = "",
          series = "",
          pages: number | null = null,
          cover: string | undefined,
          units: string[] = [],
          kind = ""
        if (regularId) {
          const rb = await cachedGetPage(regularId)
          const rp = rb.properties
          title = text(rp["교재명"])
          series = text(rp["시리즈"])
          pages = numberOf(rp["전체 페이지"])
          cover = fileUrlOf(rp["북커버"])
          // (v2.8.0 예체능) 라이브러리 구분이 프로그램이면 화면이 교재→프로그램, 단원→차시로 보여 준다(칸이 없으면 교재).
          if (text(rp["구분"]) === "프로그램") kind = "프로그램"
          // v2.5.125: 라이브러리 복사본이 있으면 단원 이름을 Supabase에서 한 번에(단원마다 Notion을 읽지 않음, 시작쪽 순).
          const copied = (await libraryCopyReady()) ? await readUnits([regularId]).catch(() => null) : null
          if (copied && copied.length) units = copied.map((u) => u.name).filter(Boolean)
          else {
            const unitIds = relationIds(rp["단원목록"])
            const unitPages = await Promise.all(unitIds.map((id: string) => cachedGetPage(id)))
            units = unitPages.map((up: any) => anyTitle(up)).filter(Boolean)
          }
        }
        // (v2.8.0) 진도교재 ID: 화면이 교재 상세를 이름이 아니라 이 ID로 묶는다(같은 교재·프로그램 2회독).
        return { id: String(mp.id).replace(/-/g, ""), title, series, pages, status: statusText, progress, range, cover, units, ...(kind ? { kind } : {}), ...(topic ? { topic } : {}), ...(completedOn ? { completed_on: completedOn } : {}) }
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

// (v2.8.0) 출석 없이 만든 평가(클래스 [평가 만들기], 평가 전용 반)의 날짜: 학습기록 '평가 기간'의 끝 날짜(하루면 그날).
// 출석 평가와 같은 모양(서울 자정 ISO)으로 돌려 기간 비교·날짜 표시가 출석 날짜와 똑같이 동작하게 한다.
export function standaloneEvalIso(evalStart: string | null, evalEnd: string | null): string | null {
  const d = evalEnd ?? evalStart
  if (!d) return null
  const day = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : kstDateOf(d)
  return day ? `${day}T00:00:00+09:00` : null
}

// (v2.8.0) 클래스 '리포트 구성': "평가만"이면 화면이 평가 중심으로 줄인다. 비었거나 칸이 없으면 전체.
export function reportModeOf(cls: any): "all" | "tests_only" {
  return cls?.properties?.["리포트 구성"]?.select?.name === "평가만" ? "tests_only" : "all"
}

// (10/30 사용자, 일일 기록 기반) 리포트는 최근 6개월 평가를 모두 싣는다(평가 추이: 일간 7일·주간 4주·월간 6달, 기간마다 모든 평가 평균).
// 본문(사진·글)과 반 평균은 무거워서 최근 TESTS_DETAILED개에만 붙인다(카드·목록에 주로 보이는 평가).
export const TESTS_DETAILED = 20
// (v2.8.0 작품 모아보기) 프로그램 사진: 최근 수업 몇 번까지 본문을 읽을지, 사진을 몇 장까지 실을지(Notion 읽기 양 제한).
export const GALLERY_MAX_LOGS = 40
export const GALLERY_MAX_PHOTOS = 120
// (v2.8.0) 평가 구분 묶음: 주간·월간은 그 이름, 나머지(빈 값·일일·단원·마무리·종합 평가·기타)는 일일 평가.
// (10/30 사용자) 진도 평가 구역은 없앴다. 단원·마무리 평가도 그날 수업의 평가로 보인다.
export function testKindOf(evalType: string | null | undefined): string {
  return evalType === "주간 평가" || evalType === "월간 평가" ? evalType : "일일 평가"
}

export async function buildRegistrationDetail(reg: any, cachedGetPage: (id: string) => Promise<any>) {
  const registrationId = reg.id
  const sinceIso = sinceIsoMonthsAgo(DETAIL_LOOKBACK_MONTHS)
  const todayIso = todayIsoSeoul()

  const classId = firstRelationId(reg.properties["클래스"])
  let teacherName = ""
  // (v2.8.0) 클래스의 '반 평균 숨김'을 체크하면 이 반 학생 리포트에 반 평균을 싣지 않는다(칸이 없으면 보여 준다).
  let hideClassAverage = false
  let report_mode: "all" | "tests_only" = "all"
  if (classId) {
    const cls = await cachedGetPage(classId)
    hideClassAverage = cls.properties?.["반 평균 숨김"]?.checkbox === true
    report_mode = reportModeOf(cls)
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
        arrived: r.arrived_at ?? null,
        left: r.left_at ?? null,
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
    .map((e) => ({ iso: e.iso, date: e.date, weekday: e.weekday, status: e.status, in: e.in, out: e.out, arrived: e.arrived, left: e.left }))

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
        // (v2.8.0 수료) 수료 보고서는 그 진도교재에 연결된다. 교재 상세가 이 한마디를 보여 준다.
        book_id: (relationIds(rpr["진도교재"])[0] ?? "").replace(/-/g, ""),
      }
    })
    // 수료 보고서는 한마디가 없어도 싣는다(교재 상세 수료 구역이 보고서 기간을 쓴다).
    .filter((rc) => (rc.comment || rc.kind === "수료 보고서") && rc.start && rc.start >= sinceIso)

  const logIdSet = new Set<string>()
  // (v2.6.19) 학습기록 날짜는 학습기록의 날짜 수식(수업일)이 아니라 이 학생이 그 기록에 연결된 출석의 실제 날짜(수업일시)를 쓴다.
  const logIsoById = new Map<string, string>()
  attendanceRows.forEach((r) => r.study_log_ids.forEach((id: string) => {
    logIdSet.add(id)
    if (r.class_iso && !logIsoById.has(id)) logIsoById.set(id, r.class_iso)
  }))
  const logIds = Array.from(logIdSet)
  // (v2.8.0) 보강 날 학습기록의 "기존 수업": 이 등록의 출석 중 `기존 결석`(보강 출석 → 원래 결석 관계)이 있는 것만 한 번 조회하고,
  // 그 결석의 수업일시를 서울 날짜로 바꿔 그 출석에 연결된 학습기록에 붙인다. 수식(API에서 UTC로 계산돼 오전 9시 전 수업은 하루
  // 어긋남)은 읽지 않는다. 칸이 없는 운영은 조용히 건너뛴다.
  const makeupOfByLog = new Map<string, string>()
  try {
    const makeupPages = await queryAllPages(DS_ATTENDANCE, { and: [{ property: "등록", relation: { contains: registrationId } }, { property: "기존 결석", relation: { is_not_empty: true } }] })
    const makeupOfByAttendance = new Map<string, string>()
    for (const p of makeupPages) {
      const absenceId = firstRelationId(p?.properties?.["기존 결석"])
      if (!absenceId) continue
      const absence = await cachedGetPage(absenceId)
      if (absence?.archived || absence?.in_trash) continue
      const day = kstDateOf(absence?.properties?.["수업일시"]?.date?.start ?? null)
      if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) makeupOfByAttendance.set(String(p.id).replace(/-/g, ""), day)
    }
    attendanceRows.forEach((r) => {
      const day = makeupOfByAttendance.get(String(r.notion_page_id).replace(/-/g, ""))
      if (day) r.study_log_ids.forEach((id: string) => makeupOfByLog.set(id.replace(/-/g, ""), day))
    })
  } catch (err) {
    console.warn("[report-cache] 기존 결석 조회 건너뜀:", (err as Error).message)
  }
  // (v2.8.0) 리포트 교재 상세를 진도교재 단위로 묶는다(같은 교재·프로그램을 두 번 할 때 회차가 섞이지 않게).
  // 학습기록의 진도교재가 이 등록의 진도교재면 그 ID, 이 등록 진도교재의 반별교재(개별 진도 반의 반 교재)면 그 학생 진도교재 ID.
  // 반별교재가 같은 진도교재가 둘 이상이거나 찾지 못하면 빈 값 → 화면이 예전처럼 교재 이름으로 묶는다.
  const cid = (id: string | null | undefined) => String(id ?? "").replace(/-/g, "")
  const bookKeyById = new Map<string, string>()
  const ownBookPages = await Promise.all(relationIds(reg.properties["진도교재"]).map((id: string) => cachedGetPage(id)))
  ownBookPages.forEach((bp: any) => bookKeyById.set(cid(bp.id), cid(bp.id)))
  const aliasOwners = new Map<string, string[]>()
  ownBookPages.forEach((bp: any) => relationIds(bp.properties?.["반별교재"]).forEach((t: string) => {
    if (!bookKeyById.has(cid(t))) aliasOwners.set(cid(t), [...(aliasOwners.get(cid(t)) ?? []), cid(bp.id)])
  }))
  aliasOwners.forEach((owners, alias) => { if (owners.length === 1) bookKeyById.set(alias, owners[0]) })
  const logPages = await Promise.all(logIds.map((id) => cachedGetPage(id)))
  const logUnitNames = await unitNamesOf(logPages) // 학습기록 "선택 단원" 이름(v2.5.126)
  const readLogDetail = async (lp: any) => {
    const lprops = lp.properties
    const category = text(lprops["구분"])
    const iso = logIsoById.get(lp.id) ?? null
    const content = text(lprops["내용"])
    const range = text(lprops["범위"])
    const unit = unitTextOf(lp, logUnitNames)
    const bookId = firstRelationId(lprops["교재"])
    let bookTitle = ""
    let isProgram = false
    if (bookId) {
      const bp = await cachedGetPage(bookId)
      bookTitle = text(bp.properties["교재명"])
      isProgram = text(bp.properties["구분"]) === "프로그램"
    }
    // [FIX, 2026-09-27] 진도교재/교재를 연결하지 않은 학습기록(그룹 진도 보강 이행 확인 등 단순 기록)은
    // bookTitle이 비어서 화면에 "학습 기록"이라는 일반 문구로만 표시됐다. 이 경우 학습기록 페이지
    // 자신의 제목("학습" 속성, 예: "보강 이행")을 대신 써서 실제로 적은 제목이 보이게 한다.
    if (!bookTitle) {
      bookTitle = text(lprops["학습"])
    }
    // (v2.5.66) 교재 없는 기록은 "주제"를 먼저 쓴다(교재명 → 주제 → 구분). 규칙대로 지은 제목
    // ("[학습] …(반) 10.13(화)")은 화면에 맞지 않아 구분으로 대신하고, 손으로 적은 옛 제목은 그대로 둔다.
    if (!bookId) {
      const topic = text(lprops["주제"])
      if (topic) bookTitle = topic
      else if (/^[(학습|과제|평가)]/.test(bookTitle)) bookTitle = category || "학습"
    }
    // (참고) 이 수정 배포 시 scripts/check-known-regressions.sh의 오래된 검사 2건(100점 💯 문구,
    // 새로고침 버튼 <img> 요구)이 최신 Feather 아이콘 통일 작업과 맞지 않아 회귀 가드를 함께
    // 갱신했다(같은 날짜 커밋 참고).
    // (v2.8.0) 평가 구분·평가 기간(칸이 없는 운영이면 빈 값). 출석 없는 평가는 평가 기간으로 날짜를 잡는다.
    const evalType = text(lprops["평가 구분"])
    const evalStart = dateStartOf(lprops["평가 기간"])
    const evalEnd = dateEndOf(lprops["평가 기간"])
    const bookKey = bookKeyById.get(cid(firstRelationId(lprops["진도교재"]))) ?? ""
    return { id: lp.id, category, iso, content, range, unit, bookTitle, bookKey, evalType, evalStart, evalEnd, isProgram }
  }
  const logDetails = await Promise.all(logPages.map(readLogDetail))
  const logDetailById = new Map(logDetails.map((detail) => [detail.id, detail]))

  const pastLogDetails = logDetails.filter((l) => (l.iso ?? "").slice(0, 10) <= todayIso && (l.iso ?? "") >= sinceIso)

  // 화면에 실제로 보여줄 최근 12건만 본문(블록)을 가져온다 -- 그보다 오래된 건 어차피 안 보이므로
  // 조회할 필요가 없다. 동시성은 4~6개로 제한해서(mapWithConcurrency), Notion API에 한꺼번에
  // 너무 많은 블록 조회 요청을 쏘지 않게 한다(리포트 발송 병목 검토 참고).
  const studyLogCandidates = pastLogDetails
    .filter((l) => l.category === "학습")
    .sort((a, b) => ((a.iso ?? "") < (b.iso ?? "") ? 1 : -1))
    .slice(0, 12)
  const studyLogBodies = new Map(
    await mapWithConcurrency(studyLogCandidates, 6, async (l) => [l.id, await readPageBodyBlocks(l.id)] as const),
  )
  const study_logs = studyLogCandidates
    .map((l) => ({ iso: l.iso, date: fmtDateKr(l.iso), book: l.bookTitle, book_id: l.bookKey, range: l.range, unit: l.unit, note: l.content, body: studyLogBodies.get(l.id) ?? [], ...(makeupOfByLog.get(l.id.replace(/-/g, "")) ? { makeup_of: makeupOfByLog.get(l.id.replace(/-/g, "")) } : {}) }))

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
        // (v2.8.0 교재 평가) 출석 없는 평가 기록의 선택 단원 이름도 읽는다(단원 평가 카드에 단원을 보여 준다).
        const recordPage = await cachedGetPage(learningRecordId)
        for (const [id, name] of await unitNamesOf([recordPage])) logUnitNames.set(id, name)
        source = await readLogDetail(recordPage)
        logDetailById.set(learningRecordId, source)
      }
      if (!classIso && text(props["구분"]) === "평가") classIso = standaloneEvalIso(source?.evalStart ?? null, source?.evalEnd ?? null)
      // (v2.6.19) 과제 마감일도 수식(과제 마감일)이 아니라 마감 출석(과제 마감)의 실제 날짜를 쓴다.
      let dueIso: string | null = null
      const dueAttendanceId = firstRelationId(props["과제 마감"])
      if (dueAttendanceId) {
        const dueAtt = await cachedGetPage(dueAttendanceId)
        dueIso = dateStartOf(dueAtt.properties["수업일시"])
      }
      return {
        id: ap.id,
        learningRecordId,
        category: text(props["구분"]),
        dueIso,
        classIso,
        status: normalizeStatus(text(props["과제상태"])),
        correct: numberOf(props["정답 문항"]) ?? 0,
        total: numberOf(props["전체 문항"]) ?? 0,
        // (v2.8.0) 학생별 선생님 한마디. 리포트 교재 상세의 평가 카드에 보인다(칸이 없으면 빈 값).
        comment: text(props["선생님 한마디"]),
        bookTitle: source?.bookTitle ?? "",
        bookKey: source?.bookKey ?? "",
        range: source?.range ?? "",
        unit: source?.unit ?? "",
        content: source?.content ?? "",
        evalType: source?.evalType ?? "",
        evalStart: source?.evalStart ?? null,
        evalEnd: source?.evalEnd ?? null,
        standalone: !attendanceId,
      }
    }),
  )

  // classIso는 시각이 포함된 ISO 문자열이고 todayIso는 날짜만 있는 문자열이므로 그대로 비교하면
  // 오늘의 과제/평가가 미래 값으로 오인되어 제외된다. 서울 기준 날짜로 통일해 비교한다.
  const activityClassDate = (a: { classIso: string | null }) => kstDateOf(a.classIso)

  const homeworkActivities = activities.filter((a) => {
    const classDate = activityClassDate(a)
    return a.category === "과제" && classDate && classDate >= sinceIso && classDate <= todayIso
  })
  const testActivities = activities.filter((a) => {
    const classDate = activityClassDate(a)
    return a.category === "평가" && classDate && classDate >= sinceIso && classDate <= todayIso
  })
  // (10/30 사용자) 최근 6개월(sinceIso) 평가를 모두 싣는다. 본문·반 평균은 최근 TESTS_DETAILED개만(detailedTests).
  const shownTests = testActivities
    .slice()
    .sort((x, y) => String(y.classIso ?? "").localeCompare(String(x.classIso ?? "")))
  const detailedTests = shownTests.slice(0, TESTS_DETAILED)

  // 화면에 실제 표시되는 학습 12건·과제 6건·평가 6건의 학생별 학습활동 본문만 가져온다.
  // 학습기록 본문은 반 전체가 공유하는 원본 자료이고, 학습활동 본문은 학생별 풀이·필기·답안이다.
  const studyActivityByRecordId = new Map(
    activities
      .filter((a) => a.category === "학습" && a.learningRecordId)
      .map((a) => [a.learningRecordId as string, a]),
  )
  const displayedStudyActivities = studyLogCandidates
    .map((l) => studyActivityByRecordId.get(l.id))
    .filter((a): a is (typeof activities)[number] => Boolean(a))
  const displayedActivities = [
    ...displayedStudyActivities,
    ...homeworkActivities.slice(0, 6),
    ...detailedTests,
  ]
  const displayedSourceIds = Array.from(
    new Set(displayedActivities.map((a) => a.learningRecordId).filter((id): id is string => Boolean(id))),
  )
  const activityPageBodies = new Map(
    await mapWithConcurrency(displayedActivities, 6, async (a) => [a.id, await readPageBodyBlocks(a.id)] as const),
  )
  const sourcePageBodies = new Map(
    await mapWithConcurrency(displayedSourceIds, 6, async (id) => [id, await readPageBodyBlocks(id)] as const),
  )
  // (v2.8.0 작품 모아보기) 프로그램(예체능) 학습기록의 사진을 모두 모은다: 학생 학습활동 본문(이 학생 작품)과
  // 학습기록 본문(반 공유 자료). 위에서 이미 읽은 본문은 다시 읽지 않고, 최근 GALLERY_MAX_LOGS 수업까지만 읽는다.
  const galleryLogs = pastLogDetails
    .filter((l) => l.category === "학습" && l.isProgram && l.bookKey)
    .sort((a, b) => ((a.iso ?? "") < (b.iso ?? "") ? 1 : -1))
    .slice(0, GALLERY_MAX_LOGS)
  const knownBodies = new Map<string, unknown[]>([...studyLogBodies, ...activityPageBodies, ...sourcePageBodies])
  const galleryPageIds = Array.from(new Set(galleryLogs.flatMap((l) => {
    const activity = studyActivityByRecordId.get(l.id)
    return [activity?.id, l.id].filter((id): id is string => !!id && !knownBodies.has(id))
  })))
  const galleryBodies = new Map(
    await mapWithConcurrency(galleryPageIds, 4, async (id) => [id, await readPageBodyBlocks(id)] as const),
  )
  const bodyOf = (id: string | undefined) => (id ? (knownBodies.get(id) ?? galleryBodies.get(id) ?? []) : [])
  const imagesOf = (body: unknown[]) => (body as any[]).filter((b) => b?.type === "image" && b.url)
  const gallery = galleryLogs
    .slice()
    .reverse()
    .flatMap((l) => [
      ...imagesOf(bodyOf(studyActivityByRecordId.get(l.id)?.id)).map((b) => ({ b, mine: true })),
      ...imagesOf(bodyOf(l.id)).map((b) => ({ b, mine: false })),
    ].map(({ b, mine }) => ({ book_id: l.bookKey, iso: l.iso, range: l.range, url: b.url, caption: b.caption ?? "", ...(b.blockId ? { block_id: b.blockId } : {}), mine })))
    .slice(-GALLERY_MAX_PHOTOS)

  const studyLogsWithActivity = study_logs.map((log, index) => {
    const source = studyLogCandidates[index]
    const activity = source ? studyActivityByRecordId.get(source.id) : undefined
    return {
      ...log,
      source_body: log.body,
      activity_body: activity ? (activityPageBodies.get(activity.id) ?? []) : [],
    }
  })

  const homeworkAll = homeworkActivities.map((a) => ({
    title: "",
    book: a.bookTitle,
    book_id: a.bookKey,
    range: a.range,
    unit: a.unit,
    note: a.content,
    iso: a.classIso,
    date: fmtDateKr(a.classIso),
    due_iso: a.dueIso,
    due: a.dueIso ? fmtDateKr(a.dueIso) : "",
    status: a.status || "미제출",
    source_body: a.learningRecordId ? (sourcePageBodies.get(a.learningRecordId) ?? []) : [],
    activity_body: activityPageBodies.get(a.id) ?? [],
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

  // (v2.8.0) 반 평균: 같은 학습기록에 묶인 학생들의 평가 학습활동 점수(정답 ÷ 전체 문항) 평균.
  // 학습기록의 '학습활동' 관계로 형제 활동을 읽으므로 Notion에 페이지를 따로 만들 필요가 없다.
  // 점수가 있는 학생이 3명 미만이면 null: 2명이면 내 점수를 빼서 다른 학생 점수를 알 수 있다.
  // 개별진도·개별수업은 학습기록에 학생이 한 명이라 자연히 null이 된다.
  const classAverageOf = async (recordId?: string | null) => {
    if (!recordId || hideClassAverage) return null
    const record = await cachedGetPage(recordId)
    const siblingIds = relationIds(record.properties?.["학습활동"])
    const siblings = await mapWithConcurrency(siblingIds, 6, (id) => cachedGetPage(id))
    const pcts = siblings
      .filter((p: any) => text(p.properties?.["구분"]) === "평가")
      .map((p: any) => ({ correct: numberOf(p.properties?.["정답 문항"]), total: numberOf(p.properties?.["전체 문항"]) }))
      .filter((x) => typeof x.correct === "number" && x.total && x.total > 0)
      .map((x) => (x.correct as number) / (x.total as number) * 100)
    if (pcts.length < 3) return null
    return { avg: Math.round(pcts.reduce((n, v) => n + v, 0) / pcts.length * 10) / 10, count: pcts.length }
  }
  const classAverages = await mapWithConcurrency(detailedTests, 3, (a) => classAverageOf(a.learningRecordId))
  const tests = shownTests
    .map((a, i) => ({
      title: "",
      book: a.bookTitle,
      book_id: a.bookKey,
      range: a.range,
      unit: a.unit,
      note: a.content,
      iso: a.classIso,
      date: fmtDateKr(a.classIso),
      correct: a.correct,
      total: a.total,
      // (v2.8.0) 평가 구분·기간. 화면이 평가 카드에 알약·기간으로 보여 준다(비어 있으면 표시 안 함).
      eval_type: a.evalType || "",
      eval_start: a.evalStart,
      eval_end: a.evalEnd,
      standalone: a.standalone,
      comment: a.comment,
      class_avg: classAverages[i]?.avg ?? null,
      class_count: classAverages[i]?.count ?? 0,
      source_body: a.learningRecordId ? (sourcePageBodies.get(a.learningRecordId) ?? []) : [],
      activity_body: activityPageBodies.get(a.id) ?? [],
    }))

  // (v2.8.0 루틴, 항목 18) 루틴 체크(했다/안 했다). 날짜는 출석의 수업일시. 루틴 체크 DB가 없는 운영은 빈 목록.
  const attendanceIsoById = new Map<string, string>()
  attendanceRows.forEach((r) => { if (r.class_iso) attendanceIsoById.set(String(r.notion_page_id).replace(/-/g, ""), r.class_iso) })
  const routines = (await routineRowsForRegistration(registrationId, cachedGetPage, attendanceIsoById, kstDateOf).catch((err) => {
    console.warn("[report-cache] 루틴 체크 건너뜀:", (err as Error).message)
    return [] as RoutineRow[]
  })).filter((r) => r.date >= sinceIso && r.date <= todayIso)

  return {
    attendance_summary,
    attendance_rows,
    routines,
    study_logs: studyLogsWithActivity,
    gallery,
    homework,
    homework_days,
    tests,
    teacher_comments,
    report_comments,
    report_mode,
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

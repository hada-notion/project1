import { queryAllPages, getBlockChildren, mapWithConcurrency } from "./notionClient.ts"
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

// 학습기록 페이지 "본문"(블록)을 학부모 리포트 피드용 부록으로 변환한다. 프론트엔드
// normalizeFeedBody(student_report_part1.js)가 기대하는 { type: "text"|"image"|"video"|"divider", ... }
// 형태와 그대로 맞춘다. 실제 노션에서 흔히 쓰는 블록(제목1~3/글머리·번호 목록/할 일/인용/콜아웃/
// 코드/구분선)과 굵게·기울임·취소선·밑줄·인라인 코드·색상 같은 텍스트 서식(annotations)까지 살려서
// 내려준다. 표(table)도 지원한다. 임베드/토글/동기화 블록(하위 블록 재귀 조회가 필요한 것들)
// 등은 조용히 건너뛴다 -- 리포트 피드는
// "기록한 글/사진"만 보여주면 되고, 모든 노션 블록을 완벽히 재현할 필요는 없다. 실제 HTML 조립은
// (XSS 이스케이프 책임을 한 곳에 두기 위해) 프론트엔드 esc()가 있는 곳에서 한다 -- 여기서는
// 텍스트와 서식 정보만 구조화해서 내려준다.
function richTextPlain(arr: any[] | undefined): string {
  return (arr ?? []).map((t: any) => t?.plain_text ?? "").join("").trim()
}
function richTextSpans(arr: any[] | undefined): unknown[] {
  return (arr ?? [])
    .map((t: any) => {
      const spanText = String(t?.plain_text ?? "")
      if (!spanText) return null
      const a = t?.annotations ?? {}
      const color = typeof a.color === "string" && a.color !== "default" ? a.color : undefined
      const href = t?.href || t?.text?.link?.url || undefined
      return {
        text: spanText,
        bold: !!a.bold,
        italic: !!a.italic,
        strikethrough: !!a.strikethrough,
        underline: !!a.underline,
        code: !!a.code,
        color,
        href,
      }
    })
    .filter(Boolean)
}
function textBlockItem(type: string, richText: any[] | undefined, extra: Record<string, unknown> = {}): unknown | null {
  const spans = richTextSpans(richText)
  const t = richTextPlain(richText)
  if (!t) return null
  return { type: "text", style: type, text: t, spans, ...extra }
}
async function blocksToFeedBody(blocks: any[]): Promise<unknown[]> {
  const items: unknown[] = []
  for (const b of blocks ?? []) {
    const type = b?.type
    if (!type) continue
    if (type === "table") {
      // 표는 자기 자신이 아니라 하위 table_row 블록에 실제 셀 내용이 있으므로 한 단계 더
      // 가져와야 한다. 표 개수는 본문 하나당 보통 0~2개뿐이라 순차 조회로도 충분하다.
      let rows: unknown[] = []
      if (b.has_children) {
        try {
          const rowBlocks = await getBlockChildren(b.id)
          rows = (rowBlocks ?? [])
            .filter((r: any) => r?.type === "table_row")
            .map((r: any) => (r.table_row?.cells ?? []).map((cell: any[]) => richTextSpans(cell)))
        } catch (err) {
          console.warn(`표 블록의 행 조회 실패 - 건너뜀(${b.id}):`, (err as Error)?.message ?? err)
        }
      }
      if (rows.length) {
        items.push({
          type: "table",
          rows,
          hasColumnHeader: !!b.table?.has_column_header,
          hasRowHeader: !!b.table?.has_row_header,
        })
      }
      continue
    }
    if (type === "image" || type === "video" || type === "pdf" || type === "file") {
      const media = b[type]
      const url = media?.type === "external" ? media.external?.url : media?.file?.url
      if (!url) continue
      const caption = richTextPlain(media?.caption)
      if (type === "pdf" || type === "file") {
        const fallbackName = type === "pdf" ? "PDF 문서" : "첨부 파일"
        items.push({
          type,
          blockId: String(b.id || ""),
          url: String(url),
          name: String(media?.name || caption || fallbackName),
          caption,
        })
      } else {
        items.push({ type, url: String(url), caption })
      }
      continue
    }
    if (type === "divider") {
      items.push({ type: "divider" })
      continue
    }
    if (type === "to_do") {
      const item = textBlockItem(type, b.to_do?.rich_text, { checked: !!b.to_do?.checked })
      if (item) items.push(item)
      continue
    }
    if (type === "callout") {
      const icon = b.callout?.icon?.type === "emoji" ? b.callout.icon.emoji : undefined
      const item = textBlockItem(type, b.callout?.rich_text, icon ? { icon } : {})
      if (item) items.push(item)
      continue
    }
    if (type === "code") {
      const item = textBlockItem(type, b.code?.rich_text, { language: String(b.code?.language || "") })
      if (item) items.push(item)
      continue
    }
    // paragraph / heading_1 / heading_2 / heading_3 / quote / bulleted_list_item / numbered_list_item는
    // 노션 API에서 블록 타입과 같은 이름의 속성 아래 rich_text를 그대로 두므로 공용 경로로 처리한다.
    const richText = b[type]?.rich_text
    if (Array.isArray(richText)) {
      const item = textBlockItem(type, richText)
      if (item) items.push(item)
    }
  }
  return items
}

// 실패해도(권한/삭제/타임아웃 등) 리포트 캐시 생성 전체를 막지 않는다 -- 본문은 "있으면 좋은"
// 부록이라, 실패 시 조용히 빈 배열로 넘어가고 경고만 남긴다(로드맵: 본문 동기화 리스크 검토 참고).
async function readPageBodyBlocks(pageId: string): Promise<unknown[]> {
  try {
    const blocks = await getBlockChildren(pageId)
    return await blocksToFeedBody(blocks)
  } catch (err) {
    console.warn(`학습기록 본문(블록) 조회 실패 - 빈 본문으로 계속 진행(${pageId}):`, (err as Error)?.message ?? err)
    return []
  }
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
    // [FIX, 2026-09-27] 진도교재/교재를 연결하지 않은 학습기록(그룹 진도 보강 이행 확인 등 단순 기록)은
    // bookTitle이 비어서 화면에 "학습 기록"이라는 일반 문구로만 표시됐다. 이 경우 학습기록 페이지
    // 자신의 제목("학습" 속성, 예: "보강 이행")을 대신 써서 실제로 적은 제목이 보이게 한다.
    if (!bookTitle) {
      bookTitle = text(lprops["학습"])
    }
    // (참고) 이 수정 배포 시 scripts/check-known-regressions.sh의 오래된 검사 2건(100점 💯 문구,
    // 새로고침 버튼 <img> 요구)이 최신 Feather 아이콘 통일 작업과 맞지 않아 회귀 가드를 함께
    // 갱신했다(같은 날짜 커밋 참고).
    return { id: lp.id, category, iso, content, range, unit, bookTitle }
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
    .map((l) => ({ iso: l.iso, date: fmtDateKr(l.iso), book: l.bookTitle, range: l.range, unit: l.unit, note: l.content, body: studyLogBodies.get(l.id) ?? [] }))

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
        id: ap.id,
        learningRecordId,
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
    ...testActivities.slice(0, 6),
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

  const tests = testActivities
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
      source_body: a.learningRecordId ? (sourcePageBodies.get(a.learningRecordId) ?? []) : [],
      activity_body: activityPageBodies.get(a.id) ?? [],
    }))

  return {
    attendance_summary,
    attendance_rows,
    study_logs: studyLogsWithActivity,
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

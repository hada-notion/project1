function renderGradesPage() {
  const grades = STUDENT.grades
  return `
    <div class="sub-page">
      <div class="header-plain"><button class="back-btn-plain" onclick="goIntro()">←</button></div>
      <div class="card">
        <h2>📊 성적정보</h2>
        <div class="view-toggle">
          <button class="${gradeView === "table" ? "active" : ""}" onclick="setGradeView('table')">표로 보기</button>
          <button class="${gradeView === "chart" ? "active" : ""}" onclick="setGradeView('chart')">차트로 보기</button>
        </div>
        ${gradeView === "table" ? buildGradeTableHtml(grades) : buildGradeChartHtml(grades)}
      </div>
    </div>
  `
}
function renderSchedulePage() {
  return `
    <div class="sub-page">
      <div class="header-plain"><button class="back-btn-plain" onclick="goIntro()">←</button></div>
      <div class="card">
        <h2>📅 일정정보</h2>
        <div class="view-toggle">
          <button class="${scheduleView === "list" ? "active" : ""}" onclick="setScheduleView('list')">리스트로 보기</button>
          <button class="${scheduleView === "calendar" ? "active" : ""}" onclick="setScheduleView('calendar')">캘린더로 보기</button>
        </div>
        ${scheduleView === "list" ? scheduleListHtml() : ""}
      </div>
      ${scheduleView === "calendar" ? buildScheduleCalendarHtml() : ""}
    </div>
  `
}
function gradesContentHtml() {
  return `
    <div class="view-toggle">
      <button class="${gradeView === "table" ? "active" : ""}" onclick="setGradeView('table')">표로 보기</button>
      <button class="${gradeView === "chart" ? "active" : ""}" onclick="setGradeView('chart')">차트로 보기</button>
    </div>
    <div class="card">${gradeView === "table" ? buildGradeTableHtml(STUDENT.grades) : buildGradeChartHtml(STUDENT.grades)}</div>
  `
}
function setGradeView(v) {
  gradeView = v
  const area = document.getElementById("grades-content-area")
  if (area) {
    area.innerHTML = gradesContentHtml()
  } else {
    renderApp()
    scrollToGrades()
  }
}

const DAYS = ["월", "화", "수", "목", "금", "토", "일"]
function buildWeekGridHtml(regs) {
  const active = regs.filter((r) => r.status === "수강중")
  const byDay = {}
  DAYS.forEach((d) => (byDay[d] = []))
  active.forEach((r) => { (r.schedule || []).forEach((s) => { if (byDay[s.day]) byDay[s.day].push({ ...s, class_name: r.class_name }) }) })
  DAYS.forEach((d) => { byDay[d].sort((a, b) => (a.start || "").localeCompare(b.start || "")) })
  return `
    <div class="week-grid">
      ${DAYS.map((d) => `
        <div class="week-col">
          <div class="day-label">${d}</div>
          ${byDay[d].length ? byDay[d].map((s) => `<div class="week-slot"><div class="slot-time">${esc(s.start)}</div>${esc(s.class_name)}</div>`).join("") : ""}
        </div>
      `).join("")}
    </div>
  `
}

function renderIntro() {
  const s = STUDENT
  const active = s.registrations.filter((r) => r.status === "수강중").slice().sort((a, b) => (a.start || "").localeCompare(b.start || ""))
  return `
    <div class="scroll-container">
      <div class="snap-section intro-section" id="intro-section">
        <button class="hamburger-btn" onclick="openMenu()">☰</button>
        <div class="intro-greeting">${esc(s.academy_name)}</div>
        <div class="intro-name">${esc(s.student_name)}</div>
        <div class="intro-sub">${[s.school, s.grade, s.gender].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join("")}</div>
        <div class="class-btn-group">
          ${active.map((r) => `
            <div class="class-btn primary" onclick="openRegistration('${r.token}')">
              <span class="cb-left">
                <span class="cb-emoji">${r.emoji}</span>
                <span class="cb-name-wrap">
                  <span class="cb-class-name">${esc(r.class_name)}</span>
                </span>
              </span>
              <span class="badge ${esc(r.status)}">${esc(r.status)}</span>
            </div>
          `).join("")}
        </div>
        <div class="swipe-hint" onclick="scrollToTimetable()">통합 시간표 보기<span class="chevron">⌄</span></div>
      </div>
      <div class="snap-section timetable-section" id="timetable-section">
        <button class="hamburger-btn dark" onclick="openMenu()">☰</button>
        <h2>🗓️ 통합 시간표</h2>
        <div class="tt-hint">현재 수강중인 반들만 요일별로 합쳐서 보여줍니다</div>
        ${buildWeekGridHtml(s.registrations)}
        <div class="up-hint" onclick="scrollToIntro()"><span class="chevron">⌃</span>이전으로</div>
        <div class="swipe-hint" onclick="scrollToSchedule()">일정 보기<span class="chevron">⌄</span></div>
      </div>
      <div class="snap-section schedule-section" id="schedule-section">
        <button class="hamburger-btn dark" onclick="openMenu()">☰</button>
        <h2>📅 일정</h2>
        <div class="section-hint">학원 공지와 상담 일정을 확인하세요</div>
        <div id="schedule-cal-area" style="width:100%">${buildScheduleCalendarHtml()}</div>
        <div class="up-hint" onclick="scrollToTimetable()"><span class="chevron">⌃</span>이전으로</div>
        <div class="swipe-hint" onclick="scrollToGrades()">성적 보기<span class="chevron">⌄</span></div>
      </div>
      <div class="snap-section grades-section" id="grades-section">
        <button class="hamburger-btn dark" onclick="openMenu()">☰</button>
        <h2>📊 성적</h2>
        <div class="section-hint">최근 시험 성적 추이를 확인하세요</div>
        <div class="section-scroll" id="grades-content-area">${gradesContentHtml()}</div>
        <div class="up-hint" onclick="scrollToSchedule()"><span class="chevron">⌃</span>이전으로</div>
      </div>
    </div>
  `
}

function regCalBaseDate() {
  const [y, m] = MOCK_TODAY.split("-").map(Number)
  return new Date(y, m - 1 + regCalMonthIndex, 1)
}
function currentReg() {
  return STUDENT.registrations.find((x) => x.token === selectedToken)
}
function navigateRegCalMonth(delta) {
  if (delta < 0 && regCalMonthIndex <= -MAX_LOOKBACK_MONTHS) return
  regCalMonthIndex += delta
  const area = document.getElementById("reg-cal-area")
  if (area) {
    area.innerHTML = buildRegCalendarHtml(currentReg(), calMode)
  } else {
    renderApp()
  }
}
function goRegCalToday() {
  regCalMonthIndex = 0
  const area = document.getElementById("reg-cal-area")
  if (area) {
    area.innerHTML = buildRegCalendarHtml(currentReg(), calMode)
  } else {
    renderApp()
  }
}
function setCalMode(mode) {
  calMode = mode
  regCalMonthIndex = 0
  renderApp()
}
function buildRegCalendarHtml(r, mode) {
  if (!r) return '<div class="empty">등록 정보가 없습니다.</div>'
  const base = regCalBaseDate()
  const y = base.getFullYear()
  const m = base.getMonth() + 1
  const monthKey = `${y}-${String(m).padStart(2, "0")}`
  const byDay = {}
  if (mode === "attendance") {
    (r.attendance_rows || []).forEach((a) => {
      if (a.date && a.date.slice(0, 7) === monthKey) byDay[Number(a.date.slice(8, 10))] = esc(a.status)
    })
  } else {
    (r.homework_days || []).forEach((h) => {
      if (h.date && h.date.slice(0, 7) === monthKey) byDay[Number(h.date.slice(8, 10))] = h.status
    })
  }
  const monthRows = (r.attendance_rows || []).filter((a) => a.date && String(a.date).slice(0, 7) === monthKey)
  const countBy = (kw) => monthRows.filter((a) => String(a.status || "").includes(kw)).length
  const monthHw = (r.homework_days || []).filter((h) => h.date && String(h.date).slice(0, 7) === monthKey)
  const hwDone = monthHw.filter((h) => h.status === "완료").length
  const summaryHtml = mode === "attendance"
    ? `<div class="cal-summary">
        <div class="cal-summary-item present"><span class="num">${countBy("출석")}</span><span class="lbl">출석</span></div>
        <div class="cal-summary-item absent"><span class="num">${countBy("결석")}</span><span class="lbl">결석</span></div>
        <div class="cal-summary-item makeup"><span class="num">${countBy("보강")}</span><span class="lbl">보강</span></div>
      </div>`
    : `<div class="cal-summary">
        <div class="cal-summary-item present"><span class="num">${hwDone}</span><span class="lbl">완료</span></div>
        <div class="cal-summary-item partial"><span class="num">${monthHw.filter((h) => h.status === "부분완료").length}</span><span class="lbl">일부 완료</span></div>
        <div class="cal-summary-item absent"><span class="num">${monthHw.filter((h) => h.status === "미완료").length}</span><span class="lbl">미완료</span></div>
      </div>`
  const dowLabels = ["일", "월", "화", "수", "목", "금", "토"]
  const firstDow = new Date(y, m - 1, 1).getDay()
  const daysInMonth = new Date(y, m, 0).getDate()
  const cells = []
  for (let i = 0; i < firstDow; i++) cells.push('<div class="cal-day empty"></div>')
  for (let day = 1; day <= daysInMonth; day++) {
    const status = byDay[day]
    const dateStr = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    const selected = dateStr === selectedCalDate ? "selected" : ""
    const today = dateStr === MOCK_TODAY ? "today" : ""
    cells.push(`<div class="cal-day ${status || ""} ${selected} ${today}" onclick="selectCalDay('${dateStr}')"><span>${day}</span></div>`)
  }
  return `
    <div class="attendance-calendar">
      <div class="cal-month-nav">
        <button class="cal-nav-btn" ${regCalMonthIndex <= -MAX_LOOKBACK_MONTHS ? "disabled" : ""} onclick="navigateRegCalMonth(-1)">‹</button>
        <div class="cal-month-title">${y}년 ${m}월</div>
        <div class="cal-nav-right">
          <button class="cal-today-btn" onclick="goRegCalToday()">오늘</button>
          <button class="cal-nav-btn" onclick="navigateRegCalMonth(1)">›</button>
        </div>
      </div>
      <div class="cal-grid">
        ${dowLabels.map((l) => `<div class="cal-dow">${l}</div>`).join("")}
        ${cells.join("")}
      </div>
      ${summaryHtml}
      <div class="cal-hint">날짜를 탭하면 데일리 리포트를 볼 수 있어요</div>
    </div>
  `
}

function setReportPeriod(period) {
  reportPeriod = period
  reportOffset = 0
  if (period === "day") reportDayDate = reportDayDate || MOCK_TODAY
  renderApp()
}
function navigateReportPeriod(delta) {
  const maxOffset = reportPeriod === "week" ? 12 : 3
  reportOffset = Math.max(0, Math.min(maxOffset, reportOffset + delta))
  renderApp()
}
function navigateReportDay(delta) {
  const candidate = addDaysStr(reportDayDate || MOCK_TODAY, -delta)
  reportDayDate = candidate > MOCK_TODAY ? MOCK_TODAY : candidate
  renderApp()
}
function goReportCurrent() {
  if (reportPeriod === "day") {
    reportDayDate = MOCK_TODAY
  } else {
    reportOffset = 0
  }
  renderApp()
}
function reportRange() {
  if (reportPeriod === "week") {
    const currentMonday = mondayOfWeek(MOCK_TODAY)
    const rangeStart = addDaysStr(currentMonday, -7 * reportOffset)
    const rangeEnd = addDaysStr(rangeStart, 6)
    return { rangeStart, rangeEnd }
  }
  const [ty, tm] = MOCK_TODAY.split("-").map(Number)
  const base = new Date(ty, tm - 1 - reportOffset, 1)
  const y = base.getFullYear()
  const m = base.getMonth() + 1
  const rangeStart = `${y}-${String(m).padStart(2, "0")}-01`
  const lastDay = new Date(y, m, 0).getDate()
  const naturalEnd = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`
  const rangeEnd = reportOffset === 0 ? MOCK_TODAY : naturalEnd
  return { rangeStart, rangeEnd }
}
function computeTestTrendPoints(tests, periodType, baseOffset) {
  const periodsCount = 3
  const points = []
  for (let i = periodsCount - 1; i >= 0; i--) {
    const offset = baseOffset + i
    let rangeStart, rangeEnd, label
    if (periodType === "week") {
      const currentMonday = mondayOfWeek(MOCK_TODAY)
      rangeStart = addDaysStr(currentMonday, -7 * offset)
      rangeEnd = addDaysStr(rangeStart, 6)
      label = `${rangeStart.slice(5).replace("-", ".")}~${rangeEnd.slice(5).replace("-", ".")}`
    } else {
      const [ty, tm] = MOCK_TODAY.split("-").map(Number)
      const base = new Date(ty, tm - 1 - offset, 1)
      const y = base.getFullYear()
      const m = base.getMonth() + 1
      rangeStart = `${y}-${String(m).padStart(2, "0")}-01`
      const lastDay = new Date(y, m, 0).getDate()
      rangeEnd = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`
      label = `${m}월`
    }
    const items = tests.filter((t) => t.date >= rangeStart && t.date <= rangeEnd)
    const avg = items.length ? Math.round(items.reduce((s, t) => s + (t.total ? (t.correct / t.total) * 100 : 0), 0) / items.length) : null
    points.push({ label, avg, count: items.length, items })
  }
  return points
}
function computeRecentTestPoints(tests, asOfDate, count) {
  const past = tests.filter((t) => t.date <= asOfDate).slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""))
  const recent = past.slice(-count)
  return recent.map((t) => ({
    label: (t.date || "").slice(5).replace("-", "."),
    avg: t.total ? Math.round((t.correct / t.total) * 1000) / 10 : null,
    count: 1,
    items: [t],
  }))
}
function buildTestTrendChartHtml(points) {
  testChartPoints = points
  const width = 400, height = 200, paddingX = 30, paddingTop = 20, paddingBottom = 34
  const xStep = points.length > 1 ? (width - paddingX * 2) / (points.length - 1) : 0
  const validAvgs = points.filter((p) => p.avg !== null).map((p) => p.avg)
  const axisMax = 100
  const ticks = [0, 20, 40, 60, 80, 100]
  const yFor = (v) => paddingTop + (height - paddingTop - paddingBottom) - (v / axisMax) * (height - paddingTop - paddingBottom)
  const xFor = (i) => paddingX + i * xStep
  const validPoints = points.map((p, i) => ({ ...p, i })).filter((p) => p.avg !== null)
  const path = validPoints.map((p) => `${xFor(p.i)},${yFor(p.avg)}`).join(" ")
  const dots = validPoints.map((p) => `<circle cx="${xFor(p.i)}" cy="${yFor(p.avg)}" r="4" fill="#6c5ce7" style="pointer-events:none" /><circle cx="${xFor(p.i)}" cy="${yFor(p.avg)}" r="12" fill="transparent" style="cursor:pointer" onclick="showTestDetailModal(${p.i})" />`).join("")
  const valueLabels = validPoints.map((p) => `<text x="${xFor(p.i)}" y="${yFor(p.avg) - 10}" font-size="11" font-weight="700" fill="#6c5ce7" text-anchor="middle" style="cursor:pointer" onclick="showTestDetailModal(${p.i})">${p.avg.toFixed(1)}점</text>`).join("")
  const gridLines = ticks.map((v) => `
    <line x1="${paddingX}" y1="${yFor(v)}" x2="${width - paddingX}" y2="${yFor(v)}" stroke="#eee" stroke-width="1" />
    <text x="2" y="${yFor(v) + 4}" font-size="9" fill="#bbb">${v}</text>
  `).join("")
  const xLabels = points.map((p, i) => `<text x="${xFor(i)}" y="${height - 10}" font-size="10" fill="#999" text-anchor="middle">${esc(p.label)}</text>`).join("")
  const emptyOverlay = validPoints.length ? "" : '<div class="empty">해당 기간 평가 기록이 없습니다.</div>'
  return `
    <div class="chart-wrap"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">${gridLines}<polyline points="${path}" fill="none" stroke="#6c5ce7" stroke-width="2" />${dots}${valueLabels}${xLabels}</svg></div>
    ${emptyOverlay}
  `
}
function buildReportTabHtml(r) {
  const homework = r.homework || []
  const tests = r.tests || []
  const reportComments = r.report_comments || []
  const { rangeStart, rangeEnd } = reportRange()
  const attendanceRows = (r.attendance_rows || []).filter((a) => a.date >= rangeStart && a.date <= rangeEnd)
  const homeworkItems = (r.homework_days || []).filter((h) => h.date && h.date >= rangeStart && h.date <= rangeEnd)
  const testItems = tests.filter((t) => t.date >= rangeStart && t.date <= rangeEnd)
  const presentCount = attendanceRows.filter((a) => a.status !== "결석").length
  const attRate = attendanceRows.length ? Math.round((presentCount / attendanceRows.length) * 100) : 0
  const doneHomework = homeworkItems.filter((h) => h.status === "완료").length
  const hwRate = homeworkItems.length ? Math.round((doneHomework / homeworkItems.length) * 100) : 0
  const periodLabel = reportPeriod === "week" ? `${withDow(rangeStart)} ~ ${withDow(rangeEnd)}` : `${rangeStart.slice(0, 7)}`
  const segToggleHtml = `
    <div class="seg-toggle">
      <button class="${reportPeriod === "day" ? "active" : ""}" onclick="setReportPeriod('day')">일간 보고서</button>
      <button class="${reportPeriod === "week" ? "active" : ""}" onclick="setReportPeriod('week')">주간 보고서</button>
      <button class="${reportPeriod === "month" ? "active" : ""}" onclick="setReportPeriod('month')">월간 보고서</button>
    </div>
  `
  if (reportPeriod === "day") {
    const dayDate = reportDayDate || MOCK_TODAY
    return `
      <h2>📊 보고서</h2>
      <div class="section-hint">주간·월간·일간 학습 리포트를 확인하세요</div>
      ${segToggleHtml}
      <div class="cal-month-nav">
        <button class="cal-nav-btn" onclick="navigateReportDay(1)">‹</button>
        <div class="cal-month-title">${esc(formatDateLabel(dayDate))}</div>
        <div class="cal-nav-right">
          <button class="cal-today-btn" onclick="goReportCurrent()">오늘</button>
          <button class="cal-nav-btn" ${dayDate >= MOCK_TODAY ? "disabled" : ""} onclick="navigateReportDay(-1)">›</button>
        </div>
      </div>
      ${buildDailyBodyHtml(r, dayDate)}
    `
  }
  return `
    <h2>📊 보고서</h2>
    <div class="section-hint">주간·월간·일간 학습 리포트를 확인하세요</div>
    ${segToggleHtml}
    <div class="cal-month-nav">
      <button class="cal-nav-btn" ${reportOffset >= (reportPeriod === "week" ? MAX_LOOKBACK_MONTHS * 4 : MAX_LOOKBACK_MONTHS) ? "disabled" : ""} onclick="navigateReportPeriod(1)">‹</button>
      <div class="cal-month-title">${esc(periodLabel)}</div>
      <div class="cal-nav-right">
        <button class="cal-today-btn" onclick="goReportCurrent()">현재</button>
        <button class="cal-nav-btn" ${reportOffset === 0 ? "disabled" : ""} onclick="navigateReportPeriod(-1)">›</button>
      </div>
    </div>
    <div class="report-donut-row">
      <div class="donut-card">
        <div class="donut-title">✅ 출석률</div>
        <div class="donut" style="background: conic-gradient(#1e9e5c 0% ${attRate}%, #eee ${attRate}% 100%)"><div class="donut-hole">${attRate}%</div></div>
        <div class="donut-count-below">(${presentCount}/${attendanceRows.length})</div>
      </div>
      <div class="donut-card">
        <div class="donut-title">📝 과제이행률</div>
        <div class="donut" style="background: conic-gradient(#6c5ce7 0% ${hwRate}%, #eee ${hwRate}% 100%)"><div class="donut-hole">${hwRate}%</div></div>
        <div class="donut-count-below">(${doneHomework}/${homeworkItems.length})</div>
      </div>
    </div>
    <div class="card">
      <h2>📄 평가 기록</h2>
      ${buildTestTrendChartHtml(computeTestTrendPoints(tests, reportPeriod, reportOffset))}
    </div>
    <div class="card">
      <h2>💬 선생님 한마디</h2>
      ${(() => {
        const kind = reportPeriod === "week" ? "주간 보고서" : "월간 보고서"
        const matched = reportComments.filter((c) => c.kind === kind && c.start && (c.end || c.start) >= rangeStart && c.start <= rangeEnd)
        return matched.length ? matched.map((c) => `<div class="list-item"><div>${esc(c.comment)}</div></div>`).join("") : `<div class="list-item empty-hint">아직 등록된 한마디가 없어요</div>`
      })()}
    </div>
  `
}

function toShortDate(date) {
  if (!date) return date
  const parts = String(date).split("-")
  if (parts.length !== 3) return date
  const [y, m, d] = parts
  return `${y.slice(-2)}.${m}.${d}`
}

function withDow(date) {
  if (!date) return date
  const s = String(date).slice(0, 10)
  const parts = s.split("-").map(Number)
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return date
  const [y, m, d] = parts
  const weekday = ["일", "월", "화", "수", "목", "금", "토"][new Date(y, m - 1, d).getDay()]
  return `${s} (${weekday})`
}

function formatDateLabel(date) {
  const [y, m, d] = date.split("-").map(Number)
  const weekday = ["일", "월", "화", "수", "목", "금", "토"][new Date(y, m - 1, d).getDay()]
  return `${y}년 ${m}월 ${d}일 (${weekday})`
}

function findNextHomework(r, date) {
  const upcoming = (r.homework || []).filter((h) => h.due && h.due >= date).sort((a, b) => (a.due || "").localeCompare(b.due || ""))
  return upcoming[0] || null
}

function findLatestComment(r, date) {
  return (r.teacher_comments || []).find((c) => c.date && String(c.date).slice(0, 10) === date) || null
}

function buildDailyBodyHtml(r, date) {
  const attendanceRow = (r.attendance_rows || []).find((a) => a.date === date)
  const homeworkDayEntry = (r.homework_days || []).find((h) => h.date === date)
  const homeworkStatusInfo = (status) => (status === "완료" ? { text: "제출", cls: "제출" } : status === "부분완료" ? { text: "부분완료", cls: "부분완료" } : { text: "미제출", cls: "미제출" })
  const todaysLogs = (r.study_logs || []).filter((l) => l.date === date)
  const nextHomework = findNextHomework(r, date)
  const todaysTests = (r.tests || []).filter((t) => t.date === date)
  const comment = findLatestComment(r, date)

  return `
    <div class="status-box-row">
      <div class="status-box">
        <div class="label">✅ 출석상태</div>
        <span class="badge ${esc(attendanceRow ? attendanceRow.status : "해당 없음")}">${esc(attendanceRow ? attendanceRow.status : "해당 없음")}</span>
      </div>
      <div class="status-box">
        <div class="label">📝 과제상태</div>
        ${homeworkDayEntry ? (() => { const info = homeworkStatusInfo(homeworkDayEntry.status); return `<span class="badge ${info.cls}">${info.text}</span>` })() : `<span class="badge">해당 없음</span>`}
      </div>
    </div>

    <div class="card">
      <h2>📖 오늘 학습 내용</h2>
      ${todaysLogs.length ? todaysLogs.map((l) => `
        <div class="log-row 학습">
          <div class="log-title-row"><div class="log-title">${esc([l.book, l.range].filter(Boolean).join(" · ") || "학습 기록")}</div></div>
          ${l.unit ? `<div class="log-context">${esc(`  • 단원: ${l.unit}`)}</div>` : ""}
          ${l.note ? `<div class="log-note">${esc(l.note)}</div>` : ""}
          ${buildFeedBodyHtml(l.body)}
        </div>
      `).join("") : '<div class="empty">이 날짜에 기록된 학습 내용이 없습니다.</div>'}
    </div>

    <div class="card">
      <h2>📝 다음과제</h2>
      ${nextHomework ? `
        <div class="log-row 과제">
          <div class="log-title-row"><div class="log-title">${esc([nextHomework.book, nextHomework.range].filter(Boolean).join(" · "))}</div><span class="log-pill ${homeworkPillTone(nextHomework.status)}">${esc(nextHomework.status)}</span></div>
          ${nextHomework.unit ? `<div class="log-context">${esc(`  • 단원: ${nextHomework.unit}`)}</div>` : ""}
          ${(nextHomework.note || nextHomework.title) ? `<div class="log-note">${esc(nextHomework.note || nextHomework.title)}</div>` : ""}
          <div class="log-context">  • 마감: ${esc(withDow(nextHomework.due))}</div>
        </div>
      ` : '<div class="empty">예정된 과제가 없습니다.</div>'}
    </div>

    <div class="card">
      <h2>📄 평가</h2>
      ${todaysTests.length ? todaysTests.map((t) => `
        <div class="log-row 평가">
          <div class="log-title-row"><div class="log-title">${esc([t.book, t.range].filter(Boolean).join(" · "))}</div><span class="log-pill ${scorePillTone(t.correct ?? 0, t.total ?? 0)}">${scorePillText(t.correct ?? 0, t.total ?? 0)}</span></div>
          ${t.unit ? `<div class="log-context">${esc(`  • 단원: ${t.unit}`)}</div>` : ""}
          ${(t.note || t.title) ? `<div class="log-note">${esc(t.note || t.title)}</div>` : ""}
        </div>
      `).join("") : '<div class="empty">이 날짜에 기록된 평가가 없습니다.</div>'}
      <div class="feed-divider"></div>
      ${buildTestTrendChartHtml(computeRecentTestPoints(r.tests || [], date, 3))}
    </div>

    <div class="card">
      <h2>💬 선생님 코멘트</h2>
      ${comment ? `<div class="list-item"><div>${esc(comment.text)}</div></div>` : '<div class="empty">등록된 코멘트가 없습니다.</div>'}
    </div>
  `
}

function renderDetail() {
  const r = STUDENT.registrations.find((x) => x.token === selectedToken)
  if (!r) return renderIntro()
  const books = r.books || []
  const homework = r.homework || []
  const tests = r.tests || []
  const comments = r.teacher_comments || []
  const studyLogs = r.study_logs || []
  const tabs = [
    { id: "books", icon: "📚", label: "교재" },
    { id: "calendar", icon: "🗓️", label: "캘린더" },
    { id: "study", icon: "📖", label: "학습기록" },
    { id: "report", icon: "📊", label: "보고서" },
  ]
  if (!tabs.some((t) => t.id === regTab)) regTab = "books"
  const tabBodies = {
    books: `
      <h2>📚 진도 교재</h2>
      <div class="section-hint">진행상황별로 교재를 볼 수 있어요</div>
      <div class="seg-toggle">
        <button class="${bookStatusTab === "진행중" ? "active" : ""}" onclick="setBookStatusTab('진행중')">진행중인 교재</button>
        <button class="${bookStatusTab === "완료" ? "active" : ""}" onclick="setBookStatusTab('완료')">완료된 교재</button>
        <button class="${bookStatusTab === "예정" ? "active" : ""}" onclick="setBookStatusTab('예정')">다음교재</button>
      </div>
      ${(() => {
        const filtered = books.filter((b) => normalizeBookStatus(b.status) === bookStatusTab)
        return `<div class="book-cards-wrap"><div class="book-cards">${filtered.length ? filtered.map((b) => `
        <div class="book-card" onclick="openBookStudy('${esc(b.title).replace(/'/g, "&#39;")}')">
          <div class="cover">${b.cover ? `<img src="${esc(b.cover)}" alt="${esc(b.title)}">` : "📘"}</div>
          <div class="info-overlay">
            <div class="title">${esc(b.title)}</div>
            ${b.progress != null ? `<div class="progress-track"><div class="progress-fill" style="width:${b.progress}%"></div></div><div class="progress-label">${b.progress}%</div>` : ""}
          </div>
        </div>
      `).join("") : `<div class="empty">${bookStatusTab} 교재가 없습니다.</div>`}</div></div>`
      })()}
    `,
    calendar: `
      <h2>🗓️ 캘린더</h2>
      <div class="section-hint">날짜를 탭하면 데일리 리포트를 볼 수 있어요</div>
      <div class="seg-toggle">
        <button class="${calMode === "attendance" ? "active" : ""}" onclick="setCalMode('attendance')">출결 현황</button>
        <button class="${calMode === "homework" ? "active" : ""}" onclick="setCalMode('homework')">과제 현황</button>
      </div>
      <div class="attendance-cal-wrap" id="reg-cal-area">${buildRegCalendarHtml(r, calMode)}</div>
    `,
    study: `
      <h2>📖 진도 학습기록 타임라인</h2>
      <div class="section-hint">학습 · 과제 · 평가 기록을 최신순으로 보여줍니다</div>
      ${(() => {
        const items = []
        studyLogs.forEach((l) => items.push({ type: "학습", icon: "📖", date: l.date, title: [l.book, l.range].filter(Boolean).join(" · ") || "학습 기록", context: l.unit ? `  • 단원: ${l.unit}` : "", note: l.note, photo: l.photo, body: l.body, book: l.book }))
        homework.forEach((h) => items.push({ type: "과제", icon: "📝", date: h.date || h.due, title: [h.book, h.range].filter(Boolean).join(" · "), context: h.unit ? `  • 단원: ${h.unit}` : "", note: h.note || h.title || "", pill: h.status, pillTone: homeworkPillTone(h.status), book: h.book }))
        tests.forEach((t) => items.push({ type: "평가", icon: "📄", date: t.date, title: [t.book, t.range].filter(Boolean).join(" · "), context: t.unit ? `  • 단원: ${t.unit}` : "", note: t.note || t.title || "", pill: scorePillText(t.correct ?? 0, t.total ?? 0), pillTone: scorePillTone(t.correct ?? 0, t.total ?? 0), book: t.book }))
        const sorted = items.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
        const groups = []
        sorted.forEach((l) => {
          const last = groups[groups.length - 1]
          if (last && last.date === l.date) { last.items.push(l) } else { groups.push({ date: l.date, items: [l] }) }
        })
        return groups.length ? groups.map((g) => `
          <div class="log-date-group">
            <div class="log-date-label">${esc(withDow(g.date))}</div>
            ${g.items.map((l) => `
              <div class="log-card ${l.type}">
                <div class="log-top">
                  <div class="log-icon"><span class="log-icon-emoji">${l.icon}</span><span class="log-icon-label">${l.type}</span></div>
                  <div class="log-body">
                    <div class="log-title-row">
                      <div class="log-title">${esc(l.title)}</div>
                      ${l.pill ? `<span class="log-pill ${l.pillTone || ""}">${esc(l.pill)}</span>` : ""}
                    </div>
                    ${l.context ? `<div class="log-context">${esc(l.context)}</div>` : ""}
                    ${l.note ? `<div class="log-note">${esc(l.note)}</div>` : ""}
                  </div>
                </div>
                ${(l.photo || (l.body && buildFeedBodyHtml(l.body))) ? `<div class="log-divider"></div><div class="log-extra">${l.photo ? `<img class="log-photo" src="${esc(l.photo)}" />` : ""}${buildFeedBodyHtml(l.body)}</div>` : ""}
              </div>
            `).join("")}
          </div>
        `).join("") : `<div class="empty">기록이 없습니다.</div>`
      })()}
    `,
    report: buildReportTabHtml(r),
  }
  return `
    <div class="reg-detail-page">
      <div class="reg-header-bar">
        <div class="reg-header-top">
          <button class="reg-back-btn" onclick="goIntro()">←</button>
          <div class="reg-breadcrumb">
            <span class="crumb" onclick="goIntro()">${esc(STUDENT.student_name)}</span>
            <span class="crumb-sep">›</span>
            <span class="crumb" onclick="goIntro()">${r.emoji} ${esc(r.class_name)}</span>
            <span class="crumb-sep">›</span>
            <span class="crumb current">${esc(tabs.find((t) => t.id === regTab)?.icon || "")} ${esc(tabs.find((t) => t.id === regTab)?.label || "")}</span>
          </div>
        </div>
        <div class="reg-head-row stacked">
          <div class="reg-emoji">${r.emoji}</div>
          <div class="reg-title">${esc(r.class_name)}</div>
        </div>
        <div class="reg-sub-badges">
          <span class="sub-badge">${esc(r.status)}</span>
          <span class="sub-badge">${esc(r.class_mode)}</span>
          <span class="sub-badge">담임 ${esc(r.teacher)}</span>
        </div>
        <div class="reg-period">${esc(r.start || "")}${r.end ? " ~ " + esc(r.end) : " ~ 현재"}</div>
      </div>
      <div class="reg-tab-content">${tabBodies[regTab]}</div>
    </div>
    <div class="reg-tabbar">
      ${tabs.map((t) => `<button class="reg-tab-btn ${regTab === t.id ? "active" : ""}" onclick="setRegTab('${t.id}')"><span class="tab-icon">${t.icon}</span>${esc(t.label)}</button>`).join("")}
    </div>
  `
}

let regScrollHandler = null
function detachRegScrollShrink() {
  if (regScrollHandler) {
    window.removeEventListener("scroll", regScrollHandler)
    regScrollHandler = null
  }
  window.onscroll = null
  document.body.classList.remove("reg-expanded")
  const bar = document.querySelector(".reg-header-bar")
  if (bar) bar.classList.remove("expanded")
}
function attachRegScrollShrink() {
  detachRegScrollShrink()
}
function renderApp() {
  if (view === "detail") {
    app.innerHTML = renderDetail()
    attachRegScrollShrink()
  } else if (view === "book") {
    app.innerHTML = renderBookDetail()
    attachRegScrollShrink()
  } else {
    detachRegScrollShrink()
    app.innerHTML = renderIntro()
  }
}

function updateDebugClock() {
  const el = document.getElementById("debug-clock")
  if (!el) return
  const now = new Date()
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    weekday: "short", hour12: false,
  }).format(now)
  el.textContent = `현재 인식 시각(Asia/Seoul): ${parts}`
}
updateDebugClock()
setInterval(updateDebugClock, 1000)

async function initApp() {
  app.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:80vh;color:#8a8a8a;font-size:15px;">불러오는 중...</div>'
  await loadReportFromServer()
  if (DATA_ERROR || !STUDENT) {
    app.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:80vh;gap:12px;color:#666;font-size:15px;text-align:center;padding:0 24px;"><div style="font-size:32px;">⚠️</div><div>' + esc(DATA_ERROR || "데이터를 불러올 수 없어요.") + '</div></div>'
    return
  }
  renderApp()
}
initApp()

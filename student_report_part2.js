function currentReg() {
  return STUDENT.registrations.find((r) => r.token === selectedToken) || null
}

function toShortDate(dateStr) {
  if (!dateStr) return "-"
  const d = new Date(dateStr + "T00:00:00")
  return `${d.getMonth() + 1}/${d.getDate()}`
}

const DOW_KR = ["일", "월", "화", "수", "목", "금", "토"]
function withDow(dateStr) {
  if (!dateStr) return "-"
  const d = new Date(dateStr + "T00:00:00")
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW_KR[d.getDay()]})`
}

function formatDateLabel(dateStr) {
  if (!dateStr) return "-"
  if (dateStr === MOCK_TODAY) return "오늘"
  if (dateStr === addDaysStr(MOCK_TODAY, -1)) return "어제"
  return withDow(dateStr)
}

// ===================== 인트로 페이지 =====================
const DAYS = ["월", "화", "수", "목", "금", "토", "일"]
function buildWeekGridHtml() {
  const activeRegs = STUDENT.registrations.filter((r) => r.status !== "수강종료")
  const byDay = {}
  DAYS.forEach((d) => { byDay[d] = [] })
  activeRegs.forEach((r) => {
    ;(r.schedule || []).forEach((s) => {
      if (byDay[s.day]) {
        byDay[s.day].push({ ...s, emoji: r.emoji, class_name: r.class_name })
      }
    })
  })
  DAYS.forEach((d) => { byDay[d].sort((a, b) => (a.start || "").localeCompare(b.start || "")) })
  return `
    <div class="week-grid">
      ${DAYS.map((d) => `
        <div class="week-col">
          <div class="day-label">${d}</div>
          ${byDay[d].length ? byDay[d].map((s) => `
            <div class="week-slot">
              <div class="slot-time">${esc(s.start)}</div>
              <div>${s.emoji} ${esc(s.class_name)}</div>
            </div>
          `).join("") : ""}
        </div>
      `).join("")}
    </div>
  `
}

function renderIntro() {
  const activeRegs = STUDENT.registrations.filter((r) => r.status !== "수강종료")
  gradeView = gradeView || "table"
  testChartPoints = []
  app.innerHTML = `
    <button class="hamburger-btn" onclick="openMenu()">☰</button>
    <div class="scroll-container">
      <div class="snap-section intro-section" id="intro-section">
        <div class="intro-greeting">안녕하세요 👋</div>
        <div class="intro-name">${esc(STUDENT.student_name)}</div>
        <div class="intro-sub"><span>${esc(STUDENT.school)}</span><span>${esc(STUDENT.grade)}</span></div>
        <div class="class-btn-group">
          ${activeRegs.length ? activeRegs.map((r, i) => `
            <button class="class-btn ${i === 0 ? "primary" : ""}" onclick="openRegistration('${r.token}')">
              <span class="cb-left">
                <span class="cb-emoji">${r.emoji}</span>
                <span class="cb-name-wrap"><span class="cb-class-name">${esc(r.class_name)}</span></span>
              </span>
              <span class="cb-arrow">›</span>
            </button>
          `).join("") : `<div style="color:#fff;opacity:0.85;font-size:13px;">등록된 클래스가 없습니다</div>`}
        </div>
        <div class="swipe-hint" onclick="scrollToTimetable()">시간표 보기<span class="chevron">⌄</span></div>
      </div>
      <div class="snap-section timetable-section" id="timetable-section">
        <div class="up-hint" onclick="scrollToIntro()"><span class="chevron">⌃</span></div>
        <h2>📅 주간 시간표</h2>
        <div class="tt-hint">이번 주 수업 시간표예요</div>
        <div class="section-scroll">${buildWeekGridHtml()}</div>
        <div class="swipe-hint" onclick="scrollToSchedule()">학원 일정 보기<span class="chevron">⌄</span></div>
      </div>
      <div class="snap-section schedule-section" id="schedule-section">
        <div class="up-hint" onclick="scrollToTimetable()"><span class="chevron">⌃</span></div>
        <h2>🏫 학원 일정</h2>
        <div class="section-hint">휴원일, 학원 행사 등 안내사항을 확인하세요</div>
        <div class="section-scroll" id="schedule-cal-area">${buildScheduleCalendarHtml()}</div>
        <div class="swipe-hint" onclick="scrollToGrades()">성적 추이 보기<span class="chevron">⌄</span></div>
      </div>
      <div class="snap-section grades-section" id="grades-section">
        <div class="up-hint" onclick="scrollToSchedule()"><span class="chevron">⌃</span></div>
        <h2>📊 성적 추이</h2>
        <div class="section-hint">시험 점수 변화를 확인하세요</div>
        <div class="section-scroll" id="grades-content-area">${gradesContentHtml()}</div>
      </div>
    </div>
  `
}

function gradesContentHtml() {
  return `
    <div class="view-toggle">
      <button class="${gradeView === "table" ? "active" : ""}" onclick="setGradeView('table')">표로 보기</button>
      <button class="${gradeView === "chart" ? "active" : ""}" onclick="setGradeView('chart')">그래프로 보기</button>
    </div>
    ${STUDENT.grades.length ? (gradeView === "table" ? buildGradeTableHtml(STUDENT.grades) : buildGradeChartHtml(STUDENT.grades)) : `<div class="empty">등록된 성적이 없습니다.</div>`}
  `
}
function setGradeView(v) {
  gradeView = v
  const area = document.getElementById("grades-content-area")
  if (area) area.innerHTML = gradesContentHtml()
  else renderApp()
}

// ===================== 등록 상세 - 달력(출결/과제) =====================
function regCalBaseDate() {
  const [y, m] = MOCK_TODAY.split("-").map(Number)
  return new Date(y, m - 1 + regCalMonthIndex, 1)
}
function navigateRegCalMonth(delta) {
  if (delta < 0 && regCalMonthIndex <= -MAX_LOOKBACK_MONTHS) return
  regCalMonthIndex += delta
  const area = document.getElementById("reg-cal-area")
  if (area) area.innerHTML = buildRegCalendarHtml()
  else renderApp()
}
function goRegCalToday() {
  regCalMonthIndex = 0
  const area = document.getElementById("reg-cal-area")
  if (area) area.innerHTML = buildRegCalendarHtml()
  else renderApp()
}
function setCalMode(mode) {
  calMode = mode
  const area = document.getElementById("reg-cal-area")
  if (area) area.innerHTML = buildRegCalendarHtml()
  else renderApp()
}
function buildRegCalendarHtml() {
  const r = currentReg()
  if (!r) return ""
  const base = regCalBaseDate()
  const y = base.getFullYear()
  const mo = base.getMonth() + 1
  const monthKey = `${y}-${String(mo).padStart(2, "0")}`
  const startWeekday = new Date(y, mo - 1, 1).getDay()
  const daysInMonth = new Date(y, mo, 0).getDate()
  const rows = calMode === "attendance" ? (r.attendance_rows || []) : (r.homework_days || [])
  const byDay = {}
  rows.filter((a) => a.date && a.date.startsWith(monthKey)).forEach((a) => {
    const d = Number(a.date.slice(8, 10))
    byDay[d] = a
  })
  let cells = ""
  for (let i = 0; i < startWeekday; i++) cells += '<div class="cal-cell"></div>'
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`
    const row = byDay[d]
    const today = dateStr === MOCK_TODAY ? "today" : ""
    const statusClass = row ? row.status : ""
    cells += `<div class="cal-cell ${row ? "has-event " + esc(statusClass) : ""} ${today}" ${row ? `onclick="selectCalDay('${dateStr}')"` : ""}><span>${d}</span></div>`
  }
  const summary = calMode === "attendance" ? (r.attendance_summary || { present: 0, absent: 0, makeup: 0 }) : null
  return `
    <div class="attendance-cal-wrap">
      <div class="seg-toggle">
        <button class="${calMode === "attendance" ? "active" : ""}" onclick="setCalMode('attendance')">출결</button>
        <button class="${calMode === "homework" ? "active" : ""}" onclick="setCalMode('homework')">과제</button>
      </div>
      <div class="attendance-calendar">
        <div class="cal-month-nav">
          <button class="cal-nav-btn" ${regCalMonthIndex <= -MAX_LOOKBACK_MONTHS ? "disabled" : ""} onclick="navigateRegCalMonth(-1)">‹</button>
          <div class="cal-month-title">${y}년 ${mo}월</div>
          <div class="cal-nav-right">
            <button class="cal-today-btn" onclick="goRegCalToday()">오늘</button>
            <button class="cal-nav-btn" onclick="navigateRegCalMonth(1)">›</button>
          </div>
        </div>
        <div class="cal-weekdays">${["일", "월", "화", "수", "목", "금", "토"].map((w) => `<div>${w}</div>`).join("")}</div>
        <div class="cal-grid">${cells}</div>
        ${summary ? `
        <div class="cal-summary">
          <div class="cal-summary-item present"><span class="num">${summary.present || 0}</span><span class="lbl">출석</span></div>
          <div class="cal-summary-item absent"><span class="num">${summary.absent || 0}</span><span class="lbl">결석</span></div>
          <div class="cal-summary-item makeup"><span class="num">${summary.makeup || 0}</span><span class="lbl">보강</span></div>
        </div>` : ""}
        <div class="cal-legend">
          <span><span class="dot" style="background:#1e9e5c"></span>출석</span>
          <span><span class="dot" style="background:#e04b4b"></span>결석</span>
          <span><span class="dot" style="background:#2f6fd9"></span>보강</span>
        </div>
        <div class="cal-hint">날짜를 눌러 상세 내용을 확인하세요</div>
      </div>
    </div>
  `
}

// ===================== 등록 상세 - 리포트 =====================
function setReportPeriod(period) {
  reportPeriod = period
  reportOffset = 0
  if (period === "day") reportDayDate = MOCK_TODAY
  renderApp()
}
function navigateReportPeriod(delta) {
  reportOffset += delta
  renderApp()
}
function navigateReportDay(delta) {
  reportDayDate = addDaysStr(reportDayDate || MOCK_TODAY, delta)
  renderApp()
}
function goReportCurrent() {
  reportOffset = 0
  reportDayDate = MOCK_TODAY
  renderApp()
}
function reportRange() {
  if (reportPeriod === "day") {
    const d = reportDayDate || MOCK_TODAY
    return { start: d, end: d }
  }
  if (reportPeriod === "month") {
    const [y, m] = MOCK_TODAY.split("-").map(Number)
    const base = new Date(y, m - 1 + reportOffset, 1)
    const by = base.getFullYear()
    const bm = base.getMonth() + 1
    const start = `${by}-${String(bm).padStart(2, "0")}-01`
    const end = `${by}-${String(bm).padStart(2, "0")}-${String(new Date(by, bm, 0).getDate()).padStart(2, "0")}`
    return { start, end }
  }
  const monday = mondayOfWeek(MOCK_TODAY)
  const start = addDaysStr(monday, reportOffset * 7)
  const end = addDaysStr(start, 6)
  return { start, end }
}

function computeTestTrendPoints(tests) {
  const sorted = tests.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""))
  return sorted.map((t) => ({ date: t.date, correct: t.correct, total: t.total, items: [t], label: withDow(t.date) }))
}
function computeRecentTestPoints(tests, limit) {
  const sorted = tests.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""))
  return sorted.slice(-limit)
}
function buildTestTrendChartHtml(tests) {
  const points = computeRecentTestPoints(tests, 8)
  testChartPoints = points.map((t) => ({ label: withDow(t.date), items: [t] }))
  if (!points.length) return `<div class="empty">평가 기록이 없습니다.</div>`
  const width = 400, height = 200
  const paddingLeft = 30, paddingRight = 14, paddingTop = 16, paddingBottom = 30
  const plotWidth = width - paddingLeft - paddingRight
  const xStep = points.length > 1 ? plotWidth / (points.length - 1) : 0
  const yFor = (pct) => height - paddingBottom - (pct / 100) * (height - paddingTop - paddingBottom)
  const xFor = (i) => points.length > 1 ? paddingLeft + i * xStep : paddingLeft + plotWidth / 2
  const pcts = points.map((p) => (p.total ? Math.round((p.correct / p.total) * 100) : 0))
  const path = pcts.map((p, i) => `${xFor(i)},${yFor(p)}`).join(" ")
  const dots = pcts.map((p, i) => `<circle cx="${xFor(i)}" cy="${yFor(p)}" r="4" fill="#6c5ce7" style="cursor:pointer" onclick="showTestDetailModal(${i})" />`).join("")
  const labels = pcts.map((p, i) => `<text x="${xFor(i)}" y="${yFor(p) - 10}" font-size="11" font-weight="700" fill="#6c5ce7" text-anchor="middle">${p}점</text>`).join("")
  const ticks = [0, 25, 50, 75, 100]
  const gridLines = ticks.map((v) => `
    <line x1="${paddingLeft}" y1="${yFor(v)}" x2="${width - paddingRight}" y2="${yFor(v)}" stroke="#eee" stroke-width="1" />
    <text x="${paddingLeft - 6}" y="${yFor(v) + 3}" font-size="9" fill="#bbb" text-anchor="end">${v}</text>
  `).join("")
  const xAxisTicks = points.map((p, i) => `<text x="${xFor(i)}" y="${height - paddingBottom + 14}" font-size="9" fill="#bbb" text-anchor="middle">${esc(toShortDate(p.date))}</text>`).join("")
  return `
    <div class="chart-wrap"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">${gridLines}<polyline points="${path}" fill="none" stroke="#6c5ce7" stroke-width="2" />${dots}${labels}${xAxisTicks}</svg></div>
  `
}

function findNextHomework(r) {
  const upcoming = (r.homework || []).filter((h) => h.status !== "제출" && h.due >= MOCK_TODAY).sort((a, b) => (a.due || "").localeCompare(b.due || ""))
  return upcoming[0] || null
}
function findLatestComment(r) {
  const sorted = (r.teacher_comments || []).slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""))
  return sorted[0] || null
}

function buildDailyBodyHtml(r, dateStr) {
  const items = []
  ;(r.study_logs || []).filter((l) => l.date === dateStr).forEach((l) => items.push({ type: "학습", title: [l.book, l.range].filter(Boolean).join(" · "), meta: l.unit ? `단원: ${l.unit}` : "" }))
  ;(r.homework || []).filter((h) => (h.date || h.due) === dateStr).forEach((h) => items.push({ type: "과제", title: h.note || h.title || [h.book, h.range].filter(Boolean).join(" · "), meta: h.status }))
  ;(r.tests || []).filter((t) => t.date === dateStr).forEach((t) => items.push({ type: "평가", title: t.note || t.title || [t.book, t.range].filter(Boolean).join(" · "), meta: scorePillText(t.correct ?? 0, t.total ?? 0) }))
  if (!items.length) return `<div class="empty">이 날의 기록이 없습니다.</div>`
  return items.map((it) => `
    <div class="day-detail-item">
      <span class="tag ${it.type}">${it.type}</span>
      <div>
        <div class="title">${esc(it.title)}</div>
        ${it.meta ? `<div class="meta">${esc(it.meta)}</div>` : ""}
      </div>
    </div>
  `).join("")
}

function buildReportTabHtml() {
  const r = currentReg()
  if (!r) return ""
  const { start, end } = reportRange()
  const attendanceInRange = (r.attendance_rows || []).filter((a) => a.date >= start && a.date <= end)
  const presentCount = attendanceInRange.filter((a) => a.status === "출석").length
  const totalAttendance = attendanceInRange.length
  const homeworkInRange = (r.homework || []).filter((h) => (h.date || h.due) >= start && (h.date || h.due) <= end)
  const submittedCount = homeworkInRange.filter((h) => h.status === "제출").length
  const totalHomework = homeworkInRange.length
  const testsInRange = (r.tests || []).filter((t) => t.date >= start && t.date <= end)
  const periodLabel = reportPeriod === "day" ? formatDateLabel(reportDayDate) : reportPeriod === "week" ? `${toShortDate(start)} ~ ${toShortDate(end)}` : `${start.slice(0, 7)}`
  const commentsInRange = (r.report_comments || []).filter((c) => (c.end || c.start) >= start && c.start <= end)
  const navFn = reportPeriod === "day" ? "navigateReportDay" : "navigateReportPeriod"
  return `
    <div class="cal-month-nav" style="margin-bottom:14px;">
      <button class="cal-nav-btn" onclick="${navFn}(-1)">‹</button>
      <div class="cal-month-title" style="font-size:15px;">${esc(periodLabel)}</div>
      <div class="cal-nav-right">
        <button class="cal-today-btn" onclick="goReportCurrent()">오늘</button>
        <button class="cal-nav-btn" onclick="${navFn}(1)">›</button>
      </div>
    </div>
    <div class="seg-toggle">
      <button class="${reportPeriod === "week" ? "active" : ""}" onclick="setReportPeriod('week')">주간</button>
      <button class="${reportPeriod === "month" ? "active" : ""}" onclick="setReportPeriod('month')">월간</button>
      <button class="${reportPeriod === "day" ? "active" : ""}" onclick="setReportPeriod('day')">일간</button>
    </div>
    ${reportPeriod !== "day" ? `
    <div class="report-donut-row">
      <div class="donut-card">
        <div class="donut-title">출석률</div>
        <div class="donut" style="background:conic-gradient(#6c5ce7 ${totalAttendance ? (presentCount / totalAttendance) * 360 : 0}deg, #f0eefc 0deg);">
          <div class="donut-hole">${totalAttendance ? Math.round((presentCount / totalAttendance) * 100) : 0}%</div>
        </div>
        <div class="donut-count-below">${presentCount}/${totalAttendance}일</div>
      </div>
      <div class="donut-card">
        <div class="donut-title">과제 제출률</div>
        <div class="donut" style="background:conic-gradient(#6c5ce7 ${totalHomework ? (submittedCount / totalHomework) * 360 : 0}deg, #f0eefc 0deg);">
          <div class="donut-hole">${totalHomework ? Math.round((submittedCount / totalHomework) * 100) : 0}%</div>
        </div>
        <div class="donut-count-below">${submittedCount}/${totalHomework}건</div>
      </div>
    </div>
    ${testsInRange.length ? `<h2 style="margin-top:18px;">📄 평가 결과</h2>${testsInRange.map((t) => `
      <div class="test-bar-row">
        <div class="title">${esc([t.book, t.range].filter(Boolean).join(" · ") || t.title || "평가")}</div>
        <div class="meta">${esc(withDow(t.date))} · ${scorePillText(t.correct ?? 0, t.total ?? 0)}</div>
        <div class="test-bar-track"><div class="test-bar-fill" style="width:${t.total ? Math.round((t.correct / t.total) * 100) : 0}%"></div></div>
      </div>
    `).join("")}` : ""}
    ` : `
    <div class="log-card">${buildDailyBodyHtml(r, reportDayDate || MOCK_TODAY)}</div>
    `}
    ${commentsInRange.length ? `<h2 style="margin-top:18px;">✏️ 선생님 코멘트</h2>${commentsInRange.map((c) => `<div class="log-card"><div class="log-note">${esc(c.comment)}</div></div>`).join("")}` : ""}
  `
}

// ===================== 등록 상세 - 메인 =====================
function renderDetail() {
  const r = currentReg()
  if (!r) return renderIntro()
  const booksFiltered = (r.books || []).filter((b) => b.status === bookStatusTab)
  const tabContent = regTab === "books" ? `
      <div class="status-box-row">
        ${["진행중", "완료", "예정"].map((s) => `<div class="status-box"><div class="label">${s}</div><div>${(r.books || []).filter((b) => b.status === s).length}</div></div>`).join("")}
      </div>
      <div class="seg-toggle">
        ${["진행중", "완료", "예정"].map((s) => `<button class="${bookStatusTab === s ? "active" : ""}" onclick="setBookStatusTab('${s}')">${s}</button>`).join("")}
      </div>
      <div class="book-cards-wrap">
        <div class="book-cards">
          ${booksFiltered.length ? booksFiltered.map((b) => `
            <div class="book-card" onclick="openBookStudy('${esc(b.title).replace(/'/g, "&#39;")}')">
              <div class="cover">${b.cover ? `<img src="${esc(b.cover)}" />` : "📘"}</div>
              <div class="info-overlay">
                <div class="title">${esc(b.title)}</div>
                ${b.progress != null ? `<div class="progress-track"><div class="progress-fill" style="width:${b.progress}%"></div></div><div class="progress-label">${b.progress}%</div>` : ""}
              </div>
            </div>
          `).join("") : `<div class="empty">해당 교재가 없습니다.</div>`}
        </div>
      </div>
    ` : regTab === "calendar" ? `
      <div id="reg-cal-area">${buildRegCalendarHtml()}</div>
    ` : regTab === "study" ? `
      ${(r.study_logs && r.study_logs.length) ? r.study_logs.slice().sort((a, b) => (b.date || "").localeCompare(a.date || "")).map((l) => `
        <div class="log-card 학습">
          <div class="log-top">
            <div class="log-icon"><span class="log-icon-emoji">📖</span><span class="log-icon-label">학습</span></div>
            <div class="log-body">
              <div class="log-title-row"><div class="log-title">${esc([l.book, l.range].filter(Boolean).join(" · "))}</div></div>
              ${l.unit ? `<div class="log-context">  • 단원: ${esc(l.unit)}</div>` : ""}
              <div class="log-context">  • 날짜: ${esc(withDow(l.date))}</div>
              ${l.note ? `<div class="log-note">${esc(l.note)}</div>` : ""}
            </div>
          </div>
          ${(l.photo || (l.body && buildFeedBodyHtml(l.body))) ? `<div class="log-divider"></div><div class="log-extra">${l.photo ? `<img class="log-photo" src="${esc(l.photo)}" />` : ""}${buildFeedBodyHtml(l.body)}</div>` : ""}
        </div>
      `).join("") : `<div class="empty">학습 기록이 없습니다.</div>`}
    ` : buildReportTabHtml()

  return `
    <div class="reg-detail-page">
      <div class="reg-header-bar" id="reg-header-bar">
        <div class="reg-header-top">
          <button class="reg-back-btn" onclick="goIntro()">←</button>
          <div class="reg-breadcrumb">
            <span class="crumb" onclick="goIntro()">${esc(STUDENT.student_name)}</span>
            <span class="crumb-sep">›</span>
            <span class="crumb current">${r.emoji} ${esc(r.class_name)}</span>
          </div>
        </div>
        <div class="reg-cover-wrap">
          <div class="reg-cover-img">${r.emoji}</div>
        </div>
        <div class="reg-head-row stacked">
          <div class="reg-title">${esc(r.class_name)}</div>
        </div>
        <div class="reg-sub-badges">
          <span class="sub-badge">${esc(r.status)}</span>
          ${r.teacher ? `<span class="sub-badge">👩‍🏫 ${esc(r.teacher)}</span>` : ""}
        </div>
        <div class="reg-period">${esc(toShortDate(r.start))} ~ ${r.end ? esc(toShortDate(r.end)) : "현재"}</div>
        <div class="reg-divider"></div>
      </div>
      <div class="reg-tab-content" id="reg-tab-content">
        <h2>${regTab === "books" ? "📚 교재" : regTab === "calendar" ? "🗓️ 출결/과제" : regTab === "study" ? "📖 학습기록" : "📊 리포트"}</h2>
        ${tabContent}
      </div>
      <div class="reg-tabbar">
        <button class="reg-tab-btn ${regTab === "books" ? "active" : ""}" onclick="setRegTab('books')"><span class="tab-icon">📚</span>교재</button>
        <button class="reg-tab-btn ${regTab === "calendar" ? "active" : ""}" onclick="setRegTab('calendar')"><span class="tab-icon">🗓️</span>출결/과제</button>
        <button class="reg-tab-btn ${regTab === "study" ? "active" : ""}" onclick="setRegTab('study')"><span class="tab-icon">📖</span>학습기록</button>
        <button class="reg-tab-btn ${regTab === "report" ? "active" : ""}" onclick="setRegTab('report')"><span class="tab-icon">📊</span>리포트</button>
      </div>
    </div>
  `
}

let regScrollHandler = null
function attachRegScrollShrink() {
  regScrollHandler = () => {
    const bar = document.getElementById("reg-header-bar")
    if (!bar) return
    if (window.scrollY > 40) {
      bar.classList.remove("expanded")
      document.body.classList.remove("reg-expanded")
    } else {
      bar.classList.add("expanded")
      document.body.classList.add("reg-expanded")
    }
  }
  window.addEventListener("scroll", regScrollHandler)
  regScrollHandler()
}
function detachRegScrollShrink() {
  if (regScrollHandler) {
    window.removeEventListener("scroll", regScrollHandler)
    regScrollHandler = null
  }
  document.body.classList.remove("reg-expanded")
}

function renderApp() {
  detachRegScrollShrink()
  if (DATA_ERROR) {
    app.innerHTML = `<div class="detail-page"><div class="card"><div class="empty">${esc(DATA_ERROR)}</div></div></div>`
    return
  }
  if (!STUDENT) {
    app.innerHTML = `<div class="detail-page"><div class="card"><div class="empty">불러오는 중...</div></div></div>`
    return
  }
  if (view === "book") {
    app.innerHTML = renderBookDetail()
    attachRegScrollShrink()
  } else if (view === "detail") {
    app.innerHTML = renderDetail()
    attachRegScrollShrink()
  } else {
    renderIntro()
  }
}

function updateDebugClock() {
  const el = document.getElementById("debug-clock")
  if (!el) return
  const now = new Date()
  el.textContent = now.toLocaleTimeString("ko-KR", { hour12: false, timeZone: "Asia/Seoul" })
}
updateDebugClock()
setInterval(updateDebugClock, 1000)

async function initApp() {
  renderApp()
  await loadReportFromServer()
  renderApp()
}
initApp()

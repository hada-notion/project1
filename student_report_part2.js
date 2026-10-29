function renderSchedulePage() {
  return `
    <div class="sub-page">
      <div class="header-plain"><button class="back-btn-plain" onclick="goIntro()" aria-label="뒤로가기"><svg class="header-icon" viewBox="0 0 24 24" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg></button></div>
      <div class="card">
        <h2><span class="page-title-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg></span>일정정보</h2>
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
          ${byDay[d].length ? byDay[d].map((s) => {
            const p = pickClassColorPalette(s.class_name)
            return `<div class="week-slot" style="background:${p.bg};color:${p.fg}"><div class="slot-time">${esc(s.start)}</div>${esc(s.class_name)}</div>`
          }).join("") : ""}
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
        <button class="hamburger-btn" onclick="openMenu()" aria-label="메뉴 열기"><svg class="header-icon" viewBox="0 0 24 24" aria-hidden="true"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg></button>
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
        <div class="swipe-hint" onclick="scrollToTimetable()">통합 시간표 보기<span class="chevron"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="7 13 12 18 17 13"></polyline><polyline points="7 6 12 11 17 6"></polyline></svg></span></div>
      </div>
      <div class="snap-section timetable-section" id="timetable-section">
        <button class="hamburger-btn dark" onclick="openMenu()" aria-label="메뉴 열기"><svg class="header-icon" viewBox="0 0 24 24" aria-hidden="true"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg></button>
        <h2><span class="page-title-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"></path></svg></span>통합 시간표</h2>
        <div class="tt-hint">현재 수강중인 반들만 요일별로 합쳐서 보여줘요</div>
        <div class="tt-card">${buildWeekGridHtml(s.registrations)}</div>
        <div class="up-hint" onclick="scrollToIntro()"><span class="chevron"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="17 11 12 6 7 11"></polyline><polyline points="17 18 12 13 7 18"></polyline></svg></span>이전으로</div>
        <div class="swipe-hint" onclick="scrollToSchedule()">일정 보기<span class="chevron"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="7 13 12 18 17 13"></polyline><polyline points="7 6 12 11 17 6"></polyline></svg></span></div>
      </div>
      <div class="snap-section schedule-section" id="schedule-section">
        <button class="hamburger-btn dark" onclick="openMenu()" aria-label="메뉴 열기"><svg class="header-icon" viewBox="0 0 24 24" aria-hidden="true"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg></button>
        <h2><span class="page-title-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg></span>일정</h2>
        <div class="section-hint">학원 일정과 학교 일정을 확인할 수 있어요</div>
        <div id="schedule-cal-area" style="width:100%">${buildScheduleCalendarHtml()}</div>
        <div class="up-hint" onclick="scrollToTimetable()"><span class="chevron"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="17 11 12 6 7 11"></polyline><polyline points="17 18 12 13 7 18"></polyline></svg></span>이전으로</div>
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

// [NEW, 2026-09-19, 자리 이동: 10-12] report_cache 기반 화면(캘린더 등)은 sync-report-cache 큐 처리(웹훅/1시간
// 주기 동기화/야간 점검)가 끝나야 반영되므로, 방금 키오스크에서 체크인/체크아웃한 직후에는 화면이 곧바로
// 바뀌지 않을 수 있다. 처음에는 캘린더 탭에만 있는 버튼으로 만들었지만, 교재·학습기록·보고서 탭이나 인트로
// 화면에서도 최신 상태를 바로 확인하고 싶다는 요청에 따라 우측 하단 플로팅 버튼(FAB)으로 옮겼다.
// 특정 등록 화면(캘린더 탭이 아니어도 상관없이 등록이 열려 있으면)에서는 그 등록만, 등록을 선택하지 않은
// 인트로 화면에서는 학생의 모든 등록을 한 번에 동기화한다.
// (v2.7.19) 서버는 키 없는 요청을 자기 리포트 토큰으로만 받는다. 등록마다 그 등록의 토큰을 함께 보낸다.
async function requestSyncForRegistrationId(registrationId, token) {
  if (!registrationId || !token) return
  await fetch(`${SUPABASE_URL}/functions/v1/sync-report-cache`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ registrationId, token }),
  })
}
function setGlobalSyncFabState(syncing) {
  const btn = document.getElementById("global-sync-fab")
  if (!btn) return
  btn.disabled = syncing
  btn.classList.toggle("syncing", syncing)
}
let globalSyncToastTimer = null
function renderGlobalSyncToast(message) {
  globalSyncMessage = message || ""
  const el = document.getElementById("global-sync-toast")
  if (!el) return
  if (globalSyncToastTimer) { clearTimeout(globalSyncToastTimer); globalSyncToastTimer = null }
  if (!message) { el.innerHTML = ""; el.classList.remove("show"); return }
  el.innerHTML = message
  el.classList.add("show")
  globalSyncToastTimer = setTimeout(() => { el.classList.remove("show") }, 3500)
}
async function requestGlobalSync() {
  if (globalSyncing) return
  globalSyncing = true
  setGlobalSyncFabState(true)
  renderGlobalSyncToast("")
  try {
    const r = currentReg()
    const targets = r ? [r] : (STUDENT?.registrations || [])
    const seen = new Set()
    const pairs = targets.filter((t) => t.registration_id && t.token && !seen.has(t.registration_id) && seen.add(t.registration_id))
    // registrationId를 명시한 웹앱 요청은 토큰·출석 원본·학습기록·학습활동·완성 캐시까지
    // 동기로 최신화한 뒤 응답한다. 모든 등록이 끝난 뒤 최신 데이터를 다시 불러온다.
    // 학생의 여러 등록을 한꺼번에 열지 않고 하나씩 처리해 Notion API 부하를 분산한다.
    for (const t of pairs) await requestSyncForRegistrationId(t.registration_id, t.token)
    await loadReportFromServer()
    renderApp()
    renderGlobalSyncToast('<span class="inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg></span>최신 정보로 갱신했어요')
  } catch (e) {
    renderGlobalSyncToast("동기화에 실패했어요. 잠시 후 다시 시도해주세요")
  } finally {
    globalSyncing = false
    setGlobalSyncFabState(false)
  }
}
// ===== 학습·과제·평가 공통 표시 =====
// 리포트 학습기록 카드와 같은 분류 아이콘·색을 홈·보고서·캘린더에서 함께 쓴다.
const KIND_ICONS = {
  "학습": `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`,
  "과제": `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>`,
  "평가": `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`,
}
const CHEVRON_DOWN_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`
const CHEVRON_RIGHT_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>`
function kindTileHtml(kind) {
  return `<div class="kind-tile ${kind}">${KIND_ICONS[kind] || ""}<b>${kind}</b></div>`
}
// 기록 한 건. 본문이 있으면 학습기록 카드와 같은 펼침(.log-meta 안 화살표 → 바로 다음 .log-extra)을 쓴다.
function kindBlockHtml(kind, opts) {
  const { title, pill, pillTone, sub, item, metaExtra } = opts
  const meta = item ? renderLogMetaRows(item.unit, item.note, metaExtra || []) : ""
  const bodyHtml = item ? buildLogBodyHtml(item) : ""
  const chevronBtn = bodyHtml ? `<button type="button" class="log-extra-chevron" onclick="toggleLogExtra(this)" aria-label="펼치기">${CHEVRON_DOWN_SVG}</button>` : ""
  const metaHtml = (meta || chevronBtn) ? `<div class="log-meta">${meta}${chevronBtn}</div>` : ""
  const extraHtml = bodyHtml ? `<div class="log-extra">${bodyHtml}</div>` : ""
  return `
    <div class="kind-block">
      <div class="kind-row">
        ${kindTileHtml(kind)}
        <div class="kind-row-body">
          <div class="kind-row-title">${esc(title || kind + " 기록")}${pill ? `<span class="log-pill ${pillTone || ""}">${esc(pill)}</span>` : ""}</div>
          ${sub ? `<div class="kind-row-sub">${esc(sub)}</div>` : ""}
        </div>
      </div>
      ${metaHtml}${extraHtml}
    </div>
  `
}
function kindEmptyHtml(kind, text) {
  return `<div class="kind-block"><div class="kind-row">${kindTileHtml(kind)}<div class="kind-row-body"><div class="kind-row-empty">${esc(text)}</div></div></div></div>`
}
function shortDateDow(date) {
  if (!date) return ""
  const s = String(date).slice(0, 10)
  const [y, m, d] = s.split("-").map(Number)
  if (!y || !m || !d) return s
  const weekday = ["일", "월", "화", "수", "목", "금", "토"][new Date(y, m - 1, d).getDay()]
  return `${m}/${d} (${weekday})`
}

// ===== 수업일 계산 (캘린더·홈) =====
// 리포트 저장 데이터의 출석 행은 오늘까지만 들어온다. 지난 수업은 출석 행으로, 앞으로 남은 수업은
// 시간표 요일로 계산하고 휴원 일정·등록 기간 밖의 날은 뺀다.
const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"]
function closedDateSet() {
  return new Set((STUDENT?.notices || []).filter((n) => n.date && normalizeCategoryName(n.category) === "휴원").map((n) => String(n.date).slice(0, 10)))
}
function isPlannedClassDate(r, dateStr, closed) {
  if (!r || !dateStr) return false
  if (r.status === "수강종료") return false
  if (r.start && dateStr < r.start) return false
  if (r.end && dateStr > r.end) return false
  if (closed && closed.has(dateStr)) return false
  const [y, m, d] = dateStr.split("-").map(Number)
  const dow = DOW_KO[new Date(y, m - 1, d).getDay()]
  return (r.schedule || []).some((s) => s.day === dow)
}
function attendanceByDate(r) {
  const map = {}
  ;(r.attendance_rows || []).forEach((a) => { if (a.date) map[a.date] = a.status || "" })
  return map
}
// 한 달의 수업 목록: [{ date, status, planned }]. 지난 수업(출석 행)은 status, 남은 수업은 planned.
function monthSessions(r, y, m) {
  const monthKey = `${y}-${String(m).padStart(2, "0")}`
  const att = attendanceByDate(r)
  const closed = closedDateSet()
  // 지난 수업은 실제 출석 행만 센다(시간표만으로는 그날 수업이 실제로 열렸는지 알 수 없다). 상태가 빈 행은
  // 출결 미입력(빗금), 오늘 상태가 빈 행은 아직 수업 전이라 남은 수업으로 본다.
  const list = Object.keys(att).filter((d) => d.startsWith(monthKey))
    .map((d) => ({ date: d, status: att[d], planned: !att[d] && d >= MOCK_TODAY }))
  // 앞으로의 수업은 리포트 저장본에 출석 행이 없으므로 시간표로 계산한다(휴원·등록 기간 밖 제외).
  const daysInMonth = new Date(y, m, 0).getDate()
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${monthKey}-${String(day).padStart(2, "0")}`
    if (dateStr < MOCK_TODAY || att[dateStr] !== undefined || !isPlannedClassDate(r, dateStr, closed)) continue
    list.push({ date: dateStr, status: "", planned: true })
  }
  return list.sort((a, b) => a.date.localeCompare(b.date))
}

// ===== 캘린더 탭 =====
// 과제 마감일별 묶음과 그날 상태: 모두 제출 → 완료, 일부 제출 → 부분완료, 제출 없이 마감 지남 → 미완료,
// 아직 마감 전 → 예정(테두리)
function homeworkDueMap(r) {
  const map = {}
  ;(r.homework || []).forEach((h) => { const d = String(h.due || "").slice(0, 10); if (d) (map[d] = map[d] || []).push(h) })
  return map
}
function homeworkDueStatus(list, dateStr) {
  const done = list.filter((h) => h.status === "제출").length
  if (done === list.length) return "완료"
  if (dateStr >= MOCK_TODAY) return "plan"
  return done ? "부분완료" : "미완료"
}
function buildHomeworkBarHtml(r, y, m, withChips) {
  const monthKey = `${y}-${String(m).padStart(2, "0")}`
  const items = (r.homework || []).filter((h) => String(h.due || "").startsWith(monthKey)).sort((a, b) => String(a.due).localeCompare(String(b.due)))
  const state = (h) => h.status === "제출" ? "완료" : String(h.due).slice(0, 10) < MOCK_TODAY ? "미완료" : ""
  const done = items.filter((h) => state(h) === "완료").length
  const late = items.filter((h) => state(h) === "미완료").length
  const chips = withChips ? `<div class="session-chips"><div class="present"><b>${done}</b>제출</div><div class="absent"><b>${late}</b>미제출</div><div><b>${items.length - done - late}</b>남은 과제</div></div>` : ""
  return `
    <div class="session-bar-card">
      <div class="session-bar"><span class="lbl">${m}월 과제</span><div class="cells">${items.map((h) => `<i class="${state(h)}"></i>`).join("") || "<i></i>"}</div><b>${done} / ${items.length} 제출</b></div>
      ${chips}
    </div>
  `
}
// 도넛 색(docs/DESIGN.md 1부 3장): 비율·점수 4구간을 중간 톤으로. 가운데 숫자로 값을 읽으므로 그림 대비 3:1 대상이 아니다.
function bandChartColor(v) {
  const n = Number(v) || 0
  return n >= 90 ? "var(--chart-good)" : n >= 70 ? "var(--chart-fair)" : n >= 50 ? "var(--chart-low)" : "var(--chart-poor)"
}
function buildSessionBarHtml(r, y, m, mode, withChips) {
  if (mode !== "attendance") return buildHomeworkBarHtml(r, y, m, withChips)
  const sessions = monthSessions(r, y, m)
  const past = sessions.filter((s) => !s.planned)
  const remaining = sessions.length - past.length
  const cells = sessions.map((s) => {
    if (s.planned) return "<i></i>"
    const st = ["출석", "결석", "보강"].find((k) => String(s.status).includes(k))
    return `<i class="${st || "지남"}"></i>`
  }).join("")
  const count = (kw) => past.filter((s) => String(s.status).includes(kw)).length
  const chips = withChips
    ? `<div class="session-chips"><div class="present"><b>${count("출석")}</b>출석</div><div class="absent"><b>${count("결석")}</b>결석</div><div class="makeup"><b>${count("보강")}</b>보강</div><div><b>${remaining}</b>남은 수업</div></div>`
    : ""
  return `
    <div class="session-bar-card">
      <div class="session-bar"><span class="lbl">${m}월 수업</span><div class="cells">${cells || "<i></i>"}</div><b>${past.length} / ${sessions.length}회</b></div>
      ${chips}
    </div>
  `
}
function calDayCellHtml(r, dateStr, mode, maps) {
  const [, , dd] = dateStr.split("-").map(Number)
  let status = ""
  let planned = false
  let missing = false
  if (mode === "attendance") {
    status = ["출석", "결석", "보강"].find((k) => String(maps.att[dateStr] || "").includes(k)) || ""
    const hasRow = maps.att[dateStr] !== undefined
    if (!status && hasRow) {
      // 출석 행은 있는데 상태가 비었음: 지난 날은 출결 미입력, 오늘은 아직 수업 전(예정)
      missing = dateStr < MOCK_TODAY
      planned = dateStr >= MOCK_TODAY
    } else if (!hasRow) {
      planned = dateStr >= MOCK_TODAY && isPlannedClassDate(r, dateStr, maps.closed)
    }
  } else if (maps.due[dateStr]) {
    const st = homeworkDueStatus(maps.due[dateStr], dateStr)
    if (st === "plan") planned = true
    else status = st
  }
  const classes = ["cal-day", status || (planned ? "plan" : missing ? "missing" : "empty-day")]
  if (dateStr === MOCK_TODAY) classes.push("today")
  if (dateStr === selectedCalDate) classes.push("picked")
  return `<div class="${classes.join(" ")}" onclick="selectCalDay('${dateStr}')"><span>${dd}</span></div>`
}
function buildRegCalendarHtml(r, mode) {
  if (!r) return '<div class="empty">등록 정보가 없습니다.</div>'
  const maps = { att: attendanceByDate(r), due: homeworkDueMap(r), closed: closedDateSet() }
  const dowHeader = calDowHtml("cal-dow")
  const legend = mode === "attendance"
    ? `<div class="cal-legend"><span><span class="dot" style="background:var(--success)"></span>출석</span><span><span class="dot" style="background:var(--danger)"></span>결석</span><span><span class="dot" style="background:var(--info)"></span>보강</span></div>`
    : `<div class="cal-legend"><span><span class="dot" style="background:var(--success)"></span>제출</span><span><span class="dot" style="background:var(--warning-graphic)"></span>일부 제출</span><span><span class="dot" style="background:var(--danger)"></span>미제출</span></div>`

  // 날짜를 고른 상태: 그 주 한 줄 + 아래에 그날 기록
  if (selectedCalDate) {
    const weekStart = calWeekStart(selectedCalDate)
    const weekEnd = addDaysStr(weekStart, 6)
    const [sy, sm] = selectedCalDate.split("-").map(Number)
    const cells = Array.from({ length: 7 }, (_, i) => calDayCellHtml(r, addDaysStr(weekStart, i), mode, maps)).join("")
    return `
      ${buildSessionBarHtml(r, sy, sm, mode, false)}
      <div class="attendance-calendar">
        <div class="cal-month-nav">
          <button class="cal-nav-btn" onclick="moveCalDayWeek(-7)" aria-label="이전 주">‹</button>
          <div class="cal-month-title">${shortDateDow(weekStart).split(" ")[0]} ~ ${shortDateDow(weekEnd).split(" ")[0]}</div>
          <div class="cal-nav-right"><button class="cal-nav-btn" onclick="moveCalDayWeek(7)" aria-label="다음 주">›</button></div>
        </div>
        <div class="cal-grid">${dowHeader}${cells}</div>
        <div class="cal-foot"><span></span><button type="button" class="cal-collapse-btn" onclick="clearCalDay()">${CHEVRON_DOWN_SVG}월 전체 보기</button>${weekStartToggleHtml()}</div>
      </div>
      ${buildCalDayPanelHtml(r, selectedCalDate)}
    `
  }

  const base = regCalBaseDate()
  const y = base.getFullYear()
  const m = base.getMonth() + 1
  const monthKey = `${y}-${String(m).padStart(2, "0")}`
  const leading = calLeadingDays(y, m)
  const daysInMonth = new Date(y, m, 0).getDate()
  const cells = []
  for (let i = 0; i < leading; i++) cells.push('<div class="cal-day empty"></div>')
  for (let day = 1; day <= daysInMonth; day++) cells.push(calDayCellHtml(r, `${monthKey}-${String(day).padStart(2, "0")}`, mode, maps))
  return `
    ${buildSessionBarHtml(r, y, m, mode, true)}
    <div class="attendance-calendar">
      <div class="cal-month-nav">
        <button class="cal-nav-btn" ${regCalMonthIndex <= -MAX_LOOKBACK_MONTHS ? "disabled" : ""} onclick="navigateRegCalMonth(-1)">‹</button>
        <div class="cal-month-title">${y}년 ${m}월</div>
        <div class="cal-nav-right">
          <button class="cal-today-btn" onclick="goRegCalToday()">오늘</button>
          <button class="cal-nav-btn" onclick="navigateRegCalMonth(1)">›</button>
        </div>
      </div>
      <div class="cal-grid">${dowHeader}${cells.join("")}</div>
      <div class="cal-foot"><span></span>${legend}${weekStartToggleHtml()}</div>
    </div>
  `
}
function moveCalDayWeek(days) {
  if (!selectedCalDate) return
  const next = addDaysStr(selectedCalDate, days)
  const [ny, nm] = next.split("-").map(Number)
  const [ty, tm] = MOCK_TODAY.split("-").map(Number)
  const monthIndex = (ny - ty) * 12 + (nm - tm)
  if (monthIndex < -MAX_LOOKBACK_MONTHS) return
  selectedCalDate = next
  regCalMonthIndex = monthIndex
  renderApp()
}
// 학습기록 카드 한 장(v2.5.101: 학습기록 탭과 캘린더 날짜 목록 공용, 내용은 학습기록 탭 그대로).
// 날짜로 묶인 목록이라 과제는 출제일 대신 "마감:"만, 본문·사진이 있을 때만 펼치기(⌄).
function logCardHtml(l) {
  return `
              <div class="log-card ${l.type}">
                <div class="log-top">
                  <div class="log-icon"><span class="log-icon-emoji">${l.icon}</span><span class="log-icon-label">${l.type}</span></div>
                  <div class="log-body">
                    <div class="log-title-row"><div class="log-title">${esc(l.title)}</div>${l.pill ? `<span class="log-pill ${l.pillTone || ""}">${esc(l.pill)}</span>` : ""}</div>
                  </div>
                </div>
                ${l.compare || ""}
                ${(() => {
                  // (v2.5.98) 날짜로 묶인 목록이라 출제일은 묶음 날짜와 같아 빼고 마감만 보인다.
                  const meta = renderLogMetaRows(l.unit, l.note, [...(l.type === "과제" && l.due ? [`마감: ${withDow(l.due)}`] : []), ...(l.extraRows || [])])
                  const bodyHtml = buildLogBodyHtml(l)
                  const hasExtra = l.photo || !!bodyHtml
                  const chevronBtn = hasExtra ? `<button type="button" class="log-extra-chevron" onclick="toggleLogExtra(this)" aria-label="펼치기"><svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg></button>` : ""
                  const metaHtml = (meta || chevronBtn) ? `<div class="log-meta">${meta}${chevronBtn}</div>` : ""
                  const extraHtml = hasExtra ? `<div class="log-extra">${l.photo ? `<img class="log-photo" src="${esc(l.photo)}" />` : ""}${bodyHtml}</div>` : ""
                  return metaHtml + extraHtml
                })()}
              </div>
`
}
// 학습·과제·평가를 카드 항목으로(학습기록 탭과 캘린더 날짜 목록이 같은 값으로 그린다)
// (v2.8.0) 결석을 메운 보강 날 학습기록: 과제의 "출제·마감"처럼 "기존 수업: 날짜" 한 줄(서버가 출석 수식 기존 수업일로 붙임)
function makeupMetaRows(l) { return l && l.makeupOf ? [`기존 수업: ${withDow(l.makeupOf)}`] : [] }
const logItemOfStudy = (l) => ({ type: "학습", icon: KIND_ICONS["학습"], date: l.date, title: [l.book, l.range].filter(Boolean).join(" · ") || "학습 기록", unit: l.unit, note: l.note, photo: l.photo, body: l.body, book: l.book, sourceBody: l.sourceBody, activityBody: l.activityBody, extraRows: makeupMetaRows(l) })
const logItemOfHomework = (h) => ({ type: "과제", icon: KIND_ICONS["과제"], date: h.classDate || h.due, due: h.due, classDate: h.classDate, title: [h.book, h.range].filter(Boolean).join(" · "), unit: h.unit, note: h.note, pill: h.status, pillTone: homeworkPillTone(h.status), book: h.book, sourceBody: h.sourceBody, activityBody: h.activityBody })
// 평가 아이콘은 학습기록 탭이 써 온 Feather file-text 그대로(KIND_ICONS 평가와 줄 하나 다름)
const LOG_TEST_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`
const logItemOfTest = (t) => ({ type: "평가", icon: LOG_TEST_ICON, date: t.date, title: testTitle(t), extraRows: testEvalRow(t) ? [testEvalRow(t)] : [], unit: t.unit, note: t.note, pill: testPillText(t), pillTone: testPillTone(t), book: t.book, sourceBody: t.sourceBody, activityBody: t.activityBody , compare: testCompareBarsHtml(t) })
// 고른 날짜의 기록: 출석 상태 + 그날 학습·그날 낸 과제·그날 평가. v2.5.101부터 한 카드에 구분선으로 잇지 않고 학습기록 탭과 같은 독립 카드.
function buildCalDayPanelHtml(r, date) {
  const att = (r.attendance_rows || []).find((a) => a.date === date)
  const logs = (r.study_logs || []).filter((l) => l.date === date)
  const homework = (r.homework || []).filter((h) => h.classDate === date)
  const tests = (r.tests || []).filter((t) => String(t.date || "").slice(0, 10) === date)
  const planned = !att && date >= MOCK_TODAY && isPlannedClassDate(r, date, closedDateSet())
  const badge = att ? `<span class="badge ${esc(att.status)}">${esc(att.status || "상태 미입력")}</span>` : `<span class="badge">${planned ? "수업 예정" : "수업 없음"}</span>`
  const blocks = [...logs.map(logItemOfStudy), ...homework.map(logItemOfHomework), ...tests.map(logItemOfTest)].map(logCardHtml)
  return `
    <div class="cal-day-head"><b>${esc(formatDateLabel(date))}</b>${badge}</div>
    ${blocks.length ? `<div class="cal-day-logs">${blocks.join("")}</div>` : `<div class="cal-day-card"><div class="empty">이날 기록된 학습·과제·평가가 없어요.</div></div>`}
    ${att ? `<button type="button" class="cal-day-link" onclick="openDayReport('${date}')">이날 보고서 보기${CHEVRON_RIGHT_SVG}</button>` : ""}
  `
}

// ===== 홈 탭 =====
function scheduleSummaryText(r) {
  const order = ["월", "화", "수", "목", "금", "토", "일"]
  const slots = (r.schedule || []).filter((s) => s.day).slice().sort((a, b) => order.indexOf(a.day) - order.indexOf(b.day))
  if (!slots.length) return ""
  const starts = [...new Set(slots.map((s) => s.start || ""))]
  if (starts.length === 1) return `${slots.map((s) => s.day).join("·")} ${starts[0]}`.trim()
  return slots.map((s) => `${s.day} ${s.start || ""}`.trim()).join(" · ")
}
function nextClassInfo(r) {
  const att = attendanceByDate(r)
  const closed = closedDateSet()
  for (let i = 0; i < 21; i++) {
    const d = addDaysStr(MOCK_TODAY, i)
    if (i === 0 && att[d] !== undefined) continue
    if (!isPlannedClassDate(r, d, closed)) continue
    const dow = DOW_KO[new Date(d + "T00:00:00").getDay()]
    const slot = (r.schedule || []).find((s) => s.day === dow) || {}
    const when = i === 0 ? "오늘" : i === 1 ? "내일" : dow
    return `${when} ${slot.start || ""}`.trim()
  }
  return "-"
}
function buildHomeHeroHtml(r) {
  const sub = [r.teacher ? `${r.teacher} 선생님` : "", scheduleSummaryText(r)].filter(Boolean).join(" · ")
  return `
    <div class="home-hero">
      <div class="home-hero-row">
        <div class="home-hero-title">${r.emoji ? `<span class="home-hero-emoji">${esc(r.emoji)}</span>` : ""}${esc(r.class_name)}</div>
        ${sub ? `<div class="home-hero-sub">${esc(sub)}</div>` : ""}
      </div>
    </div>
  `
}
function buildHomeTabHtml(r) {
  const todayAtt = (r.attendance_rows || []).find((a) => a.date === MOCK_TODAY)
  const todayPlanned = isPlannedClassDate(r, MOCK_TODAY, closedDateSet())
  const attText = todayAtt ? (todayAtt.status || "수업 전") : todayPlanned ? "수업 전" : "수업 없음"
  const attTone = todayAtt ? (String(todayAtt.status).includes("결석") ? "bad" : String(todayAtt.status).includes("보강") ? "info" : "good") : ""
  const pending = (r.homework || [])
    .filter((h) => h.status !== "제출" && h.due && h.due >= MOCK_TODAY && (!h.classDate || h.classDate <= MOCK_TODAY))
    .sort((a, b) => a.due.localeCompare(b.due))
  const books = (r.books || []).filter((b) => normalizeBookStatus(b.status) === "진행중")
  const comment = (r.teacher_comments || []).filter((c) => c.text).slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))[0]
  // (v2.8.0) 평가만 보는 반: 오늘(출석·남은 과제·다음 수업)과 남은 과제 대신 최근 평가와 최근 평가 추이를 보여 준다.
  const recentTests = (r.tests || []).filter((t) => t.date && t.date <= MOCK_TODAY).slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 3)
  const topHtml = isTestsOnly(r) ? `
      <h3 class="sec-title"><span class="sec-icon">${KIND_ICONS["평가"]}</span>최근 평가</h3>
      <div class="card">${recentTests.length ? recentTests.map((t) => kindBlockHtml("평가", { title: testTitle(t), pill: testPillText(t), pillTone: testPillTone(t), sub: [shortDateDow(t.date), testEvalRow(t)].filter(Boolean).join(" · ") })).join("") : `<div class="empty">아직 평가 기록이 없어요.</div>`}</div>
      <h3 class="sec-title"><span class="sec-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg></span>최근 평가 추이</h3>
      <div class="card">${buildTestTrendChartHtml(computeRecentTestPoints(r.tests || [], MOCK_TODAY, 5))}</div>` : ""
  return `
    <div class="feed-narrow-wrap">${topHtml}${isTestsOnly(r) ? "" : `
      <h3 class="sec-title"><span class="sec-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line></svg></span>오늘 ${esc(formatDateLabel(MOCK_TODAY).replace(/^\d+년 /, ""))}</h3>
      <div class="card">
        <div class="home-stats">
          <div class="home-stat ${attTone}"><b>${esc(attText)}</b><small>출석</small></div>
          <div class="home-stat ${pending.length ? "bad" : ""}"><b>${pending.length}개</b><small>남은 과제</small></div>
          <div class="home-stat"><b>${esc(nextClassInfo(r))}</b><small>다음 수업</small></div>
        </div>
      </div>
      <h3 class="sec-title"><span class="sec-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg></span>남은 과제</h3>
      <div class="card">${pending.length ? pending.slice(0, 3).map((h) => kindBlockHtml("과제", { title: [h.book, h.range].filter(Boolean).join(" · ") || "과제", pill: h.status, pillTone: homeworkPillTone(h.status), sub: `마감 ${shortDateDow(h.due)}` })).join("") : `<div class="empty">남은 과제가 없어요.</div>`}</div>`}
      <h3 class="sec-title"><span class="sec-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg></span>교재 진도</h3>
      <div class="card">${books.length ? books.map((b) => `
        <div class="home-progress-row" onclick="openBookStudy(${jsArg(b.title)})" style="cursor:pointer">
          <div class="home-progress-title">${esc(b.title)}</div>
          <div class="progress-line"><div class="track"><div class="fill" style="width:${b.progress ?? 0}%"></div></div><b>${b.progress ?? 0}%</b></div>
        </div>`).join("") : `<div class="empty">진행 중인 교재가 없어요.</div>`}</div>
      <h3 class="sec-title"><span class="sec-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg></span>선생님 한마디</h3>
      <div class="card">${comment ? `<div class="speech">${esc(comment.text)}<small>${esc([comment.by, comment.date ? shortDateDow(comment.date) : ""].filter(Boolean).join(" · "))}</small></div>` : `<div class="empty">아직 등록된 한마디가 없어요.</div>`}</div>
    </div>
  `
}

// ===== 교재 탭 =====
function latestBookRange(r, title) {
  const target = normBookTitle(title)
  const logs = (r.study_logs || []).filter((l) => normBookTitle(l.book) === target && l.date).sort((a, b) => b.date.localeCompare(a.date))
  const last = logs[0]
  return last ? [last.range, last.unit].filter(Boolean).join(" · ") : ""
}
function buildBooksTabHtml(r) {
  const books = r.books || []
  const countOf = (st) => books.filter((b) => normalizeBookStatus(b.status) === st).length
  const filtered = books.filter((b) => normalizeBookStatus(b.status) === bookStatusTab)
  return `
    <h2><span class="page-title-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg></span>교재</h2>
    <div class="section-hint">진행상황별로 교재를 볼 수 있어요</div>
    <div class="seg-toggle">
      <button class="${bookStatusTab === "진행중" ? "active" : ""}" onclick="setBookStatusTab('진행중')">진행중 ${countOf("진행중")}</button>
      <button class="${bookStatusTab === "완료" ? "active" : ""}" onclick="setBookStatusTab('완료')">완료 ${countOf("완료")}</button>
      <button class="${bookStatusTab === "예정" ? "active" : ""}" onclick="setBookStatusTab('예정')">다음 ${countOf("예정")}</button>
    </div>
    <div class="feed-narrow-wrap">
      <div class="book-list">${filtered.length ? filtered.map((b) => {
        const recent = latestBookRange(r, b.title)
        return `
        <div class="book-row" onclick="openBookStudy(${jsArg(b.title)})">
          <div class="book-row-cover">${b.cover ? `<img src="${esc(b.cover)}" alt="${esc(b.title)}">` : `<span>${esc(b.title)}</span>`}</div>
          <div class="book-row-body">
            <div class="book-row-title">${esc(b.title)}</div>
            ${b.pages ? `<div class="book-row-sub">${esc(b.pages)}쪽</div>` : ""}
            ${b.progress != null ? `<div class="progress-line"><div class="track"><div class="fill" style="width:${b.progress}%"></div></div><b>${b.progress}%</b></div>` : ""}
            ${recent ? `<div class="book-row-recent"><span class="inline-icon">${KIND_ICONS["학습"]}</span><span>최근 ${esc(recent)}</span></div>` : ""}
          </div>
        </div>`
      }).join("") : `<div class="empty">${bookStatusTab === "예정" ? "다음" : bookStatusTab} 교재가 없습니다.</div>`}</div>
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
const REPORT_MONTH_LOOKBACK = 6
const REPORT_WEEK_LOOKBACK = 26
function reportDayEarliest() {
  const [y, m] = MOCK_TODAY.split("-").map(Number)
  const d = new Date(y, m - 1 - REPORT_MONTH_LOOKBACK, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`
}
function navigateReportDay(delta) {
  const candidate = addDaysStr(reportDayDate || MOCK_TODAY, -delta)
  reportDayDate = candidate > MOCK_TODAY ? MOCK_TODAY : candidate < reportDayEarliest() ? reportDayEarliest() : candidate
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
// 주간보고서의 월 소속은 그 주의 목요일로 정한다.
// 월~일 중 더 많은 날짜가 포함된 달을 안정적으로 선택하고, 월 경계에서도 한 주가 중복되지 않는다.
function reportWeekLabel(rangeStart) {
  const thursday = addDaysStr(rangeStart, 3)
  const [year, month, day] = thursday.split("-").map(Number)
  const weekOfMonth = Math.floor((day - 1) / 7) + 1
  return `${year}년 ${month}월 ${weekOfMonth}주차`
}
let reportPickerMonthOffset = 0
function reportMonthValue(offset) {
  const [y, m] = MOCK_TODAY.split("-").map(Number)
  const d = new Date(y, m - 1 - offset, 1)
  return { y: d.getFullYear(), m: d.getMonth() + 1 }
}
function reportDateDiffDays(a, b) {
  const parse = (value) => {
    const [y, m, d] = value.split("-").map(Number)
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((parse(a) - parse(b)) / 86400000)
}
function reportWeekOffsetForDate(date) {
  return Math.round(reportDateDiffDays(mondayOfWeek(MOCK_TODAY), mondayOfWeek(date)) / 7)
}
function reportPickerSelectedMonthOffset() {
  let date = MOCK_TODAY
  if (reportPeriod === "day") date = reportDayDate || MOCK_TODAY
  if (reportPeriod === "week") date = addDaysStr(mondayOfWeek(MOCK_TODAY), -7 * reportOffset + 3)
  const [ty, tm] = MOCK_TODAY.split("-").map(Number)
  const [y, m] = date.split("-").map(Number)
  return Math.max(0, Math.min(REPORT_MONTH_LOOKBACK, (ty - y) * 12 + tm - m))
}
function reportPeriodButtonLabel() {
  if (reportPeriod === "day") {
    const [, m, d] = (reportDayDate || MOCK_TODAY).split("-").map(Number)
    return `${m}월 ${d}일`
  }
  if (reportPeriod === "week") return reportWeekLabel(reportRange().rangeStart)
  const { y, m } = reportMonthValue(reportOffset)
  return `${y}년 ${m}월`
}
// 토/일 글자색을 구분해 요일을 헷갈리지 않게 한다. 0=일요일 ... 6=토요일 (Date.getDay() 기준)
function weekendClassForDow(dow) {
  return dow === 6 ? "sat" : dow === 0 ? "sun" : ""
}
function buildReportCalendarPicker() {
  const { y, m } = reportMonthValue(reportPickerMonthOffset)
  const mondayOnly = reportPeriod === "week" // 주 단위로 고르는 달력은 보고서 주(월~일)와 줄을 맞춘다
  const lastDay = new Date(y, m, 0).getDate()
  const leading = calLeadingDays(y, m, mondayOnly)
  const trailing = (7 - ((leading + lastDay) % 7)) % 7
  const firstCellDate = addDaysStr(`${y}-${String(m).padStart(2, "0")}-01`, -leading)
  const currentMonday = mondayOfWeek(MOCK_TODAY)
  const selectedMonday = addDaysStr(currentMonday, -7 * reportOffset)
  const selectedDay = reportDayDate || MOCK_TODAY
  const cells = []
  for (let i = 0; i < leading + lastDay + trailing; i++) {
    const date = addDaysStr(firstCellDate, i)
    const day = Number(date.slice(8, 10))
    const outside = !date.startsWith(`${y}-${String(m).padStart(2, "0")}`)
    const dow = new Date(date + "T00:00:00").getDay()
    const weekOffset = reportWeekOffsetForDate(date)
    const rangeOk = reportPeriod === "day"
      ? date >= reportDayEarliest() && date <= MOCK_TODAY
      : weekOffset >= 0 && weekOffset <= REPORT_WEEK_LOOKBACK
    const enabled = !outside && rangeOk
    const selected = reportPeriod === "day" ? date === selectedDay : mondayOfWeek(date) === selectedMonday
    const current = reportPeriod === "day" ? date === MOCK_TODAY : mondayOfWeek(date) === currentMonday
    const classes = ["report-picker-day", weekendClassForDow(dow), outside ? "outside" : "", !outside && !rangeOk ? "unavailable" : "", current ? "current" : "", selected ? "chosen" : ""].filter(Boolean).join(" ")
    cells.push(`<button class="${classes}" ${enabled ? `onclick="selectReportPickerDate('${date}')"` : "disabled"}>${day}</button>`)
  }
  const selectedRange = reportPeriod === "week"
    ? `${reportWeekLabel(selectedMonday)} · ${selectedMonday.slice(5).replace("-", ".")}~${addDaysStr(selectedMonday, 6).slice(5).replace("-", ".")}`
    : "날짜를 선택하세요"
  return `
    <div class="report-picker-month-nav">
      <button class="cal-nav-btn" ${reportPickerMonthOffset >= REPORT_MONTH_LOOKBACK ? "disabled" : ""} onclick="navigateReportPickerMonth(1)">‹</button>
      <strong>${y}년 ${m}월</strong>
      <button class="cal-nav-btn" ${reportPickerMonthOffset <= 0 ? "disabled" : ""} onclick="navigateReportPickerMonth(-1)">›</button>
    </div>
    <div class="report-picker-grid">
      ${calDowHtml("report-picker-dow", mondayOnly)}
      ${cells.join("")}
    </div>
    <div class="report-picker-help">${esc(selectedRange)}</div>
  `
}
// 월간 피커도 일간·주간과 동일하게 실제 달력(요일 헤더 + 날짜 칸)을 보여준다.
// 다만 특정 날짜를 고를 필요가 없으므로 날짜 칸은 클릭 불가로 두고, 헤더의 ‹ › 로만 이전/다음 달로 이동한다(이동 즉시 선택 반영).
function buildReportMonthPicker() {
  const { y, m } = reportMonthValue(reportOffset)
  const lastDay = new Date(y, m, 0).getDate()
  const leading = calLeadingDays(y, m)
  const trailing = (7 - ((leading + lastDay) % 7)) % 7
  const firstCellDate = addDaysStr(`${y}-${String(m).padStart(2, "0")}-01`, -leading)
  const isCurrentMonthView = reportOffset === 0 // 실제 "이번달"을 보고 있는 경우에만 연한색 배경을 깐다
  const cells = []
  for (let i = 0; i < leading + lastDay + trailing; i++) {
    const date = addDaysStr(firstCellDate, i)
    const day = Number(date.slice(8, 10))
    const outside = !date.startsWith(`${y}-${String(m).padStart(2, "0")}`)
    const dow = new Date(date + "T00:00:00").getDay()
    // 월간 피커는 보여주는 달 전체가 곧 "선택"이므로, 그 달에 속한 실제 날짜엔 전부 테두리를 준다.
    const classes = ["report-picker-day", "static", weekendClassForDow(dow), outside ? "outside" : "", !outside && isCurrentMonthView ? "current" : "", !outside ? "chosen" : ""].filter(Boolean).join(" ")
    cells.push(`<div class="${classes}">${day}</div>`)
  }
  return `
    <div class="report-picker-month-nav">
      <button class="cal-nav-btn" ${reportOffset >= REPORT_MONTH_LOOKBACK ? "disabled" : ""} onclick="navigateReportMonthPicker(1)">‹</button>
      <strong>${y}년 ${m}월</strong>
      <button class="cal-nav-btn" ${reportOffset <= 0 ? "disabled" : ""} onclick="navigateReportMonthPicker(-1)">›</button>
    </div>
    <div class="report-picker-grid">
      ${calDowHtml("report-picker-dow")}
      ${cells.join("")}
    </div>
    <div class="report-picker-help">${esc(`${y}년 ${m}월`)}</div>
  `
}
// 월 피커의 ‹ › 는 이동 즉시 실제 선택(reportOffset)을 바꾼다. 뒤에 있는 보고서 본문도 같이 갱신하고, 모달은 열어둔 채 달력만 새로 그린다.
function navigateReportMonthPicker(delta) {
  reportOffset = Math.max(0, Math.min(REPORT_MONTH_LOOKBACK, reportOffset + delta))
  renderApp()
  refreshReportPeriodPicker()
}
function openReportPeriodPicker() {
  const modal = document.getElementById("report-period-modal")
  const body = document.getElementById("report-period-modal-body")
  const title = document.getElementById("report-period-modal-title")
  if (!modal || !body || !title) return
  reportPickerMonthOffset = reportPickerSelectedMonthOffset()
  title.textContent = reportPeriod === "day" ? "날짜 선택" : reportPeriod === "week" ? "주차 선택" : "월 이동"
  body.innerHTML = reportPeriod === "month" ? buildReportMonthPicker() : buildReportCalendarPicker()
  modal.classList.add("active")
}
function refreshReportPeriodPicker() {
  const body = document.getElementById("report-period-modal-body")
  if (body) body.innerHTML = reportPeriod === "month" ? buildReportMonthPicker() : buildReportCalendarPicker()
}
function navigateReportPickerMonth(delta) {
  reportPickerMonthOffset = Math.max(0, Math.min(REPORT_MONTH_LOOKBACK, reportPickerMonthOffset + delta))
  refreshReportPeriodPicker()
}
function closeReportPeriodPicker() {
  document.getElementById("report-period-modal")?.classList.remove("active")
}
function selectReportPickerDate(date) {
  if (reportPeriod === "day") {
    reportDayDate = date < reportDayEarliest() ? reportDayEarliest() : date > MOCK_TODAY ? MOCK_TODAY : date
  } else {
    reportOffset = Math.max(0, Math.min(REPORT_WEEK_LOOKBACK, reportWeekOffsetForDate(date)))
  }
  closeReportPeriodPicker()
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
// (v2.8.0) 반 평균: 각 평가에 붙은 class_avg(같은 학습기록에 묶인 학생들의 평가 점수 평균)를 한 점으로 모은다. 없으면 null.
function classAvgOf(items) {
  const vals = items.map((t) => t.classAvg).filter((v) => typeof v === "number")
  return vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length * 10) / 10 : null
}
// 일일 보고서: 최근 평가가 있던 날 count일. 같은 날 평가가 여럿이면 점수(정답 ÷ 전체 문항)의 평균 한 점으로 그린다.
function computeRecentTestPoints(tests, asOfDate, count) {
  const byDay = new Map()
  tests.forEach((t) => {
    const day = String(t.date || "").slice(0, 10)
    if (!day || day > String(asOfDate).slice(0, 10)) return
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(t)
  })
  const days = [...byDay.keys()].sort().slice(-count)
  return days.map((day) => {
    const items = byDay.get(day)
    const scored = items.filter((t) => t.total)
    return {
      label: day.slice(5).replace("-", "."),
      avg: scored.length ? Math.round(scored.reduce((s, t) => s + (t.correct / t.total) * 100, 0) / scored.length * 10) / 10 : null,
      classAvg: classAvgOf(items),
      count: items.length,
      items,
    }
  })
}
// (v2.8.0) 주간·월간 보고서: 그 구분 평가의 최근 count개(보고서 기간 끝까지). 같은 날 평가는 한 점(평균).
// 주간은 날짜(MM.DD), 월간은 "n월"로 적는다.
function computeKindTestPoints(tests, asOfDate, count, periodType) {
  return computeRecentTestPoints(tests, asOfDate, count).map((p) => {
    if (periodType !== "month") return p
    const day = String(p.items[0]?.date || "").slice(0, 10)
    return { ...p, label: day ? `${Number(day.slice(5, 7))}월` : p.label }
  })
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
  const dots = validPoints.map((p) => `<circle cx="${xFor(p.i)}" cy="${yFor(p.avg)}" r="4" fill="#6b5d4d" style="pointer-events:none" /><circle cx="${xFor(p.i)}" cy="${yFor(p.avg)}" r="12" fill="transparent" style="cursor:pointer" onclick="showTestDetailModal(${p.i})" />`).join("")
  const valueLabels = validPoints.map((p) => `<text x="${xFor(p.i)}" y="${yFor(p.avg) - 10}" font-size="11" font-weight="700" fill="#6b5d4d" text-anchor="middle" style="cursor:pointer" onclick="showTestDetailModal(${p.i})">${p.avg.toFixed(1)}점</text>`).join("")
  const gridLines = ticks.map((v) => `
    <line x1="${paddingX}" y1="${yFor(v)}" x2="${width - paddingX}" y2="${yFor(v)}" stroke="#eee" stroke-width="1" />
    <text x="2" y="${yFor(v) + 4}" font-size="9" fill="#bbb">${v}</text>
  `).join("")
  const xLabels = points.map((p, i) => `<text x="${xFor(i)}" y="${height - 10}" font-size="10" fill="#999" text-anchor="middle">${esc(p.label)}</text>`).join("")
  // 반 평균은 점선으로 아이 점수 선 아래에 깔고, 반 평균이 하나라도 있을 때만 범례를 붙인다.
  const classPoints = points.map((p, i) => ({ ...p, i })).filter((p) => p.classAvg !== null && p.classAvg !== undefined)
  const classPath = classPoints.map((p) => `${xFor(p.i)},${yFor(p.classAvg)}`).join(" ")
  const classLine = classPoints.length > 1 ? `<polyline points="${classPath}" fill="none" stroke="#b9ab98" stroke-width="1.5" stroke-dasharray="4 3" />` : ""
  const classDots = classPoints.map((p) => `<circle cx="${xFor(p.i)}" cy="${yFor(p.classAvg)}" r="3" fill="#fff" stroke="#b9ab98" stroke-width="1.5" style="pointer-events:none" />`).join("")
  const legend = classPoints.length
    ? `<div class="chart-legend"><span class="legend-item"><span class="dot" style="background:#6b5d4d"></span>${esc(studentLabel())}</span><span class="legend-item"><span class="dot" style="background:#fff;border:1.5px solid #b9ab98"></span>반 평균</span></div>`
    : ""
  const emptyOverlay = validPoints.length ? "" : '<div class="empty">해당 기간 평가 기록이 없습니다.</div>'
  return `
    ${legend}
    <div class="chart-wrap"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">${gridLines}${classLine}${classDots}<polyline points="${path}" fill="none" stroke="#6b5d4d" stroke-width="2" />${dots}${valueLabels}${xLabels}</svg></div>
    ${emptyOverlay}
  `
}
function buildReportTabHtml(r) {
  // (v2.8.0) 평가만 보는 반은 일간 보고서가 없다(출석이 없음). 주간부터 보여 준다.
  const testsOnly = isTestsOnly(r)
  if (testsOnly && reportPeriod === "day") reportPeriod = "week"
  const homework = r.homework || []
  const tests = r.tests || []
  const reportComments = r.report_comments || []
  const { rangeStart, rangeEnd } = reportRange()
  const attendanceRows = (r.attendance_rows || []).filter((a) => a.date >= rangeStart && a.date <= rangeEnd)
  const homeworkItems = (r.homework_days || []).filter((h) => h.date && h.date >= rangeStart && h.date <= rangeEnd)
  // (v2.8.0) 주간 보고서는 주간 평가, 월간 보고서는 월간 평가로 추이·평가 평균을 계산한다. 그 구분 평가가 한 번도
  // 없으면(주간·월간 평가를 안 보는 반) 추이는 숨기고, 평가 평균은 지금처럼 기간 안 모든 평가로 계산한다.
  const kindName = reportPeriod === "week" ? "주간 평가" : reportPeriod === "month" ? "월간 평가" : "일일 평가"
  const kindTests = tests.filter((t) => testKind(t) === kindName)
  const hasKind = reportPeriod !== "day" && kindTests.length > 0
  const testItems = (hasKind ? kindTests : tests).filter((t) => t.date >= rangeStart && t.date <= rangeEnd)
  // 출석률은 상태가 확정된 출석만 계산한다. 빈 상태(미입력/미래 수업)는 분모에서 제외하고,
  // 보강은 실제 수업 참여로 보아 출석과 함께 분자에 포함한다.
  const countedAttendanceRows = attendanceRows.filter((a) => ["출석", "보강", "결석"].includes(a.status))
  const presentCount = countedAttendanceRows.filter((a) => a.status === "출석" || a.status === "보강").length
  const attRate = countedAttendanceRows.length ? Math.round((presentCount / countedAttendanceRows.length) * 100) : 0
  const doneHomework = homeworkItems.filter((h) => h.status === "완료").length
  const hwRate = homeworkItems.length ? Math.round((doneHomework / homeworkItems.length) * 100) : 0
  // (v2.5.97) 평가 평균: 기간 안 평가 점수(정답 ÷ 전체 문항)의 평균, 소수 한 자리(최근 평가 추이와 같음). 도넛은 점수만큼 채운다.
  const scoredTests = testItems.filter((t) => t.total)
  const testAvg = scoredTests.length ? Math.round(scoredTests.reduce((n, t) => n + (t.correct ?? 0) / t.total * 100, 0) / scoredTests.length * 10) / 10 : null
  const periodLabel = reportPeriodButtonLabel()
  const segToggleHtml = `
    <div class="seg-toggle">
      ${testsOnly ? "" : `<button class="${reportPeriod === "day" ? "active" : ""}" onclick="setReportPeriod('day')">일간 보고서</button>`}
      <button class="${reportPeriod === "week" ? "active" : ""}" onclick="setReportPeriod('week')">주간 보고서</button>
      <button class="${reportPeriod === "month" ? "active" : ""}" onclick="setReportPeriod('month')">월간 보고서</button>
    </div>
  `
  if (reportPeriod === "day") {
    const dayDate = reportDayDate || MOCK_TODAY
    return `
      <h2><span class="page-title-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg></span>보고서</h2>
      <div class="section-hint">일간·주간·월간 보고서를 볼 수 있어요</div>
      <div class="feed-narrow-wrap">
      ${segToggleHtml}
      <div class="cal-month-nav">
        <button class="cal-nav-btn" ${dayDate <= reportDayEarliest() ? "disabled" : ""} onclick="navigateReportDay(1)">‹</button>
        <button class="cal-month-title period-picker-trigger" onclick="openReportPeriodPicker()" aria-label="날짜 선택">${esc(periodLabel)}</button>
        <div class="cal-nav-right">
          <button class="cal-today-btn" onclick="goReportCurrent()">오늘</button>
          <button class="cal-nav-btn" ${dayDate >= MOCK_TODAY ? "disabled" : ""} onclick="navigateReportDay(-1)">›</button>
        </div>
      </div>
      ${buildDailyBodyHtml(r, dayDate)}
      </div>
    `
  }
  return `
    <h2><span class="page-title-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg></span>보고서</h2>
    <div class="section-hint">${testsOnly ? "주간·월간" : "일간·주간·월간"} 보고서를 볼 수 있어요</div>
    <div class="feed-narrow-wrap">
    ${segToggleHtml}
    <div class="cal-month-nav">
      <button class="cal-nav-btn" ${reportOffset >= (reportPeriod === "week" ? REPORT_WEEK_LOOKBACK : REPORT_MONTH_LOOKBACK) ? "disabled" : ""} onclick="navigateReportPeriod(1)">‹</button>
      <button class="cal-month-title period-picker-trigger" onclick="openReportPeriodPicker()" aria-label="${reportPeriod === "week" ? "주차" : "월"} 선택">${esc(periodLabel)}</button>
      <div class="cal-nav-right">
        <button class="cal-today-btn" onclick="goReportCurrent()">현재</button>
        <button class="cal-nav-btn" ${reportOffset === 0 ? "disabled" : ""} onclick="navigateReportPeriod(-1)">›</button>
      </div>
    </div>
    <div class="report-donut-row${testsOnly ? "" : " three"}">
      ${testsOnly ? "" : `<div class="donut-card">
        <div class="donut-title"><span class="inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg></span>출석률</div>
        <div class="donut" style="background: conic-gradient(${bandChartColor(attRate)} 0% ${attRate}%, var(--brand-soft) ${attRate}% 100%)"><div class="donut-hole">${attRate}%</div></div>
        <div class="donut-count-below">(${presentCount}/${countedAttendanceRows.length})</div>
      </div>
      <div class="donut-card clickable" onclick="showHomeworkPeriodModal('${rangeStart}','${rangeEnd}','${esc(periodLabel)} 과제이행률')">
        <div class="donut-title"><span class="inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg></span>과제이행률</div>
        <div class="donut" style="background: conic-gradient(${bandChartColor(hwRate)} 0% ${hwRate}%, var(--brand-soft) ${hwRate}% 100%)"><div class="donut-hole">${hwRate}%</div></div>
        <div class="donut-count-below">(${doneHomework}/${homeworkItems.length})</div>
      </div>`}
      <div class="donut-card${testItems.length ? " clickable" : ""}"${testItems.length ? ` onclick="showTestPeriodModal('${rangeStart}','${rangeEnd}','${esc(periodLabel)} 평가','${hasKind ? kindName : ""}')"` : ""}>
        <div class="donut-title"><span class="inline-icon">${KIND_ICONS["평가"]}</span>평가 평균</div>
        <div class="donut" style="background: conic-gradient(${bandChartColor(testAvg ?? 0)} 0% ${testAvg ?? 0}%, var(--brand-soft) ${testAvg ?? 0}% 100%)"><div class="donut-hole">${testAvg !== null ? testAvg.toFixed(1) + "점" : "–"}</div></div>
        <div class="donut-count-below">${scoredTests.length ? `(평가 ${scoredTests.length}개)` : "(평가 없음)"}</div>
      </div>
    </div>
    ${hasKind ? `<h3 class="sec-title"><span class="sec-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg></span>${kindName} 추이</h3>
    <div class="card">
      ${buildTestTrendChartHtml(computeKindTestPoints(kindTests, rangeEnd, reportPeriod === "week" ? 4 : 6, reportPeriod))}
    </div>` : ""}
    <h3 class="sec-title"><span class="sec-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg></span>선생님 한마디</h3>
    <div class="card">
      ${(() => {
        const kind = reportPeriod === "week" ? "주간 보고서" : "월간 보고서"
        const matched = reportComments.filter((c) => c.kind === kind && c.start && (c.end || c.start) >= rangeStart && c.start <= rangeEnd)
        return matched.length ? matched.map((c) => `<div class="speech">${esc(c.comment)}</div>`).join("") : `<div class="empty">아직 등록된 한마디가 없어요.</div>`
      })()}
    </div>
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

// 다음과제 카드는 "마감이 가장 이른, 아직 지나지 않은 과제"를 보여준다. 같은 날짜에 마감인
// 과제가 여러 건이면(교재별로 각각 내주는 경우) 전부 함께 보여줘야 한다.
// 오늘 마감인 과제는 이미 위쪽 "과제상태" 칸에서 보여주고 있으므로, 여기서는 마감일이 오늘보다
// 뒤인(아직 오지 않은) 과제만 "다음" 과제로 취급한다.
function findNextHomeworkItems(r, date) {
  // 아직 수업일이 되지 않은(=아직 내주지 않은) 과제는 "다음과제"에 나오면 안 된다. classDate가 없는
  // 옛 캐시 데이터는(수업일 정보가 없던 시절 기록) 하위호환을 위해 그대로 포함시킨다.
  // 마감·출제일은 시각이 붙은 값("2026-10-21T19:00…")일 수 있어 날짜만 비교한다. 그대로 비교하면 이날 마감인
  // 과제가 "날짜 뒤"로 판정되어 지난 과제와 이번 과제에 함께 나왔다(v2.7.16).
  const day = (v) => String(v || "").slice(0, 10)
  const upcoming = (r.homework || []).filter((h) => day(h.due) > date && (!h.classDate || day(h.classDate) <= date))
  if (!upcoming.length) return []
  const minDue = upcoming.reduce((min, h) => (day(h.due) < min ? day(h.due) : min), day(upcoming[0].due))
  return upcoming.filter((h) => day(h.due) === minDue)
}

function findLatestComment(r, date) {
  return (r.teacher_comments || []).find((c) => c.date && String(c.date).slice(0, 10) === date) || null
}

// 보고서 항목 한 건: "교재 · 범위" + 상태 알약 + 메타 줄, 본문은 접지 않고 전부 보여준다.
function reportItemHtml(r, item, opts) {
  const { pill, pillTone, extraRows, compare } = opts || {}
  const title = [item.book, item.range].filter(Boolean).join(" · ") || "기록"
  const meta = renderLogMetaRows(item.unit, item.note, extraRows || [])
  const body = buildLogBodyHtml(item)
  return `
    <div class="rep-item">
      <div class="rep-title">${esc(title)}${pill ? `<span class="log-pill ${pillTone || ""}">${esc(pill)}</span>` : ""}</div>
      ${compare || ""}
      ${meta ? `<div class="rep-meta">${meta}</div>` : ""}
      ${body ? `<div class="rep-body">${body}</div>` : ""}
    </div>
  `
}
function buildDailyBodyHtml(r, date) {
  const attendanceRow = (r.attendance_rows || []).find((a) => a.date === date)
  // 과제상태는 "그날 수업이 있었는지"가 아니라 "그날이 마감일인 과제가 있는지" 기준으로 판단한다.
  const dueTodayHomework = (r.homework || []).filter((h) => String(h.due || "").slice(0, 10) === date)
  const homeworkStatusToday = dueTodayHomework.length
    ? dueTodayHomework.every((h) => h.status === "제출") ? { text: "제출", cls: "제출" }
      : dueTodayHomework.some((h) => h.status === "제출") ? { text: "일부 제출", cls: "부분완료" }
      : { text: "미제출", cls: "미제출" }
    : null
  const todaysLogs = (r.study_logs || []).filter((l) => l.date === date)
  // 이번 과제: 출제일 기준(findNextHomeworkItems). 지난 과제: 이날 마감인 과제(위 이날 마감 과제와 같은 기준).
  const nextHomeworkItems = findNextHomeworkItems(r, date)
  // (v2.8.0) 일간 보고서는 일일 평가만(주간·월간·종합 평가는 각 보고서·교재 상세에서).
  const dailyTests = (r.tests || []).filter((t) => testKind(t) === "일일 평가")
  const todaysTests = dailyTests.filter((t) => String(t.date || "").slice(0, 10) === date)
  const comment = findLatestComment(r, date)
  const attStatus = attendanceRow ? (attendanceRow.status || "상태 미입력") : "해당 없음"
  const checkIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`
  const msgIcon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>`
  // 보고서 세션(다른 탭과 같은 규칙): 세션 제목은 박스 밖, 기록마다 개별 박스. 박스 안은 흰 머리 + 베이지 본문(늘 펼침).
  const band = (inner) => `<div class="card rep-card">${inner}</div>`
  const empty = (text) => band(`<div class="empty">${text}</div>`)
  const groupBand = (items, render, emptyText) => (items.length ? items.map((it) => band(render(it))).join("") : empty(emptyText))
  const session = (icon, text, inner) => `<h3 class="sec-title"><span class="sec-icon">${icon}</span>${text}</h3>${inner}`
  const sub = (text) => `<div class="rep-sub">${text}</div>`

  const studyHtml = todaysLogs.length ? todaysLogs.map((l) => band(reportItemHtml(r, l, { extraRows: makeupMetaRows(l) }))).join("") : empty("이날 기록된 학습 내용이 없어요.")
  const homeworkHtml =
    sub("지난 과제") +
    groupBand(dueTodayHomework, (h) => reportItemHtml(r, h, { pill: h.status, pillTone: homeworkPillTone(h.status), extraRows: h.classDate ? [`출제: ${withDow(h.classDate)}`] : [] }), "이날 마감인 과제가 없어요.") +
    sub("이번 과제") +
    groupBand(nextHomeworkItems, (h) => reportItemHtml(r, h, { pill: h.status, pillTone: homeworkPillTone(h.status), extraRows: [h.classDate ? `출제: ${withDow(h.classDate)}` : null, `마감: ${withDow(h.due)}`].filter(Boolean) }), "출제된 과제가 없어요.")
  const testHtml =
    sub("이번 평가") +
    groupBand(todaysTests, (t) => reportItemHtml(r, t, { pill: testPillText(t), pillTone: testPillTone(t), compare: testCompareBarsHtml(t) }), "이날 평가가 없어요.") +
    sub("최근 평가 추이") +
    band(buildTestTrendChartHtml(computeRecentTestPoints(dailyTests, date, 3)))
  const commentHtml = comment
    ? band(`<div class="speech">${esc(comment.text)}${comment.by ? `<small>${esc(comment.by)}</small>` : ""}</div>`)
    : empty("아직 등록된 한마디가 없어요.")

  // (v2.5.97) 평가 현황: 그날 평가 점수(여러 개면 평균). 없으면 "해당 없음". 점수 색은 평가 기록 알약과 같은 단계(scorePillTone).
  const scoredToday = todaysTests.filter((t) => t.total)
  const testPctToday = scoredToday.length ? Math.round(scoredToday.reduce((n, t) => n + (t.correct ?? 0) / t.total * 100, 0) / scoredToday.length) : null
  return `
    <div class="report-donut-row three">
      <div class="donut-card">
        <div class="donut-title"><span class="inline-icon">${checkIcon}</span>출석 현황</div>
        <div class="day-status"><span class="badge ${esc(attStatus)}">${esc(attStatus)}</span></div>
        <div class="donut-count-below">${attendanceRow && attendanceRow.arrived ? `${esc(attendanceRow.arrived)} 등원` : ""}</div>
      </div>
      <div class="donut-card${homeworkStatusToday ? " clickable" : ""}"${homeworkStatusToday ? ` onclick="showHomeworkDayModal('${date}')"` : ""}>
        <div class="donut-title"><span class="inline-icon">${KIND_ICONS["과제"]}</span>과제 현황</div>
        <div class="day-status">${homeworkStatusToday ? `<span class="badge ${homeworkStatusToday.cls}">${homeworkStatusToday.text}</span>` : `<span class="badge">해당 없음</span>`}</div>
        <div class="donut-count-below">${homeworkStatusToday ? `${dueTodayHomework.length}건` : ""}</div>
      </div>
      <div class="donut-card${scoredToday.length ? " clickable" : ""}"${scoredToday.length ? ` onclick="showTestPeriodModal('${date}','${date}','${esc(formatDateLabel(date))} 평가')"` : ""}>
        <div class="donut-title"><span class="inline-icon">${KIND_ICONS["평가"]}</span>평가 현황</div>
        <div class="day-status">${testPctToday !== null ? `<span class="log-pill ${scorePillTone(testPctToday, 100)}">${scoredToday.length > 1 ? "평균 " : ""}${testPctToday}점</span>` : `<span class="badge">해당 없음</span>`}</div>
        <div class="donut-count-below">${scoredToday.length ? `${scoredToday.length}건` : ""}</div>
      </div>
    </div>
    ${session(KIND_ICONS["학습"], "학습", studyHtml)}
    ${session(KIND_ICONS["과제"], "과제", homeworkHtml)}
    ${session(KIND_ICONS["평가"], "평가", testHtml)}
    ${session(msgIcon, "선생님 한마디", commentHtml)}
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
  const tabs = regTabsList()
  if (!tabs.some((t) => t.id === regTab)) regTab = "home"
  const tabBodies = {
    home: buildHomeTabHtml(r),
    books: buildBooksTabHtml(r),
    // 주간(날짜를 고른 상태)도 월간과 같은 제목·안내 줄로 시작한다 (2026-10-14)
    calendar: selectedCalDate ? `
      <h2><span class="page-title-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg></span>캘린더</h2>
      <div class="section-hint">날짜를 누르면 그날 기록을 볼 수 있어요</div>
      <div class="seg-toggle">
        <button class="${calMode === "attendance" ? "active" : ""}" onclick="setCalMode('attendance')">출석 현황</button>
        <button class="${calMode === "homework" ? "active" : ""}" onclick="setCalMode('homework')">과제 현황</button>
      </div>
      <div class="attendance-cal-wrap day-mode" id="reg-cal-area">${buildRegCalendarHtml(r, calMode)}</div>
    ` : `
      <h2><span class="page-title-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg></span>캘린더</h2>
      <div class="section-hint">날짜를 누르면 그날 기록을 볼 수 있어요</div>
      <div class="seg-toggle">
        <button class="${calMode === "attendance" ? "active" : ""}" onclick="setCalMode('attendance')">출석 현황</button>
        <button class="${calMode === "homework" ? "active" : ""}" onclick="setCalMode('homework')">과제 현황</button>
      </div>
      <div class="attendance-cal-wrap" id="reg-cal-area">${buildRegCalendarHtml(r, calMode)}</div>
    `,
    study: `
      <h2><span class="page-title-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg></span>학습기록</h2>
      <div class="section-hint">${isTestsOnly(r) ? "평가 기록을 최근 순서로 보여줘요" : "학습 · 과제 · 평가 기록을 최근 순서로 보여줘요"}</div>
      ${isTestsOnly(r) ? "" : `<div class="seg-toggle">
        <button class="${studyLogFilter === "전체" ? "active" : ""}" onclick="setStudyLogFilter('전체')">전체</button>
        <button class="${studyLogFilter === "학습" ? "active" : ""}" onclick="setStudyLogFilter('학습')">학습</button>
        <button class="${studyLogFilter === "과제" ? "active" : ""}" onclick="setStudyLogFilter('과제')">과제</button>
        <button class="${studyLogFilter === "평가" ? "active" : ""}" onclick="setStudyLogFilter('평가')">평가</button>
      </div>`}
      <div class="feed-narrow-wrap">
      ${(() => {
        const items = []
        studyLogs.forEach((l) => items.push(logItemOfStudy(l)))
        homework.forEach((h) => items.push(logItemOfHomework(h)))
        tests.forEach((t) => items.push(logItemOfTest(t)))
        const filter = isTestsOnly(r) ? "평가" : studyLogFilter
        const filtered = filter === "전체" ? items : items.filter((it) => it.type === filter)
        // (v2.5.103) 오늘이 맨 위 → 지난 날짜 최근부터 → 앞으로 날짜는 가까운 날부터 맨 아래
        const rank = (d) => (d === MOCK_TODAY ? 0 : d < MOCK_TODAY ? 1 : 2)
        const sorted = filtered.slice().sort((a, b) => rank(a.date) - rank(b.date) || (rank(a.date) === 2 ? (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) : (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)))
        const groups = []
        sorted.forEach((l) => {
          const last = groups[groups.length - 1]
          if (last && last.date === l.date) { last.items.push(l) } else { groups.push({ date: l.date, items: [l] }) }
        })
        return groups.length ? groups.map((g) => `
          <div class="log-date-group ${g.date === MOCK_TODAY ? "today" : ""}">
            <div class="log-date-label">${esc(withDow(g.date))}${g.date === MOCK_TODAY ? " · 오늘" : ""}</div>
            ${g.items.map((l) => logCardHtml(l)).join("")}
          </div>
        `).join("") : `<div class="empty">기록이 없습니다.</div>`
      })()}
      </div>
    `,
    report: buildReportTabHtml(r),
  }
  return `
    <div class="reg-detail-page">
      <div class="reg-header-bar">
        <div class="reg-header-top">
          <button class="reg-back-btn" onclick="goIntro()" aria-label="뒤로가기"><svg class="header-icon" viewBox="0 0 24 24" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg></button>
          <div class="reg-breadcrumb">
            <span class="crumb" onclick="goIntro()">${esc(STUDENT.student_name)}</span>
            <span class="crumb-sep">›</span>
            <span class="crumb" onclick="goIntro()">${esc(r.class_name)}</span>
            <span class="crumb-sep">›</span>
            <span class="crumb current">${esc(tabs.find((t) => t.id === regTab)?.label || "")}</span>
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
      ${regTab === "home" ? buildHomeHeroHtml(r) : ""}
      <div class="reg-tab-content">${tabBodies[regTab]}</div>
    </div>
    ${regTabbarHtml(regTab, false)}
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
  // 하단 탭바가 있는 등록 상세에는 안전 여백을 적용하고,
  // 등록/교재 상세에서는 새로고침 버튼을 상단 헤더 오른쪽에 배치한다.
  document.body.classList.toggle("has-tabbar", view === "detail" || view === "book")
  document.body.classList.toggle("has-detail-header", view === "detail" || view === "book")
}

async function initApp() {
  app.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:80vh;color:#8a8a8a;font-size:15px;">불러오는 중...</div>'
  await loadReportFromServer()
  if (DATA_ERROR || !STUDENT) {
    app.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:80vh;gap:12px;color:#666;font-size:15px;text-align:center;padding:0 24px;"><div style="width:32px;height:32px;color:#c77;"><svg viewBox="0 0 24 24" aria-hidden="true" style="width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12" y2="17"></line></svg></div><div>' + esc(DATA_ERROR || "데이터를 불러올 수 없어요.") + '</div></div>'
    return
  }
  renderApp()
}

// ---------- 뒤로가기 (v2.5.86) ----------
// 학부모님이 알림톡 링크로 들어와 뒤로가기를 누르면 리포트에서 나가 버리던 것을, 앱처럼 직전 동작으로 돌아가게 한다(History API).
// 기존 함수는 고치지 않고 열고 닫는 함수만 감싼다. 주소는 바꾸지 않는다(링크 토큰·새로고침 동작 그대로).
//  - 창(메뉴·일정·시험·과제·기간 고르기·사진 크게 보기)이 열려 있으면 그것부터 닫는다. ✕·바깥 누르기로 닫아도 방문 기록을 맞춘다.
//  - 화면은 깊이로 센다: 첫 화면 0 → 등록 상세 홈 1 → 다른 탭 2(탭은 쌓지 않음) → 캘린더 날짜를 골라 접힘 +1, 교재 상세 +1.
//    뒤로가기는 한 단계 위로(교재 상세 → 등록 상세, 날짜 접힘 → 월 보기, 다른 탭 → 홈, 홈 → 첫 화면). 첫 화면에서는 원래대로 나간다.
//  - 앞으로 가기는 무시한다.
const reportNav = { idx: 0, depth: 0, layers: [], pending: 0, skip: false, popping: false, fromPop: false }
function reportDepth() {
  if (view === "book") return (regTab === "home" ? 1 : 2) + 1
  if (view !== "detail") return 0
  return (regTab === "home" ? 1 : 2) + (regTab === "calendar" && selectedCalDate ? 1 : 0)
}
function reportPush() { history.pushState({ rb: ++reportNav.idx }, "") }
// 창을 닫은 만큼 방문 기록을 되돌린다. 같은 동작 안에서 화면이 바뀌면(메뉴에서 다른 등록을 고름) 그쪽에서 기록 칸을 바꿔 쓴다.
function reportFlushBack() {
  const n = reportNav.pending
  if (!n) return
  reportNav.pending = 0
  reportNav.skip = true
  reportNav.idx -= n
  history.go(-n)
}
function reportWrapLayer(name, openName, closeName, isOpen) {
  const open = window[openName], close = window[closeName]
  window[openName] = function (...args) {
    const was = isOpen()
    const r = open.apply(this, args)
    if (!was && isOpen() && !reportNav.popping) { reportNav.layers.push({ name, close }); reportPush() }
    return r
  }
  window[closeName] = function (...args) {
    if (reportNav.popping) return close.apply(this, args)
    const i = reportNav.layers.findIndex((l) => l.name === name)
    const r = close.apply(this, args)
    if (i >= 0) { reportNav.pending += reportNav.layers.length - i; reportNav.layers.splice(i); setTimeout(reportFlushBack, 0) }
    return r
  }
}
const reportActive = (id) => () => !!document.getElementById(id)?.classList.contains("active")
reportWrapLayer("menu", "openMenu", "closeMenu", reportActive("menu"))
reportWrapLayer("schedule", "openScheduleDay", "closeScheduleDayModal", reportActive("schedule-day-modal"))
reportWrapLayer("test", "showTestDetailModal", "closeTestDetailModal", reportActive("test-detail-modal"))
reportWrapLayer("test", "showTestPeriodModal", "closeTestDetailModal", reportActive("test-detail-modal"))
reportWrapLayer("homework", "showHomeworkDayModal", "closeHomeworkDayModal", reportActive("homework-detail-modal"))
reportWrapLayer("homework", "showHomeworkPeriodModal", "closeHomeworkDayModal", reportActive("homework-detail-modal"))
reportWrapLayer("period", "openReportPeriodPicker", "closeReportPeriodPicker", reportActive("report-period-modal"))
// 사진 크게 보기: 누르면 닫히는 겹 화면(.feed-lightbox)
window.closeFeedImage = function () { document.querySelectorAll(".feed-lightbox").forEach((el) => el.remove()) }
reportWrapLayer("image", "openFeedImage", "closeFeedImage", () => !!document.querySelector(".feed-lightbox"))
{
  const openImage = window.openFeedImage
  window.openFeedImage = function (...args) {
    const r = openImage.apply(this, args)
    document.querySelectorAll(".feed-lightbox").forEach((el) => { el.onclick = () => window.closeFeedImage() })
    return r
  }
}
// 화면이 바뀔 때마다 깊이를 비교해 방문 기록을 맞춘다.
{
  const render = renderApp
  window.renderApp = renderApp = function (...args) {
    const r = render.apply(this, args)
    const d = reportDepth()
    if (reportNav.fromPop) { reportNav.depth = d; return r }
    let diff = d - reportNav.depth
    if (diff > 0) {
      // 방금 닫은 창의 기록 칸이 있으면 그 칸을 새 화면 칸으로 바꿔 쓴다.
      if (reportNav.pending > 0) { history.replaceState({ rb: reportNav.idx }, ""); reportNav.pending--; diff-- }
      while (diff-- > 0) reportPush()
    } else if (diff < 0) {
      reportNav.pending += -diff
    }
    if (reportNav.pending) setTimeout(reportFlushBack, 0)
    reportNav.depth = d
    return r
  }
}
function reportGoUp() {
  if (view === "book") return closeBookDetail()
  if (view !== "detail") return
  if (regTab === "calendar" && selectedCalDate) return clearCalDay()
  if (regTab !== "home") return setRegTab("home")
  return goIntro()
}
history.replaceState({ rb: 0 }, "")
window.addEventListener("popstate", (e) => {
  const i = e.state?.rb ?? 0
  if (reportNav.skip) { reportNav.skip = false; reportNav.idx = i; return }
  if (i > reportNav.idx) { reportNav.skip = true; history.back(); return }
  reportNav.idx = i
  if (reportNav.layers.length) {
    const layer = reportNav.layers.pop()
    reportNav.popping = true
    try { layer.close() } finally { reportNav.popping = false }
    return
  }
  reportNav.fromPop = true
  try { reportGoUp() } finally { reportNav.fromPop = false }
  reportNav.depth = reportDepth()
})

initApp()

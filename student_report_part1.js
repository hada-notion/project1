// ===================== 목업 데이터 =====================
// TODO(아이콘 소스 규칙): 일부 아이콘은 HTML에 직접 박힌 이모지이고, 일부는 노션 페이지 아이콘을 가져와야 함. 추후 아이콘 소스를 하나의 변수/규칙으로 통일하는 규칙을 정해야 함 (아직 미정).
let STUDENT = null
let DATA_ERROR = null

const SUPABASE_URL = "https://twczhsxybkcvjkdfdxvs.supabase.co"
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR3Y3poc3h5YmtjdmprZGZkeHZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyOTcwMDQsImV4cCI6MjEwMzg3MzAwNH0.t7Ltb_iSYqE4gHSoGSm-OlpiLjGqIcgrhzGJ-t56EDc"

// 반마다 서로 다른 색상 이모지를 안정적으로 배정한다 (같은 반 이름이면 항상 같은 색).
// 실제 반 색상 데이터가 서버에서 내려오면 이 함수를 그 값으로 교체하면 된다.
const CLASS_COLOR_EMOJIS = ["🟣", "🔵", "🟢", "🟠", "🔴", "🟡", "🟤", "⚪"]
function pickClassColorEmoji(seed) {
  const str = String(seed || "")
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0
  }
  return CLASS_COLOR_EMOJIS[hash % CLASS_COLOR_EMOJIS.length]
}
// 노션 "진행상태" 원본값은 "진행 중" / "완료" / "다음 교재"처럼 공백·이모지가 들어갈 수 있어서,
// 공백과 이모지를 지우고 UI 필터 값(진행중 / 완료 / 예정)으로 매핑한다.
function normalizeBookStatus(rawStatus) {
  const s = String(rawStatus || "")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/\s+/g, "")
  if (!s) return "진행중"
  if (s.includes("진행")) return "진행중"
  if (s.includes("완료") || s.includes("종료")) return "완료"
  if (s.includes("다음") || s.includes("예정") || s.includes("대기")) return "예정"
  return s
}
// 과제 상태에 따른 배지 색상 톤 (제출: 파란색 / 미제출: 빨간색)
function homeworkPillTone(status) {
  const s = String(status || "").trim()
  if (s === "제출") return "tone-submit"
  if (s === "미제출") return "tone-late"
  return ""
}
// 평가 정답률에 따른 배지 색상 톤 (60미만 빨강 / 70미만 주황 / 80미만 노랑 / 90미만 초록 / 100미만 파란 / 100 파란+이모지)
function scorePillTone(correct, total) {
  if (!total) return ""
  const pct = Math.round((correct / total) * 100)
  if (pct >= 100) return "tone-perfect"
  if (pct >= 90) return "tone-blue"
  if (pct >= 80) return "tone-green"
  if (pct >= 70) return "tone-yellow"
  if (pct >= 60) return "tone-orange"
  return "tone-red"
}
// 실제 점수(정답률)를 "N점 (correct/total)" 형식으로 표기한다. (100점이라고 별도 아이콘을 붙이지 않는다.)
function scorePillText(correct, total) {
  if (!total) return `정답 ${correct ?? 0} / 0`
  const pct = Math.round(((correct ?? 0) / total) * 100)
  return `${pct >= 100 ? "💯 " : ""}${pct}점 (${correct ?? 0}/${total})`
}
// 학습기록 카드의 보조정보는 디자인 규칙에 따라 단원·내용을 한 줄로 병합한다.
function logSecondaryText(unit, note) {
  return [unit ? `단원: ${unit}` : "", note || ""].filter(Boolean).join(" · ")
}
// 노션 학습기록 "페이지 본문"을 피드용 부록으로 정리한다.
// Edge Function 이 body: [{ type: "text" | "image", text?, url?, caption? }] 로 내려준다.
function normalizeFeedBody(rawBody) {
  if (!Array.isArray(rawBody)) return []
  return rawBody
    .map((b) => {
      if (!b) return null
      if (b.type === "image" && b.url) {
        return { type: "image", url: String(b.url), caption: String(b.caption || "") }
      }
      if (b.type === "video" && b.url) {
        return { type: "video", url: String(b.url), caption: String(b.caption || "") }
      }
      const t = String(b.text || "").trim()
      if (!t) return null
      return { type: "text", text: t, style: String(b.style || "") }
    })
    .filter(Boolean)
}

// 유튜브/비메오 링크는 iframe 임베드로, 그 외(직접 업로드된 mp4 등)는 <video> 태그로 재생한다.
function buildFeedVideoHtml(vid) {
  const url = String(vid.url || "")
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/)
  const vimeo = url.match(/vimeo\.com\/(\d+)/)
  let inner = ""
  if (yt) {
    inner = `<iframe src="https://www.youtube.com/embed/${esc(yt[1])}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`
  } else if (vimeo) {
    inner = `<iframe src="https://player.vimeo.com/video/${esc(vimeo[1])}" frameborder="0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`
  } else {
    inner = `<video src="${esc(url)}" controls preload="metadata"></video>`
  }
  return `<div class="feed-video">${inner}${vid.caption ? `<div class="feed-video-caption">${esc(vid.caption)}</div>` : ""}</div>`
}

// 피드 본문 렌더링: 글 + 사진을 인스타그램 피드처럼 보여준다.
// 이미지 1장은 크게, 2장 이상은 그리드로 배치한다.
function buildFeedBodyHtml(body) {
  const items = normalizeFeedBody(body)
  if (!items.length) return ""
  const parts = []
  let imageBuffer = []
  const flushImages = () => {
    if (!imageBuffer.length) return
    const cls = imageBuffer.length === 1 ? "feed-images single" : "feed-images"
    parts.push(`<div class="${cls}">${imageBuffer
      .map((img) => `<figure class="feed-figure"><img class="feed-img" src="${esc(img.url)}" loading="lazy" onclick="openFeedImage('${esc(img.url).replace(/'/g, "&#39;")}')" />${img.caption ? `<figcaption>${esc(img.caption)}</figcaption>` : ""}</figure>`)
      .join("")}</div>`)
    imageBuffer = []
  }
  items.forEach((it) => {
    if (it.type === "image") {
      imageBuffer.push(it)
      return
    }
    if (it.type === "video") {
      flushImages()
      parts.push(buildFeedVideoHtml(it))
      return
    }
    flushImages()
    if (it.style === "heading") parts.push(`<div class="feed-heading">${esc(it.text)}</div>`)
    else if (it.style === "bullet") parts.push(`<div class="feed-bullet">${esc(it.text)}</div>`)
    else if (it.style === "quote") parts.push(`<div class="feed-quote">${esc(it.text)}</div>`)
    else parts.push(`<div class="feed-para">${esc(it.text)}</div>`)
  })
  flushImages()
  return `<div class="feed-body">${parts.join("")}</div>`
}

// 피드 이미지 탭 → 전체화면 뷰어
function openFeedImage(url) {
  if (!url) return
  const layer = document.createElement("div")
  layer.className = "feed-lightbox"
  layer.innerHTML = `<img src="${esc(url)}" />`
  layer.onclick = () => layer.remove()
  document.body.appendChild(layer)
}

// [FIX, 2026-09-19] "수업일시" 같은 속성은 UTC 순간(instant)으로 내려온다(예: "2026-09-18T23:11:00.000Z").
// 오후/저녁 수업은 KST로 변환해도 같은 날짜라 문제가 없었지만, 키오스크 보강 체크인처럼 자정
// 근처(KST 00시~09시)에 만들어진 기록은 그냥 앞 10자만 자르면(UTC 기준) 하루 전 날짜로 표시된다
// (캘린더 칸이 비어보이거나 다른 날짜와 겹쳐 보이는 문제로 나타남). Asia/Seoul 기준으로 정확히
// 변환해서 날짜를 뽑는다.
function isoToKstDate(iso) {
  if (!iso) return null
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(iso))
  } catch (_e) {
    return null
  }
}

const LEADING_EMOJI_RE = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*/u
function splitClassNameEmoji(rawClassName) {
  const str = String(rawClassName || "").trim()
  const match = str.match(LEADING_EMOJI_RE)
  if (match) {
    return { emoji: match[1], name: str.slice(match[0].length).trim() }
  }
  return { emoji: "", name: str }
}

// Supabase RPC 응답(같은 학생의 모든 등록을 registrations[] 배열로 집계)을 앞단의 UI가 사용하는
// STUDENT/registrations[] 형태로 변환합니다.
function mapRegistration(reg) {
  return {
    token: reg.access_token || "",
    // [NEW, 2026-09-19] 캘린더 탭의 "동기화" 버튼이 sync-report-cache를 호출할 때 필요하다.
    registration_id: reg.registration_id || null,
    emoji: splitClassNameEmoji(reg.class_name).emoji || pickClassColorEmoji(splitClassNameEmoji(reg.class_name).name),
    class_name: splitClassNameEmoji(reg.class_name).name || reg.class_name || "",
    // 변경 후 (실제 값 반영)
    status: reg.status === "수강 종료" ? "수강종료"
      : reg.status === "수강 대기" ? "수강대기"
      : "수강중",
    start: reg.start_date || null,
    end: reg.end_date || null,
    teacher: reg.teacher_name || "",
    class_mode: reg.class_mode || "",
    schedule: (reg.schedule || []).map((s) => ({ day: s.day, start: s.start, end: s.end })),
    books: (reg.books || []).map((b) => ({ title: b.title || "", progress: b.progress ?? 0, status: normalizeBookStatus(b.status), cover: b.cover || "", pages: b.pages ?? null, units: b.units || [] })),
    attendance_summary: reg.attendance_summary || { present: 0, absent: 0, makeup: 0 },
    attendance_rows: (reg.attendance_rows || []).map((a) => {
      const rawDate = a.iso || a.date_iso || (typeof a.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(a.date) ? a.date : null)
      // [FIX] 백엔드가 시간/타임존까지 포함된 ISO 문자열을 보낼 수 있어, 항상 앞 10자(YYYY-MM-DD)로 정규화한다.
      // 정규화하지 않으면 캘린더(slice 비교)는 매칭되지만 일일 보고서(=== 비교)는 매칭되지 않는 문제가 생긴다.
      // [FIX, 2026-09-19] 위 "정규화"가 실제로는 UTC 기준 slice라서, 자정 근처(KST 00시~09시)에
      // 생성된 기록은 하루 전 날짜로 잘못 표시됐다 (예: 키오스크 보강 체크인). isoToKstDate로
      // Asia/Seoul 기준 날짜를 우선 사용하고, 실패하면 기존 방식(UTC slice)으로 되돌아간다.
      const kstDate = isoToKstDate(rawDate)
      return { date: kstDate || (rawDate ? String(rawDate).slice(0, 10) : null), weekday: a.weekday || "", status: a.status || "" }
    }),
    study_logs: (reg.study_logs || []).map((s) => ({ book: s.book || "", range: s.range || "", unit: s.unit || "", date: s.iso || null, note: s.note || "", body: normalizeFeedBody(s.body) })),
    homework: (reg.homework || []).map((h) => ({ title: h.title || "", book: h.book || "", range: h.range || "", unit: h.unit || "", note: h.note || "", due: h.due_iso || null, status: h.status || "미제출" })),
    homework_days: (reg.homework_days || []).map((h) => ({ date: h.date || null, status: h.status || "미완료", submitted: h.submitted ?? 0, total: h.total ?? 0 })),
    tests: (reg.tests || []).map((t) => ({ title: t.title || "", book: t.book || "", range: t.range || "", unit: t.unit || "", note: t.note || "", date: t.iso || null, correct: t.correct ?? 0, total: t.total ?? 0 })),
    teacher_comments: (reg.teacher_comments || []).map((c) => ({ text: c.text || "", date: c.iso || null, by: c.by || "" })),
    // 주간/월간 보고서: 보고서(학원) DB 자체의 "선생님 한마디"를 보고서 구분·학습 기간과 함께 보관한다.
    report_comments: (reg.report_comments || []).map((c) => ({ kind: c.kind || "", start: c.start || null, end: c.end || c.start || null, comment: c.comment || "" })),
  }
}

function mapReportToStudent(r) {
  const regs = Array.isArray(r.registrations) && r.registrations.length ? r.registrations : [r]
  return {
    academy_name: "",
    student_name: r.student_name || "",
    school: (r.school_grade || "").split(" ")[0] || "",
    grade: (r.school_grade || "").split(" ").slice(1).join(" ") || "",
    gender: "",
    birthdate: "",
    siblings: (r.siblings || []).map((sib) => ({ name: sib.name || "", token: sib.access_token || null })),
    student_phone: r.student_phone || "",
    mother_phone: r.mother_phone || "",
    father_phone: r.father_phone || "",
    primary_contact: r.primary_contact || "",
    grades: (r.grades || []).map((g) => ({
      subject: g.subject || "수학",
      exam_name: g.title || "",
      score: g.score,
      grade_level: g.level || "",
      date: g.iso || null,
    })),
    notices: (r.notices || []).map((n) => ({ date: n.date || null, title: n.title || "", category: n.category || "" })),
    registrations: regs.map(mapRegistration),
  }
}

async function loadReportFromServer() {
  const token = new URLSearchParams(window.location.search).get("token")
  if (!token) {
    DATA_ERROR = "링크가 올바르지 않아요. 받으신 링크를 다시 확인해주세요"
    return
  }
  try {
    const commonHeaders = {
      "apikey": SUPABASE_ANON_KEY,
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    }
    const [fastRes, detailRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/functions/v1/get-report-fast`, {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({ token }),
      }),
      fetch(`${SUPABASE_URL}/functions/v1/get-report-detail`, {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({ token }),
      }),
    ])
    if (!fastRes.ok) throw new Error(`HTTP ${fastRes.status}`)
    if (!detailRes.ok) throw new Error(`HTTP ${detailRes.status}`)
    const fast = await fastRes.json()
    const detail = await detailRes.json()
    const row = { ...fast, ...detail, access_token: fast.token }
    if (Array.isArray(row.registrations) && row.registrations.length) {
      row.registrations = row.registrations.map((r) => (
        r.access_token === fast.token
          ? {
              ...r,
              attendance_summary: detail.attendance_summary,
              attendance_rows: detail.attendance_rows,
              study_logs: detail.study_logs,
              homework: detail.homework,
              homework_days: detail.homework_days,
              tests: detail.tests,
              teacher_comments: detail.teacher_comments,
              report_comments: detail.report_comments,
            }
          : r
      ))
    }
    if (!row) throw new Error("no data")
    STUDENT = mapReportToStudent(row)
    if (STUDENT.student_name) {
      document.title = `${STUDENT.student_name} 학습 리포트`
    }
  } catch (e) {
    DATA_ERROR = "데이터를 불러오는 중 문제가 생겼어요. 잠시 후 다시 시도해주세요"
  }
}

// ===================== 상태 =====================
const app = document.getElementById("app")
let view = "intro" // "intro" | "detail" | "grades" | "schedule" | "book"
let selectedToken = null
let selectedBookTitle = null
let gradeView = "table"
let scheduleMonthIndex = 0
let expandedSection = null // "basic" | "registrations" | null
let selectedCalDate = null
let regTab = "books" // "books" | "calendar" | "study" | "report"
let calMode = "attendance" // "attendance" | "homework"
let regCalMonthIndex = 0
// [NEW, 2026-09-19] 우측 하단 동기화 버튼(FAB) 상태. 캘린더 탭에만 있던 버튼을 화면 전역으로 옮기면서,
// 특정 등록의 캘린더 상태가 아니라 앱 전체 상태로 관리한다 (10-12 참고).
let globalSyncing = false
let globalSyncMessage = ""
let reportPeriod = "week" // "week" | "month" | "day"
let reportOffset = 0 // 0 = current period, 1 = previous period, etc.
let reportDayDate = null // used when reportPeriod === "day"
let bookStatusTab = "진행중" // "진행중" | "완료" | "예정"
// Computes today date in Asia/Seoul time (not UTC) so it is correct before 9am KST.
function todayIsoInSeoul() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
  return parts
}
const MOCK_TODAY = todayIsoInSeoul()
// [FIX] Bound how far back the attendance calendar / schedule calendar / report
// view can navigate. Keep this in sync with the 6-month sinceIso window computed
// server-side in _shared/syncStudentReport.ts so users cannot page into months that
// have no data (which is what made the calendar look like it scrolls forever).
const MAX_LOOKBACK_MONTHS = 6

function esc(s) {
  if (s === null || s === undefined) return ""
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
}

function openMenu() { renderMenuBody(); document.getElementById("menu").classList.add("active") }
function closeMenu() { document.getElementById("menu").classList.remove("active") }

function renderMenuBody() {
  document.getElementById("menu-body").innerHTML = `
    <div class="menu-item-header ${expandedSection === "basic" ? "active" : ""}" onclick="toggleSection('basic')">
      <span class="icon">👤</span><span style="flex:1">기본정보</span><span class="menu-item-chevron">${expandedSection === "basic" ? "▲" : "▼"}</span>
    </div>
    ${expandedSection === "basic" ? `<div class="menu-item-body">${basicInfoBodyHtml()}</div>` : ""}
    <div class="menu-item-header ${expandedSection === "registrations" ? "active" : ""}" onclick="toggleSection('registrations')">
      <span class="icon">🏛️</span><span style="flex:1">등록 클래스</span><span class="menu-item-chevron">${expandedSection === "registrations" ? "▲" : "▼"}</span>
    </div>
    ${expandedSection === "registrations" ? `<div class="menu-item-body">${registrationsBodyHtml()}</div>` : ""}
  `
}
function toggleSection(name) {
  expandedSection = expandedSection === name ? null : name
  renderMenuBody()
}

function openRegistration(token) {
  selectedToken = token
  regTab = "books"
  bookStatusTab = "진행중"
  selectedBookTitle = null
  calMode = "attendance"
  regCalMonthIndex = 0
  reportPeriod = "week"
  reportOffset = 0
  reportDayDate = null
  view = "detail"
  renderApp()
  window.scrollTo({ top: 0 })
}

function openBookStudy(title) {
  selectedBookTitle = normBookTitle(title)
  view = "book"
  renderApp()
  window.scrollTo({ top: 0 })
}
function closeBookDetail() {
  view = "detail"
  selectedBookTitle = null
  renderApp()
  window.scrollTo({ top: 0 })
}
function normBookTitle(v) {
  return String(v || "").trim()
}
function renderBookDetail() {
  const r = currentReg()
  if (!r || !selectedBookTitle) return renderDetail()
  const books = r.books || []
  const targetTitle = normBookTitle(selectedBookTitle)
  const book = books.find((b) => normBookTitle(b.title) === targetTitle) || {}
  const items = []
  ;((r.study_logs) || []).filter((l) => normBookTitle(l.book) === targetTitle).forEach((l) => items.push({
    type: "학습", icon: "📖", date: l.date, book: l.book, range: l.range, unit: l.unit, note: l.note, pill: null, photo: l.photo, body: l.body,
  }))
  ;((r.homework) || []).filter((h) => normBookTitle(h.book) === targetTitle).forEach((h) => items.push({
    type: "과제", icon: "📝", date: h.date || h.due, book: h.book, range: h.range, unit: h.unit, note: h.note || h.title, pill: h.status, pillTone: homeworkPillTone(h.status), photo: null, body: null,
  }))
  ;((r.tests) || []).filter((t) => normBookTitle(t.book) === targetTitle).forEach((t) => items.push({
    type: "평가", icon: "📄", date: t.date, book: t.book, range: t.range, unit: t.unit, note: t.note || t.title, pill: scorePillText(t.correct ?? 0, t.total ?? 0), pillTone: scorePillTone(t.correct ?? 0, t.total ?? 0), photo: null, body: null,
  }))
  const sorted = items.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  const studiedUnitKeys = new Set()
  const studiedUnitList = []
  items.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).forEach((l) => {
    if (!l.unit) return
    l.unit.split(/(?=\d+-\d+\.)/).map((s) => s.trim()).filter(Boolean).forEach((part) => {
      const m = part.match(/^(\d+-\d+)/)
      const key = m ? m[1] : part
      studiedUnitKeys.add(key)
      if (!studiedUnitList.some((u) => u.text === part)) studiedUnitList.push({ text: part, done: true })
    })
  })
  const unitSortKey = (t) => {
    const m = t.match(/^(\d+)-(\d+)/)
    return m ? Number(m[1]) * 1000 + Number(m[2]) : 999999
  }
  const unitList = ((book.units && book.units.length)
    ? book.units.map((u) => {
        const m = u.match(/^(\d+-\d+)/)
        const key = m ? m[1] : u
        return { text: u, done: studiedUnitKeys.has(key) }
      })
    : studiedUnitList
  ).slice().sort((a, b) => unitSortKey(a.text) - unitSortKey(b.text))
  return `
    <div class="reg-detail-page">
      <div class="reg-header-bar">
        <div class="reg-header-top">
          <button class="reg-back-btn" onclick="closeBookDetail()">←</button>
          <div class="reg-breadcrumb">
            <span class="crumb" onclick="goIntro()">${esc(STUDENT.student_name)}</span>
            <span class="crumb-sep">›</span>
            <span class="crumb" onclick="closeBookDetail()">${r.emoji} ${esc(r.class_name)}</span>
            <span class="crumb-sep">›</span>
            <span class="crumb" onclick="closeBookDetail()">📚 교재</span>
            <span class="crumb-sep">›</span>
            <span class="crumb current">📘 ${esc(selectedBookTitle)}</span>
          </div>
        </div>
        <div class="reg-cover-wrap">
          <div class="reg-cover-img">${book.cover ? `<img src="${esc(book.cover)}" alt="${esc(selectedBookTitle)}">` : "📘"}</div>
        </div>
        <div class="reg-head-row">
          <div class="reg-emoji">📘</div>
          <div class="reg-title">${esc(selectedBookTitle)}</div>
        </div>
        <div class="reg-sub-badges">
          <span class="sub-badge">${esc(book.status || "진행중")}</span>
          ${book.progress != null ? `<span class="sub-badge">진도 ${book.progress}%</span>` : ""}
        </div>
      </div>
      <div class="reg-tab-content">
        <div class="book-cover-card">
          <div class="book-cover-top">
            <div class="book-cover-card-img">${book.cover ? `<img src="${esc(book.cover)}" alt="${esc(selectedBookTitle)}">` : "📘"}</div>
            <div class="book-cover-card-info">
              <div class="book-cover-info-row">
                <span class="info-label">단원목록</span>
                <ul class="unit-list">
                  ${unitList.length ? unitList.map((u) => `<li>${esc(u.text)}${u.done ? " ✅" : ""}</li>`).join("") : `<li class="empty">-</li>`}
                </ul>
              </div>
            </div>
          </div>
          ${book.progress != null ? `
          <div class="book-cover-progress">
            <div class="progress-track"><div class="progress-fill" style="width:${book.progress}%"></div></div>
            <div class="progress-label">진도 ${book.progress}%</div>
          </div>` : ""}
        </div>
        <h2>📖 학습기록</h2>
        <div class="section-hint">이 교재와 관련된 학습 · 과제 · 평가 기록을 최근순으로 보여줍니다</div>
        ${(() => {
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
                      <div class="log-title">${esc([l.book, l.range].filter(Boolean).join(" · ") || "기록")}</div>
                      ${l.pill ? `<span class="log-pill ${l.pillTone || ""}">${esc(l.pill)}</span>` : ""}
                    </div>
                    ${logSecondaryText(l.unit, l.note) ? `<div class="log-context">${esc(`\u00a0\u00a0• ${logSecondaryText(l.unit, l.note)}`)}</div>` : ""}
                  </div>
                </div>
                ${(l.photo || (l.body && buildFeedBodyHtml(l.body))) ? `<div class="log-divider"></div><div class="log-extra">${l.photo ? `<img class="log-photo" src="${esc(l.photo)}" />` : ""}${buildFeedBodyHtml(l.body)}</div>` : ""}
                </div>
              `).join("")}
            </div>
          `).join("") : `<div class="empty">이 교재와 관련된 기록이 없습니다.</div>`
        })()}
      </div>
      </div>
    </div>
  `
}
function setBookStatusTab(status) {
  bookStatusTab = status
  renderApp()
}
function setRegTab(tab) {
  regTab = tab
  renderApp()
  window.scrollTo({ top: 0 })
}

function goIntro() {
  view = "intro"
  selectedToken = null
  selectedCalDate = null
  renderApp()
}

function selectCalDay(date) {
  selectedCalDate = date
  regTab = "report"
  reportPeriod = "day"
  reportDayDate = date
  view = "detail"
  renderApp()
  window.scrollTo({ top: 0 })
}

function scrollToTimetable() {
  document.getElementById("timetable-section")?.scrollIntoView({ behavior: "smooth" })
}
function scrollToIntro() {
  document.getElementById("intro-section")?.scrollIntoView({ behavior: "smooth" })
}
function scrollToSchedule() {
  document.getElementById("schedule-section")?.scrollIntoView({ behavior: "smooth" })
}
function scrollToGrades() {
  document.getElementById("grades-section")?.scrollIntoView({ behavior: "smooth" })
}
function scrollToRegSection(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth" })
}

function basicInfoBodyHtml() {
  const s = STUDENT
  return `
    <div class="info-detail-row"><span class="label">학생이름</span><span>${esc(s.student_name)}</span></div>
    <div class="info-detail-row"><span class="label">학교</span><span>${esc(s.school)}</span></div>
    <div class="info-detail-row"><span class="label">학년</span><span>${esc(s.grade)}</span></div>
    <div class="info-detail-row"><span class="label">성별</span><span>${esc(s.gender)}</span></div>
    <div class="info-detail-row"><span class="label">생년월일</span><span>${esc(s.birthdate)}</span></div>
    <div class="info-detail-row"><span class="label">형제자매</span><span>${s.siblings.length ? s.siblings.map((sib) => sib.token ? `<a href="?token=${encodeURIComponent(sib.token)}" class="sibling-link">${esc(sib.name)}</a>` : esc(sib.name)).join(", ") : "-"}</span></div>
    <div class="info-detail-row"><span class="label">학생 연락처</span><span>${esc(s.student_phone)}</span></div>
    <div class="info-detail-row"><span class="label">어머니 연락처</span><span>${esc(s.mother_phone)}</span></div>
    <div class="info-detail-row"><span class="label">아버지 연락처</span><span>${esc(s.father_phone)}</span></div>
  `
}

function registrationsBodyHtml() {
  const statusOrder = { "수강중": 0, "수강종료": 1, "수강대기": 2 }
  const regs = STUDENT.registrations.slice().sort((a, b) => {
    const sa = statusOrder[a.status] ?? 3
    const sb = statusOrder[b.status] ?? 3
    if (sa !== sb) return sa - sb
    return (a.start || "").localeCompare(b.start || "")
  })
  return regs.map((r) => `
    <div class="reg-item" onclick="closeMenu(); openRegistration('${r.token}')">
      <div class="left">
        <span>${r.emoji}</span>
        <div class="name-wrap">
          <span class="class-name">${esc(r.class_name)}</span>
          <span class="period">${esc(toShortDate(r.start))} ~ ${r.end ? esc(toShortDate(r.end)) : "현재"}</span>
        </div>
      </div>
      <span class="badge ${esc(r.status)}">${esc(r.status)}</span>
    </div>
  `).join("")
}

function navigateScheduleMonth(delta) {
  // [FIX] Don't allow paging further back than MAX_LOOKBACK_MONTHS; without this the
  // calendar could be paged back indefinitely into months with no data at all.
  if (delta < 0 && scheduleMonthIndex <= -MAX_LOOKBACK_MONTHS) return
  scheduleMonthIndex += delta
  const area = document.getElementById("schedule-cal-area")
  if (area) {
    area.innerHTML = buildScheduleCalendarHtml()
  } else {
    renderApp()
  }
}
function goScheduleToday() {
  scheduleMonthIndex = 0
  const area = document.getElementById("schedule-cal-area")
  if (area) {
    area.innerHTML = buildScheduleCalendarHtml()
  } else {
    renderApp()
  }
}

function addDaysStr(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00")
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

// 주간 보고서는 항상 월요일~일요일로 고정한다. (요일에 관계없이 오늘이 속한 캘린더 주의 월요일을 기준으로 삼는다)
function mondayOfWeek(dateStr) {
  const d = new Date(dateStr + "T00:00:00")
  const day = d.getDay() // 0=일 ... 6=토
  const diffFromMonday = (day + 6) % 7
  return addDaysStr(dateStr, -diffFromMonday)
}

// 이모지는 카테고리 '이름'과 분리해서 관리한다. 노션 원본의 이모지 표기가 조금 달라져도
// normalizeCategoryName()으로 이모지를 제거한 뒤 이름 텍스트만으로 매칭한다.
function normalizeCategoryName(category) {
  return String(category || "")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .trim()
}
const NOTICE_CATEGORY_COLORS = { "휴원": "#9b9a97", "학원 일정": "#337ea9", "학사 일정": "#e03e3e", "할일": "#448361" }
const NOTICE_CATEGORY_EMOJI = { "휴원": "💤", "학원 일정": "📆", "학사 일정": "🏫", "할일": "✅" }
// 할일(✅)은 강사/직원용 내부 항목이므로 학생에게는 절대 노출하지 않는다.
function getStudentVisibleNotices() {
  return STUDENT.notices.filter((n) => normalizeCategoryName(n.category) !== "할일")
}
function scheduleBaseDate() {
  const [y, m] = MOCK_TODAY.split("-").map(Number)
  return new Date(y, m - 1 + scheduleMonthIndex, 1)
}
function buildScheduleCalendarHtml() {
  const notices = getStudentVisibleNotices()
  const base = scheduleBaseDate()
  const y = base.getFullYear()
  const mo = base.getMonth() + 1
  const monthKey = `${y}-${String(mo).padStart(2, "0")}`
  const startWeekday = new Date(y, mo - 1, 1).getDay()
  const daysInMonth = new Date(y, mo, 0).getDate()
  const byDay = {}
  notices.filter((n) => n.date && n.date.startsWith(monthKey)).forEach((n) => {
    const d = Number(n.date.slice(8, 10))
    byDay[d] = byDay[d] || []
    byDay[d].push(n)
  })
  let cells = ""
  for (let i = 0; i < startWeekday; i++) cells += '<div class="cal-cell"></div>'
  for (let d = 1; d <= daysInMonth; d++) {
    const evts = byDay[d]
    const dateStr = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`
    const today = dateStr === MOCK_TODAY ? "today" : ""
    const dots = evts ? evts.slice(0, 3).map((n) => `<span class="cal-dot" style="background:${NOTICE_CATEGORY_COLORS[normalizeCategoryName(n.category)] || "#999"}"></span>`).join("") : ""
    cells += `<div class="cal-cell ${evts ? "has-event" : ""} ${today}" ${evts ? `onclick="openScheduleDay('${dateStr}')"` : ""}><span>${d}</span>${evts ? `<span class="cal-dots">${dots}</span>` : ""}</div>`
  }
  return `
    <div class="schedule-cal-wrap">
      <div class="cal-month">
        <div class="cal-month-nav">
          <button class="cal-nav-btn" ${scheduleMonthIndex <= -MAX_LOOKBACK_MONTHS ? "disabled" : ""} onclick="navigateScheduleMonth(-1)">‹</button>
          <div class="cal-month-title">${y}년 ${mo}월</div>
          <div class="cal-nav-right">
            <button class="cal-today-btn" onclick="goScheduleToday()">오늘</button>
            <button class="cal-nav-btn" onclick="navigateScheduleMonth(1)">›</button>
          </div>
        </div>
        <div class="cal-weekdays">${["일", "월", "화", "수", "목", "금", "토"].map((w) => `<div>${w}</div>`).join("")}</div>
        <div class="cal-grid">${cells}</div>
      </div>
    </div>
  `
}
function openScheduleDay(dateStr) {
  const dayNotices = getStudentVisibleNotices().filter((n) => n.date === dateStr)
  document.getElementById("schedule-day-modal-title").textContent = dateStr
  document.getElementById("schedule-day-modal-body").innerHTML = dayNotices.length ? dayNotices.map((n) => `
    <div class="list-item">
      <div class="title"><span class="cal-dot" style="background:${NOTICE_CATEGORY_COLORS[normalizeCategoryName(n.category)] || "#999"}"></span>${esc(n.title)}</div>
      <div class="meta">${esc(`${NOTICE_CATEGORY_EMOJI[normalizeCategoryName(n.category)] || ""} ${normalizeCategoryName(n.category) || "안내"}`.trim())}</div>
    </div>
  `).join("") : '<div class="empty">이 날짜에는 일정이 없습니다.</div>'
  document.getElementById("schedule-day-modal").classList.add("active")
}
function closeScheduleDayModal() {
  document.getElementById("schedule-day-modal").classList.remove("active")
}

let testChartPoints = []
function showTestDetailModal(i) {
  const p = testChartPoints[i]
  if (!p) return
  document.getElementById("test-detail-modal-title").textContent = p.label
  const items = p.items || []
  document.getElementById("test-detail-modal-body").innerHTML = items.length
    ? items.map((t) => `
      <div class="log-row 평가">
        <div class="log-title-row"><div class="log-title">${esc([t.book, t.range].filter(Boolean).join(" · "))}</div><span class="log-pill ${scorePillTone(t.correct ?? 0, t.total ?? 0)}">${scorePillText(t.correct ?? 0, t.total ?? 0)}</span></div>
        ${t.unit ? `<div class="log-context">${esc(`  • 단원: ${t.unit}`)}</div>` : ""}
        ${(t.note || t.title) ? `<div class="log-note">${esc(t.note || t.title)}</div>` : ""}
        <div class="log-context">  • 날짜: ${esc(t.date || "-")}</div>
      </div>
    `).join("")
    : `<div class="log-row 평가"><div class="log-note">해당 기간 평가 기록이 없습니다.</div></div>`
  document.getElementById("test-detail-modal").classList.add("active")
}
function closeTestDetailModal() {
  document.getElementById("test-detail-modal").classList.remove("active")
}

function buildGradeTableHtml(grades) {
  return `
    <table class="grade-table">
      <thead><tr><th>과목</th><th>시험명</th><th>점수</th><th>등급</th><th>날짜</th></tr></thead>
      <tbody>${grades.slice().reverse().map((g) => `<tr><td>${esc(g.subject)}</td><td>${esc(g.exam_name)}</td><td>${g.score}점</td><td>${esc(g.grade_level)}</td><td>${esc(g.date)}</td></tr>`).join("")}</tbody>
    </table>
  `
}
const SUBJECT_COLORS = { "수학": "#6c5ce7" }
function niceAxisStep(maxValue, targetTicks) {
  const safeMax = maxValue > 0 ? maxValue : 100
  const roughStep = safeMax / targetTicks
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)))
  const residual = roughStep / magnitude
  let niceResidual
  if (residual > 5) niceResidual = 10
  else if (residual > 2) niceResidual = 5
  else if (residual > 1) niceResidual = 2
  else niceResidual = 1
  return niceResidual * magnitude
}
function buildGradeChartHtml(grades) {
  const subjects = [...new Set(grades.map((g) => g.subject))]
  const width = 400, height = 240
  const paddingLeft = 34, paddingRight = 14, paddingTop = 18, paddingBottom = 36
  const dates = [...new Set(grades.map((g) => g.date))].sort()
  // X축에는 날짜 대신 해당 날짜의 시험명(예: "중1 1학기 중간고사")을 표시하고, 시험명이 없으면 날짜로 폴백합니다. dates가 이미 날짜순(ISO 문자열 sort)으로 정렬돼 있으므로 시간순이 유지됩니다.
  const dateExamLabels = dates.map((d) => {
    const match = grades.find((g) => g.date === d && g.exam_name)
    return match ? match.exam_name : toShortDate(d)
  })
  const plotWidth = width - paddingLeft - paddingRight
  const xStep = dates.length > 1 ? plotWidth / (dates.length - 1) : 0
  const scores = grades.map((g) => g.score)
  const axisMax = 100
  const ticks = [0, 20, 40, 60, 80, 100]
  const yFor = (score) => height - paddingBottom - (score / axisMax) * (height - paddingTop - paddingBottom)
  const xFor = (date) => dates.length > 1 ? paddingLeft + dates.indexOf(date) * xStep : paddingLeft + plotWidth / 2
  const lines = subjects.map((subj) => {
    const pts = grades.filter((g) => g.subject === subj).sort((a, b) => (a.date || "").localeCompare(b.date || ""))
    const path = pts.map((p) => `${xFor(p.date)},${yFor(p.score)}`).join(" ")
    const color = SUBJECT_COLORS[subj] || "#999"
    const dots = pts.map((p) => `<circle cx="${xFor(p.date)}" cy="${yFor(p.score)}" r="4" fill="${color}" />`).join("")
    const valueLabels = pts.map((p) => `<text x="${xFor(p.date)}" y="${yFor(p.score) - 10}" font-size="11" font-weight="700" fill="${color}" text-anchor="middle">${p.score}점</text>`).join("")
    return `<polyline points="${path}" fill="none" stroke="${color}" stroke-width="2" />${dots}${valueLabels}`
  }).join("")
  const gridLines = ticks.map((v) => `
    <line x1="${paddingLeft}" y1="${yFor(v)}" x2="${width - paddingRight}" y2="${yFor(v)}" stroke="#eee" stroke-width="1" />
    <text x="${paddingLeft - 6}" y="${yFor(v) + 3}" font-size="9" fill="#bbb" text-anchor="end">${v}</text>
  `).join("")
  const axisLines = `
    <line x1="${paddingLeft}" y1="${paddingTop}" x2="${paddingLeft}" y2="${height - paddingBottom}" stroke="#ddd" stroke-width="1" />
    <line x1="${paddingLeft}" y1="${height - paddingBottom}" x2="${width - paddingRight}" y2="${height - paddingBottom}" stroke="#ddd" stroke-width="1" />
  `
  const xAxisTicks = dates.map((d, i) => `
    <text x="${xFor(d)}" y="${height - paddingBottom + 14}" font-size="9" fill="#bbb" text-anchor="middle">${esc(dateExamLabels[i])}</text>
  `).join("")
  return `
    <div class="chart-legend">${subjects.map((s) => `<div class="legend-item"><span class="dot" style="background:${SUBJECT_COLORS[s] || "#999"}"></span>${esc(s)}</div>`).join("")}</div>
    <div class="chart-wrap"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">${gridLines}${axisLines}${lines}${xAxisTicks}</svg></div>
  `
}

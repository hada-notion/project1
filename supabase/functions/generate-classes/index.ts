// Supabase Edge Function: generate-classes
// Reads the timetable (recurring class schedule) DB and creates class-session pages,
// then creates attendance only for registrations actually linked to that specific timetable.
//
// There are 2 call modes, distinguished by the request body:
// (1) Button (manual) call: body = { "timetableId": "<timetable page id>" }
//     -> Only that one timetable is processed, and only ONE upcoming class session is created for it.
// (2) Cron (automatic) call: body has no timetableId
//     -> ALL timetables are processed. For each one, class sessions are created/backfilled
//        until sessions exist all the way through "today + AUTO_HORIZON_DAYS" (next week, same weekday).
// Both modes share the same processTimetable() function; only horizonDate differs.
// Since a call is skipped once a timetable already has a session on/after horizonDate,
// calling this endpoint repeatedly is always safe (idempotent).
//
// v2에서 추가됨: 출석을 새로 만든 직후, 그 등록(학생)에 대해 "과제 마감"이 아직 비어있는 과제
// 학습활동이 있으면 이번에 새로 생긴 출석(수업)에 자동으로 연결한다 (linkPendingAssignmentDeadlines).
// 출제 당시엔 다음 수업이 없어서 마감을 못 잡았던 경우, 이 함수가 나중에 다음 수업을 만들 때
// 자동으로 채워지도록 하는 안전망이다. (sync-registration-class-session에도 동일한 로직이 있음 —
// 등록의 "수업 생성" 버튼 경로. 이 함수는 시간표 기준 자동/수동 생성 경로를 담당한다.)

import {
	queryDataSource,
	queryAllPages,
	getPage,
	createPage,
	updatePageProperties,
	dateStart,
	relIds,
} from "../_shared/notionClient.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"
import {
	PROP_TIMETABLE_GEN_RUNNING,
	PROP_TIMETABLE_LAST_ERROR,
	PROP_SESSION_GEN_RUNNING,
	PROP_LAST_ERROR,
} from "../_shared/constants.ts"
// 대시보드(학원) DB 자동 연결: 이 함수가 Notion API로 직접 만드는 수업/출석 페이지는 페이지
// 자동화가 트리거되지 않으므로, 생성 직후 여기서 직접 큐에 적재한다 (2026-09-20, 대시보드 기능 추가).
import { enqueueDashboardLink } from "../_shared/dashboardLinkTarget.ts"
// (2026-09-21, 인증 정책 추가) 이 함수는 지금까지 아무 인증도 없이 POST만 확인하면 누구나 호출할 수 있었다.
// 다른 어드민 함수들과 동일하게 x-admin-key 헤더를 요구해서, URL만 알면 전체 시간표를 강제로
// 재생성시킬 수 있었던 구멍을 막는다.
import { requireAdminKey } from "../_shared/adminShared.ts"

// Data source IDs (fixed by workspace structure, hardcoded)
const DS = {
  timetable: "4e4ba040-586b-832c-989b-8703a89aa322", // 시간표
  classSession: "3b1ba040-586b-80ec-af20-000b31bb69b7", // 수업
  studentClass: "67cba040-586b-835b-b02f-8708589c7cf1", // 클래스
  attendance: "8aaba040-586b-8322-8437-87608a763415", // 출석
  registration: "16dba040-586b-838a-ae3c-876c0e9cd474", // 등록
  scheduleEvent: "4ebba040-586b-836b-bfb0-8741d650419b", // 일정
  studyActivity: "ea2ba040-586b-8368-8bb6-070564a5a31c", // 학습활동
  learningRecord: "d97ba040-586b-8310-b710-8782e29b5c73", // 학습기록
}

// ---- 학습활동(학원) DB: 대기 중인 과제 마감 백필용 ----
const PROP_ACTIVITY_CATEGORY = "구분"
const PROP_ACTIVITY_REGISTRATION = "등록"
const PROP_ACTIVITY_ATTENDANCE = "출석"
const PROP_ACTIVITY_RECORD = "학습기록"
const PROP_ACTIVITY_DEADLINE = "과제 마감"
const CATEGORY_ASSIGNMENT = "과제"
const PROP_RECORD_DATE = "수업일" // 학습기록(학원) DB
const PROP_ATTENDANCE_REGISTRATION = "등록" // 출석(학원) DB
const PROP_ATTENDANCE_CLASS_DATETIME = "수업일시" // 출석(학원) DB

// Korean weekday select option name -> weekday number (0 = Sunday ... 6 = Saturday)
const WEEKDAY_MAP: Record<string, number> = {
  일: 0,
  월: 1,
  화: 2,
  수: 3,
  목: 4,
  금: 5,
  토: 6,
}

// weekday number -> single Korean character, used to build the class-session title
// in Korean (e.g. "09.14(월)") instead of the English weekday abbreviation (e.g. "09.14(Mon)").
const WEEKDAY_KR: Record<number, string> = {
  0: "일",
  1: "월",
  2: "화",
  3: "수",
  4: "목",
  5: "금",
  6: "토",
}

const KST_OFFSET = "+09:00"
const MAX_LOOKAHEAD_DAYS = 90
// Automatic (cron) calls make sure class sessions exist through this many days from today,
// i.e. through next week's same weekday.
const AUTO_HORIZON_DAYS = 7
// Perf: how many timetables to process at once (bulk-button and cron paths) instead of
// strictly one-at-a-time. Each timetable's work is independent, so this cuts wall-clock time
// roughly by this factor for a full multi-timetable run. Kept modest to stay well under
// Notion's rate limit (existing 429/5xx retry logic in notionClient.ts covers any overshoot)
// (2026-09-11 perf fix).
const TIMETABLE_CONCURRENCY = 4

// notionHeaders / queryDataSource / getPage / createPage / updatePageProperties / dateStart / relIds
// 는 이제 _shared/notionClient.ts에서 가져온다 (429/5xx 재시도가 자동으로 추가됨, 로드맵 5-9).

// 등록 1건에 대해, "과제 마감"이 아직 비어있는 과제 학습활동들을 찾아서 그 학생의 다음 수업(출석)이
// 새로 생겨났는지 확인하고 있으면 연결한다. 출제 당시엔 다음 수업이 없어서 마감을 못 잡았던 경우,
// 나중에 수업이 생성될 때(이 함수가 다시 호출될 때) 자동으로 채워지도록 하는 안전망이다.
async function linkPendingAssignmentDeadlines(regId: string, log: string[]) {
  const pending = await queryDataSource(DS.studyActivity, {
    filter: {
      and: [
        { property: PROP_ACTIVITY_REGISTRATION, relation: { contains: regId } },
        { property: PROP_ACTIVITY_CATEGORY, select: { equals: CATEGORY_ASSIGNMENT } },
        { property: PROP_ACTIVITY_DEADLINE, relation: { is_empty: true } },
      ],
    },
    page_size: 100,
  })
  if (pending.results.length === 0) return

  let linked = 0
  for (const activity of pending.results as any[]) {
    // 마감 기준 시각: 이 학습활동이 만들어진 시점의 수업(출석) 날짜, 없으면 학습기록의 수업일.
    let issueDate: string | null = null
    const attendanceIds = relIds(activity.properties[PROP_ACTIVITY_ATTENDANCE])
    if (attendanceIds.length > 0) {
      const attendancePage = await getPage(attendanceIds[0])
      issueDate = dateStart(attendancePage, PROP_ATTENDANCE_CLASS_DATETIME)
    }
    if (!issueDate) {
      const recordIds = relIds(activity.properties[PROP_ACTIVITY_RECORD])
      if (recordIds.length > 0) {
        const recordPage = await getPage(recordIds[0])
        issueDate = dateStart(recordPage, PROP_RECORD_DATE)
      }
    }
    if (!issueDate) continue

    const nextAttendance = await queryDataSource(DS.attendance, {
      filter: {
        and: [
          { property: PROP_ATTENDANCE_REGISTRATION, relation: { contains: regId } },
          { property: PROP_ATTENDANCE_CLASS_DATETIME, date: { after: issueDate } },
        ],
      },
      sorts: [{ property: PROP_ATTENDANCE_CLASS_DATETIME, direction: "ascending" }],
      page_size: 1,
    })
    const nextId = nextAttendance.results[0]?.id
    if (!nextId) continue

    await updatePageProperties(activity.id, {
      [PROP_ACTIVITY_DEADLINE]: { relation: [{ id: nextId }] },
    })
    linked++
  }
  if (linked > 0) {
    log.push(`📌 대기 중이던 과제 마감 ${linked}건을 새로 생긴 수업에 연결함 (등록 ${regId})`)
  }
}

// Today's date (YYYY-MM-DD) in KST.
function todayKstDateStr(): string {
  const now = new Date()
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  return kst.toISOString().slice(0, 10)
}

// Current time-of-day (HH:mm) in KST.
function nowKstTimeStr(): string {
  const now = new Date()
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  return kst.toISOString().slice(11, 16)
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z")
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// [start-of-day, start-of-next-day) in KST, as ISO strings, for a YYYY-MM-DD date string.
// Mirrors fix-attendance's dayRangeIso -- used to find a same-calendar-day attendance page
// that was created ahead of time (e.g. via the 등록 페이지의 캘린더 탭) before this session existed.
function dayRangeIso(dateStr: string): { start: string; end: string } {
  const start = `${dateStr}T00:00:00${KST_OFFSET}`
  const end = `${addDays(dateStr, 1)}T00:00:00${KST_OFFSET}`
  return { start, end }
}

function weekdayOf(dateStr: string): number {
  // dateStr represents a calendar date only (no timezone info), so a UTC weekday
  // calculation gives the same result as a KST weekday calculation.
  const d = new Date(dateStr + "T00:00:00Z")
  return d.getUTCDay()
}

function isWithinRange(dateStr: string, startStr: string, endStr: string): boolean {
  return dateStr >= startStr.slice(0, 10) && dateStr <= endStr.slice(0, 10)
}

type ClosurePeriod = { start: string; end: string }

async function getClosurePeriods(classId: string): Promise<ClosurePeriod[]> {
  const data = await queryDataSource(DS.scheduleEvent, {
    filter: {
      and: [
        { property: "클래스", relation: { contains: classId } },
        { property: "구분", select: { equals: "💤 휴원" } },
      ],
    },
    page_size: 100,
  })
  return data.results.map((page: any) => {
    const date = page.properties["날짜"].date
    return { start: date.start, end: date.end ?? date.start }
  })
}

function findNextClassDate(baseDate: string, weekday: number, closures: ClosurePeriod[]): string {
  let candidate = baseDate
  for (let i = 0; i < MAX_LOOKAHEAD_DAYS; i++) {
    if (weekdayOf(candidate) === weekday) {
      const blocked = closures.some((c) => isWithinRange(candidate, c.start, c.end))
      if (!blocked) return candidate
    }
    candidate = addDays(candidate, 1)
  }
  throw new Error(
    `No available class date found within ${MAX_LOOKAHEAD_DAYS} days (baseDate=${baseDate})`,
  )
}

async function getLatestClassDate(timetableId: string): Promise<string | null> {
  const data = await queryDataSource(DS.classSession, {
    filter: { property: "시간표", relation: { contains: timetableId } },
    sorts: [{ property: "수업일시", direction: "descending" }],
    page_size: 1,
  })
  if (data.results.length === 0) return null
  const date = data.results[0].properties["수업일시"].date
  return date ? date.start.slice(0, 10) : null
}

// Monday (YYYY-MM-DD) of the calendar week containing dateStr. Used by the bulk button's
// week-completeness pre-pass (2026-09-11) to group each timetable's "next needed" date into a
// shared calendar week, regardless of which weekday that particular timetable's class falls on.
function mondayOfWeek(dateStr: string): string {
  const w = weekdayOf(dateStr) // 0=Sun..6=Sat
  const daysSinceMonday = w === 0 ? 6 : w - 1
  return addDays(dateStr, -daysSinceMonday)
}

// Read-only "peek": this timetable's next MISSING class date, without creating anything.
// Mirrors the same baseDate/findNextClassDate logic processTimetable uses internally, so the
// bulk button's week-completeness pre-pass (below) can find the earliest calendar week that's
// incomplete somewhere without actually generating any sessions yet (2026-09-11).
async function peekNextNeededDate(timetable: any): Promise<string | null> {
  const props = timetable.properties
  const classIds = relIds(props["클래스"])
  if (classIds.length === 0) return null
  const classId = classIds[0]
  const weekdayName = props["요일"]?.select?.name
  const weekday = WEEKDAY_MAP[weekdayName]
  if (weekday === undefined) return null

  const today = todayKstDateStr()
  const latestDate = await getLatestClassDate(timetable.id)
  const closures = await getClosurePeriods(classId)
  const baseDate = latestDate ? addDays(latestDate, 1) : today
  return findNextClassDate(baseDate, weekday, closures)
}

// Fetches the class page's "클래스명" (title) and "담당강사" (relation) properties together.
// [2026-09-21] Changed from a "클래스명 문자열만 가져오는" helper to also read 담당강사 directly
// from 클래스(학원) DB — the ultimate source of truth for a class's teacher assignment — instead
// of relying on 시간표.담당강사 (see processTimetable below). 시간표.담당강사 was previously
// populated only by a Notion AI "자동채우기" 에이전트, which fires only for rows a person edits by
// hand in the Notion UI (never for rows this function or other API calls touch), and turned out
// to be duplicated (2 identical agents wired to the same property). Reading straight from 클래스
// removes that fragile dependency and matches how kiosk-checkin already reads 담당강사 (메뉴얼 5-10).
async function getClassInfo(classId: string): Promise<{ name: string; teacherIds: string[] }> {
  const page = await getPage(classId)
  // "클래스명" is the TITLE property of the 클래스 DB, so it's under `.title`, not `.rich_text`.
  const name = page.properties["클래스명"]?.title?.[0]?.plain_text ?? "class"
  const teacherIds = relIds(page.properties["담당강사"])
  return { name, teacherIds }
}

// "2026-09-14" -> "09.14"
function toMonthDayStr(dateStr: string): string {
  return `${dateStr.slice(5, 7)}.${dateStr.slice(8, 10)}`
}

// Perf (2026-09-11): previously this ran ONE Notion query per session date inside the
// processTimetable while-loop below — during a multi-session backfill (e.g. the first-ever
// "일주일 일괄 생성" run creating ~7 sessions per timetable) that meant 7x redundant queries per
// timetable, since a timetable's registration list rarely changes within a single call.
// Now split into: fetch ALL registrations for the timetable ONCE, then filter in-memory per
// session date.
async function getTimetableRegistrations(
  timetableId: string,
): Promise<Array<{ id: string; start: string | null; end: string | null }>> {
  const data = await queryDataSource(DS.registration, {
    filter: { property: "시간표", relation: { contains: timetableId } },
    page_size: 100,
  })
  return data.results.map((p: any) => ({
    id: p.id,
    start: p.properties["등록일"]?.date?.start ?? null,
    end: p.properties["종료일"]?.date?.start ?? null,
  }))
}

// Filters a pre-fetched registration list (see getTimetableRegistrations above) down to the
// ones valid for a SPECIFIC session date, using 등록일 <= dateStr <= 종료일 (either boundary
// empty = open-ended). This is date-bound rather than "current 수강상태", so it correctly
// handles:
//  - a timetable connected to a registration before its 등록일 arrives (future 등록일)
//  - a timetable kept connected after 종료일 for historical bookkeeping (no longer disconnected)
// Matches the session-bound logic used by fix-attendance and frozen onto the class session's
// own "등록" relation at creation time.
function filterRegistrationsForDate(
  registrations: Array<{ id: string; start: string | null; end: string | null }>,
  dateStr: string,
): string[] {
  return registrations
    .filter((r) => {
      const onOrAfterStart = !r.start || dateStr >= r.start.slice(0, 10)
      const onOrBeforeEnd = !r.end || dateStr <= r.end.slice(0, 10)
      return onOrAfterStart && onOrBeforeEnd
    })
    .map((r) => r.id)
}

// Perf helper: runs fn over items with at most `concurrency` in flight at once, instead of
// either fully sequential (slow) or unbounded Promise.all (risks Notion rate limits). Used to
// process several timetables in parallel (2026-09-11 perf fix).
async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0
  async function worker() {
    while (nextIndex < items.length) {
      const current = items[nextIndex++]
      await fn(current)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
}

type ProcessMode =
  // Button (manual, single) mode: always creates exactly ONE new session right after the
  // latest existing one, regardless of whether that latest session is already in the future.
  | { type: "single" }
  // Cron (automatic) mode AND bulk button (manual, "다음주 수업 일괄 생성") mode both use this:
  // keep creating sessions (oldest-missing-first) until one exists on/after horizonDate.
  // - Cron: horizonDate is always "today + AUTO_HORIZON_DAYS", so repeated cron runs converge
  //   on "always ~7 days ahead" instead of drifting forward.
  // - Bulk button: horizonDate is recomputed fresh on EVERY click as the Sunday of the
  //   earliest calendar week that at least one timetable is still missing a session for (see
  //   the week-completeness pre-pass in the bulk button handler below). This horizon is
  //   intentionally SHARED across every timetable in one click (not computed per-timetable),
  //   so a timetable that already has extra weeks pre-made ahead (for whatever reason) is left
  //   alone -- it's already past this horizon, so it creates nothing this round -- while
  //   timetables still missing that week get filled up to it. This keeps every timetable's
  //   length converging together instead of already-ahead ones running further ahead while
  //   behind ones never catch up (2026-09-11).
  | { type: "until"; horizonDate: string }

// 시간표 DB에 처리 상태 표시 (버튼 모드에서만 사용; 크론 모드는 DB 전체를 순회하므로 굳이
// 개별 표시하지 않는다 — 매번 다 순회해서 만들거나 안 만들거나 끝나기 때문에 사용자가 지켜볼
// 대상이 아님). 실패해도 캐스케이드 전체를 막지 않도록 조��히 무시한다.
// (2026-09-11 마이그레��션: 공유 select "생성 상태"에서 체크박스 + "실시간 처리 상태" 수식으로 전환).
async function markGenRunning(timetableId: string, running: boolean): Promise<void> {
  try {
    const props: Record<string, unknown> = { [PROP_TIMETABLE_GEN_RUNNING]: { checkbox: running } }
    // Clear any previous error the moment a new run starts (not when it finishes), so the
    // "실시간 처리 상태" formula (which shows 마지막 오류 ahead of 생성중) doesn't keep displaying a
    // stale error from a prior run for the whole duration of this new run (2026-09-11 fix).
    if (running) {
      props[PROP_TIMETABLE_LAST_ERROR] = { rich_text: [] }
    }
    await updatePageProperties(timetableId, props)
  } catch (err) {
    console.error(`markGenRunning(${timetableId}, ${running}) failed:`, (err as Error).message)
  }
}

async function markGenDone(timetableId: string): Promise<void> {
  try {
    await updatePageProperties(timetableId, {
      [PROP_TIMETABLE_GEN_RUNNING]: { checkbox: false },
      [PROP_TIMETABLE_LAST_ERROR]: { rich_text: [] },
    })
  } catch (err) {
    console.error(`markGenDone(${timetableId}) failed:`, (err as Error).message)
  }
}

async function markGenError(timetableId: string, message: string): Promise<void> {
  try {
    await updatePageProperties(timetableId, {
      [PROP_TIMETABLE_GEN_RUNNING]: { checkbox: false },
      [PROP_TIMETABLE_LAST_ERROR]: { rich_text: [{ text: { content: message.slice(0, 1900) } }] },
    })
  } catch (err) {
    console.error(`markGenError(${timetableId}) failed:`, (err as Error).message)
  }
}

// 수업(학원) DB 개별 행에 처리 상태 표시 (2026-09-11 추가). 시간표 DB의 markGenRunning과 달리
// "생성중"은 세션 생성 시점에 이미 true로 함께 만들어지므로(아래 createPage 호출부 참고),
// 여기서는 "끝났을 때" 끄는 markSessionDone/markSessionError만 필요하다. 실패해도 전체 캐스케이드를
// 막지 않도록 조용히 무시한다.
async function markSessionDone(sessionId: string): Promise<void> {
  try {
    await updatePageProperties(sessionId, {
      [PROP_SESSION_GEN_RUNNING]: { checkbox: false },
      [PROP_LAST_ERROR]: { rich_text: [] },
    })
  } catch (err) {
    console.error(`markSessionDone(${sessionId}) failed:`, (err as Error).message)
  }
}

async function markSessionError(sessionId: string, message: string): Promise<void> {
  try {
    await updatePageProperties(sessionId, {
      [PROP_SESSION_GEN_RUNNING]: { checkbox: false },
      [PROP_LAST_ERROR]: { rich_text: [{ text: { content: message.slice(0, 1900) } }] },
    })
  } catch (err) {
    console.error(`markSessionError(${sessionId}) failed:`, (err as Error).message)
  }
}

async function processTimetable(timetable: any, log: string[], mode: ProcessMode) {
  const props = timetable.properties
  const timetableId = timetable.id
  const timetableName = props["이름"]?.title?.[0]?.plain_text ?? timetableId

  const classIds = relIds(props["클래스"])
  if (classIds.length === 0) {
    log.push(`[skip] ${timetableName}: no linked class`)
    return
  }
  const classId = classIds[0]

  const weekdayName = props["요일"]?.select?.name
  const weekday = WEEKDAY_MAP[weekdayName]
  if (weekday === undefined) {
    log.push(`[skip] ${timetableName}: no weekday set`)
    return
  }

  const startTime = props["등원시간(HH:mm)"]?.rich_text?.[0]?.plain_text || "09:00"
  const endTime = props["하원시간(HH:mm)"]?.rich_text?.[0]?.plain_text || "10:00"
  // [2026-09-21] 담당강사는 더 이상 시간표 자신의 "담당강사" 속성에서 읽지 않는다 — 아래에서
  // getClassInfo(classId)로 클래스(학원) DB에서 직접 가져온다 (이유는 getClassInfo 주석 참고).
  // Per-timetable time-of-day gate for cron (auto) creation of *today's* session.
  // Configurable via the "자동생성 시간" text property (HH:mm) instead of a hardcoded constant,
  // so each class's auto-creation time can be adjusted later without a code change.
  // (2026-09-11: property renamed from "생성시각" to "자동생성 시간" for clarity — the code was
  // still reading the old key name, so this gate silently always fell back to the "00:00"
  // default. Fixed to read the current property name.)
  const generationTime = props["자동생성 시간"]?.rich_text?.[0]?.plain_text || "00:00"

  const today = todayKstDateStr()
  let latestDate = await getLatestClassDate(timetableId)
  let createdCount = 0

  // Perf (2026-09-11): closures, class name, and the registration list don't change across
  // iterations of the while-loop below for a given timetable, but were previously re-fetched
  // from Notion on EVERY iteration (i.e. once per session created). Fetching them once up
  // front removes most of the redundant network calls that made a multi-session backfill (the
  // first-ever "일주일 일괄 생성" run) slow.
  const closures = await getClosurePeriods(classId)
  const { name: className, teacherIds } = await getClassInfo(classId)
  const weekdayKr = WEEKDAY_KR[weekday]
  const timetableRegs = await getTimetableRegistrations(timetableId)

  // horizonDate is supplied directly by the caller for "until" mode. Both the cron path and
  // the bulk button path use "until" now; see ProcessMode above for how each computes it.
  const horizonDate = mode.type === "until" ? mode.horizonDate : null

  // Button (single) mode: run the create-one-session body exactly once, unconditionally.
  // Cron/extend mode: keep running it, but ONLY for candidate dates up through horizonDate
  // (inclusive). This must be checked against the *candidate* date about to be created,
  // not against the previously-created latestDate — otherwise, once a weekly class has a
  // session anywhere before horizonDate, the loop would run one more time and create an
  // extra session for the following week (one full cycle past horizonDate).
  while (true) {
    const baseDate = latestDate ? addDays(latestDate, 1) : today
    const nextDate = findNextClassDate(baseDate, weekday, closures)

    // Cron/extend mode: stop BEFORE creating a session that falls beyond horizonDate.
    if (horizonDate !== null && nextDate > horizonDate) {
      break
    }

    // Cron mode ONLY: if the next missing session is TODAY's, wait until this timetable's
    // configured "자동생성 시간" (generation time-of-day) before creating it. This only gates
    // today's date -- past catch-up dates and future dates within the horizon are created
    // immediately regardless of time-of-day. Manual clicks (single/extend) skip this gate --
    // an explicit user click should create today's session right away (2026-09-11).
    if (mode.type === "until" && nextDate === today && generationTime > nowKstTimeStr()) {
      log.push(
        `[wait] ${timetableName}: today's session (${nextDate}) scheduled for ${generationTime}, now is ${nowKstTimeStr()}`,
      )
      break
    }

    const startIso = `${nextDate}T${startTime}:00${KST_OFFSET}`
    const endIso = `${nextDate}T${endTime}:00${KST_OFFSET}`

    // Build the title directly as "<className> MM.DD(<Korean weekday>)", e.g. "고둥 과외 09.14(월)".
    // NOTE: if any separate Notion automation on the class-session DB also rewrites the
    // "이름" property (e.g. into an English "MM.DD(Mon)" format), that automation should be
    // turned off, since this function now sets the final title directly.
    const classPageTitle = `${className} ${toMonthDayStr(nextDate)}(${weekdayKr})`

    // Pass timetableId (not classId) so only registrations actually linked to this specific
    // timetable/weekday are considered, and nextDate so only registrations valid AS OF THIS
    // SESSION'S OWN DATE are included — this set is frozen onto the session's "등록" relation
    // below and never recomputed based on "current" 등록일/종료일 status. Filtered in-memory
    // from the single timetableRegs fetch above instead of a fresh Notion query per session
    // date (2026-09-11 perf fix).
    const registrationIds = filterRegistrationsForDate(timetableRegs, nextDate)

    const classPage = await createPage(DS.classSession, {
      이름: { title: [{ text: { content: classPageTitle } }] },
      수업일시: { date: { start: startIso, end: endIso } },
      클래스: { relation: [{ id: classId }] },
      시간표: { relation: [{ id: timetableId }] },
      등록: { relation: registrationIds.map((id) => ({ id })) },
      ...(teacherIds.length ? { 담당강사: { relation: teacherIds.map((id) => ({ id })) } } : {}),
      // 아래에서 출석 생성이 끝나는 즉시 false로 해제된다 (markSessionDone/markSessionError).
      [PROP_SESSION_GEN_RUNNING]: { checkbox: true },
    })

    log.push(`[created] ${timetableName}: class session created (${nextDate}), 등록 ${registrationIds.length}건 연결`)
    await enqueueDashboardLink(classPage.id, log)

    // Perf (2026-09-11): attendance creation + pending-assignment-deadline linking for each
    // registration are independent of each other, so run them concurrently instead of
    // one-at-a-time — this matters most for classes with many students.
    try {
      await Promise.all(
        registrationIds.map(async (regId) => {
          // 학부모 요청 등으로 이 날짜의 수업이 생기기 전에 등록 페이지의 캘린더 탭에서 미리
          // 출석을 만들어둔 경우(결석 표시, 메모 등을 이미 적어둔 상태)가 있을 수 있다. 그런
          // 페이지가 있으면 새로 만들지 않고, 수업/클래스/수업일시(정확한 시간으로 보정)만 채워
          // 연결한다 -- fix-attendance(출석 조정 버튼)의 동일한 로직과 맞춤. 제목/출석 상태/메모
          // 등 사용자가 미리 적어둔 값은 그대로 보존한다.
          const { start, end } = dayRangeIso(nextDate)
          const unlinkedCandidates = await queryAllPages(DS.attendance, {
            and: [
              { property: "등록", relation: { contains: regId } },
              { property: "수업", relation: { is_empty: true } },
              { property: "수업일시", date: { on_or_after: start } },
              { property: "수업일시", date: { before: end } },
            ],
          })

          let attendanceId: string
          if (unlinkedCandidates.length > 0) {
            const candidate = unlinkedCandidates[0]
            await updatePageProperties(candidate.id, {
              수업: { relation: [{ id: classPage.id }] },
              클래스: { relation: [{ id: classId }] },
              수업일시: { date: { start: startIso, end: endIso } },
              // 2026-09-16 버그 수정: 시간표 -> 수업까지만 복사되던 담당강사가 출석에는
              // 전달되지 않고 있었음. 기존 미연결 출석을 새로 연결할 때도 담당강사를 채운다.
              ...(teacherIds.length ? { 담당강사: { relation: teacherIds.map((id) => ({ id })) } } : {}),
            })
            log.push(`[linked] ${timetableName}: existing unlinked attendance ${candidate.id} -> reg ${regId} (${nextDate})`)
            attendanceId = candidate.id
          } else {
            const attendancePage = await createPage(DS.attendance, {
              출석: { title: [{ text: { content: `${nextDate} 출석` } }] },
              수업일시: { date: { start: startIso, end: endIso } },
              수업: { relation: [{ id: classPage.id }] },
              클래스: { relation: [{ id: classId }] },
              등록: { relation: [{ id: regId }] },
              // 2026-09-16 버그 수정: 시간표의 담당강사를 출석 생성 시에도 함께 복사한다.
              ...(teacherIds.length ? { 담당강사: { relation: teacherIds.map((id) => ({ id })) } } : {}),
            })
            attendanceId = attendancePage.id
          }

          await enqueueDashboardLink(attendanceId, log)

          try {
            await linkPendingAssignmentDeadlines(regId, log)
          } catch (err) {
            log.push(`[error] linkPendingAssignmentDeadlines(${regId}): ${(err as Error).message}`)
          }
        }),
      )
    } catch (err) {
      // 출석 생성 중 하나라도 실패하면 이 수업 행의 "생성중"을 끄고 오류를 남긴 뒤 그대로 다시 던진다
      // (이 예외는 위쪽 호출부의 catch에서 markGenError로 시간표 쪽에도 기록된다 — 기존 동작 유지).
      await markSessionError(classPage.id, (err as Error).message)
      throw err
    }
    await markSessionDone(classPage.id)
    log.push(`  -> ${registrationIds.length} attendance record(s) created`)

    latestDate = nextDate
    createdCount++

    // Button (single) mode always creates exactly one session, then stops.
    if (mode.type === "single") break

    if (createdCount > 20) {
      // Safety valve to avoid a runaway loop.
      log.push(`[warn] ${timetableName}: stopped after creating 20 sessions in one call (check closures/data)`)
      break
    }
  }

  if (createdCount === 0 && horizonDate !== null) {
    log.push(`[ok] ${timetableName}: already has a session through ${horizonDate} (latest=${latestDate})`)
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Use POST", { status: 405 })
  }

  // (2026-09-21) 관리자 키 검증. Notion 버튼 자동화(수업추가/다음주 수업 일괄 생성)의 "웹훅 보내기"
  // 액션에 x-admin-key 헤더를 추가해서 호출해야 한다. 만약 Supabase 대시보드 쪽에 이 함수를 직접
  // 부르는 별도 pg_cron 등이 설정되어 있었다면, 그 호출도 이제 401을 받게 되므로 함께 헤더를
  // 추가해야 한다 (이 저장소 안에서는 그런 예약 호출을 찾지 못했다).
  const authError = await requireAdminKey(req)
  if (authError) return authError

  // "?mode=bulk" query param -> 메뉴(학원) DB의 "다음주 수업 일괄 생성" 버튼 call.
  // Checked via the URL (not the body) because Notion's webhook body for a button on the
  // 메뉴 DB will still contain *some* page id (the menu page's own id, under body.data.id /
  // body.page.id etc.), which would otherwise be mistaken for a single-timetable button call
  // by the candidate search below. mode=bulk always wins regardless of the body shape.
  const isBulkButton = new URL(req.url).searchParams.get("mode") === "bulk"

  // Read an optional timetableId from the request body.
  // - Present -> this is a button (manual, single-row) call.
  // - Absent (or body is not valid JSON) -> this is a cron (automatic, batch) call.
  //
  // NOTE: Notion's built-in "웹훅 보내기" automation action has no free-text JSON body
  // editor — it only lets you pick which page properties to attach (콘텐츠 checklist), and
  // Notion builds the actual JSON payload itself. So we can't rely on a literal
  // `{ "timetableId": ... }` shape; instead we look for the triggering page's id in every
  // place Notion is known to put it, plus the raw "웹훅ID" formula value as a fallback.
  let timetableId: string | undefined
  let rawBodyForLog: unknown
  try {
    const body = await req.json()
    rawBodyForLog = body
    const candidates: unknown[] = [
      body?.timetableId,
      body?.data?.id,
      body?.data?.page?.id,
      body?.page?.id,
      body?.id,
      body?.data?.properties?.["웹훅ID"]?.formula?.string,
      body?.properties?.["웹훅ID"]?.formula?.string,
    ]
    const found = candidates.find((c) => typeof c === "string" && c.length > 0)
    if (typeof found === "string") timetableId = found
  } catch {
    // no JSON body -> treat as a cron call
  }

  const log: string[] = []
  // Always record what we received, so the response log makes it easy to see the exact
  // payload shape Notion's webhook action sent (helpful for debugging button wiring).
  log.push(`[debug] parsed timetableId=${timetableId ?? "(none)"} rawBody=${JSON.stringify(rawBodyForLog)}`)

  if (isBulkButton) {
    // (0) 메뉴 DB "다음주 수업 일괄 생성" 버튼 call: scan ALL timetables and backfill sessions
    // through next week's same weekday (same horizon the daily cron keeps topped up), but
    // triggered manually. Respond immediately and do the real work in the background, since
    // Notion's button automation waits synchronously for the response and scanning every
    // timetable can easily exceed that wait limit.
    log.push(`[debug] bulk button call (mode=bulk) — ignoring any timetableId candidate from body`)

    // 이 버튼을 누른 메뉴(학원) DB 페이지의 id. Notion이 트리거 페이지 id를 넣는 위치는 시간표
    // 버튼과 동일하므로(위 candidates 탐색 결과), 여기서는 "시간표 id"가 아니라 "메뉴 페이지 id"로 재해석해서
    // 메뉴 DB 쪼에 새로 추가한 "생성중"/"마지막 오류" 진행상태 속성에 반영한다 (시간표 DB와 동일한 로직).
    const menuPageId = timetableId

    if (menuPageId) {
      let menuPage: any
      try {
        menuPage = await getPage(menuPageId)
      } catch (err) {
        console.error("generate-classes (bulk button): failed to load menu page:", (err as Error).message)
        return new Response(JSON.stringify({ ok: false, error: (err as Error).message }, null, 2), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
      }
      // 안전장치: 짧은 시간 안에 이 버튼이 여러 번 눌려도(더블클릭, 웹훅 재시도 등) 전체 스캔이
      // 중복으로 돌지 않도록, 이미 처리 중이면 새 요청은 즉시 반환한다 (단일 버튼 모드와 동일 로직).
      const currentlyRunning = menuPage.properties?.[PROP_TIMETABLE_GEN_RUNNING]?.checkbox === true
      if (currentlyRunning) {
        return new Response(JSON.stringify({ ok: true, message: "already_processing", mode: "bulk" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      await markGenRunning(menuPageId, true)
    }

    runInBackground(async () => {
      try {
        const timetables = await queryDataSource(DS.timetable, { page_size: 100 })

        // Week-completeness pre-pass (2026-09-11): find the earliest calendar week (Mon-Sun)
        // that at least one timetable is still missing a session for. This becomes the SHARED
        // horizon for this click, so timetables that already have extra weeks pre-made ahead
        // (for whatever reason) are left untouched this round -- while timetables still missing
        // that week get filled up to it. This makes every timetable's length converge together
        // instead of already-ahead ones running further ahead while behind ones never catch up.
        const peeked = await Promise.all(
          (timetables.results as any[]).map(async (t) => ({ id: t.id, nextNeeded: await peekNextNeededDate(t) })),
        )
        const needed = peeked.filter((p) => p.nextNeeded !== null) as Array<{ id: string; nextNeeded: string }>

        if (needed.length === 0) {
          log.push(`[ok] bulk: every timetable is already fully caught up, nothing to do`)
        } else {
          const targetWeekMonday = needed
            .map((p) => mondayOfWeek(p.nextNeeded))
            .reduce((min, cur) => (cur < min ? cur : min))
          const horizonDate = addDays(targetWeekMonday, 6) // Sunday of the earliest incomplete week
          log.push(`[debug] bulk: earliest incomplete week starts ${targetWeekMonday}, filling through ${horizonDate}`)

          // Perf (2026-09-11): process several timetables concurrently instead of strictly
          // one-at-a-time — this was the main reason a full-week bulk backfill across every
          // timetable took a long time.
          await mapWithConcurrency(timetables.results as any[], TIMETABLE_CONCURRENCY, async (timetable) => {
            const tId = timetable.id
            // 안전장치: 크론/버튼이 이미 처리 중인 시간표는 건너뛴다 (중복 생성 방지).
            const alreadyRunning = timetable.properties?.[PROP_TIMETABLE_GEN_RUNNING]?.checkbox === true
            if (alreadyRunning) {
              log.push(`[skip] ${tId}: already processing (생성중)`)
              return
            }
            await markGenRunning(tId, true)
            try {
              await processTimetable(timetable, log, { type: "until", horizonDate })
              await markGenDone(tId)
            } catch (err) {
              log.push(`[error] ${tId}: ${(err as Error).message}`)
              await markGenError(tId, (err as Error)?.message ?? String(err))
            }
          })
        }
        console.log("generate-classes (bulk button) finished:\n", log.join("\n"))
        if (menuPageId) await markGenDone(menuPageId)
      } catch (err) {
        console.error(
          "generate-classes (bulk button) failed:",
          (err as Error).message,
          "\nlog so far:",
          log.join("\n"),
        )
        if (menuPageId) await markGenError(menuPageId, (err as Error)?.message ?? String(err))
      }
    })

    return respondAccepted({ mode: "bulk" })
  }

  if (timetableId) {
    // (1) Button call: Notion's "웹훅 보내기" action waits synchronously for this response.
    // processTimetable() can take a while (여러 등록/출석 생성 + 과제 마감 백필), which can exceed
    // Notion's wait limit and show a "버튼 실행 실패: 웹훅 요청 시간이 초과되었습니다" alert even
    // though the work finishes successfully. So: respond immediately, and do the real work in
    // the background. Progress is visible via the timetable's "생성 상태" property.
    let timetable: any
    try {
      timetable = await getPage(timetableId)
    } catch (err) {
      console.error("generate-classes: failed to load timetable:", (err as Error).message)
      return new Response(JSON.stringify({ ok: false, error: (err as Error).message }, null, 2), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    }

    // 안전장치: 같은 시간표에 대해 버튼이 짧은 시간 안에 여러 번(더블클릭, 웹훅 재시도 등) 눌려도
    // 수업/출석이 중복 생성되지 않도록, 이미 처리 중이면 새 요청은 즉시 반환한다.
    const currentlyRunning = timetable.properties?.[PROP_TIMETABLE_GEN_RUNNING]?.checkbox === true
    if (currentlyRunning) {
      return new Response(JSON.stringify({ ok: true, message: "already_processing", timetableId }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    await markGenRunning(timetableId, true)

    runInBackground(async () => {
      try {
        await processTimetable(timetable, log, { type: "single" })
        console.log("generate-classes (button) finished:", timetableId, "\n", log.join("\n"))
        await markGenDone(timetableId)
      } catch (err) {
        console.error(
          "generate-classes (button) failed:",
          (err as Error).message,
          "\nlog so far:",
          log.join("\n"),
          "\nstack:",
          (err as Error).stack,
        )
        await markGenError(timetableId, (err as Error)?.message ?? String(err))
      }
    })

    return respondAccepted({ timetableId })
  }

  try {
    // (2) Cron call: all timetables, backfilled through next week's same weekday. This path is
    // not triggered by a Notion button waiting on the response, so it stays synchronous.
    // Mark each timetable's "생성중"/"마지막 오류" the same way the button/bulk-button paths
    // already do, so the "실시간 처리 상태" formula shows "🔄 생성 중" while a scheduled (cron)
    // run is in progress too — previously only the button paths updated this status, so a plain
    // automatic cron call never showed any live progress at all (2026-09-11 fix).
    const horizonDate = addDays(todayKstDateStr(), AUTO_HORIZON_DAYS)
    const timetables = await queryDataSource(DS.timetable, { page_size: 100 })
    // Perf (2026-09-11): same concurrency treatment as the bulk-button path above.
    await mapWithConcurrency(timetables.results as any[], TIMETABLE_CONCURRENCY, async (timetable) => {
      const tId = timetable.id
      const alreadyRunning = timetable.properties?.[PROP_TIMETABLE_GEN_RUNNING]?.checkbox === true
      if (alreadyRunning) {
        log.push(`[skip] ${tId}: already processing (생성중)`)
        return
      }
      await markGenRunning(tId, true)
      try {
        await processTimetable(timetable, log, { type: "until", horizonDate })
        await markGenDone(tId)
      } catch (err) {
        log.push(`[error] ${tId}: ${(err as Error).message}`)
        await markGenError(tId, (err as Error)?.message ?? String(err))
      }
    })
    return new Response(JSON.stringify({ ok: true, log }, null, 2), {
      headers: { "Content-Type": "application/json" },
    })
  } catch (err) {
    console.error("generate-classes failed:", (err as Error).message, "\nlog so far:", log.join("\n"), "\nstack:", (err as Error).stack)
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message, log }, null, 2), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
})

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
	PROP_TIMETABLE_LAST_ERROR,
	PROP_LAST_ERROR,
} from "../_shared/constants.ts"
// (2026-09-21, 처리 상태 관리 리팩토링 Phase 2) 시간표/메뉴 DB의 "생성중" 체크박스+마지막 오류
// 조합을 "상태"(select, 대기/작업중/완료/오류/타임아웃복구) + "처리 시작 시각"으로 교체. 마스터플랜:
// https://app.notion.com/p/903c90386c1d473494c5df6306c53517
// (2026-09-22, Phase 3) 수업(학원) DB 레벨(세션 단위)의 "생성중" 체크박스도 같은 방식(SESSION_GEN_STATUS_SPEC,
// 아래)으로 전환했다 — 이전엔 이 파일 자체에서 checkbox를 직접 썼다 (markSessionDone/Error).
import { markRunning, markDone, markError, isRunning, STATUS_RUNNING, type StatusSpec } from "../_shared/statusTracking.ts"

// 시간표(학원) DB와 메뉴(학원) DB 모두 "상태"/"마지막 오류"/"처리 시작 시각" 속성 이름이 동일하므로
// 하나의 스펙을 공유해서 쓴다 (버튼 단일/일괄/크론 세 경로 + 메뉴 페이지 모두 이 스펙 사용).
const TIMETABLE_STATUS_SPEC: StatusSpec = {
	statusProp: "상태",
	errorProp: PROP_TIMETABLE_LAST_ERROR,
	startedAtProp: "처리 시작 시각",
}

// 수업(학원) DB 세션 단위 "생성 상태" (2026-09-22, Phase 3로 전환). 각 함수 폴더는 독립적으로
// 배포되므로 다른 함수 폴더(status-watchdog 등)에서 이 파일을 직접 import하지 않는다 — 대신
// TIMETABLE_STATUS_SPEC과 같은 패턴으로, 워치독 쪽에 동일한 프로퍼티 이름 literal을 그대로 복제해뒀다.
const SESSION_GEN_STATUS_SPEC: StatusSpec = {
	statusProp: "생성 상태",
	errorProp: PROP_LAST_ERROR,
	startedAtProp: "생성 처리 시작 시각",
}
// 대시보드(학원) DB 자동 연결: 이 함수가 Notion API로 직접 만드는 수업/출석 페이지는 페이지
// 자동화가 트리거되지 않으므로, 생성 직후 여기서 직접 큐에 적재한다 (2026-09-20, 대시보드 기능 추가).
import { enqueueDashboardLink } from "../_shared/dashboardLinkTarget.ts"
// (2026-09-21, 인증 정책 추가) 이 함수는 지금까지 아무 인증도 없이 POST만 확인하면 누구나 호출할 수 있었다.
// 다른 어드민 함수들과 동일하게 x-admin-key 헤더를 요구해서, URL만 알면 전체 시간표를 강제로
// 재생성시킬 수 있었던 구멍을 막는다.
import { requireAdminKey } from "../_shared/adminShared.ts"
import {
	DS_TIMETABLE,
	DS_CLASS_SESSION,
	DS_CLASS,
	DS_ATTENDANCE,
	DS_REGISTRATION,
	DS_SCHEDULE_EVENT,
	DS_STUDY_ACTIVITY,
	DS_LEARNING_RECORD,
} from "../_shared/constants.ts"

// Data source IDs: 이제 하드코딩하지 않고 _shared/constants.ts(환경변수 기반 단일 소스)에서
// 가져온다 (2026-09-XX, 이식성 정리). 아래 함수 안에서는 기존과 동일하게 DS.xxx 형태로 쓴다.
const DS = {
  timetable: DS_TIMETABLE,
  classSession: DS_CLASS_SESSION,
  studentClass: DS_CLASS,
  attendance: DS_ATTENDANCE,
  registration: DS_REGISTRATION,
  scheduleEvent: DS_SCHEDULE_EVENT,
  studyActivity: DS_STUDY_ACTIVITY,
  learningRecord: DS_LEARNING_RECORD,
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

// 시간표/메뉴 DB에 처리 상태 표시 (버튼 단일/일괄 모드 + 크론 모드 공용).
// (2026-09-21, 처리 상태 관리 리팩토링 Phase 2) 예전엔 이 파일 안에 markGenRunning/markGenDone/
// markGenError 3개 함수가 체크박스+텍스트를 직접 썼는데, 이제 _shared/statusTracking.ts의
// markRunning/markDone/markError(TIMETABLE_STATUS_SPEC 사용)로 대체했다 — 동작은 동일하되
// "작업중"으로 바뀐 시각도 함께 기록해서, 워치독이 오래 멈춘 항목을 자동으로 회수할 수 있게 됐다.

// 수업(학원) DB 개별 행에 처리 상태 표시 (2026-09-11 추가, 2026-09-22 Phase 3에서 상태(select)
// 방식으로 전환). "생성 상태"는 세션 생성 시점에 이미 🔄 작업중으로 함께 만들어지므로(아래
// createPage 호출부 참고), 여기서는 "끝났을 때" markDone/markError(SESSION_GEN_STATUS_SPEC)만
// 감싸서 실패해도 전체 캐스케이드를 막지 않도록 조용히 무시한다.
async function markSessionDone(sessionId: string): Promise<void> {
  try {
    await markDone(sessionId, SESSION_GEN_STATUS_SPEC)
  } catch (err) {
    console.error(`markSessionDone(${sessionId}) failed:`, (err as Error).message)
  }
}

async function markSessionError(sessionId: string, message: string): Promise<void> {
  try {
    await markError(sessionId, SESSION_GEN_STATUS_SPEC, message)
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
      // 아래에서 출석 생성이 끝나는 즉시 markSessionDone/markSessionError로 완료/오류 처리된다.
      [SESSION_GEN_STATUS_SPEC.statusProp]: { select: { name: STATUS_RUNNING } },
      [SESSION_GEN_STATUS_SPEC.startedAtProp]: { date: { start: new Date().toISOString() } },
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
      // (이 예외는 위쪽 호출부의 catch에서 markError(TIMETABLE_STATUS_SPEC)로 시간표 쪽에도 기록된다 — 기존 동작 유지).
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

// [PART N-9, 2026-09-23] 시간표 일괄 처리(메뉴 "다음주 수업 일괄 생성" 버튼 + 크론)도
// PART N-8(send-selected-notifications)과 같은 "고정 청크 + 자기호출 이어달리기" 방식으로
// 바꾼다. 기존에는 전체 시간표를 mapWithConcurrency(concurrency=4)로 한 번에 다 돌렸는데,
// 시간표가 많거나 밀린 세션이 많으면 Supabase Edge Function의 플랫폼 실행시간 한도(150초,
// WallClockTime)를 넘겨 조용히 멈추는 사고가 실제로 있었다(2026-09-21, 그때는 fetch 타임아웃만
// 추가해서 임시 봉합했었음). 이제는 시간표 CHUNK_SIZE(10)개씩(내부적으로는 여전히
// TIMETABLE_CONCURRENCY=4로 병렬) 처리하고, 남은 시간표가 있으면 자기 자신을 다시 호출해
// 이어서 처리한다. "시간표 1개 처리"를 더 이상 쪼개지 않는 최소 단위로 둔다(processTimetable
// 자체가 이미 그 범위로 설계돼 있음 -- 백필 세션 여러 개 + 그 출석까지 한 번에 처리).
// 단일 시간표 버튼 호출(아래 (1))은 원래도 시간표 1개만 처리해서 안전하므로 그대로 둔다.
const FUNCTIONS_BASE = `${Deno.env.get("SB_URL") ?? ""}/functions/v1`
const CHUNK_SIZE = 10
// 보조 안전장치: 청크 처리가 유난히 느려지더라도 150초 강제종료보다 항상 먼저 스스로 멈추기 위한
// 청크 내부 시간 한도 (PART N-8과 동일한 값).
const CHUNK_TIME_BUDGET_MS = 100 * 1000
// 체인 전체(여러 번의 이어달리기 합산) 시간 한도 (PART N-8과 동일한 값/취지).
const TOTAL_CHAIN_BUDGET_MS = 30 * 60 * 1000
// 이 함수가 스스로를 다시 호출할 때 붙이는 표시. true면 사용자/크론이 새로 부른 게 아니라 체인의
// 다음 청크임을 뜻한다 (중복 실행 검사를 건너뛰고, 누적 진행 상황을 body로 이어받는다).
const CONTINUATION_FLAG = "isContinuation"
// 자기 자신 호출(callSelf)에 타임아웃이 전혀 없었다 -- 이 내부 fetch 하나가 응답 없이 멈추면
// 체인 전체가 영원히 멈출 수 있다. AbortController로 60초 제한을 건다 (PART N-8과 동일).
const FETCH_TIMEOUT_MS = 60_000
// [FIX, 2026-09-23] 실제로 재현된 문제: CHUNK_TIME_BUDGET_MS는 "다음 항목을 새로 시작하기 전"에만
// 확인해서, 이미 시작한 시간표 1개(processTimetable) 처리 자체가 오래 걸리면(노션 API가 느려져
// fetchWithRetry가 재시도를 반복하는 경우 이론상 한 번의 호출도 최대 3분 가까이 걸릴 수 있음)
// 그 청크 전체가 150초 강제종료에 걸려 조용히 죽고, 진행 중이던 시간표는 "작업중"에 영원히
// 멈춰버린다(이어달리기 자체가 일어날 기회조차 없음). 이제 시간표 1개당 대기 시간에도 자체
// 한도를 두고(남은 청크 예산을 넘지 않는 한도까지), 넘으면 그 시간표는 그냥 넘어가서 나머지
// 항목들과 청크 마무리(이어달리기 호출)가 반드시 150초 안에 끝나도록 만든다.
const PER_ITEM_TIMEOUT_MS = 45_000

// Promise.race 기반 타임아웃 래퍼로 실패(타임아웃)와 원래 오류를 구분한다. 주의: 실제로 이
// promise를 취소하지는 못한다(Notion API 호출 자체는 백그라운드에서 계속 진행될 수 있음) --
// 다만 그 결과를 더 이상 기다리지 않고 호출부(worker 루프)가 제어권을 돌려받게 해서, 청크가
// 정해진 시간 안에 반드시 마무리(이어달리기 또는 완료 처리)되도록 하는 데에만 쓴다.
class TimeoutError extends Error {}
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`${label}: ${ms}ms 안에 끝나지 않음`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

async function callSelf(body: Record<string, unknown>, adminKey: string, bulkMode: boolean): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    // isBulkButton은 URL의 "?mode=bulk" 쿼리로만 판별하므로(아래 Deno.serve 참고), bulk 체인의
    // 이어달리기 호출도 같은 쿼리를 그대로 붙여야 다시 bulk 경로로 들어간다.
    const url = `${FUNCTIONS_BASE}/generate-classes${bulkMode ? "?mode=bulk" : ""}`
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

// 시간표 id 목록(최대 CHUNK_SIZE개) 하나를 TIMETABLE_CONCURRENCY만큼 동시에 처리한다. 도중에
// budgetMs를 넘기면, 아직 시작하지 못한 나머지는 처리하지 않고 그대로 돌려줘서(deferredIds)
// 다음 이어달리기가 이어서 처리하게 한다 (150초 강제종료보다 항상 먼저 멈추기 위함).
async function processTimetablesChunk(
  ids: string[],
  timetableById: Map<string, any>,
  mode: ProcessMode,
  concurrency: number,
  budgetMs: number,
  log: string[],
): Promise<{ okCount: number; errorCount: number; timeoutCount: number; deferredIds: string[] }> {
  const startedAt = Date.now()
  let nextIndex = 0
  let okCount = 0
  let errorCount = 0
  let timeoutCount = 0
  const deferredIds: string[] = []

  async function worker() {
    while (true) {
      const remaining = budgetMs - (Date.now() - startedAt)
      if (remaining <= 0) {
        // JS는 단일 스레드라 이 while 루프 안에 await가 없으므로, 먼저 이 분기에 들어온 워커가
        // 나머지를 전부 deferredIds로 옮길 때까지 다른 워커가 끼어들 수 없다 (중복/누락 없음).
        while (nextIndex < ids.length) deferredIds.push(ids[nextIndex++])
        return
      }
      if (nextIndex >= ids.length) return
      const id = ids[nextIndex++]
      const timetable = timetableById.get(id)
      if (!timetable) {
        log.push(`[skip] ${id}: 시간표를 찾지 못함(삭제됐거나 목록에서 빠짐)`)
        continue
      }
      const alreadyRunning = isRunning(timetable, TIMETABLE_STATUS_SPEC)
      if (alreadyRunning) {
        log.push(`[skip] ${id}: already processing (생성중)`)
        continue
      }
      await markRunning(id, TIMETABLE_STATUS_SPEC)
      // [FIX, 2026-09-23] 남은 청크 예산을 넘지 않는 한도까지만 이 시간표 하나를 기다린다 (자세한
      // 배경은 PER_ITEM_TIMEOUT_MS 주석 참고).
      const perItemTimeoutMs = Math.min(PER_ITEM_TIMEOUT_MS, remaining)
      try {
        await withTimeout(processTimetable(timetable, log, mode), perItemTimeoutMs, `${id} 처리`)
        await markDone(id, TIMETABLE_STATUS_SPEC)
        okCount++
      } catch (err) {
        if (err instanceof TimeoutError) {
          // 타임아웃이면 상태를 일부러 그대로 "작업중"으로 남겨둔다 -- markDone/markError로 바꿔
          // 버리면, 실제로는 아직 백그라운드에서 계속 진행 중일 수 있는 원래 처리와 동시에 다음
          // 시도가 같은 시간표를 다시 집어서 중복 생성을 시도할 위험이 있다(원래 처리는 정말로
          // 취소된 게 아니라 "더 기다리지 않기"만 한 것이므로). "작업중"으로 남아있으면 다음
          // 시도는 isRunning() 검사에서 건너뛰고, 15분 워치독이 결국 회수해서 다시 시도할 수
          // 있게 해준다.
          timeoutCount++
          log.push(`[timeout] ${id}: ${perItemTimeoutMs}ms 안에 끝나지 않아 다음 항목으로 넘어감 (상태는 작업중으로 유지, 워치독이 나중에 회수)`)
        } else {
          errorCount++
          log.push(`[error] ${id}: ${(err as Error).message}`)
          await markError(id, TIMETABLE_STATUS_SPEC, (err as Error)?.message ?? String(err))
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()))
  return { okCount, errorCount, timeoutCount, deferredIds }
}

type ChainState = {
  runMode: "bulk" | "cron"
  horizonDate: string
  remainingIds: string[]
  chainStartedAt: number
  okCountAcc: number
  errorCountAcc: number
  timeoutCountAcc: number
  menuPageId: string | null
}

// 한 청크(최대 CHUNK_SIZE개)를 처리하고, 남았으면 자기 자신을 다시 호출해 이어간다. bulk/cron
// 양쪽 경로가 이 함수 하나를 공유한다 (초기 horizonDate/remainingIds 계산 방식만 서로 다르고,
// 그 이후 "청크 처리 -> 남았으면 이어달리기" 로직은 완전히 동일하다).
async function runChainStep(state: ChainState, adminKey: string, log: string[]): Promise<void> {
  // 매 청크(최초 호출 + 모든 이어달리기)마다 최신 시간표 목록을 다시 조회한다 (100건 이하 소규모
  // 쿼리라 비용이 크지 않고, isRunning 등 상태를 항상 최신으로 보게 된다 -- PART N-8이
  // queryPagesLimited로 매 청크 다시 조회하는 것과 같은 취지).
  const timetables = await queryDataSource(DS.timetable, { page_size: 100 })
  const timetableById = new Map<string, any>((timetables.results as any[]).map((t) => [t.id, t]))

  const chunkIds = state.remainingIds.slice(0, CHUNK_SIZE)
  const restIds = state.remainingIds.slice(CHUNK_SIZE)

  const { okCount, errorCount, timeoutCount, deferredIds } = await processTimetablesChunk(
    chunkIds,
    timetableById,
    { type: "until", horizonDate: state.horizonDate },
    TIMETABLE_CONCURRENCY,
    CHUNK_TIME_BUDGET_MS,
    log,
  )

  const newRemainingIds = [...deferredIds, ...restIds]
  const newOkAcc = state.okCountAcc + okCount
  const newErrorAcc = state.errorCountAcc + errorCount
  const newTimeoutAcc = state.timeoutCountAcc + timeoutCount

  console.log(
    `generate-classes (${state.runMode}) chunk finished (남은 ${newRemainingIds.length}건):\n`,
    log.join("\n"),
  )

  if (newRemainingIds.length === 0) {
    if (state.menuPageId) await markDone(state.menuPageId, TIMETABLE_STATUS_SPEC)
    console.log(
      `generate-classes (${state.runMode}) ALL finished. 처리 ${newOkAcc}건, 오류 ${newErrorAcc}건, 타임아웃(재시도 대기) ${newTimeoutAcc}건.`,
    )
    return
  }

  const elapsedChain = Date.now() - state.chainStartedAt
  if (elapsedChain > TOTAL_CHAIN_BUDGET_MS) {
    const message = `전체 처리 한도(${Math.round(TOTAL_CHAIN_BUDGET_MS / 60000)}분) 초과로 중단됨. 처리 ${newOkAcc}건, 오류 ${newErrorAcc}건, 타임아웃 ${newTimeoutAcc}건, 남은 시간표 ${newRemainingIds.length}건. ${state.runMode === "bulk" ? "버튼을 다시 눌러 이어서 진행하세요." : "다음 크론 호출에서 이어서 진행됩니다."}`
    console.error(`generate-classes (${state.runMode}): ${message}`)
    if (state.menuPageId) await markError(state.menuPageId, TIMETABLE_STATUS_SPEC, message)
    return
  }

  if (state.menuPageId) {
    await updatePageProperties(state.menuPageId, {
      [PROP_TIMETABLE_LAST_ERROR]: {
        rich_text: [
          {
            text: {
              content: `🔄 진행 중... (남은 시간표 ${newRemainingIds.length}건, 처리 ${newOkAcc}·오류 ${newErrorAcc}·타임아웃 ${newTimeoutAcc})`,
            },
          },
        ],
      },
    }).catch(() => {})
  }

  // 자기 자신을 다시 호출해 다음 청크를 이어서 처리한다. 이 fetch는 호출된 쪽의 빠른 202 응답까지만
  // 기다린다 -- 실제 다음 청크 처리는 그 호출 자신의 백그라운드에서 진행되므로 오래 걸리지 않는다
  // (callSelf의 60초 타임아웃은 그래도 안전망으로 남겨둔다).
  const continueRes = await callSelf(
    {
      [CONTINUATION_FLAG]: true,
      runMode: state.runMode,
      horizonDate: state.horizonDate,
      remainingIds: newRemainingIds,
      chainStartedAt: state.chainStartedAt,
      okCountAcc: newOkAcc,
      errorCountAcc: newErrorAcc,
      timeoutCountAcc: newTimeoutAcc,
      menuPageId: state.menuPageId,
    },
    adminKey,
    state.runMode === "bulk",
  )
  if (!continueRes.ok) {
    const text = await continueRes.text().catch(() => "")
    throw new Error(`다음 이어달리기 호출 실패: ${continueRes.status} ${text}`)
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
  let parsedBody: any
  try {
    const body = await req.json()
    parsedBody = body
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

  // [PART N-9] 이 함수가 스스로를 다시 호출한 이어달리기 요청인지 여부. bulk/cron 두 체인 모두
  // 이 플래그로 판별한다 (아래 isBulkButton 분기에서는 URL의 "?mode=bulk"도 함께 확인한다).
  const isContinuation = parsedBody?.[CONTINUATION_FLAG] === true
  // 이어달리기 자기호출에 그대로 재사용할 관리자 키. requireAdminKey가 이미 이 값을 검증했다.
  const adminKeyForChain = req.headers.get("x-admin-key") ?? ""

  const log: string[] = []
  // Always record what we received, so the response log makes it easy to see the exact
  // payload shape Notion's webhook action sent (helpful for debugging button wiring).
  log.push(
    `[debug] parsed timetableId=${timetableId ?? "(none)"} isContinuation=${isContinuation} rawBody=${JSON.stringify(parsedBody)}`,
  )

  if (isBulkButton) {
    // (0) 메뉴 DB "다음주 수업 일괄 생성" 버튼 call.
    log.push(`[debug] bulk button call (mode=bulk) — ignoring any timetableId candidate from body`)

    if (isContinuation) {
      // 이어달리기 호출은 사용자가 새로 누른 게 아니므로, 중복 실행 검사 없이 body로 이어받은
      // 상태 그대로 다음 청크를 처리한다.
      const menuPageId = parsedBody?.menuPageId ?? null
      // [FIX, 2026-09-23] 이 이어달리기 호출에서도 메뉴 페이지의 "처리 시작 시각"을 갱신해야
      // 한다 -- PART N-8과 동일한 이유(체인이 15분 워치독 한도보다 길어질 수 있는데, 최초
      // 호출에서만 markRunning을 부르면 워치독이 멀쩍이 진행 중인 체인을 죽은 것으로 착각해
      // "⏱️ 타임아웃 복구"로 되돌려버릴 수 있음). 원래 이 이어달리기 분기에서 빠져있었다.
      if (menuPageId) await markRunning(menuPageId, TIMETABLE_STATUS_SPEC)
      runInBackground(async () => {
        try {
          await runChainStep(
            {
              runMode: "bulk",
              horizonDate: String(parsedBody?.horizonDate ?? ""),
              remainingIds: Array.isArray(parsedBody?.remainingIds) ? parsedBody.remainingIds : [],
              chainStartedAt: typeof parsedBody?.chainStartedAt === "number" ? parsedBody.chainStartedAt : Date.now(),
              okCountAcc: typeof parsedBody?.okCountAcc === "number" ? parsedBody.okCountAcc : 0,
              errorCountAcc: typeof parsedBody?.errorCountAcc === "number" ? parsedBody.errorCountAcc : 0,
              timeoutCountAcc: typeof parsedBody?.timeoutCountAcc === "number" ? parsedBody.timeoutCountAcc : 0,
              menuPageId,
            },
            adminKeyForChain,
            log,
          )
        } catch (err) {
          console.error(
            "generate-classes (bulk button, continuation) failed:",
            (err as Error).message,
            "\nlog so far:",
            log.join("\n"),
          )
          if (menuPageId) await markError(menuPageId, TIMETABLE_STATUS_SPEC, (err as Error)?.message ?? String(err))
        }
      })
      return respondAccepted({ mode: "bulk", isContinuation: true })
    }

    // 이 버튼을 누른 메뉴(학원) DB 페이지의 id. Notion이 트리거 페이지 id를 넣는 위치는 시간표
    // 버튼과 동일하므로(위 candidates 탐색 결과), 여기서는 "시간표 id"가 아니라 "메뉴 페이지 id"로 재해석해서
    // 메뉴 DB 쪼에 새로 추가한 "생성중"/"마지막 오류" 진행상태 속성에 반영한다 (시간표 DB와 동일한 로직).
    const menuPageId = timetableId ?? null

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
      const currentlyRunning = isRunning(menuPage, TIMETABLE_STATUS_SPEC)
      if (currentlyRunning) {
        return new Response(JSON.stringify({ ok: true, message: "already_processing", mode: "bulk" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      await markRunning(menuPageId, TIMETABLE_STATUS_SPEC)
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
          console.log("generate-classes (bulk button) finished:\n", log.join("\n"))
          if (menuPageId) await markDone(menuPageId, TIMETABLE_STATUS_SPEC)
          return
        }

        const targetWeekMonday = needed
          .map((p) => mondayOfWeek(p.nextNeeded))
          .reduce((min, cur) => (cur < min ? cur : min))
        const horizonDate = addDays(targetWeekMonday, 6) // Sunday of the earliest incomplete week
        log.push(`[debug] bulk: earliest incomplete week starts ${targetWeekMonday}, filling through ${horizonDate}`)

        // [PART N-9] 여기서부터는 10개씩 청크로 나눠 처리하고, 남으면 자기 자신을 다시 호출해
        // 이어간다 (기존의 "전체를 한 번에 mapWithConcurrency" 방식은 시간표/밀린 세션이 많을 때
        // 150초 플랫폼 한도를 넘겨 조용히 멈추는 사고가 있었다).
        const allIds = (timetables.results as any[]).map((t) => t.id)
        await runChainStep(
          {
            runMode: "bulk",
            horizonDate,
            remainingIds: allIds,
            chainStartedAt: Date.now(),
            okCountAcc: 0,
            errorCountAcc: 0,
            timeoutCountAcc: 0,
            menuPageId,
          },
          adminKeyForChain,
          log,
        )
      } catch (err) {
        console.error(
          "generate-classes (bulk button) failed:",
          (err as Error).message,
          "\nlog so far:",
          log.join("\n"),
        )
        if (menuPageId) await markError(menuPageId, TIMETABLE_STATUS_SPEC, (err as Error)?.message ?? String(err))
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
    const currentlyRunning = isRunning(timetable, TIMETABLE_STATUS_SPEC)
    if (currentlyRunning) {
      return new Response(JSON.stringify({ ok: true, message: "already_processing", timetableId }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    await markRunning(timetableId, TIMETABLE_STATUS_SPEC)

    runInBackground(async () => {
      try {
        await processTimetable(timetable, log, { type: "single" })
        console.log("generate-classes (button) finished:", timetableId, "\n", log.join("\n"))
        await markDone(timetableId, TIMETABLE_STATUS_SPEC)
      } catch (err) {
        console.error(
          "generate-classes (button) failed:",
          (err as Error).message,
          "\nlog so far:",
          log.join("\n"),
          "\nstack:",
          (err as Error).stack,
        )
        await markError(timetableId, TIMETABLE_STATUS_SPEC, (err as Error)?.message ?? String(err))
      }
    })

    return respondAccepted({ timetableId })
  }

  // (2) Cron call: all timetables, backfilled through next week's same weekday.
  // [PART N-9, 2026-09-23] 예전엔 이 경로가 동기(응답을 끝까지 기다림)였다 -- 이 함수를 부르는
  // 예약 호출이 Notion 버튼처럼 응답을 기다리는 대상이 아니라고 판단했기 때문. 하지만 시간표가
  // 많거나 밀린 세션이 많으면 이 동기 처리 자체가 Supabase Edge Function의 플랫폼 실행시간
  // 한도(150초, WallClockTime)를 넘겨 조용히 멈추는 사고가 실제로 있었다(2026-09-21). 이제는
  // 버튼/bulk 경로와 동일하게 즉시 202로 응답하고, 실제 처리는 백그라운드의 청크+이어달리기로
  // 진행한다. (이 저장소 안에서는 이 함수를 자동으로 호출하는 예약 작업을 찾지 못했다 -- Supabase
  // 대시보드에만 설정된 숨은 호출일 가능성이 있다. 그 호출이 응답 본문의 log를 읽고 있었다면 이제는
  // 더 이상 유효하지 않으니 확인이 필요하다.)
  if (isContinuation) {
    runInBackground(async () => {
      try {
        await runChainStep(
          {
            runMode: "cron",
            horizonDate: String(parsedBody?.horizonDate ?? ""),
            remainingIds: Array.isArray(parsedBody?.remainingIds) ? parsedBody.remainingIds : [],
            chainStartedAt: typeof parsedBody?.chainStartedAt === "number" ? parsedBody.chainStartedAt : Date.now(),
            okCountAcc: typeof parsedBody?.okCountAcc === "number" ? parsedBody.okCountAcc : 0,
            errorCountAcc: typeof parsedBody?.errorCountAcc === "number" ? parsedBody.errorCountAcc : 0,
            timeoutCountAcc: typeof parsedBody?.timeoutCountAcc === "number" ? parsedBody.timeoutCountAcc : 0,
            menuPageId: null,
          },
          adminKeyForChain,
          log,
        )
      } catch (err) {
        console.error(
          "generate-classes (cron, continuation) failed:",
          (err as Error).message,
          "\nlog so far:",
          log.join("\n"),
        )
      }
    })
    return respondAccepted({ mode: "cron", isContinuation: true })
  }

  const horizonDate = addDays(todayKstDateStr(), AUTO_HORIZON_DAYS)
  runInBackground(async () => {
    try {
      const timetables = await queryDataSource(DS.timetable, { page_size: 100 })
      const allIds = (timetables.results as any[]).map((t) => t.id)
      await runChainStep(
        {
          runMode: "cron",
          horizonDate,
          remainingIds: allIds,
          chainStartedAt: Date.now(),
          okCountAcc: 0,
          errorCountAcc: 0,
          timeoutCountAcc: 0,
          menuPageId: null,
        },
        adminKeyForChain,
        log,
      )
    } catch (err) {
      console.error("generate-classes (cron) failed:", (err as Error).message, "\nlog so far:", log.join("\n"), "\nstack:", (err as Error).stack)
    }
  })
  return respondAccepted({ mode: "cron" })
})

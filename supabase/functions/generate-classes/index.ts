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
	withTimeout,
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
import {
	markRunning,
	markDone,
	markError,
	markQueued,
	isRunning,
	STATUS_RUNNING,
	STATUS_QUEUED,
	type StatusSpec,
} from "../_shared/statusTracking.ts"

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
// (2026-09-24, PART N-12 후속 3차) 아래 processTimetable()이 세션/출석 페이지를 만들 때마다
// enqueueDashboardLink를 호출하는데, 매번 워커까지 깨우면(기본값) 학생 수만큼(예: 15명 반이면
// 세션 1 + 출석 15 = 16번) 배경 HTTP 호출이 같은 순간에 겹쳐 몰린다 -- 이건 9/23 2b79f1c에서 이미
// 한 번 고쳤던 문제인데, 오늘 9/22로 롤백하면서 그 커밋도 함께 날아갔었다. skipWake:true로 큐
// 적재만 반복하고, processTimetable() 호출 하나가 끝날 때 딱 한 번만 깨운다 (아래 wakeSyncQueueWorker
// 호출부 참고).
import { wakeSyncQueueWorker } from "../_shared/syncQueue.ts"
// (2026-09-21, 인증 정책 추가) 이 함수는 지금까지 아무 인증도 없이 POST만 확인하면 누구나 호출할 수 있었다.
// 다른 어드민 함수들과 동일하게 x-admin-key 헤더를 요구해서, URL만 알면 전체 시간표를 강제로
// 재생성시킬 수 있었던 구멍을 막는다.
import { requireAdminKey, getCurrentAdminKey } from "../_shared/adminShared.ts"
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

// (2026-09-24, PART N-12 후속) fetchWithRetry는 호출 하나하나에는 타임아웃(12초, 최대 5회 재시도)이
// 걸려 있지만, processTimetable() 한 번의 실행 안에는 그런 호출이 순서대로(닫힌기간/클래스정보/등록
// 목록 조회 + 주차마다 세션/출석 생성) 여러 번 들어있다. 개별 호출은 각자 자기 한도 안에서 "정상적으로"
// 재시도하며 시간을 쓰더라도, 합치면 여전히 150초 플랫폼 한도를 넘길 수 있다 (실측: 09/23
// backfill-attendance에서 같은 패턴 재현됨 — cpu_time_used는 0.5초 수준으로 낮은데 wall clock은
// 150초를 다 씀 -- 즉 거의 전부 네트워크 대기/재시도였다는 뜻). 그래서 processTimetable() 호출
// 전체를 withTimeout으로 감싸서, 이 예산을 넘기면 호출부가 기다리지 않고 포기하고 돌아간다.
const PROCESS_TIMETABLE_TIMEOUT_MS = 100_000

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
  // (2026-09-24, PART N-12 후속 4차, 사용자 설계 반영) 시간 예산을 재는 대신, 이 호출은 애초에
  // "세션 1개 + 그 출석들"만 만들고 끝나도록 범위 자체를 작게 고정한다 -- 넘겨받은 데이터(등록
  // 목록 등)가 이미 다 정해져 있어서 각 단위 작업의 크기가 작고 고정돼 있으므로, 시간 초과가
  // 구조적으로 생길 이유가 없다. 아직 더 만들 날짜가 남아있으면 done:false를 반환해서 호출부가
  // 이 시간표를 다시 "대기열"에 넣고, 다음 체인 스텝이 최신 latestDate 기준으로 이어서 만들게
  // 한다 (한 주씩 이어달리기). single/cron 호출 경로는 이 반환값을 그냥 무시하므로 동작이 그대로다.
  const baseDate = latestDate ? addDays(latestDate, 1) : today
  const nextDate = findNextClassDate(baseDate, weekday, closures)

  // Cron/extend mode: don't create a session that falls beyond horizonDate.
  const withinHorizon = horizonDate === null || nextDate <= horizonDate

  // Cron mode ONLY: if the next missing session is TODAY's, wait until this timetable's
  // configured "자동생성 시간" (generation time-of-day) before creating it. This only gates
  // today's date -- past catch-up dates and future dates within the horizon are created
  // immediately regardless of time-of-day. Manual clicks (single/extend) skip this gate --
  // an explicit user click should create today's session right away (2026-09-11).
  const gatedByGenerationTime =
    mode.type === "until" && nextDate === today && generationTime > nowKstTimeStr()
  if (gatedByGenerationTime) {
    log.push(
      `[wait] ${timetableName}: today's session (${nextDate}) scheduled for ${generationTime}, now is ${nowKstTimeStr()}`,
    )
  }

  if (withinHorizon && !gatedByGenerationTime) {
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
    await enqueueDashboardLink(classPage.id, log, { skipWake: true })

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

          await enqueueDashboardLink(attendanceId, log, { skipWake: true })

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
  }

  if (createdCount === 0 && horizonDate !== null && !gatedByGenerationTime) {
    log.push(`[ok] ${timetableName}: already has a session through ${horizonDate} (latest=${latestDate})`)
  }

  // (2026-09-24, PART N-12 후속 3차) 위에서 만든 세션/출석 페이지들은 모두 skipWake:true로 큐에만
  // 적재했으니, 이 호출 전체가 끝난 지금 딱 한 번만 워커를 깨운다 (아무것도 안 만들었으면 깨울
  // 필요도 없음). single/bulk체인/크론 세 경로 모두 이 함수를 통해서만 페이지를 만들므로, 여기
  // 한 곳에만 추가하면 세 경로 전부 동일하게 "호출 하나당 wake 최대 1건"이 보장된다.
  if (createdCount > 0) wakeSyncQueueWorker()

  // (PART N-12 후속 4차) 이 시간표에 아직 더 만들 날짜가 남아있는지 미리보기(다음 날짜 하나만
  // 계산 -- DB 스캔 아니고 이미 메모리에 있는 closures/weekday로 순수 계산)한다. mode.type이
  // "until"이고 방금 세션을 만들었을 때만 의미가 있다 (single 모드/아무것도 안 만든 경우는 호출부가
  // 반환값을 안 쓰거나 이미 끝난 것으로 취급).
  let moreNeeded = false
  if (mode.type === "until" && createdCount > 0) {
    const followingBase = addDays(latestDate!, 1)
    const followingDate = findNextClassDate(followingBase, weekday, closures)
    moreNeeded = followingDate <= horizonDate!
  }

  return { done: !moreNeeded }
}

// (2026-09-24, PART N-12: 일괄 생성 버튼을 "대기중 상태 + 순차 이어달리기" 체인으로 재설계)
// 예전(mapWithConcurrency로 여러 시간표를 동시에 처리)에는, 시간표마다 딸려나오는 대시보드 연결
// 즉시-트리거(enqueueDashboardLink 내부의 wakeSyncQueueWorker)가 같은 순간에 몰려서 Supabase
// 자체 요청빈도 제한("Rate limit exceeded")에 걸리고, 그 여파(재시도/대기)로 전체 실행이 플랫폼
// 시간 한도(150초, WallClockTime)에 걸려 강제종료되는 사고가 실제로 재현됐다 (Supabase 함수 로그
// 실측: cpu_time_used=309ms인데 wall clock은 정확히 150000ms -- 거의 전부 "대기"만 하다가
// 죽었다는 뜻). 강제종료되면 그 시점에 이미 "작업중"으로 표시해둔 시간표들은 완료/오류 처리를
// 못 받고 영원히 "작업중"인 채로 멈춰버린다.
//
// 이제는 send-selected-notifications(PART N-8)와 동일한 패턴으로: (1) 이번에 처리가 필요한
// 시간표를 전부 "⏳ 대기열"로 표시만 해두고 (빠른 Notion 쓰기, 무거운 작업 없음), (2) 한 번에
// 딱 1개만 실제로 처리(세션/출석 생성 로직 자체는 그대로)한 뒤, (3) 자기 자신을 다시 호출해
// 다음 1개로 이어간다. 이렇게 하면 대시보드 연결 트리거가 항상 한 번에 하나씩만 나가므로 위
// 레이트리밋 폭주가 구조적으로 불가능해지고, 매 호출이 시간표 1개 분량이라 150초 벽에도 걸리지
// 않는다.
const BULK_CHAIN_TOTAL_BUDGET_MS = 30 * 60 * 1000 // 30분 -- 극단적으로 많이 밀려있는 경우의 최후 안전장치.
const BULK_SELF_CALL_TIMEOUT_MS = 60_000 // 자기호출(다음 시간표로 이어달리기) 자체가 응답 없이 멈추는 것을 방지.
const FUNCTIONS_BASE = `${Deno.env.get("SB_URL") ?? ""}/functions/v1`

// (2026-09-24, PART N-12 후속 5차 버그 수정) 이 함수가 체인을 이어가는 유일한 연결고리인데,
// 지금까지 fetch()의 응답 상태(response.ok)를 전혀 확인하지 않았다 -- Supabase 자체 함수
// 호출 레이트리밋(429)이나 순간적인 오류로 이 자기호출이 거부돼도, fetch() 자체는 "정상적으로"
// resolve되므로(예외를 던지지 않음) 호출부가 이를 성공으로 착각하고 그대로 끝나버렸다. 그러면
// 체인이 아무 오류도 남기지 않고 조용히 멈춰서(대기열은 남아있는데 아무것도 진행 중이지 않은
// 상태), 사용자가 버튼을 다시 눌러야만 재개되는 문제가 실제로 관찰됐다. 상태 코드를 확인하고,
// 실패하면 짧게 재시도(레이트리밋은 금방 풀리는 것으로 이미 확인됨)한 뒤, 그래도 안 되면 던져서
// 호출부의 markError 경로가 확실히 남게 한다.
async function callSelf(body: Record<string, unknown>, adminKey: string): Promise<void> {
  const maxAttempts = 3
  let lastErr: Error | undefined
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), BULK_SELF_CALL_TIMEOUT_MS)
    try {
      const res = await fetch(`${FUNCTIONS_BASE}/generate-classes?mode=bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (res.ok) return
      lastErr = new Error(`이어달리기 자기호출 실패: HTTP ${res.status} ${await res.text()}`)
    } catch (err) {
      lastErr = err as Error
    } finally {
      clearTimeout(timeoutId)
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt))) // 1s, 2s
    }
  }
  throw lastErr ?? new Error("이어달리기 자기호출 실패: 알 수 없는 오류")
}

// 일괄 생성 체인의 한 단계: "⏳ 대기열"인 시간표를 딱 1개 찾아 처리하고, 끝나면 다음 단계로
// 이어달리기(또는 더 없으면 종료)한다. 초기 클릭(runInBackground 안)과 이어달리기 요청
// (isContinuation) 양쪽에서 공용으로 호출된다.
async function runBulkChainStep(opts: {
  menuPageId?: string
  horizonDate: string
  chainStartedAt: number
  adminKey: string
  log: string[]
}): Promise<void> {
  const { menuPageId, horizonDate, chainStartedAt, adminKey, log } = opts

  if (Date.now() - chainStartedAt > BULK_CHAIN_TOTAL_BUDGET_MS) {
    log.push(`[warn] bulk chain: 전체 시간 한도(30분)를 초과해 중단함 -- 남은 시간표는 버튼을 다시 눌러 이어서 처리해주세요`)
    console.error("generate-classes (bulk chain) 시간 한도 초과:\n", log.join("\n"))
    if (menuPageId) {
      await markError(
        menuPageId,
        TIMETABLE_STATUS_SPEC,
        "일괄 생성 체인이 30분 한도를 초과해 중단됨 (남은 시간표는 다시 버튼을 눌러 이어서 처리)",
      )
    }
    return
  }

  let queued: any
  try {
    queued = await queryDataSource(DS.timetable, {
      page_size: 1,
      filter: { property: "상태", select: { equals: STATUS_QUEUED } },
    })
  } catch (err) {
    log.push(`[error] bulk chain: 대기열 조회 실패: ${(err as Error).message}`)
    console.error("generate-classes (bulk chain) 대기열 조회 실패:\n", log.join("\n"))
    if (menuPageId) await markError(menuPageId, TIMETABLE_STATUS_SPEC, (err as Error).message)
    return
  }

  const next = (queued.results as any[])[0]
  if (!next) {
    // 더 이상 대기중인 시간표가 없음 -> 체인 종료.
    console.log("generate-classes (bulk button) finished:\n", log.join("\n"))
    if (menuPageId) await markDone(menuPageId, TIMETABLE_STATUS_SPEC)
    return
  }

  const tId = next.id
  await markRunning(tId, TIMETABLE_STATUS_SPEC)
  const timeoutLabel = `processTimetable(${tId})`
  try {
    const result = await withTimeout(
      processTimetable(next, log, { type: "until", horizonDate }),
      PROCESS_TIMETABLE_TIMEOUT_MS,
      timeoutLabel,
    )
    if (result && result.done === false) {
      // (PART N-12) 이번 스텝의 시간 예산 안에 이 시간표를 다 못 따라잡음 -- "완료" 대신 다시
      // "대기열"로 표시해서 다음 체인 스텝이 이어서 처리하게 한다 (무한루프 걱정 없음: 매 스텝마다
      // 최소 1건은 만들고 멈추므로 항상 앞으로 나아간다).
      log.push(`[requeue] ${tId}: 시간 예산 초과로 이번 스텝은 일부만 처리, 다시 대기열에 넣음`)
      await markQueued(tId, TIMETABLE_STATUS_SPEC)
    } else {
      await markDone(tId, TIMETABLE_STATUS_SPEC)
    }
  } catch (err) {
    const isTimeout = ((err as Error)?.message ?? "").includes(`${timeoutLabel}: 시간 제한(`)
    if (isTimeout) {
      // (PART N-12 후속) 개별 Notion API 호출은 각자 재시도하며(12초 x 최대 5회) 시간을 쓰다가
      // 합쳐서 예산을 넘긴 것일 수 있다 -- 실제 처리 오류가 아닐 수 있으므로 "오류"로 남기지 않고
      // 다시 "대기열"에 넣는다 (다음 스텝은 latestDate 기준으로 자동으로 이어서 재개됨).
      log.push(`[requeue] ${tId}: withTimeout(${PROCESS_TIMETABLE_TIMEOUT_MS}ms) 초과, 다시 대기열에 넣음`)
      console.error(`generate-classes (bulk chain) ${tId} 처리 시간 예산 초과, 대기열 재투입:\n`, log.join("\n"))
      await markQueued(tId, TIMETABLE_STATUS_SPEC)
    } else {
      log.push(`[error] ${tId}: ${(err as Error).message}`)
      await markError(tId, TIMETABLE_STATUS_SPEC, (err as Error)?.message ?? String(err))
    }
  }

  // 다음 시간표로 이어달리기: 202(즉시 응답)만 기다리고, 실제 처리는 그 다음 호출의 백그라운드에서
  // 진행된다 -- 호출이 계속 쌓이지 않는다 (send-selected-notifications와 동일 패턴).
  try {
    await callSelf({ isContinuation: true, menuPageId, horizonDate, chainStartedAt }, adminKey)
  } catch (err) {
    log.push(`[error] bulk chain: 다음 단계 이어달리기 호출 실패: ${(err as Error).message}`)
    console.error("generate-classes (bulk chain) 이어달리기 실패:\n", log.join("\n"))
    if (menuPageId) {
      await markError(
        menuPageId,
        TIMETABLE_STATUS_SPEC,
        `이어달리기 호출 실패: ${(err as Error).message} (다시 버튼을 눌러 이어서 처리해주세요)`,
      )
    }
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
  // (2026-09-24, PART N-12) 일괄 생성 체인의 이어달리기 호출(callSelf)이 실어보내는 필드들.
  // isBulkButton && isContinuation일 때만 의미가 있다 -- 그 외에는 무시된다.
  let isContinuation = false
  let contMenuPageId: string | undefined
  let contHorizonDate: string | undefined
  let contChainStartedAt: number | undefined
  try {
    const body = await req.json()
    rawBodyForLog = body
    isContinuation = body?.isContinuation === true
    if (isContinuation) {
      contMenuPageId = typeof body?.menuPageId === "string" ? body.menuPageId : undefined
      contHorizonDate = typeof body?.horizonDate === "string" ? body.horizonDate : undefined
      contChainStartedAt = typeof body?.chainStartedAt === "number" ? body.chainStartedAt : undefined
    }
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

    // (2026-09-24, PART N-12) 이어달리기(체인) 호출: 초기 클릭이 아니라 callSelf()가 스스로를
    // 다시 부른 것. menuPageId/horizonDate/chainStartedAt을 body에서 그대로 이어받아 runBulkChainStep을
    // 한 번 더 실행한다 -- 시간표 조회/필요 여부 재계산 없이 바로 "대기중인 것 1개 처리"로 들어간다.
    if (isContinuation) {
      if (!contHorizonDate || contChainStartedAt === undefined) {
        console.error(
          "generate-classes (bulk continuation): 잘못된 이어달리기 body:",
          JSON.stringify(rawBodyForLog),
        )
        return respondAccepted({ mode: "bulk", warning: "invalid continuation body" })
      }
      const adminKey = await getCurrentAdminKey()
      runInBackground(() =>
        runBulkChainStep({
          menuPageId: contMenuPageId,
          horizonDate: contHorizonDate!,
          chainStartedAt: contChainStartedAt!,
          adminKey,
          log,
        }),
      )
      return respondAccepted({ mode: "bulk" })
    }

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

        // (2026-09-24, PART N-12) 처리가 필요한 시간표를 전부 "⏳ 대기열"로 표시만 해둔다 (빠른
        // Notion 쓰기 몇 건 -- 세션/출석 생성이나 대시보드 연결 트리거는 전혀 안 일어나므로 여러
        // 건을 동시에 표시해도 안전하다). 실제 처리는 아래 runBulkChainStep이 한 번에 딱 1개씩만 진행한다.
        const needIds = needed.map((p) => p.id)
        await mapWithConcurrency(needIds, TIMETABLE_CONCURRENCY, async (tId) => {
          try {
            await markQueued(tId, TIMETABLE_STATUS_SPEC)
          } catch (err) {
            console.error(`generate-classes (bulk): markQueued(${tId}) 실패:`, (err as Error).message)
          }
        })

        const adminKey = await getCurrentAdminKey()
        await runBulkChainStep({ menuPageId, horizonDate, chainStartedAt: Date.now(), adminKey, log })
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
        await withTimeout(
          processTimetable(timetable, log, { type: "single" }),
          PROCESS_TIMETABLE_TIMEOUT_MS,
          `processTimetable(${timetableId})`,
        )
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
      const alreadyRunning = isRunning(timetable, TIMETABLE_STATUS_SPEC)
      if (alreadyRunning) {
        log.push(`[skip] ${tId}: already processing (생성중)`)
        return
      }
      await markRunning(tId, TIMETABLE_STATUS_SPEC)
      try {
        // (PART N-12 후속) 반환된 done:false(시간 예산 안에 다 못 따라잡음)는 크론 경로에서는
        // 그냥 무시한다 -- bulk 체인처럼 별도로 재투입해봐야 다음 크론 실행도 "대기열"을 이미
        // 접수된 것으로 보고 건너뛰므로 오히려 영원히 멈출 수 있다. 대신 이번 실행에서 진행된
        // 만큼(latestDate)은 이미 반영돼 있으니 그냥 "완료"로 두고, 다음 크론 실행이 자연스럽게
        // 이어서 마무리한다 (기존 20건 안전장치가 있었을 때도 동일하게 동작했음).
        await withTimeout(
          processTimetable(timetable, log, { type: "until", horizonDate }),
          PROCESS_TIMETABLE_TIMEOUT_MS,
          `processTimetable(${tId})`,
        )
        await markDone(tId, TIMETABLE_STATUS_SPEC)
      } catch (err) {
        log.push(`[error] ${tId}: ${(err as Error).message}`)
        await markError(tId, TIMETABLE_STATUS_SPEC, (err as Error)?.message ?? String(err))
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

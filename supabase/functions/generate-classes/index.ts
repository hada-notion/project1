// Supabase Edge Function: generate-classes
// Reads the timetable (recurring class schedule) DB and creates class-session pages,
// then creates attendance only for registrations actually linked to that specific timetable.
//
// There are 2 real call modes, distinguished by the request body/query string:
// (1) Single button call: body = { "timetableId": "<timetable page id>" }
//     -> Only that one timetable is processed, and only ONE upcoming class session is created for it.
// (2) Bulk button call: URL has ?mode=bulk (메뉴 DB의 "다음주 수업 일괄 생성" 버튼)
//     -> ALL timetables are queued, then processed one at a time via a self-calling chain
//        (runBulkChainStep) until sessions exist through the earliest incomplete week's Sunday.
// Since a call is skipped once a timetable already has a session on/after horizonDate,
// calling this endpoint repeatedly is always safe (idempotent).
//
// (2026-09-25, PART N-19) 예전엔 body가 없는 호출을 "크론(자동) 모드"로 취급해 전체 시간표를
// 동기적으로 스캔했는데, 이걸 실제로 트리거하는 스케줄러(pg_cron/GitHub Actions cron)가 레포에
// 하나도 없어 죽어있던 코드였다. 초기 배포 단계라 예약실행/자동 트리거를 최대한 줄이는 방향에
// 맞춰 이 죽은 경로를 제거했다 -- 이제 timetableId도 mode=bulk도 없는 호출은 400 에러로 응답한다.
//
// v2에서 추가됨: 출석을 새로 만든 직후, 그 등록(학생)에 대해 "과제 마감"이 아직 비어있는 과제
// 학습활동이 있으면 이번에 새로 생긴 출석(수업)에 자동으로 연결해야 한다. 출제 당시엔 다음 수업이
// 없어서 마감을 못 잡았던 경우, 이 함수가 나중에 다음 수업을 만들 때 자동으로 채워지도록 하는
// 안전망이다.
//
// v3에서 재설계됨 (2026-09-24): 기존엔 학습활동(학원) DB를 "구분=과제 AND 과제 마감=empty" 필터로
// 직접 검색했는데, 학습활동의 "구분"이 학습기록(학원) DB의 구분을 미러링하는 rollup으로 바뀐 뒤로
// select 필터가 타입 불일치(400)로 매 호출 실패하고 있었다 (조용히 catch되어 안 보였음). 이제는
// 검색을 아예 하지 않는다: 직전 수업(getLatestClassSession)이 이미 갖고 있는 "학습기록" 관계 ID들을
// 그대로 물려받아, 학습기록(구분은 여기서 네이티브 select) -> 학습활동 관계를 getPage로만 순수하게
// 따라가서(computePendingDeadlineTargets) 대상 학습활동 ID를 찾는다. 이 함수는 실제로 "과제 마감"을
// 쓰지 않고, 새로 만든 출석 페이지에 "과제마감 백필 대상"/"과제마감 백필 상태(대기열)"만 세팅해서
// 독립된 큐에 넘긴다 — 실제 연결 작업은 별도 함수 backfill-assignment-deadlines가 그 큐를 드레인하며
// 수행한다 (분리큐 원칙: 단위 작업마다 독립된 큐/체인). sync-registration-class-session의 등록
// "수업 생성" 버튼 경로에도 동일한 백필 로직이 있다 — 이 함수는 시간표 기준 자동/수동 생성 경로를
// 담당한다.

import {
	queryDataSource,
	queryAllPages,
	getPage,
	createPage,
	updatePageProperties,
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
// (2026-09-25, PART N-18) 대시보드(학원) DB 자동 연결(enqueueDashboardLink)을 이 함수에서
// 완전히 제거했다. 이유: 오늘 실측으로, 대량 수업/출석 생성 중 Notion API 자체가 429(Too Many
// Requests)를 Retry-After 28~56초짜리로 반환하는 현상이 확인됐다 -- 이는 내부 큐/동시성 문제가
// 아니라 이 통합 토큰이 쓰는 Notion API 초당 평균 호출량 자체가 한도를 넘어선 것이다. 세션 1개
// 생성 + 등록 N명 출석 생성마다 매번 대시보드 큐에 적재하던 이 호출(페이지 생성 규모에 정확히
// 비례해서 늘어남)이 그 호출량의 큰 축이었다. 지금은 초기 배포 단계라 기능을 최대한 줄이는
// 방향으로 가기로 했고, 대시보드 연결은 나중에 "대시보드 페이지 생성/수동 버튼 → 그날 데이터를
// 당겨오는" pull 모델로 별도 작업에서 다시 만들 예정이다. (예전 import는
// `import { enqueueDashboardLink } from "../_shared/dashboardLinkTarget.ts"`, 호출부는
// createPage(DS.classSession) 직후와 등록별 출석 생성 루프 안쪽 두 곳이었다.)
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

// ---- 대기 중인 과제 마감 백필용 (2026-09-24, PART N-12 후속 재설계) ----
// 예전엔 "학습활동 DB를 등록ID+구분+마감비어있음으로 검색"하는 방식이었는데, 학습활동의 "구분"이
// 어느 시점에 select에서 rollup(학습기록.구분을 그대로 미러링)으로 바뀌면서 그 필터가 매번
// 400(rollup does not match filter select)으로 깨져 있었다(2026-09-24 실측 로그로 확인). 게다가
// 검색 자체가 사용자의 설계 원칙("호출부가 이미 정확한 범위를 넘겨줘야 한다")에도 안 맞았다.
// 새 설계: 수업(학원) DB -> 학습기록(학원) DB -> 학습활동(학원) DB가 전부 진짜 relation이므로,
// 이미 하고 있던 "이전 수업 조회" 한 번에 학습기록 relation을 얹어서 챙기고, 그걸 getPage로
// 직접 따라 내려간다(별도 DB 검색 전혀 없음). 학습기록(학원) DB의 "구분"은 (학습활동과 달리)
// 진짜 select라서 그대로 비교할 수 있다.
const PROP_SESSION_LEARNING_RECORDS = "학습기록" // 수업(학원) DB relation -> 학습기록(학원) DB
const PROP_RECORD_CATEGORY = "구분" // 학습기록(학원) DB (select: 학습/과제/평가)
const PROP_RECORD_REGISTRATION = "등록" // 학습기록(학원) DB relation -> 등록(학원) DB
const PROP_RECORD_ACTIVITIES = "학습활동" // 학습기록(학원) DB relation -> 학습활동(학원) DB
const CATEGORY_ASSIGNMENT = "과제"
const PROP_ACTIVITY_DEADLINE = "과제 마감" // 학습활동(학원) DB relation -> 출석(학원) DB
// 출석(학원) DB: 여기서는 실제로 마감을 연결하지 않고, "이 학생 것으로 이미 계산해둔 대상"만
// 채워서 별도 큐(backfill-assignment-deadlines)에 넘긴다 (분리 큐 설계, 사용자 요청).
const PROP_ATTENDANCE_BACKFILL_TARGET = "과제마감 백필 대상" // relation -> 학습활동(학원) DB
const PROP_ATTENDANCE_BACKFILL_STATUS = "과제마감 백필 상태" // select

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
// Perf: concurrency cap for writing "⏳ 대기열" status onto multiple timetables at once
// (bulk-button path) before the chain processes them one at a time. Kept modest to stay well
// under Notion's rate limit (existing 429/5xx retry logic in notionClient.ts covers any
// overshoot) (2026-09-11 perf fix; 2026-09-25: 크론 경로가 죽은 코드로 삭제되면서 이 상수의
// 용도도 "대기열 표시" 단계 하나로 줄었다).
const TIMETABLE_CONCURRENCY = 4

// (2026-09-24, PART N-14 동시성 폭주 수정) 시간표 1건 처리 안에서 등록별 병렬 작업(출석
// 생성/재사용, computePendingDeadlineTargets의 getPage 두 단계)에 쓰는 동시성 상한. 기존에는
// Promise.all로 무제한 동시 호출했는데, 13명짜리 반 하나만 처리해도 등록 루프 26건 + 백필 계산
// 최대 26건까지 합쳐 50건 넘는 Notion API 호출이 한꺼번에 나가 429/재시도가 겹치며 150초
// WallClockTime으로 죽는 사고(로그로 확인)가 반복됐다. REG_CONCURRENCY=4는 기존
// TIMETABLE_CONCURRENCY(시간표 동시 처리 수)·generateReportTarget.ts/generateTuitionTarget.ts의
// REG_CONCURRENCY와 동일한 값으로 맞춘 것 — 안전장치(타임아웃)가 아니라 실제로 한 번에 나가는
// 호출 수 자체를 줄이는 근본 수정이다.
const REG_CONCURRENCY = 4

// notionHeaders / queryDataSource / getPage / createPage / updatePageProperties / dateStart / relIds
// 는 이제 _shared/notionClient.ts에서 가져온다 (429/5xx 재시도가 자동으로 추가됨, 로드맵 5-9).

// 이전 수업(같은 시간표의 latestDate에 해당하는 수업 페이지, getLatestClassSession이 이미 한 번
// 조회하면서 함께 챙겨온 것)의 "학습기록" relation ID들을 받아서, 학생(등록)별로 "이번에 새로
// 만드는 출석에 마감을 연결해줘야 할 학습활동 ID 목록"을 계산한다. DB 검색이 전혀 없다 — 전부
// 이미 알고 있는 ID를 getPage로 직접 따라 내려가는 것뿐이다(수업.학습기록 -> 학습기록.학습활동).
// 실제 마감 연결(쓰기)은 여기서 하지 않는다 — 계산 결과만 반환하고, 호출부가 출석 생성 시점에
// "과제마감 백필 대상"/"과제마감 백필 상태"에 채워서 별도 큐(backfill-assignment-deadlines)로
// 넘긴다(2026-09-24, 분리 큐 재설계, 사용자 요청).
async function computePendingDeadlineTargets(learningRecordIds: string[]): Promise<Map<string, string[]>> {
  const targets = new Map<string, string[]>()
  if (learningRecordIds.length === 0) return targets

  // (2026-09-24, PART N-14) 무제한 Promise.all -> REG_CONCURRENCY로 상한 (위 상수 주석 참고).
  const records = await mapWithConcurrency(learningRecordIds, REG_CONCURRENCY, (id) => getPage(id))
  const assignmentRecords = records.filter(
    (r: any) => r.properties[PROP_RECORD_CATEGORY]?.select?.name === CATEGORY_ASSIGNMENT,
  )
  if (assignmentRecords.length === 0) return targets

  // 학습활동 ID -> 그게 속한 등록(학생) ID. 여러 학습기록이 같은 학습활동을 가리킬 일은 없지만,
  // 안전하게 Map으로 관리한다.
  const activityOwner = new Map<string, string>()
  for (const record of assignmentRecords) {
    const regId = relIds(record.properties[PROP_RECORD_REGISTRATION])[0]
    if (!regId) continue
    for (const activityId of relIds(record.properties[PROP_RECORD_ACTIVITIES])) {
      activityOwner.set(activityId, regId)
    }
  }
  if (activityOwner.size === 0) return targets

  // 이미 마감이 채워져 있는 항목은 제외해야 하므로, 각 학습활동을 직접 조회해서 확인한다
  // (검색이 아니라 위에서 이미 확보한 ID들을 그대로 getPage로 읽는 것뿐).
  const activityIds = [...activityOwner.keys()]
  // (2026-09-24, PART N-14) 무제한 Promise.all -> REG_CONCURRENCY로 상한 (위 상수 주석 참고).
  const activities = await mapWithConcurrency(activityIds, REG_CONCURRENCY, (id) => getPage(id))
  for (const activity of activities) {
    if (relIds(activity.properties[PROP_ACTIVITY_DEADLINE]).length > 0) continue // 이미 마감 있음
    const regId = activityOwner.get(activity.id)
    if (!regId) continue
    const list = targets.get(regId) ?? []
    list.push(activity.id)
    targets.set(regId, list)
  }
  return targets
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

// processTimetable이 쓰는 버전: 위 getLatestClassDate와 똑같은 조회(같은 필터/정렬/page_size)
// 이지만, 날짜만 뽑고 버리지 않고 그 수업 페이지의 "학습기록" relation도 함께 챙긴다 — 이걸로
// computePendingDeadlineTargets를 검색 없이 바로 호출할 수 있다(2026-09-24, 분리 큐 재설계).
async function getLatestClassSession(
  timetableId: string,
): Promise<{ date: string | null; learningRecordIds: string[] } | null> {
  const data = await queryDataSource(DS.classSession, {
    filter: { property: "시간표", relation: { contains: timetableId } },
    sorts: [{ property: "수업일시", direction: "descending" }],
    page_size: 1,
  })
  if (data.results.length === 0) return null
  const page = data.results[0] as any
  const date = page.properties["수업일시"].date
  return {
    date: date ? date.start.slice(0, 10) : null,
    learningRecordIds: relIds(page.properties[PROP_SESSION_LEARNING_RECORDS]),
  }
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
async function mapWithConcurrency<T, R = void>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++
      results[current] = await fn(items[current])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  return results
}

type ProcessMode =
  // Button (manual, single) mode: always creates exactly ONE new session right after the
  // latest existing one, regardless of whether that latest session is already in the future.
  | { type: "single" }
  // Bulk button (manual, "다음주 수업 일괄 생성") mode: keep creating sessions
  // (oldest-missing-first) until one exists on/after horizonDate. horizonDate is recomputed
  //   fresh on EVERY click as the Sunday of the earliest calendar week that at least one
  //   timetable is still missing a session for (see the week-completeness pre-pass in the
  //   bulk button handler below). This horizon is intentionally SHARED across every timetable
  //   in one click (not computed per-timetable), so a timetable that already has extra weeks
  //   pre-made ahead (for whatever reason) is left alone -- it's already past this horizon, so
  //   it creates nothing this round -- while timetables still missing that week get filled up
  //   to it. This keeps every timetable's length converging together instead of already-ahead
  //   ones running further ahead while behind ones never catch up (2026-09-11).
  //   (2026-09-25: 예전엔 이 모드를 크론 경로도 같이 썼지만, 그 크론 경로 자체가 죽은 코드였어서
  //   제거했다 -- 이제 이 모드는 일괄 버튼 체인 전용이다.)
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
// (2026-09-24, PART N-16) 100_000 -> 70_000으로 하향. 실제 사고 로그에서 이 withTimeout 자체의
// 100초 데드라인이 148초가 되어서야 발동한 사례가 확인됐다 -- Notion 호출/재시도가 몰려 이벤트
// 루프가 밀리면 우리 내부 타임아웃 체크조차 정시에 실행되지 못하고, 그 순간 플랫폼의 하드
// 종료 한도(약 150초)와 거의 붙어버려서 뒤이은 markQueued/callSelf(정상 종료 경로)가 끝까지
// 실행될 시간을 못 받고 함께 죽었다. 데드라인을 낮추면 실제 작업량이 줄어드는 건 아니지만
// (사용자가 지적한 대로 안전장치 자체는 일을 줄이지 않는다), 최소한 "정상 종료 경로가 실행될
// 여유 시간"을 더 확보해서 완전 침묵 사망 대신 항상 로그+재대기열+이어달리기로 끝나게 한다.
// 진짜 근본 수정은 아래 실제 호출 수를 줄이는 변경(등록당 미연결 출석 검색을 세션당 1회로 통합)이다.
const PROCESS_TIMETABLE_TIMEOUT_MS = 70_000

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
  // (2026-09-24, PART N-17: 계측 로그 추가) 학생 수가 많은 반이 반복 타임아웃나는 걸 실측으로
  // 확인했는데, 70초 예산 중 준비 단계/수업 생성/출석 검색/학생별 처리 중 정확히 어느 구간이
  // 오래 걸리는지 로그로 구분이 안 됐다. 각 구간 시작/끝에 소요 시간을 log에 남긴다 --
  // withTimeout이 중간에 포기해도 이미 push된 항목은 그 시점의 오류 로그에 그대로 남으므로,
  // "어느 항목까지는 찍혔고 그 다음이 없는지"로 막힌 구간을 알 수 있다.
  const setupStartedAt = Date.now()
  const latestSession = await getLatestClassSession(timetableId)
  let latestDate = latestSession?.date ?? null
  let createdCount = 0
  let backfillQueuedCount = 0
  // (2026-09-24, 분리 큐 재설계) 위 조회에 이미 얹혀서 나온 이전 수업의 "학습기록" relation을
  // 그대로 따라 내려가서, 학생별로 "이번에 만드는 출석에 마감을 백필해줘야 할 학습활동 ID"를
  // 미리 계산해둔다 — 검색 없음, 전부 이미 알고 있는 ID로 getPage만 호출(위 함수 주석 참고).
  const pendingDeadlineTargets = await computePendingDeadlineTargets(latestSession?.learningRecordIds ?? [])

  // Perf (2026-09-11): closures, class name, and the registration list don't change across
  // iterations of the while-loop below for a given timetable, but were previously re-fetched
  // from Notion on EVERY iteration (i.e. once per session created). Fetching them once up
  // front removes most of the redundant network calls that made a multi-session backfill (the
  // first-ever "일주일 일괄 생성" run) slow.
  const closures = await getClosurePeriods(classId)
  const { name: className, teacherIds } = await getClassInfo(classId)
  const weekdayKr = WEEKDAY_KR[weekday]
  const timetableRegs = await getTimetableRegistrations(timetableId)
  log.push(`[timing] ${timetableName}: 준비 단계(최근수업/백필계산/휴강/클래스정보/등록목록) ${Date.now() - setupStartedAt}ms`)

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

    const createSessionStartedAt = Date.now()
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
    log.push(`[timing] ${timetableName}: 수업 페이지 생성 ${Date.now() - createSessionStartedAt}ms`)

    log.push(`[created] ${timetableName}: class session created (${nextDate}), 등록 ${registrationIds.length}건 연결`)

    // (2026-09-24, PART N-16 근본 수정) 학부모 요청 등으로 이 날짜의 수업이 생기기 전에 등록
    // 페이지의 캘린더 탭에서 미리 출석을 만들어둔 경우(결석 표시, 메모 등을 이미 적어둔 상태)가
    // 있을 수 있어서, 원래는 "등록별로" 미연결 출석을 검색했다(등록 N명 = 검색 N번). 그런데
    // 실제로 이 사전 생성 케이스는 드물고, 검색 자체는 전체 반에 대해 한 번만 해도 결과가 같다
    // (같은 날짜 범위 + "수업이 비어있음" 조건은 등록마다 다르지 않다 -- 등록 조건만 "OR로 이 반
    // 학생 중 하나"로 넓히면 된다). 등록 13명 기준 검색 호출을 13번 -> 1번으로 줄인다 -- 이게
    // 동시성 제한(REG_CONCURRENCY)보다 훨씬 직접적인 "실제 호출 수 자체를 줄이는" 수정이다.
    const { start: dayStart, end: dayEnd } = dayRangeIso(nextDate)
    const unlinkedSearchStartedAt = Date.now()
    const unlinkedByReg = new Map<string, any>()
    if (registrationIds.length > 0) {
      const unlinkedCandidates = await queryAllPages(DS.attendance, {
        and: [
          { property: "수업", relation: { is_empty: true } },
          { property: "수업일시", date: { on_or_after: dayStart } },
          { property: "수업일시", date: { before: dayEnd } },
          { or: registrationIds.map((id) => ({ property: "등록", relation: { contains: id } })) },
        ],
      })
      for (const candidate of unlinkedCandidates) {
        for (const regId of relIds(candidate.properties["등록"])) {
          if (!unlinkedByReg.has(regId)) unlinkedByReg.set(regId, candidate)
        }
      }
    }
    log.push(
      `[timing] ${timetableName}: 미연결 출석 검색 ${Date.now() - unlinkedSearchStartedAt}ms (등록 ${registrationIds.length}명)`,
    )

    // Perf (2026-09-11): attendance creation + pending-assignment-deadline linking for each
    // registration are independent of each other, so run them concurrently instead of
    // one-at-a-time — this matters most for classes with many students.
    // (2026-09-24, PART N-14) 무제한 Promise.all -> REG_CONCURRENCY로 상한. 학생 수가 많은 반일수록
    // 등록당 2건(미연결 출석 검색 + 생성/갱신)씩 한꺼번에 쏘던 게 429/재시도 폭주로 150초
    // WallClockTime 타임아웃의 주요 원인이었다 (위 REG_CONCURRENCY 주석 참고). 동시성을 낮추는 게
    // "안전장치"가 아니라 실제 동시 호출 수 자체를 줄이는 근본 수정이다.
    const regLoopStartedAt = Date.now()
    try {
      await mapWithConcurrency(registrationIds, REG_CONCURRENCY, async (regId) => {
        const unlinkedCandidates = unlinkedByReg.has(regId) ? [unlinkedByReg.get(regId)] : []

        // (2026-09-24, 분리 큐 재설계) 이 학생 것으로 미리 계산해둔 백필 대상이 있으면
        // 출석 생성/연결과 같은 쓰기에 얹어서 채운다 — 없으면 아무 것도 안 채우고 그대로
        // 패스(추가 호출 없음). 실제 마감 연결은 여기서 하지 않고 별도 큐가 한다.
        const backfillTargets = pendingDeadlineTargets.get(regId)
        const backfillProps =
          backfillTargets && backfillTargets.length > 0
            ? {
                [PROP_ATTENDANCE_BACKFILL_TARGET]: { relation: backfillTargets.map((id) => ({ id })) },
                [PROP_ATTENDANCE_BACKFILL_STATUS]: { select: { name: STATUS_QUEUED } },
              }
            : {}
        if (backfillTargets && backfillTargets.length > 0) backfillQueuedCount++

        if (unlinkedCandidates.length > 0) {
          const candidate = unlinkedCandidates[0]
          await updatePageProperties(candidate.id, {
            수업: { relation: [{ id: classPage.id }] },
            클래스: { relation: [{ id: classId }] },
            수업일시: { date: { start: startIso, end: endIso } },
            // 2026-09-16 버그 수정: 시간표 -> 수업까지만 복사되던 담당강사가 출석에는
            // 전달되지 않고 있었음. 기존 미연결 출석을 새로 연결할 때도 담당강사를 채운다.
            ...(teacherIds.length ? { 담당강사: { relation: teacherIds.map((id) => ({ id })) } } : {}),
            ...backfillProps,
          })
          log.push(`[linked] ${timetableName}: existing unlinked attendance ${candidate.id} -> reg ${regId} (${nextDate})`)
        } else {
          await createPage(DS.attendance, {
            출석: { title: [{ text: { content: `${nextDate} 출석` } }] },
            수업일시: { date: { start: startIso, end: endIso } },
            수업: { relation: [{ id: classPage.id }] },
            클래스: { relation: [{ id: classId }] },
            등록: { relation: [{ id: regId }] },
            // 2026-09-16 버그 수정: 시간표의 담당강사를 출석 생성 시에도 함께 복사한다.
            ...(teacherIds.length ? { 담당강사: { relation: teacherIds.map((id) => ({ id })) } } : {}),
            ...backfillProps,
          })
        }
      })
    } catch (err) {
      log.push(
        `[timing] ${timetableName}: 학생별 출석 처리 중 오류 발생 (실패까지 ${Date.now() - regLoopStartedAt}ms, ${registrationIds.length}명, concurrency=${REG_CONCURRENCY})`,
      )
      // 출석 생성 중 하나라도 실패하면 이 수업 행의 "생성중"을 끄고 오류를 남긴 뒤 그대로 다시 던진다
      // (이 예외는 위쪽 호출부의 catch에서 markError(TIMETABLE_STATUS_SPEC)로 시간표 쪽에도 기록된다 — 기존 동작 유지).
      await markSessionError(classPage.id, (err as Error).message)
      throw err
    }
    log.push(
      `[timing] ${timetableName}: 학생별 출석 처리 완료 ${Date.now() - regLoopStartedAt}ms (${registrationIds.length}명, concurrency=${REG_CONCURRENCY})`,
    )
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
  // (2026-09-24, 분리 큐 재설계) 과제마감 백필은 완전히 별도의 큐/함수(backfill-assignment-deadlines)
  // 이므로 독립적으로 깨운다 — sync_queue 워커와 몰려서 같은 레이트리밋 문제를 재현하지 않도록
  // 이 호출 하나당 최대 1번만 호출한다(위 wakeSyncQueueWorker와 동일한 이유).
  if (backfillQueuedCount > 0) wakeAssignmentDeadlineWorker()

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

// (2026-09-24, 분리 큐 재설계) sync_queue의 wakeSyncQueueWorker(_shared/syncQueue.ts)와 정확히
// 같은 패턴 -- 실패해도 조용히 로그만 남기고 던지지 않는다(어차피 이 함수 전용 pg_cron 안전망이
// 나중에 대기열을 다시 찾아 처리한다). generate-classes 전용 로컬 함수로 두는 이유는 다른 함수
// 폴더들과 같은 관례(TIMETABLE_STATUS_SPEC 등도 로컬 복제)를 따르기 위함이다.
function wakeAssignmentDeadlineWorker(): void {
  if (!Deno.env.get("SB_URL")) return
  const promise = getCurrentAdminKey()
    .then((adminKey) =>
      fetch(`${FUNCTIONS_BASE}/backfill-assignment-deadlines`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify({ source: "wake" }),
      }),
    )
    .catch((err) => {
      console.error("[wakeAssignmentDeadlineWorker] 워커 즉시 트리거 실패 (pg_cron 안전망이 대신 처리함):", (err as Error)?.message)
    })
  const edgeRuntime = (globalThis as Record<string, unknown>).EdgeRuntime as
    | { waitUntil?: (p: Promise<unknown>) => void }
    | undefined
  if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
    edgeRuntime.waitUntil(promise)
  }
}

// (2026-09-24, PART N-12 후속 5차 버그 수정) 이 함수가 체인을 이어가는 유일한 연결고리인데,
// 지금까지 fetch()의 응답 상태(response.ok)를 전혀 확인하지 않았다 -- Supabase 자체 함수
// 호출 레이트리밋(429)이나 순간적인 오류로 이 자기호출이 거부돼도, fetch() 자체는 "정상적으로"
// resolve되므로(예외를 던지지 않음) 호출부가 이를 성공으로 착각하고 그대로 끝나버렸다. 그러면
// 체인이 아무 오류도 남기지 않고 조용히 멈춰서(대기열은 남아있는데 아무것도 진행 중이지 않은
// 상태), 사용자가 버튼을 다시 눌러야만 재개되는 문제가 실제로 관찰됐다. 상태 코드를 확인하고,
// 실패하면 짧게 재시도(레이트리밋은 금방 풀리는 것으로 이미 확인됨)한 뒤, 그래도 안 되면 던져서
// 호출부의 markError 경로가 확실히 남게 한다.
// (2026-09-24, PART N-15 체인 사망 버그 수정) markRunning/markQueued/markDone/markError 같은
// "상태 표시" 호출도 결국 Notion API 호출이라 실패할 수 있다. 특히 방금 processTimetable()이
// 429/재시도 폭주로 타임아웃난 바로 그 순간에는, 뒤이은 markQueued() 호출도 같은 혼잡에 걸려
// 실패할 가능성이 오히려 더 높다 — 그런데 이 호출들에 안전망이 없으면 예외가 그대로 던져져서,
// 바로 아래 있는 이어달리기(callSelf) 호출까지 전혀 실행되지 못하고 체인 전체가 "아무 로그도
// 없이" 조용히 죽는다. 실제로 2026-09-24 20:52 KST 사고에서 이 패턴이 재현됐다: 로그는
// "[requeue] ... 처리 시간 예산 초과, 대기열 재투입"까지만 찍히고 그 뒤로 9분 넘게 완전히
// 멈췄는데, 해당 시간표는 상태가 "대기열"로 바뀌지도 않고 "작업중" + 원래 시작 시각 그대로
// 남아있었다 — markQueued() 자체가 던진 예외가 callSelf() 호출을 가로막았다는 뜻이다.
// 상태 표시는 부가 정보(관찰용)일 뿐 실제 처리 결과가 아니므로, 실패해도 삼키고 로그만 남긴 뒤
// 반드시 이어달리기까지는 도달하게 한다 — 안전장치가 아니라, "체인은 반드시 다음 단계로
// 이어진다"는 이 설계의 핵심 전제 자체를 지키기 위한 수정이다.
async function safeMarkStatus(label: string, fn: () => Promise<void>, log: string[]): Promise<void> {
  try {
    await fn()
  } catch (err) {
    log.push(`[warn] ${label}: 상태 표시 갱신 실패(무시하고 계속): ${(err as Error).message}`)
    console.error(`generate-classes (bulk chain) ${label} 상태 표시 갱신 실패:\n`, log.join("\n"))
  }
}

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
    if (menuPageId) {
      await safeMarkStatus(
        `${menuPageId} markError(대기열 조회 실패)`,
        () => markError(menuPageId, TIMETABLE_STATUS_SPEC, (err as Error).message),
        log,
      )
    }
    return
  }

  const next = (queued.results as any[])[0]
  if (!next) {
    // 더 이상 대기중인 시간표가 없음 -> 체인 종료.
    console.log("generate-classes (bulk button) finished:\n", log.join("\n"))
    if (menuPageId) {
      await safeMarkStatus(`${menuPageId} markDone(체인 종료)`, () => markDone(menuPageId, TIMETABLE_STATUS_SPEC), log)
    }
    return
  }

  const tId = next.id
  // (2026-09-24, PART N-15) markRunning 실패해도 처리 자체는 계속한다 -- next는 이미 확보했으므로
  // "작업중" 표시 실패가 실제 처리를 막을 이유가 없다(아래 safeMarkStatus 주석 참고).
  await safeMarkStatus(`${tId} markRunning`, () => markRunning(tId, TIMETABLE_STATUS_SPEC), log)
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
      await safeMarkStatus(`${tId} markQueued(부분 처리)`, () => markQueued(tId, TIMETABLE_STATUS_SPEC), log)
    } else {
      await safeMarkStatus(`${tId} markDone`, () => markDone(tId, TIMETABLE_STATUS_SPEC), log)
    }
  } catch (err) {
    const isTimeout = ((err as Error)?.message ?? "").includes(`${timeoutLabel}: 시간 제한(`)
    if (isTimeout) {
      // (PART N-12 후속) 개별 Notion API 호출은 각자 재시도하며(12초 x 최대 5회) 시간을 쓰다가
      // 합쳐서 예산을 넘긴 것일 수 있다 -- 실제 처리 오류가 아닐 수 있으므로 "오류"로 남기지 않고
      // 다시 "대기열"에 넣는다 (다음 스텝은 latestDate 기준으로 자동으로 이어서 재개됨).
      log.push(`[requeue] ${tId}: withTimeout(${PROCESS_TIMETABLE_TIMEOUT_MS}ms) 초과, 다시 대기열에 넣음`)
      console.error(`generate-classes (bulk chain) ${tId} 처리 시간 예산 초과, 대기열 재투입:\n`, log.join("\n"))
      // (2026-09-24, PART N-15) 바로 이 markQueued가 실패해서 체인이 죽는 사고가 실제로 재현됨
      // (위 safeMarkStatus 주석 참고) -- 실패해도 반드시 아래 callSelf까지 도달해야 한다.
      await safeMarkStatus(`${tId} markQueued(타임아웃)`, () => markQueued(tId, TIMETABLE_STATUS_SPEC), log)
    } else {
      log.push(`[error] ${tId}: ${(err as Error).message}`)
      await safeMarkStatus(
        `${tId} markError`,
        () => markError(tId, TIMETABLE_STATUS_SPEC, (err as Error)?.message ?? String(err)),
        log,
      )
    }
  }

  // 다음 시간표로 이어달리기: 202(즉시 응답)만 기다리고, 실제 처리는 그 다음 호출의 백그라운드에서
  // 진행된다 -- 호출이 계속 쌓이지 않는다 (send-selected-notifications와 동일 패턴). 위에서 무슨
  // 일이 있었든(상태 표시 실패 포함) 이 줄에는 항상 도달한다 -- PART N-15의 핵심.
  try {
    await callSelf({ isContinuation: true, menuPageId, horizonDate, chainStartedAt }, adminKey)
  } catch (err) {
    log.push(`[error] bulk chain: 다음 단계 이어달리기 호출 실패: ${(err as Error).message}`)
    console.error("generate-classes (bulk chain) 이어달리기 실패:\n", log.join("\n"))
    if (menuPageId) {
      await safeMarkStatus(
        `${menuPageId} markError(이어달리기 실패)`,
        () =>
          markError(
            menuPageId,
            TIMETABLE_STATUS_SPEC,
            `이어달리기 호출 실패: ${(err as Error).message} (다시 버튼을 눌러 이어서 처리해주세요)`,
          ),
        log,
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

  // (2026-09-25, PART N-19) 예전엔 여기서 "크론(자동) 모드"로 전체 시간표를 스캔했지만, 이
  // 경로를 트리거하는 스케줄러가 레포에 전혀 없어 죽은 코드였다(위 파일 헤더 주석 참고). 초기
  // 배포 단계라 예약실행을 최대한 줄이는 방향에 맞춰 제거했다 -- timetableId도 mode=bulk도
  // 없는 호출은 이제 명확한 에러로 응답한다.
  log.push(`[error] invalid request: no timetableId and mode != bulk`)
  console.error("generate-classes: invalid request (no timetableId, mode!=bulk):", JSON.stringify(rawBodyForLog))
  return new Response(
    JSON.stringify(
      { ok: false, error: "invalid_request: timetableId 또는 ?mode=bulk 가 필요합니다 (자동/크론 모드는 제거됨)", log },
      null,
      2,
    ),
    { status: 400, headers: { "Content-Type": "application/json" } },
  )
})

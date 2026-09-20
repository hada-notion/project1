// _shared/dashboardLinkTarget.ts
//
// "대시보드" 기능 (2026-09-20 추가): 수업(학원)/출석(학원)/일정(학원) 페이지가 생성되면 같은
// 날짜의 대시보드(학원) DB 페이지를 자동으로 찾거나 만들어서 서로 연결한다. 4개 관계 모두 실제
// 양방향(two-way) relation이라 이 파일에서 한쪽만 채워도 Notion이 반대쪽을 자동으로 채워준다
// (수업/출석/일정 -> 대시보드 방향으로만 쓰면 충분하다).
//
// 대시보드 자신이 생성/수정될 때는(사람이 직접 만들거나, 아래에서 새로 만든 경우) 그 날짜에
// 해당하는 수업/출석/일정을 전부 다시 모아 대시보드 쪽 관계를 재구성한다 (멱등한 전체 재빌드).
//
// 수업(학원)/출석(학원) 페이지는 대부분 generate-classes, kiosk-checkin 두 Edge Function이
// Notion API를 직접 호출해서 만들기 때문에(사람이 노션 화면에서 직접 "새로 만들기"를 누르는 게
// 아니라) 페이지 자동화(자동화 액션)가 걸리지 않는다. 그래서 이 두 함수 안에서 각각 페이지를
// 만든 직후 enqueueDashboardLink()를 직접 호출해서 같은 큐에 넣는다 (아래). 그 외 경로(사람이
// 노션에서 직접 만들거나, 일정을 직접 만드는 경우)는 대시보드/일정 DB에 걸어둔 "페이지가 생성되면
// → 웹훅 보내기" 자동화가 sync-dashboard-link 함수를 호출해서 같은 큐로 들어온다.

import { getPage, updatePageProperties, createPage, queryAllPages, dateStart } from "./notionClient.ts"
import { enqueueSync, wakeSyncQueueWorker } from "./syncQueue.ts"

export const DS_DASHBOARD = "3c5ba040-586b-8012-8e92-000bac7521e8" // 대시보드(학원) DB
export const DS_CLASS_SESSION = "3b1ba040-586b-80ec-af20-000b31bb69b7" // 수업(학원) DB
export const DS_ATTENDANCE = "8aaba040-586b-8322-8437-87608a763415" // 출석(학원) DB
export const DS_SCHEDULE_EVENT = "4ebba040-586b-836b-bfb0-8741d650419b" // 일정(학원) DB

const PROP_SESSION_DATETIME = "수업일시" // 수업(학원)/출석(학원) DB 공용
const PROP_SCHEDULE_DATE = "날짜" // 일정(학원) DB (기간 가능)
const PROP_DASHBOARD_DATE = "날짜" // 대시보드(학원) DB
const PROP_DASHBOARD_TITLE = "이름" // 대시보드(학원) DB
const PROP_DASHBOARD_RELATION_ON_CHILD = "대시보드" // 수업/출석/일정 DB 공용 relation 이름
const PROP_DASHBOARD_CLASS_SESSION = "수업" // 대시보드(학원) DB
const PROP_DASHBOARD_ATTENDANCE = "출석" // 대시보드(학원) DB
const PROP_DASHBOARD_SCHEDULE = "일정" // 대시보드(학원) DB

const KST_OFFSET = "+09:00"
// 일정(학원)의 "날짜"가 기간(여러 날)일 때, 끝없이 먼 미래까지 대시보드를 만들지 않도록 안전장치.
const MAX_SCHEDULE_SPAN_DAYS = 366
// 대시보드 자신이 생성/수정됐을 때, 그 날짜와 겹치는 일정을 찾기 위해 얼마나 과거까지 훑어볼지
// (일정은 기간을 가질 수 있어서, 대시보드 날짜에는 아직 안 끝났지만 훨씬 이전에 시작한 일정도
// 있을 수 있다 -- generate-classes의 getClosurePeriods가 겪는 것과 동일한 문제).
const SCHEDULE_LOOKBACK_DAYS = 60

function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z")
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// ISO 문자열(수업일시 등)에서 KST 기준 "YYYY-MM-DD" 날짜만 뽑아낸다.
function kstDateOnly(iso: string): string {
  const d = new Date(iso)
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000)
  return kst.toISOString().slice(0, 10)
}

// "YYYY-MM-DD" -> "MM.DD 대시보드" (예: "2026-09-08" -> "09.08 대시보드")
function dashboardTitleOf(dateStr: string): string {
  return `${dateStr.slice(5, 7)}.${dateStr.slice(8, 10)} 대시보드`
}

// [start-of-day, start-of-next-day) in KST, as ISO strings, for a YYYY-MM-DD date string.
function dayRangeIsoKst(dateStr: string): { start: string; end: string } {
  const start = `${dateStr}T00:00:00${KST_OFFSET}`
  const end = `${addDaysStr(dateStr, 1)}T00:00:00${KST_OFFSET}`
  return { start, end }
}

// 지정한 날짜의 대시보드(학원) 페이지를 찾고, 없으면 만든다. 제목은 "MM.DD 대시보드", 날짜는
// 날짜만(시간 없이) 저장한다.
async function findOrCreateDashboard(dateStr: string): Promise<string> {
  const existing = await queryAllPages(DS_DASHBOARD, {
    property: PROP_DASHBOARD_DATE,
    date: { equals: dateStr },
  })
  if (existing.length > 0) return existing[0].id

  const created = await createPage(DS_DASHBOARD, {
    [PROP_DASHBOARD_TITLE]: { title: [{ text: { content: dashboardTitleOf(dateStr) } }] },
    [PROP_DASHBOARD_DATE]: { date: { start: dateStr } },
  })
  return created.id
}

// 수업(학원)/출석(학원) 페이지 1건을, 자신의 "수업일시" 날짜에 해당하는 대시보드 하나에 연결한다.
export async function linkSessionOrAttendanceToDashboard(pageId: string, log: string[]): Promise<void> {
  const page = await getPage(pageId)
  const iso = dateStart(page, PROP_SESSION_DATETIME)
  if (!iso) {
    log.push(`⏭️ ${PROP_SESSION_DATETIME}가 비어있어 대시보드 연결을 건너뜀: ${pageId}`)
    return
  }
  const dateStr = kstDateOnly(iso)
  const dashboardId = await findOrCreateDashboard(dateStr)
  await updatePageProperties(pageId, {
    [PROP_DASHBOARD_RELATION_ON_CHILD]: { relation: [{ id: dashboardId }] },
  })
  log.push(`🔗 ${pageId} -> 대시보드(${dateStr}) 연결`)
}

// 일정(학원) 페이지 1건을, 그 날짜(기간 가능)가 걸치는 모든 날의 대시보드에 전부 연결한다
// (여러 날짜 걸치는 일정은 일정 DB의 "대시보드" relation의 1개 제한을 해제해뒀어야 함).
export async function linkScheduleToDashboards(pageId: string, log: string[]): Promise<void> {
  const page = await getPage(pageId)
  const prop = page.properties?.[PROP_SCHEDULE_DATE]
  const startIso: string | null = prop?.date?.start ?? null
  if (!startIso) {
    log.push(`⏭️ ${PROP_SCHEDULE_DATE}가 비어있어 대시보드 연결을 건너뜀: ${pageId}`)
    return
  }
  const endIso: string = prop?.date?.end ?? startIso
  const startDate = startIso.slice(0, 10)
  const endDate = endIso.slice(0, 10)

  const dashboardIds: string[] = []
  let cursor = startDate
  for (let i = 0; i <= MAX_SCHEDULE_SPAN_DAYS; i++) {
    dashboardIds.push(await findOrCreateDashboard(cursor))
    if (cursor >= endDate) break
    cursor = addDaysStr(cursor, 1)
  }
  if (cursor < endDate) {
    log.push(`⚠️ ${pageId}: 일정 기간이 ${MAX_SCHEDULE_SPAN_DAYS}일을 초과해 일부만 연결함`)
  }

  await updatePageProperties(pageId, {
    [PROP_DASHBOARD_RELATION_ON_CHILD]: { relation: dashboardIds.map((id) => ({ id })) },
  })
  log.push(`🔗 ${pageId} -> 대시보드 ${dashboardIds.length}건 연결 (${startDate}~${endDate})`)
}

// 대시보드(학원) 페이지 1건이 생성/갱신됐을 때, 그 날짜에 해당하는 수업/출석/일정을 전부 다시
// 모아 대시보드 자신의 관계를 재구성한다 (멱등: 항상 그 시점 기준 전체 목록으로 덮어씀).
export async function linkDashboardToChildren(dashboardPageId: string, log: string[]): Promise<void> {
  const dashboard = await getPage(dashboardPageId)
  const dateStr: string | null = dashboard.properties?.[PROP_DASHBOARD_DATE]?.date?.start?.slice(0, 10) ?? null
  if (!dateStr) {
    log.push(`⏭️ ${PROP_DASHBOARD_DATE}가 비어있어 하위 항목 연결을 건너뜀: ${dashboardPageId}`)
    return
  }
  const { start, end } = dayRangeIsoKst(dateStr)

  const [sessions, attendances, scheduleCandidates] = await Promise.all([
    queryAllPages(DS_CLASS_SESSION, {
      and: [
        { property: PROP_SESSION_DATETIME, date: { on_or_after: start } },
        { property: PROP_SESSION_DATETIME, date: { before: end } },
      ],
    }),
    queryAllPages(DS_ATTENDANCE, {
      and: [
        { property: PROP_SESSION_DATETIME, date: { on_or_after: start } },
        { property: PROP_SESSION_DATETIME, date: { before: end } },
      ],
    }),
    // 일정은 기간을 가질 수 있어서 "그 날짜를 포함하는 일정"을 Notion 필터 하나로 정확히 표현하기
    // 어렵다 (generate-classes의 getClosurePeriods와 동일한 이유). on_or_before/on_or_after로
    // 넉넉하게(대시보드 날짜 이전 SCHEDULE_LOOKBACK_DAYS일 이내 시작) 후보를 받아온 뒤, 실제 겹침
    // 여부는 아래에서 직접 필터링한다.
    queryAllPages(DS_SCHEDULE_EVENT, {
      and: [
        { property: PROP_SCHEDULE_DATE, date: { on_or_before: dateStr } },
        { property: PROP_SCHEDULE_DATE, date: { on_or_after: addDaysStr(dateStr, -SCHEDULE_LOOKBACK_DAYS) } },
      ],
    }),
  ])

  const schedules = scheduleCandidates.filter((s: any) => {
    const d = s.properties?.[PROP_SCHEDULE_DATE]?.date
    if (!d?.start) return false
    const endDate = (d.end ?? d.start).slice(0, 10)
    return endDate >= dateStr
  })

  await updatePageProperties(dashboardPageId, {
    [PROP_DASHBOARD_CLASS_SESSION]: { relation: sessions.map((p: any) => ({ id: p.id })) },
    [PROP_DASHBOARD_ATTENDANCE]: { relation: attendances.map((p: any) => ({ id: p.id })) },
    [PROP_DASHBOARD_SCHEDULE]: { relation: schedules.map((p: any) => ({ id: p.id })) },
  })
  log.push(
    `🔗 대시보드(${dateStr}) <- 수업 ${sessions.length}건, 출석 ${attendances.length}건, 일정 ${schedules.length}건 연결`,
  )
}

// process-sync-queue 워커가 target: "sync-dashboard-link" 작업을 처리할 때 호출하는 진입점.
// 페이지가 어느 DB 소속인지에 따라 위 세 함수 중 하나로 분기한다 (cascadeDeleteTarget.ts의
// dataSourceId 분기 방식과 동일한 패턴).
export async function processDashboardLinkQueueItem(payload: { pageId: string }): Promise<void> {
  const log: string[] = []
  const page = await getPage(payload.pageId)
  const dataSourceId: string | undefined = page.parent?.data_source_id

  try {
    if (dataSourceId === DS_DASHBOARD) {
      await linkDashboardToChildren(payload.pageId, log)
    } else if (dataSourceId === DS_CLASS_SESSION || dataSourceId === DS_ATTENDANCE) {
      await linkSessionOrAttendanceToDashboard(payload.pageId, log)
    } else if (dataSourceId === DS_SCHEDULE_EVENT) {
      await linkScheduleToDashboards(payload.pageId, log)
    } else {
      log.push(`⚠️ 알 수 없는 DB임: ${payload.pageId} (dataSourceId=${dataSourceId})`)
    }
    console.log("[sync-dashboard-link] (queue) finished:", payload.pageId, "\n", log.join("\n"))
  } catch (err) {
    console.error("[sync-dashboard-link] (queue) ERROR:", payload.pageId, (err as Error).message, "\n", log.join("\n"))
    throw err
  }
}

// generate-classes/kiosk-checkin처럼 Notion API를 직접 호출해서 수업/출석 페이지를 만드는
// 함수들이, 페이지 생성/갱신 직후 이 큐에 바로 적재하기 위한 편의 함수 (Notion 자동화(웹훅)를
// 거치지 않고 코드에서 직접 호출 -- 이 두 함수로 만들어진 페이지는 자동화가 트리거되지 않기 때문).
export async function enqueueDashboardLink(pageId: string, log?: string[]): Promise<void> {
  try {
    await enqueueSync("sync-dashboard-link", { pageId })
    wakeSyncQueueWorker()
  } catch (err) {
    const message = (err as Error)?.message ?? String(err)
    console.error(`[enqueueDashboardLink] 큐 적재 실패 (pageId=${pageId}):`, message)
    log?.push(`⚠️ 대시보드 연결 큐 적재 실패: ${message}`)
  }
}

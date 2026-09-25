// _shared/dashboardLinkTarget.ts
//
// 수업·출석·일정과 같은 날짜의 대시보드 페이지를 찾아 연결하는 공용 로직이다.
// [현재 상태, 2026-09-25] 대시보드 생성 자동화와 generate-classes/kiosk-checkin의 직접 적재,
// nightly-dashboard-link-audit가 모두 제거되어 enqueueDashboardLink를 포함한 운영 호출자는 없다.
// 수업 생성 중 Notion API 호출량을 줄이기 위해 제거 상태를 유지한다.
//
// 아래 구현과 큐 target은 향후 별도 pull/수동 방식 재설계를 검토하기 전까지 휴면 코드로 남긴다.
// 실제 삭제는 실행 구조 변경이므로 별도 승인 후 진행한다.

import { getPage, updatePageProperties, createPage, queryAllPages, dateStart } from "./notionClient.ts"
import { enqueueSync, wakeSyncQueueWorker } from "./syncQueue.ts"
import { withDashboardDateLock } from "./dashboardDateLock.ts"
import { DS_DASHBOARD, DS_CLASS_SESSION, DS_ATTENDANCE, DS_SCHEDULE_EVENT } from "./constants.ts"
// (2026-09-21, 이식성 리팩토링) 위 4개도 constants.ts로 이동함 — 그 파일 상단 주석 참고.
// nightly-dashboard-link-audit/index.ts가 이 중 3개를 여기서 다시 가져다 쓰고 있었는데, 그쪽도
// constants.ts에서 바로 가져오도록 함께 고쳤다.

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
//
// [FIX, 2026-09-23] "조회 -> 없으면 생성"이 원자적이지 않아서, 같은 날짜를 동시에 처리하는 호출이
// 여러 개 있으면(nightly-dashboard-link-audit의 mapWithConcurrency(..., 3, ...) 등) 모두 "없음"을
// 보고 각자 대시보드를 만들어 같은 날짜에 중복 페이지가 생기는 문제가 있었다. withDashboardDateLock
// 으로 같은 날짜에 대해서는 이 조회+생성 전체가 한 번에 하나만 실행되도록 감싼다
// (dashboardDateLock.ts 참고).
async function findOrCreateDashboard(dateStr: string): Promise<string> {
  return withDashboardDateLock(dateStr, async () => {
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
  })
}

// [NEW, 2026-09-23] cascade-delete가 같은 페이지를 archive(휴지통 이동)하는 것과 이 함수가 그 페이지를
// 갱신하려는 것이 거의 동시에 일어나면(예: 수업 삭제 -> 그 하위 출석까지 캐스케이드 삭제되는 도중,
// 이 페이지를 대시보드에 연결하려는 웹훅/큐 처리가 겹치는 경우), Notion이 400
// "Can't edit block that is archived"를 반환한다. 이 오류가 그대로 던져지면 sync-dashboard-link/
// index.ts가 HTTP 500을 응답하고, 그러면 Notion이 해당 페이지 자동화("페이지가 생성되면 → 웹훅
// 보내기")를 비활성화해버리는 문제가 있었다 (사용자가 관찰한 "대시보드 웹훅 오류 -> 자동화 꺼짐"
// 증상의 원인). cascadeDelete()(cascadeDeleteTarget.ts)는 이미 getPage 직후 이 검사를 하고 있는데,
// 이 파일의 세 함수는 하지 않고 있었다 -- 동일한 방어 로직을 추가한다.
function isArchivedOrTrashed(page: any): boolean {
  return Boolean(page?.archived || page?.in_trash)
}

// updatePageProperties를 호출하되, 그 사이(getPage 이후) 페이지가 archive되어 이제 와서 편집이
// 거부되는 race condition은 목표(대시보드 연결 정보 갱신)가 더 이상 의미 없어진 것뿐이므로 오류로
// 취급하지 않고 조용히 스킵한다 (notionClient.ts의 archivePage()가 "이미 archived된 페이지를 다시
// archive"할 때 쓰는 것과 동일한 패턴).
// 반환값: 실제로 갱신에 성공했는지 여부 (false면 호출부가 그 뒤의 "연결됨" 로그를 남기지 않도록 함).
async function updateIfNotArchived(pageId: string, properties: Record<string, unknown>, log: string[]): Promise<boolean> {
  try {
    await updatePageProperties(pageId, properties)
    return true
  } catch (err) {
    const message = (err as Error)?.message ?? String(err)
    if (message.includes("Can't edit block that is archived")) {
      log.push(`⏭️ 갱신 도중 페이지가 삭제(archive)되어 대시보드 연결을 건너뜀: ${pageId}`)
      return false
    }
    throw err
  }
}

// 수업(학원)/출석(학원) 페이지 1건을, 자신의 "수업일시" 날짜에 해당하는 대시보드 하나에 연결한다.
export async function linkSessionOrAttendanceToDashboard(pageId: string, log: string[]): Promise<void> {
  const page = await getPage(pageId)
  if (isArchivedOrTrashed(page)) {
    log.push(`⏭️ 이미 삭제된 페이지라 대시보드 연결을 건너뜀: ${pageId}`)
    return
  }
  const iso = dateStart(page, PROP_SESSION_DATETIME)
  if (!iso) {
    log.push(`⏭️ ${PROP_SESSION_DATETIME}가 비어있어 대시보드 연결을 건너뜀: ${pageId}`)
    return
  }
  const dateStr = kstDateOnly(iso)
  const dashboardId = await findOrCreateDashboard(dateStr)
  const updated = await updateIfNotArchived(
    pageId,
    { [PROP_DASHBOARD_RELATION_ON_CHILD]: { relation: [{ id: dashboardId }] } },
    log,
  )
  if (updated) log.push(`🔗 ${pageId} -> 대시보드(${dateStr}) 연결`)
}

// 일정(학원) 페이지 1건을, 그 날짜(기간 가능)가 걸치는 모든 날의 대시보드에 전부 연결한다
// (여러 날짜 걸치는 일정은 일정 DB의 "대시보드" relation의 1개 제한을 해제해뒀어야 함).
export async function linkScheduleToDashboards(pageId: string, log: string[]): Promise<void> {
  const page = await getPage(pageId)
  if (isArchivedOrTrashed(page)) {
    log.push(`⏭️ 이미 삭제된 페이지라 대시보드 연결을 건너뜀: ${pageId}`)
    return
  }
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

  const updated = await updateIfNotArchived(
    pageId,
    { [PROP_DASHBOARD_RELATION_ON_CHILD]: { relation: dashboardIds.map((id) => ({ id })) } },
    log,
  )
  if (updated) log.push(`🔗 ${pageId} -> 대시보드 ${dashboardIds.length}건 연결 (${startDate}~${endDate})`)
}

// 대시보드(학원) 페이지 1건이 생성/갱신됐을 때, 그 날짜에 해당하는 수업/출석/일정을 전부 다시
// 모아 대시보드 자신의 관계를 재구성한다 (멱등: 항상 그 시점 기준 전체 목록으로 덮어씀).
export async function linkDashboardToChildren(dashboardPageId: string, log: string[]): Promise<void> {
  const dashboard = await getPage(dashboardPageId)
  if (isArchivedOrTrashed(dashboard)) {
    log.push(`⏭️ 이미 삭제된 대시보드 페이지라 하위 항목 연결을 건너뜀: ${dashboardPageId}`)
    return
  }
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

  const updated = await updateIfNotArchived(
    dashboardPageId,
    {
      [PROP_DASHBOARD_CLASS_SESSION]: { relation: sessions.map((p: any) => ({ id: p.id })) },
      [PROP_DASHBOARD_ATTENDANCE]: { relation: attendances.map((p: any) => ({ id: p.id })) },
      [PROP_DASHBOARD_SCHEDULE]: { relation: schedules.map((p: any) => ({ id: p.id })) },
    },
    log,
  )
  if (updated) {
    log.push(
      `🔗 대시보드(${dateStr}) <- 수업 ${sessions.length}건, 출석 ${attendances.length}건, 일정 ${schedules.length}건 연결`,
    )
  }
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
//
// [FIX, 2026-09-23] opts.skipWake: generate-classes가 시간표 하나를 처리하면서 여러 수업/출석
// 페이지를 만들 때마다(학생 수만큼) 이 함수를 반복 호출하는데, 매번 wakeSyncQueueWorker()까지
// 같이 부르면 짧은 시간에 배경(EdgeRuntime.waitUntil) HTTP 호출이 수십 건씩 겹쳐 몰린다.
// 실측 결과 전부 "Rate limit exceeded"로 실패하고 있었고, 이 배경 호출들도 같은 함수 호출의
// 전체 실행시간(플랫폼 WallClockTime 한도) 안에 포함되어 일괄 생성이 시간 초과로 죽는 문제를
// 거들고 있었을 가능성이 있다. 대시보드 연결은 지연에 관대하므로(위 HANDLERS 등록 주석 참고),
// 여러 건을 한꺼번에 큐에 넣는 호출자는 skipWake:true로 큐 적재만 반복하고, 전부 끝난 뒤 딱 한
// 번만 깨우면 충분하다 (아니면 최악의 경우에도 process-sync-queue-every-1-minute cron이 처리).
export async function enqueueDashboardLink(pageId: string, log?: string[], opts?: { skipWake?: boolean }): Promise<void> {
  try {
    await enqueueSync("sync-dashboard-link", { pageId })
    if (!opts?.skipWake) wakeSyncQueueWorker()
  } catch (err) {
    const message = (err as Error)?.message ?? String(err)
    console.error(`[enqueueDashboardLink] 큐 적재 실패 (pageId=${pageId}):`, message)
    log?.push(`⚠️ 대시보드 연결 큐 적재 실패: ${message}`)
  }
}

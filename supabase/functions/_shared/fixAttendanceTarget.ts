// _shared/fixAttendanceTarget.ts
//
// fix-attendance가 처리하는 실제 출석 조정 로직을 별도 파일로 분리했다 (2026-09-18, 큐 기반 순차
// 처리 도입, Phase 3). 원래 supabase/functions/fix-attendance/index.ts 안에 있던 코드를 그대로
// 옮긴 것이다. 웹훅 payload에서 페이지 id를 찾는 로직(resolveClassSessionId 등)은 index.ts에 그대로 둔다.
//
// (2026-09-22, PART N-4: 개별 트리거 버튼 동기화 전환) processFixAttendanceQueueItem
// (process-sync-queue 전용 진입점)은 제거했다. index.ts가 fixAttendanceForClassSession을 직접
// 호출한다.

import { getPage, queryAllPages, queryDataSource, createPage, updatePageProperties, relIds, dateStart } from "./notionClient.ts"
import {
  DS_TIMETABLE,
  DS_CLASS_SESSION,
  DS_ATTENDANCE,
  DS_REGISTRATION,
  DS_STUDY_ACTIVITY,
  PROP_LAST_ERROR,
} from "./constants.ts"
// (2026-09-21, 이식성 리팩토링) 아래 4개 데이터소스 ID는 constants.ts로 이동함 — 그 파일 상단 주석 참고.
import { markRunning, markDone, markError, type StatusSpec } from "./statusTracking.ts"

// 수업(학원) DB의 "출석조정 상태"(select) + "마지막 오류" 텍스트 필드로 진행 상황을 표시한다
// (2026-09-11: 공유 select "동기화 상태"에서 체크박스로 마이그레이션 -> 2026-09-22, Phase 3에서
// 다시 상태(select)+처리 시작 시각으로 전환. 기존 "출석조정 처리중" checkbox는 폐기. 마스터플랜 참고).
// best-effort로 갱신하며 실패해도 무시한다.
export const PROP_SHARED_LAST_ERROR = PROP_LAST_ERROR

export const ATTENDANCE_FIX_STATUS_SPEC: StatusSpec = {
  statusProp: "출석조정 상태",
  errorProp: PROP_SHARED_LAST_ERROR,
  startedAtProp: "출석조정 처리 시작 시각",
}

export async function markAttendanceFixRunning(classSessionId: string): Promise<void> {
  try {
    // 새 실행이 시작되는 순간(버튼 클릭 직후) 이전 오류를 바로 지워서, 끝날 때까지 오래된 오류
    // 텍스트가 남아있지 않도록 합니다 (2026-09-11 fix). markRunning이 상태/시작시각/오류 비움을 함께 처리.
    await markRunning(classSessionId, ATTENDANCE_FIX_STATUS_SPEC)
  } catch (err) {
    console.error("[fix-attendance] failed to set 출석조정 상태:", (err as Error).message)
  }
}

export async function markAttendanceFixDone(classSessionId: string): Promise<void> {
  try {
    await markDone(classSessionId, ATTENDANCE_FIX_STATUS_SPEC)
  } catch (err) {
    console.error("[fix-attendance] failed to clear 출석조정 상태:", (err as Error).message)
  }
}

export async function markAttendanceFixError(classSessionId: string, message: string): Promise<void> {
  try {
    await markError(classSessionId, ATTENDANCE_FIX_STATUS_SPEC, message)
  } catch (err) {
    console.error("[fix-attendance] failed to set 마지막 오류:", (err as Error).message)
  }
}

const KST_OFFSET = "+09:00"

// [start-of-day, start-of-next-day) in KST, as ISO strings, for a YYYY-MM-DD date string.
function dayRangeIso(dateStr: string): { start: string; end: string } {
  const start = `${dateStr}T00:00:00${KST_OFFSET}`
  const end = `${addDays(dateStr, 1)}T00:00:00${KST_OFFSET}`
  return { start, end }
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z")
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// ---- 학습활동(학원) DB: 대기 중인 과제 마감 백필 ----
// [PART N-11, 2026-09-23] generate-classes/index.ts에 있던 linkPendingAssignmentDeadlines를
// 여기로 가져왔다. 배경: generate-classes의 일괄 생성 체인이 "수업 생성"과 "출석 생성"을 완전히
// 분리하면서(사용자 요청), 수업 생성 시점에는 출석이 아직 없어서 이 로직이 그때는 못 돈다 -- 대신
// 출석이 실제로 만들어지는 이 시점(fixAttendanceForClassSession, 아래)에서 함께 처리해야
// 맞다. 개별 "출석 조정" 버튼에도 이 안전망이 함께 적용되는 효과가 있다(기존엔 없었음, 개선).
const PROP_ACTIVITY_CATEGORY = "구분"
const PROP_ACTIVITY_REGISTRATION = "등록"
const PROP_ACTIVITY_ATTENDANCE = "출석"
const PROP_ACTIVITY_RECORD = "학습기록"
const PROP_ACTIVITY_DEADLINE = "과제 마감"
const CATEGORY_ASSIGNMENT = "과제"
const PROP_RECORD_DATE = "수업일" // 학습기록(학원) DB
const PROP_ATTENDANCE_REGISTRATION = "등록" // 출석(학원) DB
const PROP_ATTENDANCE_CLASS_DATETIME = "수업일시" // 출석(학원) DB

// 등록 1건에 대해, "과제 마감"이 아직 비어있는 과제 학습활동들을 찾아서 그 학생의 다음 수업(출석)이
// 새로 생겨났는지 확인하고 있으면 연결한다. 출제 당시엔 다음 수업이 없어서 마감을 못 잡았던 경우,
// 나중에 출석이 생성될 때(이 함수가 호출될 때) 자동으로 채워지도록 하는 안전망이다.
async function linkPendingAssignmentDeadlines(regId: string, log: string[]) {
  const pending = await queryDataSource(DS_STUDY_ACTIVITY, {
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

    const nextAttendance = await queryDataSource(DS_ATTENDANCE, {
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

export async function fixAttendanceForClassSession(
  classSessionId: string,
  log: string[],
  opts?: { trustFrozenRegistrationsIfBare?: boolean },
) {
  const classSession = await getPage(classSessionId)
  const props = classSession.properties
  const sessionName = props["이름"]?.title?.[0]?.plain_text ?? classSessionId

  const timetableIds = relIds(props["시간표"])
  const classIds = relIds(props["클래스"])
  const dateProp = props["수업일시"]?.date
  if (timetableIds.length === 0 || classIds.length === 0 || !dateProp) {
    log.push(`[skip] ${sessionName}: missing 시간표/클래스/수업일시`)
    return
  }
  const timetableId = timetableIds[0]
  const classId = classIds[0]
  const startIso: string = dateProp.start
  const endIso: string = dateProp.end ?? dateProp.start
  const dateStr = startIso.slice(0, 10)
  // 2026-09-16 버그 수정: 시간표 -> 수업까지만 복사되던 담당강사가 출석에는 전달되지 않고
  // 있었음. 이 수업(session) 자체에 이미 복사돼 있는 담당강사를, 여기서 새로 만들거나
  // 연결하는 출석에도 함께 채운다.
  const teacherIds = relIds(props["담당강사"])

  // Existing attendance pages already linked to this specific class session. Moved up (was
  // originally queried after the 등록 재동기화 block below) so we can decide, before paying for
  // the 등록 재동기화 query, whether this session is a bare shell with zero attendance at all.
  const existingAttendance = await queryAllPages(DS_ATTENDANCE, {
    property: "수업",
    relation: { contains: classSessionId },
  })

  // Registrations active as of THIS SESSION'S OWN DATE (not "now"): 등록일 <= 수업일시 and
  // (종료일 empty or 종료일 >= 수업일시, inclusive of the 종료일 calendar day). This matches the
  // "생성 오류" formula's session-bound activeRegistrations definition on 수업(학원) DB.
  // Using current-time status here would incorrectly retroactively flag already-correct past
  // attendance as "extra"/"missing" once a registration later ends or before it starts.
  //
  // [PART N-11, 2026-09-23 후속 3차] opts.trustFrozenRegistrationsIfBare: backfill-attendance가
  // 방금 generate-classes 체인1이 만든 "출석이 하나도 없는" 새 세션을 처리할 때 쓴다. 그 세션의
  // "등록" relation은 체인1이 만든 지 얼마 안 됐고 이 함수와 완전히 동일한 활성-등록 계산으로
  // 방금 채운 것이므로, 다시 Notion에 물어볼 필요가 없다(요청 1번 절약). 출석이 이미 하나라도
  // 있는 세션(과거에 이미 조정된 적 있음 -> 등록일/종료일이 나중에 수정돼 진짜로 어긋났을 가능성이
  // 있는 세션)에는 이 지름길을 쓰지 않고 항상 원래대로 다시 물어봐서 정확하게 재동기화한다.
  let activeRegIds: Set<string>
  if (opts?.trustFrozenRegistrationsIfBare && existingAttendance.length === 0) {
    activeRegIds = new Set(relIds(props["등록"]))
    log.push(`[관계 신뢰] ${sessionName}: 출석 0건 + 방금 생성된 세션으로 보아 등록 관계를 재조회 없이 그대로 신뢰 (${activeRegIds.size}명)`)
  } else {
    const activeRegs = await queryAllPages(DS_REGISTRATION, {
      and: [
        { property: "시간표", relation: { contains: timetableId } },
        {
          or: [
            { property: "등록일", date: { on_or_before: dateStr } },
            { property: "등록일", date: { is_empty: true } },
          ],
        },
        {
          or: [
            { property: "종료일", date: { on_or_after: dateStr } },
            { property: "종료일", date: { is_empty: true } },
          ],
        },
      ],
    })
    activeRegIds = new Set(activeRegs.map((r: any) => r.id))

    // Re-sync the class session's own frozen "등록" relation to match the session-date-bound
    // active set. Handles cases where a registration's 등록일/종료일 was edited AFTER this class
    // session's "등록" relation was already set (e.g. 종료일 backdated, or 등록일 corrected),
    // which would otherwise leave a stale registration connected (or missing one that should
    // now be included).
    const currentRegIds = new Set(relIds(props["등록"]))
    const regIdsMatch =
      currentRegIds.size === activeRegIds.size && [...currentRegIds].every((id) => activeRegIds.has(id))
    if (!regIdsMatch) {
      await updatePageProperties(classSessionId, {
        등록: { relation: [...activeRegIds].map((id) => ({ id })) },
      })
      log.push(`[관계 재동기화] ${sessionName}: 등록 관계를 날짜 기준으로 재조정 (${activeRegIds.size}명)`)
    }
  }

  const attendanceByRegId = new Map<string, any[]>()
  for (const att of existingAttendance) {
    const regIds = relIds(att.properties["등록"])
    const regId = regIds[0]
    if (!regId) continue
    const list = attendanceByRegId.get(regId) ?? []
    list.push(att)
    attendanceByRegId.set(regId, list)
  }

  let createdCount = 0
  let linkedCount = 0
  let deletedFlagCount = 0

  // --- Missing: active registration with no attendance on this class session ---
  for (const regId of activeRegIds) {
    if (attendanceByRegId.has(regId)) continue

    // Look for an existing attendance page for this registration, same calendar day,
    // not yet linked to any class session.
    const { start, end } = dayRangeIso(dateStr)
    const unlinkedCandidates = await queryAllPages(DS_ATTENDANCE, {
      and: [
        { property: "등록", relation: { contains: regId } },
        { property: "수업", relation: { is_empty: true } },
        { property: "수업일시", date: { on_or_after: start } },
        { property: "수업일시", date: { before: end } },
      ],
    })

    if (unlinkedCandidates.length > 0) {
      const candidate = unlinkedCandidates[0]
      await updatePageProperties(candidate.id, {
        수업: { relation: [{ id: classSessionId }] },
        클래스: { relation: [{ id: classId }] },
        // 2026-09-16 버그 수정: 기존 미연결 출석을 새로 연결할 때도 담당강사를 채운다.
        ...(teacherIds.length ? { 담당강사: { relation: teacherIds.map((id) => ({ id })) } } : {}),
      })
      linkedCount++
      log.push(`[linked] ${sessionName}: existing unlinked attendance ${candidate.id} -> reg ${regId}`)
    } else {
      const newAttendance = await createPage(DS_ATTENDANCE, {
        출석: { title: [{ text: { content: `${dateStr} 출석` } }] },
        수업일시: { date: { start: startIso, end: endIso } },
        수업: { relation: [{ id: classSessionId }] },
        클래스: { relation: [{ id: classId }] },
        등록: { relation: [{ id: regId }] },
        // 2026-09-16 버그 수정: 수업의 담당강사를 새로 만드는 출석에도 함께 복사한다.
        ...(teacherIds.length ? { 담당강사: { relation: teacherIds.map((id) => ({ id })) } } : {}),
      })
      createdCount++
      log.push(`[created] ${sessionName}: new attendance ${newAttendance.id} for reg ${regId}`)
    }

    // [PART N-11, 2026-09-23] 출석이 실제로 (링크 또는 생성으로) 채워진 시점에, 그 학생의 대기 중인
    // 과제 마감을 이 출석에 연결할 수 있는지 확인한다 (예전엔 generate-classes 자신의 세션 생성
    // 루프에서 이 일을 했는데, 수업 생성과 출석 생성을 분리하면서 이 시점으로 옮겨왔다).
    try {
      await linkPendingAssignmentDeadlines(regId, log)
    } catch (err) {
      log.push(`[error] linkPendingAssignmentDeadlines(${regId}): ${(err as Error).message}`)
    }
  }

  // --- Extra: attendance whose registration is no longer actively enrolled ---
  for (const [regId, atts] of attendanceByRegId) {
    if (activeRegIds.has(regId)) continue
    for (const att of atts) {
      await updatePageProperties(att.id, { 삭제: { checkbox: true } })
      deletedFlagCount++
      log.push(`[flagged-extra] ${sessionName}: attendance ${att.id} (reg ${regId} not actively enrolled)`)
    }
  }

  // --- Duplicate: more than one attendance for the same (still-active) registration ---
  for (const [regId, atts] of attendanceByRegId) {
    if (!activeRegIds.has(regId)) continue // already handled above
    if (atts.length <= 1) continue
    // Keep the earliest-created page; flag the rest.
    const sorted = [...atts].sort((a, b) =>
      (a.created_time ?? "").localeCompare(b.created_time ?? ""),
    )
    const [, ...rest] = sorted
    for (const dup of rest) {
      await updatePageProperties(dup.id, { 삭제: { checkbox: true } })
      deletedFlagCount++
      log.push(`[flagged-duplicate] ${sessionName}: attendance ${dup.id} (reg ${regId} duplicate)`)
    }
  }

  if (createdCount === 0 && linkedCount === 0 && deletedFlagCount === 0) {
    log.push(`[ok] ${sessionName}: attendance already matches active registrations, nothing to fix`)
  }
}
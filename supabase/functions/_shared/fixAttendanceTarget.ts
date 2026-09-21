// _shared/fixAttendanceTarget.ts
//
// fix-attendance가 처리하는 실제 출석 조정 로직을 별도 파일로 분리했다 (2026-09-18, 큐 기반 순차
// 처리 도입, Phase 3). 원래 supabase/functions/fix-attendance/index.ts 안에 있던 코드를 그대로
// 옮긴 것이다 -- process-sync-queue 워커가 이 함수를 직접 호출해서 순차 처리할 수 있게 하기 위함.
// 웹훅 payload에서 페이지 id를 찾는 로직(resolveClassSessionId 등)은 index.ts에 그대로 둔다.

import { getPage, queryAllPages, createPage, updatePageProperties, relIds } from "./notionClient.ts"
import { DS_TIMETABLE, DS_CLASS_SESSION, DS_ATTENDANCE, DS_REGISTRATION } from "./constants.ts"
// (2026-09-21, 이식성 리팩토링) 아래 4개 데이터소스 ID는 constants.ts로 이동함 — 그 파일 상단 주석 참고.

// 수업(학원) DB의 "출석조정 처리중" 체크박스 + "마지막 오류" 텍스트 필드로 진행 상황을 표시한다
// (2026-09-11: 공유 select "동기화 상태"에서 체크박스로 마이그레이션됨). best-effort로 갱신하며 실패해도 무시한다.
export const PROP_ATTENDANCE_FIX_RUNNING = "출석조정 처리중"
export const PROP_SHARED_LAST_ERROR = "마지막 오류"

export async function markAttendanceFixRunning(classSessionId: string): Promise<void> {
  try {
    // 새 실행이 시작되는 순간(버튼 클릭 직후) 이전 오류를 바로 지워서, 끝날 때까지 오래된 오류
    // 텍스트가 남아있지 않도록 합니다 (2026-09-11 fix).
    await updatePageProperties(classSessionId, {
      [PROP_ATTENDANCE_FIX_RUNNING]: { checkbox: true },
      [PROP_SHARED_LAST_ERROR]: { rich_text: [] },
    })
  } catch (err) {
    console.error("[fix-attendance] failed to set 출석조정 처리중:", (err as Error).message)
  }
}

export async function markAttendanceFixDone(classSessionId: string): Promise<void> {
  try {
    await updatePageProperties(classSessionId, {
      [PROP_ATTENDANCE_FIX_RUNNING]: { checkbox: false },
      [PROP_SHARED_LAST_ERROR]: { rich_text: [] },
    })
  } catch (err) {
    console.error("[fix-attendance] failed to clear 출석조정 처리중:", (err as Error).message)
  }
}

export async function markAttendanceFixError(classSessionId: string, message: string): Promise<void> {
  try {
    await updatePageProperties(classSessionId, {
      [PROP_ATTENDANCE_FIX_RUNNING]: { checkbox: false },
      [PROP_SHARED_LAST_ERROR]: { rich_text: [{ text: { content: message.slice(0, 1900) } }] },
    })
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

export async function fixAttendanceForClassSession(classSessionId: string, log: string[]) {
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

  // Registrations active as of THIS SESSION'S OWN DATE (not "now"): 등록일 <= 수업일시 and
  // (종료일 empty or 종료일 >= 수업일시, inclusive of the 종료일 calendar day). This matches the
  // "생성 오류" formula's session-bound activeRegistrations definition on 수업(학원) DB.
  // Using current-time status here would incorrectly retroactively flag already-correct past
  // attendance as "extra"/"missing" once a registration later ends or before it starts.
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
  const activeRegIds = new Set(activeRegs.map((r: any) => r.id))

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

  // Existing attendance pages already linked to this specific class session.
  const existingAttendance = await queryAllPages(DS_ATTENDANCE, {
    property: "수업",
    relation: { contains: classSessionId },
  })

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

// process-sync-queue 워커가 target: "fix-attendance" 작업을 처리할 때 호출하는 진입점.
export async function processFixAttendanceQueueItem(payload: { classSessionId: string }): Promise<void> {
  const bgLog: string[] = []
  try {
    await fixAttendanceForClassSession(payload.classSessionId, bgLog)
    await markAttendanceFixDone(payload.classSessionId)
    console.log("[fix-attendance] (queue) finished:", payload.classSessionId, "\n", bgLog.join("\n"))
  } catch (err) {
    console.error(
      "[fix-attendance] (queue) ERROR:",
      (err as Error).message,
      "\nlog so far:",
      bgLog.join("\n"),
      "\nstack:",
      (err as Error).stack,
    )
    await markAttendanceFixError(payload.classSessionId, (err as Error).message)
    throw err
  }
}

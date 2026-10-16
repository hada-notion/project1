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
import { type DeadlineIO, pendingDeadlinesForRegistrations } from "./assignmentDeadline.ts"
import { getCurrentAdminKey } from "./adminShared.ts"
import { enqueueSync } from "./syncQueue.ts"

// 수업(학원) DB의 "출석조정 상태"(select) + "마지막 오류" 텍스트 필드로 진행 상황을 표시한다
// (2026-09-11: 공유 select "동기화 상태"에서 체크박스로 마이그레이션 -> 2026-09-22, Phase 3에서
// 다시 상태(select)+처리 시작 시각으로 전환. 기존 "출석조정 처리중" checkbox는 폐기. 마스터플랜 참고).
// best-effort로 갱신하며 실패해도 무시한다.
export const PROP_SHARED_LAST_ERROR = PROP_LAST_ERROR
// 출석 DB의 "삭제"는 버튼이고, 삭제 자동화(cascade-delete)를 부르는 체크박스는 "삭제 체크"다(v2.6.11 수정 — 예전 코드는
// "삭제"에 체크를 써서 Notion이 거절했고, 초과·중복 출석 표시가 그 자리에서 오류로 끝났다).
const PROP_DELETE_CHECK = "삭제 체크"

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
// (v2.6.12) 수업추가(generate-classes)와 같은 방식으로 맞춘다: 새 출석(또는 연결한 출석)의 "과제마감 백필 대상"에
// 그 학생의 대기 과제를 넣고 "⏳ 대기열"로 두면 backfill-assignment-deadlines 큐가 "자동 마감 기준"을 지키며 연결한다.
// 예전 linkPendingAssignmentDeadlines는 학생마다 활동·출석을 하나씩 읽어 바로 연결했고, 자동 마감 기준을 보지 않았다.
const PROP_ATTENDANCE_BACKFILL_TARGET = "과제마감 백필 대상"
const PROP_ATTENDANCE_BACKFILL_STATUS = "과제마감 백필 상태"
const deadlineIO: DeadlineIO = { getPage, query: queryDataSource, update: updatePageProperties, attendanceDb: DS_ATTENDANCE, activityDb: DS_STUDY_ACTIVITY }
const normId = (id: string) => id.replace(/-/g, "").toLowerCase()
function backfillProps(targets: string[] | undefined): Record<string, unknown> {
  return targets && targets.length
    ? { [PROP_ATTENDANCE_BACKFILL_TARGET]: { relation: targets.map((id) => ({ id })) }, [PROP_ATTENDANCE_BACKFILL_STATUS]: { select: { name: "⏳ 대기열" } } }
    : {}
}
// 대기열에 넣은 백필을 바로 처리하도록 워커를 깨운다(실패해도 pg_cron이 10분마다 처리).
function wakeDeadlineWorker(): void {
  const base = Deno.env.get("SB_URL")
  if (!base) return
  const p = getCurrentAdminKey()
    .then((key) => fetch(`${base}/functions/v1/backfill-assignment-deadlines`, { method: "POST", headers: { "Content-Type": "application/json", "x-admin-key": key }, body: JSON.stringify({ source: "wake" }) }))
    .catch((err) => console.error("[fix-attendance] 과제 마감 워커 깨우기 실패(예약 실행이 처리):", (err as Error)?.message))
  const rt = (globalThis as any).EdgeRuntime
  if (rt && typeof rt.waitUntil === "function") rt.waitUntil(p)
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
  // 보강 수업("보강" 체크)은 모인 학생으로 진행하는 임시 수업이라 등록 현황과 맞추지 않는다. 보강 수업은
  // 시간표·클래스 없이 만들어 아래 조건에도 걸리지만, 실수로 연결돼 있어도 보강 출석을 건드리지 않게 먼저 막는다(v2.5.64).
  if (props["보강"]?.checkbox === true) {
    log.push(`[skip] ${sessionName}: 보강 수업`)
    return
  }
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
  const missingRegIds = [...activeRegIds].filter((id) => !attendanceByRegId.has(id))
  const deadlines = missingRegIds.length ? await pendingDeadlinesForRegistrations(deadlineIO, missingRegIds) : new Map<string, string[]>()
  for (const regId of missingRegIds) {
    const backfill = backfillProps(deadlines.get(normId(regId)))

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
        ...backfill,
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
        ...backfill,
      })
      createdCount++
      log.push(`[created] ${sessionName}: new attendance ${newAttendance.id} for reg ${regId}`)
    }
  }
  if ([...deadlines.values()].some((v) => v.length)) wakeDeadlineWorker()

  // --- Extra: attendance whose registration is no longer actively enrolled ---
  for (const [regId, atts] of attendanceByRegId) {
    if (activeRegIds.has(regId)) continue
    for (const att of atts) {
      await updatePageProperties(att.id, { [PROP_DELETE_CHECK]: { checkbox: true } })
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
      await updatePageProperties(dup.id, { [PROP_DELETE_CHECK]: { checkbox: true } })
      deletedFlagCount++
      log.push(`[flagged-duplicate] ${sessionName}: attendance ${dup.id} (reg ${regId} duplicate)`)
    }
  }

  if (createdCount === 0 && linkedCount === 0 && deletedFlagCount === 0) {
    log.push(`[ok] ${sessionName}: attendance already matches active registrations, nothing to fix`)
  }
}
// ---------- v2.6.11 웹훅 재정리 2단계: 수업의 "출석 조정 정보" 수식으로 조회 없이 처리 ----------
// 수업(학원) DB 수식 "출석 조정 정보"가 이 수업 날짜에 다녀야 할 등록(시간표의 등록 중 등록일 ≤ 수업일 ≤ 종료일)과
// 지금 출석을 비교해 JSON 한 줄을 만든다. Notion 자동화("출석조정 상태"가 ⚪ 대기로 바뀌면)가 이 값과 클래스·수업일시·담당강사·
// 보강을 웹훅 본문에 싣고, 서버는 Notion을 읽지 않고 쓰기만 한다. 수식은 관계 25개 제한이 없다.
//   { "v":1, "day":"YYYY-MM-DD", "skip":"사유"(있으면 아무것도 안 함),
//     "add":[{"reg":등록id,"att":같은 날 수업 없는 출석id 또는 "","rec":[이 수업의 학습기록 중 그 등록 것]}],
//     "del":[명단 밖·중복 출석 id], "roster":[다녀야 할 등록 id](지금 수업 명단과 다를 때만) }
// Notion 호출: 출석 연결·생성 수 + 삭제 표시 수 + 학생별 과제 마감 확인 + 수업 쓰기 1(명단 + 완료).
export type FixPlan = {
	v: 1
	day?: string
	skip?: string
	add: { reg: string; att?: string; rec?: string[] }[]
	del: string[]
	roster?: string[]
	makeup?: boolean // (v2.6.17) 수식 "mk":1 — 보강 수업(합치기만)
}
export type FixSession = { id: string; classIds: string[]; teacherIds: string[]; start: string | null; end: string | null; makeup: boolean }

const ID = /^[0-9a-f]{32}$/
const cleanId = (v: unknown): string | null => {
	const s = String(v ?? "").replace(/-/g, "").toLowerCase()
	return ID.test(s) ? s : null
}
// 수식 값이 아니면(속성이 없거나 형식이 다르면) null → 예전 방식(fixAttendanceForClassSession)으로 처리한다.
export function planFromText(text: unknown): FixPlan | null {
	if (typeof text !== "string" || !text.trim()) return null
	let raw: any
	try { raw = JSON.parse(text) } catch { return null }
	if (!raw || raw.v !== 1) return null
	if (typeof raw.skip === "string" && raw.skip) return { v: 1, skip: raw.skip, add: [], del: [] }
	if (!Array.isArray(raw.add) || !Array.isArray(raw.del)) return null
	const add: FixPlan["add"] = []
	for (const a of raw.add) {
		const reg = cleanId(a?.reg)
		if (!reg) return null
		add.push({ reg, att: cleanId(a?.att) ?? undefined, rec: (Array.isArray(a?.rec) ? a.rec : []).map(cleanId).filter(Boolean) as string[] })
	}
	const del = raw.del.map(cleanId)
	if (del.some((x: string | null) => !x)) return null
	let roster: string[] | undefined
	if (raw.roster !== undefined) {
		if (!Array.isArray(raw.roster)) return null
		roster = raw.roster.map(cleanId)
		if (roster!.some((x) => !x)) return null
	}
	return { v: 1, day: typeof raw.day === "string" ? raw.day : undefined, add, del, roster, ...(raw.mk === 1 ? { makeup: true } : {}) }
}

const propText = (p: any): string => {
	if (!p) return ""
	if (p.type === "formula" || p.formula) return String(p.formula?.string ?? "")
	if (Array.isArray(p.rich_text)) return p.rich_text.map((t: any) => t.plain_text ?? t.text?.content ?? "").join("")
	return ""
}

// Notion 자동화 웹훅 본문에서 계획과 수업 정보를 꺼낸다. 하나라도 없으면 null.
export function planFromWebhookBody(body: any, sessionId: string): { plan: FixPlan; session: FixSession } | null {
	const p = body?.data?.properties
	if (!p || typeof p !== "object") return null
	const plan = planFromText(propText(p["출석 조정 정보"]))
	if (!plan) return null
	if (!Array.isArray(p["클래스"]?.relation) || !("수업일시" in p)) return null
	return {
		plan,
		session: {
			id: sessionId,
			classIds: relIds(p["클래스"]),
			teacherIds: relIds(p["담당강사"]),
			start: p["수업일시"]?.date?.start ?? null,
			end: p["수업일시"]?.date?.end ?? null,
			makeup: p["보강"]?.checkbox === true,
		},
	}
}

export async function applyFixPlan(session: FixSession, plan: FixPlan, log: string[], extraSessionProps: Record<string, unknown> = {}) {
	const finish = async (props: Record<string, unknown>) => {
		const all = { ...props, ...extraSessionProps }
		if (Object.keys(all).length) await updatePageProperties(session.id, all)
	}
	if (plan.skip) {
		log.push(`[skip] ${session.id}: ${plan.skip}`)
		return await finish({})
	}
	// (v2.6.17) 보강 수업은 예외로 다룬다: 합치기만 한다. 명단에 있는데 출석이 없으면 만들거나 연결하고(수식이 같은 날
	// 🔵 보강 출석만 고름), 출석은 있는데 명단에 없으면 수식이 명단(roster)에 더한다. 지우기는 하지 않는다(사람이 직접).
	// 예전 수식(보강이면 skip)을 쓰는 운영은 위에서 그대로 건너뛴다. 보강 출석에는 과제 마감을 연결하지 않는다
	// (정규 수업의 다음 출석이 마감이 된다). 보강 수업은 클래스가 없을 수 있다(보강 대기실에서 만든 수업).
	// 웹훅 본문에 "보강"이 빠져도 수식의 mk 표시로 보강 수업임을 안다(정규 규칙으로 지우는 일이 없게 두 곳에서 확인).
	const makeup = session.makeup || plan.makeup === true
	if (makeup && plan.del.length) log.push(`[keep] ${session.id}: 보강 수업이라 출석 ${plan.del.length}건을 지우지 않음`)
	const del = makeup ? [] : plan.del
	if (!session.start || (!makeup && !session.classIds.length)) throw new Error("수업일시·클래스가 없어 출석을 맞출 수 없어요.")
	// 안전장치: 다녀야 할 학생이 0명으로 계산됐는데 출석을 지우라는 계획은 실행하지 않는다(수식 오류일 가능성이 크다 —
	// 처음 만든 수식이 날짜를 글자로 비교해 모든 출석을 지우라고 계산한 적이 있다). 반 전체 종료는 손으로 정리한다.
	if (plan.roster && plan.roster.length === 0 && del.length > 0) {
		throw new Error(`다녀야 할 학생이 0명인데 출석 ${del.length}건을 지우라는 계산이 나왔어요. "출석 조정 정보" 수식을 확인해 주세요. 반 학생이 모두 종료됐다면 출석은 직접 정리해 주세요.`)
	}
	const day = plan.day ?? session.start.slice(0, 10)
	const classId = session.classIds[0]
	const classRel = classId ? { 클래스: { relation: [{ id: classId }] } } : {}
	const teacher = session.teacherIds.length ? { 담당강사: { relation: session.teacherIds.map((id) => ({ id })) } } : {}

	// 1) 출석이 없는 등록: 같은 날 수업 없는 출석이 있으면 연결, 없으면 새로 만든다(이 수업 학습기록·대기 과제 백필도 함께).
	//    대기 과제는 학생 전원을 한 번에 조회한다.
	const deadlines = plan.add.length && !makeup ? await pendingDeadlinesForRegistrations(deadlineIO, plan.add.map((a) => a.reg)) : new Map<string, string[]>()
	for (const a of plan.add) {
		const backfill = backfillProps(deadlines.get(normId(a.reg)))
		if (a.att) {
			await updatePageProperties(a.att, { 수업: { relation: [{ id: session.id }] }, ...classRel, ...teacher, ...backfill })
			log.push(`[linked] ${session.id}: attendance ${a.att} -> reg ${a.reg}`)
		} else {
			await createPage(DS_ATTENDANCE, {
				출석: { title: [{ text: { content: `${day} ${makeup ? "보강" : "출석"}` } }] },
				수업일시: { date: { start: session.start, end: session.end ?? session.start } },
				수업: { relation: [{ id: session.id }] },
				...classRel,
				...(makeup ? { "출석 상태": { select: { name: "🔵 보강" } } } : {}),
				등록: { relation: [{ id: a.reg }] },
				...(a.rec?.length ? { 학습기록: { relation: a.rec.map((id) => ({ id })) } } : {}),
				...teacher,
				...backfill,
			})
			log.push(`[created] ${session.id}: attendance for reg ${a.reg}`)
		}
	}
	if ([...deadlines.values()].some((v) => v.length)) wakeDeadlineWorker()
	// 2) 명단 밖·중복 출석: 삭제 체크 → 출석마다 삭제 자동화(cascade-delete)
	for (const id of del) {
		await updatePageProperties(id, { [PROP_DELETE_CHECK]: { checkbox: true } })
		log.push(`[flagged] ${session.id}: attendance ${id}`)
	}
	// 3) 수업 명단(수식이 다를 때만 보냄) + 완료를 수업 쓰기 한 번에
	await finish(plan.roster ? { 등록: { relation: plan.roster.map((id) => ({ id })) } } : {})
	if (!plan.add.length && !del.length && !plan.roster) log.push(`[ok] ${session.id}: 출석이 명단과 같아요`)
}

// 큐 처리(워커가 한 건씩). 계획이 있으면 쓰기만, 없으면 예전 방식으로 수업을 읽어 맞춘다. 실패하면 오류를 쓰고 큐 재시도.
export async function processFixAttendanceQueueItem(payload: { pageId: string; plan?: FixPlan | null; session?: FixSession | null }): Promise<void> {
	const log: string[] = []
	const done = { [ATTENDANCE_FIX_STATUS_SPEC.statusProp]: { select: { name: "✅ 완료" } }, [ATTENDANCE_FIX_STATUS_SPEC.errorProp]: { rich_text: [] } }
	try {
		// 본문에 계획이 없으면 수업 페이지를 한 번 읽어 수식 값을 쓴다. Notion 자동화는 여러 DB를 거치는 수식을
		// "권한 없는 DB를 참조"한다며 웹훅에 싣지 못하게 막지만, 서버 연결은 페이지 조회로 수식 결과를 받는다.
		let parsed = payload.plan && payload.session ? { plan: payload.plan, session: payload.session } : null
		let page: any = null
		if (!parsed) {
			page = await getPage(payload.pageId)
			parsed = planFromWebhookBody({ data: { properties: page.properties } }, payload.pageId)
		}
		if (parsed) await applyFixPlan(parsed.session, parsed.plan, log, done)
		else {
			// 수식 속성이 없는 운영(아직 v2.6.11 Notion 작업 전)은 예전 방식으로 수업을 읽어 맞춘다.
			await fixAttendanceForClassSession(payload.pageId, log)
			await updatePageProperties(payload.pageId, done)
		}
	} catch (err) {
		// (v2.6.13) 본문에 실려 온 계획으로 하다 실패했으면, 같은 계획으로 다시 하지 않는다(이미 만든 출석을 또 만들 수 있음).
		// 계획 없는 새 항목을 넣어 다음 처리 때 수업 페이지를 새로 읽고 정말 빠진 것만 맞춘다. 페이지를 읽은 경우는 큐 재시도.
		if (payload.plan) {
			console.error("[fix-attendance] 본문 계획으로 처리 중 실패 → 페이지를 새로 읽는 항목으로 다시 넣음:", payload.pageId, (err as Error).message)
			await enqueueSync("fix-attendance", { pageId: payload.pageId })
			return
		}
		await markError(payload.pageId, ATTENDANCE_FIX_STATUS_SPEC, (err as Error).message).catch(() => {})
		throw err
	} finally {
		console.log("[fix-attendance] queue finished:", payload.pageId, "\n", log.join("\n"))
	}
}

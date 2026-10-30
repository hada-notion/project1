// _shared/routineCheck.ts
//
// (v2.8.0 루틴, 항목 18) 단어 암기·일기·연습처럼 "했다/안 했다"만 보는 숙제를 수업 날 출석 체크하듯 기록한다.
// 루틴은 칸이 아니라 행이다. 루틴(학원) DB(이름·클래스·쉬기)에 한 줄을 더하면 코드·속성을 고치지 않아도
// 체크 명단과 학부모 리포트에 저절로 한 줄씩 늘어난다.
//
// 수업 [루틴 체크 생성] → create-class-reports/routine-checks → 큐 "routine-checks"
//   = 이 수업 클래스의 루틴(쉬기 아님) × 이 수업 출석 → 루틴 체크 행(루틴·출석·수업·등록, 했음 꺼짐).
//   이미 있는 (출석, 루틴) 짝은 건너뛴다(두 번 눌러도, 출석이 늘어난 뒤 다시 눌러도 빠진 것만).
// 리포트(reportCacheBuilder)는 등록의 루틴 체크를 읽어 { name, date, done }으로 싣는다. 날짜는 출석(없으면 수업)의 수업일시.
//
// DB id는 전용 Secret 없이 관계에서 찾는다: 루틴 체크 DB = 수업 DB '루틴 체크' 관계, 루틴 DB = 클래스 DB '루틴' 관계.
// 칸이 없는 운영(루틴을 아직 안 쓰는 학원)은 리포트에서 조용히 빈 목록이다.
import { createPage, fetchWithRetry, fullRelationIds, getPage, notionHeaders, queryAllPages, relIds } from "./notionClient.ts"
import { DS_CLASS_SESSION, DS_REGISTRATION, NOTION_API, PROP_LAST_ERROR } from "./constants.ts"
import { markDone, markError, markRunning, type StatusSpec } from "./statusTracking.ts"

export const ROUTINE_STATUS_SPEC: StatusSpec = {
	statusProp: "루틴 체크 상태",
	errorProp: PROP_LAST_ERROR,
	startedAtProp: "루틴 체크 처리 시작 시각",
}
export const TARGET_ROUTINE_CHECKS = "routine-checks"
export const ROUTINE_BUTTON = "[루틴 체크 생성]"
export type RoutineChecksPayload = { sessionId: string }

// 루틴 체크(학원) DB 칸 / 루틴(학원) DB 칸
export const P_CHECK = { title: "이름", routine: "루틴", attendance: "출석", session: "수업", registration: "등록", done: "했음" } as const
export const P_ROUTINE = { title: "이름", rest: "쉬기", order: "순서" } as const
const P_SESSION_CHECKS = "루틴 체크"
const P_REGISTRATION_CHECKS = "루틴 체크"
const P_ATTENDANCE_CHECKS = "루틴 체크"

const plain = (prop: any): string => (prop?.title ?? prop?.rich_text ?? []).map((t: any) => t.plain_text ?? t.text?.content ?? "").join("").trim()
const cid = (id: unknown) => String(id ?? "").replace(/-/g, "")
const gone = (p: any) => !p || p.in_trash || p.archived

async function relationDataSourceOf(sourceDs: string, prop: string): Promise<string | null> {
	const res = await fetchWithRetry(`${NOTION_API}/data_sources/${sourceDs}`, { headers: notionHeaders() })
	if (!res.ok) throw new Error(`DB 정보 읽기 실패: ${res.status} ${await res.text()}`)
	const id = (await res.json())?.properties?.[prop]?.relation?.data_source_id
	return id ? String(id) : null
}
const dsCache = new Map<string, string | null>()
async function cachedDs(key: string, sourceDs: string, prop: string): Promise<string | null> {
	if (!dsCache.has(key)) dsCache.set(key, await relationDataSourceOf(sourceDs, prop))
	return dsCache.get(key) ?? null
}
export const checkDsFromSession = () => cachedDs("session", DS_CLASS_SESSION, P_SESSION_CHECKS)
export const checkDsFromRegistration = () => cachedDs("registration", DS_REGISTRATION, P_REGISTRATION_CHECKS)

// 루틴 체크 한 행의 속성. 제목은 "루틴 · 출석 제목"(출석 제목에 학생 이름·날짜가 있다).
export function routineCheckProps(o: { routineId: string; routineName: string; attendanceId: string; attendanceTitle: string; sessionId: string; registrationId: string | null }): Record<string, unknown> {
	return {
		[P_CHECK.title]: { title: [{ text: { content: [o.routineName, o.attendanceTitle].filter(Boolean).join(" · ") || "루틴 체크" } }] },
		[P_CHECK.routine]: { relation: [{ id: o.routineId }] },
		[P_CHECK.attendance]: { relation: [{ id: o.attendanceId }] },
		[P_CHECK.session]: { relation: [{ id: o.sessionId }] },
		...(o.registrationId ? { [P_CHECK.registration]: { relation: [{ id: o.registrationId }] } } : {}),
		[P_CHECK.done]: { checkbox: false },
	}
}

export const routineCheckDeps = {
	getPage,
	createPage,
	queryAllPages,
	fullRelationIds,
	checkDs: checkDsFromSession,
	markRunning: (id: string) => markRunning(id, ROUTINE_STATUS_SPEC),
	markDone: (id: string) => markDone(id, ROUTINE_STATUS_SPEC),
	markError: (id: string, message: string) => markError(id, ROUTINE_STATUS_SPEC, message),
}

// 큐 "루틴 체크 생성"(수업 1건).
export async function processRoutineChecksQueueItem(payload: RoutineChecksPayload): Promise<void> {
	const deps = routineCheckDeps
	const sessionId = payload.sessionId
	let plan: { routines: { id: string; name: string }[]; attendances: { id: string; title: string; reg: string | null }[]; ds: string }
	try {
		await deps.markRunning(sessionId)
		const session = await deps.getPage(sessionId)
		if (gone(session)) return
		const ds = await deps.checkDs()
		if (!ds) throw new Error(`수업 DB에 '${P_SESSION_CHECKS}' 관계가 없습니다. 루틴 체크(학원) DB를 먼저 연결해 주세요.`)
		const classId = relIds(session.properties?.["클래스"])[0]
		if (!classId) throw new Error("이 수업에 클래스가 없습니다.")
		const cls = await deps.getPage(classId)
		const routinePages = (await Promise.all((await deps.fullRelationIds(cls, "루틴")).map((id) => deps.getPage(id).catch(() => null))))
			.filter((p: any) => !gone(p) && p.properties?.[P_ROUTINE.rest]?.checkbox !== true)
			.sort((a: any, b: any) => (a.properties?.[P_ROUTINE.order]?.number ?? 999) - (b.properties?.[P_ROUTINE.order]?.number ?? 999))
		const routines = routinePages.map((p: any) => ({ id: cid(p.id), name: plain(p.properties?.[P_ROUTINE.title]) }))
		if (!routines.length) throw new Error("이 반에 쓰는 루틴이 없습니다. 클래스의 루틴 탭에서 루틴을 추가하거나 '쉬기'를 풀어 주세요.")
		const attPages = (await Promise.all((await deps.fullRelationIds(session, "출석")).map((id) => deps.getPage(id).catch(() => null)))).filter((p: any) => !gone(p))
		if (!attPages.length) throw new Error("이 수업에 출석이 없습니다. [출석 조정] 뒤에 다시 눌러 주세요.")
		const attendances = attPages.map((p: any) => ({ id: cid(p.id), title: plain(p.properties?.["출석"]) || plain(Object.values(p.properties ?? {}).find((v: any) => v?.type === "title")), reg: relIds(p.properties?.["등록"])[0] ?? null }))
		plan = { routines, attendances, ds }
	} catch (err) {
		// 설정 문제는 다시 해도 같다 → ⚠️ 오류만 남기고 큐 재시도 없음.
		await deps.markError(sessionId, (err as Error).message).catch(() => {})
		return
	}
	try {
		const existing = await deps.queryAllPages(plan.ds, { property: P_CHECK.session, relation: { contains: sessionId } })
		const have = new Set(existing.filter((p: any) => !gone(p)).map((p: any) => `${cid(relIds(p.properties?.[P_CHECK.attendance])[0])}|${cid(relIds(p.properties?.[P_CHECK.routine])[0])}`))
		let made = 0
		for (const a of plan.attendances) {
			for (const r of plan.routines) {
				if (have.has(`${a.id}|${r.id}`)) continue
				await deps.createPage(plan.ds, routineCheckProps({ routineId: r.id, routineName: r.name, attendanceId: a.id, attendanceTitle: a.title, sessionId, registrationId: a.reg }))
				made++
			}
		}
		console.log(`[routine-checks] session=${sessionId} 루틴 ${plan.routines.length} × 출석 ${plan.attendances.length} → 새로 ${made}건`)
		await deps.markDone(sessionId)
	} catch (err) {
		await deps.markError(sessionId, (err as Error).message).catch(() => {})
		throw err
	}
}

// ---------- 일일 보고서 알림톡 ----------
// 출석 한 장의 루틴 체크 → [{ name, done }](루틴 순서대로). 칸이 없거나 읽기에 실패하면 빈 목록(보고서는 루틴 없이 나간다).
export async function routineItemsForAttendance(attendance: any, deps: { getPage: typeof getPage; fullRelationIds: typeof fullRelationIds } = { getPage, fullRelationIds }): Promise<{ name: string; done: boolean }[]> {
	try {
		if (!attendance?.properties?.[P_ATTENDANCE_CHECKS]) return []
		const checks = (await Promise.all((await deps.fullRelationIds(attendance, P_ATTENDANCE_CHECKS)).map((id) => deps.getPage(id).catch(() => null)))).filter((p: any) => !gone(p))
		const routineCache = new Map<string, any>()
		const rows: { name: string; done: boolean; order: number }[] = []
		for (const c of checks) {
			const rid = relIds(c.properties?.[P_CHECK.routine])[0]
			if (!rid) continue
			if (!routineCache.has(rid)) routineCache.set(rid, await deps.getPage(rid).catch(() => null))
			const r = routineCache.get(rid)
			if (gone(r)) continue
			rows.push({ name: plain(r.properties?.[P_ROUTINE.title]), done: c.properties?.[P_CHECK.done]?.checkbox === true, order: r.properties?.[P_ROUTINE.order]?.number ?? 999 })
		}
		return rows.filter((x) => x.name).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)).map(({ name, done }) => ({ name, done }))
	} catch (err) {
		console.warn("[routine] 일일 보고서 루틴 읽기 건너뜀:", (err as Error).message)
		return []
	}
}

// ---------- 리포트 ----------
export type RoutineRow = { name: string; date: string; done: boolean }

// 등록 하나의 루틴 체크 → [{ name, date(서울 날짜), done }]. 날짜는 출석의 수업일시(attendanceIso), 없으면 수업 페이지.
// DB가 없으면 빈 목록. dateOf가 null이면(지운 출석·날짜 없음) 그 행은 뺀다.
export async function routineRowsForRegistration(
	registrationId: string,
	getCached: (id: string) => Promise<any>,
	attendanceIso: Map<string, string>,
	toSeoulDate: (iso: string | null) => string | null,
	deps: { checkDs: () => Promise<string | null>; queryAllPages: typeof queryAllPages } = { checkDs: checkDsFromRegistration, queryAllPages },
): Promise<RoutineRow[]> {
	let ds: string | null = null
	try { ds = await deps.checkDs() } catch { return [] }
	if (!ds) return []
	const rows = await deps.queryAllPages(ds, { property: P_CHECK.registration, relation: { contains: registrationId } })
	const names = new Map<string, string>()
	const out: RoutineRow[] = []
	for (const p of rows) {
		if (gone(p)) continue
		const routineId = relIds(p.properties?.[P_CHECK.routine])[0]
		if (!routineId) continue
		if (!names.has(routineId)) {
			const rp = await getCached(routineId).catch(() => null)
			names.set(routineId, gone(rp) ? "" : plain(rp?.properties?.[P_ROUTINE.title]))
		}
		const name = names.get(routineId)
		if (!name) continue
		let iso = attendanceIso.get(cid(relIds(p.properties?.[P_CHECK.attendance])[0])) ?? null
		if (!iso) {
			const sid = relIds(p.properties?.[P_CHECK.session])[0]
			const sp = sid ? await getCached(sid).catch(() => null) : null
			iso = sp?.properties?.["수업일시"]?.date?.start ?? null
		}
		const date = toSeoulDate(iso)
		if (!date) continue
		out.push({ name, date, done: p.properties?.[P_CHECK.done]?.checkbox === true })
	}
	return out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name))
}

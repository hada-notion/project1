// _shared/classRoomCopy.ts
//
// 수업 관리 복사본(v2.5.113, 설계 docs/설계-수업관리-복사본.md 2단계): Notion 수업·출석·학습기록·학습활동을
// Supabase cr_sessions·cr_attendance·cr_records·cr_activities에 맞춘다. 이 단계에서는 채우기만 하고,
// 수업 관리(class-room)는 아직 이 표를 읽지 않는다(5단계에서 전환).
//
// 맞추는 방법
//   - reconcile: 기간 안 전체를 Notion에서 다시 읽어 upsert하고, 기간 안인데 Notion에 없는 행은 지운다.
//       수업·출석 = "수업일시"가 기간 안, 학습기록·학습활동 = Notion 생성 시각이 기간 시작 이후.
//   - incremental: 표마다 Notion last_edited_time ≥ (커서 − 2분)인 페이지만 upsert. 커서는 sync_cursors(cr_*).
//       Notion에서 지운 페이지는 여기서 잡히지 않는다(reconcile이 지운다).
//   - class: 수업 하나가 속한 반의 앞뒤 수업(9주 전 ~ 5주 뒤)과 그 출석·기록·학습활동만 다시 읽는다(⟳ 새로고침용).
// 학부모 리포트 표(attendance_records 등)와는 따로다.

import { queryAllPages, getPage, mapWithConcurrency, selectName, formulaString, checkboxValue, anyTitleText } from "./notionClient.ts"
import { text, dateStartOf, relationIds, numberOf, fetchSupabaseWithRetry } from "./reportCacheShared.ts"
import { DS_CLASS_SESSION, DS_ATTENDANCE, DS_LEARNING_RECORD, DS_STUDY_ACTIVITY } from "./constants.ts"
import { runInBackground } from "./backgroundTask.ts"

type Page = Record<string, any>
type Row = Record<string, unknown>

export const COPY_TABLES = ["cr_sessions", "cr_attendance", "cr_records", "cr_activities"] as const
export type CopyTable = typeof COPY_TABLES[number]
const CURSOR_MARGIN_MS = 2 * 60 * 1000
const DAY = 86_400_000

const prop = (p: Page, name: string) => p?.properties?.[name]
const rel = (p: Page, name: string) => relationIds(prop(p, name))
const str = (p: Page, name: string) => text(prop(p, name)).trim()
const iso = (v: string | null | undefined) => (v ? new Date(v).toISOString() : null)

// 서울 날짜(YYYY-MM-DD). 날짜만 있는 값은 그대로.
export function seoulDay(v: string | null | undefined): string | null {
	if (!v) return null
	if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v
	const t = Date.parse(v)
	return Number.isNaN(t) ? null : new Date(t).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" })
}

// ---------- Notion 페이지 → 복사본 행 ----------
export function sessionRow(p: Page, classes: Map<string, { name: string; emoji: string }>): Row {
	const when = prop(p, "수업일시")?.date ?? {}
	const classIds = rel(p, "클래스"), c = classes.get(classIds[0] ?? "")
	return {
		id: p.id,
		name: anyTitleText(p),
		start_text: when.start ?? null,
		end_text: when.end ?? null,
		starts_at: iso(when.start),
		class_ids: classIds,
		class_name: c?.name ?? "",
		class_emoji: c?.emoji ?? "",
		teacher_ids: rel(p, "담당강사"),
		is_makeup: checkboxValue(p, "보강"),
		attendance_ids: rel(p, "출석"),
		record_ids: rel(p, "학습기록"),
		attendance_summary: formulaString(p, "출석현황") ?? "",
		notion_edited_at: p.last_edited_time,
	}
}

export function attendanceRow(p: Page): Row {
	return {
		id: p.id,
		session_ids: rel(p, "수업"),
		registration_id: rel(p, "등록")[0] ?? null,
		student_name: formulaString(p, "학생이름(보고서)") || str(p, "출석"),
		status: selectName(p, "출석 상태") ?? "",
		class_at: iso(dateStartOf(prop(p, "수업일시"))),
		arrived_at: iso(dateStartOf(prop(p, "등원스템프"))),
		left_at: iso(dateStartOf(prop(p, "하원스템프"))),
		memo: str(p, "메모"),
		comment: str(p, "선생님 한마디"),
		due_activity_ids: rel(p, "과제"),
		notion_edited_at: p.last_edited_time,
	}
}

// subject = 정규교재 이름 → 진도교재 이름(괄호 앞) → 주제 (수업 관리 기록 카드 제목 규칙과 같다)
export function recordRow(p: Page, bookNames: Map<string, string>): Row {
	const regular = bookNames.get(rel(p, "교재")[0] ?? ""), progress = bookNames.get(rel(p, "진도교재")[0] ?? "")
	return {
		id: p.id,
		title: anyTitleText(p),
		kind: selectName(p, "구분") ?? "",
		session_ids: rel(p, "수업"),
		book_id: rel(p, "교재")[0] ?? null,
		progress_book_id: rel(p, "진도교재")[0] ?? null,
		subject: regular || (progress ?? "").replace(/\(.*\)$/, "").trim() || str(p, "주제"),
		topic: str(p, "주제"),
		range: str(p, "범위"),
		unit: str(p, "단원"),
		content: str(p, "내용"),
		is_makeup: checkboxValue(p, "보강"),
		registration_ids: rel(p, "등록"),
		activity_ids: rel(p, "학습활동"),
		activity_status: selectName(p, "활동 생성 상태") ?? "",
		notion_edited_at: p.last_edited_time,
	}
}

export function activityRow(p: Page): Row {
	const due = dateStartOf(prop(p, "과제 마감일"))
	return {
		id: p.id,
		title: anyTitleText(p),
		record_id: rel(p, "학습기록")[0] ?? null,
		attendance_id: rel(p, "출석")[0] ?? null,
		registration_id: rel(p, "등록")[0] ?? null,
		student_name: anyTitleText(p),
		homework_status: selectName(p, "과제상태") ?? "",
		due_at: due && /T/.test(due) ? iso(due) : null,
		due_on: seoulDay(due),
		correct: numberOf(prop(p, "정답 문항")),
		total: numberOf(prop(p, "전체 문항")),
		notion_edited_at: p.last_edited_time,
	}
}

// 다른 페이지 이름(반 이름·이모지, 교재 이름). 한 번 동기화 안에서 같은 페이지는 한 번만 읽는다.
async function pageMap<T>(ids: string[], pick: (p: Page) => T): Promise<Map<string, T>> {
	const uniq = [...new Set(ids.filter(Boolean))]
	const got = await mapWithConcurrency(uniq, 6, async (id: string) => {
		try { return [id, pick(await getPage(id) as Page)] as const } catch { return null }
	})
	return new Map(got.filter(Boolean) as [string, T][])
}
const classInfoOf = (c: Page) => ({ name: anyTitleText(c), emoji: str(c, "이모지") || (c.icon?.type === "emoji" ? c.icon.emoji : "") })

export async function toSessionRows(pages: Page[]) {
	const classes = await pageMap(pages.map((p) => rel(p, "클래스")[0]), classInfoOf)
	return pages.map((p) => sessionRow(p, classes))
}
export async function toRecordRows(pages: Page[]) {
	const names = await pageMap(pages.flatMap((p) => [rel(p, "교재")[0], rel(p, "진도교재")[0]]), (b) => anyTitleText(b))
	return pages.map((p) => recordRow(p, names))
}

// ---------- Supabase ----------
const SB_URL = () => Deno.env.get("SB_URL") ?? ""
const SB_KEY = () => Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
function sbHeaders(extra: Record<string, string> = {}) {
	if (!SB_URL() || !SB_KEY()) throw new Error("SB_URL / SB_SERVICE_ROLE_KEY Secrets가 설정되어 있지 않습니다.")
	return { apikey: SB_KEY(), Authorization: `Bearer ${SB_KEY()}`, "Content-Type": "application/json", ...extra }
}
export async function upsertCopyRows(table: CopyTable, rows: Row[]): Promise<void> {
	const now = new Date().toISOString()
	for (let i = 0; i < rows.length; i += 500) {
		const res = await fetchSupabaseWithRetry(`${SB_URL()}/rest/v1/${table}?on_conflict=id`, {
			method: "POST",
			headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
			body: JSON.stringify(rows.slice(i, i + 500).map((r) => ({ ...r, synced_at: now }))),
		})
		if (!res.ok) throw new Error(`${table} upsert 실패: ${res.status} ${await res.text()}`)
	}
}
// 기간 안에 저장된 행 id(reconcile 삭제 판단용). filter는 PostgREST 조건(예: starts_at=gte.…&starts_at=lt.…).
async function selectCopyIds(table: CopyTable, filter: string): Promise<string[]> {
	const ids: string[] = []
	for (let offset = 0; ; offset += 1000) {
		const res = await fetchSupabaseWithRetry(`${SB_URL()}/rest/v1/${table}?select=id&${filter}&order=id&limit=1000&offset=${offset}`, { headers: sbHeaders() })
		if (!res.ok) throw new Error(`${table} id 조회 실패: ${res.status} ${await res.text()}`)
		const rows: { id: string }[] = await res.json()
		ids.push(...rows.map((r) => r.id))
		if (rows.length < 1000) return ids
	}
}
export async function deleteCopyRows(table: CopyTable, ids: string[]): Promise<void> {
	for (let i = 0; i < ids.length; i += 100) {
		const list = ids.slice(i, i + 100).map((id) => `"${id}"`).join(",")
		const res = await fetchSupabaseWithRetry(`${SB_URL()}/rest/v1/${table}?id=in.(${list})`, { method: "DELETE", headers: sbHeaders({ Prefer: "return=minimal" }) })
		if (!res.ok) throw new Error(`${table} 삭제 실패: ${res.status} ${await res.text()}`)
	}
}
async function getCursor(table: CopyTable): Promise<string | null> {
	const res = await fetchSupabaseWithRetry(`${SB_URL()}/rest/v1/sync_cursors?source=eq.${table}&select=last_synced_at`, { headers: sbHeaders() })
	if (!res.ok) throw new Error(`sync_cursors 조회 실패: ${res.status}`)
	return (await res.json())[0]?.last_synced_at ?? null
}
async function setCursor(table: CopyTable, at: string): Promise<void> {
	const res = await fetchSupabaseWithRetry(`${SB_URL()}/rest/v1/sync_cursors?on_conflict=source`, {
		method: "POST", headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify([{ source: table, last_synced_at: at }]),
	})
	if (!res.ok) throw new Error(`sync_cursors 저장 실패: ${res.status}`)
}

// ---------- 표별 Notion 읽기 ----------
const DS: Record<CopyTable, string> = { cr_sessions: DS_CLASS_SESSION, cr_attendance: DS_ATTENDANCE, cr_records: DS_LEARNING_RECORD, cr_activities: DS_STUDY_ACTIVITY }
async function toRows(table: CopyTable, pages: Page[]): Promise<Row[]> {
	if (table === "cr_sessions") return await toSessionRows(pages)
	if (table === "cr_records") return await toRecordRows(pages)
	return pages.map(table === "cr_attendance" ? attendanceRow : activityRow)
}

export type SyncResult = { table: CopyTable; read: number; upserted: number; deleted: number }

// reconcile: fromDays일 전 ~ toDays일 뒤. 수업·출석은 수업일시, 학습기록·학습활동은 Notion 생성 시각(기간 시작 이후).
export async function reconcileTable(table: CopyTable, fromDays = 120, toDays = 60, now = Date.now()): Promise<SyncResult> {
	const from = new Date(now - fromDays * DAY).toISOString(), to = new Date(now + toDays * DAY).toISOString()
	const byDate = table === "cr_sessions" || table === "cr_attendance"
	const filter = byDate
		? { and: [{ property: "수업일시", date: { on_or_after: from } }, { property: "수업일시", date: { before: to } }] }
		: { timestamp: "created_time", created_time: { on_or_after: from } }
	const startedAt = new Date().toISOString()
	const pages = await queryAllPages(DS[table], filter)
	const rows = await toRows(table, pages)
	await upsertCopyRows(table, rows)
	const col = table === "cr_sessions" ? "starts_at" : table === "cr_attendance" ? "class_at" : null
	let deleted = 0
	if (col) {
		const fresh = new Set(rows.map((r) => r.id as string))
		const stale = (await selectCopyIds(table, `${col}=gte.${encodeURIComponent(from)}&${col}=lt.${encodeURIComponent(to)}`)).filter((id) => !fresh.has(id))
		await deleteCopyRows(table, stale)
		deleted = stale.length
	}
	// 학습기록·학습활동은 Notion에서 지워져도 여기서 지우지 않는다. 읽을 때 수업의 학습기록 관계(cr_sessions.record_ids)·
	// 기록의 학습활동 관계(cr_records.activity_ids)에 있는 것만 쓰므로 지워진 행은 화면에 나오지 않는다.
	if (!(await getCursor(table))) await setCursor(table, startedAt)
	return { table, read: pages.length, upserted: rows.length, deleted }
}

// incremental: 커서 − 2분 이후 Notion에서 바뀐 페이지만. 커서가 없으면 먼저 reconcile을 돌려야 한다.
export async function incrementalTable(table: CopyTable): Promise<SyncResult> {
	const cursor = await getCursor(table)
	if (!cursor) throw new Error(`${table}: 아직 처음 채우기(reconcile)를 하지 않았습니다.`)
	const since = new Date(Date.parse(cursor) - CURSOR_MARGIN_MS).toISOString()
	const startedAt = new Date().toISOString()
	const pages = await queryAllPages(DS[table], { timestamp: "last_edited_time", last_edited_time: { on_or_after: since } })
	const rows = await toRows(table, pages)
	await upsertCopyRows(table, rows)
	await setCursor(table, startedAt)
	return { table, read: pages.length, upserted: rows.length, deleted: 0 }
}

// class: 수업 하나가 속한 반의 앞뒤 수업(9주 전 ~ 5주 뒤, class-room의 같은 반 범위)과 그 출석·기록·학습활동.
export async function syncClassOfSession(sessionId: string): Promise<SyncResult[]> {
	const session = await getPage(sessionId) as Page
	const classId = rel(session, "클래스")[0]
	const anchor = prop(session, "수업일시")?.date?.start
	let sessions: Page[] = [session]
	if (classId && anchor) {
		const t = Date.parse(anchor)
		sessions = await queryAllPages(DS_CLASS_SESSION, { and: [
			{ property: "클래스", relation: { contains: classId } },
			{ property: "수업일시", date: { on_or_after: new Date(t - 63 * DAY).toISOString() } },
			{ property: "수업일시", date: { before: new Date(t + 36 * DAY).toISOString() } },
		] })
	}
	const byChunks = async (ds: string, prop: string, ids: string[]) => {
		const out: Page[] = []
		for (let i = 0; i < ids.length; i += 90) out.push(...await queryAllPages(ds, { or: ids.slice(i, i + 90).map((id) => ({ property: prop, relation: { contains: id } })) }))
		return [...new Map(out.map((p) => [p.id, p])).values()]
	}
	const sIds = sessions.map((p) => p.id as string)
	const [attendance, records] = await Promise.all([byChunks(DS_ATTENDANCE, "수업", sIds), byChunks(DS_LEARNING_RECORD, "수업", sIds)])
	const activities = await byChunks(DS_STUDY_ACTIVITY, "학습기록", records.map((r) => r.id as string))
	const out: SyncResult[] = []
	for (const [table, pages] of [["cr_sessions", sessions], ["cr_attendance", attendance], ["cr_records", records], ["cr_activities", activities]] as [CopyTable, Page[]][]) {
		const rows = await toRows(table, pages)
		await upsertCopyRows(table, rows)
		out.push({ table, read: pages.length, upserted: rows.length, deleted: 0 })
	}
	return out
}

export function isCopyTable(v: unknown): v is CopyTable {
	return typeof v === "string" && (COPY_TABLES as readonly string[]).includes(v)
}
// 동기화 함수 이름(보안 설정 SECURITY_WEBHOOK_ROUTES와 같아야 한다)
export const COPY_SYNC_FUNCTION = "sync-class-room-copy"

// ---------- 함께 쓰기(v2.5.115, 4단계) ----------
// 우리 함수가 Notion에 쓴 직후 복사본도 맞춘다. 응답을 늦추지 않도록 뒤에서(runInBackground) 하고, 실패해도
// 원래 작업(Notion 쓰기)에는 영향이 없다 — 놓친 것은 5분 증분·매일 밤 대조가 맞춘다.
// 페이지를 다시 읽는 이유: 반대쪽 관계(예: 기록을 만들면 수업의 "학습기록")와 수식 값까지 Notion의 지금 상태로 맞추기 위해.

// 페이지들을 Notion에서 다시 읽어 upsert(휴지통에 간 페이지는 복사본에서 지움). 읽은 페이지를 돌려준다.
export async function mirrorPageIds(table: CopyTable, ids: string[]): Promise<Page[]> {
	const uniq = [...new Set(ids.filter(Boolean))]
	if (!uniq.length) return []
	const pages = (await mapWithConcurrency(uniq, 4, async (id: string) => {
		try { return await getPage(id) as Page } catch { return null }
	})).filter(Boolean) as Page[]
	const live = pages.filter((p) => !p.archived && !p.in_trash)
	if (live.length) await upsertCopyRows(table, await toRows(table, live))
	const gone = pages.filter((p) => p.archived || p.in_trash).map((p) => p.id as string)
	if (gone.length) await deleteCopyRows(table, gone)
	return live
}

// 테스트처럼 뒤에서 도는 작업을 원하지 않을 때 CLASS_ROOM_COPY_WRITE=off
const writeOff = () => Deno.env.get("CLASS_ROOM_COPY_WRITE") === "off"
const logMirror = (what: string, err: unknown) => console.error(`[classRoomCopy] ${what} 실패(다음 증분이 맞춤):`, (err as Error)?.message)

// 여러 표를 차례로 맞춘다(뒤에서).
export function mirrorLater(jobs: [CopyTable, string[]][]): void {
	if (writeOff()) return
	runInBackground(async () => {
		for (const [table, ids] of jobs) {
			try { await mirrorPageIds(table, ids) } catch (err) { logMirror(table, err) }
		}
	})
}

// 지운 페이지(Notion 휴지통)를 네 복사본 표에서 지운다(뒤에서). 어느 표의 페이지인지 몰라도 된다.
export function removeLater(ids: string[]): void {
	const uniq = [...new Set(ids.filter(Boolean))]
	if (!uniq.length || writeOff()) return
	runInBackground(async () => {
		for (const table of COPY_TABLES) {
			try { await deleteCopyRows(table, uniq) } catch (err) { logMirror(`${table} 삭제`, err) }
		}
	})
}

// 키오스크 등원·하원: Notion을 다시 읽지 않고 그 출석 행의 시각·상태만 고친다(행이 아직 없으면 아무 일도 없음).
export async function patchAttendanceStamp(attendanceId: string, field: "arrived_at" | "left_at", iso: string | null, status: string): Promise<void> {
	const res = await fetchSupabaseWithRetry(`${SB_URL()}/rest/v1/cr_attendance?id=eq.${encodeURIComponent(attendanceId)}`, {
		method: "PATCH",
		headers: sbHeaders({ Prefer: "return=minimal" }),
		body: JSON.stringify({ [field]: iso, ...(status ? { status } : {}), synced_at: new Date().toISOString() }),
	})
	if (!res.ok) throw new Error(`cr_attendance 스템프 실패: ${res.status} ${await res.text()}`)
}
export function patchAttendanceStampLater(attendanceId: string | null | undefined, field: "arrived_at" | "left_at", iso: string | null, status: string): void {
	if (!attendanceId || writeOff()) return
	runInBackground(async () => {
		try { await patchAttendanceStamp(attendanceId, field, iso, status) } catch (err) { logMirror("cr_attendance 스템프", err) }
	})
}

// Assignment deadline policy: own registration + nearest later attendance, not weekday timetable.
// The marker records the last system-written relation. A different/cleared value is a manual override.
export const AUTO_DEADLINE_PROP = "자동 마감 기준"
export type DeadlineIO = {
  getPage: (id: string) => Promise<any>
  query: (db: string, body: Record<string, unknown>) => Promise<any>
  update: (id: string, properties: Record<string, unknown>) => Promise<any>
  attendanceDb: string
  activityDb: string
}
export function ids(page: any, name: string): string[] {
  return (page?.properties?.[name]?.relation ?? []).map((r: any) => r.id)
}
function key(id: string) { return id.replace(/-/g, "").toLowerCase() }
function same(a: string[], b: string[]) { return a.length === b.length && a.every((id, i) => key(id) === key(b[i])) }
function live(page: any) { return page && !page.archived && !page.in_trash && !page.properties?.["삭제 체크"]?.checkbox }
export function automaticDeadlineAllowed(page: any): boolean {
  const current = ids(page, "과제 마감"), marker = ids(page, AUTO_DEADLINE_PROP)
  return (current.length === 0 && marker.length === 0) || (marker.length === 1 && same(current, marker))
}
export async function queryEveryPage(io: DeadlineIO, db: string, body: Record<string, unknown>): Promise<any[]> {
  const rows: any[] = []; let cursor: string | undefined
  do {
    const result = await io.query(db, { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) })
    rows.push(...(result.results ?? []))
    if (result.has_more && (!result.next_cursor || result.next_cursor === cursor)) throw new Error("deadline pagination cursor missing/repeated")
    cursor = result.has_more ? result.next_cursor : undefined
  } while (cursor)
  return rows
}
export async function findNextDeadline(io: DeadlineIO, registrationId: string, afterIso: string): Promise<string | null> {
  // Multiple pages if the first result is a deleted/invalid attendance. Never link across registrations.
  let cursor: string | undefined
  do {
    const result = await io.query(io.attendanceDb, {
      filter: { and: [
        { property: "등록", relation: { contains: registrationId } },
        { property: "수업일시", date: { after: afterIso } },
        { property: "삭제 체크", checkbox: { equals: false } },
      ] },
      sorts: [{ property: "수업일시", direction: "ascending" }], page_size: 10,
      ...(cursor ? { start_cursor: cursor } : {}),
    })
    for (const page of result.results ?? []) {
      const time = page.properties?.["수업일시"]?.date?.start
      if (live(page) && same(ids(page, "등록"), [registrationId]) && time && Date.parse(time) > Date.parse(afterIso)) return page.id
    }
    if (result.has_more && (!result.next_cursor || result.next_cursor === cursor)) throw new Error("attendance pagination cursor missing/repeated")
    cursor = result.has_more ? result.next_cursor : undefined
  } while (cursor)
  return null
}
// One narrow query per registration. Notion filters out completed and non-automatic existing deadlines.
export async function pendingDeadlineActivities(io: DeadlineIO, registrationId: string): Promise<string[]> {
  const rows = await queryEveryPage(io, io.activityDb, { filter: { and: [
    { property: "등록", relation: { contains: registrationId } },
    { property: "과제상태", select: { equals: "🔴 미제출" } },
    { property: "삭제 체크", checkbox: { equals: false } },
    { or: [ { property: "과제 마감", relation: { is_empty: true } }, { property: AUTO_DEADLINE_PROP, relation: { is_not_empty: true } } ] },
  ] } })
  return rows.filter(p => live(p) && same(ids(p, "등록"), [registrationId]) && automaticDeadlineAllowed(p)).map(p => p.id)
}
export async function reconcileDeadline(io: DeadlineIO, activityId: string, triggerAttendanceId: string): Promise<string> {
  const activity = await io.getPage(activityId)
  if (!live(activity) || activity.properties?.["과제상태"]?.select?.name !== "🔴 미제출" || !automaticDeadlineAllowed(activity)) return "preserved"
  const owners = ids(activity, "등록"), sources = ids(activity, "출석"), records = ids(activity, "학습기록")
  if (owners.length !== 1 || sources.length !== 1 || records.length !== 1) return "invalid_relations"
  const [trigger, source, record] = await Promise.all([io.getPage(triggerAttendanceId), io.getPage(sources[0]), io.getPage(records[0])])
  const after = source?.properties?.["수업일시"]?.date?.start
  const triggerTime = trigger?.properties?.["수업일시"]?.date?.start
  if (!live(trigger) || !live(source) || !live(record) || record.properties?.["구분"]?.select?.name !== "과제" ||
    !same(ids(trigger, "등록"), owners) || !same(ids(source, "등록"), owners) || !after || !triggerTime || Date.parse(triggerTime) <= Date.parse(after)) return "invalid_source"
  // Read the activity again before writing: preserve manual edits and changed ownership since queuing.
  const fresh = await io.getPage(activityId)
  if (!live(fresh) || fresh.properties?.["과제상태"]?.select?.name !== "🔴 미제출" || !automaticDeadlineAllowed(fresh) ||
    !same(ids(fresh, "등록"), owners) || !same(ids(fresh, "출석"), sources) || !same(ids(fresh, "학습기록"), records) ||
    !same(ids(fresh, "과제 마감"), ids(activity, "과제 마감")) || !same(ids(fresh, AUTO_DEADLINE_PROP), ids(activity, AUTO_DEADLINE_PROP))) return "changed"
  const nextId = await findNextDeadline(io, owners[0], after)
  if (!nextId) return "no_next_attendance"
  if (same(ids(fresh, "과제 마감"), [nextId]) && same(ids(fresh, AUTO_DEADLINE_PROP), [nextId])) return "unchanged"
  await io.update(activityId, {
    "과제 마감": { relation: [{ id: nextId }] },
    [AUTO_DEADLINE_PROP]: { relation: [{ id: nextId }] },
    "학습정보 수정일": { date: { start: new Date().toISOString() } },
  })
  return "updated"
}

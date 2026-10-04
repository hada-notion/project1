// Carry the small plan between self-calls; avoid re-querying every timetable at every step.
export type BulkClassItem = { id: string; nextAt: string }
export function timetableStartAt(page: any, date: string): string {
  const time = page.properties?.["등원시간(HH:mm)"]?.rich_text?.map((t: any) => t.plain_text ?? t.text?.content ?? "").join("") || "09:00"
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`invalid timetable start time: ${page.id}`)
  return `${date}T${time}:00+09:00`
}
export function orderBulkClasses(items: BulkClassItem[]): BulkClassItem[] {
  if (items.some(p => !p.id || !Number.isFinite(Date.parse(p.nextAt)))) throw new Error("invalid bulk class plan")
  if (new Set(items.map(p => p.id)).size !== items.length) throw new Error("duplicate timetable in bulk class plan")
  return [...items].sort((a, b) => Date.parse(a.nextAt) - Date.parse(b.nextAt) || a.id.localeCompare(b.id))
}
export function finishBulkStep(plan: BulkClassItem[], id: string, nextAt?: string): BulkClassItem[] {
  return orderBulkClasses([...plan.filter(p => p.id !== id), ...(nextAt ? [{ id, nextAt }] : [])])
}

// 키오스크 힌트는 조회 최적화일 뿐 인증/현재 등록 검증을 대신하지 않는다.
export const ACTIVE_KIOSK_STATUS = "🟢 수강 중"
export function compactKioskId(id: unknown): string { return String(id ?? "").replaceAll("-", "").toLowerCase() }
export function validKioskId(id: unknown): boolean { return /^[0-9a-f]{32}$/i.test(compactKioskId(id)) }
export function normalizeKioskPhone(phone: unknown): string { return String(phone ?? "").replace(/[^0-9]/g, "") }
export function kioskPhoneNumbers(page: any): string[] {
  const props = page?.properties ?? {}
  return [...new Set(["학생 연락처", "어머니 연락처", "아버지 연락처", "기타 보호자 연락처"]
    .map(name => normalizeKioskPhone(props[name]?.phone_number)).filter(phone => phone.length >= 9))]
}
export function kioskStatus(page: any): string {
  const p = page?.properties?.["수강상태"]
  return p?.formula?.string ?? p?.select?.name ?? p?.status?.name ?? ""
}
export function kioskText(p: any): string {
  if (p?.rollup?.array) return p.rollup.array.map(kioskText).find(Boolean) ?? ""
  if (p?.formula?.string) return p.formula.string
  return (p?.title ?? p?.rich_text ?? []).map((t: any) => t.plain_text ?? t.text?.content ?? "").join("")
}
export type KioskCandidate = { registrationId: string; studentName: string; className: string; phones: string[] }
export function buildKioskDirectory(registrations: any[], students: any[]): KioskCandidate[] {
  const byId = new Map(students.filter(p => !p.archived && !p.in_trash).map(p => [compactKioskId(p.id), p]))
  return registrations.filter(p => !p.archived && !p.in_trash && kioskStatus(p) === ACTIVE_KIOSK_STATUS).flatMap(reg => {
    const relations = reg.properties?.["학생정보"]?.relation ?? []
    if (relations.length !== 1 || reg.properties?.["학생정보"]?.has_more) return []
    const student = byId.get(compactKioskId(relations[0].id))
    if (!student) return []
    const phones = kioskPhoneNumbers(student)
    if (!phones.length) return []
    return [{ registrationId: reg.id, studentName: kioskText(reg.properties?.["학생이름(등록)"]) || kioskText(student.properties?.["이름"]) || "이름 미상",
      className: kioskText(reg.properties?.["클래스명(등록)"]), phones }]
  })
}
// 기존 공용 All의 50페이지 제한으로 목록을 조용히 잘라 캐시하지 않는다.
export async function queryAllKioskPages(query: (body: Record<string, unknown>) => Promise<any>, body: Record<string, unknown> = {}): Promise<any[]> {
  const rows: any[] = [], seen = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await query({ ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) })
    rows.push(...(page.results ?? []))
    if (!page.has_more) break
    if (!page.next_cursor || seen.has(page.next_cursor)) throw new Error("키오스크 목록 페이지네이션 오류")
    cursor = page.next_cursor; seen.add(cursor!)
  } while (true)
  return rows
}
export async function resolveKioskHint(args: { registrationId: string; phone: string; registrationDbId: string; studentDbId: string; getPage: (id: string) => Promise<any> }): Promise<any | null> {
  if (!validKioskId(args.registrationId)) return null
  // 목록 갱신 전 삭제된 페이지는 부작용 없이 힌트 무효로 처리한다. 다른 API 오류는 숨기지 않는다.
  const getExistingPage = async (id: string) => {
    try { return await args.getPage(id) }
    catch (error) { if (/page fetch failed: 404(?:\s|$)/.test(String(error))) return null; throw error }
  }
  const reg = await getExistingPage(args.registrationId)
  if (!reg) return null
  const parentId = reg.parent?.database_id ?? reg.parent?.data_source_id
  if (reg.archived || reg.in_trash || compactKioskId(parentId) !== compactKioskId(args.registrationDbId) || kioskStatus(reg) !== ACTIVE_KIOSK_STATUS) return null
  const relations = reg.properties?.["학생정보"]?.relation ?? []
  if (relations.length !== 1 || reg.properties?.["학생정보"]?.has_more || !validKioskId(relations[0].id)) return null
  const student = await getExistingPage(relations[0].id)
  if (!student) return null
  const studentParent = student.parent?.database_id ?? student.parent?.data_source_id
  if (student.archived || student.in_trash || compactKioskId(studentParent) !== compactKioskId(args.studentDbId) || !kioskPhoneNumbers(student).includes(normalizeKioskPhone(args.phone))) return null
  return reg
}

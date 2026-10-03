import { idFromString } from "./notionClient.ts"
import { type NeisRow, eventGrades, ownedProperties, textOf } from "./neisSchool.ts"
export function academicRange(now = new Date(), requested?: unknown) {
  const kst = new Date(now.getTime() + 9 * 3600000)
  const current = kst.getUTCFullYear() - (kst.getUTCMonth() < 2 ? 1 : 0)
  const year = requested === undefined ? current : Number(requested)
  if (!Number.isInteger(year) || year < 2000 || year > current + 1) throw new Error("학년도 형식/범위 오류")
  const end = new Date(Date.UTC(year + 1, 2, 0)).toISOString().slice(0, 10).replaceAll("-", "")
  return { year, from: `${year}0301`, to: end }
}
export function sameOwnedEvent(page: any, row: NeisRow, schoolId: string, key: string, gradeIds: string[]) {
  const props = ownedProperties(row, schoolId, key, gradeIds)
  return textOf(page, "이름") === row.EVENT_NM &&
    page.properties?.["날짜"]?.date?.start === props["날짜"].date.start &&
    !page.properties?.["날짜"]?.date?.end &&
    page.properties?.["구분"]?.select?.name === "🏫 학사 일정" &&
    textOf(page, "원본 행사내용") === (row.EVENT_CNTNT ?? "") &&
    textOf(page, "수업공제일명") === (row.SBTR_DD_SC_NM ?? "") &&
    textOf(page, "대상 학년") === (eventGrades(row).map(n => `${n}학년`).join(", ") || "미지정") &&
    JSON.stringify((page.properties?.["학년"]?.relation ?? []).map((r: any) => r.id).sort()) === JSON.stringify([...gradeIds].sort())
}

export function buttonSchoolId(body: any): string | null {
  // 보낸 학교의 ID만 읽는다. source.automation_id/작성자 ID는 학교 ID로 사용하지 않는다.
  for (const value of [body?.pageId, body?.pageUrl, body?.data?.id, body?.data?.url, body?.id, body?.url]) {
    if (typeof value === "string") { const id = idFromString(value); if (id) return id }
  }
  return null
}

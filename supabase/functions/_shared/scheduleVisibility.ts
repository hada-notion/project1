// 내부 운영 표시 여부와 학부모 공개 여부를 분리한다. 누락/잘못된 공개 값은 비공개.
export const NOTICE_VISIBILITY_POLICY = 1
const PUBLIC_CATEGORIES = new Set(["📆 학원 일정", "🏫 학사 일정", "💤 휴원"])
export function isParentPublicEvent(page: any): boolean {
  const p = page?.properties
  return !page?.archived && !page?.in_trash &&
    p?.["숨김"]?.checkbox === false &&
    p?.["학부모 공개"]?.checkbox === true &&
    PUBLIC_CATEGORIES.has(p?.["구분"]?.select?.name)
}
// 기존 캐시에는 공개 결정의 근거가 없다. 재동기화 전까지 일정만 비공개로 반환한다.
export function publicNoticeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const { notice_visibility_policy, notices, ...rest } = fields
  return { ...rest, notices: notice_visibility_policy === NOTICE_VISIBILITY_POLICY && Array.isArray(notices) ? notices : [] }
}

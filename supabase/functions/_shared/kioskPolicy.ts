// 키오스크 등원·하원 처리 방식(v2.5.39). 키오스크 설정에서 기기마다 고르고, 요청 body.mode로 온다.
//   once  (1일 1회, 기본값): 그날 이미 찍힌 스템프가 있으면 덮어쓰지 않고 "이미 처리"로 안내한다.
//   every (매번 기록): 누를 때마다 새 시각으로 덮어쓰고 알림톡을 보낸다(외출·재입장 등).
// 두 방식 모두 같은 버튼을 RECENT_REPEAT_MS 안에 다시 누르면 실수로 두 번 누른 것으로 보고 무시한다
// (응답을 기다리다 다시 누르는 경우 학부모가 같은 알림을 연달아 받지 않게). 바꿀 때는 이 파일만 고친다.
export type KioskCheckMode = "once" | "every"
export const RECENT_REPEAT_MS = 2 * 60 * 1000

export function kioskCheckMode(value: unknown): KioskCheckMode {
  return value === "every" ? "every" : "once"
}

// write: 새로 기록 / already: 1일 1회라 그대로 둠 / recent: 방금(2분 안) 같은 버튼이라 무시
export function decideStamp(mode: KioskCheckMode, existingIso: string | null | undefined, nowMs: number): "write" | "already" | "recent" {
  if (!existingIso) return "write"
  const at = Date.parse(existingIso)
  if (Number.isFinite(at) && nowMs - at >= 0 && nowMs - at < RECENT_REPEAT_MS) return "recent"
  return mode === "every" ? "write" : "already"
}

// 정규 수업이 없는 날 방문(보강)으로 출석을 새로 만들 때 넣을 속성(v2.7.9).
// 출석 `클래스`는 원본처럼 `등록`을 거친 롤업일 수도, 운영 학원처럼 직접 관계일 수도 있다. 롤업에는 값을 쓸 수 없으므로
// 먼저 클래스를 넣어 만들고, Notion이 `클래스` 때문에 거절하면(isClassPropertyError) 클래스 없이 다시 만든다.
export function walkInAttendanceProperties(o: {
  title: string
  registrationId: string
  nowIso: string
  stampProp: string
  classIds: string[]
  teacherIds: string[]
  includeClass: boolean
}): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    "출석": { title: [{ text: { content: o.title.slice(0, 200) } }] },
    "등록": { relation: [{ id: o.registrationId }] },
    "출석 상태": { select: { name: "🔵 보강" } },
    "수업일시": { date: { start: o.nowIso } },
  }
  if (o.includeClass && o.classIds.length) properties["클래스"] = { relation: o.classIds.map((id) => ({ id })) }
  if (o.teacherIds.length) properties["담당강사"] = { relation: o.teacherIds.map((id) => ({ id })) }
  properties[o.stampProp] = { date: { start: o.nowIso } }
  return properties
}

// notionCreatePage 오류 문구가 `클래스` 속성 때문에 거절된 400인지
export function isClassPropertyError(message: string): boolean {
  return /\b400\b/.test(message) && message.includes("클래스")
}

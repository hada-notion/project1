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

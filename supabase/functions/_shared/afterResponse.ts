// 응답을 보낸 뒤에도 끝까지 처리할 작업. Supabase Edge Runtime이면 waitUntil에 맡기고(돌려주는 값 없음),
// 그 기능이 없는 환경(로컬 테스트 등)에서는 작업 Promise를 돌려줘서 호출자가 기다릴 수 있게 한다.
export function runAfterResponse(promise: Promise<unknown>): Promise<unknown> | void {
  const edgeRuntime = (globalThis as Record<string, unknown>).EdgeRuntime as
    | { waitUntil?: (p: Promise<unknown>) => void }
    | undefined
  if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
    edgeRuntime.waitUntil(promise)
    return
  }
  return promise
}

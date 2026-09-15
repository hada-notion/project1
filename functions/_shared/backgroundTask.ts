// _shared/backgroundTask.ts
//
// 문제 상황(2026-09-10, 강다은 학생으로 전체 흐름 테스트 중 실제 발생):
// Notion 버튼의 "웹훅 보내기" 자동화는 이 Edge Function의 HTTP 응답을 동기적으로 기다린다.
// 여러 학생/여러 등록/여러 진도교재를 한 번에 처리하는 등 실제 작업이 오래 걸리면, 작업 자체는
// 끝까지 정상적으로 끝나더라도 Notion이 기다리다 지쳐 "버튼 실행 실패: 웹훅 요청 시간이
// 초과되었습니다" 알림을 띄운다 — 사용자 입장에서는 실패한 것처럼 보이지만 실제로는 다 처리됨.
//
// 해결: 요청을 받으면 (1) 빠르게 끝나는 유효성 검사/중복실행 방지 락 체크까지만 동기로 하고,
// (2) Notion에는 곧바로 202 응답을 돌려줘서 더 이상 기다리지 않게 하고,
// (3) 실제 무거운 처리는 EdgeRuntime.waitUntil로 백그라운드에서 계속 실행한다.
// 진행 상태/완료 여부는 각 함수가 이미 쓰고 있는 "동기화 상태"/"삭제 상태"/"생성 상태" 속성으로
// Notion 화면에서 직접 확인한다 (버튼의 응답 body를 볼 필요가 없어짐).
//
// EdgeRuntime은 Supabase Edge Function(Deno Deploy) 런타임에서 전역으로 제공되는 객체다.
// 로컬 테스트 등 EdgeRuntime이 없는 환경에서도 안전하게 동작하도록, 없으면 그냥
// fire-and-forget으로 백그라운드 프로미스를 실행한다 (약간의 조기 종료 위험은 있지만 로컬
// 테스트 목적이라 실제 배포 환경 동작에는 영향 없음).
export function runInBackground(task: () => Promise<void>): void {
	const promise = task().catch((err) => {
		console.error("[runInBackground] background task failed:", (err as Error)?.message, (err as Error)?.stack)
	})
	const edgeRuntime = (globalThis as Record<string, unknown>).EdgeRuntime as
		| { waitUntil?: (p: Promise<unknown>) => void }
		| undefined
	if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
		edgeRuntime.waitUntil(promise)
	}
}

// Notion 웹훅이 더 기다리지 않도록 즉시 돌려주는 202 응답. 실제 결과는 Notion 페이지의
// 상태 속성(동기화 상태/삭제 상태/생성 상태)으로 확인한다.
export function respondAccepted(extra: Record<string, unknown> = {}): Response {
	return new Response(JSON.stringify({ ok: true, accepted: true, ...extra }, null, 2), {
		status: 202,
		headers: { "Content-Type": "application/json" },
	})
}

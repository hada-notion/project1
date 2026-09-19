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

// [FIX, 2026-09-19] 이 202 응답에는 CORS 헤더(Access-Control-Allow-Origin 등)가 없었다.
// Notion 자동화(서버-to-서버 웹훅)는 브라우저가 아니라서 지금까지는 문제가 안 됐지만,
// student_report.html의 "동기화" 버튼처럼 브라우저에서 직접 sync-report-cache를 호출하는
// 경우에는 프리플라이트(OPTIONS)는 통과해도 실제 POST 202 응답에 CORS 헤더가 없어서 브라우저가
// 응답을 읽지 못하고 fetch()가 그대로 실패했다(서버는 정상 처리해 큐에 잘 쌓였는데도 화면에는
// "동기화에 실패했어요"로만 보였음). 이 파일을 쓰는 다른 Notion 웹훅 전용 함수들도 이미 전부
// CORS를 "*"로 허용하고 있어서, 여기서도 동일하게 맞춰도 안전하다.
export function respondAccepted(extra: Record<string, unknown> = {}): Response {
	return new Response(JSON.stringify({ ok: true, accepted: true, ...extra }, null, 2), {
		status: 202,
		headers: {
			"Content-Type": "application/json",
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
			"Access-Control-Allow-Methods": "POST, GET, OPTIONS",
		},
	})
}

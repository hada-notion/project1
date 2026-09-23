// Supabase Edge Function: sync-failure-audit
//
// (2026-09-23, 🚨 동기화 실패 알림(학원) DB 통합) sync_queue에서 재시도(최대 3회)를 모두 소진하고
// 영구 실패(status='failed')로 확정된 항목을 주기적으로 스캔해서, "자동화 로그(학원) DB"(기존
// "전송로그(학원) DB"를 확장)에 요약 1건을 기록한다.
//
// 배경: "🚨 동기화 실패 알림(학원) DB"가 2026-09-18에 스키마만 만들어진 채, 실제로 이 DB에 쓰는
// Edge Function이나 cron이 하나도 없어서 항상 비어 있었다(자동화 검수 체크리스트에서 발견).
// 별도 DB를 계속 두는 대신, 기존 전송 로그 DB를 넓혀서 "자동화 로그" 하나로 통합하고, 이 함수가
// 실제로 그 자리를 채운다.
//
// 동작: sync_queue.audited_at이 비어있는 status='failed' 항목을 모두 가져와 target별로 묶어
// 건수를 세고, 대표 오류 메시지 몇 개를 요약에 붙인다. 항목이 있으면 자동화 로그 DB에 1건을
// 남기고, 보고한 항목들의 audited_at을 채운다(다음 스캔에서 중복 보고되지 않도록). 항목이 없으면
// 로그를 남기지 않고 조용히 종료한다(소음 방지).
//
// 요청: POST, 헤더 x-admin-key 필요. pg_cron(20260923010000 마이그레이션, 30분마다)이 이 함수를
// 호출한다. process-sync-queue-every-minute/status-watchdog-every-5-minutes와 동일한 패턴.

import { requireAdminKey, createSyncFailureLogEntry } from "../_shared/adminShared.ts"
import { getUnauditedFailedSyncQueueItems, markSyncQueueItemsAudited } from "../_shared/syncQueue.ts"

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
	"Access-Control-Allow-Methods": "POST, OPTIONS",
}

Deno.serve(async (req) => {
	if (req.method === "OPTIONS") {
		return new Response(null, { headers: CORS_HEADERS })
	}

	const authError = await requireAdminKey(req)
	if (authError) return authError

	try {
		const items = await getUnauditedFailedSyncQueueItems()

		if (items.length === 0) {
			return new Response(JSON.stringify({ ok: true, failCount: 0, logged: false }), {
				status: 200,
				headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
			})
		}

		// target별 건수 집계 + 대표 오류 메시지 최대 5개까지만 요약에 포함(너무 길어지지 않게).
		const byTarget = new Map<string, number>()
		for (const item of items) {
			byTarget.set(item.target, (byTarget.get(item.target) ?? 0) + 1)
		}
		const targetSummary = Array.from(byTarget.entries())
			.map(([target, count]) => `${target}: ${count}건`)
			.join(", ")
		const sampleErrors = items
			.slice(0, 5)
			.map((item) => `#${item.id}(${item.target}): ${item.last_error ?? "(오류 메시지 없음)"}`)
			.join("\n")
		const detail = `대상별 집계 — ${targetSummary}\n\n샘플 오류:\n${sampleErrors}`

		await createSyncFailureLogEntry({ failCount: items.length, detail })
		await markSyncQueueItemsAudited(items.map((item) => item.id))

		return new Response(JSON.stringify({ ok: true, failCount: items.length, logged: true, byTarget: Object.fromEntries(byTarget) }), {
			status: 200,
			headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
		})
	} catch (err) {
		console.error("[sync-failure-audit] 실패:", (err as Error).message)
		return new Response(JSON.stringify({ error: (err as Error).message }), {
			status: 500,
			headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
		})
	}
})

// POST /functions/v1/nightly-dashboard-link-audit
// body: {} (x-admin-key 필요, GitHub Actions 매일 새벽 cron 전용)
//
// (2026-09-20) "대시보드" 자동 연결 기능의 안전망. generate-classes/kiosk-checkin은 수업/출석
// 페이지를 만든 직후 enqueueDashboardLink()를 직접 호출해서 큐에 넣는데, 그 호출 자체가 실패하면
// (예: Supabase 일시 장애) 그 페이지는 사람이 노션 화면에서 만든 게 아니라서 "페이지가 생성되면 →
// 웹훅 보내기" 자동화도 걸리지 않아 영영 대시보드에 연결되지 않을 수 있다. 매일 새벽, "오늘 편집된"
// 수업(학원)/출석(학원)/일정(학원) 페이지 중 "대시보드" relation이 비어있는 것만 골라 다시 연결을
// 시도한다 (범위를 "오늘"로 고정해서 등록이 계속 늘어나도 이 함수의 비용은 늘지 않는다 --
// nightly-report-sync-audit와 동일한 설계).
//
// 이 기능 도입 이전에 만들어진 수업/출석/일정 페이지는 "대시보드" relation이 비어있는 게 정상이므로
// (오늘 편집되지 않는 한) 이 함수가 손대지 않는다 -- 의도된 동작이며 버그가 아니다.

import { requireAdminKey, CORS_HEADERS as ADMIN_CORS } from "../_shared/adminShared.ts"
import { queryAllPages, mapWithConcurrency } from "../_shared/notionClient.ts"
import {
	DS_CLASS_SESSION,
	DS_ATTENDANCE,
	DS_SCHEDULE_EVENT,
	linkSessionOrAttendanceToDashboard,
	linkScheduleToDashboards,
} from "../_shared/dashboardLinkTarget.ts"

const PROP_DASHBOARD_RELATION = "대시보드" // 수업/출석/일정 DB 공용

function todayIsoSeoul(): string {
	// 날짜만 필요 (Notion 날짜/타임스탬프 필터는 date-only 문자열도 받는다).
	return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" })
}

// "오늘 편집됐지만 대시보드 relation이 비어있는" 페이지를 찾는다.
async function findMissing(dataSourceId: string): Promise<any[]> {
	const todayIso = todayIsoSeoul()
	return queryAllPages(dataSourceId, {
		and: [
			{ timestamp: "last_edited_time", last_edited_time: { on_or_after: todayIso } },
			{ property: PROP_DASHBOARD_RELATION, relation: { is_empty: true } },
		],
	})
}

Deno.serve(async (req: Request) => {
	if (req.method === "OPTIONS") return new Response("ok", { headers: ADMIN_CORS })

	const authError = await requireAdminKey(req)
	if (authError) return authError

	try {
		const [sessions, attendances, schedules] = await Promise.all([
			findMissing(DS_CLASS_SESSION),
			findMissing(DS_ATTENDANCE),
			findMissing(DS_SCHEDULE_EVENT),
		])

		let linked = 0
		let errors = 0
		const log: string[] = []

		const runLink = async (pageId: string, fn: (pageId: string, log: string[]) => Promise<void>) => {
			try {
				await fn(pageId, log)
				linked++
			} catch (err) {
				errors++
				console.error(`nightly-dashboard-link-audit: ${pageId} 연결 실패:`, (err as Error).message)
			}
		}

		await mapWithConcurrency(sessions, 3, (p: any) => runLink(p.id, linkSessionOrAttendanceToDashboard))
		await mapWithConcurrency(attendances, 3, (p: any) => runLink(p.id, linkSessionOrAttendanceToDashboard))
		await mapWithConcurrency(schedules, 3, (p: any) => runLink(p.id, linkScheduleToDashboards))

		return new Response(
			JSON.stringify({
				checkedSessions: sessions.length,
				checkedAttendances: attendances.length,
				checkedSchedules: schedules.length,
				linked,
				errors,
				log,
			}),
			{ headers: { ...ADMIN_CORS, "Content-Type": "application/json" } },
		)
	} catch (err) {
		return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
			status: 500,
			headers: { ...ADMIN_CORS, "Content-Type": "application/json" },
		})
	}
})

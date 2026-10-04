// Supabase Edge Function: backfill-assignment-deadlines
// Independent Notion status queue. generate-classes supplies student-owned candidate IDs.
// Each trigger attendance is only a signal: re-read the activity, protect manual overrides,
// validate registration/source/category, and find the closest later attendance across weekdays.
// Automatic provenance is stored with the deadline; legacy populated values are never inferred.
// Persist remaining targets after every item so timeout retries resume with bounded progress.
// Immediate wake + existing pg_cron fallback and status tracking are preserved.

import { queryDataSource, updatePageProperties, getPage, relIds, withTimeout } from "../_shared/notionClient.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"
import { requireAdminKey, getCurrentAdminKey } from "../_shared/adminShared.ts"
import {
	STATUS_QUEUED,
	markRunning,
	markDone,
	markError,
	markQueued,
	type StatusSpec,
} from "../_shared/statusTracking.ts"
import { DS_ATTENDANCE, DS_STUDY_ACTIVITY } from "../_shared/constants.ts"
import { reconcileDeadline } from "../_shared/assignmentDeadline.ts"

const PROP_BACKFILL_TARGET = "과제마감 백필 대상" // 출석(학원) DB, relation -> 학습활동(학원) DB

const ATTENDANCE_BACKFILL_STATUS_SPEC: StatusSpec = {
	statusProp: "과제마감 백필 상태",
	errorProp: "마지막 오류", // 출석(학원) DB의 다른 기능들과 공유하는 필드 (기존 관례).
	startedAtProp: "과제마감 백필 처리 시작 시각",
}

// (이식성 정리) 다른 함수들과 동일하게 SB_URL 환경변수로 조립한다.
const FUNCTIONS_BASE = `${Deno.env.get("SB_URL") ?? ""}/functions/v1`

// 한 항목의 실제 링크 작업(getPage 없이 이미 알고 있는 학습활동 ID들에 updatePageProperties만
// 하면 되므로 원래도 가볍지만, 개별 Notion API 호출이 응답 없이 멈추는 경우를 대비해 여전히
// withTimeout으로 감싼다 -- generate-classes의 PROCESS_TIMETABLE_TIMEOUT_MS와 동일한 값.
const LINK_TIMEOUT_MS = 100_000
// 자기호출(다음 항목으로 이어달리기) 자체가 응답 없이 멈추는 것을 방지.
const SELF_CALL_TIMEOUT_MS = 60_000
// 체인 전체 시간 한도 -- 극단적으로 많이 밀려있는 경우의 최후 안전장치 (다른 체인들과 동일하게 30분).
const CHAIN_TOTAL_BUDGET_MS = 30 * 60 * 1000

// generate-classes의 callSelf와 동일한 패턴: res.ok를 반드시 확인하고, 실패하면 짧게 재시도한
// 뒤에도 안 되면 던져서 호출부가 로그를 남기게 한다 (조용히 체인이 멈추는 사고 방지).
async function callSelf(body: Record<string, unknown>, adminKey: string): Promise<void> {
	const maxAttempts = 3
	let lastErr: Error | undefined
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const controller = new AbortController()
		const timeoutId = setTimeout(() => controller.abort(), SELF_CALL_TIMEOUT_MS)
		try {
			const res = await fetch(`${FUNCTIONS_BASE}/backfill-assignment-deadlines`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
				body: JSON.stringify(body),
				signal: controller.signal,
			})
			if (res.ok) return
			lastErr = new Error(`이어달리기 자기호출 실패: HTTP ${res.status} ${await res.text()}`)
		} catch (err) {
			lastErr = err as Error
		} finally {
			clearTimeout(timeoutId)
		}
		if (attempt < maxAttempts - 1) {
			await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt))) // 1s, 2s
		}
	}
	throw lastErr ?? new Error("이어달리기 자기호출 실패: 알 수 없는 오류")
}

async function findNextQueued(): Promise<any | null> {
	const data = await queryDataSource(DS_ATTENDANCE, {
		page_size: 1,
		filter: { property: ATTENDANCE_BACKFILL_STATUS_SPEC.statusProp, select: { equals: STATUS_QUEUED } },
	})
	return (data.results as any[])[0] ?? null
}

// 출석이 들고 있는 학생별 후보를 검토하고, 각 학생의 가장 가까운 다음 출석을 선택한다.
async function linkTargets(attendanceId: string, activityIds: string[]): Promise<void> {
  // Trigger is a wake signal, never a blindly assigned deadline. Recheck owner/manual override
  // and find the closest attendance across all timetables at execution time.
  const io = { getPage, query: queryDataSource, update: updatePageProperties, attendanceDb: DS_ATTENDANCE, activityDb: DS_STUDY_ACTIVITY }
  for (let i = 0; i < activityIds.length; i++) {
    await reconcileDeadline(io, activityIds[i], attendanceId)
    // Persist progress so a slow batch resumes at remaining targets instead of re-reading all.
    await updatePageProperties(attendanceId, {
      [PROP_BACKFILL_TARGET]: { relation: activityIds.slice(i + 1).map(id => ({ id })) },
    })
  }
}

// 체인의 한 단계: "⏳ 대기열"인 출석을 딱 1개 찾아 처리하고, 끝나면 다음 단계로 이어달리기(또는
// 더 없으면 종료)한다. 초기 웨이크(runInBackground 안)와 이어달리기 요청(isContinuation) 양쪽에서
// 공용으로 호출된다. generate-classes의 runBulkChainStep과 동일한 패턴.
async function runChainStep(opts: { chainStartedAt: number; adminKey: string; log: string[] }): Promise<void> {
	const { chainStartedAt, adminKey, log } = opts

	if (Date.now() - chainStartedAt > CHAIN_TOTAL_BUDGET_MS) {
		log.push(`[warn] backfill chain: 전체 시간 한도(30분)를 초과해 중단함 -- pg_cron 안전망이 이어서 처리함`)
		console.error("backfill-assignment-deadlines 시간 한도 초과:\n", log.join("\n"))
		return
	}

	let next: any
	try {
		next = await findNextQueued()
	} catch (err) {
		log.push(`[error] backfill chain: 대기열 조회 실패: ${(err as Error).message}`)
		console.error("backfill-assignment-deadlines 대기열 조회 실패:\n", log.join("\n"))
		return
	}

	if (!next) {
		// 더 이상 대기중인 항목이 없음 -> 체인 종료.
		console.log("backfill-assignment-deadlines finished (queue empty):\n", log.join("\n"))
		return
	}

	const attendanceId = next.id
	const activityIds = relIds(next.properties[PROP_BACKFILL_TARGET])
	await markRunning(attendanceId, ATTENDANCE_BACKFILL_STATUS_SPEC)

	if (activityIds.length === 0) {
		// 대상이 비어있는데 대기열로 표시된 이상한 상태 -- 그냥 완료로 정리한다 (재시도해도 똑같을 것).
		log.push(`[ok] ${attendanceId}: 백필 대상이 비어있음, 완료로 처리`)
		await markDone(attendanceId, ATTENDANCE_BACKFILL_STATUS_SPEC)
	} else {
		const timeoutLabel = `backfill(${attendanceId})`
		try {
			await withTimeout(linkTargets(attendanceId, activityIds), LINK_TIMEOUT_MS, timeoutLabel)
			log.push(`[done] ${attendanceId}: 학습활동 ${activityIds.length}건의 마감 검토 완료(수동값 보존 포함)`)
			await markDone(attendanceId, ATTENDANCE_BACKFILL_STATUS_SPEC)
		} catch (err) {
			const isTimeout = ((err as Error)?.message ?? "").includes(`${timeoutLabel}: 시간 제한(`)
			if (isTimeout) {
				// 개별 Notion API 호출은 각자 재시도하며 시간을 쓰다가 합쳐서 예산을 넘긴 것일 수 있다 --
				// 실제 처리 오류가 아닐 수 있으므로 "오류"로 남기지 않고 다시 "대기열"에 넣는다.
				log.push(`[requeue] ${attendanceId}: withTimeout(${LINK_TIMEOUT_MS}ms) 초과, 다시 대기열에 넣음`)
				console.error(`backfill-assignment-deadlines ${attendanceId} 처리 시간 예산 초과, 대기열 재투입:\n`, log.join("\n"))
				await markQueued(attendanceId, ATTENDANCE_BACKFILL_STATUS_SPEC)
			} else {
				log.push(`[error] ${attendanceId}: ${(err as Error).message}`)
				await markError(attendanceId, ATTENDANCE_BACKFILL_STATUS_SPEC, (err as Error)?.message ?? String(err))
			}
		}
	}

	// 다음 항목으로 이어달리기: 202(즉시 응답)만 기다리고, 실제 처리는 그 다음 호출의 백그라운드에서
	// 진행된다 -- 호출이 계속 쌓이지 않는다 (generate-classes/send-selected-notifications와 동일 패턴).
	try {
		await callSelf({ isContinuation: true, chainStartedAt }, adminKey)
	} catch (err) {
		log.push(`[error] backfill chain: 다음 단계 이어달리기 호출 실패: ${(err as Error).message}`)
		console.error("backfill-assignment-deadlines 이어달리기 실패:\n", log.join("\n"))
		// menuPageId 같은 "이 체인 전체를 대표하는 페이지"가 없으므로 오류를 남길 곳이 따로 없다 --
		// pg_cron 안전망이 다음 주기에 남은 대기열을 다시 찾아 처리한다.
	}
}

Deno.serve(async (req: Request) => {
	if (req.method !== "POST") {
		return new Response("Use POST", { status: 405 })
	}

	// generate-classes의 wakeAssignmentDeadlineWorker() (즉시 트리거) 또는 pg_cron 안전망만
	// 이 함수를 호출한다. 둘 다 관리자 키를 헤더에 넣어 호출해야 한다.
	const authError = await requireAdminKey(req)
	if (authError) return authError

	let body: any
	try {
		body = await req.json()
	} catch {
		body = undefined
	}

	const isContinuation = body?.isContinuation === true
	const chainStartedAt = isContinuation && typeof body?.chainStartedAt === "number" ? body.chainStartedAt : Date.now()

	const adminKey = await getCurrentAdminKey()
	const log: string[] = []
	runInBackground(() => runChainStep({ chainStartedAt, adminKey, log }))

	return respondAccepted({ isContinuation })
})

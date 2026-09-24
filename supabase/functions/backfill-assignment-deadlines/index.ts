// Supabase Edge Function: backfill-assignment-deadlines
//
// (2026-09-24, 분리 큐 재설계) generate-classes가 새 수업/출석을 만들 때, 그 학생의 직전 수업에
// "구분=과제"인 학습기록이 있었고 그 학습기록에 연결된 학습활동 중 아직 "과제 마감"이 비어있는
// 게 있으면, 그 학습활동 ID들을 이번에 새로 만든 출석의 "과제마감 백필 대상"(relation)에 채우고
// "과제마감 백필 상태"를 "⏳ 대기열"로 표시해서 이 함수에 넘긴다 (generate-classes/index.ts의
// computePendingDeadlineTargets 주석 참고 -- 예전엔 generate-classes 자신이 학습활동(학원) DB를
// "구분=과제 AND 과제 마감=empty"로 직접 검색했는데, 학습활동의 "구분"이 학습기록(학원) DB의
// 구분을 미러링하는 rollup으로 바뀐 뒤로 select 필터가 타입 불일치(400)로 매번 조용히 실패하고
// 있었다. 그 버그를 고치는 김에, 사용자가 명시적으로 요청한 원칙("모든 단위 작업은 분리큐로")에
// 따라 이 링크 작업 자체도 generate-classes의 세션/출석 생성 흐름과 완전히 독립된 자기 큐/체인으로
// 뽑아냈다.)
//
// 이 함수가 하는 일은 아주 좁다: "과제마감 백필 상태 == ⏳대기열"인 출석 페이지를 딱 1개 찾아서,
// 그 페이지가 이미 들고 있는 "과제마감 백필 대상" relation(학습활동 ID들 -- 이미 generate-classes가
// 계산해서 넘겨준 값이라 여기서는 검색이 전혀 필요 없음)을 그대로 읽어, 각 학습활동의 "과제 마감"
// relation을 이 출석으로 채운다. 끝나면 상태를 완료로 표시하고, 자기 자신을 다시 호출해 다음
// 대기열 항목으로 이어달리기한다 (generate-classes의 runBulkChainStep/callSelf와 완전히 동일한
// 패턴 -- 청크가 아니라 매번 1건씩 처리하는 이유도 같다: 대상 하나가 유난히 느려도 다음 항목이
// 그것 때문에 굶지 않게 하기 위함).
//
// 트리거 경로 2가지 (다른 큐/함수와 동일한 이중 안전망 구조):
//   1) generate-classes가 새 백필 대상을 만든 직후 wakeAssignmentDeadlineWorker()로 즉시 트리거
//      (지연시간 줄이기용, 실패해도 조용히 무시됨).
//   2) pg_cron이 주기적으로 호출하는 안전망 (즉시 트리거가 실패/유실되거나, 처리 중 이 함수 자체가
//      시간 예산을 다 쓰고 멈춰도 다음 주기에 이어서 처리하도록). 마이그레이션:
//      supabase/migrations/<타임스탬프>_backfill_assignment_deadlines_cron.sql
//
// 동시성 안전성: 이 큐는 Postgres 테이블이 아니라 Notion의 "과제마감 백필 상태" select 속성
// 자체가 큐다(사용자의 설계 원칙: "Notion의 상태 속성이 큐다"). generate-classes의 크론 경로는
// 여러 시간표를 동시에(TIMETABLE_CONCURRENCY=4) 처리할 수 있어서, 이 워커가 거의 같은 순간에
// 여러 번 깨어날 수 있다. 명시적인 잠금 테이블은 두지 않았다 -- 최악의 경우 두 호출이 우연히
// 같은 대기열 항목을 동시에 집어도, 이 함수가 하는 쓰기(학습활동의 "과제 마감"을 이 출석으로
// 설정)는 완전히 멱등이라 중복 실행되어도 결과가 달라지지 않는다 (runBulkChainStep도 같은 수준의
// 동시성 허용치를 이미 쓰고 있다).
//
// (참고) sync-registration-class-session(등록 "수업 생성" 버튼 경로)에도 같은 백필 필요성이
// 있는데, 그 함수는 아직 구 방식(직접 검색)을 쓰는지 별도로 확인 필요 -- 이 함수 자체는 어느
// 쪽이 채워주든 "과제마감 백필 대상"/"과제마감 백필 상태"만 보고 동작하므로 무관하다.

import { queryDataSource, updatePageProperties, relIds, withTimeout } from "../_shared/notionClient.ts"
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
import { DS_ATTENDANCE } from "../_shared/constants.ts"

const PROP_BACKFILL_TARGET = "과제마감 백필 대상" // 출석(학원) DB, relation -> 학습활동(학원) DB
const PROP_ACTIVITY_DEADLINE = "과제 마감" // 학습활동(학원) DB, relation -> 출석(학원) DB

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

// 이 출석 페이지가 이미 들고 있는 "과제마감 백필 대상" 학습활동 ID들의 "과제 마감"을 이 출석으로
// 채운다. 검색 없음 -- 전부 이미 알고 있는 ID에 대한 쓰기뿐이다.
async function linkTargets(attendanceId: string, activityIds: string[]): Promise<void> {
	await Promise.all(
		activityIds.map((activityId) =>
			updatePageProperties(activityId, {
				[PROP_ACTIVITY_DEADLINE]: { relation: [{ id: attendanceId }] },
			}),
		),
	)
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
			log.push(`[done] ${attendanceId}: 학습활동 ${activityIds.length}건의 "과제 마감"을 연결함`)
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

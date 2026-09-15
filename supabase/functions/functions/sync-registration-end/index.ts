// Supabase Edge Function: sync-registration-end
//
// 등록(학원) DB "종료 처리" 버튼 전용.
// 종료일 기준으로 아래를 "즉시" 실행한다 (수강상태 수식이 실제로 종료로 바뀌길 기다리지 않음):
//   1. 종료일 이후 날짜의 출석을 삭제(archive)하고, 함께 연결돼 있던 학습활동/학습기록도 정리한다.
//   2. 종료일 이후 날짜의 수업 페이지들에서 이 등록을 roster("등록" relation)에서 제거한다.
//   3. 시간표 관계를 전부 해제한다.
//   4. 진도교재 정리는 sync-registration-textbook의 cleanup-on-end 라우트에 위임한다
//      ("다음 교재" 상태 + 학습기록 없음 인 인스턴스만: 그룹 진도는 연결 해제, 개별 진도는 페이지 삭제.
//      진행 중/완료 상태이거나 학습기록이 있는 교재는 절대 건드리지 않음).
//
// 종료일이 없으면 아무것도 하지 않고 안내만 반환한다 (버튼을 실수로 눌러도 안전).
// 각 단계가 idempotent라 이미 처리된 등록에 다시 눌러도 안전하다 (재실행 가능).
//
// 호출 방식: body에 { pageId: "등록 페이지 id" } 를 담아 호출 ("종료 처리" 버튼용).
//
// 무거운 실제 로직(출석 삭제/수업 roster 해제/교재 정리 호출)은 sync-registration-timetable과
// 거의 동일했기 때문에 _shared/registrationSync.ts로 옮겼다. 이 파일은 그 결과를 가지고
// 기존과 똑같은 문구로 로그만 지어낸다 (로드맵: sync-* 리팩토링, 기능 변경 없음).

import {
	PROP_END_DATE,
	PROP_TITLE,
	PROP_TIMETABLE,
	PROP_SYNCED_AT,
	PROP_SYNC_END_RUNNING,
	PROP_SYNC_TIMETABLE_RUNNING,
	PROP_SYNC_TEXTBOOK_RUNNING,
	PROP_SYNC_CLASS_SESSION_RUNNING,
	PROP_SYNC_ENROLL_RUNNING,
} from "../_shared/constants.ts"
import { getPage, updatePageProperties, relIds, titleText, extractPageId, checkboxValue } from "../_shared/notionClient.ts"
import {
	archiveAttendanceAfterEndDate,
	disconnectClassSessionsAfterEndDate as disconnectClassSessionsAfterEndDateShared,
	callTextbookCleanup,
	makeSyncStatusSetter,
} from "../_shared/registrationSync.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"

const setSyncStatus = makeSyncStatusSetter(PROP_SYNC_END_RUNNING, [
	PROP_SYNC_TIMETABLE_RUNNING,
	PROP_SYNC_TEXTBOOK_RUNNING,
	PROP_SYNC_CLASS_SESSION_RUNNING,
	PROP_SYNC_ENROLL_RUNNING,
])

async function deleteAttendanceAfterEndDate(
	registrationId: string,
	endDateIso: string,
	regName: string | undefined,
	log: string[],
) {
	const { deletedCount, activityCount, recordCount } = await archiveAttendanceAfterEndDate(registrationId, endDateIso)
	if (deletedCount > 0) {
		const extra =
			activityCount || recordCount ? ` (학습활동 ${activityCount}건, 학습기록 ${recordCount}건 함께 삭제)` : ""
		log.push(`🗑️ [${regName}] 종료일 이후 출석 ${deletedCount}건 삭제${extra}`)
	} else {
		log.push(`✓ [${regName}] 종료일 이후 삭제할 출석 없음`)
	}
}

async function disconnectClassSessionsAfterEndDate(
	registrationId: string,
	endDateIso: string,
	regName: string | undefined,
	log: string[],
) {
	const { disconnectedCount } = await disconnectClassSessionsAfterEndDateShared(registrationId, endDateIso)
	if (disconnectedCount > 0) {
		log.push(`🔌 [${regName}] 종료일 이후 수업 ${disconnectedCount}건에서 이 등록 연결 해제`)
	} else {
		log.push(`✓ [${regName}] 종료일 이후 연결 해제할 수업 없음`)
	}
}

async function disconnectTimetable(registrationId: string, regName: string | undefined, log: string[]) {
	const reg = await getPage(registrationId)
	const timetableIds = relIds(reg.properties[PROP_TIMETABLE])
	if (timetableIds.length === 0) {
		log.push(`✓ [${regName}] 이미 시간표 연결 없음`)
		return
	}
	await updatePageProperties(registrationId, { [PROP_TIMETABLE]: { relation: [] } })
	log.push(`🔌 [${regName}] 시간표 연결 ${timetableIds.length}건 전부 해제`)
}

async function cleanupTextbooks(registrationId: string, regName: string | undefined, log: string[]) {
	const result = await callTextbookCleanup(registrationId)
	if (!result.ok) {
		if (result.kind === "http") {
			log.push(`⚠️ [${regName}] 교재 정리 호출 실패: ${result.status} ${result.body}`)
		} else {
			log.push(`⚠️ [${regName}] 교재 정리 호출 오류: ${result.message}`)
		}
		return
	}
	log.push(
		`📚 [${regName}] 진도교재 정리: 연결해제 ${result.unlinked.length}건, 삭제 ${result.deleted.length}건, 보존(진행중/학습기록있음) ${result.kept.length}건`,
	)
}

async function processEndForRegistration(pageId: string, log: string[]) {
	const reg = await getPage(pageId)
	const regName = titleText(reg, PROP_TITLE)
	const endDate = reg.properties[PROP_END_DATE]?.date?.start
	if (!endDate) {
		log.push(`⏭️ [${regName}] 종료일이 없어 종료 처리를 건너뜀`)
		return
	}

	// 출석 삭제와 수업 roster 해제는 서로 다른 리소스를 건드리는 독립 작업이라 동시 실행한다.
	await Promise.all([
		deleteAttendanceAfterEndDate(pageId, endDate, regName, log),
		disconnectClassSessionsAfterEndDate(pageId, endDate, regName, log),
	])
	await disconnectTimetable(pageId, regName, log)
	await cleanupTextbooks(pageId, regName, log)
}

Deno.serve(async (req: Request) => {
	if (req.method !== "POST") {
		return new Response("Use POST", { status: 405 })
	}
	const log: string[] = []
	let pageId: string | null = null
	try {
		let body: Record<string, unknown> = {}
		try {
			body = await req.json()
		} catch {
			body = {}
		}
		console.log("[sync-registration-end] received body:", JSON.stringify(body))

		pageId = extractPageId(body)
		if (!pageId) {
			return new Response(JSON.stringify({ error: "pageId를 찾을 수 없음" }), { status: 400 })
		}

		// 이미 처리 중이면(백그라운드 작업이 아직 안 끝남) 새로 시작하지 않고 즉시 반환한다 --
		// 처리 중 재클릭으로 인한 중복 생성/중복 처리를 막기 위한 락.
		const regPageForLock = await getPage(pageId)
		if (checkboxValue(regPageForLock, PROP_SYNC_END_RUNNING)) {
			return new Response(JSON.stringify({ ok: true, message: "already_processing", pageId }, null, 2), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})
		}

		await setSyncStatus(pageId, "처리중")

		// Notion의 "웹훅 보내기" 버튼 액션은 이 응답을 동기적으로 기다린다. 출석/수업/교재 정리까지
		// 함께 처리하다 보면 시간이 길어져 "버튼 실행 실패: 웹훅 요청 시간이 초과되었습니다" 알림이
		// 뜰 수 있으므로(실제로는 끝까지 정상 처리됨), 응답을 먼저 보내고 나머지는 백그라운드로 미룬다.
		// 진행 상황은 등록의 "동기화 상태"(이미 처리중으로 설정됨)로 확인할 수 있다.
		const resolvedPageId = pageId
		runInBackground(async () => {
			try {
				const bgLog: string[] = []
				await processEndForRegistration(resolvedPageId, bgLog)
				await setSyncStatus(resolvedPageId, "완료")
				console.log("[sync-registration-end] (background) finished:", resolvedPageId, "\n", bgLog.join("\n"))
			} catch (err) {
				console.error("[sync-registration-end] (background) ERROR:", (err as Error).message, (err as Error).stack)
				await setSyncStatus(resolvedPageId, "오류", (err as Error).message)
			}
		})

		return respondAccepted({ pageId })
	} catch (err) {
		console.error("[sync-registration-end] ERROR:", (err as Error).message, (err as Error).stack)
		if (pageId) {
			await setSyncStatus(pageId, "오류", (err as Error).message)
		}
		return new Response(JSON.stringify({ ok: false, error: (err as Error).message, log }, null, 2), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		})
	}
})

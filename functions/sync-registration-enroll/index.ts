// Supabase Edge Function: sync-registration-enroll
//
// 등록(학원) DB "등록" 버튼 전용 — "종료 처리" 버튼의 반대 동작.
//   1. 등록일이 비어 있으면 버튼을 누른 날짜(오늘)로 등록일을 채운다. 이미 등록일이 있으면 건드리지 않는다.
//   2. 종료일이 있으면 제거한다 (종료 처리로 종료됐던 등록을 다시 등록 상태로 되돌림).
//   3. 시간표 관계가 비어 있으면, 연결된 클래스의 시간표 전체를 그대로 등록에 연결한다.
//      이미 시간표가 연결되어 있으면 덮어쓰지 않는다 — 클래스의 시간표가 학생 개개인에게
//      완전히 똑같이 적용되지 않을 수 있어서, 한 번 수동으로 조정해 둔 값은 유지한다.
//      (기존에는 클래스 속성 편집 웹훅으로 자동 처리했지만, 이제 이 버튼으로 기능을 옮겼다.)
//
// 호출 방식: body에 { pageId: "등록 페이지 id" } 를 담아 호출 ("등록" 버튼용).

import {
	PROP_CLASS,
	PROP_ENROLL_DATE,
	PROP_END_DATE,
	PROP_TITLE,
	PROP_TIMETABLE,
	PROP_SYNCED_AT,
	PROP_SYNC_ENROLL_RUNNING,
	PROP_SYNC_TIMETABLE_RUNNING,
	PROP_SYNC_TEXTBOOK_RUNNING,
	PROP_SYNC_CLASS_SESSION_RUNNING,
	PROP_SYNC_END_RUNNING,
} from "../_shared/constants.ts"
import {
	getPage,
	updatePageProperties,
	relIds,
	titleText,
	extractPageId,
	todaySeoulDate,
	checkboxValue,
} from "../_shared/notionClient.ts"
import { makeSyncStatusSetter } from "../_shared/registrationSync.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"

const PROP_CLASS_TIMETABLE = "시간표" // 클래스(학원) DB의 시간표 relation

const setSyncStatus = makeSyncStatusSetter(PROP_SYNC_ENROLL_RUNNING, [
	PROP_SYNC_TIMETABLE_RUNNING,
	PROP_SYNC_TEXTBOOK_RUNNING,
	PROP_SYNC_CLASS_SESSION_RUNNING,
	PROP_SYNC_END_RUNNING,
])

async function processEnrollForRegistration(pageId: string, log: string[]) {
	const reg = await getPage(pageId)
	const regName = titleText(reg, PROP_TITLE)

	const updates: Record<string, unknown> = {}

	const enrollDate = reg.properties[PROP_ENROLL_DATE]?.date?.start
	if (!enrollDate) {
		const today = todaySeoulDate()
		updates[PROP_ENROLL_DATE] = { date: { start: today } }
		log.push(`📅 [${regName}] 등록일이 비어있어 오늘(${today})로 설정함`)
	} else {
		log.push(`✓ [${regName}] 이미 등록일이 있어 유지함 (${enrollDate})`)
	}

	if (reg.properties[PROP_END_DATE]?.date?.start) {
		updates[PROP_END_DATE] = { date: null }
		log.push(`🗑️ [${regName}] 종료일 제거함`)
	}

	if (Object.keys(updates).length > 0) {
		await updatePageProperties(pageId, updates)
	}

	// 시간표는 등록/종료일 변경과 별개로, 비어있을 때만 클래스 기준으로 세팅한다.
	const existingTimetables = relIds(reg.properties[PROP_TIMETABLE])
	if (existingTimetables.length > 0) {
		log.push(`✓ [${regName}] 이미 시간표가 연결되어 있어 유지함 (수동 조정 보존)`)
		return
	}

	const classIds = relIds(reg.properties[PROP_CLASS])
	if (classIds.length === 0) {
		log.push(`⏭️ [${regName}] 클래스가 연결되어 있지 않아 시간표를 세팅하지 못함`)
		return
	}

	const classPage = await getPage(classIds[0])
	const timetableIds = relIds(classPage.properties[PROP_CLASS_TIMETABLE])
	if (timetableIds.length === 0) {
		log.push(`⚠️ [${regName}] 클래스에 연결된 시간표가 없어 세팅하지 못함`)
		return
	}

	await updatePageProperties(pageId, {
		[PROP_TIMETABLE]: { relation: timetableIds.map((id: string) => ({ id })) },
	})
	log.push(`🔗 [${regName}] 클래스 기준 시간표 ${timetableIds.length}건 연결함 (필요하면 지금 수동으로 조정 후 "수업 생성"을 누르세요)`)
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
		console.log("[sync-registration-enroll] received body:", JSON.stringify(body))

		pageId = extractPageId(body)
		if (!pageId) {
			return new Response(JSON.stringify({ error: "pageId를 찾을 수 없음" }), { status: 400 })
		}

		// 이미 처리 중이면 새로 시작하지 않고 즉시 반환 -- 처리 중 재클릭으로 인한 중복 처리 방지.
		const regPageForLock = await getPage(pageId)
		if (checkboxValue(regPageForLock, PROP_SYNC_ENROLL_RUNNING)) {
			return new Response(JSON.stringify({ ok: true, message: "already_processing", pageId }, null, 2), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})
		}

		await setSyncStatus(pageId, "처리중")

		// Notion의 "웹훅 보내기" 버튼 액션은 이 응답을 동기적으로 기다린다. 처리 시간이 길어지면
		// "버튼 실행 실패: 웹훅 요청 시간이 초과되었습니다" 알림이 뜰 수 있으므로(실제로는 끝까지
		// 정상 처리됨), 응답을 먼저 보내고 나머지는 백그라운드로 미룬다. 진행 상황은 등록의
		// "동기화 상태"(이미 처리중으로 설정됨)로 확인할 수 있다.
		const resolvedPageId = pageId
		runInBackground(async () => {
			try {
				const bgLog: string[] = []
				await processEnrollForRegistration(resolvedPageId, bgLog)
				await setSyncStatus(resolvedPageId, "완료")
				console.log("[sync-registration-enroll] (background) finished:", resolvedPageId, "\n", bgLog.join("\n"))
			} catch (err) {
				console.error("[sync-registration-enroll] (background) ERROR:", (err as Error).message, (err as Error).stack)
				await setSyncStatus(resolvedPageId, "오류", (err as Error).message)
			}
		})

		return respondAccepted({ pageId })
	} catch (err) {
		console.error("[sync-registration-enroll] ERROR:", (err as Error).message, (err as Error).stack)
		if (pageId) {
			await setSyncStatus(pageId, "오류", (err as Error).message)
		}
		return new Response(JSON.stringify({ ok: false, error: (err as Error).message, log }, null, 2), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		})
	}
})

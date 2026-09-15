// Supabase Edge Function: sync-registration-class-session
//
// 등록(학원) DB "수업 생성" 버튼 전용.
// 연결된 시간표의 기존 수업(수업 학원 DB) 각각에 대해 이 등록의 출석을 생성/연결한다.
//   - 새 수업 페이지는 만들지 않는다 (그건 generate-classes가 시간표를 기준으로 반복 생성하는 몫).
//   - 등록일~종료일(있으면) 범위 안의 수업만 대상으로 한다.
//   - 이미 등록(roster)/출석이 연결된 수업은 건너뛰므로 종료일 변경 등으로 다시 눌러도 안전
//     (재실행 가능).
//   - 이미 만들어져 있는 학습기록이 있으면(같은 수업 + 같은 등록) 새로 만드는 출석에 바로 연결한다
//     (학습기록/학습활동을 새로 만들거나 억지로 매칭하지는 않음).
//
// 호출 방식:
//   - body에 { pageId: "등록 페이지 id" } 를 담아 호출하면 그 등록 1건만 처리 ("수업 생성" 버튼용).
//   - body 없이 호출하면 전체 스캔: 등록일이 있고 아직 종료되지 않은 모든 등록에 대해 처리
//     (cron 안전망용, 선택적).
//
// 수업/출석 생성의 실제 로직은 sync-registration-timetable의 복원(restore) 로직과 거의 동일했기
// 때문에 _shared/registrationSync.ts로 옮겼다. 이 파일은 그 결과를 가지고 기존과 똑같은 문구로
// 로그만 지어낸다 (로드맵: sync-* 리팩토링, 기능 변경 없음).

import {
	DS_REGISTRATION,
	PROP_CLASS,
	PROP_ENROLL_DATE,
	PROP_END_DATE,
	PROP_TITLE,
	PROP_STATUS,
	PROP_TIMETABLE,
	STATUS_ENDED,
	PROP_SYNCED_AT,
	PROP_SYNC_CLASS_SESSION_RUNNING,
	PROP_SYNC_TIMETABLE_RUNNING,
	PROP_SYNC_TEXTBOOK_RUNNING,
	PROP_SYNC_END_RUNNING,
	PROP_SYNC_ENROLL_RUNNING,
} from "../_shared/constants.ts"
import { queryDataSource, getPage, relIds, titleText, extractPageId, mapWithConcurrency, checkboxValue } from "../_shared/notionClient.ts"
import { attachSessionsAndAttendance, makeSyncStatusSetter } from "../_shared/registrationSync.ts"

const setSyncStatus = makeSyncStatusSetter(PROP_SYNC_CLASS_SESSION_RUNNING, [
	PROP_SYNC_TIMETABLE_RUNNING,
	PROP_SYNC_TEXTBOOK_RUNNING,
	PROP_SYNC_END_RUNNING,
	PROP_SYNC_ENROLL_RUNNING,
])

// 등록 1건에 대해, 연결된 시간표의 기존 수업들에 이 등록을 붙이고(roster) 출석을 생성한다.
// 시간표는 "등록" 버튼(sync-registration-enroll)에서 클래스 기준으로 세팅하고, 필요하면
// 담당자가 수동으로 조정한 뒤 이 함수(수업 생성 버튼)를 누르는 흐름이라 여기서는 시간표를
// 건드리지 않고 이미 연결된 시간표만 그대로 사용한다.
async function createSessionsAndAttendanceForRegistration(reg: any, log: string[]) {
	const regName = titleText(reg, PROP_TITLE)

	const enrollDate = reg.properties[PROP_ENROLL_DATE]?.date?.start
	if (!enrollDate) {
		log.push(`⏭️ [${regName}] 등록일이 없어 건너뜀`)
		return
	}

	const timetableIds = relIds(reg.properties[PROP_TIMETABLE])
	if (timetableIds.length === 0) {
		log.push(`⏭️ [${regName}] 연결된 시간표가 없어 건너뜀 ("등록" 버튼을 먼저 눌러 시간표를 연결하세요)`)
		return
	}

	const endDate = reg.properties[PROP_END_DATE]?.date?.start
	const classIds = relIds(reg.properties[PROP_CLASS])

	const {
		sessionsTouched: touchedSessions,
		attendanceCreated: createdAttendance,
		recordsLinked,
	} = await attachSessionsAndAttendance(reg, timetableIds, enrollDate, endDate, classIds)

	if (createdAttendance > 0) {
		log.push(
			`✅ [${regName}] 수업 ${touchedSessions}건 확인, 출석 ${createdAttendance}건 생성 (기존 학습기록 연결 ${recordsLinked}건)`,
		)
	} else {
		log.push(`✓ [${regName}] 이미 모든 수업/출석이 연결되어 있음 (수업 ${touchedSessions}건 확인)`)
	}
}

// 안전망: 등록일이 있고 아직 종료되지 않은 모든 등록을 훑어서 누락분을 보정한다 (선택적 cron용).
async function createSessionsForAllPending(log: string[]) {
	const data = await queryDataSource(DS_REGISTRATION, {
		filter: {
			and: [
				{ property: PROP_ENROLL_DATE, date: { is_not_empty: true } },
				{ property: PROP_TIMETABLE, relation: { is_not_empty: true } },
				{ property: PROP_STATUS, formula: { string: { does_not_equal: STATUS_ENDED } } },
			],
		},
		page_size: 100,
	})
	await mapWithConcurrency(data.results, 4, (reg: any) => createSessionsAndAttendanceForRegistration(reg, log))
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
		console.log("[sync-registration-class-session] received body:", JSON.stringify(body))

		pageId = extractPageId(body)
		console.log("[sync-registration-class-session] extracted pageId:", pageId)

		if (pageId) {
			const reg = await getPage(pageId)
			// 이미 처리 중이면 새로 시작하지 않고 즉시 반환 -- 처리 중 재클릭으로 인한 중복 출석 생성 방지.
			if (checkboxValue(reg, PROP_SYNC_CLASS_SESSION_RUNNING)) {
				return new Response(JSON.stringify({ ok: true, message: "already_processing", pageId }, null, 2), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
			}
			await setSyncStatus(pageId, "처리중")
			await createSessionsAndAttendanceForRegistration(reg, log)
			await setSyncStatus(pageId, "완료")
		} else {
			// body가 없거나 페이지를 못 찾았으면(cron용) 전체 스캔.
			await createSessionsForAllPending(log)
		}

		return new Response(JSON.stringify({ ok: true, log }, null, 2), {
			headers: { "Content-Type": "application/json" },
		})
	} catch (err) {
		console.error("[sync-registration-class-session] ERROR:", (err as Error).message, (err as Error).stack)
		if (pageId) {
			await setSyncStatus(pageId, "오류", (err as Error).message)
		}
		return new Response(JSON.stringify({ ok: false, error: (err as Error).message, log }, null, 2), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		})
	}
})

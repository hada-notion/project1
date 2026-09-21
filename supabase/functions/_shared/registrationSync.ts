// _shared/registrationSync.ts
//
// sync-registration-class-session / sync-registration-end / sync-registration-timetable
// 세 함수가 거의 그대로 복붙한 동일한 로직을 각자 들고 있었다 (출석 삭제, 수업 roster 해제,
// 수업/출석 생성 또는 복원, 진도교재 정리 호출). 이번 리팩토링에서 이 로직들을 하나로 모은다.
//
// 설계 원칙: 여기 함수들은 카운트만 리턴하고 log.push는 직접 하지 않는다. 로그 문구는
// 호출하는 쪽(class-session/end/enroll/textbook/timetable)이 각자 기존과 똑같이 작성한다.
// 함수마다 로그 문구가 조금씩 달랐기 때문에(이모지/영문 표기 차이), 그걸 여기서 통일해버리면
// 겉보기 동작(응답 로그)이 달라진다. 그래서 실제 Notion 조작 로직만 합치고, 문구는 그대로 보존한다.
//
// [FIX, 2026-09-21, PART N-2] callTextbookCleanup이 sync-registration-textbook의 cleanup-on-end
// 라우트를 호출할 때 x-admin-key 헤더를 전혀 보내지 않고 있었다. 이번 라운드에서 그 라우트를 포함해
// sync-registration-textbook 전체에 관리자 키 인증을 추가하므로, 이 내부 호출도 함께 헤더를 보내도록
// 고쳐야 한다 (안 그러면 sync-registration-end/timetable이 내부적으로 부르는 이 호출이 401로 깨짐).
// wakeSyncQueueWorker()(_shared/syncQueue.ts)가 이미 같은 패턴(getCurrentAdminKey를 읽어 헤더에 실어
// 내부 함수 호출)을 쓰고 있어서 그대로 따라간다.

import { PROP_SYNCED_AT, PROP_LAST_ERROR } from "./constants.ts"
import {
	DS_ATTENDANCE,
	DS_CLASS_SESSION,
	DS_LEARNING_RECORD,
	PROP_ATTENDANCE_TITLE,
	PROP_ATTENDANCE_REGISTRATION,
	PROP_ATTENDANCE_CLASS_DATETIME,
	PROP_ATTENDANCE_SESSION,
	PROP_ATTENDANCE_ACTIVITY,
	PROP_ATTENDANCE_LEARNING_RECORD,
	PROP_ATTENDANCE_TEACHER,
	PROP_SESSION_REGISTRATION,
	PROP_SESSION_DATETIME,
	PROP_SESSION_TIMETABLE,
	PROP_SESSION_TEACHER,
	PROP_RECORD_SESSION,
	PROP_RECORD_REGISTRATION,
	PROP_CLASS,
	TEXTBOOK_CLEANUP_URL,
} from "./constants.ts"
import {
	queryDataSource,
	updatePageProperties,
	createPage,
	archivePage,
	relIds,
	mapWithConcurrency,
	setCombinedSyncStatus,
} from "./notionClient.ts"
import { getCurrentAdminKey } from "./adminShared.ts"

// ---------- 0) "처리중/완료/오류" 상태 표시 헬퍼 ----------
// class-session/end/enroll/textbook/timetable 다섯 함수 모두 거의 동일한 setSyncStatus를 각자
// 정의하고 있었다. selfFlagProp만 다를 뿐이라 각 함수에 특화된 setSyncStatus 함수를 만들어주는
// 헬퍼로 대신한다.
// (2026-09-21 정리: 예전에는 여기서 otherFlagProps라는 두 번째 인자를 받아 setCombinedSyncStatus로
// 그대로 넘겼는데, setCombinedSyncStatus 쪽 구현이 "동기화 상태" select 조합용이었던 이 값을
// "실시간 처리 상태" 수식 도입 이후 전혀 읽지 않는 완전한 죽은 인자였다(체크박스는 노션 수식이
// 직접 실시간으로 조합해서 보여준다). sync-registration-textbook의 호출부가 이 목록에서
// PROP_SYNC_ENROLL_RUNNING 하나를 빠뜨리고 있었지만, 애초에 아무 데도 쓰이지 않는 값이라 실제
// 동작 차이는 없었다. 혼동을 줄이기 위해 otherFlagProps 자체를 완전히 제거했다 — 각 호출부의
// "다른 처리중 플래그 목록"도 함께 제거했으니 이제 이 불일치 자체가 존재하지 않는다.)
//
// [NEW, 2026-09-17] startedAtProp: 선택적으로 넘기면 "처리중"이 시작된 시각을 함께 기록한다.
// 호출부가 나중에 이 시각을 확인해서, 락이 너무 오래(예: 10분 이상) 켜져 있으면 "이전 실행이
// 응답 없이 멈춘 것"으로 보고 무시할 수 있게 하기 위함이다 (교재 일괄 배부 재클릭 시 무한 멈춤
// 자동 복구 목적). 넘기지 않으면 기존과 100% 동일하게 동작한다.
export function makeSyncStatusSetter(selfFlagProp: string, startedAtProp?: string) {
	return async function setSyncStatus(pageId: string, status: "처리중" | "완료" | "오류", errorMessage?: string) {
		await setCombinedSyncStatus(pageId, {
			selfFlagProp,
			errorProp: PROP_LAST_ERROR,
			syncedAtProp: PROP_SYNCED_AT,
			startedAtProp,
			phase: status === "처리중" ? "start" : status === "완료" ? "success" : "error",
			errorMessage,
		})
	}
}

// ---------- 1) 종료일 이후 출석 삭제 (+함께 딸려있던 학습활동/학습기록 정리) ----------
// sync-registration-end.deleteAttendanceAfterEndDate 와 sync-registration-timetable의 동일한
// 이름 함수를 하나로 합쳤다. 실제 Notion 조작(조회/아카이브)만 하고 개수만 리턴하며, 로그는
// 호출부가 직접 구성한다.
export async function archiveAttendanceAfterEndDate(
	registrationId: string,
	endDateIso: string,
): Promise<{ deletedCount: number; activityCount: number; recordCount: number }> {
	const data = await queryDataSource(DS_ATTENDANCE, {
		filter: {
			and: [
				{ property: PROP_ATTENDANCE_REGISTRATION, relation: { contains: registrationId } },
				{ property: PROP_ATTENDANCE_CLASS_DATETIME, date: { after: endDateIso } },
			],
		},
		page_size: 100,
	})

	// 출석을 지우기 전에, 각 출석에 연결돼 있던 학습활동/학습기록도 함께 정리 대상으로 모아둔다.
	const activityIds = new Set<string>()
	const recordIds = new Set<string>()
	for (const att of data.results) {
		for (const id of relIds(att.properties[PROP_ATTENDANCE_ACTIVITY])) activityIds.add(id)
		for (const id of relIds(att.properties[PROP_ATTENDANCE_LEARNING_RECORD])) recordIds.add(id)
	}

	await mapWithConcurrency(data.results, 4, (att: any) => archivePage(att.id))
	await mapWithConcurrency([...activityIds], 4, (id) => archivePage(id))
	await mapWithConcurrency([...recordIds], 4, (id) => archivePage(id))

	return { deletedCount: data.results.length, activityCount: activityIds.size, recordCount: recordIds.size }
}

// ---------- 2) 종료일 이후 수업에서 등록 roster 연결 해제 ----------
export async function disconnectClassSessionsAfterEndDate(
	registrationId: string,
	endDateIso: string,
): Promise<{ disconnectedCount: number }> {
	const data = await queryDataSource(DS_CLASS_SESSION, {
		filter: {
			and: [
				{ property: PROP_SESSION_REGISTRATION, relation: { contains: registrationId } },
				{ property: PROP_SESSION_DATETIME, date: { after: endDateIso } },
			],
		},
		page_size: 100,
	})
	let disconnectedCount = 0
	for (const session of data.results) {
		const remainingIds = relIds(session.properties[PROP_SESSION_REGISTRATION]).filter(
			(id: string) => id !== registrationId,
		)
		await updatePageProperties(session.id, {
			[PROP_SESSION_REGISTRATION]: { relation: remainingIds.map((id: string) => ({ id })) },
		})
		disconnectedCount++
	}
	return { disconnectedCount }
}

// ---------- 3) 수업 roster 연결 + 출석 생성/복원 (생성 버튼과 종료일 삭제/연장 후 복원이 거의 동일 로직) ----------
// - sync-registration-class-session.createSessionsAndAttendanceForRegistration 과
//   sync-registration-timetable.restoreClassSessionsAndAttendance 둘 다 이 함수를 통해 실행된다.
// - opts.retryOnEmpty: timetable의 "복원" 경로에만 있다 — 방금 종료일을 지우거나 연장해서 시간표가
//   다시 연결된 직후라 Notion 관계 필터 검색이 지연 인덱싱될 수 있어서, 비었으면 1.5초 후 한 번 더
//   지핀다 (생성 버튼 경로는 이 지연이 발생하지 않았으므로 원래 retry 없음).
export async function attachSessionsAndAttendance(
	reg: any,
	timetableIds: string[],
	enrollDate: string,
	endDate: string | undefined,
	classIds: string[],
	opts: { retryOnEmpty?: boolean } = {},
): Promise<{ sessionsTouched: number; attendanceCreated: number; recordsLinked: number }> {
	let sessionsTouched = 0
	let attendanceCreated = 0
	let recordsLinked = 0

	for (const timetableId of timetableIds) {
		const sessionFilterAnd: Record<string, unknown>[] = [
			{ property: PROP_SESSION_TIMETABLE, relation: { contains: timetableId } },
			{ property: PROP_SESSION_DATETIME, date: { on_or_after: enrollDate } },
		]
		if (endDate) {
			sessionFilterAnd.push({ property: PROP_SESSION_DATETIME, date: { on_or_before: endDate } })
		}

		let data = await queryDataSource(DS_CLASS_SESSION, {
			filter: { and: sessionFilterAnd },
			page_size: 100,
		})
		if (opts.retryOnEmpty && data.results.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 1500))
			data = await queryDataSource(DS_CLASS_SESSION, {
				filter: { and: sessionFilterAnd },
				page_size: 100,
			})
		}

		const outcomes = await mapWithConcurrency(data.results, 4, async (session: any) => {
			// roster 연결과 출석 생성은 서로 독립적으로 확인한다 — roster엔 이미 연결돼 있지만
			// 출석만 빠진 경우(이전 실행에서 부분적으로만 처리된 경우 등)에도 출석을 놓치지 않는다.
			const existingIds = relIds(session.properties[PROP_SESSION_REGISTRATION])
			if (!existingIds.includes(reg.id)) {
				await updatePageProperties(session.id, {
					[PROP_SESSION_REGISTRATION]: { relation: [...existingIds, reg.id].map((id: string) => ({ id })) },
				})
			}

			const attendanceCheck = await queryDataSource(DS_ATTENDANCE, {
				filter: {
					and: [
						{ property: PROP_ATTENDANCE_REGISTRATION, relation: { contains: reg.id } },
						{ property: PROP_ATTENDANCE_SESSION, relation: { contains: session.id } },
					],
				},
				page_size: 1,
			})
			if (attendanceCheck.results.length > 0) return { touched: true, attendance: false, linkedRecord: false }

			const sessionDate = session.properties[PROP_SESSION_DATETIME]?.date
			if (!sessionDate?.start) return { touched: true, attendance: false, linkedRecord: false }
			const dateOnly = String(sessionDate.start).slice(0, 10)

			// 시간표 -> 수업 생성 시(generate-classes) 이미 복사돼 있는 담당강사를, 출석 생성
			// 시에도 함께 복사한다 (2026-09-16 버그 수정: 이전엔 수업까지만 복사되고 출석에는
			// 전달되지 않고 있었음).
			const teacherIds = relIds(session.properties[PROP_SESSION_TEACHER])

			// 이 수업(session)에 대해 이미 만들어져 있는 학습기록이 있다면, 새로 만드는 출석에 바로 연결한다.
			const recordMatch = await queryDataSource(DS_LEARNING_RECORD, {
				filter: {
					and: [
						{ property: PROP_RECORD_SESSION, relation: { contains: session.id } },
						{ property: PROP_RECORD_REGISTRATION, relation: { contains: reg.id } },
					],
				},
				page_size: 100,
			})
			const recordIds = recordMatch.results.map((r: any) => r.id)

			await createPage(DS_ATTENDANCE, {
				[PROP_ATTENDANCE_TITLE]: { title: [{ text: { content: `${dateOnly} 출석` } }] },
				[PROP_ATTENDANCE_CLASS_DATETIME]: { date: { start: sessionDate.start, end: sessionDate.end ?? null } },
				[PROP_ATTENDANCE_SESSION]: { relation: [{ id: session.id }] },
				...(classIds.length ? { [PROP_CLASS]: { relation: [{ id: classIds[0] }] } } : {}),
				[PROP_ATTENDANCE_REGISTRATION]: { relation: [{ id: reg.id }] },
				...(recordIds.length
					? { [PROP_ATTENDANCE_LEARNING_RECORD]: { relation: recordIds.map((id: string) => ({ id })) } }
					: {}),
				...(teacherIds.length
					? { [PROP_ATTENDANCE_TEACHER]: { relation: teacherIds.map((id: string) => ({ id })) } }
					: {}),
			})
			return { touched: true, attendance: true, linkedRecord: recordIds.length > 0 }
		})

		sessionsTouched += outcomes.filter((o) => o.touched).length
		attendanceCreated += outcomes.filter((o) => o.attendance).length
		recordsLinked += outcomes.filter((o) => o.linkedRecord).length
	}

	return { sessionsTouched, attendanceCreated, recordsLinked }
}

// ---------- 4) 진도교재 정리 호출 (sync-registration-textbook의 cleanup-on-end 라우트) ----------
// class-session/end/timetable 세 함수가 모두 동일한 fetch로 이 라우트를 호출하는데, 결과 해석/로깅
// 문구는 함수마다 조금씩 다르므로 여기서는 fetch + 파싱만 담당하고, 로깅은 호출부가 직접 구성한다.
// end.ts와 timetable.ts가 http-실패(!res.ok)와 fetch 예외(catch)를 서로 다른 로그 문구로 지어왔다
// ("호출 실패" vs "호출 오류" / "call failed" vs "call error"). 그 원인 구분을 kind 필드로 그대로 넘겨준다.
//
// [FIX, 2026-09-21, PART N-2] cleanup-on-end 라우트에 관리자 키 인증을 추가하면서, 이 내부 호출도
// x-admin-key 헤더를 실어 보내도록 고쳤다 (이전에는 헤더 없이 호출해서 인증을 추가하는 즉시 이
// 내부 호출이 401로 깨질 뻔했다).
export async function callTextbookCleanup(
	registrationId: string,
): Promise<
	| { ok: true; unlinked: string[]; deleted: string[]; kept: string[] }
	| { ok: false; kind: "http"; status: number; body: string }
	| { ok: false; kind: "exception"; message: string }
> {
	try {
		const adminKey = await getCurrentAdminKey()
		const res = await fetch(TEXTBOOK_CLEANUP_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
			body: JSON.stringify({ pageId: registrationId }),
		})
		if (!res.ok) {
			return { ok: false, kind: "http", status: res.status, body: await res.text() }
		}
		const json = await res.json()
		return {
			ok: true,
			unlinked: json?.result?.unlinked ?? [],
			deleted: json?.result?.deleted ?? [],
			kept: json?.result?.kept ?? [],
		}
	} catch (err) {
		return { ok: false, kind: "exception", message: (err as Error).message }
	}
}

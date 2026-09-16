// Supabase Edge Function: sync-exam-scope
//
// 시험범위(학원) DB의 "응시학생 등록"·"시험일정 추가" 두 버튼이 공통으로 호출한다.
// 노션 수식이던 "응시학생 현황"이 학생 DB에 없는 "상태"/"수강중" 값을 참조하고 있던 버그를
// 계기로, 응시학생 현황과 시험일 계산을 한때 이 함수로 옮겼었다 (로드맵 4-5, 2026-09-16).
// 같은 날, "응시학생 현황"은 정확한 속성명("등록상태" == "🟢 등록 중")을 쓰는 노션 수식으로
// 다시 전환했다. "시험일" 자동 계산은 요청한 적 없는 기능이라 같은 날 삭제했다 — "시험일"은
// 이제 사용자가 직접 입력하는 수동 날짜 속성이다. 이 함수는 이제 응시 대상 학생을 찾아 아직
// 없는 성적 행을 만드는 것만 한다.
//
//   1. (응시 대상 학생 찾기) 시험범위와 같은 학년이면서, 학교가 지정돼 있으면 같은 학교인
//      "등록상태 = 🟢 등록 중" 학생 중 아직 이 시험범위에 성적 행이 없는 학생을 찾아 성적 행을
//      만든다. 이미 성적 행이 있는 학생은 건드리지 않는다 (점수 등 기존 입력값 보존).
//
// 호출 방식: body에 { pageId: "시험범위 페이지 id" } 를 담아 호출 ("응시학생 등록"/"시험일정 추가" 버튼용).

import {
	DS_GRADE,
	DS_STUDENT,
	PROP_SCOPE_TITLE,
	PROP_SCOPE_GRADE_LEVEL,
	PROP_SCOPE_SCHOOL,
	PROP_SCOPE_RUNNING,
	PROP_SCOPE_LAST_ERROR,
	PROP_SCOPE_SYNCED_AT,
	PROP_GRADE_TITLE,
	PROP_GRADE_STUDENT,
	PROP_GRADE_SCOPE,
	PROP_GRADE_GRADE_LEVEL,
	PROP_GRADE_SCHOOL,
	PROP_STUDENT_TITLE,
	PROP_STUDENT_GRADE_LEVEL,
	PROP_STUDENT_SCHOOL,
	PROP_STUDENT_ENROLL_STATUS,
	STUDENT_STATUS_ENROLLED,
} from "../_shared/constants.ts"
import {
	getPage,
	updatePageProperties,
	createPage,
	queryAllPages,
	relIds,
	relationIds,
	titleText,
	extractPageId,
	checkboxValue,
} from "../_shared/notionClient.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"

async function setStatus(pageId: string, status: "처리중" | "완료" | "오류", errorMessage?: string) {
	try {
		if (status === "처리중") {
			await updatePageProperties(pageId, {
				[PROP_SCOPE_RUNNING]: { checkbox: true },
				[PROP_SCOPE_LAST_ERROR]: { rich_text: [] },
			})
			return
		}
		if (status === "오류") {
			await updatePageProperties(pageId, {
				[PROP_SCOPE_RUNNING]: { checkbox: false },
				[PROP_SCOPE_LAST_ERROR]: {
					rich_text: [{ text: { content: (errorMessage ?? "알 수 없는 오류").slice(0, 1900) } }],
				},
			})
			return
		}
		await updatePageProperties(pageId, {
			[PROP_SCOPE_RUNNING]: { checkbox: false },
			[PROP_SCOPE_LAST_ERROR]: { rich_text: [] },
			[PROP_SCOPE_SYNCED_AT]: { date: { start: new Date().toISOString() } },
		})
	} catch {
		// 상태 표시 실패는 무시
	}
}

async function findEligibleStudents(gradeId: string, schoolId: string | null) {
	const andFilters: Record<string, unknown>[] = [
		{ property: PROP_STUDENT_GRADE_LEVEL, relation: { contains: gradeId } },
		{ property: PROP_STUDENT_ENROLL_STATUS, formula: { string: { equals: STUDENT_STATUS_ENROLLED } } },
	]
	if (schoolId) {
		andFilters.push({ property: PROP_STUDENT_SCHOOL, relation: { contains: schoolId } })
	}
	return queryAllPages(DS_STUDENT, { and: andFilters })
}

async function processExamScope(pageId: string, log: string[]) {
	const scope = await getPage(pageId)
	const scopeName = titleText(scope, PROP_SCOPE_TITLE) ?? "(이름 없음)"
	const gradeIds = relationIds(scope, PROP_SCOPE_GRADE_LEVEL)
	const schoolIds = relationIds(scope, PROP_SCOPE_SCHOOL)
	const gradeId = gradeIds[0] ?? null
	const schoolId = schoolIds[0] ?? null

	// 응시 대상 학생을 찾아 아직 없는 성적 행을 만든다.
	if (gradeId) {
		const candidates = await findEligibleStudents(gradeId, schoolId)

		const existingGrades = await queryAllPages(DS_GRADE, {
			property: PROP_GRADE_SCOPE,
			relation: { contains: pageId },
		})
		const studentsWithGrade = new Set<string>()
		for (const g of existingGrades) {
			for (const sid of relIds(g.properties[PROP_GRADE_STUDENT])) studentsWithGrade.add(sid)
		}

		let created = 0
		for (const student of candidates) {
			if (studentsWithGrade.has(student.id)) continue
			const studentName = titleText(student, PROP_STUDENT_TITLE) ?? "(이름 없음)"
			const studentGradeIds = relIds(student.properties[PROP_STUDENT_GRADE_LEVEL])
			const studentSchoolIds = relIds(student.properties[PROP_STUDENT_SCHOOL])
			await createPage(DS_GRADE, {
				[PROP_GRADE_TITLE]: { title: [{ text: { content: `${studentName} - ${scopeName}` } }] },
				[PROP_GRADE_STUDENT]: { relation: [{ id: student.id }] },
				[PROP_GRADE_SCOPE]: { relation: [{ id: pageId }] },
				...(studentGradeIds.length
					? { [PROP_GRADE_GRADE_LEVEL]: { relation: studentGradeIds.map((id: string) => ({ id })) } }
					: {}),
				...(studentSchoolIds.length
					? { [PROP_GRADE_SCHOOL]: { relation: studentSchoolIds.map((id: string) => ({ id })) } }
					: {}),
			})
			created++
		}
		log.push(`👥 [${scopeName}] 대상 학생 ${candidates.length}명 중 신규 성적 행 ${created}건 생성함`)
	} else {
		log.push(`⏭️ [${scopeName}] 학년이 비어있어 응시학생 등록을 건너뜀`)
	}
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
		console.log("[sync-exam-scope] received body:", JSON.stringify(body))

		pageId = extractPageId(body)
		if (!pageId) {
			return new Response(JSON.stringify({ error: "pageId를 찾을 수 없음" }), { status: 400 })
		}

		// 이미 처리 중이면 새로 시작하지 않고 즉시 반환 -- 처리 중 재클릭으로 인한 중복 처리 방지.
		const scopeForLock = await getPage(pageId)
		if (checkboxValue(scopeForLock, PROP_SCOPE_RUNNING)) {
			return new Response(JSON.stringify({ ok: true, message: "already_processing", pageId }, null, 2), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})
		}

		await setStatus(pageId, "처리중")

		// Notion의 "웹훅 보내기" 버튼 액션은 이 응답을 동기적으로 기다린다. 처리 시간이 길어지면
		// "버튼 실행 실패: 웹훅 요청 시간이 초과되었습니다" 알림이 뜰 수 있으므로, 응답을 먼저 보내고
		// 나머지는 백그라운드로 미룬다. 진행 상황은 시험범위의 "처리중"/"마지막 오류"로 확인할 수 있다.
		const resolvedPageId = pageId
		runInBackground(async () => {
			try {
				const bgLog: string[] = []
				await processExamScope(resolvedPageId, bgLog)
				await setStatus(resolvedPageId, "완료")
				console.log("[sync-exam-scope] (background) finished:", resolvedPageId, "\n", bgLog.join("\n"))
			} catch (err) {
				console.error("[sync-exam-scope] (background) ERROR:", (err as Error).message, (err as Error).stack)
				await setStatus(resolvedPageId, "오류", (err as Error).message)
			}
		})

		return respondAccepted({ pageId })
	} catch (err) {
		console.error("[sync-exam-scope] ERROR:", (err as Error).message, (err as Error).stack)
		if (pageId) {
			await setStatus(pageId, "오류", (err as Error).message)
		}
		return new Response(JSON.stringify({ ok: false, error: (err as Error).message, log }, null, 2), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		})
	}
})

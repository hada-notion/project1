// _shared/examScopeTarget.ts
//
// sync-exam-scope가 처리하는 실제 응시학생 등록 로직을 별도 파일로 분리했다 (2026-09-18, 큐 기반 순차
// 처리 도입, Phase 3). 원래 index.ts 안에 있던 코드를 그대로 옮긴 것이다.
//
// (2026-09-22, PART N-4: 개별 트리거 버튼 동기화 전환) processSyncExamScopeQueueItem
// (process-sync-queue 전용 진입점)은 제거했다. index.ts가 processExamScope를 직접 호출한다.

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
} from "./constants.ts"
import { getPage, updatePageProperties, createPage, queryAllPages, relIds, relationIds, titleText } from "./notionClient.ts"

export async function setExamScopeStatus(pageId: string, status: "처리중" | "완료" | "오류", errorMessage?: string) {
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

export async function processExamScope(pageId: string, log: string[]) {
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
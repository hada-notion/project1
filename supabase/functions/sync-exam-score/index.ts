// Supabase Edge Function: sync-exam-score
//
// 성적(학원) DB의 점수/등수/응시인원이 바뀌거나 새 성적 행이 만들어질 때 호출된다.
// 노션 수식이던 "백분률"(등수/응시인원*100)과 "시험구분"(시험범위→시험의 지필고사/모의고사
// 값)을 웹앱에서 계산해 일반 속성에 기록한다 (로드맵 4-5, 2026-09-16, 수식→plain 전환).
//
// 호출 방식: body에 { pageId: "성적 페이지 id" } 를 담아 호출 (성적 DB "속성 편집됨" 자동화용).

import {
	PROP_GRADE_TITLE,
	PROP_GRADE_SCOPE,
	PROP_GRADE_RANK,
	PROP_GRADE_ATTENDEE_COUNT,
	PROP_GRADE_PERCENTILE,
	PROP_GRADE_EXAM_TYPE,
	PROP_SCOPE_EXAM,
	PROP_EXAM_WRITTEN,
	PROP_EXAM_MOCK,
} from "../_shared/constants.ts"
import { getPage, updatePageProperties, relIds, titleText, extractPageId } from "../_shared/notionClient.ts"

async function computeExamType(scopeId: string): Promise<string> {
	const scope = await getPage(scopeId)
	const examIds = relIds(scope.properties[PROP_SCOPE_EXAM])
	if (examIds.length === 0) return ""
	const examPages = await Promise.all(examIds.map((id: string) => getPage(id)))
	const parts = examPages
		.map((exam: any) => {
			const written = exam.properties[PROP_EXAM_WRITTEN]?.select?.name ?? ""
			const mock = exam.properties[PROP_EXAM_MOCK]?.select?.name ?? ""
			return `${written}${mock}`
		})
		.filter((s: string) => s.length > 0)
	return parts.join(", ")
}

Deno.serve(async (req: Request) => {
	if (req.method !== "POST") {
		return new Response("Use POST", { status: 405 })
	}
	try {
		let body: Record<string, unknown> = {}
		try {
			body = await req.json()
		} catch {
			body = {}
		}
		console.log("[sync-exam-score] received body:", JSON.stringify(body))

		const pageId = extractPageId(body)
		if (!pageId) {
			return new Response(JSON.stringify({ error: "pageId를 찾을 수 없음" }), { status: 400 })
		}

		const grade = await getPage(pageId)
		const gradeName = titleText(grade, PROP_GRADE_TITLE) ?? "(이름 없음)"
		const rank = grade.properties[PROP_GRADE_RANK]?.number ?? null
		const attendeeCount = grade.properties[PROP_GRADE_ATTENDEE_COUNT]?.number ?? null

		const updates: Record<string, unknown> = {}
		let percentile: number | null = null
		if (rank != null && attendeeCount != null && attendeeCount > 0) {
			percentile = Math.round((rank / attendeeCount) * 100 * 100) / 100
		}
		updates[PROP_GRADE_PERCENTILE] = { number: percentile }

		const scopeIds = relIds(grade.properties[PROP_GRADE_SCOPE])
		const examType = scopeIds.length > 0 ? await computeExamType(scopeIds[0]) : ""
		updates[PROP_GRADE_EXAM_TYPE] = { rich_text: examType ? [{ text: { content: examType } }] : [] }

		await updatePageProperties(pageId, updates)

		return new Response(JSON.stringify({ ok: true, pageId, gradeName, percentile, examType }, null, 2), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})
	} catch (err) {
		console.error("[sync-exam-score] ERROR:", (err as Error).message, (err as Error).stack)
		return new Response(JSON.stringify({ ok: false, error: (err as Error).message }, null, 2), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		})
	}
})

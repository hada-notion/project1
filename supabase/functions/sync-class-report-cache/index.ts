// Supabase Edge Function: sync-class-report-cache
//
// 클래스(학원) DB의 "학생 페이지 미리 동기화" 버튼이 호출한다.
// 보고서를 실제로 발송하지 않고, 이 클래스에 속한 학생들 중 리포트 토큰이 발급된 등록 전체의
// 학부모 리포트 캐시(report_cache 테이블)만 미리 강제로 다시 계산한다.
// send-report가 발송 직전에 등록 1건에 대해 하는 ensureFreshReportCache와 같은 계산(reportCacheBuilder.ts의
// buildCacheRowForRegistration)을, 발송 없이 클래스 전체 학생에 대해 미리 실행하는 버전이다.
//
// 사용 배경(2026-09-18): 보고서를 보내기 전에 여러 학생의 리포트 웹사이트를 한 번에 미리
// 확인하고 싶다는 요청. 실제로 카카오 알림톡을 발송해버리면 되돌릴 수 없으므로, 발송과 완전히
// 분리된 별도의 미리보기/확인용 동기화 경로가 필요했다.
//
// generate-report/generate-tuition과 같은 버튼-웹훅 패턴: 즉시 202 응답 -> 백그라운드 실행.
// (등록 1건만 재계산해도 Notion API를 수십 번 호출해야 해서, 반 전체를 동기 응답으로 처리하면
// Notion "웹훅 보내기" 자동화가 응답을 기다리다 타임아웃난다. 그래서 sync-report-cache와 동일하게
// 항상 즉시 202로 응답하고 나머지는 백그라운드에서 처리한다.)
// 다른 클래스 버튼들(교재 생성/보고서 생성/월 수강료 생성)과 동일하게 별도 인증 없이, 클래스
// 페이지에서 온 신뢰된 버튼 웹훅으로 취급한다 (admin-key 불필요).
// 진행 상태는 클래스 페이지의 "실시간 처리 상태" 속성("학생 페이지 동기화중" 체크박스 + "마지막 오류")으로 확인한다.
//
// [FIX, 2026-09-18] CLASS_REPORT_SYNC_RUNNING이 "리포트 동기화중"으로 하드코딩되어 있었는데,
// 클래스(학원) DB의 실제 체크박스 이름이 그동안 두 차례("리포트 미리 동기화중" -> "학생 페이지
// 동기화중") 바뀌면서 더 이상 존재하지 않는 속성명이 되어 있었다. 그 결과 이 함수가 시작하자마자
// (runInBackground로 넘어가기도 전에) setClassStatus가 존재하지 않는 속성에 PATCH를 시도해
// Notion API 400 에러로 즉시 실패했고, 실제 재계산(processClass)은 단 한 번도 실행되지 못한 채
// 클래스 버튼 클릭이 매번 조용히 실패하고 있었다 (등록 페이지의 개별 "학생 페이지 동기화" 버튼은
// 이 체크박스를 쓰지 않아 영향이 없었다). 실제 스키마의 체크박스 이름으로 상수를 맞춘다.

import { getPage, queryAllPages, mapWithConcurrency, extractPageId, checkboxValue } from "../_shared/notionClient.ts"
import { runInBackground, respondAccepted } from "../_shared/backgroundTask.ts"
import { makePageCache, upsertReportCacheRows, type ReportCacheRow } from "../_shared/reportCacheShared.ts"
import { buildCacheRowForRegistration } from "../_shared/reportCacheBuilder.ts"
import { makeClassStatusSetter } from "../_shared/generateShared.ts"

// 등록(학원) DB. sync-report-cache/index.ts와 동일한 고정값.
const DS_REGISTRATION = "16dba040-586b-838a-ae3c-876c0e9cd474"

const CLASS_REPORT_SYNC_RUNNING = "학생 페이지 동기화중"
const setClassStatus = makeClassStatusSetter(CLASS_REPORT_SYNC_RUNNING)

// 이 클래스에 속하고 리포트 토큰이 발급된(=학부모 리포트 링크가 생성된) 등록만 대상으로 한다.
// sync-report-cache의 mode:"all" 전체 재동기화와 동일한 "토큰 있는 건만" 기준을 클래스 범위로 좁힌 버전.
async function processClass(classId: string): Promise<string> {
	const registrations = await queryAllPages(DS_REGISTRATION, {
		and: [
			{ property: "클래스", relation: { contains: classId } },
			{ property: "토큰", rich_text: { is_not_empty: true } },
		],
	})
	if (registrations.length === 0) return "대상 등록 없음 (리포트 토큰이 발급된 학생이 없음)"

	const cachedGetPage = makePageCache()
	const rows = await mapWithConcurrency(registrations, 4, (reg: any) => buildCacheRowForRegistration(reg, cachedGetPage))
	const validRows = rows.filter((r): r is ReportCacheRow => r != null)
	await upsertReportCacheRows(validRows)
	return `동기화 ${validRows.length}건, 스킵 ${rows.length - validRows.length}건 (대상 ${registrations.length}건)`
}

Deno.serve(async (req: Request) => {
	if (req.method !== "POST") {
		return new Response("Use POST", { status: 405 })
	}

	let body: unknown
	try {
		body = await req.json()
	} catch {
		body = undefined
	}
	const classId = body ? extractPageId(body) : null
	if (!classId) {
		return new Response(JSON.stringify({ ok: false, error: "classId를 찾지 못함", rawBody: body }, null, 2), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		})
	}

	// 이미 처리 중이면 새로 시작하지 않고 바로 반환 -- 처리 중 재클릭으로 인한 중복 처리 방지.
	const classPageForLock = await getPage(classId)
	if (checkboxValue(classPageForLock, CLASS_REPORT_SYNC_RUNNING)) {
		return new Response(JSON.stringify({ ok: true, message: "already_processing", classId }, null, 2), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})
	}

	await setClassStatus(classId, "처리중")

	runInBackground(async () => {
		try {
			const summary = await processClass(classId)
			console.log("sync-class-report-cache finished:", classId, summary)
			await setClassStatus(classId, "완료")
		} catch (err) {
			console.error("sync-class-report-cache failed:", (err as Error).message, "\nstack:", (err as Error).stack)
			await setClassStatus(classId, "오류", (err as Error).message)
		}
	})

	return respondAccepted({ classId })
})

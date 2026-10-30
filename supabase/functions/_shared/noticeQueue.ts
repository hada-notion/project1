// _shared/noticeQueue.ts
//
// (v2.6.24) 보고서·수강료 안내·교재비 안내문 발송을 큐로 한 건씩 보낸다. v2.6.20 일일 보고서 큐와 같은 방식이다.
// 각 버튼(보고서 [보고서 전송], 수강료 [안내문 발송], 교재비 [안내문 전송])과 발송함 [일괄 전송]은 대상 페이지의
// 전송 상태를 ⚪ 대기로만 바꾸고, 각 DB 자동화가 send-report|send-tuition-notice|send-textbook-notice/queue로
// 페이지마다 웹훅을 보낸다. process-sync-queue가 한 건씩 처리하므로 월말에 학생 전체를 보내도 호출이 몰리지 않고,
// 멈춘 건은 큐에 남아 이어서 끝난다. 예전 발송함 이어달리기(send-selected-notifications)의 10건 묶음·전역 잠금이
// 필요 없다.
//
// (v2.8.0) 수강료는 같은 학생의 같은 달 수강료('같은 달 수강료')를 한 통으로 보낸다(아래 prepareTuition). 발송함 일괄은
// 그중 하나라도 이미 보냈으면 잠그고(⚠️ 사유), 수강료 [안내문 전송](개별 전송 체크)은 잠금 없이 다시 보낸다.
// (10/28) 가정통신문(월간 일정 안내, kind "letter")도 같다: '같은 달 가정통신문'을 한 통으로, 같은 잠금·개별 전송. 문구는
// _shared/monthlyNotice.ts buildLetterNotice(보내기 직전 '학원 일정'을 다시 넣고 (일정안내) 수식 값 우선). 일정도 전달사항도 없으면 ⚠️.
//
// 한 건 처리(필요한 만큼만 읽기):
//   1) 페이지 1번 읽기 — 전송 상태가 ⚪ 대기가 아니면 건너뜀(두 번 눌러도·같은 항목이 두 번 들어와도 한 번만 보냄).
//   2) (보고서만) 리포트 최신화 — 같은 발송함은 공용 캐시(5분 단위 실행 키), "리포트 토큰" 롤업이 있으면 등록을 다시 읽지 않음.
//   3) 알림톡 설정은 adminShared 캐시, 수신 대상이 우선 연락 대상이면 페이지의 연락처 롤업·수식만 쓴다.
//   4) 발송 → 전송 로그 1건 → 페이지 쓰기 1번(✅ 완료, 일괄전송 선택 해제, 오류 지움).
// 예전 "발송중" 체크(잠금 쓰기 2번)는 쓰지 않는다 — 전송 상태가 그 역할을 한다.
// 발송 전 단계에서 실패하면 마지막 오류만 남기고 큐가 다시 시도한다(아직 아무것도 안 보냄, 상태는 ⚪ 대기 그대로).
// 발송 단계에서 실패하면 다시 보내지 않고 ⚠️ 오류로 남긴다(실제로는 나갔을 수 있어, 사람이 확인 후 다시 누른다).
import {
	createSendLogEntry,
	extractErrorMessage,
	getAlimtalkConfig,
	getBotUserId,
	notionGetPage,
	notionPatchPageProperties,
	type AlimtalkConfigCategory,
	type SendLogCategory,
} from "./adminShared.ts"
import {
	getDateRange,
	getFormulaText,
	getRelationFirstId,
	getRollupText,
	normalizePhone,
	resolveAlimtalkRecipients,
} from "./alimtalkShared.ts"
import { refreshStudentReport } from "./dailyReportRefresh.ts"
import { buildLetterNotice, LetterBlocked } from "./monthlyNotice.ts"
import { BOOK_EVAL_LOG_CATEGORY, BOOK_EVAL_NOTICE_SENT_PROP, BOOK_EVAL_NOTICE_STATUS_PROP, bookEvalContent } from "./bookEvalNotice.ts"
import { alimtalkVar, BULLET, reportStatusBlock, textbookBlock, tuitionInfoBlock, reportConfigChain, reportSectionVars } from "./noticeBlocks.ts"
import { fitVariablesToTemplate } from "./templateFit.ts"

export type NoticeKind = "report" | "tuition" | "textbook" | "letter" | "bookEval"
export type NoticePayload = { kind: NoticeKind; pageId: string; clickerUserId?: string | null }

export const NOTICE_STATUS_PROP: Record<NoticeKind, string> = {
	report: "보고서 전송 상태",
	tuition: "안내문 전송 상태",
	textbook: "안내문 전송 상태",
	letter: "안내문 전송 상태",
	// (v2.8.0 교재 평가, 항목 16) 학습활동 한 장 = 학생 한 명의 교재 평가 결과 안내(_shared/bookEvalNotice.ts).
	bookEval: BOOK_EVAL_NOTICE_STATUS_PROP,
}
// 같은 학생의 같은 달 다른 반 장(한 통으로 보내는 묶음)
const SIBLING_PROP: Partial<Record<NoticeKind, string>> = { tuition: "같은 달 수강료", letter: "같은 달 가정통신문" }
const WAITING = "⚪ 대기"
const RUN_BUCKET_MS = 5 * 60 * 1000
const REPORT_PATH = Deno.env.get("REPORT_PATH") ?? "/project1/student_report.html"
const FALLBACK = {
	pfId: Deno.env.get("SOLAPI_PF_ID") ?? "",
	senderNumber: Deno.env.get("SOLAPI_SENDER_NUMBER") ?? "",
	report: Deno.env.get("SOLAPI_TEMPLATE_ID_WEEKLY") || Deno.env.get("SOLAPI_TEMPLATE_ID_MONTHLY") || "",
	tuition: Deno.env.get("SOLAPI_TEMPLATE_ID_TUITION") ?? "",
	textbook: Deno.env.get("SOLAPI_TEMPLATE_ID_TEXTBOOK") ?? "",
	letter: "",
	bookEval: "",
}

type Prepared = {
	registrationId: string
	title: string
	logCategory: SendLogCategory
	configCategory: AlimtalkConfigCategory
	configFallback?: AlimtalkConfigCategory | AlimtalkConfigCategory[]
	// 설정 행이 없을 때 Secrets 기본 템플릿을 쓰지 않는다(수료 보고서: 맞는 기본 템플릿이 없음 → 템플릿 ID 없음 오류).
	noEnvTemplate?: boolean
	primaryPhone: string
	variables: (notice: string) => Record<string, string>
	log: { reportId?: string; tuitionId?: string; textbookCartId?: string; letterId?: string; periodStart?: string; periodEnd?: string }
	clearBulkSelect: boolean
	// 보낸 뒤 ✅ 완료와 함께 쓸 칸(진도 평가: 안내 일시)
	doneExtra?: Record<string, unknown>
}

const plain = (prop: any): string => {
	if (!prop) return ""
	if (Array.isArray(prop.rich_text)) return prop.rich_text.map((t: any) => t.plain_text ?? t.text?.content ?? "").join("")
	if (prop.type === "rollup" || prop.rollup) {
		for (const v of prop.rollup?.array ?? []) {
			const s = plain(v)
			if (s) return s
		}
	}
	return ""
}

async function sendKakao(to: string, variables: Record<string, string>, config: { pfId: string; templateId: string; senderNumber: string }) {
	if (!to) throw new Error("받는 사람 연락처가 비어 있습니다.")
	if (!config.templateId) throw new Error("템플릿 ID가 설정되지 않았습니다. '알림톡 설정(학원) DB'를 확인해 주세요.")
	const { SolapiMessageService } = await import("npm:solapi")
	const service = new SolapiMessageService(Deno.env.get("SOLAPI_API_KEY")!, Deno.env.get("SOLAPI_API_SECRET")!)
	// (v2.8.0 통일안) 옛·새 템플릿 변수를 함께 만들었으므로 이 템플릿에 있는 것만 보낸다.
	const fitted = await fitVariablesToTemplate(service, config.templateId, variables)
	return service.send({
		to: normalizePhone(to),
		from: normalizePhone(config.senderNumber),
		kakaoOptions: { pfId: config.pfId, templateId: config.templateId, variables: fitted, disableSms: false },
	}, { allowDuplicates: true })
}

// 테스트에서 Notion·리포트 최신화·실제 발송을 바꿔 끼울 수 있게 한다.
export const noticeDeps = {
	getPage: notionGetPage,
	patch: notionPatchPageProperties,
	refresh: refreshStudentReport,
	config: getAlimtalkConfig,
	recipients: resolveAlimtalkRecipients,
	send: sendKakao,
	log: createSendLogEntry,
	botUserId: getBotUserId,
	letter: buildLetterNotice,
	bookEval: bookEvalContent,
	now: () => Date.now(),
}

async function prepareReport(page: any): Promise<Prepared> {
	const reportId = page.id as string
	const reportType = page.properties?.["보고서 구분"]?.select?.name ?? ""
	if (reportType !== "주간 보고서" && reportType !== "월간 보고서" && reportType !== "수료 보고서") {
		throw new Error(`이 보고서의 '보고서 구분'이 "주간 보고서" / "월간 보고서" / "수료 보고서" 중 하나가 아닙니다 (현재 값: "${reportType || "없음"}").`)
	}
	const registrationId = getRelationFirstId(page, "등록")
	if (!registrationId) throw new Error("이 보고서에 연결된 '등록'이 없습니다.")
	const teacherComment = plain(page.properties?.["선생님 한마디"]).trim()
	// 같은 발송함(없으면 이 보고서)은 5분 단위로 공용 캐시를 쓴다. 같은 반 학생들이 반 공통 학습기록·교재를 한 번만 읽는다.
	const batchId = getRelationFirstId(page, "알림톡 발송함") ?? reportId
	const runKey = `notice:${batchId}:${Math.floor(noticeDeps.now() / RUN_BUCKET_MS)}`
	const { access_token, cacheRow } = await noticeDeps.refresh(registrationId, { sharedRunKey: runKey, tokenRaw: plain(page.properties?.["리포트 토큰"]) || null })
	if (teacherComment) {
		// 코멘트가 최신 캐시에 실제로 들어갔는지 마지막에 확인한다(send-report와 같은 안전장치).
		const comments = (cacheRow?.registration_detail?.report_comments ?? []) as Array<{ id?: string; comment?: string }>
		const want = reportId.replaceAll("-", "").toLowerCase()
		if (!comments.some((c) => String(c.id ?? "").replaceAll("-", "").toLowerCase() === want && c.comment === teacherComment)) {
			throw new Error("선생님 코멘트가 최신 보고서 캐시에 포함되지 않았습니다.")
		}
	}
	const period = getDateRange(page, "보고서 기간")
	// 변수 값은 "변수(알림톡)" 수식 → 옛 "(보고서)" 수식(_shared/noticeBlocks.ts alimtalkVar).
	// (v2.8.0 통일안) 새 템플릿의 #{학습현황}(두 칸 표기)과 옛 템플릿의 #{보고서요약}을 함께 만든다.
	const v = (name: string, fallback = "") => alimtalkVar(page, name, fallback, `${name}(보고서)`)
	const studentName = v("학생이름")
	const summary = getFormulaText(page, "보고서요약(보고서)")
	const fixed: Record<string, string> = {
		"#{보고서기간}": v("보고서기간"),
		"#{보고서구분}": alimtalkVar(page, "보고서구분", reportType),
		"#{학생이름}": studentName,
		"#{클래스}": v("클래스"),
		"#{학습기간}": v("학습기간"),
		"#{학습현황}": alimtalkVar(page, "학습현황", reportStatusBlock(summary)),
		"#{보고서요약}": summary,
		// (v2.8.0 구역) 주간·월간 학습·활동 보고서의 구역 변수.
		...reportSectionVars(page),
		"#{페이지ID}": REPORT_PATH + "?token=" + access_token,
	}
	const chain = await reportConfigChain(reportType, registrationId, (id) => noticeDeps.getPage(id))
	return {
		registrationId,
		title: studentName || reportType,
		logCategory: reportType as SendLogCategory,
		// (v2.8.0) 주간·월간 템플릿을 나눴다. "주간 보고서"/"월간 보고서" 행이 없으면 옛 "보고서" 행.
		configCategory: chain.category,
		configFallback: chain.fallback.length ? chain.fallback : undefined,
		noEnvTemplate: chain.noEnvTemplate,
		primaryPhone: getFormulaText(page, "학부모 연락처(보고서)"),
		variables: () => fixed,
		log: { reportId, periodStart: period.start || undefined, periodEnd: period.end || undefined },
		clearBulkSelect: true,
	}
}

// (v2.8.0) 수강료 안내는 같은 학생의 같은 달 수강료(듣는 반마다 한 장, '같은 달 수강료')를 한 통으로 보낸다.
// 문구는 수강료 페이지의 (수강료안내) 수식 값을 그대로 쓴다(수강 내역 줄·합계가 Notion에서 계산됨). 수식이 없거나 비면
// 이 한 장만 담은 예전 모양으로 보낸다(운영에 수식이 아직 없을 때).
// "청구년월(수강료안내)" 같은 옛 이름을 넘기면 "청구년월(알림톡)"을 먼저 읽는다.
const tuitionVar = (page: any, legacy: string, fallback: string) => alimtalkVar(page, legacy.replace(/\(수강료안내\)$/, ""), fallback, legacy)
function prepareTuition(page: any): Prepared {
	const registrationId = getRelationFirstId(page, "등록")
	if (!registrationId) throw new Error("이 수강료 안내에 연결된 등록이 없습니다.")
	const studentName = getFormulaText(page, "학생정보")
	const period = getDateRange(page, "청구기간")
	const amount = getFormulaText(page, "청구금액(표시)")
	const fixed: Record<string, string> = {
		"#{청구년월}": tuitionVar(page, "청구년월(수강료안내)", getFormulaText(page, "청구년월(보고서)")),
		"#{청구기간}": tuitionVar(page, "청구기간(수강료안내)", getFormulaText(page, "청구기간(표시)")),
		"#{학생이름}": tuitionVar(page, "학생이름(수강료안내)", studentName),
		"#{수강내역}": tuitionVar(page, "수강내역(수강료안내)", `${BULLET}${getRollupText(page, "클래스(수강료)")}  ${amount}`),
		"#{청구금액}": tuitionVar(page, "청구금액(수강료안내)", amount),
	}
	// (10/29 다시 신청한 본문) 머리줄 "📚 수강 내역"까지 담는 블록(솔라피가 값 맨 앞 공백을 지우므로).
	fixed["#{수강정보}"] = alimtalkVar(page, "수강정보", tuitionInfoBlock(fixed["#{수강내역}"]))
	return {
		registrationId,
		title: studentName || "수강료 안내",
		logCategory: "수강료 안내",
		configCategory: "수강료 안내",
		primaryPhone: getRollupText(page, "학부모 연락처"),
		variables: (notice) => ({ ...fixed, "#{안내멘트}": notice }),
		log: { tuitionId: page.id, periodStart: period.start || undefined, periodEnd: period.end || undefined },
		clearBulkSelect: true,
	}
}

const DONE = "✅ 완료"
const statusOf = (p: any, kind: NoticeKind) => p?.properties?.[NOTICE_STATUS_PROP[kind]]?.select?.name ?? ""
const siblingIds = (page: any, kind: NoticeKind): string[] => (page?.properties?.[SIBLING_PROP[kind] ?? ""]?.relation ?? []).map((r: any) => String(r.id))
// 잠금 사유. 보낸 뒤 같은 달 장이 모두 ✅가 되므로 어느 반으로 보냈는지는 알 수 없다(묶음 전체로 말한다).
const LOCK_REASON: Partial<Record<NoticeKind, string>> = {
	tuition: "같은 달 수강료 안내(다른 반 포함)를 이미 보냈습니다. 다시 보내려면 [안내문 전송]을 누르세요.",
	letter: "같은 달 가정통신문(다른 반 포함)을 이미 보냈습니다. 다시 보내려면 [안내문 전송]을 누르세요.",
}
// 수강료·가정통신문 [안내문 전송](개별)이 켠다. 켜져 있으면 같은 달 장을 이미 보냈어도 보낸다.
const isForced = (page: any) => page?.properties?.["개별 전송"]?.checkbox === true

function prepareTextbook(page: any): Prepared {
	const registrationId = getRelationFirstId(page, "등록")
	if (!registrationId) throw new Error("교재비 페이지에 연결된 등록이 없습니다.")
	const studentName = getRollupText(page, "학생이름(표시)") || "학생"
	// (v2.8.0 통일안) 새 템플릿의 #{교재내역}("📚 교재 내역 … 🧾 합계")과 옛 템플릿의 #{교재비안내}를 함께 만든다.
	const unpaid = getFormulaText(page, "미납교재")
	const fixed: Record<string, string> = {
		"#{학생이름}": alimtalkVar(page, "학생이름", studentName),
		"#{클래스}": alimtalkVar(page, "클래스", getRollupText(page, "클래스명(표시)")),
		"#{교재내역}": alimtalkVar(page, "교재내역", textbookBlock(unpaid)),
		"#{교재비안내}": unpaid,
	}
	return {
		registrationId,
		title: studentName || "교재비 안내",
		logCategory: "교재비 안내",
		configCategory: "교재비 안내",
		primaryPhone: "", // 교재비에는 연락처 롤업이 없다 → 우선 연락 대상이면 등록을 한 번 읽는다
		variables: (notice) => ({ ...fixed, "#{안내멘트}": notice }),
		log: { textbookCartId: page.id },
		clearBulkSelect: false,
	}
}

async function prepareLetter(page: any): Promise<Prepared> {
	const built = await noticeDeps.letter(page)
	return {
		registrationId: built.registrationId,
		title: built.title,
		logCategory: "월간 일정 안내",
		configCategory: "월간 일정 안내",
		primaryPhone: "", // 가정통신문에는 연락처 롤업이 없다 → 우선 연락 대상이면 등록을 한 번 읽는다
		variables: () => built.variables,
		log: { letterId: page.id, periodStart: built.period.start, periodEnd: built.period.end },
		clearBulkSelect: false,
	}
}

// (v2.8.0 진도 평가, 항목 16) 학습활동 한 장 → 진도 평가 결과 안내. 보내기 직전 리포트를 최신화해 링크를 열면 최신 점수·한마디가 보인다.
async function prepareBookEval(page: any): Promise<Prepared> {
	const c = await noticeDeps.bookEval(page)
	const runKey = `notice:bookeval:${c.registrationId}:${Math.floor(noticeDeps.now() / RUN_BUCKET_MS)}`
	const { access_token } = await noticeDeps.refresh(c.registrationId, { sharedRunKey: runKey, tokenRaw: null })
	return {
		registrationId: c.registrationId,
		title: c.studentName,
		logCategory: BOOK_EVAL_LOG_CATEGORY as SendLogCategory,
		configCategory: BOOK_EVAL_LOG_CATEGORY as AlimtalkConfigCategory,
		primaryPhone: "", // 학습활동에는 연락처가 없다 → 우선 연락 대상이면 등록을 한 번 읽는다
		variables: () => ({ ...c.variables, "#{페이지ID}": REPORT_PATH + "?token=" + access_token }),
		log: {},
		clearBulkSelect: false,
		doneExtra: { [BOOK_EVAL_NOTICE_SENT_PROP]: { date: { start: new Date(noticeDeps.now()).toISOString() } } },
	}
}

async function finish(kind: NoticeKind, pageId: string, status: "✅ 완료" | "⚠️ 오류", message: string | null, clearBulkSelect: boolean, extra: Record<string, unknown> = {}) {
	await noticeDeps.patch(pageId, {
		[NOTICE_STATUS_PROP[kind]]: { select: { name: status } },
		"마지막 오류": { rich_text: message ? [{ text: { content: message.slice(0, 1900) } }] : [] },
		...(clearBulkSelect ? { "일괄전송 선택": { checkbox: false } } : {}),
		...extra,
	}).catch((err: unknown) => console.error("[notice] 상태 쓰기 실패:", pageId, extractErrorMessage(err)))
}

export async function processNoticeQueueItem(payload: NoticePayload): Promise<void> {
	const { kind, pageId } = payload
	const page = await noticeDeps.getPage(pageId)
	if (page?.archived || page?.in_trash) return
	const status = page?.properties?.[NOTICE_STATUS_PROP[kind]]?.select?.name ?? ""
	if (status !== WAITING) {
		console.log(`[notice] ${kind} ${pageId}: 전송 상태가 ${status || "비어 있음"}이라 건너뜀`)
		return
	}

	// (v2.8.0) 수강료·가정통신문: 같은 달 장을 함께 다룬다. 일괄(발송함 [일괄 전송])은 그중 하나라도 이미 보냈으면 잠근다.
	// 개별([안내문 전송], '개별 전송' 체크)은 잠금 없이 다시 보낸다. 보낸 뒤 같은 달 장 모두 ✅.
	const grouped = !!SIBLING_PROP[kind]
	const forced = grouped && isForced(page)
	const forcedReset = forced ? { "개별 전송": { checkbox: false } } : {}
	const bulkReset = kind === "tuition"
	let siblings: any[] = []
	if (grouped) {
		siblings = (await Promise.all(siblingIds(page, kind).map((id) => noticeDeps.getPage(id).catch(() => null)))).filter((p: any) => p && !p.archived && !p.in_trash)
		const sent = siblings.find((p: any) => statusOf(p, kind) === DONE)
		if (sent && !forced) {
			return await finish(kind, pageId, "⚠️ 오류", LOCK_REASON[kind] ?? "같은 달 안내를 이미 보냈습니다.", bulkReset)
		}
	}

	// 발송 전 단계: 실패하면 오류만 적고 예외 → 큐 재시도(아직 보내지 않음, 상태는 ⚪ 대기 그대로).
	let prep: Prepared
	let config: Awaited<ReturnType<typeof getAlimtalkConfig>>
	let recipients: { phone: string }[]
	try {
		prep = kind === "report" ? await prepareReport(page) : kind === "tuition" ? prepareTuition(page) : kind === "letter" ? await prepareLetter(page) : kind === "bookEval" ? await prepareBookEval(page) : prepareTextbook(page)
		config = await noticeDeps.config(prep.configCategory, { pfId: FALLBACK.pfId, templateId: prep.noEnvTemplate ? "" : FALLBACK[kind], senderNumber: FALLBACK.senderNumber }, prep.configFallback)
		recipients = await noticeDeps.recipients({ registrationId: prep.registrationId, primaryPhone: prep.primaryPhone, recipientTarget: config.recipientTarget })
	} catch (err) {
		// 일정도 전달사항도 없음처럼 다시 해도 같은 막힘은 재시도 없이 ⚠️로 끝낸다.
		if (err instanceof LetterBlocked) return await finish(kind, pageId, "⚠️ 오류", err.message, false, forcedReset)
		await noticeDeps.patch(pageId, { "마지막 오류": { rich_text: [{ text: { content: extractErrorMessage(err).slice(0, 1900) } }] } }).catch(() => {})
		throw err
	}
	const senderUserId = (payload.clickerUserId ?? page.properties?.["실행자"]?.people?.[0]?.id ?? (await noticeDeps.botUserId().catch(() => null))) ?? undefined
	const variables = prep.variables(config.notice ?? "")
	const logBase = { registrationId: prep.registrationId, senderUserId, title: prep.title, category: prep.logCategory, ...prep.log }

	// 발송 단계: 실패해도 다시 보내지 않는다(이미 나갔을 수 있음).
	try {
		for (const r of recipients) await noticeDeps.send(r.phone, variables, config)
	} catch (sendErr) {
		const reason = extractErrorMessage(sendErr)
		await noticeDeps.log({ ...logBase, status: "실패", failReason: reason }).catch(() => {})
		return await finish(kind, pageId, "⚠️ 오류", reason, prep.clearBulkSelect, forcedReset)
	}
	await noticeDeps.log({ ...logBase, status: "성공" }).catch((err: unknown) => console.error("[notice] 전송 로그 실패:", extractErrorMessage(err)))
	await finish(kind, pageId, "✅ 완료", null, prep.clearBulkSelect, { ...forcedReset, ...(prep.doneExtra ?? {}) })
	// 같은 달 장도 이 한 통에 들어갔으므로 ✅로 맞추고 전송 로그를 남긴다(다른 반 발송함에서 다시 보내지 않게).
	for (const sib of siblings) {
		const sibLog = kind === "tuition" ? { tuitionId: String(sib.id) } : { registrationId: getRelationFirstId(sib, "등록") ?? prep.registrationId, letterId: String(sib.id) }
		await noticeDeps.log({ ...logBase, ...sibLog, status: "성공" }).catch((err: unknown) => console.error("[notice] 전송 로그 실패:", extractErrorMessage(err)))
		await finish(kind, String(sib.id), "✅ 완료", null, bulkReset)
	}
	console.log(`[notice] ${kind} sent: ${pageId} (${recipients.length}명${siblings.length ? `, 같은 달 ${siblings.length}장 함께` : ""})`)
}

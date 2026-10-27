// _shared/noticeQueue.ts
//
// (v2.6.24) 보고서·수강료 안내·교재비 안내문 발송을 큐로 한 건씩 보낸다. v2.6.20 일일 보고서 큐와 같은 방식이다.
// 각 버튼(보고서 [보고서 전송], 수강료 [안내문 발송], 교재비 [안내문 전송])과 발송함 [일괄 전송]은 대상 페이지의
// 전송 상태를 ⚪ 대기로만 바꾸고, 각 DB 자동화가 send-report|send-tuition-notice|send-textbook-notice/queue로
// 페이지마다 웹훅을 보낸다. process-sync-queue가 한 건씩 처리하므로 월말에 학생 전체를 보내도 호출이 몰리지 않고,
// 멈춘 건은 큐에 남아 이어서 끝난다. 예전 발송함 이어달리기(send-selected-notifications)의 10건 묶음·전역 잠금이
// 필요 없다.
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

export type NoticeKind = "report" | "tuition" | "textbook"
export type NoticePayload = { kind: NoticeKind; pageId: string; clickerUserId?: string | null }

export const NOTICE_STATUS_PROP: Record<NoticeKind, string> = {
	report: "보고서 전송 상태",
	tuition: "안내문 전송 상태",
	textbook: "안내문 전송 상태",
}
const WAITING = "⚪ 대기"
const RUN_BUCKET_MS = 5 * 60 * 1000
const REPORT_PATH = Deno.env.get("REPORT_PATH") ?? "/project1/student_report.html"
const FALLBACK = {
	pfId: Deno.env.get("SOLAPI_PF_ID") ?? "",
	senderNumber: Deno.env.get("SOLAPI_SENDER_NUMBER") ?? "",
	report: Deno.env.get("SOLAPI_TEMPLATE_ID_WEEKLY") || Deno.env.get("SOLAPI_TEMPLATE_ID_MONTHLY") || "",
	tuition: Deno.env.get("SOLAPI_TEMPLATE_ID_TUITION") ?? "",
	textbook: Deno.env.get("SOLAPI_TEMPLATE_ID_TEXTBOOK") ?? "",
}

type Prepared = {
	registrationId: string
	title: string
	logCategory: SendLogCategory
	configCategory: AlimtalkConfigCategory
	primaryPhone: string
	variables: (notice: string) => Record<string, string>
	log: { reportId?: string; tuitionId?: string; textbookCartId?: string; periodStart?: string; periodEnd?: string }
	clearBulkSelect: boolean
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
	return service.send({
		to: normalizePhone(to),
		from: normalizePhone(config.senderNumber),
		kakaoOptions: { pfId: config.pfId, templateId: config.templateId, variables, disableSms: false },
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
	now: () => Date.now(),
}

async function prepareReport(page: any): Promise<Prepared> {
	const reportId = page.id as string
	const reportType = page.properties?.["보고서 구분"]?.select?.name ?? ""
	if (reportType !== "주간 보고서" && reportType !== "월간 보고서") {
		throw new Error(`이 보고서의 '보고서 구분'이 "주간 보고서" / "월간 보고서" 중 하나가 아닙니다 (현재 값: "${reportType || "없음"}").`)
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
	const studentName = getFormulaText(page, "학생이름(보고서)")
	const fixed = {
		"#{보고서기간}": getFormulaText(page, "보고서기간(보고서)"),
		"#{보고서구분}": reportType,
		"#{학생이름}": studentName,
		"#{클래스}": getFormulaText(page, "클래스(보고서)"),
		"#{학습기간}": getFormulaText(page, "학습기간(보고서)"),
		"#{보고서요약}": getFormulaText(page, "보고서요약(보고서)"),
		"#{페이지ID}": REPORT_PATH + "?token=" + access_token,
	}
	return {
		registrationId,
		title: studentName || reportType,
		logCategory: reportType as SendLogCategory,
		configCategory: "보고서",
		primaryPhone: getFormulaText(page, "학부모 연락처(보고서)"),
		variables: () => fixed,
		log: { reportId, periodStart: period.start || undefined, periodEnd: period.end || undefined },
		clearBulkSelect: true,
	}
}

function prepareTuition(page: any): Prepared {
	const registrationId = getRelationFirstId(page, "등록")
	if (!registrationId) throw new Error("이 수강료 안내에 연결된 등록이 없습니다.")
	const studentName = getFormulaText(page, "학생정보")
	const period = getDateRange(page, "청구기간")
	// (v2.8.0) 템플릿이 학생 합산 모양(#{수강내역}·#{청구금액} 합계)으로 바뀌었다. 한 장만 보낼 때는 수강내역이 한 줄이다.
	// 학생의 반을 모두 합쳐 한 통으로 보내는 것은 학생 월간 안내 [수강료 안내](_shared/monthlyNotice.ts).
	const amount = getFormulaText(page, "청구금액(표시)")
	const fixed = {
		"#{청구년월}": getFormulaText(page, "청구년월(보고서)"),
		"#{청구기간}": getFormulaText(page, "청구기간(표시)"),
		"#{학생이름}": studentName,
		"#{수강내역}": `• ${getRollupText(page, "클래스(수강료)")}: ${amount}`,
		"#{청구금액}": amount,
	}
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

function prepareTextbook(page: any): Prepared {
	const registrationId = getRelationFirstId(page, "등록")
	if (!registrationId) throw new Error("교재비 페이지에 연결된 등록이 없습니다.")
	const studentName = getRollupText(page, "학생이름(표시)") || "학생"
	const fixed = {
		"#{학생이름}": studentName,
		"#{클래스}": getRollupText(page, "클래스명(표시)"),
		"#{교재비안내}": getFormulaText(page, "미납교재"),
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

async function finish(kind: NoticeKind, pageId: string, status: "✅ 완료" | "⚠️ 오류", message: string | null, clearBulkSelect: boolean) {
	await noticeDeps.patch(pageId, {
		[NOTICE_STATUS_PROP[kind]]: { select: { name: status } },
		"마지막 오류": { rich_text: message ? [{ text: { content: message.slice(0, 1900) } }] : [] },
		...(clearBulkSelect ? { "일괄전송 선택": { checkbox: false } } : {}),
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

	// 발송 전 단계: 실패하면 오류만 적고 예외 → 큐 재시도(아직 보내지 않음, 상태는 ⚪ 대기 그대로).
	let prep: Prepared
	let config: Awaited<ReturnType<typeof getAlimtalkConfig>>
	let recipients: { phone: string }[]
	try {
		prep = kind === "report" ? await prepareReport(page) : kind === "tuition" ? prepareTuition(page) : prepareTextbook(page)
		config = await noticeDeps.config(prep.configCategory, { pfId: FALLBACK.pfId, templateId: FALLBACK[kind], senderNumber: FALLBACK.senderNumber })
		recipients = await noticeDeps.recipients({ registrationId: prep.registrationId, primaryPhone: prep.primaryPhone, recipientTarget: config.recipientTarget })
	} catch (err) {
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
		return await finish(kind, pageId, "⚠️ 오류", reason, prep.clearBulkSelect)
	}
	await noticeDeps.log({ ...logBase, status: "성공" }).catch((err: unknown) => console.error("[notice] 전송 로그 실패:", extractErrorMessage(err)))
	await finish(kind, pageId, "✅ 완료", null, prep.clearBulkSelect)
	console.log(`[notice] ${kind} sent: ${pageId} (${recipients.length}명)`)
}

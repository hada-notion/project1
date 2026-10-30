// _shared/lessonNotice.ts
//
// (v2.8.0) 수업 안내 알림톡. 보강 수업이나 평소와 다른 수업(공휴일·선거일 정상 수업, 시간 변경)을 학부모에게 알린다.
// 일일 보고서와 같은 방식: 수업 [수업 안내 일괄 전송]·출석 [수업 안내 전송] 버튼은 출석의 "수업 안내 상태"를 ⚪ 대기로만
// 바꾸고, 출석 DB 자동화 [웹훅] 수업 안내가 send-lesson-notice/queue로 출석마다 웹훅을 보낸다. 큐가 한 건씩 보낸다.
//
// 한 건 처리:
//   - 출석 "수업 안내 일시"(마지막으로 안내한 수업일시)가 지금 수업일시와 같으면 보내지 않는다(이미 안내한 학생). 비었거나
//     다르면(시간을 바꾼 뒤 다시 누름) 지금 수업일시로 "수업 안내"를 보낸다. 변경 전용 템플릿은 두지 않는다(10/27 결정:
//     드문 일이라 시간만 바꾸고 다시 누르면 된다, 바뀐 이유는 수업 안내 메모에). 같은 시간으로 다시 보내려면 "수업 안내 일시"를 비운다.
//   - 결석으로 표시된 학생은 보내지 않는다. 수업구분은 수업 "보강" 체크면 "보강 수업", 아니면 "정규 수업".
//     수업일시는 "26.10.30(금) 17:00". 전달사항은 수업 "수업 안내 메모"(50자까지, 비면 "없음").
//     템플릿 제목은 고정이고 자유 문장 변수는 전달사항 하나다(카카오 심사: 간헐적 공지 통로로 보이지 않게).
//   - 다른 알림톡처럼 변수 값은 보내는 페이지(출석)의 수식에서 읽는다: 수업구분(수업안내)·수업일시(수업안내)·전달사항(수업안내),
//     학생이름(보고서)·클래스(보고서). 수식이 아직 없거나 비면 같은 규칙으로 서버가 계산한다(운영에 수식을 넣기 전에도 동작).
//   - 알림톡 설정의 "수업 안내" 행이 꺼져 있거나 템플릿 ID가 비면 보내지 않고 ⚠️(다른 템플릿으로 잘못 나가지 않게).
//   - 오류는 출석 "수업 안내 오류"에만 적는다(보고서의 "마지막 오류"는 건드리지 않음).
//   - 전송 로그는 등록에만 연결한다(출석의 전송 내역·발송 횟수는 일일 보고서용이라 섞지 않음). 보낸 뒤 출석 "수업 안내 일시"를 적는다.
// 발송 전 단계(읽기)에서 실패하면 큐가 다시 한다. 발송 단계에서 실패하면 다시 보내지 않고 ⚠️(이미 나갔을 수 있음).
import {
  createSendLogEntry,
  extractErrorMessage,
  getAlimtalkConfig,
  type AlimtalkConfigCategory,
  getBotUserId,
  notionGetPage,
  notionPatchPageProperties,
  type SendLogCategory,
} from "./adminShared.ts"
import { getFormulaText, normalizePhone, resolveAlimtalkRecipients } from "./alimtalkShared.ts"
import { relIds } from "./notionClient.ts"
import { alimtalkVar, dateOnly, lessonInfoBlock } from "./noticeBlocks.ts"
import { fitVariablesToTemplate } from "./templateFit.ts"

export const LESSON_NOTICE_STATUS_PROP = "수업 안내 상태"
export const LESSON_NOTICE_SENT_PROP = "수업 안내 일시"
// 출석 [수업 안내 전송](개별)이 켠다. 켜져 있으면 같은 일시로 이미 안내했어도 보내고, 처리 뒤 끈다.
export const LESSON_NOTICE_FORCE_PROP = "개별 전송"
export const LESSON_MEMO_PROP = "수업 안내 메모"
// 출석 "마지막 오류"는 일일 보고서 칸이다(실시간 처리 상태·학생별 전송 상태가 읽음). 수업 안내는 따로 쓴다.
export const LESSON_NOTICE_ERROR_PROP = "수업 안내 오류"
export const TARGET_LESSON_NOTICE = "lesson-notice"

export type LessonNoticeKind = "수업 안내"

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"]

// 템플릿의 자유 문장 변수(수업 안내·일정 안내의 전달사항): 공백을 한 칸으로, 50자를 넘으면 자르고 "…", 비면 "없음".
export function noteText(value: string | null | undefined, max = 50): string {
  const t = String(value ?? "").replace(/\s+/g, " ").trim()
  if (!t) return "없음"
  const chars = Array.from(t)
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : t
}

// 수업 안내의 수업일시 "26.10.30(금) 17:00"(서울, 24시간제). 시각이 없는 날짜면 "26.10.30(금)".
export function formatClassTime(value: string | null | undefined): string {
  const v = String(value ?? "")
  if (!v) return ""
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(v)
  const t = new Date(dateOnly ? `${v}T00:00:00+09:00` : v)
  if (Number.isNaN(t.getTime())) return ""
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", year: "2-digit", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(t).map((p) => [p.type, p.value]))
  const dayIdx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday)
  const head = `${parts.year}.${parts.month}.${parts.day}(${WEEKDAY[dayIdx]})`
  return dateOnly ? head : `${head} ${parts.hour}:${parts.minute}`
}

// 같은 시각인지(표기 차이 무시). 둘 다 비면 같다.
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return !a && !b
  const ta = new Date(a).getTime(), tb = new Date(b).getTime()
  return !Number.isNaN(ta) && ta === tb
}

export type LessonNoticePlan =
  | { skip: string }
  | { kind: LessonNoticeKind; variables: Record<string, string>; classIso: string; configCategory: AlimtalkConfigCategory }

// 출석·수업 페이지로 무엇을 보낼지 정한다(네트워크 없음). makeupOfIso는 보강 출석의 기존 결석 수업일시(있으면).
// (v2.8.0 통일안) 새 템플릿 변수 #{수업정보}와 옛 템플릿 변수(#{수업일시}·#{전달사항})를 함께 만든다.
// 보낼 때 그 템플릿에 있는 것만 남긴다(_shared/templateFit.ts).
export function planLessonNotice(attendance: any, session: any | null, makeupOfIso = ""): LessonNoticePlan {
  const p = attendance?.properties ?? {}
  if (p["출석 상태"]?.select?.name === "🔴 결석") return { skip: "결석으로 표시된 학생이라 보내지 않았습니다." }
  const classIso = String(p["수업일시"]?.date?.start ?? "")
  if (!classIso) return { skip: "출석의 수업일시가 비어 있습니다." }
  // (10/29 사용자) 일괄은 같은 일시로 이미 안내한 학생을 건너뛰고, 개별 [수업 안내 전송]('개별 전송' 체크)은 다시 보낸다.
  const sentIso = String(p[LESSON_NOTICE_SENT_PROP]?.date?.start ?? "")
  if (sentIso && sameInstant(sentIso, classIso) && p[LESSON_NOTICE_FORCE_PROP]?.checkbox !== true) return { skip: "" }
  const makeup = session?.properties?.["보강"]?.checkbox === true
  const label = makeup ? "보강 수업" : "정규 수업"
  const memo = (session?.properties?.[LESSON_MEMO_PROP]?.rich_text ?? []).map((t: any) => t.plain_text ?? "").join("").trim()
  const note = getFormulaText(attendance, "전달사항(수업안내)").trim() || noteText(memo)
  // 일시는 수식을 읽지 않는다: Notion API가 수식의 formatDate를 UTC로 계산해 18:00이 "09:00"으로 온다(10/27 원본). 서버가 서울 시각으로.
  const classTime = formatClassTime(classIso)
  const makeupOf = makeupOfIso ? dateOnly(formatClassTime(makeupOfIso)) : ""
  return {
    kind: "수업 안내",
    classIso,
    // (v2.8.0 구역, 10/30 사용자) 보강 수업과 그 밖의 수업(시간 변경·공휴일 정상 수업 등)을 템플릿으로 나눈다.
    configCategory: makeup ? "보강 수업 안내" : "수업 일정 안내",
    variables: {
      "#{수업구분}": alimtalkVar(attendance, "수업구분", label, "수업구분(수업안내)"),
      "#{학생이름}": alimtalkVar(attendance, "학생이름", getFormulaText(attendance, "학생이름(보고서)")),
      "#{클래스}": alimtalkVar(attendance, "클래스", getFormulaText(attendance, "클래스(보고서)")),
      "#{수업정보}": lessonInfoBlock({ classTime, makeupOf: makeupOfIso ? dateOnly(formatClassTime(makeupOfIso)) : undefined, note }),
      "#{수업일시}": classTime,
      "#{전달사항}": note,
      // (v2.8.0 구역) [보강 정보]/[수업 정보] 구역: 보강이면 🔁 기존 + 📅 일시, 아니면 📅 일시. 날짜는 서버가 서울 시각으로 만든다.
      "#{수업일정}": [...(makeupOf ? [`🔁 기존  ${makeupOf} 결석`] : []), `📅 일시  ${classTime}`].join("\n"),
    },
  }
}

const SOLAPI_API_KEY = Deno.env.get("SOLAPI_API_KEY") ?? ""
const SOLAPI_API_SECRET = Deno.env.get("SOLAPI_API_SECRET") ?? ""
const SOLAPI_SENDER_NUMBER_FALLBACK = Deno.env.get("SOLAPI_SENDER_NUMBER") ?? ""

// 템플릿 ID·채널 기본값(Secrets)을 쓰지 않는다: 설정 행이 꺼졌거나 비었으면 다른 템플릿으로 나가지 않게 막는다.
// (v2.8.0) 일정 안내(_shared/scheduleNotice.ts)도 같은 규칙으로 이 함수를 쓴다. primaryPhone이 비면 등록의 우선 연락처를 읽는다.
// configCategory를 주면 그 행부터 찾고, 없거나 꺼져 있으면 kind 행(예: "보강 수업 안내" → "수업 안내").
export async function sendConfiguredAlimtalk(kind: SendLogCategory, registrationId: string, primaryPhone: string, variables: Record<string, string>, configCategory?: AlimtalkConfigCategory) {
  const config = configCategory && configCategory !== kind
    ? await getAlimtalkConfig(configCategory, { pfId: "", templateId: "", senderNumber: SOLAPI_SENDER_NUMBER_FALLBACK }, kind)
    : await getAlimtalkConfig(kind, { pfId: "", templateId: "", senderNumber: SOLAPI_SENDER_NUMBER_FALLBACK })
  if (!config.templateId || !config.pfId) throw new LessonConfigError(`알림톡 설정의 '${kind}' 행을 켜고(활성 여부) 카카오 채널 ID·템플릿 ID를 넣어 주세요.`)
  const recipients = await resolveAlimtalkRecipients({ registrationId, primaryPhone, recipientTarget: config.recipientTarget })
  const { SolapiMessageService } = await import("npm:solapi")
  const messageService = new SolapiMessageService(SOLAPI_API_KEY, SOLAPI_API_SECRET)
  const fitted = await fitVariablesToTemplate(messageService, config.templateId, variables)
  const results = []
  for (const r of recipients) {
    results.push(await messageService.send({
      to: r.phone,
      from: normalizePhone(config.senderNumber),
      kakaoOptions: { pfId: config.pfId, templateId: config.templateId, variables: fitted, disableSms: false },
    }, { allowDuplicates: true }))
  }
  return results
}

// 보내기 전에 막힌 경우(설정·연락처). 다시 해도 같으므로 큐 재시도 없이 ⚠️.
export class LessonConfigError extends Error {}

// 테스트에서 Notion·발송을 바꿔 끼울 수 있게 한다.
export const lessonNoticeDeps = {
  getPage: notionGetPage,
  patch: notionPatchPageProperties,
  send: sendConfiguredAlimtalk,
  log: createSendLogEntry,
  botUser: getBotUserId,
}

async function finish(attendanceId: string, status: "✅ 완료" | "⚠️ 오류", message: string | null, extra: Record<string, unknown> = {}) {
  await lessonNoticeDeps.patch(attendanceId, {
    [LESSON_NOTICE_STATUS_PROP]: { select: { name: status } },
    [LESSON_NOTICE_ERROR_PROP]: { rich_text: message ? [{ text: { content: message.slice(0, 1900) } }] : [] },
    [LESSON_NOTICE_FORCE_PROP]: { checkbox: false },
    ...extra,
  }).catch((err: unknown) => console.error("[lesson-notice] 출석 상태 쓰기 실패:", attendanceId, extractErrorMessage(err)))
}

export async function processLessonNoticeQueueItem(payload: { attendanceId: string; clickerUserId?: string | null }): Promise<void> {
  const deps = lessonNoticeDeps
  const attendanceId = payload.attendanceId
  const page = await deps.getPage(attendanceId)
  if (page?.archived || page?.in_trash || page?.properties?.["삭제 체크"]?.checkbox) return
  const registrationId = relIds(page.properties?.["등록"])[0]
  if (!registrationId) return await finish(attendanceId, "⚠️ 오류", "등록 관계가 비어 있습니다.")
  const sessionId = relIds(page.properties?.["수업"])[0]
  const session = sessionId ? await deps.getPage(sessionId) : null
  // 보강 출석이면 기존 결석의 수업일시(🔁 기존 줄). 못 읽으면 그 줄 없이 보낸다.
  const makeupId = relIds(page.properties?.["기존 결석"])[0]
  const makeupPage = makeupId ? await deps.getPage(makeupId).catch(() => null) : null
  const plan = planLessonNotice(page, session, String(makeupPage?.properties?.["수업일시"]?.date?.start ?? ""))
  if ("skip" in plan) {
    // 이미 같은 일시로 안내한 학생(일괄 전송을 다시 누른 경우)은 완료로 둔다.
    return await finish(attendanceId, plan.skip ? "⚠️ 오류" : "✅ 완료", plan.skip || null)
  }
  const studentName = plan.variables["#{학생이름}"] || "수업 안내"
  const senderUserId = (payload.clickerUserId ?? page.properties?.["실행자"]?.people?.[0]?.id ?? (await deps.botUser().catch(() => null))) ?? undefined
  try {
    await deps.send(plan.kind, registrationId, getFormulaText(page, "학부모 연락처"), plan.variables, plan.configCategory)
  } catch (err) {
    const reason = extractErrorMessage(err)
    if (err instanceof LessonConfigError || /연락처 오류/.test(reason)) return await finish(attendanceId, "⚠️ 오류", reason)
    await deps.log({ registrationId, senderUserId, title: studentName, category: plan.kind, status: "실패", failReason: reason })
    return await finish(attendanceId, "⚠️ 오류", reason)
  }
  await deps.log({ registrationId, senderUserId, title: studentName, category: plan.kind, status: "성공" })
  await finish(attendanceId, "✅ 완료", null, { [LESSON_NOTICE_SENT_PROP]: { date: { start: plan.classIso } } })
  console.log(`[lesson-notice] ${plan.kind} sent: ${attendanceId}`)
}

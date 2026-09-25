// POST /functions/v1/kiosk-checkin
// header: x-admin-key: <관리자 키>  (list-students 등 다른 키오스크/관리 화면 함수와 동일한 인증)
// body: { phone: string, type: "checkin" | "checkout", registrationId?: string }
//
// attendance_kiosk.html의 등원/하원 버튼이 호출한다. 예전에는 이 화면이 외부 Make.com 웹훅으로
// 학생 매칭·출석 기록·알림톡 발송을 위임했는데, 그 경로를 없애고 다른 관리 함수들과 동일하게
// Notion을 직접 조회/갱신하도록 통합한다 (로드맵: 키오스크 Make 의존 제거, 2026-09-19).
//
// 매칭: 학생(학원) DB의 학생/어머니/아버지 연락처 중 하나가 일치하고, 수강 중(🟢)인 등록을 찾는다.
// - 매칭이 하나도 없으면 { matched: false }.
// - 같은 번호로 매칭되는 등록이 여러 건이면(형제/자매가 보호자 번호 공유 등) 검색을 바로 끝내지
//   않고 { needsSelection: true, candidates: [...] }를 반환한다. 프론트는 사용자가 고른
//   registrationId를 담아 이 엔드포인트를 다시 호출한다.
// - 오늘 날짜의 출석 페이지가 있으면 그 페이지에 등원/하원스템프를 기록한다. 이때 "출석 상태"가
//   이미 "🔵 보강"이면 그대로 두고(정규 수업 없는 날의 방문을 유지), 그 외(기본값/결석 등)는
//   실제로 등원·하원했으므로 "🟢 출석"으로 갱신한다.
//   [FIX, 2026-09-19] 원래는 스템프만 찍고 "출석 상태"를 전혀 건드리지 않아서, 정규 수업이 있어
//   미리 만들어진 출석 페이지가 있어도 키오스크로 등원/하원 처리해도 "출석"으로 바뀌지 않는 버그가
//   있었다.
// - 없으면(시험기간 등 정규 수업이 없는 날의 방문) 출석 페이지를 새로 만들고 "출석 상태"를
//   "🔵 보강"으로 설정한다. 하원인데 등원 기록이 없던 경우엔 하원스템프만 채우고 등원스템프는
//   비워둔다.
// - 등원인데 이미 등원스템프가 있으면, 하원인데 이미 하원스템프가 있으면 각각 덮어쓰지 않고
//   { alreadyDone: true, alreadyAt }로 안내하고 알림톡도 다시 보내지 않는다(중복 처리 방지).
//   [FIX, 2026-09-19] 원래는 하원에는 이 중복 방지가 없어서 하원 버튼을 다시 누르면 스템프를
//   덮어쓰고 알림톡도 매번 다시 발송하는 문제가 있었다. 등원과 동일하게 맞춘다.
// - 카카오 알림톡: 등원/하원을 별도 템플릿 두 개로 운영하면 Solapi 템플릿 승인을 두 번 받아야 해서
//   (2026-09-19) "키오스크 알림톡" 코드 하나로 통합했다. "알림톡 설정(학원) DB"에 이 코드 행이
//   있고 활성화되어 있어야 실제 발송된다. Solapi 템플릿 승인 전(비활성 상태)에는 조용히 건너뛰고,
//   출결 기록 자체는 항상 정상 동작한다. 템플릿 변수는 학생이름/구분("등원" 또는 "하원")/일자/시간이며,
//   일자/시간은 각각 "2026년 9월 19일"/"오전 9시 40분" 형식으로 만들어서 보낸다(2026-09-19 #3,
//   템플릿 문구에 맞춤).
// - [FIX, 2026-09-19 #2] "발신번호"는 이 DB의 모든 행에서 비어 있고, 다른 발송 함수들처럼
//   Secrets의 SOLAPI_SENDER_NUMBER로 대체하도록 되어 있어야 하는데 여기만 빈 문자열을 기본값으로
//   써서 활성화 후에도 Solapi 발송이 매번 "from 없음"으로 실패하고 있었다. 다른 함수와 동일하게
//   SOLAPI_SENDER_NUMBER를 fallback으로 쓰도록 고쳤다.

import {
  CORS_HEADERS,
  requireAdminKey,
  getRegistrationDbId,
  resolveRelatedDatabaseId,
  notionQueryDatabase,
  notionQueryDatabaseAll,
  notionGetPage,
  notionPatchPageProperties,
  notionCreatePage,
  getAlimtalkConfig,
  createSendLogEntry,
  extractErrorMessage,
} from "../_shared/adminShared.ts"
import { normalizePhone, resolveParentPhone, resolveAlimtalkRecipients } from "../_shared/alimtalkShared.ts"
// (2026-09-25, PART N-18) 대시보드(학원) DB 자동 연결(enqueueDashboardLink)을 제거했다. 오늘
// Notion API 자체의 429(Retry-After 28~56초) 레이트리밋이 실측 확인됐고, 초기 배포 단계라
// 기능을 최대한 줄이는 방향으로 가기로 했다 -- 나중에 pull 모델로 별도 작업에서 다시 만들 예정.
// (예전 import는 `import { enqueueDashboardLink } from "../_shared/dashboardLinkTarget.ts"`,
// 호출부는 stateChanged 블록 안 한 곳이었다.)

function plainText(prop: any): string {
  if (!prop) return ""
  const arr = prop.title ?? prop.rich_text ?? []
  return arr.map((t: any) => t.plain_text).join("")
}

function formulaText(prop: any): string {
  return prop?.formula?.string ?? ""
}

// "학생이름(등록)"/"클래스명(등록)" 같은 rollup(title 대상) 속성에서 표시 텍스트를 뽑아낸다.
function rollupFirstText(prop: any): string {
  const arr = prop?.rollup?.array ?? []
  if (!arr.length) return ""
  const item = arr[0]
  if (item?.type === "title") return (item.title ?? []).map((t: any) => t.plain_text).join("")
  if (item?.type === "rich_text") return (item.rich_text ?? []).map((t: any) => t.plain_text).join("")
  if (item?.type === "formula") return item.formula?.string ?? String(item.formula?.number ?? "")
  return ""
}

function todayKst(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date())
}

function formatKstTime(iso: string | null | undefined): string {
  if (!iso) return ""
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso))
}

// [NEW, 2026-09-19] 카카오 알림톡 템플릿("등하원 안내")의 일자/시간 변수 전용 포맷.
// 다른 곳(키오스크 화면의 "이미 처리됨" 안내, 보강 출석 페이지 제목 등)의 날짜/시간 표시는
// 그대로 두고, 알림톡으로 나가는 값만 "2026년 9월 19일"/"오전 9시 40분" 형식으로 만든다.
function formatKstDateKorean(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map((v) => parseInt(v, 10))
  return `${y}년 ${m}월 ${d}일`
}

function formatKstTimeKorean(iso: string | null | undefined): string {
  if (!iso) return ""
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    hour: "numeric",
    minute: "numeric",
    hour12: true,
  }).formatToParts(new Date(iso))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ""
  const period = get("dayPeriod").toUpperCase() === "PM" ? "오후" : "오전"
  const hour = get("hour")
  const minute = get("minute").padStart(2, "0")
  return `${period} ${hour}시 ${minute}분`
}

type Candidate = { registrationId: string; studentName: string; className: string }

async function findActiveRegistrationsForStudent(registrationDbId: string, studentId: string): Promise<any[]> {
  const json = await notionQueryDatabase(registrationDbId, {
    filter: {
      and: [
        { property: "학생정보", relation: { contains: studentId } },
        { property: "수강상태", formula: { string: { equals: "🟢 수강 중" } } },
      ],
    },
    page_size: 20,
  })
  return json.results ?? []
}

function toCandidate(reg: any): Candidate {
  const props = reg.properties ?? {}
  return {
    registrationId: reg.id,
    studentName: rollupFirstText(props["학생이름(등록)"]) || "이름 미상",
    className: rollupFirstText(props["클래스명(등록)"]) || "",
  }
}

async function findTodayAttendance(attendanceDbId: string, registrationId: string): Promise<any | null> {
  const start = todayKst() + "T00:00:00+09:00"
  const end = todayKst() + "T23:59:59+09:00"
  const json = await notionQueryDatabase(attendanceDbId, {
    filter: {
      and: [
        { property: "등록", relation: { contains: registrationId } },
        { property: "수업일시", date: { on_or_after: start } },
        { property: "수업일시", date: { on_or_before: end } },
      ],
    },
    page_size: 10,
  })
  return (json.results ?? [])[0] ?? null
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS })

  const authError = await requireAdminKey(req)
  if (authError) return authError

  try {
    const body = await req.json().catch(() => ({}))
    const type: "checkin" | "checkout" | null =
      body?.type === "checkout" ? "checkout" : body?.type === "checkin" ? "checkin" : null
    if (!type) throw new Error("type은 checkin 또는 checkout이어야 합니다.")
    const phone = normalizePhone(String(body?.phone ?? ""))
    if (phone.length < 9) throw new Error("전화번호를 정확히 입력해주세요.")

    const registrationDbId = getRegistrationDbId()
    const studentDbId = await resolveRelatedDatabaseId(registrationDbId, "학생정보")
    const attendanceDbId = await resolveRelatedDatabaseId(registrationDbId, "출석")

    let registrationId: string | null =
      typeof body?.registrationId === "string" && body.registrationId ? body.registrationId : null
    let studentName = ""

    if (!registrationId) {
      // 학생 연락처/어머니 연락처/아버지 연락처 저장 형식이 사람마다 달라서(하이픈 유무 등) Notion
      // 필터의 정확 일치에 기대지 않고, 전체를 가져와 숫자만 비교한다 (학생 수 규모상 충분히 빠름).
      const students = await notionQueryDatabaseAll(studentDbId, {})
      const matchedStudents = students.filter((s: any) => {
        const p = s.properties ?? {}
        return (
          normalizePhone(p["학생 연락처"]?.phone_number ?? "") === phone ||
          normalizePhone(p["어머니 연락처"]?.phone_number ?? "") === phone ||
          normalizePhone(p["아버지 연락처"]?.phone_number ?? "") === phone
        )
      })

      const candidates: Candidate[] = []
      for (const student of matchedStudents) {
        const regs = await findActiveRegistrationsForStudent(registrationDbId, student.id)
        candidates.push(...regs.map(toCandidate))
      }

      if (candidates.length === 0) {
        return new Response(JSON.stringify({ matched: false }), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        })
      }
      if (candidates.length > 1) {
        return new Response(JSON.stringify({ needsSelection: true, candidates }), {
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        })
      }
      registrationId = candidates[0].registrationId
      studentName = candidates[0].studentName
    }

    const registrationPage = await notionGetPage(registrationId)
    if (!studentName) {
      studentName = rollupFirstText(registrationPage.properties?.["학생이름(등록)"]) || "이름 미상"
    }
    const classIds: string[] = (registrationPage.properties?.["클래스"]?.relation ?? []).map((r: any) => r.id)

    let teacherIds: string[] = []
    if (classIds.length) {
      const classPage = await notionGetPage(classIds[0])
      teacherIds = (classPage.properties?.["담당강사"]?.relation ?? []).map((r: any) => r.id)
    }

    const nowIso = new Date().toISOString()
    let attendance = await findTodayAttendance(attendanceDbId, registrationId)
    let stateChanged = false
    let alreadyDone = false
    let alreadyAt = ""

    if (attendance) {
      // [FIX, 2026-09-19] 등원/하원 모두 동일하게: 이미 처리된 스템프면 건너뛰고, 새로 처리하는
      // 경우에만 스템프를 찍고 "출석 상태"도 함께 갱신한다.
      const stampProp = type === "checkin" ? "등원스템프" : "하원스템프"
      const existingStamp = attendance.properties?.[stampProp]?.date?.start
      if (existingStamp) {
        alreadyDone = true
        alreadyAt = formatKstTime(existingStamp)
      } else {
        const currentStatus = attendance.properties?.["출석 상태"]?.select?.name ?? ""
        const patch: Record<string, unknown> = { [stampProp]: { date: { start: nowIso } } }
        // 이미 "🔵 보강"으로 표시된 기록(정규 수업 없는 날의 방문)은 그대로 유지하고,
        // 그 외(기본값·결석 등으로 만들어져 있던 정규 수업 출석 페이지)는 실제로 등원/하원했으니
        // "🟢 출석"으로 갱신한다.
        if (currentStatus !== "🔵 보강") {
          patch["출석 상태"] = { select: { name: "🟢 출석" } }
        }
        await notionPatchPageProperties(attendance.id, patch)
        stateChanged = true
      }
    } else {
      // 정규 수업이 없는 날의 방문(시험기간 등 특수 상황) -- 출석 페이지를 새로 만들고 보강으로 표시.
      const title = `${studentName} ${todayKst()} 보강(${type === "checkin" ? "등원" : "하원"})`
      const properties: Record<string, unknown> = {
        "출석": { title: [{ text: { content: title.slice(0, 200) } }] },
        "등록": { relation: [{ id: registrationId }] },
        "출석 상태": { select: { name: "🔵 보강" } },
        "수업일시": { date: { start: nowIso } },
      }
      if (classIds.length) properties["클래스"] = { relation: classIds.map((id) => ({ id })) }
      if (teacherIds.length) properties["담당강사"] = { relation: teacherIds.map((id) => ({ id })) }
      properties[type === "checkin" ? "등원스템프" : "하원스템프"] = { date: { start: nowIso } }

      attendance = await notionCreatePage(attendanceDbId, properties)
      stateChanged = true
    }

    // 카카오 알림톡 (등원/하원 통합 템플릿이 아직 설정 전이면 조용히 건너뛴다)
    if (stateChanged) {
      const category = "키오스크 알림톡"
      // [FIX, 2026-09-19] "알림톡 설정(학원) DB"의 "발신번호"가 비어 있으면(운영 중인 모든 행이 그렇다)
      // 다른 발송 함수들(send-daily-report 등, _shared/alimtalkShared.ts)처럼 Secrets의
      // SOLAPI_SENDER_NUMBER로 대체해야 하는데, 여기만 빈 문자열 fallback을 써서 Solapi 발송이
      // "from"이 비어 있다는 이유로 매번 조용히 실패하고 있었다(전송로그에는 실패로 남았지만
      // 활성화 전 정상 skip과 구분이 잘 안 됐음).
      const config = await getAlimtalkConfig(category, {
        pfId: "",
        templateId: "",
        senderNumber: Deno.env.get("SOLAPI_SENDER_NUMBER") ?? "",
      })
      if (config.pfId && config.templateId) {
        try {
          const parentPhone = await resolveParentPhone(attendance, registrationId)
          if (!parentPhone) throw new Error("학부모 연락처를 찾을 수 없습니다.")

          const { SolapiMessageService } = await import("npm:solapi")
          const messageService = new SolapiMessageService(
            Deno.env.get("SOLAPI_API_KEY")!,
            Deno.env.get("SOLAPI_API_SECRET")!,
          )
          const recipients = await resolveAlimtalkRecipients({
            registrationId,
            primaryPhone: parentPhone,
            recipientTarget: config.recipientTarget,
          })
          for (const recipient of recipients) {
            await messageService.send({
              to: recipient.phone,
              from: normalizePhone(config.senderNumber),
              kakaoOptions: {
                pfId: config.pfId,
                templateId: config.templateId,
                variables: {
                  "학생이름": studentName,
                  "구분": type === "checkin" ? "등원" : "하원",
                  "일자": formatKstDateKorean(todayKst()),
                  "시간": formatKstTimeKorean(nowIso),
                },
                disableSms: false,
              },
            })
          }
          await createSendLogEntry({
            registrationId,
            attendanceId: attendance.id,
            title: studentName,
            category,
            status: "성공",
          })
        } catch (sendErr) {
          await createSendLogEntry({
            registrationId,
            attendanceId: attendance.id,
            title: studentName,
            category,
            status: "실패",
            failReason: extractErrorMessage(sendErr),
          })
        }
      }
    }

    return new Response(JSON.stringify({ matched: true, studentName, alreadyDone, alreadyAt }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  } catch (err) {
    console.error("kiosk-checkin error:", err)
    return new Response(JSON.stringify({ error: extractErrorMessage(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    })
  }
})

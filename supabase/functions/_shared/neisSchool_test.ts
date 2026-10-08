import { eventKey, eventGrades, ownedProperties, newEventProperties, safeWebsite, type NeisRow } from "./neisSchool.ts"
function assert(v: unknown, message = "assertion failed") { if (!v) throw new Error(message) }
const row: NeisRow = { ATPT_OFCDC_SC_CODE: "B10", SD_SCHUL_CODE: "7041238", AY: "2026", AA_YMD: "20261002", EVENT_NM: "중간고사", EVENT_CNTNT: "", SCHUL_CRSE_SC_NM: "중학교", ONE_GRADE_EVENT_YN: "N", TW_GRADE_EVENT_YN: "Y", THREE_GRADE_EVENT_YN: "N", SBTR_DD_SC_NM: "해당없음" }
Deno.test("대상 학년 Y만 연결", () => assert(JSON.stringify(eventGrades(row)) === "[2]"))
Deno.test("키는 내용 변경에 안정적, 학교/날짜/행사/학년 변경은 구별", async () => {
 const k = await eventKey(row, "abc")
 assert(k === await eventKey({ ...row, EVENT_CNTNT: "변경" }, "abc"))
 for (const r of [{ ...row, EVENT_NM: "기말고사" }, { ...row, AA_YMD: "20261003" }, { ...row, TW_GRADE_EVENT_YN: "N", THREE_GRADE_EVENT_YN: "Y" }]) assert(k !== await eventKey(r, "abc"))
 assert(k !== await eventKey(row, "def"))
})
Deno.test("숨김/메모/본문/진행상태 보존", () => { const props = ownedProperties(row, "abc", "key", ["grade2"]); for (const key of ["숨김", "학부모 공개", "메모", "진행상태", "태그", "담당자"]) assert(!(key in props)); assert(props["날짜"].date.start === "2026-10-02") })
Deno.test("공휴일/토요일/애매한 행사도 수집", () => { for (const name of ["한글날", "토요휴업일", "창체의날"]) assert(ownedProperties({ ...row, EVENT_NM: name }, "abc", "key", [])["이름"].title[0].text.content === name) })
Deno.test("웹사이트 안전 프로토콜", () => { assert(safeWebsite("javascript:alert(1)") === null); assert(safeWebsite("https://cheonwang.sen.ms.kr") === "https://cheonwang.sen.ms.kr/"); assert(safeWebsite(null) === null) })

Deno.test("나이스 100건 넘어도 페이지를 끝까지 수집", async () => {
  const { neisRows } = await import("./neisSchool.ts")
  const original = globalThis.fetch
  Deno.env.set("NEIS_API_KEY", "offline-test-only")
  let calls = 0
  globalThis.fetch = async input => {
    calls++; const u = new URL(String(input)); const index = Number(u.searchParams.get("pIndex"))
    return new Response(JSON.stringify({ SchoolSchedule: [{ head: [{ list_total_count: 102 }, { RESULT: { CODE: "INFO-000" } }] }, { row: Array.from({ length: index === 1 ? 100 : 2 }, () => row) }] }))
  }
  try { assert((await neisRows("SchoolSchedule", {})).length === 102); assert(calls === 2) }
  finally { globalThis.fetch = original; Deno.env.delete("NEIS_API_KEY") }
})
Deno.test("API 오류를 빈 목록으로 숨기지 않음", async () => {
 const { neisRows } = await import("./neisSchool.ts")
 const original = globalThis.fetch; Deno.env.set("NEIS_API_KEY", "offline-test-only")
 globalThis.fetch = async () => new Response(JSON.stringify({ RESULT: { CODE: "ERROR-290" } }))
 try { let failed = false; try { await neisRows("SchoolSchedule", {}) } catch { failed = true }; assert(failed) }
 finally { globalThis.fetch = original; Deno.env.delete("NEIS_API_KEY") }
})
Deno.test("인증키 없이는 샘플로 동기화하지 않음", async () => {
 const { neisRows } = await import("./neisSchool.ts")
 let failed = false; try { await neisRows("SchoolSchedule", {}) } catch { failed = true }; assert(failed)
})

Deno.test("신규 학사일정만 숨김 체크/학부모 비공개", () => {
 const props = newEventProperties(row, "school", "key", ["grade2"])
 assert(props["숨김"].checkbox === true)
 assert(props["학부모 공개"].checkbox === false)
 assert(!("숨김" in ownedProperties(row, "school", "key", ["grade2"])))
 assert(!("학부모 공개" in ownedProperties(row, "school", "key", ["grade2"])))
})

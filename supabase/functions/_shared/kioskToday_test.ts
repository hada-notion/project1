import { buildKioskTodayRows, hashPhone, kstDate } from "./kioskToday.ts"

function assert(cond: unknown, msg = "assertion failed") { if (!cond) throw new Error(msg) }

const id = (n: number) => String(n).repeat(32).slice(0, 32)
const reg = (n: number, studentN: number, status = "🟢 수강 중") => ({
  id: id(n),
  properties: {
    "수강상태": { formula: { string: status } },
    "학생정보": { relation: [{ id: id(studentN) }] },
    "학생이름(등록)": { rollup: { array: [{ title: [{ plain_text: "학생" + n }] }] } },
    "클래스명(등록)": { formula: { string: "중1 A" } },
    "클래스": { relation: [{ id: "c".repeat(32) }] },
  },
})
const student = (n: number, phone: string) => ({ id: id(n), properties: { "어머니 연락처": { phone_number: phone } } })
const att = (pageN: number, regN: number, start: string, extra: Record<string, unknown> = {}) => ({
  id: "a" + String(pageN).repeat(31),
  properties: { "등록": { relation: [{ id: id(regN) }] }, "수업일시": { date: { start } }, ...extra },
})

Deno.test("kioskToday: KST date rolls over at 15:00 UTC", () => {
  assert(kstDate(new Date("2026-10-12T14:59:00Z")) === "2026-10-12")
  assert(kstDate(new Date("2026-10-12T15:00:00Z")) === "2026-10-13")
})

Deno.test("kioskToday: phone hash ignores separators and differs per number", async () => {
  assert(await hashPhone("010-1111-2222") === await hashPhone("01011112222"))
  assert(await hashPhone("01011112222") !== await hashPhone("01011112223"))
  assert(!(await hashPhone("01011112222")).includes("0101111"), "hash must not contain the number")
})

Deno.test("kioskToday: rows link today's earliest attendance and keep stamps and status", async () => {
  const rows = await buildKioskTodayRows(
    [reg(1, 5), reg(2, 6), reg(3, 7, "⚪ 수강 종료")],
    [student(5, "010-1111-2222"), student(6, "010-3333-4444"), student(7, "010-5555-6666")],
    [
      att(2, 1, "2026-10-12T18:00:00+09:00"),
      att(1, 1, "2026-10-12T16:00:00+09:00", { "등원스템프": { date: { start: "2026-10-12T15:55:00+09:00" } }, "출석 상태": { select: { name: "🔵 보강" } } }),
    ],
    "2026-10-12",
  )
  assert(rows.length === 2, "ended registration is not prepared: " + rows.length)
  const r1 = rows.find(r => r.registration_id === id(1))!
  assert(r1.attendance_page_id === att(1, 1, "").id, "earliest attendance chosen")
  assert(r1.checkin_at === "2026-10-12T15:55:00+09:00" && r1.checkout_at === null && r1.attendance_status === "🔵 보강")
  assert(r1.phone_hashes[0] === await hashPhone("01011112222") && r1.class_ids.length === 1 && r1.student_name === "학생1")
  const r2 = rows.find(r => r.registration_id === id(2))!
  assert(r2.attendance_page_id === null && r2.checkin_at === null, "no attendance today")
})

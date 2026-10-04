import { buildKioskDirectory, resolveKioskHint, queryAllKioskPages, kioskPhoneNumbers } from "./kioskIdentity.ts"
function assert(v: unknown, msg = "assertion failed") { if (!v) throw new Error(msg) }
const db = "11111111111111111111111111111111", sdb = "22222222222222222222222222222222"
const rid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", sid = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
function fixtures() {
  const student = { id: sid, parent: { database_id: sdb }, properties: { "이름": { title: [{ plain_text: "테스트" }] }, "어머니 연락처": { phone_number: "010-0000-1111" }, "기타 보호자 연락처": { phone_number: "01000001111" } } }
  const reg = { id: rid, parent: { database_id: db }, properties: { "수강상태": { formula: { string: "🟢 수강 중" } }, "학생정보": { relation: [{ id: sid }] }, "토큰": { rich_text: [{ plain_text: "not-for-kiosk" }] } } }
  return { student, reg }
}
Deno.test("최소 목록은 연락처 정규화·중복 제거, 토큰 미노출", () => {
  const { student, reg } = fixtures(); const rows = buildKioskDirectory([reg], [student]);
  assert(rows.length === 1 && rows[0].phones.length === 1 && rows[0].phones[0] === "01000001111")
  assert(!JSON.stringify(rows).includes("not-for-kiosk")); assert(Object.keys(rows[0]).sort().join() === "className,phones,registrationId,studentName")
})
Deno.test("종료/삭제/학생 없는 등록 제외", () => {
  const { student, reg } = fixtures();
  assert(buildKioskDirectory([{ ...reg, archived: true }], [student]).length === 0)
  assert(buildKioskDirectory([reg], [{ ...student, in_trash: true }]).length === 0)
  assert(buildKioskDirectory([reg], []).length === 0)
  reg.properties["수강상태"].formula.string = "🔴 수강 종료"; assert(buildKioskDirectory([reg], [student]).length === 0)
})
Deno.test("공유 연락처는 형제/복수 등록 후보를 모두 유지", () => {
  const { student, reg } = fixtures(); const rows = buildKioskDirectory([reg, { ...reg, id: "cccccccccccccccccccccccccccccccc" }], [student]); assert(rows.length === 2)
})
Deno.test("정상 힌트는 등록·학생 두 페이지만 조회", async () => {
  const { student, reg } = fixtures(); const calls: string[] = [];
  const result = await resolveKioskHint({ registrationId: rid, phone: "010-0000-1111", registrationDbId: db, studentDbId: sdb, getPage: async id => { calls.push(id); return id === rid ? reg : student } })
  assert(result === reg && calls.join() === [rid,sid].join())
})
Deno.test("다른 전화번호 힌트는 거부", async () => {
  const { student, reg } = fixtures(); assert(await resolveKioskHint({ registrationId: rid, phone: "01099999999", registrationDbId: db, studentDbId: sdb, getPage: async id => id === rid ? reg : student }) === null)
})
Deno.test("종료/다른 DB/삭제 등록은 학생 조회 전에 거부", async () => {
  for (const mode of ["ended", "wrong-db", "archived"]) {
    const { student, reg } = fixtures(); const candidate: any = structuredClone(reg)
    if (mode === "ended") candidate.properties["수강상태"].formula.string = "🔴 수강 종료"
    if (mode === "wrong-db") candidate.parent.database_id = sdb
    if (mode === "archived") candidate.archived = true
    let n = 0; assert(await resolveKioskHint({ registrationId: rid, phone: "01000001111", registrationDbId: db, studentDbId: sdb, getPage: async id => { n++; return id === rid ? candidate : student } }) === null); assert(n === 1)
  }
})
Deno.test("타 DB·삭제 학생/잘못된 ID 거부", async () => {
  const { student, reg } = fixtures()
  for (const bad of [{ ...student, parent: { database_id: db } }, { ...student, archived: true }]) assert(await resolveKioskHint({ registrationId: rid, phone: "01000001111", registrationDbId: db, studentDbId: sdb, getPage: async id => id === rid ? reg : bad }) === null)
  assert(await resolveKioskHint({ registrationId: "invalid", phone: "01000001111", registrationDbId: db, studentDbId: sdb, getPage: async () => { throw new Error("must not fetch") } }) === null)
})
Deno.test("페이지네이션은 마지막 페이지까지 수집", async () => {
  let n = 0; const rows = await queryAllKioskPages(async body => { n++; assert(body.page_size === 100); return n === 1 ? { results: [1], has_more: true, next_cursor: "next" } : { results: [2], has_more: false } }); assert(rows.join() === "1,2" && n === 2)
})
Deno.test("페이지네이션 오류는 불완전한 목록으로 성공하지 않음", async () => {
  for (const cursor of [null, "same"]) { let failed = false; try { await queryAllKioskPages(async () => ({ results: [], has_more: true, next_cursor: cursor })) } catch { failed = true }; assert(failed) }
})
Deno.test("빈 전화번호는 후보에 포함하지 않음", () => { assert(kioskPhoneNumbers({}).length === 0) })

Deno.test("삭제된 힌트의 404만 무효 처리하고 서버 오류는 숨기지 않음", async () => {
  const args = { registrationId: rid, phone: "01000001111", registrationDbId: db, studentDbId: sdb }
  assert(await resolveKioskHint({ ...args, getPage: async () => { throw new Error("Notion page fetch failed: 404 object not found") } }) === null)
  let failed = false; try { await resolveKioskHint({ ...args, getPage: async () => { throw new Error("Notion page fetch failed: 500 error") } }) } catch { failed = true }; assert(failed)
})

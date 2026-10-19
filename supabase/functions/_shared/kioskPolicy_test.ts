import { decideStamp, isClassPropertyError, kioskCheckMode, RECENT_REPEAT_MS, walkInAttendanceProperties } from "./kioskPolicy.ts"

function assert(cond: unknown, msg = "assertion failed") { if (!cond) throw new Error(msg) }

const now = Date.parse("2026-10-12T09:00:00Z")
const ago = (ms: number) => new Date(now - ms).toISOString()

Deno.test("kiosk mode defaults to once", () => {
  assert(kioskCheckMode(undefined) === "once" && kioskCheckMode("x") === "once" && kioskCheckMode("every") === "every")
})

Deno.test("no stamp is always written", () => {
  assert(decideStamp("once", null, now) === "write" && decideStamp("every", undefined, now) === "write")
})

Deno.test("a repeat within two minutes is ignored in both modes", () => {
  assert(decideStamp("once", ago(30_000), now) === "recent")
  assert(decideStamp("every", ago(RECENT_REPEAT_MS - 1), now) === "recent")
})

Deno.test("older stamps: once keeps, every overwrites", () => {
  assert(decideStamp("once", ago(RECENT_REPEAT_MS), now) === "already")
  assert(decideStamp("every", ago(60 * 60 * 1000), now) === "write")
})

Deno.test("a future or unreadable stamp is not treated as recent", () => {
  assert(decideStamp("once", new Date(now + 60_000).toISOString(), now) === "already")
  assert(decideStamp("every", "not-a-date", now) === "write")
})

Deno.test("walk-in attendance writes class only when asked", () => {
  const base = { title: "홍길동 10.19 보강(등원)", registrationId: "r1", nowIso: "2026-10-19T09:00:00+09:00", stampProp: "등원스템프", classIds: ["c1"], teacherIds: ["t1"] }
  const withClass = walkInAttendanceProperties({ ...base, includeClass: true })
  const withoutClass = walkInAttendanceProperties({ ...base, includeClass: false })
  assert("클래스" in withClass && !("클래스" in withoutClass), "class toggle")
  assert("담당강사" in withoutClass && "등원스템프" in withoutClass && "등록" in withoutClass, "other properties kept")
  assert(!("클래스" in walkInAttendanceProperties({ ...base, classIds: [], includeClass: true })), "no class ids → no class")
})

Deno.test("class property rejection is recognised", () => {
  assert(isClassPropertyError('Notion page create failed: 400 {"code":"validation_error","message":"클래스 is expected to be rollup."}'))
  assert(!isClassPropertyError("Notion page create failed: 400 등원스템프 is not a property that exists."))
  assert(!isClassPropertyError("Notion page create failed: 502 클래스"))
})

import { decideStamp, kioskCheckMode, RECENT_REPEAT_MS } from "./kioskPolicy.ts"

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

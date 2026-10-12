import { StepTiming } from "./stepTiming.ts"

function assert(cond: unknown, msg = "assertion failed") { if (!cond) throw new Error(msg) }

Deno.test("step timing records each step and sums repeated names", () => {
  let t = 0
  const timing = new StepTiming(() => t)
  t = 100; timing.mark("auth")
  t = 350; timing.mark("notion")
  t = 400; timing.mark("notion")
  t = 1000
  const s = timing.summary()
  assert(s.total === 1000 && s.auth === 100 && s.notion === 300, JSON.stringify(s))
  assert(timing.header() === "total;dur=1000, auth;dur=100, notion;dur=300", timing.header())
})

Deno.test("step timing header keeps only safe characters in names", () => {
  let t = 0
  const timing = new StepTiming(() => t)
  t = 5; timing.mark("a b/c")
  assert(timing.header().includes("a_b_c;dur=5"), timing.header())
})

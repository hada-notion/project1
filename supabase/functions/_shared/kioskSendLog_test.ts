// 네트워크를 대체한 모의 테스트. 실제 학생/출석/알림톡을 생성하지 않는다.
Deno.test("키오스크 성공/실패 로그의 등하원 구분과 다른 발송 로그 보존", async () => {
  const names = ["NOTION_SEND_LOG_DB_ID", "NOTION_TOKEN"]
  const previous = names.map(name => Deno.env.get(name))
  Deno.env.set("NOTION_SEND_LOG_DB_ID", "11111111111111111111111111111111")
  Deno.env.set("NOTION_TOKEN", "offline-test-only")
  const originalFetch = globalThis.fetch
  const captured: any[] = []
  globalThis.fetch = async (_input, init) => {
    captured.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ id: "mock-log" }), { status: 200 })
  }
  try {
    const { createSendLogEntry } = await import("./adminShared.ts")
    for (const status of ["성공", "실패"] as const) {
      for (const attendanceType of ["등원", "하원"] as const) {
        await createSendLogEntry({ registrationId: "22222222222222222222222222222222", attendanceId: "33333333333333333333333333333333", title: "테스트", category: "키오스크 알림톡", status, attendanceType })
        const p = captured.at(-1).properties
        if (p["출결 구분"]?.select?.name !== attendanceType || p["발송 구분"].select.name !== "키오스크 알림톡" || p["발송 상태"].select.name !== status || !p["출석"]?.relation?.length || p["발송자"]) throw new Error("키오스크 로그 보존 실패")
      }
    }
    for (const category of ["일일 보고서", "주간 보고서", "수강료 안내"] as const) {
      await createSendLogEntry({ registrationId: "22222222222222222222222222222222", title: "테스트", category, status: "성공", attendanceType: "등원", senderUserId: "44444444444444444444444444444444" })
      const p = captured.at(-1).properties
      if (p["출결 구분"] || p["발송자"]?.people?.[0]?.id !== "44444444444444444444444444444444") throw new Error("일반 발송 로그 변경")
    }
    if (captured.length !== 7) throw new Error("로그 테스트 누락")
  } finally {
    globalThis.fetch = originalFetch
    names.forEach((name, i) => { if (previous[i] === undefined) Deno.env.delete(name); else Deno.env.set(name, previous[i]!) })
  }
})

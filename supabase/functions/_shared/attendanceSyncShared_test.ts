// buildAttendanceRow: Notion 출석 페이지 → attendance_records 행(v2.5.99 등원·하원 시각). 네트워크·비밀값 없음.
import { buildAttendanceRow } from "./attendanceSyncShared.ts"
function assert(value: unknown, message = "assertion failed") { if (!value) throw new Error(message) }
const page = (props: Record<string, unknown>) => ({ id: "att1", last_edited_time: "2026-10-14T08:00:00.000Z", properties: {
  "등록": { type: "relation", relation: [{ id: "reg1" }] },
  "수업일시": { type: "date", date: { start: "2026-10-14T17:00:00.000+09:00", end: "2026-10-14T18:00:00.000+09:00" } },
  "출석 상태": { type: "select", select: { name: "🟢 출석" } },
  ...props,
} })
Deno.test("buildAttendanceRow keeps the kiosk arrival and leave stamps apart from the class time", () => {
  const row = buildAttendanceRow(page({ "등원스템프": { type: "date", date: { start: "2026-10-14T16:52:00.000+09:00" } }, "하원스템프": { type: "date", date: { start: "2026-10-14T17:58:00.000+09:00" } } }))!
  assert(row.arrived_at === "2026-10-14T16:52:00.000+09:00" && row.left_at === "2026-10-14T17:58:00.000+09:00", JSON.stringify(row))
  assert(row.check_in === "17:00" && row.check_out === "18:00", "class time unchanged: " + row.check_in + "~" + row.check_out)
  const none = buildAttendanceRow(page({}))!
  assert(none.arrived_at === null && none.left_at === null, "no stamp → null")
  assert(buildAttendanceRow({ id: "x", properties: {} }) === null, "no registration → skipped")
})

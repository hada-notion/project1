// Step timing for slow request paths (e.g. kiosk-checkin). Records how long each named step took, in ms,
// so the Supabase function log shows where the time goes. Only step names and durations are recorded;
// never pass personal data (names, phone numbers, page titles) as a step name.
export class StepTiming {
  private start: number
  private last: number
  private steps: [string, number][] = []

  constructor(private now: () => number = () => performance.now()) {
    this.start = this.now()
    this.last = this.start
  }

  // Close the current step under `name` (time since the previous mark).
  mark(name: string): void {
    const t = this.now()
    this.steps.push([name, Math.round(t - this.last)])
    this.last = t
  }

  total(): number {
    return Math.round(this.now() - this.start)
  }

  // {"total": 1234, "auth": 120, ...} — repeated names are summed.
  summary(): Record<string, number> {
    const out: Record<string, number> = { total: this.total() }
    for (const [name, ms] of this.steps) out[name] = (out[name] ?? 0) + ms
    return out
  }

  // Server-Timing header value: "auth;dur=120, db_ids;dur=300, total;dur=1234"
  header(): string {
    return Object.entries(this.summary())
      .map(([name, ms]) => `${name.replace(/[^A-Za-z0-9_-]/g, "_")};dur=${ms}`)
      .join(", ")
  }
}

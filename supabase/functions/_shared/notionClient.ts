// 공용 Notion API 헬퍼. sync-registration-timetable에서 검증된 재시도/병렬처리 로직과
// sync-registration-textbook에서 발견된 페이지ID 추출 버그 수정을 합쳐서 한 곳에 둔다.
// 이렇게 하면 한쪽에서 고친 버그나 개선사항이 다른 쪽에도 자동으로 적용된다 (로드맵 5-9).

import { NOTION_API, NOTION_TOKEN, NOTION_VERSION } from "./constants.ts"

// "등록"/"종료 처리" 버튼이 눌린 시점의 한국(Asia/Seoul) 날짜를 "YYYY-MM-DD" 형식으로 반환한다.
export function todaySeoulDate(): string {
	return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" })
}

export function notionHeaders() {
	return {
		Authorization: `Bearer ${NOTION_TOKEN}`,
		"Notion-Version": NOTION_VERSION,
		"Content-Type": "application/json",
	}
}

// Notion API가 429(레이트리밋)나 일시적 5xx를 반환하면 Retry-After 헤더(있으면) 또는 지수 백오프만큼
// 대기 후 자동 재시도한다. cascade-delete/fix-attendance에서 검증된, 429 전용보다 더 안전한 버전 (로드맵 5-9).
export async function fetchWithRetry(url: string, init: RequestInit, maxRetries = 5): Promise<Response> {
	let lastRes: Response | undefined
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const res = await fetch(url, init)
		if (res.status !== 429 && res.status < 500) return res
		lastRes = res
		if (attempt === maxRetries) return res
		const retryAfterHeader = res.headers.get("Retry-After")
		const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN
		const backoffMs = Number.isFinite(retryAfterMs) ? retryAfterMs : 300 * Math.pow(2, attempt)
		await new Promise((resolve) => setTimeout(resolve, backoffMs))
	}
	return lastRes!
}

// 동시에 실행되는 작업 수를 concurrency로 제한하면서 배열을 병렬 처리한다
// (Notion API 레이트리밋 대비, 순차 처리보다 훨씬 빠르다).
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length)
	let nextIndex = 0
	async function worker() {
		while (true) {
			const i = nextIndex++
			if (i >= items.length) return
			results[i] = await fn(items[i], i)
		}
	}
	const workerCount = Math.min(concurrency, items.length)
	await Promise.all(Array.from({ length: workerCount }, () => worker()))
	return results
}

export async function queryDataSource(dataSourceId: string, body: Record<string, unknown>) {
	const res = await fetchWithRetry(`${NOTION_API}/data_sources/${dataSourceId}/query`, {
		method: "POST",
		headers: notionHeaders(),
		body: JSON.stringify(body),
	})
	if (!res.ok) {
		throw new Error(`query ${dataSourceId} failed: ${res.status} ${await res.text()}`)
	}
	return res.json()
}

// 필터에 맞는 모든 페이지를 커서를 따라가며 끝까지 모아서 반환한다 (cascade-delete, fix-attendance 등에서 공용으로 사용).
export async function queryAllPages(dataSourceId: string, filter?: Record<string, unknown>): Promise<any[]> {
	const all: any[] = []
	let cursor: string | undefined = undefined
	do {
		const body: Record<string, unknown> = { page_size: 100 }
		if (filter) body.filter = filter
		if (cursor) body.start_cursor = cursor
		const data = (await queryDataSource(dataSourceId, body)) as any
		all.push(...data.results)
		cursor = data.has_more ? data.next_cursor : undefined
	} while (cursor)
	return all
}

export async function getPage(pageId: string) {
	const res = await fetchWithRetry(`${NOTION_API}/pages/${pageId}`, { headers: notionHeaders() })
	if (!res.ok) {
		throw new Error(`get page ${pageId} failed: ${res.status} ${await res.text()}`)
	}
	return res.json()
}

export async function updatePageProperties(pageId: string, properties: Record<string, unknown>) {
	const res = await fetchWithRetry(`${NOTION_API}/pages/${pageId}`, {
		method: "PATCH",
		headers: notionHeaders(),
		body: JSON.stringify({ properties }),
	})
	if (!res.ok) {
		throw new Error(`update page ${pageId} failed: ${res.status} ${await res.text()}`)
	}
	return res.json()
}

export async function createPage(dataSourceId: string, properties: Record<string, unknown>) {
	const res = await fetchWithRetry(`${NOTION_API}/pages`, {
		method: "POST",
		headers: notionHeaders(),
		body: JSON.stringify({ parent: { data_source_id: dataSourceId }, properties }),
	})
	if (!res.ok) {
		throw new Error(`create page in ${dataSourceId} failed: ${res.status} ${await res.text()}`)
	}
	return res.json()
}

export async function archivePage(pageId: string) {
	const res = await fetchWithRetry(`${NOTION_API}/pages/${pageId}`, {
		method: "PATCH",
		headers: notionHeaders(),
		body: JSON.stringify({ archived: true }),
	})
	if (!res.ok) {
		const text = await res.text()
		// 이미 archived된 페이지를 다시 archive하려고 하면 Notion이 400 validation_error를 준다.
		// 짧은 시간 안에 여러 건을 삭제할 때, 서로 다른 캐스케이드 삭제가 같은 하위 페이지(예: 여러
		// 학생이 공유하는 학습기록)를 함께 가리켜서 거의 동시에 둘 다 archive를 시도하는 경우 발생한다
		// (2026-09-12 fix). 목표(페이지가 삭제된 상태)는 이미 달성되어 있으므로 오류로 취급하지 않고
		// 조용히 성공 처리한다.
		if (res.status === 400 && text.includes("Can't edit block that is archived")) {
			return { id: pageId, archived: true }
		}
		throw new Error(`archive page ${pageId} failed: ${res.status} ${text}`)
	}
	return res.json()
}

// ---------- 페이지 속성 읽기 공용 유틸 ----------

export function relIds(prop: any): string[] {
	return (prop?.relation ?? []).map((r: any) => r.id)
}

export function relationIds(page: any, propName: string): string[] {
	return relIds(page?.properties?.[propName])
}

export function selectName(page: any, propName: string): string | undefined {
	return page?.properties?.[propName]?.select?.name
}

export function statusName(page: any, propName: string): string | undefined {
	return page?.properties?.[propName]?.status?.name
}

export function formulaString(page: any, propName: string): string | undefined {
	return page?.properties?.[propName]?.formula?.string
}

export function titleText(page: any, propName: string): string | undefined {
	return page?.properties?.[propName]?.title?.[0]?.plain_text
}

// 지정한 이름이 아니라, 페이지의 title 타입 속성을 찾아서 반환한다 (속성명을 모를 때 사용).
export function anyTitleText(page: any): string {
	const properties = page?.properties ?? {}
	for (const key of Object.keys(properties)) {
		const prop = properties[key]
		if (prop?.type === "title") {
			const title = prop.title ?? []
			return title.map((t: any) => t.plain_text ?? "").join("")
		}
	}
	return ""
}

export function dateStart(page: any, propName: string): string | null {
	return page?.properties?.[propName]?.date?.start ?? null
}

export function checkboxValue(page: any, propName: string): boolean {
	return page?.properties?.[propName]?.checkbox === true
}

// 이미 연결된 relation에 addIds를 합쳐서(중복 제거) 다시 저장한다. 이미 전부 연결돼 있으면 아무것도 하지 않는다.
// 등록 페이지의 "동기화 상태"(사용자에게 보이는 select)를, 시간표/교재 두 Edge Function이 각각
// 처리 중인지 표시하는 체크박스 두 개를 조합해서 계산한다. 서로 독립적인 두 함수가 동시에 실행돼도
// (예: 같은 웹훅 자동화가 두 함수를 모두 호출하는 경우) 한쪽이 끝났다고 바로 "완료"로 표시하지 않고,
// 다른 쪽이 아직 처리 중이면 "처리 중"을 유지한다. 상태 표시 실패는 본 로직에 영향 없도록 조용히 무시한다.
export async function setCombinedSyncStatus(
	pageId: string,
	args: {
		selfFlagProp: string
		// (v2, 2026-09-11) "동기화 상태" select를 조합하던 용도였는데, 체크박스를 실시간으로 읽는
		// "실시간 처리 상태" 수식으로 대체되면서 이 함수 내부에서는 더 이상 쓰지 않는다. 호출부
		// (makeSyncStatusSetter/makeClassStatusSetter)가 여전히 넘기고 있어서 시그니처만 유지한다.
		otherFlagProps: string[]
		// "마지막 오류" 텍스트 속성 이름. 실패 시 에러 메시지를 쓰고, 성공 시 비운다.
		errorProp: string
		syncedAtProp?: string
		// [NEW, 2026-09-17] 넘기면 "처리중" 시작 시각을 이 날짜 속성에 기록한다 (무한 멈춤 자동
		// 복구용, makeSyncStatusSetter 주석 참고).
		startedAtProp?: string
		phase: "start" | "success" | "error"
		errorMessage?: string
	},
) {
	try {
		if (args.phase === "start") {
			// 새 실행이 시작되는 순간(버튼 클릭 직후) 이전 오류를 바로 지워서, 끝날 때까지 오래된 오류
			// 텍스트가 "실시간 처리 상태" 수식에 남아있지 않도록 합니다 (2026-09-11 fix).
			await updatePageProperties(pageId, {
				[args.selfFlagProp]: { checkbox: true },
				[args.errorProp]: { rich_text: [] },
				...(args.startedAtProp ? { [args.startedAtProp]: { date: { start: new Date().toISOString() } } } : {}),
			})
			return
		}
		if (args.phase === "error") {
			const message = (args.errorMessage ?? "알 수 없는 오류").slice(0, 1900)
			await updatePageProperties(pageId, {
				[args.selfFlagProp]: { checkbox: false },
				[args.errorProp]: { rich_text: [{ text: { content: message } }] },
			})
			return
		}
		// success: 내 플래그를 끄고 "마지막 오류"를 비운다. "실시간 처리 상태" 수식이 체크박스들을
		// 실시간으로 조합해서 보여주므로, 더 이상 select 조합(다른 플래그 재조회) 로직이 필요 없다.
		const properties: Record<string, unknown> = {
			[args.selfFlagProp]: { checkbox: false },
			[args.errorProp]: { rich_text: [] },
		}
		if (args.syncedAtProp) {
			properties[args.syncedAtProp] = { date: { start: new Date().toISOString() } }
		}
		await updatePageProperties(pageId, properties)
	} catch {
		// 상태 표시 실패는 무시
	}
}

export async function addRelation(pageId: string, propName: string, addIds: string[]) {
	const page = await getPage(pageId)
	const existing = relationIds(page, propName)
	const merged = Array.from(new Set([...existing, ...addIds]))
	if (merged.length === existing.length) return
	await updatePageProperties(pageId, { [propName]: { relation: merged.map((id) => ({ id })) } })
}

// ---------- 웹훅 body에서 페이지 ID 추출 ----------
//
// 문자열 "끝"에서만 UUID를 추출한다. Notion 페이지 URL은 항상 맨 끝에 페이지 ID가 붙기 때문에,
// 문자열 중간 어디서든 찾는 방식은 한글 제목 슬러그(예: "고1A반-...")의 hex처럼 보이는 글자(1,A 등)가
// 실제 ID 바로 앞에 붙어 있을 때 ID가 밀려서 잘못 잘리는 버그가 있었다 (2026-09-09, sync-registration-textbook에서 실제 발생 확인).
export function idFromString(v: string): string | null {
	const cleaned = v.split("?")[0].replace(/\/$/, "")
	const match = cleaned.match(
		/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i,
	)
	return match ? match[0].replace(/-/g, "") : null
}

// body에서 pageId/pageUrl/url/id 필드를 우선 확인하고, data 안에 중첩된 경우도 확인하고,
// 그래도 못 찾으면 body 전체를 재귀적으로 훑어 문자열 끝에서 ID를 찾는다 (최후 수단).
export function extractPageId(body: unknown): string | null {
	const tryFields = (obj: Record<string, unknown>): string | null => {
		for (const key of ["pageId", "pageUrl", "url", "id"]) {
			const v = obj[key]
			if (typeof v === "string") {
				const id = idFromString(v)
				if (id) return id
			}
		}
		return null
	}
	if (typeof body === "object" && body !== null) {
		const obj = body as Record<string, unknown>
		const direct = tryFields(obj)
		if (direct) return direct
		const data = obj["data"]
		if (typeof data === "object" && data !== null) {
			const nested = tryFields(data as Record<string, unknown>)
			if (nested) return nested
		}
		const stack: unknown[] = [body]
		while (stack.length) {
			const cur = stack.pop()
			if (typeof cur === "string") {
				const id = idFromString(cur)
				if (id) return id
			} else if (Array.isArray(cur)) {
				stack.push(...cur)
			} else if (typeof cur === "object" && cur !== null) {
				stack.push(...Object.values(cur as Record<string, unknown>))
			}
		}
	}
	return null
}

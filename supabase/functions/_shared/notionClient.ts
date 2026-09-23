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
//
// (2026-09-22, Phase 6: 동시성 제어) 기존에는 fetch() 자체에 타임아웃이 전혀 없어서, Notion API
// 호출 하나가 응답 없이 멈추면(드물지만 실제로 generate-classes에서 재현됨, 2026-09-21) 그 위의
// markRunning된 "작업중" 상태도 영원히 멈춰 있었다 -- sweepStaleStatus 워치독이 15분 뒤에 상태
// 표시는 회수해도, 실제로 멈춘 fetch 자체는 회수하지 못했다(재클릭해야만 새 시도가 시작됨). 이제
// AbortController로 요청마다 FETCH_TIMEOUT_MS 제한을 걸어서, 응답 없이 멈춘 호출도 타임아웃 ->
// 기존 백오프 재시도 경로로 흘러들어가게 한다 -- 즉 "영원히 멈춤"이 최악의 경우에도 "몇 번의
// 타임아웃 + 백오프만큼 지연 후 자동 복구(또는 명확한 오류)"로 바뀐다. 마스터플랜:
// https://app.notion.com/p/903c90386c1d473494c5df6306c53517
//
// (2026-09-23, PART N-11 후속) 처음엔 30초로 뒀는데, 이게 오히려 Supabase 플랫폼 자체의
// WallClockTime 한도(150초)보다 재시도 로직이 더 오래 걸리게 만드는 원인이었다: 요청이 응답 없이
// 계속 멈추면 maxRetries=5(총 6번 시도) x 30초 타임아웃 + 백오프 대기 ≈ 189초가 걸려야 이 함수가
// 스스로 포기하고 에러를 던지는데, 그 전에 플랫폼이 150초에서 먼저 강제 종료시켜버린다 (실제로
// backfill-attendance에서 cpu_time_used=92ms, wall clock 정확히 150초로 재현됨 -- 거의 전부
// "응답 대기"만 하다가 죽었다는 뜻). 30초 -> 12초로 줄이면 최악의 경우도 6번 x 12초 + 백오프
// ≈ 81초로 끝나서, 150초 한도보다 훨씬 먼저 스스로 포기하고 명확한 에러를 던지게 된다 -- 그래야
// 위쪽의 청크+체인 로직이 그 에러를 잡아서 로그를 남기고 다음 라운드로 넘어갈 수 있다. 정상적인
// Notion API 응답은 보통 수 초 안에 오므로, 12초는 여전히 넉넉한 여유다.
const FETCH_TIMEOUT_MS = 12_000

export async function fetchWithRetry(url: string, init: RequestInit, maxRetries = 5): Promise<Response> {
	let lastRes: Response | undefined
	let lastErr: Error | undefined
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const controller = new AbortController()
		const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
		try {
			const res = await fetch(url, { ...init, signal: controller.signal })
			if (res.status !== 429 && res.status < 500) return res
			lastRes = res
			lastErr = undefined
			if (attempt === maxRetries) return res
			const retryAfterHeader = res.headers.get("Retry-After")
			const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN
			const backoffMs = Number.isFinite(retryAfterMs) ? retryAfterMs : 300 * Math.pow(2, attempt)
			await new Promise((resolve) => setTimeout(resolve, backoffMs))
		} catch (err) {
			// fetch 자체가 타임아웃(AbortError)이나 네트워크 오류로 실패한 경우. 429/5xx와 동일한
			// 백오프 스케줄로 재시도하고, 마지막 시도까지 전부 실패하면 원인을 알 수 있는 오류를 던진다
			// (호출자는 이미 전부 이 예외를 자기 catch->markError 경로로 처리하도록 되어 있어 안전하다).
			lastErr = err as Error
			lastRes = undefined
			if (attempt === maxRetries) {
				throw new Error(
					`Notion API 요청이 ${maxRetries + 1}번 시도 후에도 실패함 (마지막 원인: ${lastErr.message}): ${url}`,
				)
			}
			const backoffMs = 300 * Math.pow(2, attempt)
			await new Promise((resolve) => setTimeout(resolve, backoffMs))
		} finally {
			clearTimeout(timeoutId)
		}
	}
	if (lastRes) return lastRes
	throw lastErr ?? new Error(`fetchWithRetry: 알 수 없는 오류로 응답을 받지 못함: ${url}`)
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

// [NEW, 2026-09-23, PART N-8: 일괄전송 고정 청크 재설계] 한 번에 최대 limit개까지만, 지정한
// 정렬 순서로 가져온다. queryAllPages와 달리 커서를 따라가며 끝까지 모으지 않고 첫 페이지만 본다 --
// send-selected-notifications가 "이름순 10건만" 처리하고 나머지는 스스로 이어달리기하도록 바뀌면서
// 필요해졌다. limit이 100을 넘으면 Notion API 한 페이지 한도(100)로 잘린다(현재 호출부는 항상
// 100 이하만 쓴다).
export async function queryPagesLimited(
	dataSourceId: string,
	filter: Record<string, unknown> | undefined,
	sorts: Record<string, unknown>[] | undefined,
	limit: number,
): Promise<any[]> {
	const body: Record<string, unknown> = { page_size: Math.min(limit, 100) }
	if (filter) body.filter = filter
	if (sorts) body.sorts = sorts
	const data = (await queryDataSource(dataSourceId, body)) as any
	return (data.results ?? []).slice(0, limit)
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

// [2026-09-17] 일부 날짜 속성(예: 학습기록의 "수업일")이 사용자가 직접 입력하는 date 타입에서
// 관계를 통해 자동 계산되는 formula 타입으로 바뀌면서, Notion API 응답 모양이 date.start가 아니라
// formula.date.start로 바뀌었다. 두 모양을 모두 지원해서, 속성 타입이 나중에 다시 바뀌어도 기존
// 호출부가 계속 동작하게 한다.
export function dateStart(page: any, propName: string): string | null {
	const prop = page?.properties?.[propName]
	return prop?.date?.start ?? prop?.formula?.date?.start ?? null
}

export function checkboxValue(page: any, propName: string): boolean {
	return page?.properties?.[propName]?.checkbox === true
}

// [2026-09-17, 6차 수정] setCombinedSyncStatus의 각 단계(시작/완료/오류)를 실제로 Notion에 쓰는
// 부분. updatePageProperties는 fetchWithRetry를 통해 429/5xx는 이미 재시도하지만, 그 외의 순간적인
// 네트워크 예외(fetch 자체가 throw하는 경우 등)는 재시도 없이 곧바로 실패한다. 이 쓰기 하나가 바로
// 체크박스를 다시 꺼주는 마지막 단계이므로, 여기서만이라도 별도로 몇 번 더 재시도하고, 그래도 안
// 되면 반드시 로그를 남긴다 (예전에는 catch{}로 완전히 조용히 무시해서 실패 사실 자체를 알 수
// 없었다 -- "교재 일괄 배부"가 실제 처리는 다 끝내고 로그에도 finished까지 찍혔는데도 체크박스만
// 영원히 켜져 있던 사례가 바로 이 경로였다).
// [2026-09-17, 7차 수정] 6차 수정(재시도 3회, 최대 1.6초 대기) 이후에도 이 마지막 쓰기 3번이 모두
// 실패해서 체크박스가 계속 켜진 채로 남는 사례가 다시 나왔다. 재시도 횟수를 5회로 늘리고 대기
// 시간도 1초 단위로 늘려서, 일시적인 네트워크 문제가 조금 더 오래 가도 견딜 수 있게 한다 (그래도
// 다 실패하는 극단적인 경우를 위해, sync-textbook-distribution의 from-class 핸들러에도 재클릭 시
// 실제 데이터로 완료 여부를 다시 계산하는 별도의 자가 복구를 추가했다).
async function updateStatusWithRetry(
	pageId: string,
	properties: Record<string, unknown>,
	phase: "start" | "success" | "error",
): Promise<void> {
	const maxAttempts = 5
	let lastErr: unknown
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			await updatePageProperties(pageId, properties)
			return
		} catch (err) {
			lastErr = err
			if (attempt < maxAttempts) {
				await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
			}
		}
	}
	console.error(
		`[setCombinedSyncStatus] 상태 표시 갱신 최종 실패 (phase=${phase}, pageId=${pageId}) -- 체크박스/오류 표시가 갱신되지 않았을 수 있음:`,
		(lastErr as Error)?.message ?? String(lastErr),
	)
}

// 등록 페이지의 "동기화 상태"(사용자에게 보이는 select)를, 시간표/교재 두 Edge Function이 각각
// 처리 중인지 표시하는 체크박스 두 개를 조합해서 계산한다. 서로 독립적인 두 함수가 동시에 실행돼도
// (예: 같은 웹훅 자동화가 두 함수를 모두 호출하는 경우) 한쪽이 끝났다고 바로 "완료"로 표시하지 않고,
// 다른 쪽이 아직 처리 중이면 "처리 중"을 유지한다.
//
// [2026-09-17, 6차 수정 -- 진짜 마지막 원인] 예전에는 이 함수 전체가 try/catch{}로 감싸여 있어서,
// "완료/오류로 바꾸는 이 마지막 쓰기 자체"가 실패해도 완전히 조용히 무시됐다. 즉 실제 처리(교재배부
// 생성 등)는 다 끝나고 로그에도 "finished"가 정상적으로 찍히는데, 정작 체크박스를 다시 끄는 이
// 마지막 PATCH 한 번만 실패하면 그 사실을 아무도 알 수 없고, 체크박스는 영원히 켜진 채로 남는다 --
// 재클릭 자동 복구(3차 수정)가 있어야만 풀린다. generate-tuition/report도 이 함수를 그대로 쓰지만,
// 한 번 실행에 필요한 Notion API 호출 수가 이 함수(학생 1명당 진도교재 조회+기존 교재배부 조회+생성
// 등 여러 건)보다 훨씬 적어서 이 마지막 쓰기가 불운하게 실패할 확률 자체가 낮았을 뿐, 구조적으로는
// 똑같이 취약했다. 이제 실제 쓰기는 위 updateStatusWithRetry로 옮겨서 (a) 재시도하고 (b) 다 실패해도
// 반드시 로그를 남기도록 바꿨다.
export async function setCombinedSyncStatus(
	pageId: string,
	args: {
		selfFlagProp: string
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
	if (args.phase === "start") {
		// 새 실행이 시작되는 순간(버튼 클릭 직후) 이전 오류를 바로 지워서, 끝날 때까지 오래된 오류
		// 텍스트가 "실시간 처리 상태" 수식에 남아있지 않도록 합니다 (2026-09-11 fix).
		await updateStatusWithRetry(
			pageId,
			{
				[args.selfFlagProp]: { checkbox: true },
				[args.errorProp]: { rich_text: [] },
				...(args.startedAtProp ? { [args.startedAtProp]: { date: { start: new Date().toISOString() } } } : {}),
			},
			"start",
		)
		return
	}
	if (args.phase === "error") {
		const message = (args.errorMessage ?? "알 수 없는 오류").slice(0, 1900)
		await updateStatusWithRetry(
			pageId,
			{
				[args.selfFlagProp]: { checkbox: false },
				[args.errorProp]: { rich_text: [{ text: { content: message } }] },
			},
			"error",
		)
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
	await updateStatusWithRetry(pageId, properties, "success")
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

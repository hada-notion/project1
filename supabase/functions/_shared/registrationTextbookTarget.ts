// _shared/registrationTextbookTarget.ts
//
// sync-registration-textbook의 "개별교재 생성" 버튼(create-individual 라우트) 실제 로직을 별도
// 파일로 분리했다 (2026-09-18, 큐 기반 순차 처리 도입, Phase 3). cleanup-on-end 라우트는
// 다른 함수들이 내부적으로 동기 호출(fetch)해서 즉시 결과를 받아야 하므로 큐로 옮기지 않고
// index.ts에 그대로 둔다 (이 파일에서는 그 로직도 함께 두어 라우트 핸들러를 가벼게 유지한다).
//
// (2026-09-22, PART N-4: 개별 트리거 버튼 동기화 전환) create-individual 라우트도 등록 페이지 1건만
// 대상으로 하는 개별 트리거라 processCreateIndividualBooksQueueItem(process-sync-queue 전용
// 진입점)은 제거했다. index.ts가 createIndividualBooksForRegistration을 직접 호출한다.
//
// (2026-09-22, PART N-7: 클래스 "진도교재" 25개 제한 버그 수정) createIndividualBooksForRegistration이
// 클래스 페이지를 getPage로 통째로 읽어서 그 안의 "진도교재" relation을 후보로 쓰고 있었는데, Notion
// 페이지 조회 API는 relation 속성을 최대 25개까지만 돌려주고 나머지는 잘라버린다. "진도교재"는
// "클래스"<->"진도교재" 양방향 관계라 인스턴스가 생길 때마다 이 목록에도 자동으로 끼어들기 때문에,
// 개별 지도처럼 학생이 많이 쌓이는 클래스는 금방 25개를 넘기고 그 뒤로는 진짜 템플릿 일부가 후보
// 목록에서 조용히 사라진다 (실제로 "고등 과외" 클래스에서 템플릿 8개 중 4개가 이렇게 누락되어 개별
// 진도 교재 인스턴스가 일부만 생성되는 문제로 나타났다). 클래스 페이지를 거치지 않고, 진도교재
// 데이터소스를 "클래스 = 이 클래스"로 직접 쿼리(queryAllPages, 커서 끝까지 따라감)하도록 고쳤다.
//
// (2026-09-22, PART N-8: 클래스 "교재 생성" 버튼 라우트 누락 수정) 클래스(학원) DB "교재 생성" 버튼
// 자동화가 실제로는 sync-registration-textbook의 create-class 라우트를 호출하고 있었는데, 이
// 파일과 index.ts에는 create-individual/cleanup-on-end 두 라우트만 있었고 create-class는 애초에
// 구현된 적이 없었다 (항상 404 "알 수 없는 경로: create-class" — Supabase 로그로 실제 운영 클래스
// "고1 A반"에서도 확인됨, 화면에는 그냥 아무 반응 없음으로만 보였다). 클래스에 연결된 활성(🟢 수강
// 중) 등록 전체에 대해 createIndividualBooksForRegistration을 실행하는 createBooksForClass를
// 추가했다. 현재는 create-individual과 동일한 runSyncWebhookForPage를 재사용해 즉시 응답 후
// EdgeRuntime.waitUntil 백그라운드에서 처리한다. pageId 자리에 classId를 넘기고, 잠금/상태 속성은
// 클래스 DB의 "교재 생성 상태"와 "마지막 오류"를 사용한다.
//
// (2026-10-04, PART N-11: 클래스 "교재 생성" 순차 이어달리기 재설계) PART N-8의 createBooksForClass는
// mapWithConcurrency(registrations, 4, ...)로 등록 여러 건을 "동시에" 처리했다. 그런데 그룹 진도
// 모드에서는 반별교재(템플릿) 페이지 "하나"를 반 전체 등록이 공유하고, resolveInstanceForTemplate이
// 그 템플릿의 "등록" relation을 읽고(read) -> 수정하고(modify) -> 통째로 다시 쓰는(write) 방식으로
// 등록을 추가한다. 이 read-modify-write가 원자적이지 않아서, 같은 템플릿을 동시에 겨냥하는 등록
// 여러 건의 쓰기가 서로 경쟁(race)하면 "마지막에 쓴 쪽이 이긴다" -- 즉 먼저 끝낸 등록들이 추가한
// 내용이 조용히 덮어써져 사라진다. 실제로 "고1 A" 클래스(6명 x 템플릿 4개 = 24쌍)에서 일부 쌍만
// 연결되거나 한쪽 방향으로만 연결되는 현상으로 나타났고, 학생 수가 많아질수록(동시 처리 4건) 더
// 자주 재현된다. 근본 해결은 "등록을 절대 동시에 처리하지 않는 것"이다 -- 클래스 배치 레벨에서는
// 완전히 순차 처리하도록 바꾼다(등록 1건 안에서 서로 다른 템플릿들을 mapWithConcurrency(4)로 처리하는
// 것은 그대로 안전하다 -- 템플릿이 다르면 공유 상태가 없다).
//
// 동시에 사용자가 요청한 두 번째 문제("처리 중 실시간 상태를 보고 싶다")도 함께 해결한다:
// 완전 순차 처리 자체가 다건 배치에서 Supabase Edge Function의 플랫폼 실행시간 한도(~150초)에
// 걸릴 수 있으므로, send-selected-notifications(알림톡 발송함 "일괄 전송")와 동일한 "고정 청크
// (여기서는 1건) + 자기 호출 이어달리기" 패턴을 쓴다(index.ts). 그 패턴이 등록을 한 건씩 처리하는
// 동안, 등록(학원) DB의 "교재 상태"(개별 "개별교재 생성" 버튼이 이미 쓰는 것과 동일한 속성)도 함께
// 갱신해서, 클래스 버튼으로 처리되는 중에도 각 학생 등록 페이지에서 실시간 진행 상황이 보이게
// 한다 -- 별도 Notion 스키마 변경 없이 기존 속성을 재사용한다. 아래 createBooksForClass(동시 처리)는
// 제거하고, index.ts의 이어달리기 루프가 매 홉마다 쓰는 getPendingClassTextbookRegistrations /
// createBooksForOneRegistrationWithStatus로 대체했다.
//
// (2026-10-04, PART N-11 실사용 검증) "고1 A" 클래스에서 실제 버튼으로 재현 테스트해 경쟁(race)
// 없이 등록 전원이 순차 정상 연결됨을 확인했다. 테스트 과정에서 getPendingClassTextbookRegistrations의
// 판정 기준에 대한 혼동이 한 번 있었다 -- 이 함수는 "진도교재"/템플릿의 "등록" relation이 실제로
// 연결돼 있는지가 아니라 "교재 상태" select 값만 보고 완료 여부를 판정한다. 그래서 테스트용으로
// relation만 수동으로 연결 해제하고 "교재 상태"는 "완료"로 남겨둔 학생은 여전히 "완료"로 간주돼
// 다음 배치에서 건너뛰어졌다(아래 getPendingClassTextbookRegistrations 함수 설명 참고). 정상
// 운영 중에는 "개별교재 생성"/"교재 생성" 두 버튼이 항상 relation과 "교재 상태"를 함께 갱신하므로
// 이 간극이 생기지 않는다 -- 수동으로 relation만 건드리는 경우(주로 테스트/데이터 보정)에만
// "교재 상태"도 함께 초기화해야 한다는 점을 기억해둔다.
//
// (2026-10-04, PART N-12: 대상 판정을 "교재 상태"에서 실제 relation 비교로 전환) 위 검증 과정에서
// 드러난 더 근본적인 사례: 클래스에 반별교재(템플릿)가 "나중에 새로 추가"되면, 이미 "교재 상태 완료"인
// 기존 학생들은 getPendingClassTextbookRegistrations가 애초에 대상에서 제외해서 클래스 "교재 생성"
// 버튼을 다시 눌러도 새 템플릿을 받지 못한다 (사용자 지적 - 교재 상태만 보는 한 피할 수 없는 구조적
// 한계). "교재 상태" select 값 대신, 클래스의 템플릿 목록과 각 등록의 실제 연결 상태를 직접 비교하는
// 방식으로 바꾼다 -- 클래스의 템플릿을 한 번만 조회해서(getClassTextbookPages) 그룹 진도는 템플릿의
// "등록" relation과 등록의 "진도교재" relation 양쪽에 서로 포함되는지, 개별 진도는 (등록+템플릿)에
// 해당하는 인스턴스가 존재하고 그 인스턴스가 등록의 "진도교재"에 포함되는지를 확인한다
// (isTemplateSatisfiedForRegistration). 모든 템플릿이 충족된 등록은 "이미 동일함" -> 빠르게 건너뛰고,
// 하나라도 빠진 등록만 처리 대상(pending)으로 잡는다. 템플릿이 아예 없으면(클래스 세팅 전) 할 일이
// 없는 것이므로 건너뛴다. 덤으로 예전 경쟁(race) 버그로 남아있을 수 있는 "한쪽 방향만 연결된" 상태도
// 양쪽을 다 확인하므로 자동으로 다시 pending 처리되어 스스로 복구된다. "교재 상태"(TEXTBOOK_STATUS_SPEC)
// 자체는 여전히 createBooksForOneRegistrationWithStatus가 갱신해서 사용자가 보는 실시간 진행 표시
// 용도로는 그대로 남겨둔다 - 다만 더 이상 "처리할 대상인지"를 가르는 기준으로는 쓰지 않는다.

import {
	PROP_CLASS,
	PROP_LAST_ERROR,
	DS_REGISTRATION,
	PROP_STATUS,
} from "./constants.ts"
import {
	getPage,
	queryDataSource,
	queryAllPages,
	createPage,
	updatePageProperties,
	archivePage,
	relationIds,
	selectName,
	statusName,
	titleText,
	formulaString,
	mapWithConcurrency,
} from "./notionClient.ts"
import { type StatusSpec, markRunning, markError, STATUS_DONE } from "./statusTracking.ts"
import { LIBRARY_PROP, libraryIds, libraryKey } from "./libraryProp.ts"
import { libraryCopyReady, readBooks } from "./libraryCopy.ts"

// (2026-09-22, 처리 상태 관리 리팩토링 Phase 3) "교재 처리중" 체크박스(등록 DB, create-individual
// 라우트 전용) → "교재 상태"(select) + "교재 처리 시작 시각"(date). 마스터플랜:
// https://app.notion.com/p/903c90386c1d473494c5df6306c53517
export const TEXTBOOK_STATUS_SPEC: StatusSpec = {
	statusProp: "교재 생성 상태",
	errorProp: PROP_LAST_ERROR,
	startedAtProp: "교재 생성 시작 시각",
}

// (2026-09-22, PART N-8 -> Phase 3 전환) 클래스(학원) DB "교재 생성" 버튼 전용 상태. "교재 생성중"
// 체크박스 -> "교재 생성 상태"(select) + "교재 생성 처리 시작 시각"(date). 클래스 DB의 "마지막
// 오류"는 수강료 생성/보고서 생성 등과 공유하는 필드다(PROP_LAST_ERROR, 값 동일). 마스터플랜:
// https://app.notion.com/p/903c90386c1d473494c5df6306c53517
export const CLASS_TEXTBOOK_STATUS_SPEC: StatusSpec = {
	statusProp: "교재 생성 상태",
	errorProp: PROP_LAST_ERROR,
	startedAtProp: "교재 생성 처리 시작 시각",
}

const DATA_SOURCE_PROGRESS_BOOK = Deno.env.get("DATA_SOURCE_PROGRESS_BOOK_ID")! // 진도교재(학원) DB

// 진도교재(학원) DB 속성 이름
const PROP_BOOK_TITLE = "진도교재" // title
const PROP_TEMPLATE_RELATION = "반별교재" // 인스턴스 -> 템플릿 (self-relation, limit 1)
const PROP_PROGRESS_MODE = "진도방식" // 개별 진도 | 그룹 진도
const PROP_PROGRESS_STATUS = "진행상태" // 다음 교재 | 진행 중 | 미사용 | 완료
const PROP_CLASS_ON_BOOK = "클래스" // relation (진도교재 DB 쪽)
const PROP_REGISTRATION_ON_BOOK = "등록" // relation
const PROP_LEARNING_RECORD = "학습기록" // relation
const PROP_REGISTRATION_BOOKS = "진도교재" // 등록 DB 쪽 relation
const STATUS_NEXT = "다음 교재"

// 클래스(학원) DB "교재 생성" 버튼 대상 판정 기준. 보고서 생성/수강료 생성/교재비 생성 등 다른
// 클래스 단위 일괄 버튼과 동일하게 "현재 🟢 수강 중"인 등록만 대상으로 한다.
const STATUS_ACTIVE = "🟢 수강 중"

// 제목의 서식이 나뉘어 있어도 첫 조각만 복사하지 않고 전체 문자열을 사용한다.
function fullBookTitle(page: any, name: string): string {
	return (page?.properties?.[name]?.title ?? []).map((part: any) => part.plain_text ?? part.text?.content ?? "").join("")
}

// (v2.6.10, 웹훅 재정리 1단계) 등록 쪽에서 한 번만 쓴다.
// 등록.진도교재와 진도교재.등록은 하나의 양방향 관계라, 등록의 "진도교재"를 쓰면 템플릿·개별교재의 "등록"은
// Notion이 맞춘다. 예전에는 그룹 템플릿의 "등록"을 읽고-고치고-다시 썼는데, 페이지 조회는 관계를 25개까지만
// 돌려줘서 25명이 넘는 반에서는 다시 쓸 때 나머지 연결이 지워질 수 있었다. 이제 템플릿 쪽은 쓰지 않는다.
// Notion 호출: (등록 조회 1, 웹훅 본문에 클래스·이름이 있으면 0) + 클래스 교재 조회 1 + 이 등록의 교재 조회 1
// + 없는 개별교재 생성 + 등록 쓰기 1. 이 등록의 교재 조회가 관계 25개 제한 없이 지금 연결 전체를 준다.
// bookIds: 페이지에서 읽은 등록의 "진도교재"(25개 미만일 때만 믿는다). 웹훅 본문에는 없다.
export type RegistrationSnapshot = { id: string; classId: string | null; name: string; bookIds?: string[] }

export function snapshotFromRegistrationPage(page: any): RegistrationSnapshot {
	return { id: page.id as string, classId: relationIds(page, PROP_CLASS)[0] ?? null, name: fullBookTitle(page, "이름"), bookIds: relationIds(page, PROP_REGISTRATION_BOOKS) }
}

// Notion 자동화 웹훅 본문(data.properties)에서 등록의 클래스·이름을 꺼낸다. 둘 중 하나라도 없으면 null(페이지를 읽는다).
export function snapshotFromWebhookBody(body: any, pageId: string): RegistrationSnapshot | null {
	const props = body?.data?.properties
	if (!props || typeof props !== "object") return null
	const cls = props[PROP_CLASS], name = props["이름"]
	if (!Array.isArray(cls?.relation) || !Array.isArray(name?.title)) return null
	return { id: pageId, classId: cls.relation[0]?.id ?? null, name: fullBookTitle({ properties: { 이름: name } }, "이름") }
}

// 교재명: 라이브러리 복사본이 준비됐으면 Supabase에서(Notion 호출 0), 아니면 라이브러리 페이지를 읽는다.
async function libraryTitles(ids: string[]): Promise<Map<string, string>> {
	const out = new Map<string, string>()
	if (!ids.length) return out
	if (await libraryCopyReady()) {
		try {
			for (const b of await readBooks(ids)) if (b.title) out.set(b.id, b.title)
		} catch (err) {
			console.error("[registrationTextbook] 라이브러리 복사본 읽기 실패(Notion을 읽음):", (err as Error).message)
		}
	}
	const missing = ids.filter((id) => !out.has(id))
	const pages = await mapWithConcurrency(missing, 3, (id) => getPage(id).catch(() => null))
	pages.forEach((p, i) => { const t = p ? fullBookTitle(p, "교재명") : ""; if (t) out.set(missing[i], t) })
	return out
}

// 이 등록에 연결된 진도교재 전체(관계 25개 제한 없이)
async function booksOfRegistration(registrationId: string): Promise<any[]> {
	return await queryAllPages(DATA_SOURCE_PROGRESS_BOOK, { property: PROP_REGISTRATION_ON_BOOK, relation: { contains: registrationId } })
}

type CreateOptions = {
	// 큐 처리: 등록 쓰기에 함께 넣을 속성(교재 상태 완료 등). 있으면 바뀐 것이 없어도 한 번 쓴다.
	extraProps?: Record<string, unknown>
}

export async function createIndividualBooksForRegistration(registrationId: string, snapshot?: RegistrationSnapshot, opts: CreateOptions = {}) {
	const reg = snapshot ?? snapshotFromRegistrationPage(await getPage(registrationId))
	const finish = async (props: Record<string, unknown>) => {
		const all = { ...props, ...(opts.extraProps ?? {}) }
		if (Object.keys(all).length) await updatePageProperties(registrationId, all)
	}
	if (!reg.classId) { await finish({}); return { skipped: "클래스가 아직 연결되어 있지 않음" } }

	const candidates = await queryAllPages(DATA_SOURCE_PROGRESS_BOOK, {
		property: PROP_CLASS_ON_BOOK,
		relation: { contains: reg.classId },
	})
	const templatePages = candidates.filter(isClassTextbookTemplate)
	if (candidates.length === 0) { await finish({}); return { skipped: "클래스에 반별교재(템플릿)가 아직 없음 - 먼저 진도교재 DB에서 템플릿을 만들어 클래스에 연결하세요" } }
	if (templatePages.length === 0) {
		await finish({})
		return { skipped: "클래스에 연결된 진도교재 중 진짜 템플릿이 없음 (전부 이미 생성된 개별교재 인스턴스로 보임)" }
	}

	const owned = await booksOfRegistration(registrationId)
	const ownedIds = owned.map((p: any) => p.id as string)
	const linkIds: string[] = []
	const toCreate: any[] = []
	const results: { instanceId: string; linked?: boolean; created?: boolean }[] = []
	for (const t of templatePages) {
		const mode = selectName(t, PROP_PROGRESS_MODE) ?? "그룹 진도"
		if (mode === "그룹 진도") {
			if (!ownedIds.includes(t.id)) linkIds.push(t.id)
			results.push({ instanceId: t.id, linked: true })
			continue
		}
		const instance = owned.find((p: any) => relationIds(p, PROP_TEMPLATE_RELATION).includes(t.id))
		if (instance) results.push({ instanceId: instance.id, linked: true })
		else toCreate.push(t)
	}

	const titles = await libraryTitles([...new Set(toCreate.map((t) => libraryIds(t)[0]).filter(Boolean) as string[])])
	const created = await mapWithConcurrency(toCreate, 3, async (t: any) => {
		const libId = libraryIds(t)[0]
		const bookName = (libId && titles.get(libId)) || "라이브러리 연결 필요"
		const properties: Record<string, unknown> = {
			[PROP_BOOK_TITLE]: { title: [{ text: { content: `${bookName}(${reg.name})` } }] },
			[PROP_TEMPLATE_RELATION]: { relation: [{ id: t.id }] },
			[PROP_PROGRESS_MODE]: { select: { name: selectName(t, PROP_PROGRESS_MODE) ?? "개별 진도" } },
			[PROP_PROGRESS_STATUS]: { status: { name: STATUS_NEXT } },
			[PROP_REGISTRATION_ON_BOOK]: { relation: [{ id: registrationId }] },
		}
		if (libId) properties[libraryKey(t) ?? LIBRARY_PROP] = { relation: [{ id: libId }] }
		const page = await createPage(DATA_SOURCE_PROGRESS_BOOK, properties)
		return page.id as string
	})
	for (const id of created) results.push({ instanceId: id, created: true })

	// 개별교재는 만들 때 "등록"을 넣었으므로 양방향 관계로 이미 연결돼 있다. 그래도 등록 쓰기에 함께 넣어
	// (같은 요청 하나) 쌍이 아닌 옛 구성에서도 연결되게 한다.
	const next = [...new Set([...ownedIds, ...linkIds, ...created])]
	// 페이지에서 읽은 등록 쪽 목록에 빠진 교재가 있으면(예전 한쪽만 연결된 자료) 함께 고친다.
	const known = reg.bookIds && reg.bookIds.length < 25 ? reg.bookIds : null
	const changed = linkIds.length > 0 || created.length > 0 || (known !== null && next.some((id) => !known.includes(id)))
	await finish(changed || opts.extraProps ? { [PROP_REGISTRATION_BOOKS]: { relation: next.map((id) => ({ id })) } } : {})
	return { results }
}

// (v2.6.10) Notion 자동화 "교재 상태가 ⚪ 대기로 바뀌면" 웹훅 → sync_queue → 이 함수(워커가 한 건씩).
// 작업중 쓰기 없이, 결과와 "✅ 완료"를 등록 쓰기 한 번에 넣는다. 실패하면 "⚠️ 오류"를 쓰고 큐 재시도에 맡긴다(다시 실행해도 중복 생성 없음).
export async function processRegistrationTextbookQueueItem(payload: { pageId: string; snapshot?: RegistrationSnapshot | null }): Promise<void> {
	try {
		const result = await createIndividualBooksForRegistration(payload.pageId, payload.snapshot ?? undefined, {
			extraProps: { [TEXTBOOK_STATUS_SPEC.statusProp]: { select: { name: STATUS_DONE } }, [TEXTBOOK_STATUS_SPEC.errorProp]: { rich_text: [] } },
		})
		console.log("[sync-registration-textbook] queue finished:", payload.pageId, JSON.stringify(result))
	} catch (err) {
		await markError(payload.pageId, TEXTBOOK_STATUS_SPEC, (err as Error).message).catch(() => {})
		throw err
	}
}

async function getActiveRegistrationsForClassNow(classId: string): Promise<any[]> {
	const registrations = await queryAllPages(DS_REGISTRATION, {
		property: PROP_CLASS,
		relation: { contains: classId },
	})
	return registrations.filter((reg: any) => formulaString(reg, PROP_STATUS) === STATUS_ACTIVE)
}

// 등록 페이지의 표시용 이름. "이름"(title) 속성이 비어있는 드문 경우에도 실패 목록/로그에 뭔가는
// 보이도록 id 일부로 대체한다.
function registrationLabel(reg: any): string {
	return titleText(reg, "이름") ?? `(이름 없음: ${String(reg?.id ?? "").slice(0, 8)})`
}

// 반별교재가 있으면 복사된 인스턴스다. 출처 없이 등록에 직접 연결된 개별교재도
// 배포 기준이 아니다. 그룹 교재는 여러 등록이 연결된 뒤에도 계속 배포 기준으로 유지한다.
function isClassTextbookTemplate(page: any): boolean {
	if (relationIds(page, PROP_TEMPLATE_RELATION).length > 0) return false
	const mode = selectName(page, PROP_PROGRESS_MODE) ?? "그룹 진도"
	return mode === "그룹 진도" || relationIds(page, PROP_REGISTRATION_ON_BOOK).length === 0
}

// 클래스 직접 연결은 반의 기준 교재 조회에만 사용한다. 구형 개별교재가 섞이면 위에서 제외한다.
async function getClassTextbookPages(classId: string): Promise<any[]> {
	return await queryAllPages(DATA_SOURCE_PROGRESS_BOOK, {
		property: PROP_CLASS_ON_BOOK,
		relation: { contains: classId },
	})
}

// (PART N-12) 템플릿 하나가 특정 등록에 대해 이미 "완전히 연결됐는지" 판정한다.
// - 그룹 진도: 템플릿 자신의 "등록" relation에 이 등록이 들어있고, 동시에 이 등록의 "진도교재"에도
//   템플릿 자신이 들어있어야 한다. 양쪽을 다 확인하므로, 예전 경쟁(race) 버그로 한쪽 방향만 연결된
//   잔존 상태도 "아직 미완료"로 잡혀서 재실행 시 스스로 복구된다.
// - 개별 진도: (이 등록 + 이 템플릿) 조합의 인스턴스가 instancePages 안에 존재하고, 그 인스턴스가
//   이 등록의 "진도교재"에 들어있어야 한다.
function isTemplateSatisfiedForRegistration(
	templatePage: any,
	instancePages: any[],
	registrationId: string,
	existingBookIds: string[],
): boolean {
	const mode = selectName(templatePage, PROP_PROGRESS_MODE) ?? "그룹 진도"
	if (mode === "그룹 진도") {
		const regLinkedOnTemplate = relationIds(templatePage, PROP_REGISTRATION_ON_BOOK).includes(registrationId)
		const templateLinkedOnReg = existingBookIds.includes(templatePage.id)
		return regLinkedOnTemplate && templateLinkedOnReg
	}
	const instance = instancePages.find(
		(p) =>
			relationIds(p, PROP_TEMPLATE_RELATION).includes(templatePage.id) &&
			relationIds(p, PROP_REGISTRATION_ON_BOOK).includes(registrationId),
	)
	if (!instance) return false
	return existingBookIds.includes(instance.id)
}

// (PART N-12) 클래스 "교재 생성" 버튼 순차 이어달리기(index.ts)가 매 홉마다 "아직 처리할 등록이
// 남았는지"를 확인하는 데 쓴다. 이전에는 "교재 상태"(select) 값만 보고 판정했는데, 그러면 클래스에
// 템플릿이 "나중에 추가"됐을 때 이미 "완료"로 표시된 기존 학생들을 영원히 다시 못 잡는 구조적 한계가
// 있었다(2026-10-04 PART N-11 실사용 검증에서 드러남). 그래서 이제는 클래스의 템플릿 목록과 각
// 등록의 실제 연결 상태를 직접 비교한다 -- 모든 템플릿이 이미 충족된(isTemplateSatisfiedForRegistration)
// 등록은 "클래스와 학생의 진도교재가 같음" -> 빠르게 건너뛰고, 하나라도 빠진 등록만 pending으로
// 잡는다. 템플릿이 아예 없는 클래스(세팅 전)는 할 일이 없으므로 전원 건너뛴다. 이름(가나다) 순으로
// 정렬해서 처리 순서/진행 표시("3/24 처리 중")가 매번 같은 순서로 예측 가능하게 보이게 한다.
export async function getPendingClassTextbookRegistrations(classId: string): Promise<any[]> {
	const registrations = await getActiveRegistrationsForClassNow(classId)
	if (registrations.length === 0) return []

	const classBooks = await getClassTextbookPages(classId)
	const templatePages = classBooks.filter(isClassTextbookTemplate)
	// 새 개별교재는 클래스가 비어 있으므로 classBooks 안에서 찾으면 항상 누락으로 판정된다.
	// 복사 출처로 조회하고, 아래에서 등록까지 대조한다. 구형 클래스 연결 인스턴스도 함께 찾는다.
	const individualTemplateIds = templatePages
		.filter((p: any) => selectName(p, PROP_PROGRESS_MODE) === "개별 진도")
		.map((p: any) => p.id as string)
	const batches: string[][] = []
	for (let i = 0; i < individualTemplateIds.length; i += 50) {
		batches.push(individualTemplateIds.slice(i, i + 50))
	}
	const instancePages = (await mapWithConcurrency(batches, 4, (ids) => queryAllPages(DATA_SOURCE_PROGRESS_BOOK, {
		or: ids.map((id) => ({ property: PROP_TEMPLATE_RELATION, relation: { contains: id } })),
	}))).flat()

	const pending = templatePages.length === 0
		? []
		: registrations.filter((reg: any) => {
			const existingBookIds = relationIds(reg, PROP_REGISTRATION_BOOKS)
			return !templatePages.every((t: any) => isTemplateSatisfiedForRegistration(t, instancePages, reg.id, existingBookIds))
		})
	pending.sort((a: any, b: any) => registrationLabel(a).localeCompare(registrationLabel(b), "ko"))
	return pending
}

// 등록 1건을 처리하면서 등록(학원) DB의 "교재 상태"(개별 "개별교재 생성" 버튼과 동일한 속성)도 함께
// 갱신한다. 별도 Notion 스키마 변경 없이, 클래스 "교재 생성" 버튼으로 처리되는 중에도 각 학생의
// 등록 페이지에서 실시간 진행 상황("🔄 작업중" -> "✅ 완료"/"⚠️ 오류")을 볼 수 있게 해준다.
export async function createBooksForOneRegistrationWithStatus(
	reg: any,
): Promise<{ id: string; label: string; ok: boolean; note: string }> {
	const label = registrationLabel(reg)
	try {
		await markRunning(reg.id, TEXTBOOK_STATUS_SPEC)
		const result: any = await createIndividualBooksForRegistration(reg.id, snapshotFromRegistrationPage(reg), {
			extraProps: { [TEXTBOOK_STATUS_SPEC.statusProp]: { select: { name: STATUS_DONE } }, [TEXTBOOK_STATUS_SPEC.errorProp]: { rich_text: [] } },
		})
		const note = result && typeof result.skipped === "string" ? result.skipped : `처리 ${result?.results?.length ?? 0}건`
		return { id: reg.id, label, ok: true, note }
	} catch (err) {
		const message = (err as Error)?.message ?? String(err)
		await markError(reg.id, TEXTBOOK_STATUS_SPEC, message).catch(() => {})
		return { id: reg.id, label, ok: false, note: message }
	}
}

// 종료 처리 시 교재 정리: "다음 교재" 상태 + 학습기록 없음 인 인스턴스만 정리 대상.
// 그룹 진도 -> 등록에서 연결만 해제 (인스턴스 페이지는 보존)
// 개별 진도 -> 인스턴스 페이지 자체를 아카이브
// 그 외(진행 중/완료 상태이거나 학습기록이 있음)는 절대 건드리지 않고 그대로 둔다.
export async function cleanupUnusedBooksOnEnd(registrationId: string) {
	// (v2.6.10) 이 등록의 교재는 관계 25개 제한 없이 조회하고, 그룹 교재는 등록 쪽에서만 뺀다(양방향 관계라 교재의
	// "등록"은 Notion이 맞춤). 예전처럼 그룹 교재의 "등록"을 읽고-고치고-다시 쓰면 25명이 넘는 반에서 연결이 지워졌다.
	const books = await booksOfRegistration(registrationId)
	const bookIds = books.map((b: any) => b.id as string)
	const unlinked: string[] = []
	const deleted: string[] = []
	const kept: string[] = []
	let remaining = bookIds

	for (const book of books) {
		const bookId = book.id as string
		const mode = selectName(book, PROP_PROGRESS_MODE)
		const status = statusName(book, PROP_PROGRESS_STATUS)
		const hasRecords = relationIds(book, PROP_LEARNING_RECORD).length > 0

		if (status !== STATUS_NEXT || hasRecords) {
			kept.push(bookId)
			continue
		}

		if (mode === "그룹 진도") {
			remaining = remaining.filter((id) => id !== bookId)
			unlinked.push(bookId)
			// 그룹 진도 교재는 반 전체가 공유하므로 교재는 그대로 두고, 이 등록의 "진도교재"에서만 뺀다(아래 등록 쓰기).
		} else {
			await archivePage(bookId)
			deleted.push(bookId)
			remaining = remaining.filter((id) => id !== bookId)
		}
	}

	if (unlinked.length > 0 || deleted.length > 0) {
		await updatePageProperties(registrationId, {
			[PROP_REGISTRATION_BOOKS]: { relation: remaining.map((id) => ({ id })) },
		})
	}

	return { unlinked, deleted, kept }
}

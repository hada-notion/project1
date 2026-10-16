// _shared/learningRecordShare.ts
//
// (v2.6.16) 출석을 지울 때 그 출석에 연결된 학습기록을 지울지, 연결만 끊을지 정한다.
// 그룹 수업 학습기록은 반 학생 전체가 같이 쓰므로 한 학생의 출석이 지워진다고 기록까지 지우면 안 된다.
//   - 지움: 진도방식이 "그룹 진도"가 아니고, 기록에 연결된 학생(등록)이 지우는 출석의 학생뿐(또는 없음)
//     예) 이 학생만을 위한 개별 진도 기록
//   - 연결만 끊음: "그룹 진도"이거나 다른 학생도 연결됨(교재 없이 주제로 만든 반 전체 기록 포함)
//     → 기록의 "출석"에서 지우는 출석을, "등록"에서 그 학생을 뺀다. 기록은 남는다.
// 관계 목록은 조회(query) 결과에서 읽어야 한다(페이지 읽기는 관계를 25개까지만 줘서, 그대로 다시 쓰면 나머지가 지워진다).
import { relIds } from "./notionClient.ts"

export const PROP_RECORD_TEXTBOOK = "진도교재"
export const PROP_PROGRESS_TYPE = "진도방식"
export const GROUP_PROGRESS_TYPE = "그룹 진도"
const PROP_RECORD_ATTENDANCE = "출석"
const PROP_RECORD_REGISTRATION = "등록"

export type RecordRemoval =
	| { action: "delete" }
	| { action: "detach"; properties: Record<string, unknown> }

const norm = (id: string) => id.replace(/-/g, "").toLowerCase()

// record: 학습기록 페이지(조회 결과), attendanceIds: 지우는 출석, registrationIds: 그 출석의 학생(등록),
// progressType: 기록의 진도교재 "진도방식"(없으면 undefined)
export function decideRecordRemoval(
	record: any,
	attendanceIds: string[],
	registrationIds: string[],
	progressType: string | undefined,
): RecordRemoval {
	const regs = relIds(record?.properties?.[PROP_RECORD_REGISTRATION])
	const leaving = new Set(registrationIds.map(norm))
	const others = regs.filter((id: string) => !leaving.has(norm(id)))
	if (progressType !== GROUP_PROGRESS_TYPE && others.length === 0) return { action: "delete" }
	const gone = new Set(attendanceIds.map(norm))
	const atts = relIds(record?.properties?.[PROP_RECORD_ATTENDANCE]).filter((id: string) => !gone.has(norm(id)))
	return {
		action: "detach",
		properties: {
			[PROP_RECORD_ATTENDANCE]: { relation: atts.map((id: string) => ({ id })) },
			[PROP_RECORD_REGISTRATION]: { relation: others.map((id: string) => ({ id })) },
		},
	}
}

// 진도교재별 진도방식을 한 번씩만 읽는다.
export function makeProgressTypeReader(getPage: (id: string) => Promise<any>) {
	const cache = new Map<string, Promise<string | undefined>>()
	return (record: any): Promise<string | undefined> => {
		const textbookId: string | undefined = relIds(record?.properties?.[PROP_RECORD_TEXTBOOK])[0]
		if (!textbookId) return Promise.resolve(undefined)
		if (!cache.has(textbookId)) {
			cache.set(textbookId, getPage(textbookId).then((p) => p?.properties?.[PROP_PROGRESS_TYPE]?.select?.name as string | undefined))
		}
		return cache.get(textbookId)!
	}
}

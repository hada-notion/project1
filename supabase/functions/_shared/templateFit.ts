// (v2.8.0 알림톡 통일안) 옛 템플릿과 새 템플릿이 함께 쓰이는 동안 서버는 두 쪽 변수를 다 만든다.
// 보내기 직전에 그 템플릿의 본문·제목·버튼에 실제로 적힌 #{…}만 남긴다. 솔라피의 변수 칸(variables)과
// 검수 의견(comments)은 보지 않는다: 사본으로 만든 템플릿에는 본문에 없는 옛 변수가 변수 칸에 남아 있다(10/29 확인).
// 템플릿을 읽지 못하면 받은 변수를 그대로 보낸다(예전 동작).

type TemplateReader = { getKakaoAlimtalkTemplate(templateId: string): Promise<unknown> }

const TTL_MS = 10 * 60 * 1000
const IGNORED_KEYS = new Set(["variables", "comments"])
const cache = new Map<string, { text: string; at: number }>()

export const templateFitDeps = { now: () => Date.now() }

// 템플릿 응답을 글자로 펼친다(변수 칸·검수 의견 제외). 본문·강조 제목·버튼 주소가 모두 들어간다.
export function templateText(template: unknown): string {
	return JSON.stringify(template, (key, value) => (IGNORED_KEYS.has(key) ? undefined : value)) ?? ""
}

export async function fitVariablesToTemplate(reader: TemplateReader, templateId: string, variables: Record<string, string>): Promise<Record<string, string>> {
	if (!templateId) return variables
	const now = templateFitDeps.now()
	let hit = cache.get(templateId)
	if (!hit || now - hit.at > TTL_MS) {
		try {
			hit = { text: templateText(await reader.getKakaoAlimtalkTemplate(templateId)), at: now }
			cache.set(templateId, hit)
		} catch (err) {
			console.warn("[template-fit] 템플릿을 읽지 못해 변수를 그대로 보냅니다:", templateId, (err as Error)?.message ?? String(err))
			return variables
		}
	}
	const text = hit.text
	if (!text.includes("#{")) return variables
	return Object.fromEntries(Object.entries(variables).filter(([key]) => text.includes(key)))
}

export function clearTemplateFitCache() {
	cache.clear()
}

// deno-lint-ignore-file no-explicit-any
import { notionQueryDatabase } from "./notionClient.ts"

export const ALIMTALK_CONFIG_DB_ID = Deno.env.get("ALIMTALK_CONFIG_DB_ID") ?? ""

export type AlimtalkConfigCategory = "수강료 안내" | "주간 보고서" | "월간 보고서" | "진도교재 배부"

export type AlimtalkConfig = {
  pfId: string
  templateId: string
  senderNumber: string
  // [NEW, 2026-09-17] "발송 구분" 행의 "안내멘트"를 그대로 담아서 반환한다.
  // 예전에는 send-tuition-notice가 수강료(학원) DB에 존재하지도 않는 "안내멘트" 롤업을 직접
  // 읽으려 했는데, 그 속성이 실제로는 없어서 항상 빈 값이 나가던 버그가 있었다.
  // 이제 발송 코드가 이 config.notice를 쓰도록 바꿔서 알림톡 설정 DB의 "안내멘트" 값이 그대로 반영된다.
  notice: string
}

type AlimtalkConfigCacheEntry = { value: AlimtalkConfig; expiresAt: number }
const alimtalkConfigCache = new Map<AlimtalkConfigCategory, AlimtalkConfigCacheEntry>()
const ALIMTALK_CONFIG_CACHE_MS = 60_000

export async function getAlimtalkConfig(
  category: AlimtalkConfigCategory,
  fallback: { pfId: string; templateId: string; senderNumber: string },
): Promise<AlimtalkConfig> {
  const cached = alimtalkConfigCache.get(category)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  if (!ALIMTALK_CONFIG_DB_ID) return { ...fallback, notice: "" }

  try {
    const json = await notionQueryDatabase(ALIMTALK_CONFIG_DB_ID, {
      filter: {
        property: "발송 구분",
        title: { equals: category },
      },
      page_size: 1,
    })
    const page = json.results?.[0]
    if (!page) return { ...fallback, notice: "" }

    const active = page.properties?.["활성 여부"]?.checkbox
    if (active === false) return { ...fallback, notice: "" }

    const getText = (name: string) =>
      (page.properties?.[name]?.rich_text ?? []).map((t: any) => t.plain_text).join("").trim()

    const config: AlimtalkConfig = {
      pfId: getText("카카오 채널 ID (pfId)") || fallback.pfId,
      templateId: getText("템플릿 ID") || fallback.templateId,
      senderNumber: getText("발신번호") || fallback.senderNumber,
      // [NEW, 2026-09-17] 안내멘트는 기존에 Secrets 기본값 개념이 없었으므로 빈 문자열을 기본값으로 둔다.
      notice: getText("안내멘트"),
    }

    alimtalkConfigCache.set(category, { value: config, expiresAt: Date.now() + ALIMTALK_CONFIG_CACHE_MS })
    return config
  } catch (e) {
    console.error("getAlimtalkConfig 실패, Secrets 기본값 사용:", e)
    return { ...fallback, notice: "" }
  }
}

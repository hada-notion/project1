// 학습기록 페이지 본문(블록) → 피드 부록(v2.5.95에 reportCacheBuilder.ts에서 내용 그대로 옮김). 학부모 리포트 캐시와 수업 관리 기록 카드가 함께 쓴다.
import { getBlockChildren } from "./notionClient.ts"

// 학습기록 페이지 "본문"(블록)을 학부모 리포트 피드용 부록으로 변환한다. 프론트엔드
// normalizeFeedBody(student_report_part1.js)가 기대하는 { type: "text"|"image"|"video"|"divider", ... }
// 형태와 그대로 맞춘다. 실제 노션에서 흔히 쓰는 블록(제목1~3/글머리·번호 목록/할 일/인용/콜아웃/
// 코드/구분선)과 굵게·기울임·취소선·밑줄·인라인 코드·색상 같은 텍스트 서식(annotations)까지 살려서
// 내려준다. 표(table)도 지원한다. 임베드/토글/동기화 블록(하위 블록 재귀 조회가 필요한 것들)
// 등은 조용히 건너뛴다 -- 리포트 피드는
// "기록한 글/사진"만 보여주면 되고, 모든 노션 블록을 완벽히 재현할 필요는 없다. 실제 HTML 조립은
// (XSS 이스케이프 책임을 한 곳에 두기 위해) 프론트엔드 esc()가 있는 곳에서 한다 -- 여기서는
// 텍스트와 서식 정보만 구조화해서 내려준다.
function richTextPlain(arr: any[] | undefined): string {
  return (arr ?? []).map((t: any) => t?.plain_text ?? "").join("").trim()
}
function richTextSpans(arr: any[] | undefined): unknown[] {
  return (arr ?? [])
    .map((t: any) => {
      const spanText = String(t?.plain_text ?? "")
      if (!spanText) return null
      const a = t?.annotations ?? {}
      const color = typeof a.color === "string" && a.color !== "default" ? a.color : undefined
      const href = t?.href || t?.text?.link?.url || undefined
      return {
        text: spanText,
        bold: !!a.bold,
        italic: !!a.italic,
        strikethrough: !!a.strikethrough,
        underline: !!a.underline,
        code: !!a.code,
        color,
        href,
      }
    })
    .filter(Boolean)
}
function textBlockItem(type: string, richText: any[] | undefined, extra: Record<string, unknown> = {}): unknown | null {
  const spans = richTextSpans(richText)
  const t = richTextPlain(richText)
  if (!t) return null
  return { type: "text", style: type, text: t, spans, ...extra }
}
export async function blocksToFeedBody(blocks: any[]): Promise<unknown[]> {
  const items: unknown[] = []
  for (const b of blocks ?? []) {
    const type = b?.type
    if (!type) continue
    if (type === "table") {
      // 표는 자기 자신이 아니라 하위 table_row 블록에 실제 셀 내용이 있으므로 한 단계 더
      // 가져와야 한다. 표 개수는 본문 하나당 보통 0~2개뿐이라 순차 조회로도 충분하다.
      let rows: unknown[] = []
      if (b.has_children) {
        try {
          const rowBlocks = await getBlockChildren(b.id)
          rows = (rowBlocks ?? [])
            .filter((r: any) => r?.type === "table_row")
            .map((r: any) => (r.table_row?.cells ?? []).map((cell: any[]) => richTextSpans(cell)))
        } catch (err) {
          console.warn(`표 블록의 행 조회 실패 - 건너뜀(${b.id}):`, (err as Error)?.message ?? err)
        }
      }
      if (rows.length) {
        items.push({
          type: "table",
          rows,
          hasColumnHeader: !!b.table?.has_column_header,
          hasRowHeader: !!b.table?.has_row_header,
        })
      }
      continue
    }
    if (type === "image" || type === "video" || type === "pdf" || type === "file") {
      const media = b[type]
      const url = media?.type === "external" ? media.external?.url : media?.file?.url
      if (!url) continue
      const caption = richTextPlain(media?.caption)
      if (type === "pdf" || type === "file") {
        const fallbackName = type === "pdf" ? "PDF 문서" : "첨부 파일"
        items.push({
          type,
          blockId: String(b.id || ""),
          url: String(url),
          name: String(media?.name || caption || fallbackName),
          caption,
        })
      } else {
        // (v2.8.0 작품 모아보기) 사진은 blockId도 싣는다: 주소가 만료되면 get-report-file이 이 블록을 다시 읽어 새 주소를 준다.
        items.push({ type, url: String(url), caption, ...(type === "image" && b.id ? { blockId: String(b.id) } : {}) })
      }
      continue
    }
    if (type === "divider") {
      items.push({ type: "divider" })
      continue
    }
    if (type === "to_do") {
      const item = textBlockItem(type, b.to_do?.rich_text, { checked: !!b.to_do?.checked })
      if (item) items.push(item)
      continue
    }
    if (type === "callout") {
      const icon = b.callout?.icon?.type === "emoji" ? b.callout.icon.emoji : undefined
      const item = textBlockItem(type, b.callout?.rich_text, icon ? { icon } : {})
      if (item) items.push(item)
      continue
    }
    if (type === "code") {
      const item = textBlockItem(type, b.code?.rich_text, { language: String(b.code?.language || "") })
      if (item) items.push(item)
      continue
    }
    // paragraph / heading_1 / heading_2 / heading_3 / quote / bulleted_list_item / numbered_list_item는
    // 노션 API에서 블록 타입과 같은 이름의 속성 아래 rich_text를 그대로 두므로 공용 경로로 처리한다.
    const richText = b[type]?.rich_text
    if (Array.isArray(richText)) {
      const item = textBlockItem(type, richText)
      if (item) items.push(item)
    }
  }
  return items
}

// 실패해도(권한/삭제/타임아웃 등) 리포트 캐시 생성 전체를 막지 않는다 -- 본문은 "있으면 좋은"
// 부록이라, 실패 시 조용히 빈 배열로 넘어가고 경고만 남긴다(로드맵: 본문 동기화 리스크 검토 참고).
export async function readPageBodyBlocks(pageId: string): Promise<unknown[]> {
  try {
    const blocks = await getBlockChildren(pageId)
    return await blocksToFeedBody(blocks)
  } catch (err) {
    console.warn(`학습기록 본문(블록) 조회 실패 - 빈 본문으로 계속 진행(${pageId}):`, (err as Error)?.message ?? err)
    return []
  }
}

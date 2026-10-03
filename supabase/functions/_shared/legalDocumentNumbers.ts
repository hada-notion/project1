import { fetchSupabaseWithRetry } from "./reportCacheShared.ts"
import { getPage, updatePageProperties } from "./notionClient.ts"
const SB_URL = Deno.env.get("SB_URL") ?? ""
const SERVICE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? ""
export async function reserveLegalNumber(kind: "student" | "receipt", id: string, existing: number | null = null): Promise<number> {
 if (!SB_URL || !SERVICE_KEY) throw new Error("번호 저장 서버 설정이 필요합니다")
 if (existing !== null && (!Number.isSafeInteger(existing) || existing <= 0)) throw new Error("등록번호는 양의 정수여야 합니다")
 const response = await fetchSupabaseWithRetry(`${SB_URL}/rest/v1/rpc/reserve_legal_document_number`, {
  method:"POST", headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`,"Content-Type":"application/json"},
  body:JSON.stringify({p_kind:kind,p_entity_id:id,p_existing:existing}),
 })
 if (!response.ok) throw new Error(`고유번호 저장 실패 (${response.status}). 번호 중복/변경 또는 마이그레이션 상태를 확인하세요.`)
 const n = Number(await response.json())
 if (!Number.isSafeInteger(n) || n < 1) throw new Error("서버가 올바르지 않은 번호를 반환했습니다")
 return n
}
export async function ensureStudentRegistrationNumber(studentId: string, page?: any): Promise<number> {
 const student = page ?? await getPage(studentId)
 const existing = student.properties?.["등록번호"]?.number ?? null
 const n = await reserveLegalNumber("student", studentId, existing)
 if (existing !== n) await updatePageProperties(studentId,{"등록번호":{number:n}})
 return n
}

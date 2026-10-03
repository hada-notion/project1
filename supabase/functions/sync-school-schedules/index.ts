// 이전 정기 수집용 엔드포인트 비활성화. 기존 일정/기록은 삭제하지 않는다.
import { CORS_HEADERS, requireAdminKey } from "../_shared/adminShared.ts"
Deno.serve(async req=>{
  if(req.method==="OPTIONS")return new Response(null,{headers:CORS_HEADERS})
  const denied=await requireAdminKey(req);if(denied)return denied
  return new Response(JSON.stringify({error:"정기 학사일정 수집은 비활성화됐습니다. 학교의 ‘학사일정 가져오기’ 버튼을 사용하세요."}),{status:410,headers:{...CORS_HEADERS,"Content-Type":"application/json"}})
})

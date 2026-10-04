import { orderBulkClasses, finishBulkStep, timetableStartAt } from "./bulkClassOrder.ts"
function assert(v: unknown, msg="assertion failed") { if(!v)throw new Error(msg) }
const item=(id:string,day:number,time="20:00")=>({id,nextAt:`2026-10-${day}T${time}:00+09:00`})
Deno.test("역순 입력이어도 가까운 월수금 순서",()=>{assert(orderBulkClasses([item("fri",16),item("wed",14),item("mon",12)]).map(x=>x.id).join()==="mon,wed,fri")})
Deno.test("같은 날짜는 시작 시각, 동률은 ID로 안정 정렬",()=>{assert(orderBulkClasses([item("b",12,"10:00"),item("later",12,"20:00"),item("a",12,"10:00")]).map(x=>x.id).join()==="a,b,later")})
Deno.test("요일 이름 아닌 실제 예정일로 주 경계 정렬",()=>{assert(orderBulkClasses([item("next-mon",19),item("fri",16),item("sun",18)]).map(x=>x.id).join()==="fri,sun,next-mon")})
Deno.test("한 건 완료 후 제거, 재대기 날짜는 전체 사이에 재삽입",()=>{const p=orderBulkClasses([item("mon",12),item("wed",14),item("fri",16)]);assert(finishBulkStep(p,"mon",item("mon",19).nextAt).map(x=>x.id).join()==="wed,fri,mon");assert(finishBulkStep(p,"mon").map(x=>x.id).join()==="wed,fri")})
Deno.test("계획은 입력 배열을 변경하지 않음",()=>{const p=[item("fri",16),item("mon",12)];orderBulkClasses(p);assert(p[0].id==="fri")})
Deno.test("시간표 시각 +09:00 정규화·기본값",()=>{assert(timetableStartAt({id:"t",properties:{"등원시간(HH:mm)":{rich_text:[{plain_text:"20:30"}]}}},"2026-10-12")==="2026-10-12T20:30:00+09:00");assert(timetableStartAt({id:"t"},"2026-10-12").includes("T09:00:00"))})
Deno.test("잘못된 계획·중복 시간표·시각은 생성 전 실패",()=>{for(const p of [[{id:"x",nextAt:"bad"}],[item("x",12),item("x",14)]]){let failed=false;try{orderBulkClasses(p)}catch{failed=true}assert(failed)};let failed=false;try{timetableStartAt({id:"t",properties:{"등원시간(HH:mm)":{rich_text:[{plain_text:"25:00"}]}}},"2026-10-12")}catch{failed=true}assert(failed)})

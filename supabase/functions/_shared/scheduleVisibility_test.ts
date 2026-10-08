import { isParentPublicEvent, publicNoticeFields, NOTICE_VISIBILITY_POLICY } from "./scheduleVisibility.ts"
import { buildStudentNotices } from "./reportCacheBuilder.ts"
function assert(v: unknown, msg = "assertion failed") { if (!v) throw new Error(msg) }
function event(hidden: unknown = false, published: unknown = true, category = "📆 학원 일정"): any {
 return {id:"event", properties:{"숨김":{type:"checkbox",checkbox:hidden},"학부모 공개":{type:"checkbox",checkbox:published},"구분":{type:"select",select:{name:category}},"날짜":{type:"date",date:{start:new Date().toISOString().slice(0,10)}},"이름":{type:"title",title:[{plain_text:"공개 행사"}]}}}
}
for (const hidden of [false,true]) for (const published of [false,true]) Deno.test(`숨김=${hidden}/공개=${published}`,()=>assert(isParentPublicEvent(event(hidden,published)) === (!hidden&&published)))
Deno.test("공개/숨김 누락과 잘못된 값은 비공개",()=>{
 for(const v of [undefined,null,"true",1]) {const e=event();e.properties["학부모 공개"].checkbox=v;assert(!isParentPublicEvent(e))}
 for(const v of [undefined,null,"false",0]) {const e=event();e.properties["숨김"].checkbox=v;assert(!isParentPublicEvent(e))}
 assert(!isParentPublicEvent({properties:{}}))
})
Deno.test("할일/미지정 구분은 공개하지 않음",()=>{for(const c of ["✅ 할일","","내부 일정"]) assert(!isParentPublicEvent(event(false,true,c)))})
Deno.test("학원/학사/휴원은 공개 조건 적용",()=>{for(const c of ["📆 학원 일정","🏫 학사 일정","💤 휴원"]) assert(isParentPublicEvent(event(false,true,c)))})
Deno.test("삭제/아카이브 일정은 비공개",()=>{for(const k of ["archived","in_trash"]) assert(!isParentPublicEvent({...event(),[k]:true}))})
Deno.test("기존 캐시 일정 제거/다른 학생 필드 유지",()=>{const f=publicNoticeFields({student_name:"가상학생",notices:[{title:"직원회의"}]});assert(JSON.stringify(f.notices)==="[]");assert(f.student_name==="가상학생")})
Deno.test("정책 확인된 캐시는 일정 보존/내부 정책값 비노출",()=>{const notices=[{title:"설명회"}];const f=publicNoticeFields({notice_visibility_policy:NOTICE_VISIBILITY_POLICY,notices});assert(f.notices===notices);assert(!("notice_visibility_policy" in f));assert(JSON.stringify(publicNoticeFields({notice_visibility_policy:NOTICE_VISIBILITY_POLICY,notices:null}).notices)==="[]")})
function rel(ids:string[]) {return {type:"relation",relation:ids.map(id=>({id}))}}
async function noticesFor(pages:Record<string,any>, props:any) {return await buildStudentNotices("student",props,async id=>{assert(!!pages[id],id);return pages[id]})}
Deno.test("학생 직접 연결도 숨김/공개 조건을 우회하지 않음",async()=>{
 const good=event();good.id="good";const staff=event(false,false);staff.id="staff";const hidden=event(true,true);hidden.id="hidden"
 const n=await noticesFor({good,staff,hidden},{"학원일정":rel(["good","staff","hidden"])});assert(n.length===1)
})
Deno.test("학교/학년 관련성 조건 유지",async()=>{
 const good=event();good.id="good";good.properties["학교"]=rel(["school"]);good.properties["학년"]=rel(["grade"])
 const other=event();other.id="other";other.properties["학교"]=rel(["school"]);other.properties["학년"]=rel(["other-grade"])
 const n=await noticesFor({good,other,school:{properties:{"일정":rel(["good","other"])}},grade:{properties:{"일정":rel([])}}},{"학교":rel(["school"]),"학년":rel(["grade"])});assert(n.length===1)
})
Deno.test("클래스 직접 연결 비공개도 제외",async()=>{
 const staff=event(false,false);staff.id="staff";const n=await noticesFor({staff,reg:{properties:{"수강상태":{type:"status",status:{name:"수강 중"}},"클래스":rel(["class"])}},class:{properties:{"일정":rel(["staff"])}}},{"등록":rel(["reg"])});assert(n.length===0)
})
Deno.test("날짜 누락 일정 제외",async()=>{const e=event();delete e.properties["날짜"];assert((await noticesFor({event:e},{"학원일정":rel(["event"])})).length===0)})

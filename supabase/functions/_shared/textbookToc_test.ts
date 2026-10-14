// 교재 목차 → 단원목록 후보(v2.5.118). 네트워크 없음.
import { cleanUnits, parseToc, tocLines } from "./textbookToc.ts"
function assertEquals(a: unknown, b: unknown, msg = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${msg}\n  got:  ${x}\n  want: ${y}`) }
const names = (r: ReturnType<typeof parseToc>) => r.units.filter((u) => u.include).map((u) => `${u.name}@${u.page ?? "-"}`)

Deno.test("HTML toc lines: br/p, entities, spaces", () => {
	assertEquals(tocLines("<p>Ⅰ. 수와&nbsp;연산</p><br/>1. 소인수분해 &middot;&middot;&middot; 8<BR>&#50;. 정수와 유리수"), ["Ⅰ. 수와 연산", "1. 소인수분해 ··· 8", "2. 정수와 유리수"])
})

Deno.test("big units: 1-1 numbering restarts in each big unit, pages from line ends", () => {
	const r = parseToc(`머리말
Ⅰ. 수와 연산 ········ 6
1. 소인수분해 ········ 8
  01 소수와 합성수 ··· 8
2. 정수와 유리수 ········ 28
Ⅱ. 문자와 식
3. 문자의 사용과 식의 계산 ········ 62
4. 일차방정식 ········ 84
정답과 해설`)
	assertEquals(r.hasBig, true)
	assertEquals(names(r), ["1-1. 소인수분해@8", "1-2. 정수와 유리수@28", "2-1. 문자의 사용과 식의 계산@62", "2-2. 일차방정식@84"])
	assertEquals(r.units.find((u) => u.name.includes("일차방정식"))?.big, "문자와 식")
})

Deno.test("no big units: plain 1. numbering", () => {
	const r = parseToc("1 소인수분해 8\n2 정수와 유리수 28\n3. 일차방정식 p.60")
	assertEquals(r.hasBig, false)
	assertEquals(names(r), ["1. 소인수분해@8", "2. 정수와 유리수@28", "3. 일차방정식@60"])
})

Deno.test("first small unit page fills a mid unit without a page; smalls are not units", () => {
	const r = parseToc("Ⅰ 도형의 방정식\n1. 평면좌표\n1-1 두 점 사이의 거리 ··· 8\n1-2 선분의 내분점 ··· 12\n2. 직선의 방정식 ··· 22")
	assertEquals(names(r), ["1-1. 평면좌표@8", "1-2. 직선의 방정식@22"])
})

Deno.test("only 1-1 style lines under big units become mid units", () => {
	const r = parseToc("1단원 수와 연산\n1-1 소인수분해 8\n1-2 정수와 유리수 28\n2단원 문자와 식\n2-1 문자의 사용 62")
	assertEquals(names(r), ["1-1. 소인수분해@8", "1-2. 정수와 유리수@28", "2-1. 문자의 사용@62"])
})

Deno.test("unnumbered list: each line is a unit; skip lines start excluded", () => {
	const r = parseToc("이 책의 구성과 특징\n소인수분해\n정수와 유리수\n빠른 정답")
	assertEquals(names(r), ["1. 소인수분해@-", "2. 정수와 유리수@-"])
	assertEquals(r.units.filter((u) => !u.include).map((u) => u.name), ["이 책의 구성과 특징", "빠른 정답"])
})

Deno.test("mid units before the first big unit are left out, years are not pages", () => {
	const r = parseToc("1. 예비 학습\nⅠ. 함수\n1. 2022 개정 교육과정 함수 개념\n2. 일차함수 40")
	assertEquals(names(r), ["1-1. 2022 개정 교육과정 함수 개념@-", "1-2. 일차함수@40"])
	assertEquals(r.units[0].include, false)
})

Deno.test("cleanUnits trims, drops empty names and bad pages, caps the count", () => {
	assertEquals(cleanUnits([{ name: "  1-1.  소인수분해 ", page: "8" }, { name: "", page: 3 }, { name: "x", page: -1 }, { name: "y", page: 2.5 }, { name: "z", page: "" }]), [{ name: "1-1. 소인수분해", page: 8 }, { name: "x", page: null }, { name: "y", page: null }, { name: "z", page: null }])
	assertEquals(cleanUnits("nope"), [])
	assertEquals(cleanUnits(Array.from({ length: 100 }, (_, i) => ({ name: "u" + i }))).length, 80)
})

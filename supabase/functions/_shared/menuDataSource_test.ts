import { pickMenuDataSourceId } from "./menuDataSource.ts"
function assertEquals(a: unknown, b: unknown) { if (a !== b) throw new Error(`expected ${b}, got ${a}`) }

const ds = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
	object: "data_source",
	id,
	title: [{ plain_text: title }],
	...extra,
})

Deno.test("메뉴 데이터소스: 이름이 정확히 같은 것 하나를 고른다", () => {
	assertEquals(pickMenuDataSourceId([ds("a", "메뉴(학원) DB"), ds("b", "메뉴(학원) DB 사본")]), "a")
})

Deno.test("메뉴 데이터소스: 휴지통·보관된 것은 뺀다", () => {
	assertEquals(
		pickMenuDataSourceId([ds("old", "메뉴(학원) DB", { in_trash: true }), ds("new", "메뉴(학원) DB")]),
		"new",
	)
	assertEquals(pickMenuDataSourceId([ds("old", "메뉴(학원) DB", { archived: true })]), null)
})

Deno.test("메뉴 데이터소스: 없거나 둘 이상이면 건너뛴다", () => {
	assertEquals(pickMenuDataSourceId([]), null)
	assertEquals(pickMenuDataSourceId([ds("a", "메뉴(학원) DB"), ds("b", "메뉴(학원) DB")]), null)
	assertEquals(pickMenuDataSourceId([{ object: "page", id: "p", title: [{ plain_text: "메뉴(학원) DB" }] }]), null)
})

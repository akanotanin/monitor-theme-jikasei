// 公开备注的取值：空 / 空白 / 没有这个字段都算「没写」，其余原样（含首尾空白削掉）。
// 跑法同另外几个：`npm test`（Node 自己剥类型，不需要 runner）。没有任何东西 import 它，不进 bundle。
import { publicRemark } from "./notes.ts"

let failed = 0
function eq(got: unknown, want: unknown, what: string) {
  const [a, b] = [JSON.stringify(got), JSON.stringify(want)]
  if (a !== b) {
    failed++
    console.error(`✗ ${what}\n    得到 ${a}\n    期望 ${b}`)
  }
}

eq(publicRemark({ public_remark: "CN2 GIA 三网优化" }), "CN2 GIA 三网优化", "有备注就原样取出")
eq(publicRemark({ public_remark: "  CN2 GIA  " }), "CN2 GIA", "首尾空白削掉")
eq(publicRemark({ public_remark: "" }), "", "空串＝没写（hub 对留空给的就是空串）")
eq(publicRemark({ public_remark: "   \t " }), "", "只有空白＝没写，不能渲染出空的备注位")
eq(publicRemark({ public_remark: null }), "", "null＝没写（类型上防御一手）")
eq(publicRemark({}), "", "老 hub 没有这个字段＝没写")
eq(publicRemark({ public_remark: undefined }), "", "字段在但是 undefined＝没写")
// 100 字是 hub 的上限，一个字都不能在这边被截断：截断只发生在版式层（CSS 省略号 + title）。
const LONG = "这是一条刚好一百字的公开备注，用来验证详细档标题行右端的截断与悬停提示是否按预期工作；同时检查经典档新增的那枚信息图标在没有备注时是否零占位，以及延迟与紧凑两档的浮层里这行说明会不会把价格和到期挤走。"
eq(LONG.length, 100, "样张正好 100 字")
eq(publicRemark({ public_remark: LONG }), LONG, "整条备注原样交给版式层")
// 只取一个字面量、不留引用：旧 hub 把 remark 当私有字段，绝不能顺手拿它来顶公开备注。
eq(publicRemark({ public_remark: "", remark: "只给管理员看" } as { public_remark: string; remark: string }), "", "私有 remark 不参与（匿名本来就拿不到）")

if (failed) {
  console.error(`\n公开备注：${failed} 条不通过`)
  process.exit(1)
}
console.log("公开备注：全部通过")

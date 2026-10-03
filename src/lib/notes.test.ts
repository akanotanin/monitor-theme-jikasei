// 备注的取值与切分：公开备注（hub 下发给访客的那条）与私有备注（只下发给登录的管理员）。
// 空 / 空白 / 没有这个字段都算「没写」；逗号分隔＝多枚小卡片；私有备注先按换行分段、段内再拆。
// 跑法同另外几个：`npm test`（Node 自己剥类型，不需要 runner）。没有任何东西 import 它，不进 bundle。
import { hubTags, privateRemark, publicRemark, splitTags } from "./notes.ts"

let failed = 0
function eq(got: unknown, want: unknown, what: string) {
  const [a, b] = [JSON.stringify(got), JSON.stringify(want)]
  if (a !== b) {
    failed++
    console.error(`✗ ${what}\n    得到 ${a}\n    期望 ${b}`)
  }
}

// ── 公开备注的取值 ────────────────────────────────────────────────────
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
// 只取一个字面量、不留引用：hub 把 remark 当私有字段，绝不能顺手拿它来顶公开备注。
eq(publicRemark({ public_remark: "", remark: "只给管理员看" } as { public_remark: string; remark: string }), "", "私有 remark 不参与公开备注")

// ── 逗号分隔＝多枚小卡片（与 1.15.x 那份「服务器备注」的写法逐字相同） ──
eq(hubTags({ public_remark: "CN2 GIA,三网优化,流媒体解锁" }), ["CN2 GIA", "三网优化", "流媒体解锁"], "三枚就是三枚")
eq(hubTags({ public_remark: "三网优化，备用, 高防" }), ["三网优化", "备用", "高防"], "全角逗号也认，逐枚削空白")
eq(hubTags({ public_remark: " a , , b ," }), ["a", "b"], "空片段丢掉、首尾逗号不算一枚")
eq(hubTags({ public_remark: ",,," }), [], "全是逗号＝没有备注")
eq(hubTags({ public_remark: "一枚" }), ["一枚"], "没有逗号就是一枚")
eq(hubTags({ public_remark: "   " }), [], "只有空白＝没有备注")
eq(hubTags({}), [], "老 hub 没这个字段＝没有备注")
// 站长在现网后台就是这么填的（他验收时用的那串），照它断一条。
eq(hubTags({ public_remark: "备注1,备注测试2,备注333" }), ["备注1", "备注测试2", "备注333"], "现网后台填的那串＝三枚卡片")
// 私有备注绝不能顶替公开备注（匿名访客拿不到它，那会变成「有的站看得见、有的看不见」）。
eq(hubTags({ public_remark: "公开那条", remark: "私有那条" } as { public_remark: string; remark: string }), ["公开那条"], "hubTags 只读公开字段")

// ── 私有备注：整段原文（保留换行，**不拆**） ─────────────────────────────
eq(privateRemark({ remark: "私有甲,私有乙" }), "私有甲,私有乙", "单行带逗号也整段留着（不拆成两枚）")
eq(privateRemark({ remark: "第一行\n第二行" }), "第一行\n第二行", "换行原样保留")
eq(privateRemark({ remark: "第一行\n\n第三行" }), "第一行\n\n第三行", "中间的空行也留着（成段的备忘）")
eq(privateRemark({ remark: "甲\r\n乙" }), "甲\n乙", "CRLF 归一成 LF")
eq(privateRemark({ remark: "甲\r乙" }), "甲\n乙", "单独的 CR 也归一")
eq(privateRemark({ remark: "  甲,乙  " }), "甲,乙", "只削首尾空白，内部一字不动")
eq(privateRemark({ remark: "" }), "", "空串＝没写")
eq(privateRemark({ remark: "   \n  " }), "", "只有空白＝没写（不能渲染出空块）")
eq(privateRemark({ remark: null }), "", "null＝没写")
eq(privateRemark({}), "", "字段不在（老 hub / 匿名视图）＝没写")
eq(privateRemark({ remark: "私有那条", public_remark: "公开那条" } as { remark: string; public_remark: string }), "私有那条", "只读私有字段")

// ── splitTags 本身 ────────────────────────────────────────────────────
eq(splitTags("a, b ，c"), ["a", "b", "c"], "半角 / 全角逗号都拆，逐枚削空白")
eq(splitTags(",,，"), [], "全是分隔符＝空")

if (failed) {
  console.error(`\n备注：${failed} 条不通过`)
  process.exit(1)
}
console.log("备注：全部通过")

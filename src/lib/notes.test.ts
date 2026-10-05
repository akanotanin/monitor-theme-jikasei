// 备注的取值与切分：公开备注（hub 下发给访客）与私有备注（只下发给登录的管理员）合并成一串小卡片。
// 空 / 空白 / 没有这个字段都算「没写」；逗号分隔＝多枚小卡片；私有那条多一手「按换行也拆」。
// 跑法同另外几个：`npm test`（Node 自己剥类型，不需要 runner）。没有任何东西 import 它，不进 bundle。
import { hasDetailRemarks, hubTags, publicRemark, remarkChips, splitTags } from "./notes.ts"

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

// ── 合并后的备注：私有在前（own: true）、公有在后，都拆成一枚枚小卡片 ─────────
const NODE = { public_remark: "hub备注A,hub备注B" }
eq(remarkChips(NODE), [{ text: "hub备注A", own: false }, { text: "hub备注B", own: false }], "只有公开备注 → 两枚，都不是 own")
eq(remarkChips({ ...NODE, remark: "私有甲,私有乙" }),
  [{ text: "私有甲", own: true }, { text: "私有乙", own: true }, { text: "hub备注A", own: false }, { text: "hub备注B", own: false }],
  "两边都有 → 私有在前、公有在后，各带自己的来源标记")
eq(remarkChips({ remark: "第一行\n第二行的一枚，带全角逗号" }),
  [{ text: "第一行", own: true }, { text: "第二行的一枚", own: true }, { text: "带全角逗号", own: true }],
  "私有备注按换行也拆（hub 对它没有单行约束）")
eq(remarkChips({ remark: "甲\r\n乙" }), [{ text: "甲", own: true }, { text: "乙", own: true }], "CRLF 一样拆")
eq(remarkChips({ remark: "   \n , " }), [], "私有只有空白 / 逗号 → 一枚都没有")
eq(remarkChips({ remark: null }), [], "null＝没写")
eq(remarkChips({}), [], "两个字段都不在（老 hub / 匿名视图）→ 空数组（零占位）")
eq(remarkChips({ public_remark: ",,," }), [], "公开备注全是逗号＝没写")
eq(remarkChips({ remark: "仅自己可见的一条" }), [{ text: "仅自己可见的一条", own: true }], "只有私有备注 → 一枚 own（访客那边根本没有它）")
eq(remarkChips({ public_remark: "公开那条", remark: "私有那条" }),
  [{ text: "私有那条", own: true }, { text: "公开那条", own: false }], "两枚各带自己的来源标记")
eq(remarkChips({ public_remark: "hub 一条" }), [{ text: "hub 一条", own: false }], "公开备注那串按逗号拆")

// ── splitTags 本身 ────────────────────────────────────────────────────
eq(splitTags("a, b ，c"), ["a", "b", "c"], "半角 / 全角逗号都拆，逐枚削空白")
eq(splitTags(",,，"), [], "全是分隔符＝空")

// ── 整页详情那一块占不占位（骨架对齐高度要用它） ──────────────────────────
// 四种组合都要钉住：有备注且摊在详情页 → 占位；有备注但只摊在卡片上 / 都不显示 → 不占位；
// 没备注 → 不占位（这一条错了骨架会反过来高出 38px）。
const noted = { public_remark: "公开备注", remark: "私有备注" }
eq(hasDetailRemarks(noted, "both"), true, "有备注 + 都显示 → 详情页那一块占位")
eq(hasDetailRemarks(noted, "detail"), true, "有备注 + 只在详情页 → 占位")
eq(hasDetailRemarks(noted, "card"), false, "有备注 + 只在卡片 → 详情页不占位")
eq(hasDetailRemarks(noted, "none"), false, "有备注 + 都不显示 → 详情页不占位")
eq(hasDetailRemarks({}, "both"), false, "没写备注 → 不占位")
eq(hasDetailRemarks({ public_remark: "  ,  " }, "both"), false, "只有逗号空段 → 当作没写")

if (failed) {
  console.error(`\n备注：${failed} 条不通过`)
  process.exit(1)
}
console.log("备注：全部通过")

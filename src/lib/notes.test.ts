// 公开备注的取值与切分：空 / 空白 / 没有这个字段都算「没写」；逗号分隔＝多枚小卡片。
// 跑法同另外几个：`npm test`（Node 自己剥类型，不需要 runner）。没有任何东西 import 它，不进 bundle。
import { hubTags, publicRemark, remarkTags } from "./notes.ts"

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

// ── 逗号分隔＝多枚小卡片（与 1.15.x 那份「服务器备注」的写法逐字相同） ──────────
eq(hubTags({ public_remark: "CN2 GIA,三网优化,流媒体解锁" }), ["CN2 GIA", "三网优化", "流媒体解锁"], "三枚就是三枚")
eq(hubTags({ public_remark: "三网优化，备用, 高防" }), ["三网优化", "备用", "高防"], "全角逗号也认，逐枚削空白")
eq(hubTags({ public_remark: " a , , b ," }), ["a", "b"], "空片段丢掉、首尾逗号不算一枚")
eq(hubTags({ public_remark: ",,," }), [], "全是逗号＝没有备注")
eq(hubTags({ public_remark: "一枚" }), ["一枚"], "没有逗号就是一枚")
eq(hubTags({ public_remark: "   " }), [], "只有空白＝没有备注")
eq(hubTags({}), [], "老 hub 没这个字段＝没有备注")
// 站长在现网后台就是这么填的（他验收时用的那串），照它断一条。
eq(hubTags({ public_remark: "备注1,备注测试2,备注333" }), ["备注1", "备注测试2", "备注333"], "现网后台填的那串＝三枚卡片")

// ── 两个来源的取舍：主题设置里写了的优先，没写的用 hub 那条 ─────────────────
const NODE = { name: '东京机', public_remark: 'hub备注A,hub备注B' }
eq(remarkTags(NODE, ''), ['hub备注A', 'hub备注B'], '主题设置留空 → 用 hub 的公开备注')
eq(remarkTags(NODE, '别的机器=别的备注'), ['hub备注A', 'hub备注B'], '主题设置里没写这台 → 用 hub 的')
eq(remarkTags(NODE, '东京机=自己的备注'), ['自己的备注'], '主题设置里写了这台 → 用它（hub 那条让位）')
eq(remarkTags(NODE, '东京机=一,二,三'), ['一', '二', '三'], '主题设置里那几枚照样按逗号切')
eq(remarkTags(NODE, '东京机='), ['hub备注A', 'hub备注B'], '这台写成空值＝这里没写 → 仍用 hub 的')
eq(remarkTags(NODE, '东京机=,,,'), ['hub备注A', 'hub备注B'], '值里全是逗号＝这里没写 → 仍用 hub 的')
eq(remarkTags(NODE, ' 东京机 = 带空白 '), ['带空白'], '名字两侧空白削掉后照样命中')
eq(remarkTags(NODE, '# 东京机=注释里的不算'), ['hub备注A', 'hub备注B'], '# 开头的行是注释，不参与')
eq(remarkTags(NODE, '东京机=后一行\n东京机=前一行覆盖'), ['前一行覆盖'], '同一台写多行时后一行覆盖前一行')
eq(remarkTags({ name: '没备注的机器' }, ''), [], '两边都没有 → 空数组（页面上一个像素都不占）')
eq(remarkTags({ name: '东京机' }, '东京机=只有主题设置'), ['只有主题设置'], 'hub 没这个字段时主题设置照样生效')
eq(remarkTags({ name: '东京机', public_remark: '   ' }, ''), [], 'hub 那条只有空白＝没有')

if (failed) {
  console.error(`\n公开备注：${failed} 条不通过`)
  process.exit(1)
}
console.log("公开备注：全部通过")

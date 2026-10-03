// 站点设置的取值与迁移：旧版本存过的值必须还能读出来。
// 跑法同另外几个：`npm test`（Node 自己剥类型，不需要 runner）。没有任何东西 import 它，不进 bundle。
//
// 重点在三处容易静默出错的迁移：
//   1. cardStyle：≤1.2.9 的 "detail" 现在叫 "latency"，1.9.0 起多了 "compact";
//   2. listTop：≤1.4.0 是两个布尔开关（showSummary / showGroupTabs），1.5.0 合成四选一；
//   3. farmUrl：≤1.5.0 是两个键（showFarmEntry + farmUrl），1.6.0 并成一个三态键。
// 另外 1.16.0 删掉了 serverNotes（备注改由 hub 的「公开备注」按节点管，见 notes.test.ts）：
// 删字段不是迁移，但要挡住它以后被顺手加回来——下面有一条护栏按 theme.json 与 DEFAULTS 双向断。
// 读不出来的表现不是报错，而是「站长开着的那一项自己关了」。
import { readFileSync } from "node:fs"

import { DEFAULTS, FARM_OFF, cardStyleOf, hasGroupTabs, hasSummary, isBudgetLayout, listTopOf, normalizeConfig } from "./site-settings.ts"

let failed = 0
function eq(got: unknown, want: unknown, what: string) {
  const [a, b] = [JSON.stringify(got), JSON.stringify(want)]
  if (a !== b) {
    failed++
    console.error(`✗ ${what}\n    得到 ${a}\n    期望 ${b}`)
  }
}

// ── cardStyle：旧名迁移 ───────────────────────────────────────────────
eq(cardStyleOf("detail"), "latency", '旧值 "detail" 迁到 "latency"')
for (const v of ["classic", "latency", "detailed", "plain", "compact"]) eq(cardStyleOf(v), v, `cardStyle 保留 ${v}`)
eq(cardStyleOf("nope"), "plain", "cardStyle 认不出的值回落「简约」（默认档）")
eq(cardStyleOf(undefined), "plain", "cardStyle 没存过回落「简约」（默认档）")

// ── listTop：六选一本身就认 ───────────────────────────────────────────
const TOPS = ["none", "groups", "summary", "budget", "both", "bothBudget"] as const
for (const v of TOPS) eq(listTopOf(v), v, `listTop 保留 ${v}`)

// ── listTop：老的两个布尔开关按组合迁过来 ─────────────────────────────
eq(listTopOf(undefined, { showSummary: true, showGroupTabs: true }), "both", "老配置：两个都开 → both")
eq(listTopOf(undefined, { showSummary: true, showGroupTabs: false }), "summary", "老配置：只开概览 → summary")
eq(listTopOf(undefined, { showSummary: false, showGroupTabs: true }), "groups", "老配置：只开分组标签 → groups")
eq(listTopOf(undefined, { showSummary: false, showGroupTabs: false }), "none", "老配置：两个都关 → none")
eq(listTopOf(undefined, {}), "none", "没存过任何一项 → none")
eq(listTopOf(undefined), "none", "连配置对象都没有 → none")
// 只存了其中一个（另一个键根本不存在）也要按「关」算，不能当成缺失而回落整个默认值。
eq(listTopOf(undefined, { showGroupTabs: true }), "groups", "只存了分组标签一个键 → groups")
// 不认识的 listTop（手改、别的版本）当没存过，继续按老开关迁，而不是直接掉回默认。
eq(listTopOf("weird", { showSummary: true }), "summary", "listTop 认不出时仍按老开关迁")

// ── 三个布尔是六选一的投影 ───────────────────────────────────────────
// 1.10.0 多出的 budget / bothBudget 只在「概览卡片长什么样」上有别：前两个布尔与 summary / both 一致。
eq(TOPS.map((t) => [t, hasSummary(t), hasGroupTabs(t), isBudgetLayout(t)]),
  [["none", false, false, false], ["groups", false, true, false], ["summary", true, false, false],
    ["budget", true, false, true], ["both", true, true, false], ["bothBudget", true, true, true]],
  "六档 → 三个布尔")

// ── normalizeConfig：逐项收窄 ────────────────────────────────────────
// 整对象比较按 key 排序，免得属性书写顺序不同被当成不一致。
const sorted = (o: unknown) => JSON.stringify(Object.fromEntries(Object.entries(o as Record<string, unknown>).sort()))
eq(sorted(normalizeConfig(null)), sorted(DEFAULTS), "什么都没存 → 全默认")
eq(sorted(normalizeConfig({})), sorted(DEFAULTS), "空对象 → 全默认")
eq(normalizeConfig({ siteIcon: "   " }).siteIcon, DEFAULTS.siteIcon, "站点图标只有空白 → 回落默认")
eq(normalizeConfig({ siteIcon: " https://x/i.png " }).siteIcon, "https://x/i.png", "站点图标去首尾空白")
// farmUrl / pingLines 的空串是「有意义的值」（自动探测 / 自动取前三条），不能被顶成默认。
eq(normalizeConfig({ farmUrl: "" }).farmUrl, "", "养鸡场入口空串保留（自动探测）")
eq(normalizeConfig({ farmUrl: "  /chicken/  " }).farmUrl, "/chicken/", "养鸡场地址去首尾空白")
eq(normalizeConfig({ farmUrl: "off" }).farmUrl, FARM_OFF, "养鸡场入口的 off 值保留")
// ── 养鸡场入口：1.5.0 的两个键并入一个（showFarmEntry / farmUrl → farmUrl） ──
// 老站点把入口关了而地址键从没动过：必须落成 off，否则会静默又冒出一枚它关掉的图标。
eq(normalizeConfig({ showFarmEntry: false }).farmUrl, FARM_OFF, "老配置：关掉入口 → off")
// 地址键一旦存在就按它来（哪怕是空串）——这是站长明确定过的值，
// 也覆盖「并入之后重新填了地址」的情形（那时旧键 showFarmEntry 可能还是 false）。
eq(normalizeConfig({ showFarmEntry: false, farmUrl: "" }).farmUrl, "", "地址键存在时按地址来（空串＝自动）")
eq(normalizeConfig({ showFarmEntry: false, farmUrl: "/farm/" }).farmUrl, "/farm/", "地址键存在时优先于旧开关")
eq(normalizeConfig({ showFarmEntry: true }).farmUrl, "", "老配置：开着入口（没填地址）→ 自动探测")
eq(normalizeConfig({ showFarmEntry: "no" }).farmUrl, "", "旧开关类型不对 → 当作没存过，自动探测")
eq(normalizeConfig({ pingLines: "" }).pingLines, "", "延迟线路空串保留")
eq(normalizeConfig({ cardStyle: "detail" }).cardStyle, "latency", "normalizeConfig 也走 cardStyle 迁移")
eq(normalizeConfig({ showSummary: true }).listTop, "summary", "normalizeConfig 也走 listTop 迁移")
eq(normalizeConfig({ listTop: "both" }).listTop, "both", "新值优先")

// ── 护栏：设置项别超过 6 个 ──────────────────────────────────────────
// Hub 1.3.0 的「主题设置」对话框在非标题字段 > 6 时会把布局从左导航 + 单列换成两列 + 分组导航，
// 两列里每格只有半宽：说明折成四五行的同时并排两项高矮不齐、每组最后一行还空半格。
// 1.5.0 就是为此把两个顶部开关并成一个四选一的；以后再想加设置项，先想清楚这一条。
const manifest = JSON.parse(readFileSync(new URL("../../theme.json", import.meta.url), "utf8"))
const fields = manifest.config.filter((f: { type: string }) => f.type !== "title")
if (fields.length > 6) {
  failed++
  console.error(`✗ theme.json 的非标题设置项有 ${fields.length} 个（> 6）：面板会切成两列 + 分组导航，排版会散开`)
}
// 两边的 key 必须一一对上：面板按 theme.json 画表单，页面按 DEFAULTS 兜底。
const keys = fields.map((f: { key: string }) => f.key).sort()
eq(keys, Object.keys(DEFAULTS).sort(), "theme.json 的字段与 DEFAULTS 的键一致")

// 1.16.0 删掉的 serverNotes 不许以任何形式回来：备注只有 hub 的「公开备注」一个来源
// （按节点管，见 notes.test.ts）。留一条反向断言，是因为「顺手把老开关加回来」最容易
// 变成两套并存——页面照常、后台照常，只有站长会在两处各写一遍备注然后发现只有一处生效。
eq(keys.includes("serverNotes"), false, "theme.json 里没有 serverNotes（备注已交给 hub）")
eq(Object.keys(DEFAULTS).includes("serverNotes"), false, "DEFAULTS 里没有 serverNotes")

if (failed) {
  console.error(`\n站点设置：${failed} 条不通过`)
  process.exit(1)
}
console.log(`站点设置：全部通过（含 ${fields.length} 个设置项的阈值护栏）`)

// 站点设置的取值与迁移：旧版本存过的值必须还能读出来。
// 跑法同另外几个：`npm test`（Node 自己剥类型，不需要 runner）。没有任何东西 import 它，不进 bundle。
//
// 重点在两处容易静默出错的迁移：
//   1. cardStyle：≤1.2.9 的 "detail" 现在叫 "latency"；
//   2. listTop：≤1.4.0 是两个布尔开关（showSummary / showGroupTabs），1.5.0 合成四选一。
// 读不出来的表现不是报错，而是「站长开着的那一项自己关了」。
import { readFileSync } from "node:fs"

import { DEFAULTS, cardStyleOf, hasGroupTabs, hasSummary, listTopOf, normalizeConfig } from "./site-settings.ts"

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
for (const v of ["classic", "latency", "detailed"]) eq(cardStyleOf(v), v, `cardStyle 保留 ${v}`)
eq(cardStyleOf("nope"), "classic", "cardStyle 认不出的值回落经典")
eq(cardStyleOf(undefined), "classic", "cardStyle 没存过回落经典")

// ── listTop：四选一本身就认 ───────────────────────────────────────────
const TOPS = ["none", "groups", "summary", "both"] as const
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

// ── 两个布尔是四选一的投影 ───────────────────────────────────────────
eq(TOPS.map((t) => [t, hasSummary(t), hasGroupTabs(t)]),
  [["none", false, false], ["groups", false, true], ["summary", true, false], ["both", true, true]],
  "四档 → 两个布尔")

// ── normalizeConfig：逐项收窄 ────────────────────────────────────────
// 整对象比较按 key 排序，免得属性书写顺序不同被当成不一致。
const sorted = (o: unknown) => JSON.stringify(Object.fromEntries(Object.entries(o as Record<string, unknown>).sort()))
eq(sorted(normalizeConfig(null)), sorted(DEFAULTS), "什么都没存 → 全默认")
eq(sorted(normalizeConfig({})), sorted(DEFAULTS), "空对象 → 全默认")
eq(normalizeConfig({ siteIcon: "   " }).siteIcon, DEFAULTS.siteIcon, "站点图标只有空白 → 回落默认")
eq(normalizeConfig({ siteIcon: " https://x/i.png " }).siteIcon, "https://x/i.png", "站点图标去首尾空白")
// farmUrl / pingLines 的空串是「有意义的值」（自动探测 / 自动取前三条），不能被顶成默认。
eq(normalizeConfig({ farmUrl: "" }).farmUrl, "", "养鸡场地址空串保留")
eq(normalizeConfig({ pingLines: "" }).pingLines, "", "延迟线路空串保留")
eq(normalizeConfig({ farmUrl: "  /chicken/  " }).farmUrl, "/chicken/", "养鸡场地址去首尾空白")
eq(normalizeConfig({ showFarmEntry: false }).showFarmEntry, false, "关掉养鸡场入口要保留 false")
eq(normalizeConfig({ showFarmEntry: "no" }).showFarmEntry, true, "类型不对回落默认（真）")
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

if (failed) {
  console.error(`\n站点设置：${failed} 条不通过`)
  process.exit(1)
}
console.log(`站点设置：全部通过（含 ${fields.length} 个设置项的阈值护栏）`)

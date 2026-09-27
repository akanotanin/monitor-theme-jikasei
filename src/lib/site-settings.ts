/**
 * 站点级设置的「值」这一层：类型、默认值，以及 Hub 存回来的自由 JSON 怎么收窄成它们。
 *
 * 单独一个文件是为了能脱开 React 与 `@/` 别名直接跑测试（见 site-settings.test.ts）：
 * 这边最容易悄悄错的是**迁移**——旧版本存过的值读不出来时不会报错，只会静默掉回默认，
 * 站长那边看到的是「我明明开着，怎么自己关了」。
 *
 * 两边必须逐字一致的两处：theme.json 的表单（面板画什么）、这里的 DEFAULTS（页面兜底什么），
 * `scripts/check-config.mjs` 在打包前对一遍。
 */

export type ThemeConfig = {
  /** 顶栏那枚圆形站标的地址，同时也是标签页图标；取不到就退回主题自带那张。 */
  siteIcon: string
  /** 顶栏那枚「养鸡场」图标的开关。 */
  showFarmEntry: boolean
  /** 养鸡场的地址；空串 = 自动探测本站的 `/chicken/`。 */
  farmUrl: string
  /** 卡片形态：classic = 网络两行、不含延迟；latency = 网络单行 + 三网延迟；detailed = 再加在线时长、价格与到期。 */
  cardStyle: "classic" | "latency" | "detailed"
  /** 列表页顶部显示什么：none = 都不显示；groups = 分组标签行；summary = 概览卡片行；both = 两个都显示。 */
  listTop: "none" | "groups" | "summary" | "both"
  /** 卡片「三网延迟」要显示的线路，按名字指定（ping 任务名），一行一个。 */
  pingLines: string
}

export const DEFAULTS: ThemeConfig = {
  siteIcon: "/site-icon.png",
  showFarmEntry: true,
  // 留空 = 自动：本站在约定的 `/chicken/` 上真装了养鸡场才显示那枚图标。
  // 「装主题」与「部署养鸡场」是两件事，站长没装就不该多出一枚点了没反应的图标；
  // 想固定指向别处（包括别人的公开那座）就填地址。
  farmUrl: "",
  // 默认「经典」：更紧凑、不发延迟请求；想带三网延迟的在后台切「延迟」。
  cardStyle: "classic",
  // 默认「都不显示」：这两行都是「一眼看全站」的补充，站点本来就有每台机器的卡片；
  // 关着时它们整个不挂载，首屏与没有这个功能时一模一样。
  listTop: "none",
  // 延迟线路：留空 = 按后台顺序自动显示前几条；填了名字就只显示这些（一行一个）。
  // 名字是 ping 任务的名字，不是节点名——对不上的行会被跳过。
  pingLines: "",
}

/**
 * 卡片形态这一档的取值。它在上一版（≤1.2.9）叫 "detail"，现在改叫 "latency"
 * ——「延迟」才是这一档真正展示的东西，也把「详细」这个名字腾给后面那一档。
 * 读到旧值就迁过来：不迁的话，存过 "detail" 的站会被当成从没保存过、悄悄掉回经典。
 */
export function cardStyleOf(v: unknown): ThemeConfig["cardStyle"] {
  // ≤1.2.9 的值：那时候这一档叫「详细」，现在叫「延迟」——同一档，只是换了名字。
  if (v === "detail") return "latency"
  if (v === "classic" || v === "latency" || v === "detailed") return v
  return DEFAULTS.cardStyle
}

/**
 * 「列表页顶部」这一档：1.4.0 及更早是两个独立开关（showSummary / showGroupTabs），
 * 1.5.0 合成一个四选一。合成的原因是排版而不是懒——Hub 的「主题设置」对话框在
 * **非标题字段超过 6 个**时会从左导航 + 单列变成两列 + 分组导航（hub 1.3.0 实测，
 * 前端逻辑：`o = fields.length > 6` 决定栅格列数），两列里每格只有半宽，
 * 说明文字挤成四五行、并排的两项高矮不齐、每组最后一行还空半格。回到 6 个字段最省事，
 * 这两个开关本来就问的是同一件事（列表页顶部那两行显示什么），四档把它们四个组合都留着。
 *
 * 读到没有 `listTop` 的旧配置就按两个开关的组合迁过来：不迁的话，站长开着的那一行会静默消失。
 */
export function listTopOf(v: unknown, saved: { showSummary?: unknown; showGroupTabs?: unknown } = {}): ThemeConfig["listTop"] {
  if (v === "none" || v === "groups" || v === "summary" || v === "both") return v
  // 旧版（≤1.4.0）：两个布尔开关，四种组合正好对应这一档的四个取值。
  const summary = saved.showSummary === true
  const tabs = saved.showGroupTabs === true
  if (summary && tabs) return "both"
  if (summary) return "summary"
  if (tabs) return "groups"
  return DEFAULTS.listTop
}

/** 表单是四选一，页面只关心两个布尔：列表页顶部那行分组标签、那行概览卡片。 */
export function hasGroupTabs(top: ThemeConfig["listTop"]): boolean {
  return top === "groups" || top === "both"
}

export function hasSummary(top: ThemeConfig["listTop"]): boolean {
  return top === "summary" || top === "both"
}

/**
 * 收窄 Hub 存回来的设置。逐项收窄类型：Hub 存的是自由 JSON，站长清空输入框可能留下空串或 null，
 * 直接展开会让一个空串把默认图标顶掉。
 */
export function normalizeConfig(saved: unknown): ThemeConfig {
  const s = (saved && typeof saved === "object" ? saved : {}) as Record<string, unknown>
  return {
    siteIcon:
      typeof s.siteIcon === "string" && s.siteIcon.trim() ? s.siteIcon.trim() : DEFAULTS.siteIcon,
    // 留空是有意义的值（「自动探测本站」），不能像 siteIcon 那样回落成某个固定地址——
    // 那会把站长的选择又变成一座指向别处的图标。只有这一项从来没过才用默认值。
    farmUrl: typeof s.farmUrl === "string" ? s.farmUrl.trim() : DEFAULTS.farmUrl,
    showFarmEntry: typeof s.showFarmEntry === "boolean" ? s.showFarmEntry : DEFAULTS.showFarmEntry,
    // select：值不在声明里的选项内（旧版本、手改）就当没保存过，回落默认；
    // 旧值 "detail" 迁到 "latency"（见 cardStyleOf）。
    cardStyle: cardStyleOf(s.cardStyle),
    // 1.5.0 起是四选一，旧的 showSummary / showGroupTabs 在这里迁移（见 listTopOf）。
    listTop: listTopOf(s.listTop, { showSummary: s.showSummary, showGroupTabs: s.showGroupTabs }),
    // 留空是有意义的值（= 自动取前几条），空串不能当「没填过」；只有类型不对时才回落。
    pingLines: typeof s.pingLines === "string" ? s.pingLines : DEFAULTS.pingLines,
  }
}

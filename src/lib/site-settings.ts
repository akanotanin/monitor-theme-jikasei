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

/**
 * 顶栏养鸡场入口的「关闭」值：与「留空＝自动探测本站」「填地址＝自定义」并列的第三种状态。
 * 1.6.0 把原来两个键（`showFarmEntry` 开关 + `farmUrl` 地址）并进 `farmUrl` 这一个键，
 * 三种状态挤在一格里，靠这个哨兵值表达「关掉」。
 */
export const FARM_OFF = "off"

export type ThemeConfig = {
  /** 顶栏那枚圆形站标的地址，同时也是标签页图标；取不到就退回主题自带那张。 */
  siteIcon: string
  /**
   * 顶栏养鸡场入口：空串 = 自动探测本站的 `/chicken/`；`FARM_OFF` = 不显示入口；
   * 其它 = 自定义地址（同域路径或完整网址）。
   */
  farmUrl: string
  /**
   * 卡片形态：classic = 速率与总量各一行（2×2 四格）、不含延迟；plain = 网络合成一行，
   * 读数窗另换一套视觉处理（标签提亮、条压细、底注变小）、不含延迟；latency = 网络一行 +
   * 三网延迟；detailed = 再加在线时长、价格与到期；compact = 一行一台的表格（密度最高）。
   * 默认是 plain（站长的选择，2026-10-01 起）。
   */
  cardStyle: "classic" | "latency" | "detailed" | "plain" | "compact"
  /**
   * 列表页顶部显示什么：none = 都不显示；groups = 分组标签行；summary = 概览卡片行（原版）；
   * budget = 概览卡片行（月度预算剩余价值版）；both = 分组标签行 + 原版概览卡片；
   * bothBudget = 分组标签行 + 预算版概览卡片。
   */
  listTop: "none" | "groups" | "summary" | "budget" | "both" | "bothBudget"
  /** 卡片「三网延迟」要显示的线路，按名字指定（ping 任务名），一行一个。 */
  pingLines: string
  /** 「备注显示位置」：备注小卡片摊在哪儿（卡片 / 整页详情 / 两边都摊）。 */
  remarkPlacement: RemarkPlacement
}

/** 「备注显示位置」：`both` 卡片与详情页（默认）/ `card` 只在卡片 / `detail` 只在整页详情。 */
export type RemarkPlacement = "both" | "card" | "detail"

/** 三档取值（`normalizeConfig` 认这三样，别的都回落到 `both`）。 */
export const REMARK_PLACEMENTS: RemarkPlacement[] = ["both", "card", "detail"]

/**
 * 卡片那一侧（含「紧凑」就地展开行、经典/延迟右上角那枚浮层、详细档标题行）要不要摊备注。
 * 与 `remarksOnDetail` 是一对：两处合起来恰好覆盖「备注的落点」那三条口径。
 */
export function remarksOnCards(p: RemarkPlacement): boolean {
  return p !== "detail"
}

/** 整页详情（点进去那一页）要不要摊备注。 */
export function remarksOnDetail(p: RemarkPlacement): boolean {
  return p !== "card"
}

export const DEFAULTS: ThemeConfig = {
  siteIcon: "/site-icon.png",
  // 留空 = 自动：本站在约定的 `/chicken/` 上真装了养鸡场才显示那枚图标。
  // 「装主题」与「部署养鸡场」是两件事，站长没装就不该多出一枚点了没反应的图标；
  // 想固定指向别处（包括别人的公开那座）就填地址，想一律不显示就填 `off`。
  farmUrl: "",
  // 默认「经典」：紧凑、不发延迟请求；想带三网延迟的在后台切「延迟」，机器多想一屏看全的切「紧凑」。
  cardStyle: "plain",
  // 默认「都不显示」：这两行都是「一眼看全站」的补充，站点本来就有每台机器的卡片；
  // 关着时它们整个不挂载，首屏与没有这个功能时一模一样。
  listTop: "none",
  // 延迟线路：留空 = 按后台顺序自动显示前几条；填了名字就只显示这些（一行一个）。
  // 名字是 ping 任务的名字，不是节点名——对不上的行会被跳过。
  pingLines: "",
  // 备注显示位置：默认两边都摊。
  remarkPlacement: "both",
}

/**
 * 卡片形态这一档的取值。它在上一版（≤1.2.9）叫 "detail"，现在改叫 "latency"
 * ——「延迟」才是这一档真正展示的东西，也把「详细」这个名字腾给后面那一档。
 * 读到旧值就迁过来：不迁的话，存过 "detail" 的站会被当成从没保存过、悄悄掉回经典。
 */
export function cardStyleOf(v: unknown): ThemeConfig["cardStyle"] {
  // ≤1.2.9 的值：那时候这一档叫「详细」，现在叫「延迟」——同一档，只是换了名字。
  if (v === "detail") return "latency"
  if (v === "classic" || v === "latency" || v === "detailed" || v === "plain" || v === "compact") return v
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
 * 1.10.0 又多了一层「概览卡片长什么样」（原版 / 月度预算剩余价值版），但仍然并在这一个键里：
 * 再开一个设置项就是第 7 个字段，对话框又回到那个两列的排版。六档＝分组标签行开关（开关）
 * × 概览卡片三态（不显示 / 原版 / 预算版）里真的用得上的组合。
 *
 * 读到没有 `listTop` 的旧配置就按两个开关的组合迁过来：不迁的话，站长开着的那一行会静默消失。
 */
export function listTopOf(v: unknown, saved: { showSummary?: unknown; showGroupTabs?: unknown } = {}): ThemeConfig["listTop"] {
  if (v === "none" || v === "groups" || v === "summary" || v === "budget" || v === "both" || v === "bothBudget") return v
  // 旧版（≤1.4.0）：两个布尔开关，四种组合正好对应这一档的四个取值。
  const summary = saved.showSummary === true
  const tabs = saved.showGroupTabs === true
  if (summary && tabs) return "both"
  if (summary) return "summary"
  if (tabs) return "groups"
  return DEFAULTS.listTop
}

/** 表单是六选一，页面只关心这三个布尔：分组标签行、概览卡片行、那行是不是预算版。 */
export function hasGroupTabs(top: ThemeConfig["listTop"]): boolean {
  return top === "groups" || top === "both" || top === "bothBudget"
}

export function hasSummary(top: ThemeConfig["listTop"]): boolean {
  return top === "summary" || top === "budget" || top === "both" || top === "bothBudget"
}

/**
 * 概览卡片排成「月度预算剩余价值版」：第一张卡是月度预算 + 剩余价值，第二张卡是节点 + 最忙节点
 * （照站长给的参考图，后一张的两块读数分居卡片两端）。原版则是四张各一块读数。
 */
export function isBudgetLayout(top: ThemeConfig["listTop"]): boolean {
  return top === "budget" || top === "bothBudget"
}

/**
 * 顶栏养鸡场入口：1.5.0 及更早是两个键——`showFarmEntry`（布尔开关）+ `farmUrl`（地址，
 * 空串＝自动探测本站）。1.6.0 并成一个 `farmUrl`：空串＝自动、`off`＝关闭、其它＝地址。
 *
 * 要迁的是**「关掉」那一点信息**：老站点把入口关了（`showFarmEntry` 为假）而地址键从没动过，
 * 就直接落到 `off`——不迁的话，它会静默地又冒出一枚站长早就关掉的图标。地址键一旦存在
 * （哪怕是空串）就按它来：那是站长明确定过的值，也能覆盖「并入之后重新填了地址」的情形。
 */
function farmEntryOf(s: Record<string, unknown>): string {
  if (typeof s.farmUrl === "string") return s.farmUrl.trim()
  if (s.showFarmEntry === false) return FARM_OFF
  return DEFAULTS.farmUrl
}

/**
 * 收窄 Hub 存回来的设置。逐项收窄类型：Hub 存的是自由 JSON，站长清空输入框可能留下空串或 null，
 * 直接展开会让一个空串把默认图标顶掉。
 *
 * 备注不在这一层：hub 按节点下发的「公开备注」（给访客）与「私有备注」（只给登录的管理员）
 * 走 `/api/nodes`，见 `@/lib/notes`。主题这边没有备注设置项（1.15.x 那份「服务器备注」清单
 * 已删）；老站点配置里若还留着那个键，只是 Hub 站点配置里一个没人读的键（无害）。
 */
export function normalizeConfig(saved: unknown): ThemeConfig {
  const s = (saved && typeof saved === "object" ? saved : {}) as Record<string, unknown>
  return {
    siteIcon:
      typeof s.siteIcon === "string" && s.siteIcon.trim() ? s.siteIcon.trim() : DEFAULTS.siteIcon,
    // 养鸡场入口见 farmEntryOf：空串与 off 都是有意义的值，不能像 siteIcon 那样回落。
    farmUrl: farmEntryOf(s),
    // select：值不在声明里的选项内（旧版本、手改）就当没保存过，回落默认；
    // 旧值 "detail" 迁到 "latency"（见 cardStyleOf）。
    cardStyle: cardStyleOf(s.cardStyle),
    // 1.5.0 起是四选一，旧的 showSummary / showGroupTabs 在这里迁移（见 listTopOf）。
    listTop: listTopOf(s.listTop, { showSummary: s.showSummary, showGroupTabs: s.showGroupTabs }),
    // 留空是有意义的值（= 自动取前几条），空串不能当「没填过」；只有类型不对时才回落。
    pingLines: typeof s.pingLines === "string" ? s.pingLines : DEFAULTS.pingLines,
    // 「备注显示位置」只认那三档；老站点配置里没有这个键（或写成别的）→ 两边都摊。
    remarkPlacement: REMARK_PLACEMENTS.includes(s.remarkPlacement as RemarkPlacement)
      ? (s.remarkPlacement as RemarkPlacement)
      : DEFAULTS.remarkPlacement,
  }
}

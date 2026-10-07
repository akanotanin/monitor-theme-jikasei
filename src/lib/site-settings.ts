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
  /**
   * 卡片形态：classic = 速率与总量各一行（2×2 四格）、不含延迟；plain = 网络合成一行，
   * 读数窗另换一套视觉处理（标签提亮、条压细、底注变小）、不含延迟；latency = 网络一行 +
   * 三网延迟；detailed = 再加在线时长、价格与到期；compact = 一行一台的表格（密度最高）。
   * 默认「详细」（2026-10-06 站长定的）。
   */
  cardStyle: "classic" | "latency" | "detailed" | "plain" | "compact"
  /**
   * 列表页顶部显示什么：none = 都不显示；groups = 分组标签行；summary = 概览卡片行（原版）；
   * budget = 概览卡片行（月度预算剩余价值版）；both = 分组标签行 + 原版概览卡片；
   * bothBudget = 分组标签行 + 预算版概览卡片。
   *
   * 带标签行的两档里，**概览卡片算的是当前分组**（与下面的列表同一批机器，见 api.ts 的
   * groupView）；只有概览卡片的两档没有筛选入口，那它一直是全站口径。
   */
  listTop: "none" | "groups" | "summary" | "budget" | "both" | "bothBudget"
  /** 卡片「三网延迟」要显示的线路，按名字指定（ping 任务名），一行一个。 */
  pingLines: string
  /** 「备注显示位置」：备注小卡片摊在哪儿（卡片 / 整页详情 / 两边都摊）。 */
  remarkPlacement: RemarkPlacement
  /**
   * 节点地球显不显示：这是**站长给的默认**，也是这一整块功能的**闸门**。
   * 关掉时地球不渲染、**顶栏那枚开关也不出现**（访客的旧偏好不许把它顶回来）；开着时访客在
   * 顶栏那枚图标上自己关/开过的记在他自己浏览器里（localStorage），以他的为准
   * （与 `cardStyle` 同一套口径：站点级设置存 hub、访客偏好才落本地）。
   */
  globeOn: boolean
  /** 站点用哪一档明暗：随系统 / 随北京时间自动 / 固定亮 / 固定暗（访客自己的开关优先）。 */
  themeMode: ThemeMode
}

/** 四档明暗：`system` 随系统、`auto` 按北京时间自动、`light`/`dark` 固定。 */
export type ThemeMode = "system" | "auto" | "light" | "dark"

/** 四档的取值与顺序（后台那格下拉、`normalizeConfig` 都照它）。 */
export const THEME_MODES: ThemeMode[] = ["system", "auto", "light", "dark"]

/** 「备注显示位置」：`both` 卡片与详情页（默认）/ `card` 只在卡片 / `detail` 只在整页详情 / `none` 都不显示。 */
export type RemarkPlacement = "both" | "card" | "detail" | "none"

/** 四档取值（`normalizeConfig` 认这四样，别的都回落到 `both`）。 */
export const REMARK_PLACEMENTS: RemarkPlacement[] = ["both", "card", "detail", "none"]

/**
 * 卡片那一侧（含「紧凑」就地展开行、经典/延迟右上角那枚浮层、详细档标题行）要不要摊备注。
 * 与 `remarksOnDetail` 是一对，两处合起来恰好覆盖「备注的落点」那四档口径。
 *
 * ★写成**白名单**（只认 `both`/`card`）而不是「不等于 detail」：后者在新增第四档「都不显示」时会
 * 悄悄把卡片侧漏开（备注没关掉），是那种「看着改了、其实没生效」的坏实现。
 */
export function remarksOnCards(p: RemarkPlacement): boolean {
  return p === "both" || p === "card"
}

/** 整页详情（点进去那一页）要不要摊备注。同样写成白名单。 */
export function remarksOnDetail(p: RemarkPlacement): boolean {
  return p === "both" || p === "detail"
}

export const DEFAULTS: ThemeConfig = {
  // 默认「详细」（2026-10-06 站长定的）：在「延迟」之上再摊在线时长、价格与到期，一眼看全一台机器。
  // 想更轻的站切「简约」（底部收成一行两段、不发延迟请求）；机器多、想一屏看全的切「紧凑」（一行一台的表格）。
  cardStyle: "detailed",
  // 默认「两个都显示·概览卡片价值版」（2026-10-06 站长定的）：分组标签行 + 预算版概览卡片。
  // 这两行都是「一眼看全站」的补充，数据取自节点列表本身、不多发请求；站点没分组时标签行自然不出现。
  listTop: "bothBudget",
  // 延迟线路：留空 = 按后台顺序自动显示前几条；填了名字就只显示这些（一行一个）。
  // 名字是 ping 任务的名字，不是节点名——对不上的行会被跳过。
  pingLines: "",
  // 备注显示位置：默认两边都摊。
  remarkPlacement: "both",
  // 地球默认显示：它本来就是这块页面的招牌，站长要更安静的版面可以在后台关掉；
  // 关掉是**整块关**（地球不渲染、顶栏那枚开关也一起不出现），不是「访客还能自己开回来」的默认档。
  globeOn: true,
  // 明暗默认「随系统」：与 1.25.0 之前的行为一致（那时没有这一项，就是跟着系统走）。
  themeMode: "system",
}

/** 卡片形态的五档，**按界面上要显示的顺序**（顶栏那枚菜单、后台那格下拉都照它排）。 */
export const CARD_STYLES: ThemeConfig["cardStyle"][] = ["classic", "plain", "latency", "detailed", "compact"]

/**
 * 卡片形态这一档的取值，认不出来就 `null`。
 *
 * 两处用：
 *   · `cardStyleOf`（站点设置）：认不出 → 回落默认档；
 *   · 访客自己在顶栏选的那一档：认不出 → `null` = **没选过**，于是跟着站长的设置走。
 *     两者差别就在这一步：设置读坏了要退回一个能用的值，访客的偏好读坏了应该视为"没选"。
 *
 * 还在迁一个旧值：它在上一版（≤1.2.9）叫 "detail"，现在改叫 "latency"——「延迟」才是这一档
 * 真正展示的东西，也把「详细」这个名字腾给后面那一档。不迁的话，存过 "detail" 的站会被
 * 当成从没保存过、悄悄掉回经典。
 */
export function cardStyleOrNull(v: unknown): ThemeConfig["cardStyle"] | null {
  const style = v === "detail" ? "latency" : v
  return CARD_STYLES.includes(style as ThemeConfig["cardStyle"]) ? (style as ThemeConfig["cardStyle"]) : null
}

export function cardStyleOf(v: unknown): ThemeConfig["cardStyle"] {
  return cardStyleOrNull(v) ?? DEFAULTS.cardStyle
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
  // ★「键在不在」本身也是信息：站长保存过旧表单才有键。两个都是 false 是**明确把两行都关掉**（→ none），
  //   与「从没配过」必须分开——后者才跟着默认档走。混在一起的话，默认档一旦不是 none，
  //   老站明明关掉的两行会在升级后悄悄冒出来（就是本文件开头警告的那种静默改观感）。
  const configured = saved.showSummary !== undefined || saved.showGroupTabs !== undefined
  const summary = saved.showSummary === true
  const tabs = saved.showGroupTabs === true
  if (summary && tabs) return "both"
  if (summary) return "summary"
  if (tabs) return "groups"
  return configured ? "none" : DEFAULTS.listTop
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
 * 收窄 Hub 存回来的设置。逐项收窄类型：Hub 存的是自由 JSON，站长清空输入框可能留下空串或 null，
 * 直接展开会让一个空串把默认值顶掉。
 *
 * ★顶栏那枚入口图标（养鸡场）1.25.0 起**不再有设置项**：主题一律自动探测本站约定的
 * `/chicken/`（见 `@/lib/theme-config` 的 `useLocalFarm`）——「装主题」与「部署养鸡场」是两件事，
 * 装了才显示、没装不占位，站长不必配。老站点配置里若还留着 `farmUrl` / `showFarmEntry`
 * （1.6.0 之前那两个键，或后来那个三态键），这里**一律不再读**：面板上已经没有那一格，
 * 页面要是还听它的，就成了「看不见的开关」——站长想关也关不掉（与 1.6.0 并档时那条静默迁移
 * 是相反方向的取舍：那次面板里还留着那一格，所以要让面板说了算；这次那一格已经不在面板上了）。
 * 那些键留在 Hub 的站点配置里没人读，无害。
 *
 * 站点图标（`siteIcon`）1.25.0 起**不再由主题管**：hub 1.4.0 的面板「设置 → 站点图标」一设，
 * `/favicon.svg`、`/favicon.ico`、`/apple-touch-icon.png` 全由 hub 回答，换主题也保留；主题只要
 * 自带一份同名兜底（`public/favicon.svg`、`public/apple-touch-icon.png`）。老站点配置里若还留着
 * 那个键，只是 Hub 站点配置里一个没人读的键（无害，与「服务器备注」同）。
 *
 * 备注不在这一层：hub 按节点下发的「公开备注」（给访客）与「私有备注」（只给登录的管理员）
 * 走 `/api/nodes`，见 `@/lib/notes`。
 */
export function normalizeConfig(saved: unknown): ThemeConfig {
  const s = (saved && typeof saved === "object" ? saved : {}) as Record<string, unknown>
  return {
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
    // 开关：只认真布尔。老站点配置里没有这个键（→ 默认显示）；写成 "false" 这种字符串不算数。
    globeOn: typeof s.globeOn === "boolean" ? s.globeOn : DEFAULTS.globeOn,
    // 四档明暗：认不出来的取值（旧版本、手改）回落默认，别让页面卡在一个不存在的档上。
    themeMode: THEME_MODES.includes(s.themeMode as ThemeMode) ? (s.themeMode as ThemeMode) : DEFAULTS.themeMode,
  }
}

/**
 * 北京时间（UTC+8）现在是几点（0–23）。
 *
 * 用固定偏移而不是 `Intl`：中国全境不实行夏令时，UTC+8 就是北京时间；`Intl` 那套在
 * 少数老浏览器/精简 ICU 上会抛，而这里要的只是一个钟点。
 */
export function beijingHour(at: Date = new Date()): number {
  return (at.getUTCHours() + 8) % 24
}

/** 「随北京时间自动切换」的夜间窗口：**19:00 起、次日 07:00 止**（用暗色）。 */
export const NIGHT_FROM = 19
export const NIGHT_TO = 7

/** 按北京时间算，现在是不是夜里（该用暗色）。 */
export function isBeijingNight(at: Date = new Date()): boolean {
  const h = beijingHour(at)
  return h >= NIGHT_FROM || h < NIGHT_TO
}

/**
 * 站点设置 + 系统的明暗偏好 → 最终该不该用暗色。
 *
 * `auto` 只按钟点走（不查日出日落：那要经纬度与天文算法，而站长要的是「白天亮、晚上暗」）；
 * 访客自己点过那枚太阳/月亮图标的话，组件会拿他的选择**压过**这里的结论。
 */
export function resolveDark(mode: ThemeMode, systemDark: boolean, at: Date = new Date()): boolean {
  if (mode === "dark") return true
  if (mode === "light") return false
  if (mode === "auto") return isBeijingNight(at)
  return systemDark
}

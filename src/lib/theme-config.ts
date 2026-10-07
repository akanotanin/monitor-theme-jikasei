import { useCallback, useEffect, useState } from "react"

import { api } from "@/lib/api"
import { cardStyleOrNull, DEFAULTS, normalizeConfig, type ThemeConfig } from "@/lib/site-settings"

/**
 * 站点级设置：只存 Hub（`/api/themes/<short>/config`），一个站一份，不落访客的浏览器——
 * 访客自己的偏好（深浅色）才用 localStorage。后台「主题设置」表单按 theme.json 的
 * `config` 现画，两边靠 key 对上；默认值与迁移规则在 `site-settings.ts`（那里能单测），
 * `scripts/check-config.mjs` 在打包前兜底。
 */
const SHORT = "jikasei"

/**
 * 访客自己的两个偏好：**看不看节点地球**、**列表用哪种卡片形态**。都只存在他自己浏览器里，
 * 不写 hub —— 这与「站点级设置只存 hub、访客偏好才放 localStorage」是同一条规矩（见
 * `monitor-theme-porting` 铁律 4）。两者的默认都来自站长的设置：没选过（或存的值读不懂）
 * 就跟着设置走。
 *
 * 为什么还要给访客一份：站长那一档是**全站默认**（「节点地球」开关 2026-10-07 加进主题设置，
 * 与「主题模式」一起共 6 项、面板仍是一页平铺的单列），而访客仍该能自己关掉 —— 他的选择只影响
 * 他自己，站长改默认也不会被他的旧选择顶掉（选成与站长相同＝删掉记录、重新跟着走）。
 *
 * ★ 但地球与卡片形态有一处**不一样**：卡片形态是「列表怎么排」，站长那档无论取哪一档、
 * 那一页都还在；地球是一整块功能。站长在「主题设置 → 节点地球」里关掉 = **这一块关着**
 * （地球不渲染、顶栏那枚开关也不出现，见 `useGlobeVisible` 的注释）。
 */
const GLOBE_KEY = "jikasei:globe"
const CARD_STYLE_KEY = "jikasei:card_style"

/**
 * 节点地球看不看：站长在「主题设置 → 节点地球」里那一档是**闸门**，访客的偏好只在闸门开着时
 * 起作用（默认取站长那一档、他自己动过就以他的为准）。
 *
 * ★ 站长关掉（`siteDefault === false`）时一律是关：地球不渲染，**顶栏那枚开关也不出现**
 * （App.tsx 里按 `config.globeOn` 决定挂不挂那枚按钮）——「面板即事实」：关掉的这一块不该
 * 在页面上留一个点得动却什么也不开的按钮，访客存在自己浏览器里的旧偏好也不许把站长关掉的
 * 整块顶回来（老版本存过 `"1"` 的访客就是这么来的：那时站长那档是关的、他自己开过）。
 *
 * 选成与站长相同的那一档时**把记录删掉**（= 重新「跟着站长走」，以后站长改默认他也跟着变）——
 * 与 `useCardStyle` 同一套口径。存储被禁用（隐私模式）时这次会话里照样能开关，只是记不住。
 */
export function useGlobeVisible(siteDefault: boolean): [boolean, () => void] {
  const [saved, setSaved] = useState<string | null>(() => {
    try {
      return localStorage.getItem(GLOBE_KEY)
    } catch {
      return null
    }
  })
  const on = siteDefault && (saved === null || saved !== "0")
  return [
    on,
    () => {
      const next = !on
      const record = next === siteDefault ? null : next ? "1" : "0"
      try {
        if (record === null) localStorage.removeItem(GLOBE_KEY)
        else localStorage.setItem(GLOBE_KEY, record)
      } catch {
        // 同上：记不住就记不住，界面照常。
      }
      setSaved(record)
    },
  ] as const
}

/**
 * 列表用哪种卡片形态。返回的是**最终生效**的那一档与一个选择函数：
 * 访客选的记下来；选成和站长设置一样的那档时**把记录删掉**（= 重新"跟着站长走"，
 * 以后站长改默认，这位访客也会跟着变）。
 */
export function useCardStyle(siteDefault: ThemeConfig["cardStyle"]): [ThemeConfig["cardStyle"], (next: ThemeConfig["cardStyle"]) => void] {
  const [picked, setPicked] = useState<ThemeConfig["cardStyle"] | null>(() => {
    try {
      return cardStyleOrNull(localStorage.getItem(CARD_STYLE_KEY))
    } catch {
      return null
    }
  })
  const choose = useCallback(
    (next: ThemeConfig["cardStyle"]) => {
      setPicked(next === siteDefault ? null : next)
      try {
        if (next === siteDefault) localStorage.removeItem(CARD_STYLE_KEY)
        else localStorage.setItem(CARD_STYLE_KEY, next)
      } catch {
        // 记不住就只影响这一次会话：当前这一档仍然会立刻生效。
      }
    },
    [siteDefault],
  )
  return [picked ?? siteDefault, choose]
}

// 类型、默认值、收窄与迁移都在 site-settings.ts；这里只留取数据与页面侧的钩子，
// 顺手再导出一遍，页面统一从 `@/lib/theme-config` 拿。
export { DEFAULTS, hasGroupTabs, hasSummary, isBudgetLayout } from "@/lib/site-settings"
export type { ThemeConfig } from "@/lib/site-settings"

// ★ 站点图标（标签页／书签／手机桌面快捷方式）1.25.0 起**不在这里管了**：
// hub 1.4.0 的面板「设置 → 站点图标」一设，`/favicon.svg`、`/favicon.ico`、`/apple-touch-icon.png`
// 都由 hub 回答，而且 hub 在送 index.html 时会把这两个地址改写成 `?v=<内容摘要>` —— 站长换了图，
// URL 就变了，浏览器自己会重新取（Chrome 对标签页图标是按 URL 记的，不换 URL 就不重取）。
// 所以主题侧既不需要那个设置项，也不需要早跑脚本去改写 `<link>`；顶栏那枚圆标直接指同一个地址。
// 主题自带的 `public/favicon.svg` + `public/apple-touch-icon.png`（同一枚站标生成，
// 见 tools/make_icons.py）是 hub 上没设图标时的兜底。

/**
 * 本站约定的位置（`/chicken/`）上有没有装那座小鸡农场。装了就把入口指过去，没装就什么都不显示——
 * 「装主题」与「部署小鸡农场」是两件事，不能因为装了主题就多出一枚点不到东西的图标。
 *
 * ★ 1.25.0 起**没有设置项了**（原来那格「养鸡场入口」可以填地址或填 `off` 关掉）：探测就是唯一的
 * 来源，挂载即探一次。站长在面板里没有可配的开关，也就不存在「面板关了、页面还开着」这种看不见的状态。
 *
 * ★ 判据是**内容**而不是状态码：hub 对未知路径会回落到当前主题的 `index.html` 并回 200，
 * 所以 `/chicken/` 在「装了」与「没装」两种情况下都是 200 —— 拿状态码探等于恒真。
 * 小鸡农场的 location 里有一条 `^~ /chicken/api/` 反代到 hub，回的是 JSON；
 * 没装时同一条路径同样落到 index.html（HTML），`res.json()` 会抛错。
 *
 * 代价是没装小鸡农场的站每次加载多一次请求（落回 index.html，约 1KB）；装了的那次拿到的
 * 就是它自己的节点列表。
 */
export function useLocalFarm(): string {
  const [found, setFound] = useState(false)
  useEffect(() => {
    let alive = true
    fetch("/chicken/api/nodes", { headers: { Accept: "application/json" } })
      .then((res) => res.json())
      .then((data) => {
        if (alive && data && Array.isArray(data.nodes)) setFound(true)
      })
      .catch(() => {
        // 没装、或装了但那台没回 JSON：都不显示入口，不报错、不占位。
      })
    return () => { alive = false }
  }, [])
  return found ? "/chicken/" : ""
}

/**
 * 读回本站的设置。任何失败都回落默认值：后台没存过（Hub 回 `{}`）、旧 hub 没这个接口、
 * 反代拦了——都不该让公开页白屏或缺一块。收窄与迁移见 `normalizeConfig`。
 */
export function useThemeConfig(): ThemeConfig {
  const [config, setConfig] = useState(DEFAULTS)
  useEffect(() => {
    let active = true
    api<Partial<ThemeConfig>>(`/themes/${SHORT}/config`)
      .then((saved) => {
        if (!active) return
        // 逐项收窄 + 旧值迁移都在 site-settings.ts（那里能单测）。
        setConfig(normalizeConfig(saved))
      })
      .catch(() => {
        // 取不到设置（旧 hub、反代拦了）就维持默认值：公开页照常渲染，不该白屏或缺一块。
      })
    return () => { active = false }
  }, [])
  return config
}

import { useEffect, useState } from "react"

import { api } from "@/lib/api"
import { DEFAULTS, normalizeConfig, type ThemeConfig } from "@/lib/site-settings"

/**
 * 站点级设置：只存 Hub（`/api/themes/<short>/config`），一个站一份，不落访客的浏览器——
 * 访客自己的偏好（深浅色）才用 localStorage。后台「主题设置」表单按 theme.json 的
 * `config` 现画，两边靠 key 对上；默认值与迁移规则在 `site-settings.ts`（那里能单测），
 * `scripts/check-config.mjs` 在打包前兜底。
 */
const SHORT = "jikasei"

// 类型、默认值、收窄与迁移都在 site-settings.ts；这里只留取数据与页面侧的钩子，
// 顺手再导出一遍，页面统一从 `@/lib/theme-config` 拿。
export { DEFAULTS, FARM_OFF, hasGroupTabs, hasSummary } from "@/lib/site-settings"
export type { ThemeConfig } from "@/lib/site-settings"

/**
 * 标签页／书签／手机桌面快捷方式的图标，跟顶栏那枚站标用同一个地址：
 * 站长在「主题设置」里只填一处，页头与标签页就不会各是各的。
 *
 * 页面里可能有多个 `<link rel="icon">`（不同尺寸/格式），也可能一个都没有——
 * 一律就地改写、缺的补一个；`apple-touch-icon` 也一并跟上（iOS 加到主屏读的是它）。
 * **等顶栏那张出了结果才动这里**：站长那张图第一次是从零开始下载的，标签页与页头
 * 同时去要同一个地址，两条并发请求在弱链路（隧道、窄上行）上会互相踩——页头那张当场
 * 失败、顶栏的图标整块消失。跟着顶栏走就不会有两条并发，兜底也与它同一套。
 */
export function useSiteFavicon(icon: string | null) {
  useEffect(() => {
    // 传 null = 顶栏那张还没出结果：先维持 index.html 里的静态值，别抢跑。
    if (!icon) return
    const setIcons = (href: string) => {
      const icons = document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')
      if (icons.length) icons.forEach((link) => { link.href = href })
      else {
        const link = document.createElement("link")
        link.rel = "icon"
        link.href = href
        document.head.append(link)
      }
      let touch = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')
      if (!touch) {
        touch = document.createElement("link")
        touch.rel = "apple-touch-icon"
        document.head.append(touch)
      }
      touch.href = href
    }

    setIcons(icon)
  }, [icon])
}

/**
 * 本站约定的位置（`/chicken/`）上有没有养鸡场。装了就把入口指过去，没装就什么都不显示——
 * 「装主题」与「部署养鸡场」是两件事，不能因为装了主题就多出一枚点不到东西的图标。
 *
 * ★ 判据是**内容**而不是状态码：hub 对未知路径会回落到当前主题的 `index.html` 并回 200，
 * 所以 `/chicken/` 在「装了」与「没装」两种情况下都是 200 —— 拿状态码探等于恒真。
 * 养鸡场的 location 里有一条 `^~ /chicken/api/` 反代到 hub，回的是 JSON；
 * 没装时同一条路径同样落到 index.html（HTML），`res.json()` 会抛错。
 *
 * 代价是没装养鸡场的站每次加载多一次请求（落回 index.html，约 1KB）；装了的那次拿到的
 * 就是它自己的节点列表。站长想省掉这次探测、或指向别处（包括别人的公开养鸡场），
 * 在「主题设置」里填一个地址即可，那时这个钩子整个不跑（`enabled` 为假）。
 */
export function useLocalFarm(enabled: boolean): string {
  const [found, setFound] = useState(false)
  useEffect(() => {
    if (!enabled) return
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
  }, [enabled])
  // 关掉开关 / 填了地址时不返回地址（不必把探测结果清掉：站点设置在一次加载里只会到一次，
  // enabled 至多从假变真一回，页面上没有会让它翻回去的路径；真改了设置就是整页重载）。
  return enabled && found ? "/chicken/" : ""
}

/**
 * 读回本站的设置。任何失败都回落默认值：后台没存过（Hub 回 `{}`）、旧 hub 没这个接口、
 * 反代拦了——都不该让公开页白屏或缺一块。收窄与迁移见 `normalizeConfig`。
 */
export function useThemeConfig(): { config: ThemeConfig; loaded: boolean } {
  const [config, setConfig] = useState(DEFAULTS)
  // 设置到没到。顶栏那枚养鸡场图标靠它决定要不要去探测本站（见 useLocalFarm）：
  // 没等到设置就探，会让「填了自己地址」和「关掉入口」的站白探一次。
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let active = true
    api<Partial<ThemeConfig>>(`/themes/${SHORT}/config`)
      .then((saved) => {
        if (!active) return
        // 逐项收窄 + 旧值迁移都在 site-settings.ts（那里能单测）。
        setConfig(normalizeConfig(saved))
        setLoaded(true)
      })
      .catch(() => {
        // 取不到设置（旧 hub、反代拦了）也要置真：否则那次自动探测会被永远挡着、
        // 图标永远不出现。默认值已经就位，公开页照常渲染。
        setLoaded(true)
      })
    return () => { active = false }
  }, [])
  return { config, loaded }
}

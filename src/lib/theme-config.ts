import { useEffect, useState } from "react"

import { api } from "@/lib/api"

/**
 * 站点级设置：只存 Hub（`/api/themes/<short>/config`），一个站一份，不落访客的浏览器——
 * 访客自己的偏好（深浅色）才用 localStorage。后台「主题设置」表单按 theme.json 的
 * `config` 现画，两边靠 key 对上；DEFAULTS 必须与 theme.json 里那些 `default` 一致，
 * `scripts/check-config.mjs` 在打包前兜底。
 */
const SHORT = "jikasei"

export type ThemeConfig = {
  /** 顶栏那枚圆形站标的地址，同时也是标签页图标；取不到就退回主题自带那张。 */
  siteIcon: string
  /** 列表页是否显示分组标签行（全部 / 各组 / 未分组）。 */
  showGroupTabs: boolean
}

export const DEFAULTS: ThemeConfig = {
  siteIcon: "/site-icon.png",
  showGroupTabs: true,
}

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
 * 读回本站的设置。任何失败都回落默认值：后台没存过（Hub 回 `{}`）、旧 hub 没这个接口、
 * 反代拦了——都不该让公开页白屏或缺一块。
 *
 * 逐项收窄类型：Hub 存的是自由 JSON，站长清空输入框可能留下空串或 null，
 * 直接展开会让一个空串把默认图标顶掉。
 */
export function useThemeConfig(): ThemeConfig {
  const [config, setConfig] = useState(DEFAULTS)
  useEffect(() => {
    let active = true
    api<Partial<ThemeConfig>>(`/themes/${SHORT}/config`)
      .then((saved) => {
        if (!active) return
        setConfig({
          siteIcon:
            typeof saved.siteIcon === "string" && saved.siteIcon.trim()
              ? saved.siteIcon.trim()
              : DEFAULTS.siteIcon,
          showGroupTabs:
            typeof saved.showGroupTabs === "boolean" ? saved.showGroupTabs : DEFAULTS.showGroupTabs,
        })
      })
      .catch(() => { /* 默认值已经就位 */ })
    return () => { active = false }
  }, [])
  return config
}

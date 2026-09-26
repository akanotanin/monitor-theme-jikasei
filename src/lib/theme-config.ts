import { useEffect, useState } from "react"

import { api } from "@/lib/api"

/**
 * 站点级设置：只存 Hub（`/api/themes/<short>/config`），一个站一份，不落访客的浏览器——
 * 访客自己的偏好（深浅色）才用 localStorage。后台「主题设置」表单按 theme.json 的
 * `config` 现画，两边靠 key 对上；DEFAULTS 必须与 theme.json 里那些 `default` 一致，
 * `scripts/check-config.mjs` 在打包前兜底。
 */
const SHORT = "custom"

export type ThemeConfig = {
  /** 顶栏那枚圆形站标的地址；取不到就退回主题自带那张。 */
  siteIcon: string
  /** 列表页是否显示分组标签行（全部 / 各组 / 未分组）。 */
  showGroupTabs: boolean
}

export const DEFAULTS: ThemeConfig = {
  siteIcon: "/site-icon.png",
  showGroupTabs: true,
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

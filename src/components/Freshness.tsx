import { useEffect, useState } from "react"

/**
 * 页脚的「更新于 N 秒前」：**页面数据的年龄**（最近一次收到快照距现在多久）。
 *
 * 为什么要有它：实时连接（WS）静默断掉时会自动降级成 5 秒轮询 —— 页面上数字还在动，
 * 访客却无从判断「它是不是还活着、还是卡住了」。这行小字把数据的实际年龄摊开，三档：
 *   安静（弱化灰）：≤10 秒 —— 2 秒推送 / 5 秒轮询的常态都在这条线里，不动声色；
 *   提一档（前景色 70%）：11~44 秒 —— 明显落后于推送节奏，但还不必惊动人；
 *   警示（--warn）：≥45 秒 —— 数据已经旧到该看一眼了（多半是链路真的断了）。
 * 数据还没到之前不渲染（首屏那一瞬是空的，比先摆一个「—」安静）。
 *
 * 每秒 tick 的重绘**只发生在这个叶子组件里**（state 只在这儿），不牵动整棵树；
 * 页面在后台时浏览器的定时器节流会让它少跑几拍，回到前台自然对上。
 * 悬停说明里写清口径与降级行为，免得站长把这行当故障报。
 */
export function Freshness({ at }: { at: number | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  if (at === null) return null
  const ago = Math.max(0, Math.round((now - at) / 1000))
  const text = ago < 60 ? `${ago} 秒前` : ago < 3600 ? `${Math.floor(ago / 60)} 分钟前` : `${Math.floor(ago / 3600)} 小时前`
  const tone = ago <= 10 ? "text-muted-foreground" : ago < 45 ? "text-foreground/70" : "text-warn"
  return (
    <span
      data-freshness=""
      className={`tnum text-xs ${tone}`}
      title="页面数据距最近一次快照的时长：实时连接每 2 秒推送一次；它断开时会自动降级为每 5 秒轮询，这行数字会照常走动。"
    >
      更新于 {text}
    </span>
  )
}

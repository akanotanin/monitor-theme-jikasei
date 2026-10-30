import { useEffect, useRef, useState, type ReactNode } from "react"

/**
 * 明细浮层里**自己滚的那一节**（2026-10-31：机器多的情况）。
 *
 * 为什么单独成件：预算与「今日流量」两枚浮层都要「表头/尾巴不动、中间滚」，而且都要在
 * 「下面还有」时给一点提示 —— headless 里量过，`scrollbar-width: thin` 在部分平台上是
 * 悬停/滚动才现形的 overlay 滚动条（截图里干干净净，看不出还能往下翻）；手机上更是如此。
 * 所以除了纸面滚动条，滚动视口的下沿再挂一道**渐隐遮罩**（CSS mask，`data-more` 时才有）：
 * 露在边上那一行会淡出去，一眼看得出下面还有；滚到底遮罩撤掉，最后一行干干净净。
 *
 * `data-detail-scroll` 是护栏的锚点（判「这一节在滚、不是整块在滚」）。
 */
export function DetailScroll({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLSpanElement | null>(null)
  const [more, setMore] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 4)
    update()
    el.addEventListener("scroll", update, { passive: true })
    // 两种「长出来」都要跟：浮层自己的高度被压过（ResizeObserver），以及行往里加（MutationObserver
    // ——「今日流量」的峰值是一台一台回来的，那时滚动区盒子没变、只有内容变高）。
    const ro = new ResizeObserver(update)
    ro.observe(el)
    const mo = new MutationObserver(update)
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    return () => { el.removeEventListener("scroll", update); ro.disconnect(); mo.disconnect() }
  }, [])

  return (
    <span
      ref={ref}
      data-detail-scroll=""
      data-detail-more={more ? "" : undefined}
      className="detail-scroll block space-y-1 px-2.5 py-1.5"
    >
      {children}
    </span>
  )
}

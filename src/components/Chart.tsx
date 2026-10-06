import { useLayoutEffect, useRef, useState } from "react"

import { ChartTooltip } from "@/components/ChartTooltip"
import { clockFor, quarters, timeTicks } from "@/lib/format"

/**
 * 零依赖的时间序列图：替掉 recharts（它给详情页背了 384KB 原始 / 110KB gzip 的包，
 * 而这里要画的只是「坐标轴 + 网格 + 几条折线/面积 + 一枚悬停 tooltip」）。
 *
 * 口径与原来那套**逐项对齐**，不是重新设计：
 *   · Y 轴从 0 起、刻度就是 `quarters(top)`（top 由 `axisTop` 定，所以四格是整数）；
 *   · X 轴是**真时间轴**（`timeTicks` 给的显式刻度），不是按序号排的类别轴 ——
 *     否则 agent 掉线那段时间会被压成 0 宽，看着像什么都没发生；
 *   · 断点照断：某个采样是 null（那一段没数据）就断开重起一笔，不连桥；
 *   · 折线不带点、1.5px、无入场动画（`SERIES` 那三条注释说的就是这些）；
 *   · 悬停时画一条竖线 + 那枚自绘 tooltip（`ChartTooltip`，本来就跟 recharts 解耦，
 *     只是 props 恰好同形）。
 *
 * 尺寸跟着父容器走（`ResizeObserver`）：四张资源图挂在 `Panel` 的 `h-40` 里，
 * 延迟图挂在 `flex-1` 里，两条路都得撑满。
 */
export type ChartSeries = {
  key: string
  name: string
  color: string
  /** 面积图：线下面填一层同色淡色；折线图不填。 */
  area?: boolean
  /** 区间（band）：这一列的值是 `[低, 高]`，画成两条边之间的一块淡色（Smokeping 那种「烟」）。 */
  band?: boolean
  dash?: string
}

export type ChartRow = { ts: number } & Record<string, number | [number, number] | null | undefined>

/** 左边留给 Y 轴刻度的宽度，与四张资源图原来的 `Y_WIDTH` 一致（否则各图 x 会错位）。 */
const LEFT = 68
const RIGHT = 8
const TOP = 6
const BOTTOM = 24
/** 刻度字号（与原来 `AXIS.fontSize` 一致）。 */
const FONT = 11
/** 11px 下大约的字符宽，用来判两个 X 刻度标签会不会撞上。 */
const CHAR = 6.2

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

/** 取值域（band 那一列是 [低, 高]，两条边都要算进去）。 */
function extentOf(view: ChartRow[], keys: string[]): [number, number] | null {
  let lo = Infinity
  let hi = -Infinity
  for (const row of view) {
    for (const key of keys) {
      const v = row[key]
      const pair = Array.isArray(v) ? v : [v]
      for (const one of pair) {
        const n = num(one)
        if (n === null) continue
        if (n < lo) lo = n
        if (n > hi) hi = n
      }
    }
  }
  return lo === Infinity ? null : [lo, hi]
}

/**
 * 自动刻度的整齐步长：把量程摊成 count 格，每格取「1 / 2 / 2.5 / 5 / 10 × 10^k」里第一个够大的，
 * 再把上下沿各向外扩到步长的整数倍 —— 就是原来 recharts `domain={["auto","auto"]}` 那套效果
 * （延迟轴不从 0 起：这些线路活在一条窄带里，锚到 0 会把起伏压平）。
 */
function niceScale(lo: number, hi: number, count = 4): { lo: number; hi: number; ticks: number[] } {
  if (!(hi > lo)) {
    const pad = Math.abs(hi) > 1 ? Math.abs(hi) * 0.1 : 1
    lo -= pad
    hi += pad
  }
  const raw = (hi - lo) / count
  const mag = 10 ** Math.floor(Math.log10(Math.max(raw, Number.MIN_VALUE)))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((n) => n >= raw) ?? raw
  const low = Math.floor(lo / step) * step
  const high = Math.ceil(hi / step) * step
  const ticks: number[] = []
  for (let v = low; v <= high + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return { lo: low, hi: high, ticks }
}

export function TimeChart({
  rows,
  series,
  hours,
  top = 0,
  unit = "",
  format,
  yFormat,
  from = 0,
  to,
  label,
  domain = "zero",
  left = LEFT,
  onZoom,
  renderTooltip,
}: {
  rows: ChartRow[]
  series: ChartSeries[]
  /** 窗口宽度，决定 X 轴标签的粒度（`clockFor`）。 */
  hours: number
  /** `domain="zero"` 时的 Y 轴顶端；刻度是它的四等分。 */
  top?: number
  /** 拼在 Y 轴刻度后面的单位（`%` / `/s` / `ms`），空字符串就不拼。 */
  unit?: string
  /** 悬停 tooltip 里那个值怎么印（用自绘 tooltip 时可以不传）。 */
  format?: (value: number) => string
  /** Y 轴刻度怎么印，默认按原样（最多一位小数）。 */
  yFormat?: (value: number) => string
  /** 只看 `rows[from..to]` 这一段（缩放窗口用，索引是**全量数组**里的下标）。 */
  from?: number
  to?: number
  /** 给读屏用的一句话（这张图画的是什么）。 */
  label?: string
  /**
   * `zero`：Y 轴从 0 起、刻度是 `quarters(top)`（四张资源图）。
   * `auto`：Y 轴按数据自身的量程取整齐刻度（延迟轴 —— 那些线路活在一条窄带里，
   *         锚到 0 会把抖动压平；这就是原来 `domain={["auto","auto"]}` 的意思）。
   */
  domain?: "zero" | "auto"
  /** 左边留给 Y 轴刻度的宽度（四张资源图 68，延迟图 52，与原来逐像素一致）。 */
  left?: number
  /** 给了它就能**在图上横向拖选一段缩放**（索引是全量数组里的下标）。 */
  onZoom?: (from: number, to: number) => void
  /** 自定义悬停内容（延迟图用它接 `PingTooltip`）。 */
  renderTooltip?: (row: ChartRow) => React.ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hover, setHover] = useState<number | null>(null)
  const [pointerY, setPointerY] = useState<number | null>(null)
  const [tipH, setTipH] = useState(0)
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)

  // 卡片高度：用来把它夹在绘图区里（别顶出去）。悬停的那一格变了才量一次 —— 带依赖数组
  // 是给 linter 一个交代（不写它会被判成「每次渲染都 setState」），值没变时 setState 会被
  // React 直接丢掉，不会多渲染一轮。
  useLayoutEffect(() => {
    const h = tip.current?.offsetHeight ?? 0
    if (h && h !== tipH) setTipH(h)
  }, [hover, tipH])

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(read)
    ro.observe(el)
    read()
    return () => ro.disconnect()
  }, [])

  const last = Math.max(0, rows.length - 1)
  const a = Math.min(Math.max(Math.round(from), 0), last)
  const b = Math.min(Math.max(to ?? last, a), last)
  const view = rows.slice(a, b + 1)

  const w = size.w
  const h = size.h
  const plotW = Math.max(1, w - left - RIGHT)
  const plotH = Math.max(1, h - TOP - BOTTOM)
  const t0 = view.length ? view[0].ts : 0
  const t1 = view.length ? view[view.length - 1].ts : 1
  const span = Math.max(1, t1 - t0)

  // 刻度：零起点用 quarters(top)，自动档用数据量程取整齐步长。
  const scale =
    domain === "auto"
      ? niceScale(...(extentOf(view, series.map((s) => s.key)) ?? [0, 1]))
      : { lo: 0, hi: top > 0 ? top : 1, ticks: quarters(top) }
  const yRange = Math.max(1e-9, scale.hi - scale.lo)

  const x = (ts: number) => left + ((ts - t0) / span) * plotW
  const y = (value: number) => TOP + plotH - ((value - scale.lo) / yRange) * plotH

  const yLabel = yFormat ?? ((value: number) => String(Math.round(value * 10) / 10))
  const xTicks = view.length > 1 ? timeTicks(t0, t1).filter((t) => t >= t0 && t <= t1) : []
  const clock = clockFor(hours)
  // 撞在一起的刻度标签直接丢掉（原来靠 recharts 的 minTickGap，这里自己算）：
  // 按 11px 的近似字宽排一遍，与前一个标签的右沿重叠就不画。
  const keptX: number[] = []
  let edge = -Infinity
  for (const t of xTicks) {
    const half = (clock(t).length * CHAR) / 2
    const cx = x(t)
    if (cx - half < edge + 6) continue
    keptX.push(t)
    edge = cx + half
  }

  /** 一条曲线：null 断开重起一笔（不连桥）。 */
  const lineOf = (s: ChartSeries) => {
    let d = ""
    let pen = false
    for (const row of view) {
      const v = num(row[s.key])
      if (v === null) {
        pen = false
        continue
      }
      d += `${pen ? "L" : "M"}${x(row.ts).toFixed(1)},${y(v).toFixed(1)}`
      pen = true
    }
    return d
  }

  /** 面积：每一段连续的点各自闭合成一块（同样不跨断点）。 */
  const areasOf = (s: ChartSeries) => {
    const out: string[] = []
    let run: { x: number; y: number }[] = []
    const flush = () => {
      if (run.length < 2) {
        run = []
        return
      }
      const base = TOP + plotH
      out.push(
        `M${run[0].x.toFixed(1)},${base.toFixed(1)}` +
          run.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("") +
          `L${run[run.length - 1].x.toFixed(1)},${base.toFixed(1)}Z`,
      )
      run = []
    }
    for (const row of view) {
      const v = num(row[s.key])
      if (v === null) {
        flush()
        continue
      }
      run.push({ x: x(row.ts), y: y(v) })
    }
    flush()
    return out
  }

  /** 区间（band）：上沿去、下沿回的一块；同样不跨断点。 */
  const bandsOf = (s: ChartSeries) => {
    const out: string[] = []
    let run: { x: number; lo: number; hi: number }[] = []
    const flush = () => {
      if (run.length < 2) {
        run = []
        return
      }
      const up = run.map((p) => `${p.x.toFixed(1)},${y(p.hi).toFixed(1)}`).join("L")
      const down = [...run].reverse().map((p) => `${p.x.toFixed(1)},${y(p.lo).toFixed(1)}`).join("L")
      out.push(`M${up}L${down}Z`)
      run = []
    }
    for (const row of view) {
      const pair = row[s.key]
      const lo = num(Array.isArray(pair) ? pair[0] : null)
      const hi = num(Array.isArray(pair) ? pair[1] : null)
      if (lo === null || hi === null) {
        flush()
        continue
      }
      run.push({ x: x(row.ts), lo, hi })
    }
    flush()
    return out
  }

  const indexAt = (clientX: number, el: Element) => {
    const rect = el.getBoundingClientRect()
    const ratio = (clientX - rect.left) / Math.max(1, rect.width)
    return Math.min(view.length - 1, Math.max(0, Math.round(ratio * (view.length - 1))))
  }

  const hovered = hover === null ? null : view[Math.min(Math.max(hover, 0), view.length - 1)]
  const payload = hovered
    ? series.map((s) => ({
        dataKey: s.key,
        name: s.name,
        color: s.color,
        value: num(Array.isArray(hovered[s.key]) ? null : hovered[s.key]),
        payload: hovered as unknown as Record<string, unknown>,
      }))
    : []
  const zoomed = !!onZoom && (a > 0 || b < last)
  const sel = drag ? { lo: Math.min(drag.from, drag.to), hi: Math.max(drag.from, drag.to) } : null

  return (
    // `data-chart`：给护栏一个稳定锚点（仓库里 `data-latency` / `data-card-style` 同一套做法）。
    // 换实现（recharts → 自绘）时，按 `.recharts-surface` 那种类名找的判据会静默变成 0。
    <div ref={box} data-chart="" className="relative h-full w-full">
      {w > 0 && h > 0 && (
        <svg width={w} height={h} role="img" aria-label={label} className="overflow-visible">
          {/* 网格：只画横线（原来 `vertical={false}`），虚线、用边框色。 */}
          {scale.ticks.map((v) => (
            <line
              key={`g${v}`}
              x1={left}
              x2={left + plotW}
              y1={y(v)}
              y2={y(v)}
              className="stroke-border"
              strokeDasharray="3 3"
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          ))}
          {/* Y 轴刻度 */}
          {scale.ticks.map((v) => (
            <text
              key={`y${v}`}
              x={left - 6}
              y={y(v)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={FONT}
              fill="currentColor"
            >
              {`${yLabel(v)}${unit}`}
            </text>
          ))}
          {/* X 轴刻度 */}
          {keptX.map((t) => (
            <text key={`x${t}`} x={x(t)} y={TOP + plotH + 14} textAnchor="middle" fontSize={FONT} fill="currentColor">
              {clock(t)}
            </text>
          ))}
          {series.map((s) =>
            s.band
              ? bandsOf(s).map((d, i) => <path key={`b${s.key}${i}`} d={d} fill={s.color} fillOpacity={0.16} stroke="none" />)
              : null,
          )}
          {series.map((s) =>
            s.area ? (
              areasOf(s).map((d, i) => <path key={`a${s.key}${i}`} d={d} fill={s.color} fillOpacity={0.15} stroke="none" />)
            ) : null,
          )}
          {/* 线：band 那一列没有线（它的值是 [低, 高]，画成一块区间），别给它生成空路径。 */}
          {series.filter((s) => !s.band).map((s) => (
            <path
              key={`l${s.key}`}
              d={lineOf(s)}
              fill="none"
              stroke={s.color}
              strokeWidth={1.5}
              strokeDasharray={s.dash}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {/* 悬停竖线（原来 `CURSOR` 那枚）。 */}
          {hovered && !sel && (
            <line x1={x(hovered.ts)} x2={x(hovered.ts)} y1={TOP} y2={TOP + plotH} className="stroke-border" strokeWidth={1} />
          )}
          {/* 拖选中的那一段（松手才真的缩放）。 */}
          {sel && view.length > 1 && (
            <rect
              x={x(view[sel.lo].ts)}
              y={TOP}
              width={Math.max(1, x(view[sel.hi].ts) - x(view[sel.lo].ts))}
              height={plotH}
              fill="currentColor"
              opacity={0.08}
            />
          )}
          {/* 命中层：整块绘图区接指针，按 x 找最近的那个点；给了 onZoom 就能横向拖选缩放。 */}
          <rect
            x={left}
            y={TOP}
            width={plotW}
            height={plotH}
            fill="transparent"
            // `pan-y`：手机上竖着划仍然滚页面，只有横向拖才被这里接走。
            style={onZoom ? { touchAction: "pan-y" } : undefined}
            onMouseMove={(e) => {
              if (view.length === 0) return
              setHover(indexAt(e.clientX, e.currentTarget))
              // 卡片要跟着鼠标走，所以纵坐标也记下来（原来是钉在图表顶端的）。
              const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect()
              setPointerY(Math.min(Math.max(e.clientY - rect.top, 0), rect.height))
            }}
            onMouseLeave={() => {
              setHover(null)
              setPointerY(null)
            }}
            onPointerDown={(e) => {
              if (!onZoom || view.length < 3) return
              // 捕获失败不该让整段拖选失效（指针已经消失、或合成事件没有有效 id 时会抛）。
              try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 无所谓 */ }
              const at = indexAt(e.clientX, e.currentTarget)
              setDrag({ from: at, to: at })
            }}
            onPointerMove={(e) => {
              if (!drag) return
              setDrag({ ...drag, to: indexAt(e.clientX, e.currentTarget) })
            }}
            onPointerUp={() => {
              if (!drag || !onZoom) return
              const lo = Math.min(drag.from, drag.to)
              const hi = Math.max(drag.from, drag.to)
              setDrag(null)
              // 只是点了一下（没拖开）就不动：重置交给那枚「重置」。
              if (hi - lo >= 2) onZoom(a + lo, a + hi)
            }}
          />
        </svg>
      )}
      {/* 缩放着的时候给一枚重置（原来 recharts 的 Brush 是拖两端把手，这里改成图上拖选 + 这枚按钮）。 */}
      {zoomed && onZoom && (
        <button
          type="button"
          onClick={() => onZoom(0, last)}
          className="tap tap-y-6 absolute top-0 right-1 rounded-md border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          重置
        </button>
      )}
      {hovered && (
        <div
          ref={tip}
          className="pointer-events-none absolute z-30"
          // 纵向**跟着鼠标**走（原来是钉在图表顶端）：以光标为中心，再夹在绘图区里 ——
          // 上下两头各留一点，别顶出图外，也别盖住 x 轴标签。
          // 横向仍贴着光标那条竖线（靠右时翻到左边），与原来一致。
          style={{
            top: Math.min(Math.max((pointerY ?? plotH / 2) - tipH / 2 + TOP, TOP), Math.max(TOP, TOP + plotH - tipH)),
            ...(x(hovered.ts) > left + plotW - 150
              ? { right: w - x(hovered.ts) + 8 }
              : { left: x(hovered.ts) + 8 }),
          }}
        >
          {renderTooltip ? (
            renderTooltip(hovered)
          ) : (
            <ChartTooltip active label={hovered.ts} payload={payload} format={format ?? ((v: number) => String(v))} />
          )}
        </div>
      )}
    </div>
  )
}

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
  dash?: string
}

export type ChartRow = { ts: number } & Record<string, number | null | undefined>

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

export function TimeChart({
  rows,
  series,
  hours,
  top,
  unit = "",
  format,
  yFormat,
  from = 0,
  to,
  label,
}: {
  rows: ChartRow[]
  series: ChartSeries[]
  /** 窗口宽度，决定 X 轴标签的粒度（`clockFor`）。 */
  hours: number
  /** Y 轴顶端；刻度是它的四等分。 */
  top: number
  /** 拼在 Y 轴刻度后面的单位（`%` / `/s`），空字符串就不拼。 */
  unit?: string
  /** 悬停 tooltip 里那个值怎么印。 */
  format: (value: number) => string
  /** Y 轴刻度怎么印，默认按原样（最多一位小数）。 */
  yFormat?: (value: number) => string
  /** 只看 `rows[from..to]` 这一段（延迟图的缩放窗口用）。 */
  from?: number
  to?: number
  /** 给读屏用的一句话（这张图画的是什么）。 */
  label?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hover, setHover] = useState<number | null>(null)

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
  const plotW = Math.max(1, w - LEFT - RIGHT)
  const plotH = Math.max(1, h - TOP - BOTTOM)
  const t0 = view.length ? view[0].ts : 0
  const t1 = view.length ? view[view.length - 1].ts : 1
  const span = Math.max(1, t1 - t0)
  const yTop = top > 0 ? top : 1

  const x = (ts: number) => LEFT + ((ts - t0) / span) * plotW
  const y = (value: number) => TOP + plotH - (value / yTop) * plotH

  const yTicks = quarters(top)
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

  const hovered = hover === null ? null : view[Math.min(Math.max(hover, 0), view.length - 1)]
  const payload = hovered
    ? series.map((s) => ({
        dataKey: s.key,
        name: s.name,
        color: s.color,
        value: num(hovered[s.key]),
        payload: hovered as unknown as Record<string, unknown>,
      }))
    : []

  return (
    <div ref={box} className="relative h-full w-full">
      {w > 0 && h > 0 && (
        <svg width={w} height={h} role="img" aria-label={label} className="overflow-visible">
          {/* 网格：只画横线（原来 `vertical={false}`），虚线、用边框色。 */}
          {yTicks.map((v) => (
            <line
              key={`g${v}`}
              x1={LEFT}
              x2={LEFT + plotW}
              y1={y(v)}
              y2={y(v)}
              className="stroke-border"
              strokeDasharray="3 3"
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          ))}
          {/* Y 轴刻度 */}
          {yTicks.map((v) => (
            <text
              key={`y${v}`}
              x={LEFT - 6}
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
            s.area ? (
              areasOf(s).map((d, i) => <path key={`a${s.key}${i}`} d={d} fill={s.color} fillOpacity={0.15} stroke="none" />)
            ) : null,
          )}
          {series.map((s) => (
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
          {hovered && (
            <line x1={x(hovered.ts)} x2={x(hovered.ts)} y1={TOP} y2={TOP + plotH} className="stroke-border" strokeWidth={1} />
          )}
          {/* 命中层：整块绘图区接鼠标，按 x 找最近的那个点。 */}
          <rect
            x={LEFT}
            y={TOP}
            width={plotW}
            height={plotH}
            fill="transparent"
            onMouseMove={(e) => {
              if (view.length === 0) return
              const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect()
              const ratio = (e.clientX - rect.left) / Math.max(1, rect.width)
              setHover(Math.round(ratio * (view.length - 1)))
            }}
            onMouseLeave={() => setHover(null)}
          />
        </svg>
      )}
      {hovered && (
        <div
          className="pointer-events-none absolute z-30"
          // 靠右时翻到光标左边，别把 tooltip 顶出图外（原来是 recharts 自己兜的）。
          style={
            x(hovered.ts) > LEFT + plotW - 150
              ? { right: w - x(hovered.ts) + 8, top: TOP }
              : { left: x(hovered.ts) + 8, top: TOP }
          }
        >
          <ChartTooltip active label={hovered.ts} payload={payload} format={format} />
        </div>
      )}
    </div>
  )
}

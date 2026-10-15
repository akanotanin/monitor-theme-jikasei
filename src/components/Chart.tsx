import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"

import { ChartTooltip } from "@/components/ChartTooltip"
import { clockFor, innerTicks, quarters, timeTicks, zoomSpan } from "@/lib/format"

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

// ★历史存档（2026-10-15）：这里曾有一支「最近视距」下限（`AUTO_MIN_SPAN_RATIO = 0.25`，
//   2026-10-14 深夜加：几 ms 的抖动不再被怼满全高），2026-10-15 站长要求**撤回**——延迟图
//   量程回到「贴数据自身量程」的口径（详情图与卡片走势线同步撤回）。再遇到「要不要加量程
//   下限」的需求，先把两边取舍问清楚（贴数据 = 抖动看得清、但小波动会满屏；带下限 = 安静、
//   但小波动被压平），别再绕回来。


/** 滚轮缩放的跨度下限（单位跟图表走；当前只有延迟图开，= 1ms）：再近就没信息了。 */
const ZOOM_MIN_SPAN = 1
/** 滚轮缩放的顶端封顶：1000 与「数据顶端 × 2」取大——爆表值（超时 3000ms 之类）也留得下余地。 */
const zoomCapOf = (dataHi: number) => Math.max(1000, dataHi * 2)

export function TimeChart({
  rows,
  series,
  hours,
  top = 0,
  unit = "",
  format,
  yFormat,
  label,
  domain = "zero",
  left = LEFT,
  wheelZoom,
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
  /**
   * 给了它（且 `domain="auto"`）就能**用滚轮调整 Y 轴（纵向）范围**：以光标压着的那个
   * 值为锚点收放（缩放后那个值还钉在同一行像素上）、双击图表复位；夹子两道——跨度最小
   * `ZOOM_MIN_SPAN`（1ms）、顶端最高 `zoomCapOf(数据顶端)`。监听是**非 passive** 的：
   * 光标在图上时滚轮归这张图，页面不跟着滚（页面别处照常滚）。
   * 当前只有整页详情的延迟图开（紧凑展开里不开——列表里滚轮要留给翻列表）。
   */
  wheelZoom?: boolean
  /** 自定义悬停内容（延迟图用它接 `PingTooltip`）。 */
  renderTooltip?: (row: ChartRow) => React.ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hover, setHover] = useState<number | null>(null)
  const [pointerY, setPointerY] = useState<number | null>(null)
  const [tipH, setTipH] = useState(0)
  // 拖着线平移的基准：按下那一刻的指针 y 与量程（整段拖动都按它算，不跟着每次移动累加）。
  const panRef = useRef<{ y0: number; lo: number; hi: number; moved: boolean } | null>(null)
  // 滚轮缩放出来的手动 Y 范围（null = 自动量程）。
  const [yZoom, setYZoom] = useState<{ lo: number; hi: number } | null>(null)
  // clipPath 的 id：每张图一个（延迟图与四张资源图会同页共存），`useId` 的冒号等字符剔掉。
  const cid = useId().replace(/[^a-zA-Z0-9_-]/g, "")
  // 换量程（`hours`）＝整页重新取数：横向缩放由调用方（NodeDetail）复位，纵向缩放归本组件管，
  // 跟它一起回自动。
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    setYZoom(null)
  }, [hours])

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

  const view = rows

  const w = size.w
  const h = size.h
  const plotW = Math.max(1, w - left - RIGHT)
  const plotH = Math.max(1, h - TOP - BOTTOM)
  const t0 = view.length ? view[0].ts : 0
  const t1 = view.length ? view[view.length - 1].ts : 1
  const span = Math.max(1, t1 - t0)

  // 刻度：零起点用 quarters(top)，自动档用数据量程取整齐步长。
  const autoExtent = extentOf(view, series.map((s) => s.key))
  const autoScale =
    domain === "auto"
      ? niceScale(...(autoExtent ?? [0, 1]))
      : { lo: 0, hi: top > 0 ? top : 1, ticks: quarters(top) }
  // 手动档（滚轮缩放）：边界就是滚出来的精确值、刻度只挑范围内的整齐数（见 innerTicks）——
  // 自动档那套「向外扩到整步长」会把锚点随每次滚动蹭走，滚轮手感靠的就是锚点不漂。
  const scale = yZoom ? { lo: yZoom.lo, hi: yZoom.hi, ticks: innerTicks(yZoom.lo, yZoom.hi) } : autoScale
  const yRange = Math.max(1e-9, scale.hi - scale.lo)

  const x = (ts: number) => left + ((ts - t0) / span) * plotW
  const y = (value: number) => TOP + plotH - ((value - scale.lo) / yRange) * plotH

  // 滚轮监听器只装一次，量程与几何从 ref 里现读（渲染期间写 ref 是「最新值」的标准做法，
  // 放 layout effect 里保证每次渲染后都对齐）。
  const wheelRef = useRef({ lo: 0, hi: 0, plotH: 0, dataHi: 0 })
  useLayoutEffect(() => {
    wheelRef.current = { lo: scale.lo, hi: scale.hi, plotH, dataHi: autoExtent?.[1] ?? 0 }
  })
  // 滚轮缩放（`wheelZoom` 且 domain=auto）：非 passive（要 preventDefault 住页面滚动），
  // 光标压着的那个值当锚点收放；夹子两道（跨度 ≥ ZOOM_MIN_SPAN、顶端 ≤ zoomCapOf）。
  useEffect(() => {
    const el = box.current
    if (!el || !wheelZoom || domain !== "auto") return
    const onWheel = (e: WheelEvent) => {
      const st = wheelRef.current
      if (st.plotH <= 0) return
      e.preventDefault()
      // deltaMode：0=像素（绝大多数）、1=行、2=页；先归一到「像素」口径。
      let d = e.deltaY
      if (e.deltaMode === 1) d *= 16
      else if (e.deltaMode === 2) d *= 100
      // 单次事件封顶 ±240：每 100 个滚动单位收放约 14%（e^±0.15），一格滚轮（±100/±120）
      // 的观感正好，触控板的小步长也顺；猛甩一下最多按 1.43× 走，不会一步飞天。
      d = Math.max(-240, Math.min(240, d))
      const f = Math.exp(d * 0.0015)
      const rect = el.getBoundingClientRect()
      const ratio = Math.min(Math.max((e.clientY - rect.top - TOP) / st.plotH, 0), 1)
      // 锚点 = 光标当前压着的那个值。缩放后它还钉在同一行像素上——滚轮「手感」的全部就是这一条。
      const anchor = st.hi - ratio * (st.hi - st.lo)
      // 跨度下限：min(1ms, 自动量程的 1/4)。亚毫秒线路的自动量程本来就窄于 1ms，固定 1ms 会把
      // 第一格滚轮变成「放大 + 锚点跳走」、下沿贴 0 时更会双向卡死（2026-10-15 审出来，量程数学
      // 与三道夹子都挪进 format.ts 的 zoomSpan，配了单测）。
      const floor = Math.min(ZOOM_MIN_SPAN, Math.max((autoExtent ? autoExtent[1] - autoExtent[0] : 0) * 0.25, 1e-9))
      setYZoom(zoomSpan({ lo: st.lo, hi: st.hi, anchor, ratio, factor: f, floor, cap: zoomCapOf(st.dataHi) }))
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [wheelZoom, domain])

  // 默认刻度印法：小数位**跟着刻度步长走**（步长 0.25 就印两位）—— 一位小数会把 0.25 印成
  // 「0.3」，网格线画在真值上、标签却对不上（2026-10-15 与 kanso 同步）。
  const yDigits = (() => {
    const t = scale.ticks
    if (t.length < 2) return 1
    const stepV = Math.abs(t[1] - t[0])
    for (let d = 0; d <= 3; d++) if (Math.abs(Math.round(stepV * 10 ** d) / 10 ** d - stepV) < stepV * 1e-9) return d
    return 3
  })()
  const yLabel = yFormat ?? ((value: number) => String(Math.round(value * 10 ** yDigits) / 10 ** yDigits))
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
  const zoomed = yZoom !== null

  return (
    // `data-chart`：给护栏一个稳定锚点（仓库里 `data-latency` / `data-card-style` 同一套做法）。
    // 换实现（recharts → 自绘）时，按 `.recharts-surface` 那种类名找的判据会静默变成 0。
    /* `select-none`：拖动平移时浏览器会顺手起一个选区、把扫过的文字（右上那枚「重置」）划成
       蓝底（2026-10-15 与 kanso 同步）。图表这一块没有可选的正文，整块关掉最省事。 */
    <div ref={box} data-chart="" className="relative h-full w-full select-none">
      {w > 0 && h > 0 && (
        <svg width={w} height={h} role="img" aria-label={label} className="overflow-visible">
          {/* 绘图区的裁剪框：滚轮把量程缩窄后，超出范围的值不再画到轴外去（留一点溢出到
              tooltip / 刻度那一圈才要 `overflow-visible`，曲线本身必须夹在框里）。自动档
              本来就装得下，有它也不变样。折线 / 面积 / 区间三块共用这一条。 */}
          <defs>
            <clipPath id={cid}>
              <rect x={left} y={TOP} width={plotW} height={plotH} />
            </clipPath>
          </defs>
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
              y={Math.min(Math.max(y(v), TOP + 8), TOP + plotH - 8)}
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
          <g clipPath={`url(#${cid})`}>
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
          </g>
          {/* 悬停竖线（原来 `CURSOR` 那枚）。 */}
          {hovered && (
            <line x1={x(hovered.ts)} x2={x(hovered.ts)} y1={TOP} y2={TOP + plotH} className="stroke-border" strokeWidth={1} />
          )}
          {/* 命中层：整块绘图区接指针，按 x 找最近的那个点；`wheelZoom` 那档还能拖着线上下平移。 */}
          <rect
            x={left}
            y={TOP}
            width={plotW}
            height={plotH}
            fill="transparent"
            // `pan-y`：手机上竖着划仍然滚页面（平移是鼠标手势，触屏不抢）。光标用默认箭头。
            style={{ touchAction: "pan-y" }}
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
              if (!wheelZoom || e.button !== 0 || plotH <= 0) return
              // 捕获失败不该让整段拖动失效（指针已经消失、或合成事件没有有效 id 时会抛）。
              try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 无所谓 */ }
              // 基准取**当前显示中的**量程：没缩过就是自动档那一段（照样能拖，拖完即手动档）。
              panRef.current = { y0: e.clientY, lo: scale.lo, hi: scale.hi, moved: false }
            }}
            onPointerMove={(e) => {
              const st = panRef.current
              if (!st) return
              // 没按住左键却还挂在拖动里（捕获失败 + 松手落在图外那条路径）就当场清掉。
              if ((e.buttons & 1) === 0) { panRef.current = null; return }
              const dy = e.clientY - st.y0
              // 3px 死区：只是点一下不该把量程挪走。
              if (!st.moved && Math.abs(dy) < 3) return
              st.moved = true
              const span = st.hi - st.lo
              // 1px = span/plotH：像素位移原样换算成值位移 —— 线就钉在光标上跟着走。
              let shift = (dy / plotH) * span
              // 整段一起停（夹的是**位移**，不是各自收边）：下沿不越 0、顶端不越封顶。
              const cap = Math.max(zoomCapOf(autoExtent?.[1] ?? 0), st.hi)
              shift = Math.min(Math.max(shift, -st.lo), cap - st.hi)
              setYZoom({ lo: st.lo + shift, hi: st.hi + shift })
            }}
            onPointerCancel={() => {
              // ★触屏竖划时浏览器接管手势、对这层派发的是 pointercancel（不会再有 pointerup）：
              //   这里顺手把平移状态也清掉。
              panRef.current = null
            }}
            onPointerUp={() => {
              panRef.current = null
            }}
            onDoubleClick={() => {
              // 双击 = 复位：量程回到自动档，与那枚「重置」按钮同效。
              setYZoom(null)
            }}
          />
        </svg>
      )}
      {/* 缩放着的时候给一枚重置（滚轮纵缩 + 拖线平移都归位，双击图表同效）。 */}
      {zoomed && (
        <button
          type="button"
          onClick={() => setYZoom(null)}
          title="重置缩放（双击图表同效）"
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

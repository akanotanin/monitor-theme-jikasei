import { useEffect, useMemo, useState } from "react"

import { api, type Node } from "@/lib/api"
import { AUTO_MIN_SPAN_RATIO } from "@/components/Chart"

/** `/api/nodes/{id}/metrics?series=ping` 返回里，本组件用到的几块（形状同详情页）。 */
type PingPoint = {
  task_id: number
  ts: number
  latency: number | null
  band?: [number, number]
  loss?: number
}
type Probes = Record<string, string>
type Loss = Record<string, number>

type Probe = { id: number; name: string; points: PingPoint[]; loss: number }

/**
 * 每张卡片各要一条延迟历史，节点一多就是几十条并发。hub 建历史窗口是有并发上限的
 * （详情页那段注释写着它会把 agent 上报的那条连接占住），一次全打过去会换回一串 503。
 * 所以这里自己排个队：最多同时三条，其余排队等着，谁先下来谁放行下一个。
 */
const MAX_CONCURRENT = 3
let running = 0
const waiting: Array<() => void> = []
function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++
    return Promise.resolve()
  }
  return new Promise((resolve) => waiting.push(() => { running++; resolve() }))
}
function release() {
  running--
  waiting.shift()?.()
}

function normalize(d: { ping?: PingPoint[]; probes?: Probes; loss?: Loss }): Probe[] {
  const ping = d.ping ?? []
  const names = d.probes ?? {}
  const loss = d.loss ?? {}
  return [...new Set(ping.map((p) => p.task_id))]
    .map((id) => ({
      id,
      name: names[String(id)] ?? `探测 ${id}`,
      points: ping.filter((p) => p.task_id === id).sort((a, b) => a.ts - b.ts),
      loss: Number(loss[String(id)] ?? 0),
    }))
    .filter((p) => p.points.length > 0)
}

/**
 * 卡片的延迟数据多久算过期。页面上其余数字跟着 hub 的快照在跳，这一块要是只在挂载时
 * 取一次，访客开着页面看十几分钟仍是进页面那一刻的延迟。到点重新取一次，成本与首屏
 * 相同（仍走上面那个三条并发的队列）。
 */
const TTL = 60_000

/**
 * 拉本节点最近一小时的延迟：点数取 40，够画一条能看出起伏的走势线，又不至于让每张
 * 卡片多背一大坨。失败与「这段时间没有延迟数据」都收敛成空数组，卡片上什么都不画。
 *
 * 每 `TTL` 刷新一次；页面切到后台时不发（省掉访客看不见的流量），回到前台时若手上这份
 * 已经过期就补一次。同一时刻只允许一条在飞，避免慢请求叠着打。
 */
function useNodePing(id: number): Probe[] | null {
  const [probes, setProbes] = useState<Probe[] | null>(null)
  useEffect(() => {
    let alive = true
    let busy = false
    let fetchedAt = 0
    const load = () => {
      if (busy || Date.now() - fetchedAt < TTL) return
      busy = true
      fetchedAt = Date.now()
      acquire().then(() => {
        if (!alive) {
          busy = false
          release()
          return
        }
        api<{ ping?: PingPoint[]; probes?: Probes; loss?: Loss }>(
          `/nodes/${id}/metrics?hours=1&points=40&series=ping`,
        )
          .then((d) => { if (alive) setProbes(normalize(d)) })
          .catch(() => { if (alive) setProbes([]) })
          .finally(() => { busy = false; release() })
      })
    }
    const onVisible = () => { if (document.visibilityState === "visible") load() }
    load()
    const timer = window.setInterval(onVisible, TTL)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [id])
  return probes
}

// 延迟分档：顺畅 / 偏高 / 糟，三档都走灰阶——这一块不抢旁边网络数的颜色，只用深浅说话。
// 阈值取整百毫秒，跨海线路普遍在 150-200 之间，想改就改这两个数。丢包只要不为零，
// 至少抬到「偏高」；到 5% 直接算「糟」。
const GOOD_MS = 100
const WARN_MS = 200
type Tone = "ok" | "warn" | "bad" | "none"

function toneOf(ms: number | null, loss: number): Tone {
  if (ms === null) return "none"
  if (loss >= 5 || ms >= WARN_MS) return "bad"
  if (loss > 0 || ms >= GOOD_MS) return "warn"
  return "ok"
}

// 越糟越深：顺畅用弱化灰（和旁边的线路名同色，安静），偏高转深，糟用前景色顶格。
// 数值与走势线共用这一个灰阶，一条线越黑越该看一眼。
const toneClass = (tone: Tone) =>
  tone === "bad" ? "text-foreground"
    : tone === "warn" ? "text-foreground/70"
      : "text-muted-foreground"

const SPARK_W = 100
const SPARK_H = 20

/** 走势线：无坐标轴、无交互，只把这一小时的起伏画出来；断点照断，不连桥。
    ★w-full：svg 是替换元素，做 grid 项时默认的 stretch 不会把它撑满轨道（会停在
    viewBox 比例推出来的固有宽）——显式 width:100% 拿足整条轨道；flex 那处不受影响
    （flex-1 的 basis 是 0%，flex 布局主轴上宽度声明不参与定尺）。 */
function Sparkline({ values, className }: { values: Array<number | null>; className: string }) {
  const nums = values.filter((v): v is number => v !== null)
  if (nums.length < 2) return <span className="w-full min-w-0 flex-1" />
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  // 「最近视距」下限：与详情页自动量程共用一个常数（见 Chart.tsx）——窄量程不往死里放，
  // 拉到底限档时以中值为轴居中展开。
  const span = Math.max(max - min, Math.max(max, 1) * AUTO_MIN_SPAN_RATIO)
  const lo = (min + max) / 2 - span / 2
  const x = (i: number) => (values.length <= 1 ? 0 : (i * SPARK_W) / (values.length - 1))
  const y = (v: number) => SPARK_H - 2 - ((v - lo) / span) * (SPARK_H - 4)
  const segments: string[] = []
  let current: string[] = []
  values.forEach((v, i) => {
    if (v === null) {
      if (current.length) { segments.push(current.join(" ")); current = [] }
      return
    }
    current.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`)
  })
  if (current.length) segments.push(current.join(" "))
  return (
    <svg
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      className={`h-4 w-full min-w-0 flex-1 ${className}`}
      aria-hidden="true"
    >
      {segments.map((points, i) => (
        <polyline
          key={i}
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  )
}

/**
 * 卡面与浮层共用的一份行选择：站长在后台「三网延迟」里填了名字就按名字取、按填写的顺序，
 * 留空则按后台顺序自动取前三条；两处都卡在三条以内（与设置项里写的「最多三个」一致）。
 * 匹配用的是 ping 任务的名字，改过名、删过任务的那一行自然落空、不占位——三条的上限卡在
 * **真正渲染出来的行**上，所以先按名字取、再截断（反过来写的话，填写清单里前三个名字有一个
 * 对不上，访客就只看到两行，而设置项里明明写着三条）。
 */
function pickRows(probes: Probe[] | null, lines: string): Probe[] {
  const all = probes ?? []
  const wanted = [...new Set(lines.split("\n").map((s) => s.trim()).filter(Boolean))]
  if (wanted.length === 0) return all.slice(0, 3)
  const byName = new Map<string, Probe>()
  for (const p of all) if (!byName.has(p.name)) byName.set(p.name, p)
  return wanted
    .map((name) => byName.get(name))
    .filter((p): p is Probe => p !== undefined)
    .slice(0, 3)
}

/**
 * 卡片底部那组「三网延迟」：一条线路一行——线路名、当前延迟、一小时走势、丢包率。
 * 数据来自 hub 的 ping 历史（同详情页的延迟图），按 `task_id` 一条一条摊开；线路名用的是
 * 站长在后台给 ping 任务起的名字，所以「广东电信」这类带地域的叫法原样呈现。
 * 延迟与走势只走灰阶，越糟越深（见 toneClass）。站长可在后台「三网延迟」里指定显示哪几条
 * （按 ping 任务名匹配，一行一个，最多三条）；留空时按后台顺序自动取前三条。数据每 60 秒
 * 刷新一次（页面在后台时不取）。
 *
 * `onOpen` 给了就整块可点：点一行**直达详情页的「网络延迟」页签** —— 这一块显示的就是那张
 * 一小时的延迟图，想看更大更全的同款，点它比「先开详情、再找页签」少一步（2026-10-12 的
 * 创意项）。行 hover 时线路名从弱化灰提亮，作为「这里能点」的提示（与整卡可点不冲突：
 * 行级点击先 `stopPropagation`，否则会走整卡那条「默认页签」的路）。
 */
export function LatencyPanel({ node, lines, onOpen, adaptive = false }: { node: Node; lines: string; onOpen?: () => void; adaptive?: boolean }) {
  const probes = useNodePing(node.id)
  const rows = useMemo(() => pickRows(probes, lines), [probes, lines])
  if (rows.length === 0) return null
  // ★版式分档（站长 2026-10-15 定的口径，别再合并成一套）：
  //  · **延迟档（adaptive）**：2026-10-14 论坛反馈的 C 稿——名字/数值列按内容自适应，上限沿用
  //    旧口径（名字最宽 80px、超了截断 + title 悬停看全；丢包列仍固定 40px 右对齐）。行是
  //    subgrid：列宽在本容器（`[data-latency]`）内**整块共享**，短名字贴身、三行仍逐列对齐。
  //  · **详细档（不带 adaptive）**：保持固定列原样（名字 80 + 数值 56 右对齐 + 丢包 40），
  //    逐字未动——站长要详细卡维持原表格感。
  // 逐宽判据：tools/verify_latency_row_fit.mjs。
  return (
    // `data-latency` 是给护栏认「这一档摊没摊三网延迟」的锚点（`data-net` 同一套做法：
    // 按类名找会在改版后失配，而失配的表现是"看着没坏"）。
    <div
      data-latency=""
      className={adaptive
        ? "mt-4 grid grid-cols-[max-content_max-content_minmax(0,1fr)_2.5rem] items-center gap-x-2 gap-y-1.5 border-t pt-4"
        : "mt-4 space-y-1.5 border-t pt-4"}
    >
      {rows.map((p) => {
        const last = [...p.points].reverse().find((pt) => pt.latency !== null)
        const ms = last?.latency ?? null
        const tone = toneOf(ms, p.loss)
        const gray = toneClass(tone)
        return (
          <div
            key={p.id}
            className={adaptive
              ? `group col-span-4 grid grid-cols-subgrid items-center gap-x-2 text-xs ${onOpen ? "cursor-pointer" : ""}`
              : `group flex items-center gap-2 text-xs ${onOpen ? "cursor-pointer" : ""}`}
            onClick={onOpen ? (e) => { e.stopPropagation(); onOpen() } : undefined}
            title={onOpen ? "打开详情 · 网络延迟" : undefined}
          >
            {/* 线路名列：自适应档按内容收缩（上限 80px = 老固定列宽，超长截断 + title 悬停看全）；
                详细档保持 80px 固定列。可点时 hover 提亮，作为「行能点」的低调提示。 */}
            <span data-probe-name="" className={`${adaptive ? "max-w-20" : "w-20 shrink-0"} truncate text-muted-foreground ${onOpen ? "transition-colors group-hover:text-foreground" : ""}`} title={p.name}>{p.name}</span>
            <span className={adaptive ? `tnum text-right font-medium ${gray}` : `tnum w-14 shrink-0 text-right font-medium ${gray}`}>
              {ms === null ? "超时" : `${ms} ms`}
            </span>
            <Sparkline values={p.points.map((pt) => pt.latency)} className={gray} />
            <span className={adaptive ? "tnum text-right text-muted-foreground" : "tnum w-10 shrink-0 text-right text-muted-foreground"}>
              {p.loss > 0 ? `${p.loss.toFixed(1)}%` : "0.0%"}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * 经典档浮层底部那三网延迟：一条线路一行——线路名、当前延迟、一小时走势、丢包率，
 * 与「延迟」档卡面同一套（同一个 `useNodePing`、同一套灰阶与走势线）。
 *
 * 两条口径：
 * ① **只有浮层打开时才会挂载**（调用处写在 `peekOpen` 里）⇒ 经典档默认一个 ping 请求都不发，
 *    点开哪台才取哪台；取不到、或这台没有延迟数据就整块不渲染（连分隔线一起没有）。
 * ② 行选择与卡面共用 `pickRows`：站长在后台「三网延迟」里指定、最多三条，留空取前三条。
 *
 * 这一块自带顶部分隔线（`border-t`）——它排在「到期」下面，靠这条线把「计费那几行」与
 * 「现在通不通」分开；没有数据时整块不渲染，所以也不会留下一条孤零零的线。
 */
export function PeekLatency({ node, lines, onOpen }: { node: Node; lines: string; onOpen?: () => void }) {
  const probes = useNodePing(node.id)
  const rows = useMemo(() => pickRows(probes, lines), [probes, lines])
  if (rows.length === 0) return null
  // ★版式（站长 2026-10-15：浮层跟「延迟」档一样走自适应）：名字/数值列按内容自适应、
  // 上限沿用旧列宽（名字 72px、丢包列 36px 固定）；行是 subgrid，列宽整块共享——
  // 短名字贴身、多行仍逐列对齐。
  return (
    <span data-peek-latency="" className="grid grid-cols-[max-content_max-content_minmax(0,1fr)_2.25rem] items-center gap-x-2 gap-y-1 border-t pt-2">
      {rows.map((p) => {
        // 最新一个非空样本 = 浮层里那个数字（与卡面同一口径：ping 每 60 秒一跳）。
        const ms = [...p.points].reverse().find((pt) => pt.latency !== null)?.latency ?? null
        const gray = toneClass(toneOf(ms, p.loss))
        return (
          <span
            key={p.id}
            className={`group col-span-4 grid grid-cols-subgrid items-center gap-x-2 ${onOpen ? "cursor-pointer" : ""}`}
            onClick={onOpen ? (e) => { e.stopPropagation(); onOpen() } : undefined}
            title={onOpen ? "打开详情 · 网络延迟" : undefined}
          >
            {/* 名字列按内容收缩（上限 72px = 老固定列宽；超长的名字靠 title 悬停看全。
                与卡面同一套 onOpen 行为：点一行直达详情的「网络延迟」页签）。 */}
            <span data-probe-name="" className={`max-w-[4.5rem] truncate text-muted-foreground ${onOpen ? "transition-colors group-hover:text-foreground" : ""}`} title={p.name}>{p.name}</span>
            <span className={`tnum text-right font-medium ${gray}`}>
              {ms === null ? "超时" : `${ms} ms`}
            </span>
            <Sparkline values={p.points.map((pt) => pt.latency)} className={gray} />
            <span className="tnum text-right text-muted-foreground">
              {p.loss > 0 ? `${p.loss.toFixed(1)}%` : "0.0%"}
            </span>
          </span>
        )
      })}
    </span>
  )
}

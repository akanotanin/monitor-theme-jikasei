import { useEffect, useMemo, useRef, useState } from "react"
import {
  Area, AreaChart, Brush, CartesianGrid, ComposedChart, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts"

import { Info, Lock } from "lucide-react"

import { ChartTooltip, PingTooltip } from "@/components/ChartTooltip"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Country, deployed } from "@/components/NodeCard"
import { api, type Node } from "@/lib/api"
import {
  axisBytes, axisTop, bytes, clockFor, despike, quarters, cpuName, osName, rate, timeTicks, uptime,
} from "@/lib/format"
import { hubTags, privateRemark } from "@/lib/notes"
import { rangesFor } from "@/lib/ranges"

type Point = {
  ts: number
  cpu: number
  mem_used: number
  disk_used: number
  net_rx: number
  net_tx: number
}
// `latency` is the bucket's median round trip, null when every probe in it timed
// out. `band` is the range its answers spanned, absent when they spanned nothing.
// `loss` is the percentage that timed out, absent when none did.
type PingPoint = {
  task_id: number
  ts: number
  latency: number | null
  band?: [number, number]
  loss?: number
}
/** Probe names by id, sent alongside the samples they label. */
type Probes = Record<string, string>
/**
 * Proportion of the whole window each probe lost, by id, absent for probes that
 * lost nothing. Sent because it cannot be derived here: every bucket's `loss` is
 * already a percentage of that bucket, so the sample counts it was divided by are
 * unavailable. Averaging them would weight a bucket holding one sample equally
 * with one holding twelve, and the window's first and last buckets are partial
 * regardless of what the probe does.
 */
type Loss = Record<string, number>

// 时间范围那排按钮由 hub 的保留天数生成（见 @/lib/ranges）：hub 1.3.2 起 `hours` 的上限就是
// 保留天数本身（登录与匿名相同），1.15.x 那排写死的 1/6/24 小时 + 7 天只对老 hub 成立。
// 两个页签共用同一组窗口——延迟页签原先停在上面的 24 小时，理由是「一周宽的桶会把抖动与丢包
// 摊平」；但那是替访客做判断：想看一周走势的人只能在资源页签里看，而延迟恰恰是资源页签给不了的
// 那条。窗口拉长不会让点数变多，hub 只会把桶放得更宽（168 小时 ≈ 9 分钟一桶，30 天以上走
// 小时汇总），所以更长的探测史仍画得下、也仍看得见趋势。
const AXIS = { stroke: "currentColor", fontSize: 11, tickLine: false, axisLine: false }

// No grow-in animation: it would spend 1.5 s drawing a line across the panel on
// every range change, on a page meant to be read at a glance, and on the latency
// chart across seven hundred points per probe.
const SERIES = { dot: false as const, strokeWidth: 1.5, isAnimationActive: false }

// One width for every stacked panel's value axis. Sized to their own labels --
// 40px under "100%", 68px under "172 MB" -- the four plot areas would be offset by
// 28px, placing a CPU spike and the network spike that caused it at different x.
const Y_WIDTH = 68

// 延迟图最多同时画四条线路，所以这里备九个色相、每个再配一版短虚线：前九条走实线，
// 第十条起色相重复、换线型。色相表是 index.css 里的 --chart-1..9，深浅两套只差亮度，
// 同一台机器在两种主题下是同一种颜色。
const COLORS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `var(--chart-${n})`)
const PALETTE = [
  ...COLORS.map((stroke) => ({ stroke, dash: undefined })),
  ...COLORS.map((stroke) => ({ stroke, dash: "6 3" })),
]

// 四张资源图共用一枚光标线与一个提升的层级：recharts 把 tooltip 画在图表容器内部，
// 不给 z-index 就会被下一块面板压住半截。
const CURSOR = { stroke: "var(--border)" }
const TOOLTIP_BOX = { zIndex: 30 }

const TABS = [
  { key: "resources", label: "资源" },
  { key: "latency", label: "网络延迟" },
] as const

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-2 text-xs font-medium text-muted-foreground">{title}</h4>
      <div className="h-40 w-full text-muted-foreground">{children}</div>
    </div>
  )
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
      }`}
    >
      {children}
    </button>
  )
}

/**
 * How many samples of a probe's own series make up seven minutes of neighbours.
 *
 * The window the filter judges against has to be a duration, not a count: the
 * hub buckets a window to the `points` asked for below, so the same day arrives
 * as one-minute buckets on a desktop and two-minute ones on a phone, and a fixed
 * count would clip a five-minute stall on the first while keeping it on the
 * second. The smallest gap is the bucket interval; a longer one is the node
 * being offline. Odd, so the window has a middle, and bounded so a sparse probe
 * still has neighbours and a dense one does not pay for a wide sort.
 */
function despikeWindow(points: { ts: number }[]): number {
  let step = Infinity
  for (let i = 1; i < points.length; i++) step = Math.min(step, points[i].ts - points[i - 1].ts)
  return Math.min(15, Math.max(3, Math.round(420 / step) | 1))
}

/**
 * 在线时间：与卡片上原先那枚状态徽章同一个时长，只是搬进信息项里——徽章占的是
 * 标题行，而标题行在手机上本来就窄。没接入（探针从没上报过）与离线是两回事：
 * 前者没有时长可言，后者写清楚已经离线多久（不足一分钟就不报数）。
 */
function onlineFor(node: Node) {
  if (node.online) return node.metrics ? uptime(node.metrics.uptime) : "—"
  if (!deployed(node)) return "未接入"
  const down = node.last_seen ? Date.now() / 1000 - node.last_seen : 0
  return down >= 60 ? `离线 ${uptime(down)}` : "离线"
}

function Fact({ label, value }: { label: string; value?: string | number | null }) {
  if (value === null || value === undefined || value === "") return null
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm">{value}</dd>
    </div>
  )
}

export function NodeDetail({ node, embedded = false, onOpenDetail, historyDays }: {
  node: Node
  /** 紧凑形态点开一行时的就地渲染：省掉身份行与规格，直接落在延迟上，高度写死。 */
  embedded?: boolean
  /** 就地展开时通往整页详情的口子。不传就不画那个链接。 */
  onOpenDetail?: () => void
  /** hub 的历史保留天数（`/api/me` 的 `history_days`）；老 hub 不给，按 7 天算（见 @/lib/ranges）。 */
  historyDays?: number
}) {
  // 这台机器的公开备注（见 @/lib/notes）：hub 后台按节点填的那条，逗号分隔＝多枚小卡片。
  // ★**公开**备注在整页详情上不摊（站长 2026-10-03 定的）：这一页只留规格与图表，公开备注在列表
  // 卡片上（经典/延迟收在右上角浮层里、详细挂标题行右端）与「紧凑」展开行那格看。
  // 下面那枚控件与备注条都只在 embedded（紧凑展开）时才出现；私有备注见再下面那个块。
  const noteTags = hubTags(node)
  // 私有备注（hub 后台那个「仅管理员可见」的字段）：hub 只在登录态下发，匿名访客拿不到这个键。
  const privateNote = privateRemark(node)
  const [peekOpen, setPeekOpen] = useState(false)
  const peekRef = useRef<HTMLSpanElement | null>(null)
  // 摊开时点别处 / Esc 收起（与「延迟」档那枚同一个做法）。
  useEffect(() => {
    if (!peekOpen) return
    const onDown = (e: PointerEvent) => {
      const el = e.target
      if (!(el instanceof HTMLElement) || !peekRef.current?.contains(el)) setPeekOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPeekOpen(false) }
    document.addEventListener("pointerdown", onDown)
    document.addEventListener("keydown", onKey)
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey) }
  }, [peekOpen])
  // 就地展开只讲延迟（那一格点开就是为了看延迟），所以页签默认落在延迟而不是资源。
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>(embedded ? "latency" : "resources")
  // Each tab keeps its own range: a 7-day trend and a 1-hour trace answer
  // different questions.
  const [ranges, setRanges] = useState({ resources: 6, latency: 6 })
  // 可选窗口按保留天数生成（老 hub 按 7 天，结果与 1.15.x 那排逐字相同）。
  const RANGES = rangesFor(historyDays)
  const RANGES_FOR = { resources: RANGES, latency: RANGES }
  const hours = ranges[tab]
  const [smooth, setSmooth] = useState(false)
  // Probes switched off. Hiding a slow one is what makes the fast ones readable,
  // as the axis rescales to what remains.
  const [hiddenProbes, setHiddenProbes] = useState<number[]>([])
  const [data, setData] = useState<{ metrics: Point[]; ping: PingPoint[]; probes: Probes; loss?: Loss } | null>(null)
  // Retained rather than folded into an empty result: a refused request and an
  // empty window are different answers, and the hub has reason to refuse this one
  // -- it caps how many history windows it builds concurrently, since each holds
  // the connection the agents report through. Rendered as an empty window, a 503
  // would misdirect the reader.
  const [failed, setFailed] = useState("")
  // Where the brush has been dragged, so the axis reticks for the visible span
  // rather than retaining the whole window's ticks.
  const [zoom, setZoom] = useState<[number, number] | null>(null)
  // Where the chart begins on screen, so its height can occupy the remainder.
  const [chartTop, setChartTop] = useState(0)

  useEffect(() => {
    let active = true
    // The charts must not continue drawing the old range while the new one is in
    // flight.
    // oxlint-disable-next-line react/set-state-in-effect
    setData(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setZoom(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setFailed("")
    // What this screen can resolve, in device pixels, which is the unit the line
    // is drawn in: a 1280-wide retina panel has 2560 of them for a day of minutes.
    // Read here rather than from a ref, since the hub only thins further, an
    // approximate figure suffices, and the viewport is known before layout. A
    // rotation keeps whatever it fetched with.
    //
    // The tab determines which half is requested; the other accounted for a third
    // to two thirds of every response and was never drawn.
    const points = Math.round(globalThis.innerWidth * (globalThis.devicePixelRatio || 1))
    const series = tab === "latency" ? "ping" : "metrics"
    api<{ metrics: Point[]; ping: PingPoint[]; probes: Probes; loss?: Loss }>(
      `/nodes/${node.id}/metrics?hours=${hours}&points=${points}&series=${series}`,
    )
      .then((next) => { if (active) setData(next) })
      .catch((e: Error) => {
        // `|| "..."` as in App.tsx: HTTP/2 dropped statusText, so a bodiless
        // failure from a proxy arrives as the empty string and renders as no
        // error.
        if (active) { setFailed(e.message || "网络错误"); setData({ metrics: [], ping: [], probes: {} }) }
      })
    return () => { active = false }
  }, [node.id, hours, tab])

  const m = node.metrics
  // One series per probe that reported, labelled from the names the samples
  // arrived with. Memoised, as are the two below: the node prop changes every few
  // seconds as live metrics arrive, and rebuilding the chart's data array on those
  // renders would reset the brush.
  const pingSeries = useMemo(
    () =>
      [...new Set((data?.ping ?? []).map((p) => p.task_id))]
        .map((id) => {
          // Timeouts are retained: dropping them would draw a probe losing half
          // its packets as an unbroken line, and one that never answered not at
          // all.
          const points = (data?.ping ?? []).filter((p) => p.task_id === id)
          // Taken from the hub rather than summed from the buckets above, each of
          // which is already a percentage of its own bucket, so averaging them
          // would report one lost round in thirteen as 50%. Left unrounded, since
          // `Math.round` would render 0.28% and 0.00% as the same badge, and the
          // absence of a badge denotes no loss.
          const loss = data?.loss?.[id] ?? 0
          return { id, name: data?.probes?.[id] ?? `探测 ${id}`, points, loss }
        })
        .filter((s) => s.points.length > 0),
    [data],
  )

  // The hub answers in seconds; the time axis requires milliseconds.
  const metricRows = useMemo(
    () => (data?.metrics ?? []).map((m) => ({ ...m, ts: m.ts * 1_000 })),
    [data],
  )

  // Axis tops for the two panels with no capacity to measure against. CPU and a
  // transfer rate do not express fullness: against a fixed 0-100, a machine
  // sitting at 0.4% draws as a line along the panel's floor. Memory and disk keep
  // their totals as tops, where fullness is the entire question.
  const tops = useMemo(() => {
    const max = (pick: (m: Point) => number) =>
      metricRows.reduce((hi, m) => Math.max(hi, pick(m)), 0)
    return {
      // A floor of 4%, or a machine that never exceeds 0.4% would get an axis of
      // 0-0.4 and render every scheduler blip as a peak. Capped at 100.
      cpu: axisTop(max((m) => m.cpu), 4, 10, 100),
      // Base 1024, so the steps are round in the unit `axisBytes` prints.
      rate: axisTop(max((m) => Math.max(m.net_rx, m.net_tx)), 1024, 1024),
    }
  }, [metricRows])

  const shownProbes = useMemo(
    () => pingSeries.filter((s) => !hiddenProbes.includes(s.id)),
    [pingSeries, hiddenProbes],
  )
  // Keyed on the full list, so a line keeps its shade when others are hidden.
  const style = (id: number) => PALETTE[pingSeries.findIndex((p) => p.id === id) % PALETTE.length]

  // The hub stamps every sample with its bucket rather than the second the probe
  // finished, so probes reporting at the bucket's rate share rows instead of each
  // contributing its own: a day of four probes is 717 rows rather than 2,868. A
  // slower probe leaves gaps in its own column, which is what `connectNulls`
  // addresses.
  //
  // Every probe and both versions of every sample are held here whether or not
  // they are on screen: recharts resets the brush when the data array changes
  // identity, and re-reads a controlled selection only when the index props
  // change, which they do not. Hiding a probe or enabling despiking therefore
  // selects a `dataKey` rather than rebuilding the array.
  const pingRows = useMemo(() => {
    const rows = new Map<
      number,
      { ts: number } & Record<string, number | [number, number] | null>
    >()
    for (const s of pingSeries) {
      const windowSize = despikeWindow(s.points)
      const smoothed = despike(s.points.map((p) => p.latency), windowSize)
      // The band spans the same outliers as the line, and with one probe on
      // screen it is what the axis is fitted to, so it is clipped alongside it
      // rather than left to pull the axis back open. The latency fills the
      // buckets that carry no band, keeping each filter's window dense.
      const lo = despike(s.points.map((p) => p.band?.[0] ?? p.latency), windowSize)
      const hi = despike(s.points.map((p) => p.band?.[1] ?? p.latency), windowSize)
      s.points.forEach((p, i) => {
        const row = rows.get(p.ts) ?? { ts: p.ts * 1_000 }
        row[`t${s.id}`] = p.latency
        row[`s${s.id}`] = smoothed[i]
        row[`l${s.id}`] = p.loss ?? 0
        // A bucket with a single answer carries no band and spans only that
        // answer. Left null, `connectNulls` would bridge the hours between the
        // few buckets that have one: 2 to 10 of 1,440 in a day, the widest gap
        // 803 minutes, drawn as one large wedge.
        row[`b${s.id}`] = p.band ?? (p.latency === null ? null : [p.latency, p.latency])
        // Taken as the span of three filtered series rather than a pair: the two
        // edges are filtered independently, so a bucket that answered slightly
        // faster than usual can trip the low edge alone and come back above the
        // high one -- [180, 178] against a line of 176, drawn backwards with the
        // line outside it.
        const [low, high] = [lo[i], hi[i]]
        row[`c${s.id}`] =
          low === null || high === null
            ? null
            : [Math.min(low, high, smoothed[i] ?? low), Math.max(low, high, smoothed[i] ?? high)]
        rows.set(p.ts, row)
      })
    }
    return [...rows.values()].sort((a, b) => a.ts - b.ts)
  }, [pingSeries])

  // 延迟 tooltip 要按时间戳回查整行：recharts 只把光标下那几条曲线交给它，而丢包率
  // 挂在同一行的另一列上（`l<id>`），得连行一起拿到。
  const rowByTs = useMemo(() => new Map(pingRows.map((row) => [row.ts, row])), [pingRows])

  // A real time axis rather than the category axis recharts defaults to: on a
  // category axis ticks are selected by index, so a period the agent was offline
  // for collapses to nothing.
  const timeAxis = (rows: { ts: number }[], from = 0, to = rows.length - 1) => ({
    dataKey: "ts",
    type: "number" as const,
    domain: ["dataMin", "dataMax"] as const,
    // Explicit, or recharts places them at 05:14 and 10:22. Any that still collide
    // are dropped by `minTickGap`.
    ticks: rows.length ? timeTicks(rows[from].ts, rows[to].ts) : undefined,
    tickFormatter: clockFor(hours),
    minTickGap: hours > 24 ? 72 : 40,
    ...AXIS,
  })

  return (
    <div className="space-y-4">
      {/* 就地展开（紧凑形态点开一行）时不重复这台机器的身份行、规格与备注：那一行在表格里
          已经报过名字，规格留给整页详情，这里只留延迟本身。 */}
      {!embedded && (
      <>
      {/* 旗子在前、名字在后，与卡片上的次序一致。状态徽章与 agent 版本不在这行：
          在线时长已经并进下面的信息项，agent 版本对访客没有意义。 */}
      <div className="flex items-center gap-2">
        <Country node={node} />
        <h2 className="truncate text-lg font-medium">{node.name}</h2>
      </div>

      {/* One flat row of facts: what is left after the traffic figures moved
          out is one machine's spec sheet, and a box around a single topic is
          just a box. Three across at lg, two at md, one on a phone -- a kernel
          version or a CPU model needs about 270px to stay whole. */}
      <dl className="grid gap-x-6 gap-y-3 md:grid-cols-2 lg:grid-cols-3">
        <Fact label="系统" value={[osName(node.os), node.kernel].filter(Boolean).join(" · ")} />
        <Fact
          label="CPU"
          value={node.cpu_name ? `${cpuName(node.cpu_name)} × ${node.cpu_cores}` : `${node.cpu_cores} 核`}
        />
        <Fact label="内存 / 硬盘" value={`${bytes(node.mem_total)} / ${bytes(node.disk_total)}`} />
        <Fact
          label="架构"
          value={[node.arch, node.virt !== "none" ? node.virt : "", m ? `${m.procs} 进程` : ""]
            .filter(Boolean)
            .join(" · ")}
        />
        <Fact label="今日流量" value={`↓ ${bytes(node.day_rx)} · ↑ ${bytes(node.day_tx)}`} />
        {/* 最后一格是「在线时间」：取代原先标题行上那枚状态徽章。它顶掉的是「续费」
            那一格——公开页的访客关心这台机器还活着多久，价格与到期在后台看。 */}
        <Fact label="在线时间" value={onlineFor(node)} />
      </dl>

      {/* 私有备注（hub 后台那个「仅管理员可见」的字段，只在登录态下发）：**整段展示**（探针原本的
          设定）——`whitespace-pre-wrap` 保留站长自己分好的换行，不做逗号拆分（逗号＝多枚是**公开**
          备注的写法）。顶部一行「私有备注 · 仅自己可见」标记：一眼分清它不是公开备注（访客看不到
          这个字段，所以这一块只有站长自己看得到）。
          ★容器用 `bg-card border` 而不是 `bg-muted`：页面底是 `background`（0.985），块底用 `card`
          （1.0）再加 1px 描边才立得住；护栏里有一条按**像素距离**断「块底色 ≠ 页面底色」+「有 1px
          描边」，别再改回无边界的一块浅灰。没写时一个像素都不占。 */}
      {privateNote !== "" && (
        <div data-private-remark className="space-y-1 rounded-md border border-border bg-card px-3 py-2">
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Lock className="size-3" />私有备注 · 仅自己可见
          </div>
          <p className="text-sm whitespace-pre-wrap">{privateNote}</p>
        </div>
      )}
      </>
      )}

      <div className={embedded ? "space-y-2" : "space-y-2 border-t pt-4"}>
        {!embedded && (
        <div className="flex gap-1">
          {TABS.map((t) => (
            <Tab key={t.key} active={tab === t.key} onClick={() => setTab(t.key)}>
              {t.label}
            </Tab>
          ))}
        </div>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex gap-1">
            {RANGES_FOR[tab].map((r) => (
              <Tab
                key={r.hours}
                active={hours === r.hours}
                onClick={() => setRanges((all) => ({ ...all, [tab]: r.hours }))}
              >
                {r.label}
              </Tab>
            ))}
          </div>
          {tab === "latency" && (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={smooth}
                onChange={(e) => setSmooth(e.target.checked)}
                className="accent-foreground"
              />
              削峰
            </label>
          )}
          {/* 公开备注在这一行右端：桌面（≥sm）**直接并排**在「完整详情 ›」左边（不新增行高），
              手机这一行放不下，收成一枚小图标 + 浮层（点开看全，点别处 / Esc 收起）。
              一枚备注一枚小卡片（逗号分隔的多枚就排成多枚）。
              宽度上限用固定 px（内容尺寸容器里百分比会被解析成很小的值）。没写备注时这一行与从前
              逐像素相同。
              ★只有「紧凑」就地展开（embedded）才需要这条入口：整页详情不摊**公开**备注（见上面那段），
              所以那一页的量程栏右边不再挂图标，免得同一句话出现两遍。 */}
          {embedded && (noteTags.length > 0 || onOpenDetail) && (
            <span className="ml-auto flex min-w-0 items-center gap-x-4 gap-y-1">
              {noteTags.length > 0 && (
                <>
                  <span data-note-strip className="hidden min-w-0 max-w-[14rem] items-center gap-1 overflow-hidden sm:flex">
                    {noteTags.map((tag, i) => (
                      <Badge key={`${i}-${tag}`} variant="secondary" className="min-w-0 max-w-full shrink font-normal" title={tag}>
                        <span className="min-w-0 truncate">{tag}</span>
                      </Badge>
                    ))}
                  </span>
                  <span
                    ref={peekRef}
                    className="relative inline-flex items-center sm:hidden"
                    onPointerEnter={() => setPeekOpen(true)}
                    onPointerLeave={() => setPeekOpen(false)}
                  >
                    <button
                      data-note-popover
                      aria-expanded={peekOpen}
                      aria-label={`公开备注：${noteTags.join("、")}`}
                      onClick={(e) => {
                        // 这一块本身在展开行里，点它不该连带开合那一行。
                        e.stopPropagation()
                        setPeekOpen((open) => !open)
                      }}
                      // 只拦「激活键」的冒泡（别让 Enter 顺带开合这一行、跳详情页）；Esc 必须放它上去。
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") e.stopPropagation() }}
                      className="inline-flex text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <Info className="size-3.5" />
                    </button>
                    {peekOpen && (
                      <span
                        data-note-panel
                        role="tooltip"
                        className="absolute top-5 right-0 z-20 flex w-max max-w-[16rem] flex-wrap gap-1 rounded-md border bg-card px-2 py-1.5 shadow-md"
                      >
                        {noteTags.map((tag, i) => (
                          <Badge key={`${i}-${tag}`} variant="secondary" className="min-w-0 max-w-full shrink font-normal" title={tag}>
                            <span className="min-w-0 truncate">{tag}</span>
                          </Badge>
                        ))}
                      </span>
                    )}
                  </span>
                </>
              )}
              {onOpenDetail && (
                <button onClick={onOpenDetail} className="text-xs text-muted-foreground transition-colors hover:text-foreground">
                  完整详情 ›
                </button>
              )}
            </span>
          )}
        </div>
      </div>

      {!data ? (
        <Skeleton className="h-40 w-full" />
      ) : failed ? (
        <p className="py-8 text-center text-sm text-destructive" role="alert">读取历史数据失败：{failed}</p>
      ) : tab === "latency" ? (
        pingSeries.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">这段时间没有延迟数据</p>
        ) : (
          // An explicit pixel height on the column, so the chart can be `flex-1`
          // within it while the legend takes what it needs: four probes are one row
          // of chips on a desktop and two on a phone, so any fixed reservation is
          // wrong on one of them.
          <div
            // `+ scrollY`, because getBoundingClientRect is measured from the
            // viewport and this callback runs on every render; a live node
            // re-renders every two seconds, so a scrolled page would re-derive the
            // height from a top that has moved.
            ref={(el) => {
              // 就地展开时高度写死，不再按视口撑满：它下面还压着别的行。
              if (el && !embedded) setChartTop(el.getBoundingClientRect().top + scrollY)
            }}
            style={
              !embedded && chartTop
                ? { height: `calc(100svh - ${Math.round(chartTop)}px - 1rem)` }
                : undefined
            }
            className={embedded ? "flex h-72 flex-col gap-3" : "flex min-h-72 flex-col gap-3"}>
            {/* `min-h-0` is what makes `flex-1` a real number rather than the
                content's own height: ResponsiveContainer reads its parent, and
                a flex child not told it may shrink reports whatever the SVG
                last was. The column above has a height in pixels, so this
                resolves at layout instead of coming back 0. */}
            <div className="min-h-0 w-full flex-1 text-muted-foreground">
              {shownProbes.length === 0 ? (
                <p className="py-8 text-center text-sm">没有选中任何探测</p>
              ) : (
                <ResponsiveContainer>
                  <ComposedChart data={pingRows}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                    <XAxis
                      {...timeAxis(
                        pingRows,
                        Math.min(zoom?.[0] ?? 0, pingRows.length - 1),
                        Math.min(zoom?.[1] ?? pingRows.length - 1, pingRows.length - 1),
                      )}
                    />
                    {/* Not anchored at zero: these lines live in a narrow band
                        far from it, and zero flattens every wobble. */}
                    <YAxis unit="ms" width={52} domain={["auto", "auto"]} {...AXIS} />
                    {/* 延迟图自己画 tooltip：四条线路叠在一起时，默认那枚只会说
                        「名字 + 值」，看不出谁最慢、谁在丢包。最慢的排最前，超时的标
                        「无响应」，有丢包的缀一段丢包率。 */}
                    <Tooltip
                      content={
                        <PingTooltip
                          rowByTs={rowByTs}
                          probes={shownProbes}
                          smooth={smooth}
                          style={style}
                        />
                      }
                      cursor={CURSOR}
                      wrapperStyle={TOOLTIP_BOX}
                    />
                    {/* Behind the line, the range that bucket's answers
                        spanned -- Smokeping's "smoke". At the day window a
                        bucket moves 63 ms at the 90th percentile against the
                        25 ms the trend moves, so a line alone draws the smaller
                        of the two.

                        Only with one probe on screen: rendered for four, the
                        bands overlap into a fog and their extremes drag the
                        axis from 165-385 out to 140-420. */}
                    {shownProbes.length === 1 &&
                      shownProbes.map((s) => (
                        <Area
                          key={`band${s.id}`}
                          dataKey={`${smooth ? "c" : "b"}${s.id}`}
                          stroke="none"
                          fill={style(s.id).stroke}
                          fillOpacity={0.16}
                          isAnimationActive={false}
                          tooltipType="none"
                          legendType="none"
                          connectNulls
                        />
                      ))}
                    {shownProbes.map((s) => (
                      <Line
                        key={s.id}
                        dataKey={`${smooth ? "s" : "t"}${s.id}`}
                        name={s.name}
                        stroke={style(s.id).stroke}
                        strokeDasharray={style(s.id).dash}
                        {...SERIES}
                        connectNulls
                      />
                    ))}
                    {/* Drag either handle to zoom into a stretch of the trend. */}
                    <Brush
                      dataKey="ts"
                      height={22}
                      travellerWidth={8}
                      tickFormatter={clockFor(hours)}
                      className="fill-muted"
                      stroke="var(--color-muted-foreground)"
                      onChange={(r) => setZoom([r.startIndex ?? 0, r.endIndex ?? pingRows.length - 1])}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Under the chart: what it covers is picked at the top, what is
                drawn in it is picked here. Recharts paints the brush into the
                same SVG as the axis, so this is as close beneath as HTML
                sits. */}
            {(pingSeries.length > 1 || pingSeries.some((s) => s.loss > 0)) && (
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              {pingSeries.map((s) => {
                const shown = !hiddenProbes.includes(s.id)
                return (
                  <button
                    key={s.id}
                    onClick={() =>
                      setHiddenProbes((h) => (shown ? [...h, s.id] : h.filter((id) => id !== s.id)))
                    }
                    className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-opacity ${
                      shown ? "" : "opacity-40"
                    }`}
                  >
                    {/* The swatch carries the same shade and dash as the line. */}
                    <svg width="14" height="6" className="shrink-0" aria-hidden>
                      <line
                        x1="0"
                        y1="3"
                        x2="14"
                        y2="3"
                        stroke={style(s.id).stroke}
                        strokeDasharray={style(s.id).dash}
                        strokeWidth="2"
                      />
                    </svg>
                    {s.name}
                    {/* The line is only what answered, so a probe dropping
                        half its packets draws like a healthy one. */}
                    {s.loss > 0 && (
                      <span className="tabular-nums opacity-60">
                        丢 {s.loss < 1 ? "<1" : Math.round(s.loss)}%
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
            )}
          </div>
        )
      ) : data.metrics.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">这段时间没有历史数据</p>
      ) : (
        <div className="space-y-5">
          <Panel title="CPU">
            <ResponsiveContainer>
              <AreaChart data={metricRows}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis {...timeAxis(metricRows)} />
                <YAxis domain={[0, tops.cpu]} ticks={quarters(tops.cpu)} unit="%" width={Y_WIDTH} {...AXIS} />
                <Tooltip
                  content={<ChartTooltip format={(v) => `${v.toFixed(1)}%`} />}
                  cursor={CURSOR}
                  wrapperStyle={TOOLTIP_BOX}
                />
                <Area dataKey="cpu" name="CPU" stroke="var(--chart-1)" fill="var(--chart-1)" fillOpacity={0.15} {...SERIES} />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>

          {/* The axis top is the machine's memory, so the line's height is the
              fraction in use whatever range is picked. Tracking the window's
              own maximum, which is what an area chart does by default, puts
              127 MB of a 457 MB box at the top of the panel. The size is in the
              title because the axis top is claiming it. */}
          <Panel title={`内存 · ${bytes(node.mem_total)}`}>
            <ResponsiveContainer>
              <AreaChart data={metricRows}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis {...timeAxis(metricRows)} />
                <YAxis domain={[0, node.mem_total]} ticks={quarters(node.mem_total)} tickFormatter={axisBytes} width={Y_WIDTH} {...AXIS} />
                <Tooltip
                  content={<ChartTooltip format={(v) => bytes(v)} />}
                  cursor={CURSOR}
                  wrapperStyle={TOOLTIP_BOX}
                />
                <Area dataKey="mem_used" name="内存" stroke="var(--chart-4)" fill="var(--chart-4)" fillOpacity={0.15} {...SERIES} />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>

          {/* A rate has no total to be a fraction of, so this one climbs the
              ladder like CPU rather than pinning to a capacity. */}
          <Panel title="网络速率">
            <ResponsiveContainer>
              <LineChart data={metricRows}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis {...timeAxis(metricRows)} />
                <YAxis domain={[0, tops.rate]} ticks={quarters(tops.rate)} tickFormatter={axisBytes} unit="/s" width={Y_WIDTH} {...AXIS} />
                <Tooltip
                  content={<ChartTooltip format={(v) => rate(v)} />}
                  cursor={CURSOR}
                  wrapperStyle={TOOLTIP_BOX}
                />
                <Line dataKey="net_rx" name="下行" stroke="var(--ok)" {...SERIES} />
                <Line dataKey="net_tx" name="上行" stroke="var(--chart-2)" {...SERIES} />
              </LineChart>
            </ResponsiveContainer>
          </Panel>

          {/* The disk it is filling, for the same reason as memory: a node
              using 2.7% of its disk draws along the top of the panel when the
              axis tracks the window's own maximum. */}
          <Panel title={`硬盘 · ${bytes(node.disk_total)}`}>
            <ResponsiveContainer>
              <AreaChart data={metricRows}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis {...timeAxis(metricRows)} />
                <YAxis domain={[0, node.disk_total]} ticks={quarters(node.disk_total)} tickFormatter={axisBytes} width={Y_WIDTH} {...AXIS} />
                <Tooltip
                  content={<ChartTooltip format={(v) => bytes(v)} />}
                  cursor={CURSOR}
                  wrapperStyle={TOOLTIP_BOX}
                />
                <Area dataKey="disk_used" name="硬盘" stroke="var(--chart-3)" fill="var(--chart-3)" fillOpacity={0.15} {...SERIES} />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>
        </div>
      )}
    </div>
  )
}

import type { ComponentType, ReactNode } from "react"
import { Activity, ArrowDown, ArrowDownUp, ArrowUp, Gauge, Server } from "lucide-react"

import { Card } from "@/components/ui/card"
import { speedHistory, type Node } from "@/lib/api"
import { bytes, rate } from "@/lib/format"
import { summarize } from "@/lib/summary"

/**
 * 列表页顶上那行概览卡片：节点 / 最忙节点 / 今日流量 / 实时网速。
 *
 * 四张卡的数据都来自 `/api/nodes` 里本来就有的字段，开着它不会多发一个请求——唯一的
 * 例外是第四张下面那条走势线，它画的是访客打开页面之后自己攒下的实时速率（api.ts 的
 * `speedHistory`，每 2 秒一个采样、留最近 60 个 ≈ 2 分钟）：hub 没有「全站速率历史」
 * 这种接口，刷新页面就得重新攒，所以冷启动头几秒那里是空的。
 *
 * 默认关（主题设置 `showSummary`）。站点本来就有每台机器自己的卡片，不需要概览的站
 * 不必为此让出首屏；开关关掉时这个组件整个不挂载。
 */

/** 一行标题：图标 + 名称，与卡片里其它弱化小字同一套灰。 */
function Tile({ icon: Icon, title, children }: {
  icon: ComponentType<{ className?: string }>
  title: string
  children: ReactNode
}) {
  // 卡片是 flex-col，所以 `mt-auto` 能把底部那行压到同排最高的那张卡片的下沿，
  // 四张卡片的第二行因此对齐（内容行数不同也对齐）。
  return (
    <Card className="min-w-0 gap-0 p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5 shrink-0" />
        {title}
      </div>
      {children}
    </Card>
  )
}

/** 一枚带方向箭头的读数。颜色随所在那一行（今日那行是前景色，累计那行是弱化灰）。 */
function Val({ icon: Icon, children }: {
  icon: ComponentType<{ className?: string }>
  children: ReactNode
}) {
  return (
    <span className="tnum inline-flex min-w-0 items-center gap-1.5">
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{children}</span>
    </span>
  )
}

// viewBox 的横纵与卡片实际尺寸无关：下面的 preserveAspectRatio 会把它拉满整行，
// 纵轴按自己的最大值缩放。零基准——网速这种量没有上限可参照，不零基准会把
// 「一直很忙」和「偶尔抖一下」画成同一个形状。
const W = 100
const H = 28

/**
 * 实时网速下面那条走势线：下行 / 上行两条折线，无坐标轴、无填充——这一块只说
 * 「从打开页面到现在大概什么形状」，确切读数是它上面那一行。
 *
 * `preserveAspectRatio="none"` 把 viewBox 横向拉满卡片，代价是线宽也会被拉粗，
 * 所以每条线挂 `vectorEffect="non-scaling-stroke"` 把线宽钉回 1px。
 *
 * 采样点少于两个（冷启动的头几秒、或 hub 一直连不上）就只占位不画线：一个点画不出
 * 走势，画在那里会被读成「一直那么快」。高度照留，卡片不会因此跳一下。
 */
function Sparkline({ series }: { series: { rx: number; tx: number }[] }) {
  const ready = series.length > 1
  const max = Math.max(1, ...series.map((s) => Math.max(s.rx, s.tx)))
  const line = (pick: (s: { rx: number; tx: number }) => number) =>
    series
      .map((s, i) => `${((i / (series.length - 1)) * W).toFixed(2)},${(H - 1 - (pick(s) / max) * (H - 2)).toFixed(2)}`)
      .join(" ")
  return (
    <div className="mt-auto h-7 pt-4">
      {ready && (
        <svg className="h-full w-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {/* 下行用前景色、上行用弱化灰：与卡片网络区那两个方向的读法一致
              （速率用前景色、累计用灰），深浅色下都跟着同一套变量走。 */}
          <polyline points={line((s) => s.rx)} fill="none" strokeWidth={1} vectorEffect="non-scaling-stroke" className="stroke-foreground/70" />
          <polyline points={line((s) => s.tx)} fill="none" strokeWidth={1} vectorEffect="non-scaling-stroke" className="stroke-muted-foreground/60" />
        </svg>
      )}
    </div>
  )
}

export function SummaryCards({ nodes }: { nodes: Node[] }) {
  const fleet = summarize(nodes)
  const offline = fleet.total - fleet.online
  // 模块级的采样缓冲：`useNodes` 每次收到推送（或轮询回来）就追加一个点，
  // 所以这里读到的是「打开页面到现在」的全站速率，与分组筛选无关。
  const series = speedHistory.get(null) ?? []

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Tile icon={Server} title="节点">
        {/* 「在线 / 总数」：斜杠是纯文本，与数字同一色（照参考图），也省得读屏与复制时黏成一团。 */}
        <div className="tnum mt-2 text-xl font-semibold">
          {fleet.online} / {fleet.total}
        </div>
        <div className="mt-auto pt-6 text-xs text-muted-foreground">
          {fleet.total === 0 ? "还没有节点" : offline === 0 ? "全部在线" : `${offline} 台离线`}
        </div>
      </Tile>

      <Tile icon={Activity} title="最忙节点">
        {/* 一位小数，与卡片里 CPU 那格同一个口径。 */}
        <div className="tnum mt-2 text-xl font-semibold">
          {fleet.busiest ? `${fleet.busiest.cpu.toFixed(1)}%` : "—"}
        </div>
        <div className="mt-auto truncate pt-6 text-xs text-muted-foreground">
          {fleet.busiest ? fleet.busiest.name : "无在线节点"}
        </div>
      </Tile>

      <Tile icon={ArrowDownUp} title="今日流量">
        <div className="mt-2 grid grid-cols-2 gap-x-3 text-base font-semibold">
          <Val icon={ArrowDown}>{bytes(fleet.dayRx)}</Val>
          <Val icon={ArrowUp}>{bytes(fleet.dayTx)}</Val>
        </div>
        <div className="mt-3 text-xs text-muted-foreground">总流量</div>
        <div className="mt-1 grid grid-cols-2 gap-x-3 text-sm text-muted-foreground">
          <Val icon={ArrowDown}>{bytes(fleet.totalRx)}</Val>
          <Val icon={ArrowUp}>{bytes(fleet.totalTx)}</Val>
        </div>
      </Tile>

      <Tile icon={Gauge} title="实时网速">
        <div className="mt-2 grid grid-cols-2 gap-x-3 text-base font-semibold">
          <Val icon={ArrowDown}>{rate(fleet.netRx)}</Val>
          <Val icon={ArrowUp}>{rate(fleet.netTx)}</Val>
        </div>
        <Sparkline series={series} />
      </Tile>
    </div>
  )
}

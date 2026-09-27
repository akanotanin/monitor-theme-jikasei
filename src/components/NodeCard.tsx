import { useState } from "react"
import { ArrowDown, ArrowUp } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { LatencyPanel } from "@/components/Latency"
import { Meter } from "@/components/Meter"
import type { Node } from "@/lib/api"
import { bytes, FOREVER, pair, percent, rate } from "@/lib/format"

/**
 * This period's usage as the plan meters it. The hub computes it; the switch
 * below serves only a hub from before `month_used`.
 */
function monthUsage(node: Node): number {
  if (typeof node.month_used === "number") return node.month_used
  const { month_rx: rx, month_tx: tx } = node
  switch (node.traffic_mode) {
    case "up":
      return tx
    case "down":
      return rx
    case "max":
      return Math.max(rx, tx)
    default:
      return rx + tx
  }
}

// A node that has reported once has told the hub its shape -- cores, memory,
// disk -- and the hub retains its traffic totals whether connected or not. A node
// that never connected is the only case with nothing to show.
export function deployed(node: Node) {
  return node.cpu_cores > 0 || node.mem_total > 0
}

// 上游那枚「圆点 + 在线时长」徽章（Status）已随本主题删除：卡片与详情页都不再挂它，
// 详情页把同一个时长写进了信息项里的「在线时间」（见 NodeDetail 的 onlineFor）。
// 要恢复，去上游 monitor-theme-default 的 v1.1.0 取回该组件，并把 index.css 里
// --online / --offline 两个色值一起加回来。

/**
 * Where the machine is: its flag, or the bare code for one the set lacks.
 *
 * 旗子是主题自带的静态文件（`/flags/<CC>.svg`，258 面，按 ISO 3166-1 alpha-2
 * 命名，36×36 圆角方形画布、图案画在中间的 36×26 里），按国家码现取一张：访客
 * 只会下载页面上真正出现的那几面旗，不必把整套打进 bundle。
 *
 * 取不到就退回文字徽标——国家码不在这 258 面里（hub 偶尔给出 XA 这类非 ISO 码）、
 * 或者旗子文件没被装上，都走这一条，不留一枚破图。
 */
export function Country({ node }: { node: Node }) {
  const [missing, setMissing] = useState(false)
  const code = (node.country || "").trim().toUpperCase()
  if (!code) return null
  if (missing) {
    return (
      <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
        {code}
      </Badge>
    )
  }
  return (
    <img
      src={`/flags/${code}.svg`}
      alt={code}
      title={code}
      width={24}
      height={18}
      loading="lazy"
      // 24×18（4:3）：比一行 12px 的字高一档才看得清，1px 描边让日本、波兰这类
      // 白底旗在卡片上仍有边界。画布是正方形，`object-cover` 正好裁掉上下留白，
      // `-translate-y-px` 抵消行盒与图标基线之间的 1px 落差。
      className="h-[18px] w-6 shrink-0 -translate-y-px rounded-[3px] object-cover ring-1 ring-border/70"
      onError={() => setMissing(true)}
    />
  )
}

// Traffic uses the plan's own counting rule, so the bar matches the quota the
// node is billed against.
function trafficFoot(node: Node) {
  return node.traffic_limit > 0
    ? pair(monthUsage(node), node.traffic_limit)
    : `${bytes(monthUsage(node))} / ${FOREVER}`
}

export function NodeCard({ node, onOpen, latencyLines, cardStyle }: { node: Node; onOpen: () => void; latencyLines: string; cardStyle: "detail" | "classic" }) {
  const m = node.metrics

  return (
    <Card
      onClick={onOpen}
      // min-w-0: a grid item sizes to its content unless told otherwise, and the
      // name line below does not wrap, so on a phone the card would grow past its
      // column and scroll the page sideways. The truncate inside only takes effect
      // once the card is allowed to be narrower.
      className="min-w-0 cursor-pointer gap-0 p-4 transition-colors hover:border-ring"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
    >
      {/* 一行身份：旗子在前、名字在后。原先的三段（名称 + 国家徽标 / 系统·虚拟化·
          架构那一行 / 右侧的状态与到期两行）在这里收成一行——列表页一眼要看的是
          哪台机器、还剩多少余量；系统与到期在详情页写得更全，挤在卡片上只会把
          名字推到省略号。 */}
      <div className="flex min-w-0 items-center gap-2">
        <Country node={node} />
        <h3 className="truncate font-medium">{node.name}</h3>
      </div>

      {/* One layout for both states: a disconnected node still knows its
          cores, memory, disk size and traffic totals, and showing those with
          the live figures blank beats a stretched card with one line in it. */}
      {deployed(node) ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4">
            {/* The core count belongs beside the word CPU: it is what the
                percentage and the load averages are both measured against. */}
            <Meter
              label={`CPU ${node.cpu_cores} 核`}
              pct={m ? m.cpu : null}
              foot={m ? m.load.map((n) => n.toFixed(2)).join(" ") : "—"}
            />
            <Meter
              label="内存"
              pct={m ? percent(m.mem_used, m.mem_total) : null}
              foot={m ? pair(m.mem_used, m.mem_total) : bytes(node.mem_total)}
            />
            <Meter
              label="硬盘"
              pct={m ? percent(m.disk_used, m.disk_total) : null}
              foot={m ? pair(m.disk_used, m.disk_total) : bytes(node.disk_total)}
            />
            <Meter
              label="流量"
              pct={node.traffic_limit > 0 ? percent(monthUsage(node), node.traffic_limit) : null}
              empty={FOREVER}
              foot={trafficFoot(node)}
            />
          </div>

          {cardStyle === "classic" ? (
            /* 经典形态：速率一行、总量一行，2×2；不含延迟，也就不发延迟请求。 */
            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t pt-4 text-xs">
              <span className="tnum inline-flex items-center gap-1.5">
                <ArrowDown className="size-3 text-muted-foreground" />
                {m ? rate(m.net_rx) : "—"}
              </span>
              <span className="tnum inline-flex items-center gap-1.5">
                <ArrowUp className="size-3 text-muted-foreground" />
                {m ? rate(m.net_tx) : "—"}
              </span>
              <span className="tnum inline-flex items-center gap-1.5 text-muted-foreground">
                <ArrowDown className="size-3" />
                {bytes(node.total_rx)}
              </span>
              <span className="tnum inline-flex items-center gap-1.5 text-muted-foreground">
                <ArrowUp className="size-3" />
                {bytes(node.total_tx)}
              </span>
            </div>
          ) : (
            <>
              {/* 两个方向各一组、左右各占一端（下行在左、上行在右，与经典形态的读法一致），
                  组内「实时速率 · 累计总量」用一枚分隔点连起来；颜色沿用原本一套：实时速率用
                  前景色，累计总量与箭头、分隔点都用弱化灰。 */}
              {/* 这一组紧接在上面的用量格之后，横线挪到它下面（见 Latency 的边框），
                  由那条线把「速率 · 总量」与下面的三网延迟分开。 */}
              <div className="mt-4 flex items-center justify-between gap-x-3 text-xs">
                <span className="tnum inline-flex items-center gap-1.5 whitespace-nowrap">
                  <ArrowDown className="size-3 shrink-0 text-muted-foreground" />
                  {m ? rate(m.net_rx) : "—"}
                  <span className="text-muted-foreground">·</span>
                  <span className="text-muted-foreground">{bytes(node.total_rx)}</span>
                </span>
                <span className="tnum inline-flex items-center gap-1.5 whitespace-nowrap">
                  <ArrowUp className="size-3 shrink-0 text-muted-foreground" />
                  {m ? rate(m.net_tx) : "—"}
                  <span className="text-muted-foreground">·</span>
                  <span className="text-muted-foreground">{bytes(node.total_tx)}</span>
                </span>
              </div>
              {/* 三网延迟：每条线路一行，数据来自 hub 的 ping 历史（详见 Latency.tsx）。 */}
              <LatencyPanel node={node} lines={latencyLines} />
            </>
          )}
        </>
      ) : (
        /* Never connected: nothing to plot, so the card stays short rather than
           padding out to match its neighbours. */
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          还没有接入。在后台生成安装命令并执行一次。
        </p>
      )}
    </Card>
  )
}

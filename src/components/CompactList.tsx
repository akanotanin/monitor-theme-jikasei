import { ArrowDown, ArrowUp } from "lucide-react"

import { Country, deployed, monthUsage } from "@/components/NodeCard"
import type { Node } from "@/lib/api"
import { FOREVER, bytes, pair, percent, rate } from "@/lib/format"

/**
 * 「紧凑」形态：一行一台机器的表格。
 *
 * 另外三种形态都是网格里的卡片，一屏只排得下八到十几台；这一档换成表格，同样高度能排
 * 下两三倍，适合机器多、只想扫一眼余量的站。布局参考的是常见监控面板那种行列式，但配色
 * 仍是本主题这一套灰阶：进度条一律前景色，不按「越满越危险」上色（那是详情页仪表盘的事），
 * 弱化灰只留给列名、负载与离线这类附注。
 *
 * 列随屏宽收放：最窄只留「名称 / CPU / 流量」，依次加回网速、在线、内存、负载、硬盘。
 * 表头一直在（窄屏也不收）——数据列收得越少，越需要一行字告诉访客哪列是什么。
 * 延迟、时长、计费都不在这一档里：它要的正是「一屏看全」，那些留给详情页与另外三档。
 *
 * 参考了 monitor-theme-design（tom2almighty）那张服务器表格的行列式布局，但只取骨架，
 * 不搬它的配色与交互：它有状态点、排序表头、搜索框与内联展开，这些都是本主题另有取舍的地方
 * （状态点早随本主题删掉、排序与搜索不做、点一行是跳详情页而不是就地展开）；列宽也只能写死，
 * 不开 `table-fixed` 就撑不住长机器名。
 *
 * 用 `table-fixed`：走的是定宽算法，名称列不写宽度、吃掉余量，其余列写死宽度；名称过长
 * 在这里会真的截断，而不是把整张表撑出屏幕。`display:none` 的单元格从表里整个消失，所以
 * 表头与每行在各档断点下渲染出来的列数始终一致，不会错位。
 */

/** 单元格内的一条细进度条：宽度跟着格子走；没有上限（流量不限）就留空，与 Meter 对 null 一致。 */
function Bar({ pct }: { pct: number | null }) {
  const filled = pct === null ? 0 : Math.min(100, Math.max(0, pct))
  return (
    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-foreground/70 transition-[width] duration-500" style={{ width: `${filled}%` }} />
    </div>
  )
}

/** 与 Meter 同一口径：一位小数只留给个位数，上了两位数就取整，免得列宽跟着数字跳。 */
function pctText(p: number | null): string {
  return p === null ? "—" : `${p < 10 ? p.toFixed(1) : p.toFixed(0)}%`
}

/**
 * 表里的在线时长只写最大那一段：完整写法（「13 天 12 小时」）会把这一列撑得比 CPU 还宽。
 * 从没接入的机器没有时长可说，写「未接入」——它是「离线」之外唯一一种空状态。
 */
function shortUptime(node: Node): string {
  if (!node.online) return deployed(node) ? "离线" : "未接入"
  const s = node.metrics?.uptime
  if (s === undefined || s <= 0) return "在线"
  const d = Math.floor(s / 86400)
  if (d > 0) return `${d} 天`
  const h = Math.floor(s / 3600)
  return h > 0 ? `${h} 小时` : `${Math.floor(s / 60)} 分`
}

// 列宽与显隐：下面表头与每行共用同一份，改一处就得两处一起改（写在常量里，省得对不上）。
const COL = {
  uptime: "hidden w-16 sm:table-cell",
  load: "hidden w-14 md:table-cell",
  net: "hidden w-24 sm:table-cell sm:w-28",
  cpu: "w-14 sm:w-16",
  mem: "hidden w-14 sm:table-cell sm:w-16",
  disk: "hidden w-14 md:table-cell",
  traffic: "w-24 sm:w-32",
} as const
const HEAD = "px-3 py-2 text-right text-xs font-normal text-muted-foreground"
const CELL = "whitespace-nowrap px-3 py-1.5 text-right align-middle"

function Row({ node, onOpen }: { node: Node; onOpen: () => void }) {
  const m = node.metrics
  // CPU 是 hub 直接给的百分比；内存、硬盘、流量都要自己按 used/total 算。流量按套餐口径
  // （monthUsage，与经典/延迟档同一套），没有上限就是没有上限：文本写 ∞、条留空。
  const cpu = m ? m.cpu : null
  const mem = m ? percent(m.mem_used, m.mem_total) : null
  const disk = m ? percent(m.disk_used, m.disk_total) : null
  const used = monthUsage(node)
  const trafficText = node.traffic_limit > 0 ? pair(used, node.traffic_limit) : `${bytes(used)} / ${FOREVER}`
  const traffic = node.traffic_limit > 0 ? percent(used, node.traffic_limit) : null

  return (
    <tr
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
      className="cursor-pointer outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50"
    >
      {/* 名称列不写宽度：定宽表把余量全给它，机器名长短不一时其余列纹丝不动。 */}
      <td className="px-3 py-1.5 align-middle">
        <span className="flex min-w-0 items-center gap-2">
          <Country node={node} />
          <span className="truncate font-medium">{node.name}</span>
        </span>
      </td>
      <td className={`${COL.uptime} ${CELL} text-muted-foreground`}>{shortUptime(node)}</td>
      <td className={`${COL.load} ${CELL} text-muted-foreground`}>{m ? m.load[0].toFixed(2) : "—"}</td>
      <td className={`${COL.net} ${CELL}`}>
        <span className="tnum inline-flex items-center gap-1">
          <ArrowDown className="size-3 shrink-0 text-muted-foreground" />
          {m ? rate(m.net_rx) : "—"}
        </span>
        <span className="tnum mt-0.5 flex items-center justify-end gap-1">
          <ArrowUp className="size-3 shrink-0 text-muted-foreground" />
          {m ? rate(m.net_tx) : "—"}
        </span>
      </td>
      <td className={`${COL.cpu} ${CELL}`}>
        <span className="tnum">{pctText(cpu)}</span>
        <Bar pct={cpu} />
      </td>
      <td className={`${COL.mem} ${CELL}`}>
        <span className="tnum">{pctText(mem)}</span>
        <Bar pct={mem} />
      </td>
      <td className={`${COL.disk} ${CELL}`}>
        <span className="tnum">{pctText(disk)}</span>
        <Bar pct={disk} />
      </td>
      <td className={`${COL.traffic} ${CELL}`}>
        <span className="tnum">{trafficText}</span>
        <Bar pct={traffic} />
      </td>
    </tr>
  )
}

/** 紧凑形态的外壳：一张带边框的表。 */
export function CompactList({ nodes, onOpen }: { nodes: Node[]; onOpen: (id: number) => void }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <table className="w-full table-fixed text-xs">
        <thead>
          <tr className="border-b bg-muted/40">
            <th className="px-3 py-2 text-left text-xs font-normal text-muted-foreground">名称</th>
            <th className={`${COL.uptime} ${HEAD}`}>在线</th>
            <th className={`${COL.load} ${HEAD}`}>负载</th>
            <th className={`${COL.net} ${HEAD}`}>网速</th>
            <th className={`${COL.cpu} ${HEAD}`}>CPU</th>
            <th className={`${COL.mem} ${HEAD}`}>内存</th>
            <th className={`${COL.disk} ${HEAD}`}>硬盘</th>
            <th className={`${COL.traffic} ${HEAD}`}>流量</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {nodes.map((n) => <Row key={n.id} node={n} onOpen={() => onOpen(n.id)} />)}
        </tbody>
      </table>
    </div>
  )
}

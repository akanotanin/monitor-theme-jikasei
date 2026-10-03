import { lazy, Suspense, useEffect, useState } from "react"
import { ArrowDown, ArrowUp, ChevronRight } from "lucide-react"

import { Country, deployed, monthUsage } from "@/components/NodeCard"
import { Skeleton } from "@/components/ui/skeleton"
import type { Node } from "@/lib/api"
import { FOREVER, CYCLES, bytes, daysUntil, money, osName, pair, percent, rate } from "@/lib/format"

/**
 * 「紧凑」形态：一行一台机器的表格，点一行就地摊开延迟。
 *
 * 另外三种形态都是网格里的卡片，一屏只排得下八到十几台；这一档换成表格，同样高度能排
 * 下两三倍，适合机器多、只想扫一眼余量的站。
 *
 * 版式照着 monitor-theme-design（tom2almighty）那张服务器表排——列序与对齐都对齐它：
 *   名称（折角 + 国旗 + 名字，左对齐） 系统 在线 剩余 价格 负载 网速 CPU 内存 硬盘 流量
 * 除名称列外一律居中，每个指标是「读数压在一条细进度条上」，网速是「↓ 下行 | ↑ 上行」，
 * 表头一直挂在上方、网速那格还缀着 `↓|↑`。国旗仍排在名字之前、不自成一列——与另外三种
 * 形态同一处身份读法（旗子认地方、名字认机器）。续费价是源站没有的一列，本主题把它与
 * 到期摆在一起，讲的都是账期。
 *
 * 点一行**就地摊开延迟**（源站亦然，不跳详情页）：展开行里挂的是整页详情那份延迟图
 * （NodeDetail 的 embedded 模式，含 1/6/24/7天 范围与削峰开关），点名称前那枚折角或在
 * 行上敲回车都会开合。折角因此是「点得进去」的提示，落点是就地展开而不是整页跳转；真要去
 * 整页详情，展开行右上角留了「完整详情 ›」。
 *
 * 只借版式，不借它的皮：配色仍是本主题这一套灰阶。深浅只有一条规则——表头标签与箭头是弱化灰，
 * 单元格里的数据是前景色，「没有这个值」（`—` / `∞` / `未接入`）也回到弱化灰；主次不再用深浅
 * 区分（卡片里那层灰是「主读数底下的注脚」，而表里每个格子本身就是主读数），只在字重上留一线：
 * 指标读数用 medium、其余常规。也没有它的状态点、排序表头与搜索框——本主题早把状态点删了、
 * 不做排序与搜索。
 *
 * 列随屏宽收放（与源站同样的思路，只是断点用本主题一贯的视口断点而非容器查询）：
 *   窄屏   名称 / CPU / 流量
 *   sm+    加回 网速、内存
 *   md+    加回 在线、负载、硬盘
 *   lg+    加回 到期、价格
 *   xl+    加回 系统（这一列要给名字留全，只有 ≥1280 才塞得下）
 * 表头窄屏也保留——数据列收得越少，越需要一行字告诉访客哪列是什么。
 *
 * 用 `table-fixed`：走的是定宽算法，名称列不写宽度、吃掉余量，其余列写死宽度；名称过长
 * 在这里会真的截断，而不是把整张表撑出屏幕。`display:none` 的单元格从表里整个消失，所以
 * 表头与每行在各档断点下渲染出来的列数始终一致，不会错位。
 */

// 点开一行就地摊开的那块：整页详情（含那张延迟图）单独一个 chunk，与 App 里那份同一个——
// 表格本身不必背上 recharts，点开时才取（App 开页已经在预热这个 chunk）。
const NodeDetail = lazy(() => import("@/components/NodeDetail").then((m) => ({ default: m.NodeDetail })))

/**
 * 单元格内的一条细进度条。高度、圆角、色值都照 Meter 来（h-1.5、填色 bg-foreground 纯前景色），
 * 第四种形态才不像另一套零件拼的；没有上限（流量不限）就留空，与 Meter 对 null 一致。
 */
function Bar({ pct }: { pct: number | null }) {
  const filled = pct === null ? 0 : Math.min(100, Math.max(0, pct))
  return (
    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-foreground transition-[width] duration-500" style={{ width: `${filled}%` }} />
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

/**
 * 表里的到期只写天数（详细档那句「剩余 95 天」太长）。取 hub 算好的 `expires_in`，
 * 旧 hub 没有才按 `expires_at` 自己数——与 NodeCard 的 expiryText 同一套规则，只是更短。
 * 没有期限（∞）算「没有这个值」，走弱化灰；有天数就是数据，走前景色。快到期（≤7 天）与
 * 已过期再加重一档字重——源站在这一列挂红/黄徽章，本主题没红没黄，就用字重把该看一眼的
 * 从满列数据里拎出来。
 */
function expiryShort(node: Node): { text: string; soon: boolean; muted: boolean } {
  const days = node.expires_in !== undefined ? node.expires_in : daysUntil(node.expires_at)
  if (days === null || days === undefined) return { text: FOREVER, soon: false, muted: true }
  if (days < 0) return { text: `过期 ${-days} 天`, soon: true, muted: false }
  if (days <= 7) return { text: `${days} 天`, soon: true, muted: false }
  return { text: `${days} 天`, soon: false, muted: false }
}

// 每一列从哪一档起出现（视口 px，0 = 一直都在）。表头、每行单元格、展开行要跨的列数
// 都从这一份推，三处不会各写各的；列宽另放 W，只写宽度、不碰显隐。
const MIN = {
  name: 0, os: 1280, uptime: 768, expiry: 1024, price: 1024, load: 768,
  net: 640, cpu: 0, mem: 640, disk: 768, traffic: 0,
} as const
const W = {
  name: "", os: "w-36", uptime: "w-16", expiry: "w-14", price: "w-28", load: "w-14",
  net: "w-24 lg:w-44", cpu: "w-14 sm:w-16 xl:w-20", mem: "w-14 sm:w-16 xl:w-20",
  disk: "w-12 xl:w-20", traffic: "w-28 sm:w-32 xl:w-36",
} as const
type ColKey = keyof typeof MIN

const visClass = (min: number) =>
  min === 0 ? "" : min <= 640 ? "hidden sm:table-cell" : min <= 768 ? "hidden md:table-cell" : min <= 1024 ? "hidden lg:table-cell" : "hidden xl:table-cell"
const colCls = (key: ColKey) => `${visClass(MIN[key])} ${W[key]}`.trim()

const HEAD = "px-2 py-2 text-center text-xs font-normal text-muted-foreground"
const CELL = "whitespace-nowrap px-2 py-2 text-center align-middle"

/** 眼下看得见几列——展开行要跨的就是这个数。跟着 MIN 走，不另写一份。 */
function useSpan(): number {
  const count = () => (Object.values(MIN) as number[]).filter((m) => innerWidth >= m).length
  const [span, setSpan] = useState(count)
  useEffect(() => {
    const onResize = () => setSpan(count())
    addEventListener("resize", onResize)
    return () => removeEventListener("resize", onResize)
  }, [])
  return span
}

/** 展开行里那块：整页详情的延迟图就地渲染；从没接入的机器没有历史可画，写一句话带过。 */
function Expanded({ node, span, onOpenDetail, historyDays, notes }: { node: Node; span: number; onOpenDetail: () => void; historyDays?: number; notes?: string }) {
  return (
    <tr className="bg-muted/30">
      {/* 展开行要跨满当前看得见的列数：colSpan 得跟着断点走（见 useSpan），写死一个数会
          在窄屏上把表格撑出多余的列。 */}
      <td colSpan={span} className="p-0">
        <div className="border-t border-border/60 px-4 py-3">
          {deployed(node) ? (
            <Suspense fallback={<Skeleton className="h-72" />}>
              <NodeDetail node={node} embedded onOpenDetail={onOpenDetail} historyDays={historyDays} notes={notes} />
            </Suspense>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">还没有接入。在后台生成安装命令并执行一次。</p>
          )}
        </div>
      </td>
    </tr>
  )
}

function Row({ node, span, open, onToggle, onOpenDetail, onWarm, historyDays, notes }: {
  node: Node
  span: number
  open: boolean
  onToggle: () => void
  onOpenDetail: () => void
  /** 摸到这一行就先取详情那块 chunk（与卡片同一个回调，见 App 的 warmDetail）。 */
  onWarm?: () => void
  /** hub 的保留天数，展开时透给那块延迟图（时间范围那排按钮按它生成）。 */
  historyDays?: number
  /** 主题设置里那份「服务器备注」清单，展开时透给那块延迟图那一行。 */
  notes?: string
}) {
  const m = node.metrics
  // CPU 是 hub 直接给的百分比；内存、硬盘、流量都要自己按 used/total 算。流量按套餐口径
  // （monthUsage，与经典/延迟档同一套），没有上限就是没有上限：文本写 ∞、条留空。
  const cpu = m ? m.cpu : null
  const mem = m ? percent(m.mem_used, m.mem_total) : null
  const disk = m ? percent(m.disk_used, m.disk_total) : null
  const used = monthUsage(node)
  const trafficText = node.traffic_limit > 0 ? pair(used, node.traffic_limit) : `${bytes(used)} / ${FOREVER}`
  const traffic = node.traffic_limit > 0 ? percent(used, node.traffic_limit) : null
  const expiry = expiryShort(node)
  // 续费价与计费周期：与「详细」卡片同一套读法（金额 + 周期），只是压在一个格子里。
  const cycle = CYCLES[node.billing_cycle] ?? (node.billing_cycle || null)

  return (
    <>
      <tr
        role="button"
        aria-expanded={open}
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onToggle())}
        onPointerOver={onWarm}
        onFocus={onWarm}
        onTouchStart={onWarm}
        className={`cursor-pointer outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 ${open ? "bg-muted/30" : ""}`}
      >
        {/* 名称列不写宽度、也不居中：定宽表把余量全给它，机器名长短不一时其余列纹丝不动。
            折角 → 国旗 → 名字：折角是「点得进去」的提示，展开时转成朝下；国旗与另外三种
            形态同一处读法，都排在名字之前。 */}
        <td className="px-3 py-2 align-middle">
          <span className="flex min-w-0 items-center gap-2">
            <ChevronRight className={`size-3.5 shrink-0 text-muted-foreground/60 transition-transform ${open ? "rotate-90" : ""}`} />
            <Country node={node} />
            <span className="truncate text-sm font-medium">{node.name}</span>
          </span>
        </td>
        <td className={`${colCls("os")} ${CELL} ${node.os ? "" : "text-muted-foreground"}`}>
          <span className="block truncate">{node.os ? osName(node.os) : "—"}</span>
        </td>
        <td className={`${colCls("uptime")} ${CELL} ${deployed(node) ? "" : "text-muted-foreground"}`}>{shortUptime(node)}</td>
        <td className={`${colCls("expiry")} ${CELL} tnum ${expiry.muted ? "text-muted-foreground" : ""} ${expiry.soon ? "font-medium" : ""}`}>{expiry.text}</td>
        <td className={`${colCls("price")} ${CELL} tnum ${node.price > 0 ? "" : "text-muted-foreground"}`}>
          {node.price > 0
            ? <span className="block truncate">{money(node.price, node.currency)}{cycle ? ` / ${cycle}` : ""}</span>
            : "—"}
        </td>
        <td className={`${colCls("load")} ${CELL} tnum ${m ? "" : "text-muted-foreground"}`}>{m ? m.load[0].toFixed(2) : "—"}</td>
        <td className={`${colCls("net")} ${CELL}`}>
          {/* 下行在左、上行在右，与三种卡片形态的读法一致；窄屏摞成两行（源站窄屏也这么摞），
              宽屏才并排——那一排要一个半读数的宽度，窄屏给不起。 */}
          <div className="tnum flex flex-col items-center gap-0.5 lg:flex-row lg:justify-center lg:gap-1">
            <span className="inline-flex items-center gap-1">
              <ArrowDown className="size-3 shrink-0 text-muted-foreground" />
              {m ? rate(m.net_rx) : "—"}
            </span>
            <span className="hidden text-muted-foreground/60 lg:inline">|</span>
            <span className="inline-flex items-center gap-1">
              <ArrowUp className="size-3 shrink-0 text-muted-foreground" />
              {m ? rate(m.net_tx) : "—"}
            </span>
          </div>
        </td>
        <td className={`${colCls("cpu")} ${CELL}`}>
          <span className="tnum font-medium">{pctText(cpu)}</span>
          <Bar pct={cpu} />
        </td>
        <td className={`${colCls("mem")} ${CELL}`}>
          <span className="tnum font-medium">{pctText(mem)}</span>
          <Bar pct={mem} />
        </td>
        <td className={`${colCls("disk")} ${CELL}`}>
          <span className="tnum font-medium">{pctText(disk)}</span>
          <Bar pct={disk} />
        </td>
        <td className={`${colCls("traffic")} ${CELL}`}>
          <span className="tnum block truncate font-medium">{trafficText}</span>
          <Bar pct={traffic} />
        </td>
      </tr>
      {open && <Expanded node={node} span={span} onOpenDetail={onOpenDetail} historyDays={historyDays} notes={notes} />}
    </>
  )
}

/** 紧凑形态的外壳：一张带边框的表，表头一行。展开的行由 CompactList 统一管开合。 */
export function CompactList({ nodes, onOpen, onWarm, historyDays, notes }: { nodes: Node[]; onOpen: (id: number) => void; onWarm?: () => void; historyDays?: number; notes?: string }) {
  const span = useSpan()
  // 一次只摊开一行：表格本来就密，同时摊开两块会把上下文冲散。
  const [open, setOpen] = useState<number | null>(null)

  return (
    <div className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm">
      <table className="w-full table-fixed text-xs">
        <thead>
          <tr className="border-b bg-muted/40">
            <th className={`${colCls("name")} px-3 py-2 text-left text-xs font-normal text-muted-foreground`}>名称</th>
            <th className={`${colCls("os")} ${HEAD}`}>系统</th>
            <th className={`${colCls("uptime")} ${HEAD}`}>在线</th>
            <th className={`${colCls("expiry")} ${HEAD}`}>剩余</th>
            <th className={`${colCls("price")} ${HEAD}`}>价格</th>
            <th className={`${colCls("load")} ${HEAD}`}>负载</th>
            <th className={`${colCls("net")} ${HEAD}`}>网速<span className="hidden lg:inline"> ↓|↑</span></th>
            <th className={`${colCls("cpu")} ${HEAD}`}>CPU</th>
            <th className={`${colCls("mem")} ${HEAD}`}>内存</th>
            <th className={`${colCls("disk")} ${HEAD}`}>硬盘</th>
            <th className={`${colCls("traffic")} ${HEAD}`}>流量</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {nodes.map((n) => (
            <Row
              key={n.id}
              node={n}
              span={span}
              open={open === n.id}
              onToggle={() => setOpen((cur) => (cur === n.id ? null : n.id))}
              onOpenDetail={() => onOpen(n.id)}
              onWarm={onWarm}
              historyDays={historyDays}
              notes={notes}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

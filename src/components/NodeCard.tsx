import { useState, type ComponentType, type ReactNode } from "react"
import {
  ArrowDown, ArrowDownUp, ArrowUp, CalendarClock, Cpu, HardDrive, MemoryStick,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { LatencyPanel } from "@/components/Latency"
import { Meter } from "@/components/Meter"
import type { Node } from "@/lib/api"
import { CYCLES, FOREVER, bytes, currencySymbol, daysUntil, money, moneyAmount, pair, percent, rate, uptime } from "@/lib/format"
import { hasNotes, tagsFor } from "@/lib/site-settings"

/**
 * This period's usage as the plan meters it. The hub computes it; the switch
 * below serves only a hub from before `month_used`.
 */
export function monthUsage(node: Node): number {
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
//
// 详细档标题行前那枚状态点（StatusDot）也一并撤了：那一点紧贴国旗、挤在名字前头，
// 位置局促；何况在线与否在下面的 MetaRow 里已写成「在线 …」的文字，不必再用一枚
// 无标签的圆点重复一遍。标题行现在只剩「旗子 + 名字」。

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

/* ------------------------------------------------------------------ 详细档的小件 */

/** 详细档第二行左边那句「在线 …」。没接入的节点没有时长可说，返回 null。 */
function onlineText(node: Node): string | null {
  if (node.online) return node.metrics ? `在线 ${uptime(node.metrics.uptime)}` : "在线"
  if (!deployed(node)) return null
  const down = node.last_seen ? Date.now() / 1000 - node.last_seen : 0
  return down >= 60 ? `离线 ${uptime(down)}` : "离线"
}

function priceText(node: Node): string | null {
  return node.price > 0 ? money(node.price, node.currency) : null
}

function cycleText(node: Node): string | null {
  if (node.price <= 0) return null
  return CYCLES[node.billing_cycle] ?? (node.billing_cycle || null)
}

/**
 * 到期还剩多少天。优先用 hub 算好的 `expires_in`：它按 hub 的时区算，还会给在线节点
 * 顺延到期日，访客自己按浏览器时钟算会在顺延前的那几个小时里显示成「已过期」。只有
 * 旧 hub 没这个 key 时，才退回按 `expires_at` 自己数。
 */
function expiryText(node: Node): string | null {
  const days = node.expires_in !== undefined ? node.expires_in : daysUntil(node.expires_at)
  if (days === null || days === undefined) return null
  if (days < 0) return `已过期 ${-days} 天`
  if (days === 0) return "今天到期"
  return `剩余 ${days} 天`
}

/**
 * 详细档第二行。两副面孔：
 *   原样（备注关）——左「在线时长」、右「价格 / 周期」。
 *   备注开——两边对调并让位：左「备注标签」、右「在线时长」，价格移进下面第三枚读数盒。
 * 两样都没有就整行不画。
 */
function MetaRow({ node, notes, remark }: { node: Node; notes: string; remark: boolean }) {
  const online = onlineText(node)
  if (remark) {
    const tags = tagsFor(notes, node.name)
    if (!online && tags.length === 0) return null
    return (
      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        {/* 一枚标签一个胶囊：备注里用逗号分隔，这里就排成多枚（`三网优化,备用` 是两枚）。
            容器 flex-1 + flex-wrap：排不下时往下折行，右侧「在线时长」始终贴右不动。
            空占位那块保住「在线时长」始终贴右，与另一副面孔里的价格同一位置。 */}
        {tags.length > 0
          ? (
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
              {tags.map((tag, i) => (
                <Badge
                  key={`${i}-${tag}`}
                  variant="secondary"
                  // Badge 自带 `w-fit shrink-0`：单枚过长时要能被容器截断，所以放开 shrink、限 max-w-full。
                  className="min-w-0 max-w-full shrink font-normal"
                  title={tag}
                >
                  <span className="min-w-0 truncate">{tag}</span>
                </Badge>
              ))}
            </span>
          )
          : <span className="min-w-0 flex-1" />}
        {online && <span className="shrink-0 truncate text-right">{online}</span>}
      </div>
    )
  }
  const price = priceText(node)
  const cycle = cycleText(node)
  if (!online && !price) return null
  return (
    <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span className="truncate">{online}</span>
      {price && <span className="tnum shrink-0">{cycle ? `${price} / ${cycle}` : price}</span>}
    </div>
  )
}

/**
 * 详细档那三枚读数盒：实时速率 / 累计总量 / 剩余时间。一层浅底把它们与上下的网格分开，
 * 像仪表盘上嵌进去的读数窗——前两个对应「此刻」与「累计」，第三个上面是本机还剩多久、
 * 下面一行备注关时写到期日、备注开时换成价格与计费周期。
 */
function InfoBox({ children }: { children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5 overflow-hidden rounded-md bg-muted/60 px-2 py-2 text-xs">
      {children}
    </div>
  )
}

function Stat({ icon: Icon, children }: {
  icon: ComponentType<{ className?: string }>
  children: ReactNode
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon className="size-3 shrink-0" />
      <span className="tnum truncate">{children}</span>
    </span>
  )
}

// Traffic uses the plan's own counting rule, so the bar matches the quota the
// node is billed against.
function trafficFoot(node: Node) {
  return node.traffic_limit > 0
    ? pair(monthUsage(node), node.traffic_limit)
    : `${bytes(monthUsage(node))} / ${FOREVER}`
}

export function NodeCard({ node, onOpen, onWarm, latencyLines, cardStyle, notes }: {
  node: Node
  onOpen: () => void
  /** 指针或键盘刚落到这张卡片上：先把手头这块 chunk（详情页的图表那 391KB）取回来。 */
  onWarm?: () => void
  latencyLines: string
  cardStyle: "classic" | "latency" | "detailed" | "plain"
  /** 「详细」形态的服务器备注清单（每行 `服务器名=备注`）；空串 = 关闭。 */
  notes: string
}) {
  const m = node.metrics
  // 详细档：图标、元信息行与三枚读数盒都只在它里面出现；配色仍与另外两档同一套灰。
  const detailed = cardStyle === "detailed"
  // 简约档：结构、内容、位置与经典档完全一致，只换一套视觉处理——标签改用前景色、
  // 进度条压到 4px、底注降到 11px、名字加粗一档、格子间距收紧（见下方各处 plain 分支）。
  const plain = cardStyle === "plain"
  // 备注只在「详细」档生效，且清单非空才算开——留空即关闭，这一档保持 1.5.0 的样子。
  const remark = detailed && hasNotes(notes)
  const price = priceText(node)
  const cycle = cycleText(node)

  // 卡片底部那一行网络：经典、简约、延迟三档共用**同一个节点**——一行两段，
  // 左边实时速率（前景色）、右边累计总量（弱化灰），上面一条分隔线；箭头用文字
  // ↓ ↑ 而不是图标，这样整段能原样复制成「↓ 88 B/s ↑ 312 B/s」。
  // 延迟档原本是「上下行各一组、组内用分隔点连起来」的两端式，按要求与经典/简约
  // 看齐后改成这条；三档同一个节点也是护栏里「逐项相同」那条等价断言的前提。
  // `data-net` 是给护栏认这一行的锚点（原来的判据按 2×2 那格的类名找，改版后会失配）。
  // 这一行归**简约 / 延迟**两档（它们共用同一个节点，「看齐」因此在结构上恒成立）。
  const netRow = (
    <div data-net="row" className="tnum mt-3 flex items-center justify-between gap-2 border-t pt-2.5 text-xs">
      <span className="truncate">{m ? `↓ ${rate(m.net_rx)} ↑ ${rate(m.net_tx)}` : "—"}</span>
      <span className="truncate text-muted-foreground">
        {`↓ ${bytes(node.total_rx)} ↑ ${bytes(node.total_tx)}`}
      </span>
    </div>
  )

  // 经典档底部＝**原本的 2×2 四格**：速率一行、总量一行（与上面读数格同两条列），
  // 箭头是文字 ↓ ↑（不是图标，整段可原样复制），第一行的数值用前景色、箭头与整行总量弱化。
  // 它和上面那条一行两段不是一回事——经典恢复原样后，这两档已经不再同版式。
  const netGrid = (
    <div data-net="grid" className="tnum mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t pt-4 text-xs">
      <span>
        <span className="text-muted-foreground">↓</span> {m ? rate(m.net_rx) : "—"}
      </span>
      <span>
        <span className="text-muted-foreground">↑</span> {m ? rate(m.net_tx) : "—"}
      </span>
      <span className="text-muted-foreground">↓ {bytes(node.total_rx)}</span>
      <span className="text-muted-foreground">↑ {bytes(node.total_tx)}</span>
    </div>
  )

  return (
    <Card
      onClick={onOpen}
      // 摸到卡片（悬停 / 键盘 Tab 到它 / 手指按下）就先取详情那块 chunk：真要打开的人，
      // 鼠标按下去之前多半已经碰过这张卡了。见 App 的 warmDetail。
      onPointerOver={onWarm}
      onFocus={onWarm}
      onTouchStart={onWarm}
      // min-w-0: a grid item sizes to its content unless told otherwise, and the
      // name line below does not wrap, so on a phone the card would grow past its
      // column and scroll the page sideways. The truncate inside only takes effect
      // once the card is allowed to be narrower.
      className="min-w-0 cursor-pointer gap-0 p-4 transition-colors hover:border-foreground/25"
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
        {/* 简约档只把名字加粗一档（参考站是 600），文字与位置照旧。 */}
        <h3 className={`truncate ${plain ? "font-semibold" : "font-medium"}`}>{node.name}</h3>
      </div>

      {/* One layout for both states: a disconnected node still knows its
          cores, memory, disk size and traffic totals, and showing those with
          the live figures blank beats a stretched card with one line in it. */}
      {deployed(node) ? (
        <>
          {detailed && <MetaRow node={node} notes={notes} remark={remark} />}

          <div className={`mt-4 grid grid-cols-2 gap-x-4 ${plain ? "gap-y-3" : "gap-y-4"}`}>
            {/* The core count belongs beside the word CPU: it is what the
                percentage and the load averages are both measured against. */}
            <Meter
              plain={plain}
              icon={detailed ? Cpu : undefined}
              label={plain
                ? <>CPU <span className="text-muted-foreground">{node.cpu_cores} 核</span></>
                : `CPU ${node.cpu_cores} 核`}
              pct={m ? m.cpu : null}
              foot={m ? m.load.map((n) => n.toFixed(2)).join(" ") : "—"}
            />
            <Meter
              plain={plain}
              icon={detailed ? MemoryStick : undefined}
              label="内存"
              pct={m ? percent(m.mem_used, m.mem_total) : null}
              foot={m ? pair(m.mem_used, m.mem_total) : bytes(node.mem_total)}
            />
            <Meter
              plain={plain}
              icon={detailed ? HardDrive : undefined}
              label="硬盘"
              pct={m ? percent(m.disk_used, m.disk_total) : null}
              foot={m ? pair(m.disk_used, m.disk_total) : bytes(node.disk_total)}
            />
            <Meter
              plain={plain}
              icon={detailed ? ArrowDownUp : undefined}
              label="流量"
              pct={node.traffic_limit > 0 ? percent(monthUsage(node), node.traffic_limit) : null}
              empty={FOREVER}
              foot={trafficFoot(node)}
            />
          </div>

          {cardStyle === "classic" ? (
            netGrid
          ) : cardStyle === "plain" ? (
            netRow
          ) : cardStyle === "latency" ? (
            <>
              {/* 延迟档底部与「简约」同一行版式（就是上面那同一个 netRow 节点），
                  分隔线由它自己的 border-t 画在上面，三网延迟再从下面那条线开始。 */}
              {netRow}
              {/* 三网延迟：每条线路一行，数据来自 hub 的 ping 历史（详见 Latency.tsx）。 */}
              <LatencyPanel node={node} lines={latencyLines} />
            </>
          ) : (
            <>
              {/* 详细形态：网速、总量，加第三枚读数盒并排。第三枚上面一直是「剩余时间」，
                  下面一行备注关时写到期日、备注开时换成「价格 / 周期」（到期日不再显示）。
                  速率与总量各按上下行分两行；配色与另外两档同一套灰。下面照旧挂三网延迟。 */}
              <div className="mt-4 grid grid-cols-3 gap-2">
                <InfoBox>
                  <Stat icon={ArrowDown}>{m ? rate(m.net_rx) : "—"}</Stat>
                  <Stat icon={ArrowUp}>{m ? rate(m.net_tx) : "—"}</Stat>
                </InfoBox>
                <InfoBox>
                  <Stat icon={ArrowDown}>{bytes(node.total_rx)}</Stat>
                  <Stat icon={ArrowUp}>{bytes(node.total_tx)}</Stat>
                </InfoBox>
                <InfoBox>
                  <Stat icon={CalendarClock}>{expiryText(node) ?? "无期限"}</Stat>
                  {remark
                    ? price && (
                      <span className="flex min-w-0 items-center gap-1.5">
                        {/* 货币符号单独占一列，和上面「剩余时间」前那枚时钟图标同宽同位——
                            两行的左边缘才对得齐（符号缺位时这一列留空，数字仍从这里起）。
                            颜色不降级：这一排三格讲的都是读数，上一格写剩余时间、这一格写计费，
                            都该是前景色（弱化灰留给真正的附注）。 */}
                        <span className="w-3 shrink-0 text-center">{currencySymbol(node.currency)}</span>
                        <span className="tnum truncate">
                          {moneyAmount(node.price, node.currency)}{cycle ? ` / ${cycle}` : ""}
                        </span>
                      </span>
                    )
                    : node.expires_at && (
                      <span className="block truncate pl-[18px] text-muted-foreground">{node.expires_at}</span>
                    )}
                </InfoBox>
              </div>
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

import { Card } from "@/components/ui/card"
import { Country, RemarkChips, deployed, monthUsage } from "@/components/NodeCard"
import { TextHighlight } from "@/components/TextHighlight"
import type { Node } from "@/lib/api"
import { CYCLE_SHORT, FOREVER, bytes, daysUntil, money, osName, pair, percent, rate, uptime } from "@/lib/format"
import { remarkChips } from "@/lib/notes"
import { remarksOnCards, type RemarkPlacement } from "@/lib/site-settings"

/**
 * 「宽卡」那一档的卡片（在收成 1080 的整页容器里两列铺开、每张 510 宽 —— 容器收窄与
 * 卡片同属这一档，见 App 的 shell）。
 *
 * 版式照参考站的宽卡校准过（那边 508×209）。从上到下六块：
 *   ① 身份行：旗子 + 名字；
 *   ② 一行灰字：系统 · 运行时间（四种处境各自的写法见 metaLine）；
 *   ③ 四个读数格：CPU / 内存 / 存储 / 负载（上面一条分隔线，见 Readout）；
 *   ④ 上传 / 下载：左右两栏，各带累计总量与实时速率，中间一道竖线；
 *   ⑤ 总流量：左边「已用 / 额度」、右边「流量重置」，下面一条全宽进度条；
 *   ⑥ 底注：价格 / 到期（左）＋ 备注小卡片（最多 CHIPS 枚，右）。
 *
 * ★ 风格与其余几档同一套口径（2026-10-15 按站长要求收齐）：**不带状态点、不带「已离线」
 *   徽章**（在线与否写在②那行文字里——「已离线 / 未接入 / 在线」，与详细档的「离线 …」同一
 *   口径）；读数条用**前景色的 70%**（与经典 / 简约那两档同一族），绿条与红点只属于源形态，
 *   不在本主题的配色语言里。卡面**不含延迟**——延迟在整页详情里看（点卡片进去）；也不挂经典 /
 *   延迟两档右上角那枚信息图标：在线时间与价格 / 到期本来就写在②与⑥的那两行里。
 *
 * 护栏锚点：`data-node-card`（卡片，值是 id）· `data-metrics`（四读数格容器）·
 * `data-net="duo"`（上传下载两栏——与经典 / 简约那两档的 `data-net` 是**不同**的两块：那边是
 * 「速率 / 总量」两行，这边是「上传 / 下载」两栏，所以另起一个值，免得护栏把两处读混）·
 * `data-remark="card"`（底注右侧那一串备注小卡片）。
 */

/**
 * 名字下面那行灰字：`系统 · 运行时间 34 天`。离线写「已离线」、从未接入写「未接入」、
 * 连上但还没上报写「在线」—— 四种处境在卡面上各自说得清，不都塞成「离线」。
 */
function metaLine(node: Node): string {
  const state = node.metrics
    ? `运行时间 ${uptime(node.metrics.uptime)}`
    : node.online ? "在线" : deployed(node) ? "已离线" : "未接入"
  return [osName(node.os), state].filter(Boolean).join(" · ")
}

/**
 * 负载那一格的条：`load[0] / 核数` —— 1 核机上 0.20 的负载 = 20%（条读的是「满载的几成」，
 * 而不是把 1 分钟均值直接当百分比）。核数取不到时按 1 核算，免得除零。
 */
function loadPct(node: Node): number | null {
  const m = node.metrics
  return m ? percent(m.load[0], Math.max(1, node.cpu_cores || 1)) : null
}

/**
 * 底注那行小字：`价格 ¥47.00/年 · 剩余 179 天`（有哪截写哪截，都没有就整条不占位）。
 *
 * · 价格 0 不写：hub 后台那一格写着「留空或 0 为免费」，把「没填」也印成「免费」是在替站长断言。
 * · 到期优先用 hub 算好的 `expires_in`（按 hub 的时区算、在线机器还会顺延），只有旧 hub 没这个
 *   key 时才退回按 `expires_at` 自己数（见 @/lib/format 的 daysUntil）。
 */
function noteText(node: Node): string {
  const cycle = CYCLE_SHORT[node.billing_cycle]
  const price = node.price > 0 ? `价格 ${money(node.price, node.currency)}${cycle ? `/${cycle}` : ""}` : ""
  const days = node.expires_in !== undefined ? node.expires_in : daysUntil(node.expires_at)
  const left = days === null || days === undefined ? ""
    : days < 0 ? `已过期 ${-days} 天` : days === 0 ? "今天到期" : `剩余 ${days} 天`
  return [price, left].filter(Boolean).join(" · ")
}

// Traffic uses the plan's own counting rule, so the bar matches the quota the
// node is billed against.
function trafficFoot(node: Node) {
  return node.traffic_limit > 0
    ? pair(monthUsage(node), node.traffic_limit)
    : `${bytes(monthUsage(node))} / ${FOREVER}`
}

/**
 * 底注那一行最多摊几枚备注小卡片。底注只有一行：贪多就会把「价格 / 剩余」挤到看不见，
 * 而那个恰恰是访客问「这台还剩多久」时先找的那一句。
 */
const CHIPS = 3

/**
 * 一个读数格：表名在上、读数在中、条在下 —— 卡片上四个格子（CPU / 内存 / 存储 / 负载）都是它。
 *
 * 表名是弱化灰的小字（12px），读数 13px / 600（那一格的重心），条 3px 压在读数下缘、铺满整格宽。
 * ★ 填色是**前景色的 70%**（与经典 / 简约那两档同一族）：一页 4×N 根条排下来不压读数，
 * 低百分比的短条也还认得出来（口径与判据见 NodeCard 的 Meter）。
 *
 * `pct` 为 null（这台没上报 / 这一项没有上限）时轨道留空、不画填色，读数由调用方写成「—」：
 * 一条 0% 的实心条会被读成「用得很少」，而真相是「不知道」。
 */
function Readout({ label, value, pct, title }: { label: string; value: string; pct: number | null; title?: string }) {
  const filled = pct === null ? 0 : Math.min(100, Math.max(0, pct))
  return (
    <div className="min-w-0" title={title}>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="tnum mt-0.5 truncate text-[13px] font-semibold leading-[18px]">{value}</div>
      <div className="mt-1 h-[3px] w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-foreground/70 transition-[width] duration-500" style={{ width: `${filled}%` }} />
      </div>
    </div>
  )
}

export function WideCard({ node, onOpen, onWarm, terms, remarkPlacement, selected }: {
  node: Node
  onOpen: () => void
  /** 指针或键盘刚落到这张卡片上：先把手头这块 chunk（详情页的图表）取回来。 */
  onWarm?: () => void
  /** 搜索命中词：名字里描色（见 Highlight）。没在搜时是空数组。 */
  terms?: string[]
  /** 「备注显示位置」：`detail` 时卡片这一侧一枚都不摊（整页详情照旧，见 NodeDetail）。 */
  remarkPlacement?: RemarkPlacement
  /** 键盘光标（↑↓）停在这张卡上：加一圈描边。 */
  selected?: boolean
}) {
  const m = node.metrics
  // 备注小卡片：先按「备注显示位置」判这一侧要不要摊，再交给 @/lib/notes 拆（私有在前、公有在后）；
  // 底注只有一行，只取前 CHIPS 枚。访客那边 hub 只下发公有那几枚，所以同一个位置他们看到的就是公有。
  const chips = remarksOnCards(remarkPlacement ?? "both") ? remarkChips(node).slice(0, CHIPS) : []
  const note = noteText(node)
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
      // 键盘光标（搜索框里 ↑↓ 选中的那台）停在上面时加一圈 2px 描边：用 outline 而不是
      // border/ring —— 不占盒宽、不改网格（用 border 会让这张卡大一圈、把邻居挤动）。
      // data-node-card 是滚动定位（见 App 的 NodeList）与护栏共用的锚点；
      // data-selected 是「当前被键盘选中」的标记（护栏读它，不用去解析类名）。
      data-node-card={node.id}
      data-selected={selected ? "1" : undefined}
      // 卡片内边距照参考站那一档：上下 12px / 左右 16px（其余几档是四面 16px）。
      className={`min-w-0 cursor-pointer gap-0 px-4 py-3 transition-colors hover:border-foreground/25 ${selected ? "outline-2 outline-offset-1 outline-ring" : ""}`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
    >
      {/* ① 身份行：旗子 + 名字。
          不带状态点、不带徽章（2026-10-15 按站长要求与其余形态统一）——在线与否写在②那行
          文字里（「已离线 / 未接入 / 在线」）。名字加粗一档。搜索命中处描色（Highlight：mark
          不改变 textContent，既有文案断言照旧；没在搜时它原样返回，零影响）。 */}
      <div className="flex min-w-0 items-center gap-2">
        <Country node={node} />
        <h3 className="min-w-0 flex-1 truncate font-semibold leading-5"><TextHighlight text={node.name} terms={terms} /></h3>
      </div>

      {/* ② 系统 · 运行时间：与名字左对齐的一行灰字（@/lib/format 的 osName 去掉代号那截）。 */}
      <p className="mt-0.5 truncate text-xs text-muted-foreground">{metaLine(node)}</p>

      {/* One layout for both states: a disconnected node still knows its
          cores, memory, disk size and traffic totals, and showing those with
          the live figures blank beats a stretched card with one line in it. */}
      {deployed(node) ? (
        <>
          {/* ③ 四个读数格：参考站的口径是「表名 / 读数 / 条」一列到底，上面一条分隔线把头部
              与读数区隔开。格子里只剩百分比：核数、已用 / 总量挪进各自的悬停说明（Readout 的
              title），整页详情里仍然写全。 */}
          <div data-metrics="" className="mt-1.5 grid grid-cols-4 gap-x-3 border-t pt-1.5">
            <Readout
              label="CPU"
              title={`${node.cpu_cores} 核`}
              pct={m ? m.cpu : null}
              value={m ? `${m.cpu.toFixed(2)}%` : "—"}
            />
            <Readout
              label="内存"
              title={m ? pair(m.mem_used, m.mem_total) : bytes(node.mem_total)}
              pct={m ? percent(m.mem_used, m.mem_total) : null}
              value={m ? `${percent(m.mem_used, m.mem_total).toFixed(2)}%` : "—"}
            />
            <Readout
              label="存储"
              title={m ? pair(m.disk_used, m.disk_total) : bytes(node.disk_total)}
              pct={m ? percent(m.disk_used, m.disk_total) : null}
              value={m ? `${percent(m.disk_used, m.disk_total).toFixed(2)}%` : "—"}
            />
            {/* 负载：读数是 1 分钟均值，条按「满载的几成」上色（见 loadPct），三条均值在悬停说明里。 */}
            <Readout
              label="负载"
              title={m ? `1 / 5 / 15 分钟：${m.load.map((n) => n.toFixed(2)).join(" ")}` : undefined}
              pct={loadPct(node)}
              value={m ? m.load[0].toFixed(2) : "—"}
            />
          </div>

          {/* ④ 上传 / 下载：左上传、右下载，中间一道竖线把两栏分开。
              速率是这一块的重心（大字加粗）；累计总量弱化成灰字跟在标签那一行的右端。
              箭头保留 ↑ / ↓（可以整段复制），颜色取弱化灰（与经典档的 ↑ ↓ 同一口径，
              2026-10-15 由绿色收齐）。`data-net="duo"` 是给护栏认这一块用的锚点。 */}
          <div data-net="duo" className="mt-1.5 grid grid-cols-2">
            <div className="min-w-0 pr-3">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="shrink-0"><span className="text-muted-foreground">↑</span> 上传</span>
                <span className="tnum min-w-0 truncate text-muted-foreground">累计 {bytes(node.total_tx)}</span>
              </div>
              <div className="tnum mt-0.5 truncate text-base font-semibold leading-[18px]">{m ? rate(m.net_tx) : "—"}</div>
            </div>
            <div className="min-w-0 border-l pl-3">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="shrink-0"><span className="text-muted-foreground">↓</span> 下载</span>
                <span className="tnum min-w-0 truncate text-muted-foreground">累计 {bytes(node.total_rx)}</span>
              </div>
              <div className="tnum mt-0.5 truncate text-base font-semibold leading-[18px]">{m ? rate(m.net_rx) : "—"}</div>
            </div>
          </div>

          {/* ⑤ 总流量：数字行（左：已用 / 额度，右：重置日；没有额度就写 N/A），再下面一条全宽
              进度条 —— 用量按套餐的计流量方式算（trafficFoot / monthUsage）。 */}
          <div className="tnum mt-1.5 flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="min-w-0 truncate">{trafficFoot(node)}</span>
            <span className="shrink-0">
              流量重置：{node.traffic_limit > 0 ? `每月 ${node.traffic_reset_day} 日` : "N/A"}
            </span>
          </div>
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-foreground/70 transition-[width] duration-500"
              style={{ width: `${node.traffic_limit > 0 ? percent(monthUsage(node), node.traffic_limit) : 0}%` }}
            />
          </div>

          {/* ⑥ 底注：价格 / 到期在左、备注小卡片在右；两截都没有就整行不占位。
              `data-remark="card"` 是护栏的锚点（与详细档标题行的 `data-remark="title"` 分开）。 */}
          {(note || chips.length > 0) && (
            <div className="mt-1.5 flex min-w-0 items-center justify-between gap-2">
              <span className="tnum min-w-0 truncate text-[11px] leading-4 text-muted-foreground">{note}</span>
              {chips.length > 0 && (
                <span data-remark="card" className="flex min-w-0 shrink items-center justify-end gap-1">
                  <RemarkChips chips={chips} />
                </span>
              )}
            </div>
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

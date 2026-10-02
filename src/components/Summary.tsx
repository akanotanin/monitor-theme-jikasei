import type { ReactNode } from "react"
import { ArrowDown, ArrowUp } from "lucide-react"

import { Card } from "@/components/ui/card"
import { speedHistory, type Node } from "@/lib/api"
import { bytes, rate } from "@/lib/format"
import { budgetOf, cny, fxNote } from "@/lib/money"
import { summarize, type Fleet } from "@/lib/summary"

/**
 * 列表页顶上那行概览卡片，两副面孔（主题设置的「列表页顶部」里选）：
 *
 *   原版（summary / both）——四张卡片，各一块读数：节点 / 最忙节点 / 今日流量 / 实时网速。
 *   月度预算剩余价值版（budget / bothBudget）——四张卡片，但前两张各排两块读数：
 *     ① 月度预算 + 剩余价值（口径见 lib/money.ts）
 *     ② 节点 + 最忙节点（照参考图：节点挪到原先最忙节点那一侧、最忙节点往右让位，
 *        两块分居同一张卡片的两端，下沿对齐）
 *     后两张两副面孔完全一样。
 *
 * 两副面孔的数据都来自 `/api/nodes` 里本来就有的字段，开着它不会多发一个请求——唯一的
 * 例外是第四张下面那条走势线，它画的是访客打开页面之后自己攒下的实时速率（api.ts 的
 * `speedHistory`，每 2 秒一个采样、留最近 60 个 ≈ 2 分钟）：hub 没有「全站速率历史」
 * 这种接口，刷新页面就得重新攒，所以冷启动头几秒那里是空的。
 *
 * 默认不显示（主题设置的「列表页顶部」没选它）。站点本来就有每台机器自己的卡片，
 * 不需要概览的站不必为此让出首屏；没选时这个组件整个不挂载。
 */

/**
 * 一块读数：一行小标签、一行大数字、一行小字。
 *
 * 卡片是 flex、块是 flex-col，所以块里的 `mt-auto` 能把底部那行压到同排最高的那块的下沿，
 * 内容行数不同也对齐（例如「无在线节点」与「1 台离线」落在同一条基线上）。它在块本身高度
 * 有富余时才起作用；刚好装下时那行就紧跟在数字下面（`pt-1`）——也就是参考站那种三段式。
 *
 * 标签前不带图标：参考站的四张卡都没有，图标只是把标签挤窄、并把整行垫高。
 */
function Block({ title, hint, children }: {
  title: string
  /** 悬停提示：口径说明——月度预算与剩余价值那两个数不是一眼能看懂的，得写清楚。 */
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col" title={hint}>
      <div className="truncate text-xs text-muted-foreground">{title}</div>
      {children}
    </div>
  )
}

/** 一块读数里的主数字。`tnum` 让数字等宽：每两秒刷一次时不会左右抖。 */
function Big({ children }: { children: ReactNode }) {
  return <div className="tnum mt-1 truncate text-2xl font-semibold tracking-tight">{children}</div>
}

/** 一块读数底下那行小字（卡片两端对齐时它落在下沿）。 */
function Foot({ children }: { children: ReactNode }) {
  return <div className="tnum mt-auto truncate pt-1 text-xs text-muted-foreground">{children}</div>
}

/** 一张卡片：里面就一块读数（今日流量 / 实时网速，以及原版的每一张）。 */
function Tile({ children }: { children: ReactNode }) {
  return <Card className="min-w-0 gap-0 p-4">{children}</Card>
}

/**
 * 一张卡片里两块读数：**两块平分**（`grid-cols-2` + 同一个 `gap-x-2`），所以两张卡里的第二块
 * 读数落在同一条竖线上，而且与「今日流量 / 实时网速」两张卡里那张两列小栅格的第二列同一落点
 * —— 整行四张卡读起来是一个栅格（站长挑的排法：最素、不要分隔线）。
 *
 * 早先试过 `justify-between`（块宽按内容走）：剩余价值（≈¥191.94）比最忙节点（51.0%）宽，
 * 两张卡的右列起点差 18px（1440）/17px（390），被框出来报过；也试过固定 45% 的右列，列对齐了
 * 但与前两张卡不是一个节奏。护栏里两条都钉着（同一列 + 同一落点）。
 *
 * 下沿对齐靠 `items-stretch`（块撑满卡片高度，grid 的默认值）+ Block 里的 `mt-auto`。
 */
function Pair({ children }: { children: ReactNode }) {
  return (
    <Card className="grid min-w-0 grid-cols-2 gap-x-2 gap-y-0 p-4">
      {children}
    </Card>
  )
}

/**
 * 一枚带方向箭头的读数。颜色随所在那一行（今日那行是前景色，累计那行是弱化灰）。
 *
 * 箭头 12px、与数字的间距 4px（原为 14 / 6）：概览卡片那两列数字的宽度是按像素抠出来的，
 * 这 4px 直接进文字框（见 Unit 那段注释），观感上分辨不出。
 */
function Val({ icon: Icon, children }: {
  icon: typeof ArrowDown
  children: ReactNode
}) {
  return (
    <span className="tnum inline-flex min-w-0 items-center gap-1">
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{children}</span>
    </span>
  )
}

/**
 * 读数里的「数字 / 单位」两段：数字保持 24px，单位（含 `/s`）降一档 —— 16px、常规字重、
 * 弱化灰，与「节点」卡里那个 `/ 4` 同一套写法。
 *
 * 为的是宽度。这一行是 `grid grid-cols-2` + `truncate`，每格的文字框 = 格宽 − 16px
 * （箭头 12 + 间距 4），而四列布局下卡片最宽 299px → 文字框最多 111px，最窄的四列
 * （1024 那档）只有 77px。24px 的「112.6 KB/s」要 109px、「1023.9 KB/s」要 122px，
 * 装不下就被静默截成「112.6 K…」——站长报过的「概览卡片有概率显示不全」就是这个：
 * 读数越长、视口越窄越容易中招。三道一起收：单位降一档（省 20px，见下）、
 * `rate()` 的三位有效数字（最长「999 KB/s」71px）、箭头与间距各收一档（省 4px）。
 *
 * 只给上面那行 24px 的大数用（今日流量 / 实时网速）：底部那行小字本来就是 12px，
 * 单位再「降档」会比数字还大。空格留在单位前而不是用 `ml-*` 撑间距——否则复制文本
 * 与读屏会把两个词黏成「112.6KB/s」。
 */
function Unit({ children }: { children: string }) {
  const m = children.match(/^([0-9.,]+)\s*(.+)$/)
  if (!m) return <>{children}</>
  return (
    <>
      {m[1]}
      <span className="text-base font-normal text-muted-foreground"> {m[2]}</span>
    </>
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
    /* 走势线的高度照着参考站那条来（那边约 22px）：这一格是卡片里唯一不是文字的东西，
       高了整行四张卡就不再等高（护栏钉着「四张卡等高」）。 */
    <div className="mt-1 h-5">
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

/** 「节点」那块读数：在线 / 总数 + 离线台数。两副面孔共用，块本身一模一样。 */
function NodesBlock({ fleet }: { fleet: Fleet }) {
  const offline = fleet.total - fleet.online
  return (
    <Block title="节点">
      {/* 斜杠与总数照参考站降一档（16px / 常规字重 / 弱化灰），只有在线数是那个大数。
          空格照旧留着：抹掉它复制与读屏会得到「3/4」这种黏成一团的写法。 */}
      <Big>
        {fleet.online} <span className="text-base font-normal text-muted-foreground">/ {fleet.total}</span>
      </Big>
      <Foot>
        {fleet.total === 0 ? "还没有节点" : offline === 0 ? "全部在线" : `${offline} 台离线`}
      </Foot>
    </Block>
  )
}

/** 「最忙节点」那块读数：CPU 占用最高的在线节点。 */
function BusiestBlock({ fleet }: { fleet: Fleet }) {
  return (
    <Block title="最忙节点">
      {/* 一位小数，与卡片里 CPU 那格同一个口径。 */}
      <Big>{fleet.busiest ? `${fleet.busiest.cpu.toFixed(1)}%` : "—"}</Big>
      <Foot>
        {fleet.busiest ? fleet.busiest.name : "无在线节点"}
      </Foot>
    </Block>
  )
}

export function SummaryCards({ nodes, finance = false }: { nodes: Node[]; finance?: boolean }) {
  const fleet = summarize(nodes)
  const budget = budgetOf(nodes)
  // 模块级的采样缓冲：`useNodes` 每次收到推送（或轮询回来）就追加一个点，
  // 所以这里读到的是「打开页面到现在」的全站速率，与分组筛选无关。
  const series = speedHistory.get(null) ?? []
  // 折算说明：只列真的用到过的币种——各站的账混着 USD / EUR / CNY 记，合起来必须说明口径。
  const note = fxNote(budget.used, budget.skipped)

  return (
    /* 版式照参考站：`sm` 起两列、`lg` 起四列。**手机是一列而不是参考站的两列**——参考站每张
       卡只有一个大数，两个数并排也放得下；本站的「今日流量 / 实时网速」一张卡里有两个方向，
       390px 两列时每张卡只有 173px、两个数会各自截断（护栏量过）。 */
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {finance ? (
        <>
          {/* 第一张卡：月度预算 + 剩余价值。两个数都是把各站的账按固定汇率折成人民币后相加，
              所以写「≈」；口径与汇率清单放在悬停提示里（见 lib/money.ts）。 */}
          <Pair>
            <Block title="月度预算" hint={`各节点的价格按计费周期摊到每个月后相加；一次性买断与没填价格的不计入。${note}`}>
              <Big>{budget.monthly === null ? "—" : `≈${cny(budget.monthly)}`}</Big>
              <Foot>{budget.monthlyCount ? `${budget.monthlyCount} 台计费` : "未记录价格"}</Foot>
            </Block>
            <Block title="剩余价值" hint={`已经付掉、还没用掉的那一段：价格 × 剩余天数 ÷ 周期天数；无到期日与一次性买断的不计入。${note}`}>
              <Big>{budget.remaining === null ? "—" : `≈${cny(budget.remaining)}`}</Big>
              <Foot>{budget.remainingCount ? `${budget.remainingCount} 台未到期` : "无预付到期"}</Foot>
            </Block>
          </Pair>

          {/* 第二张卡：节点 + 最忙节点，与上面同一套排法——两块读数分居卡片两端。 */}
          <Pair>
            <NodesBlock fleet={fleet} />
            <BusiestBlock fleet={fleet} />
          </Pair>
        </>
      ) : (
        <>
          <Tile>
            <NodesBlock fleet={fleet} />
          </Tile>

          <Tile>
            <BusiestBlock fleet={fleet} />
          </Tile>
        </>
      )}

      <Tile>
        <Block title="今日流量">
          {/* 大数一行（今日上下行），累计并成一行小字——参考站整张卡就是「小标签 / 大数 /
              一行小字」三段，这样四张卡等高、整行才是一个节奏。四个数一个没少。
              栅格间距沿用 `gap-x-2`（与 Pair 同一个值）：整行四张卡的第二列因此落在同一条
              竖线上（护栏钉着）。 */}
          <div className="mt-1 grid grid-cols-2 gap-x-2 text-2xl font-semibold tracking-tight">
            <Val icon={ArrowDown}><Unit>{bytes(fleet.dayRx)}</Unit></Val>
            <Val icon={ArrowUp}><Unit>{bytes(fleet.dayTx)}</Unit></Val>
          </div>
          <Foot>
            <span className="inline-flex items-center gap-1.5">
              总流量
              <Val icon={ArrowDown}>{bytes(fleet.totalRx)}</Val>
              <Val icon={ArrowUp}>{bytes(fleet.totalTx)}</Val>
            </span>
          </Foot>
        </Block>
      </Tile>

      <Tile>
        <Block title="实时网速">
          <div className="mt-1 grid grid-cols-2 gap-x-2 text-2xl font-semibold tracking-tight">
            <Val icon={ArrowDown}><Unit>{rate(fleet.netRx)}</Unit></Val>
            <Val icon={ArrowUp}><Unit>{rate(fleet.netTx)}</Unit></Val>
          </div>
          <Sparkline series={series} />
        </Block>
      </Tile>
    </div>
  )
}

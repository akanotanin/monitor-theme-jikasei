import type { ReactNode } from "react"

/**
 * 图表 tooltip：本主题自己画的那一枚。
 *
 * 用自绘而不是 recharts 默认的那张：默认 tooltip 每个点只给「名字 + 值」一行，
 * 延迟图里四条线路叠在一起时看不出谁最慢、谁在丢包，而且要按当前主题色去配一套
 * 样式。改成一张列表面板——每条曲线一枚同色圆点、名字、值，需要时后面再跟一小段
 * 尾巴（丢包率），最差的一条排最前，窄屏只列前几条、其余折成「另有 N 条」。
 *
 * 值不是有限数（探测超时）时默认整行不列：一条没有数据的线画不出来，列出来只会
 * 让人以为它是 0。要保留这种行的地方（延迟图，超时恰恰是要看的）在 `keepEmpty`
 * 里说明，右侧改印 `emptyText`。
 */
export type TooltipEntry = {
  dataKey?: string | number
  name?: string | number
  value?: number | string | null
  color?: string
  payload?: Record<string, unknown>
}

export type ChartTooltipProps = {
  /** recharts 注入。 */
  active?: boolean
  payload?: TooltipEntry[]
  label?: string | number
  /** 数字怎么印：百分比 / 字节 / 速率各一处。 */
  format: (value: number) => string
  /** 一行里除「名字 + 值」之外的尾巴，例如丢包率。 */
  trailing?: (entry: TooltipEntry) => ReactNode
  /** 最差的一条排最前：几条线路叠在一起时，先看的永远是最慢的那条。 */
  worstFirst?: boolean
  /** 窄屏只列前 N 条，其余折成「另有 N 条」；不传则全列。 */
  capNarrow?: number
  /** 值缺失时仍要保留的条目（延迟图里那条在丢包的线）。 */
  keepEmpty?: (entry: TooltipEntry) => boolean
  /** 值缺失时右侧印什么，默认破折号。 */
  emptyText?: string
  /** 排序键，默认按 `value`。 */
  sortKey?: (entry: TooltipEntry) => number
}

const finite = (entry: TooltipEntry) =>
  entry.value !== null && entry.value !== undefined && Number.isFinite(Number(entry.value))

// 640px：与卡片网格的 `sm:` 断点同一处，窄屏上一张 tooltip 最多也就压住七十来字。
const NARROW = 640

export function ChartTooltip({
  active,
  payload,
  label,
  format,
  trailing,
  worstFirst,
  capNarrow,
  keepEmpty,
  emptyText,
  sortKey,
}: ChartTooltipProps) {
  if (!active || !payload?.length) return null
  const rows = payload.filter((entry) => finite(entry) || (keepEmpty?.(entry) ?? false))
  if (!rows.length) return null
  const key = sortKey ?? ((entry: TooltipEntry) => Number(entry.value))
  const ordered = worstFirst ? [...rows].sort((a, b) => key(b) - key(a)) : rows
  const narrow = typeof window !== "undefined" && window.innerWidth < NARROW
  const shown = narrow && capNarrow ? ordered.slice(0, capNarrow) : ordered

  return (
    <div className="pointer-events-none max-w-[70vw] rounded-lg border bg-popover px-2 py-1.5 text-[11px] leading-tight shadow-md">
      {/* 时间戳自己格式化：默认 tooltip 的标题在这套样式里字号偏大，而且 hub 给的是秒。 */}
      <div className="mb-1 text-muted-foreground">{new Date(Number(label)).toLocaleString("zh-CN")}</div>
      <ul className="space-y-px">
        {shown.map((entry) => (
          <li key={String(entry.dataKey)} className="flex items-center gap-1.5 whitespace-nowrap">
            {/* 与线上同色同线型的那枚小圆点。 */}
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: entry.color }} />
            <span>{entry.name}</span>
            {finite(entry) ? (
              <span className="tnum ml-auto pl-2 font-medium">{format(Number(entry.value))}</span>
            ) : (
              <span className="ml-auto pl-2 text-muted-foreground">{emptyText ?? "—"}</span>
            )}
            {trailing?.(entry)}
          </li>
        ))}
      </ul>
      {narrow && capNarrow && ordered.length > shown.length && (
        <div className="mt-1 text-muted-foreground">另有 {ordered.length - shown.length} 条</div>
      )}
    </div>
  )
}

/** 延迟图的一行里，丢包率挂在 `l<id>` 上（`t<id>` / `s<id>` 是曲线本身）。 */
const lossOf = (entry: TooltipEntry) => Number(entry.payload?.[`l${String(entry.dataKey ?? "").slice(1)}`] ?? 0)

/**
 * 延迟图的 tooltip：最慢的线路排最前，超时的线路保留并标「无响应」，有丢包的
 * 在后面缀一小段丢包率——只画「答上来的那些」的线看起来和健康线路一模一样。
 */
export function PingTooltip({
  active,
  label,
  rowByTs,
  probes,
  smooth,
  style,
}: {
  active?: boolean
  label?: string | number
  rowByTs: Map<number, Record<string, number | [number, number] | null>>
  probes: { id: number; name: string }[]
  smooth: boolean
  style: (id: number) => { stroke: string }
}) {
  if (!active) return null
  const row = rowByTs.get(Number(label))
  if (!row) return null
  const payload = probes.map((probe) => {
    const dataKey = `${smooth ? "s" : "t"}${probe.id}`
    return {
      dataKey,
      name: probe.name,
      color: style(probe.id).stroke,
      value: (row[dataKey] ?? null) as number | null,
      payload: row,
    }
  })
  return (
    <ChartTooltip
      active
      label={label}
      payload={payload}
      worstFirst
      capNarrow={5}
      format={(value) => `${value} ms`}
      // 没答上来的排最后：它们是「没有值」，不是「很快」。
      sortKey={(entry) => (entry.value == null ? Number.MAX_SAFE_INTEGER : Number(entry.value))}
      keepEmpty={(entry) => lossOf(entry) > 0}
      emptyText="无响应"
      trailing={(entry) => {
        const loss = lossOf(entry)
        return loss > 0 ? <span className="tnum pl-1 text-muted-foreground">丢 {loss}%</span> : null
      }}
    />
  )
}

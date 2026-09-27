import { useEffect, useMemo, useState } from "react"

import { api, type Node } from "@/lib/api"

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
 * 拉本节点最近一小时的延迟：点数取 40，够画一条能看出起伏的走势线，又不至于让每张
 * 卡片多背一大坨。失败与「这段时间没有延迟数据」都收敛成空数组，卡片上什么都不画。
 */
function useNodePing(id: number): Probe[] | null {
  const [probes, setProbes] = useState<Probe[] | null>(null)
  useEffect(() => {
    let alive = true
    acquire().then(() => {
      if (!alive) {
        release()
        return
      }
      api<{ ping?: PingPoint[]; probes?: Probes; loss?: Loss }>(
        `/nodes/${id}/metrics?hours=1&points=40&series=ping`,
      )
        .then((d) => { if (alive) setProbes(normalize(d)) })
        .catch(() => { if (alive) setProbes([]) })
        .finally(release)
    })
    return () => { alive = false }
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

/** 走势线：无坐标轴、无交互，只把这一小时的起伏画出来；断点照断，不连桥。 */
function Sparkline({ values, className }: { values: Array<number | null>; className: string }) {
  const nums = values.filter((v): v is number => v !== null)
  if (nums.length < 2) return <span className="min-w-0 flex-1" />
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  const span = max - min || 1
  const x = (i: number) => (values.length <= 1 ? 0 : (i * SPARK_W) / (values.length - 1))
  const y = (v: number) => SPARK_H - 2 - ((v - min) / span) * (SPARK_H - 4)
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
      className={`h-4 min-w-0 flex-1 ${className}`}
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
 * 卡片底部那组「三网延迟」：一条线路一行——线路名、当前延迟、一小时走势、丢包率。
 * 数据来自 hub 的 ping 历史（同详情页的延迟图），按 `task_id` 一条一条摊开；线路名用的是
 * 站长在后台给 ping 任务起的名字，所以「广东电信」这类带地域的叫法原样呈现。
 * 延迟与走势只走灰阶，越糟越深（见 toneClass）。站长可在后台「三网延迟」里指定显示哪几条
 * （按 ping 任务名匹配，一行一个，最多三条）；留空时按后台顺序自动取前几条。
 */
export function LatencyPanel({ node, lines }: { node: Node; lines: string }) {
  const probes = useNodePing(node.id)
  // 填了名字就只显示这些、按填写的顺序（最多三条）；留空则按后台顺序自动取前几条。
  // 匹配用的是 ping 任务的名字，改过名、删过任务的那一行自然落空，不占位。
  const rows = useMemo(() => {
    const all = probes ?? []
    const wanted = [...new Set(lines.split("\n").map((s) => s.trim()).filter(Boolean))]
    if (wanted.length === 0) return all.slice(0, 4)
    const byName = new Map<string, Probe>()
    for (const p of all) if (!byName.has(p.name)) byName.set(p.name, p)
    return wanted.slice(0, 3).map((name) => byName.get(name)).filter((p): p is Probe => p !== undefined)
  }, [probes, lines])
  if (rows.length === 0) return null
  return (
    <div className="mt-4 space-y-1.5 border-t pt-4">
      {rows.map((p) => {
        const last = [...p.points].reverse().find((pt) => pt.latency !== null)
        const ms = last?.latency ?? null
        const tone = toneOf(ms, p.loss)
        const gray = toneClass(tone)
        return (
          <div key={p.id} className="flex items-center gap-2 text-xs">
            <span className="w-16 shrink-0 truncate text-muted-foreground">{p.name}</span>
            <span className={`tnum w-14 shrink-0 text-right font-medium ${gray}`}>
              {ms === null ? "超时" : `${ms} ms`}
            </span>
            <Sparkline values={p.points.map((pt) => pt.latency)} className={gray} />
            <span className="tnum w-10 shrink-0 text-right text-muted-foreground">
              {p.loss > 0 ? `${p.loss.toFixed(1)}%` : "0.0%"}
            </span>
          </div>
        )
      })}
    </div>
  )
}

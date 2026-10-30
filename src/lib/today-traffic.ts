import { api, type Node } from "./api.ts"

/**
 * 「今日流量」那张概览卡片里的**节点明细**（2026-10-30 站长要求）。
 *
 * 卡片面上一共只有两个数（今天的下行 / 上行总量，来自 `/api/nodes`）；展开后要看的是
 * **每台机器今天收发了多少、以及今天的采样峰值是什么时候冲上去的**。前半截同样是
 * `/api/nodes` 里现成的（`day_rx / day_tx`），后半截 hub 没有聚合接口 —— 只能一台一个
 * `/api/nodes/<id>/metrics` 请求，回来自己取最高点。
 *
 * 峰值取的是历史桶里的 `net_rx_max / net_tx_max`（**桶内最高**那一档，hub 自己算好的），
 * 没有这两列的老 hub 退回桶均值 `net_rx / net_tx`：那会把峰值抹平，但总比不给数强。
 * 桶宽由请求的 `points` 决定（这里按两分钟一个桶要），所以峰值时刻的精度也就是两分钟 ——
 * 浮层尾巴上写明「按历史采样计算」，与卡片面那两个精确的累计值区分开。窗口另按今天的 0 点
 * 裁一刀：hub 的 `hours` 下限是 1，刚过零点时那一段会伸到昨天去（见 fetchOne）。
 *
 * 缓存 60 秒、同一台不并发重复取：浮层开关几次不该反复打 hub（hub 的历史查询有 4 个
 * 并发闸门，超了回 503）。
 */

/** 历史桶里用得上的那几列：`ts` 是秒；`*_max` 是桶内最高、没有就退回均值。 */
export type TrafficRow = {
  ts: number
  net_rx?: number | null
  net_tx?: number | null
  net_rx_max?: number | null
  net_tx_max?: number | null
}

export type TrafficPeak = {
  /** 窗口内最高的下行速率（B/s）。 */
  down: number
  /** 那一刻的毫秒时间戳；窗口里一个采样都没有时为 null。 */
  downAt: number | null
  up: number
  upAt: number | null
}

export const NO_PEAK: TrafficPeak = { down: 0, downAt: null, up: 0, upAt: null }

/** 本机时区的今天 00:00（毫秒）。 */
export function dayStart(now = Date.now()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 要向 hub 要哪一段：从今天 00:00 到现在。
 *
 * `hours` 下限 1（hub 把 hours 钳在 1 以上；刚过零点时不能要 0）；`points` 按「两分钟一个桶」
 * 估算，下限 60（一小时一桶太粗，峰值时刻会差到小时）、上限 720（一天），免得跨了保留天数
 * 之外的窗口要出天文数字。
 */
export function windowFor(now = Date.now()): { hours: number; points: number } {
  const hours = Math.max(1, Math.ceil((now - dayStart(now)) / 3_600_000))
  return { hours, points: Math.min(720, Math.max(60, hours * 30)) }
}

/** 一批历史桶里最高的上行 / 下行，各带发生时刻（毫秒）。 */
export function peakOf(rows: TrafficRow[]): TrafficPeak {
  const peak: TrafficPeak = { ...NO_PEAK }
  for (const row of rows) {
    // 负数只可能来自坏样本：按 0 处理，别让它把「最高」压成负的。
    const down = Math.max(0, row.net_rx_max ?? row.net_rx ?? 0)
    const up = Math.max(0, row.net_tx_max ?? row.net_tx ?? 0)
    const at = row.ts * 1000
    if (down > peak.down) {
      peak.down = down
      peak.downAt = at
    }
    if (up > peak.up) {
      peak.up = up
      peak.upAt = at
    }
  }
  return peak
}

/**
 * 只在**今天**那一段里挑峰值。窗口是从「现在回溯 hours 小时」来的（hub 的 hours 下限 1），
 * 刚过零点那一段会伸到昨天；峰值时刻要是昨晚的，与「今天」这个标题就对不上。
 */
export function peakToday(rows: TrafficRow[], now = Date.now()): TrafficPeak {
  const since = dayStart(now) / 1000
  return peakOf(rows.filter((row) => row.ts >= since))
}

/** 今天收发了多少（上行 + 下行），明细按它降序排。 */
export function trafficTotal(node: Node): number {
  return Math.max(0, node.day_rx) + Math.max(0, node.day_tx)
}

/** 浮层里最多给多少台取峰值：今天流量最大的那些，其余那几台只剩「今日流量」一栏。 */
export const PEAK_LIMIT = 48

/** 缓存 60 秒。 */
const TTL = 60_000
const cache = new Map<number, { at: number; peak: TrafficPeak }>()
const inflight = new Map<number, Promise<TrafficPeak>>()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** hub 的历史查询有并发闸门（超了回 503）：这一台单独取，让一层重试兜住那一下。 */
async function fetchOne(node: Node, now: number): Promise<TrafficPeak> {
  const { hours, points } = windowFor(now)
  const path = `/nodes/${node.id}/metrics?hours=${hours}&points=${points}&series=metrics`
  // 窗口从「现在往回 hours 小时」算，而 hours 下限是 1 —— 刚过零点那会儿这一段会伸到昨天。
  // 交给 peakToday 按今天的 0 点裁一刀（2026-10-31 00:2x 实测：不裁的话峰值时刻全是昨晚的）。
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await api<{ metrics?: TrafficRow[] }>(path)
      return peakToday(data.metrics ?? [], now)
    } catch (e) {
      // 只对「忙 / 网络抖动」重试一次；404（主题删了这台）之类的立刻放弃。
      const status = (e as { status?: number }).status
      if (attempt >= 1 || (status !== undefined && status !== 429 && status !== 503)) throw e
      await sleep(250)
    }
  }
}

/** 取一台的峰值（命中缓存就直接给）。 */
export function peakFor(node: Node, now = Date.now()): Promise<TrafficPeak> {
  const hit = cache.get(node.id)
  if (hit && now - hit.at < TTL) return Promise.resolve(hit.peak)
  const running = inflight.get(node.id)
  if (running) return running
  const job = fetchOne(node, now)
    .then((peak) => {
      cache.set(node.id, { at: Date.now(), peak })
      return peak
    })
    .finally(() => inflight.delete(node.id))
  inflight.set(node.id, job)
  return job
}

/**
 * 给这批节点取峰值：**边取边回**（`onPeak` 每回来一台就叫一次，浮层不用等齐），
 * 同时在飞的请求不超过 `concurrency` 个 —— 那正是 hub 的闸门宽度，再多只会换回 503。
 * 单台失败不影响别的台（那一台留在 `failed` 里，浮层标「—」）。
 */
export async function fetchTrafficPeaks(nodes: Node[], options: {
  now?: number
  onPeak?: (id: number, peak: TrafficPeak) => void
  /** 取到一半浮层关掉了：不再发起**新的**请求（在飞的那几个照常收尾、结果进缓存）。 */
  stopped?: () => boolean
  concurrency?: number
} = {}): Promise<{ peaks: Map<number, TrafficPeak>; failed: number[] }> {
  const { now = Date.now(), onPeak, stopped, concurrency = 4 } = options
  const peaks = new Map<number, TrafficPeak>()
  const failed: number[] = []
  // 只给今天流量最大的那些取峰值（见 PEAK_LIMIT）。浮层也只列这些台（2026-10-31 起）——
  // 列出来却没取峰值的行会是一排「—」，读起来像「这些机器没有采样」，比不列更容易误会。
  const queue = [...nodes]
    .sort((a, b) => trafficTotal(b) - trafficTotal(a))
    .slice(0, PEAK_LIMIT)

  let next = 0
  const worker = async () => {
    while (next < queue.length) {
      if (stopped?.()) return
      const node = queue[next++]
      try {
        const peak = await peakFor(node, now)
        peaks.set(node.id, peak)
        onPeak?.(node.id, peak)
      } catch {
        failed.push(node.id)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  return { peaks, failed }
}

/** 护栏/调试用：把缓存丢掉（下一次重新向 hub 取）。 */
export function clearTrafficPeakCache() {
  cache.clear()
  inflight.clear()
}

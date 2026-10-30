// 「今日流量」明细浮层的口径：窗口怎么取、峰值怎么挑、按什么排序。
// 跑法同另外几个：`npm test`（Node 自己剥类型，不需要 runner）。
// 没有任何东西 import 它，所以不进 bundle。
import { NO_PEAK, dayStart, peakOf, peakToday, trafficTotal, windowFor, PEAK_LIMIT, type TrafficRow } from "./today-traffic.ts"
import type { Node } from "./api.ts"

let failed = 0
function eq(got: unknown, want: unknown, what: string) {
  const [a, b] = [JSON.stringify(got), JSON.stringify(want)]
  if (a !== b) {
    failed++
    console.error(`✗ ${what}\n    得到 ${a}\n    期望 ${b}`)
  }
}

/** 只关心 day_rx / day_tx 的节点样张（其余字段给中性值，与 money.test.ts 同一套写法）。 */
function node(over: Partial<Node> = {}): Node {
  return {
    id: 1, name: "节点", sort: 1, public: true, online: true, country: "", group: "",
    last_seen: 0, metrics: null, os: "", kernel: "", arch: "", virt: "", cpu_name: "",
    cpu_cores: 0, mem_total: 0, swap_total: 0, disk_total: 0, agent_version: "",
    price: 0, currency: "CNY", billing_cycle: "monthly", expires_at: null, expires_in: null,
    traffic_limit: 0, traffic_mode: "sum", traffic_reset_day: 1, total_rx: 0, total_tx: 0,
    month_rx: 0, month_tx: 0, month_start: "", day_rx: 0, day_tx: 0,
    ...over,
  }
}

/* ── ① 今天从哪儿算起 ────────────────────────────────────────────── */
{
  const at = (h: number, m = 0) => new Date(2026, 9, 30, h, m, 0, 0).getTime() // 2026-10-30 本地时间
  eq(new Date(dayStart(at(13, 45))).getHours(), 0, "dayStart：回到本机时区的 0 点")
  eq(new Date(dayStart(at(13, 45))).getDate(), 30, "dayStart：还是同一天（没跨到前一/后一天）")
  eq(new Date(dayStart(at(0, 5))).getDate(), 30, "dayStart：刚过零点也算今天")
}

/* ── ② 要向 hub 要哪一段 ────────────────────────────────────────────── */
{
  const at = (h: number, m = 0) => new Date(2026, 9, 30, h, m, 0, 0).getTime()
  eq(windowFor(at(0, 5)), { hours: 1, points: 60 }, "刚过零点：hours 下限 1、points 下限 60")
  eq(windowFor(at(13, 45)), { hours: 14, points: 420 }, "13:45：向你天要到 14 小时、两分钟一个桶")
  eq(windowFor(at(23, 59)), { hours: 24, points: 720 }, "23:59：24 小时 / 720 点（上限）")
  // 只比大小关系，别把 12 小时那条钉成魔法数：改点数策略时这里仍是「细到能认出峰值时刻」。
  const noon = windowFor(at(12))
  eq(noon.points / noon.hours, 30, "点数与小时数的比例＝每小时 30 个（两分钟一个桶）")
}

/* ── ③ 峰值怎么挑 ─────────────────────────────────────────────────── */
{
  const rows: TrafficRow[] = [
    { ts: 1000, net_rx: 100, net_tx: 50, net_rx_max: 200, net_tx_max: 80 },
    { ts: 2000, net_rx: 900, net_tx: 40, net_rx_max: 300, net_tx_max: 400 },
    { ts: 3000, net_rx: 50, net_tx: 20, net_rx_max: null, net_tx_max: null },
  ]
  eq(peakOf(rows), { down: 300, downAt: 2_000_000, up: 400, upAt: 2_000_000 },
    "优先取桶内最高（net_*_max），并记下发生时刻（秒 → 毫秒）")
}

{
  // 老 hub 没有 *_max 两列：退回桶均值（会把峰值抹平，但总比不给数强）。
  const rows: TrafficRow[] = [
    { ts: 10, net_rx: 100, net_tx: 20 },
    { ts: 20, net_rx: 700, net_tx: 60 },
  ]
  eq(peakOf(rows), { down: 700, downAt: 20_000, up: 60, upAt: 20_000 }, "缺 max 两列时退回桶均值")
}

{
  const rows: TrafficRow[] = [
    { ts: 5, net_rx: -1, net_tx: null, net_rx_max: -9 },
    { ts: 6 },
  ]
  eq(peakOf(rows), NO_PEAK, "全是空值 / 负数：当 0 处理，不给「最高」写成负数")
  eq(peakOf([]), NO_PEAK, "一个采样都没有：空峰值（浮层写「—」）")
}

/* ── ③b 只要今天那一段 ────────────────────────────────────────────── */
{
  // 刚过零点（00:20）时 hub 的 1 小时窗口会带回昨晚 23:20–24:00 的桶：那些不许算进「今天」。
  const now = new Date(2026, 9, 31, 0, 20, 0, 0).getTime()
  const yesterday = Math.floor(new Date(2026, 9, 30, 23, 30, 0, 0).getTime() / 1000)
  const today = Math.floor(new Date(2026, 9, 31, 0, 10, 0, 0).getTime() / 1000)
  const rows: TrafficRow[] = [
    { ts: yesterday, net_rx: 1, net_tx: 1, net_rx_max: 999 * 1024 ** 2, net_tx_max: 999 * 1024 ** 2 },
    { ts: today, net_rx_max: 5 * 1024 ** 2, net_tx_max: 2 * 1024 ** 2 },
  ]
  eq(peakToday(rows, now), { down: 5 * 1024 ** 2, downAt: today * 1000, up: 2 * 1024 ** 2, upAt: today * 1000 },
    "只算今天 0 点之后的桶（昨晚那一大截不许当成今天的峰值）")
  eq(peakToday([{ ts: yesterday, net_rx_max: 1 }], now), NO_PEAK, "今天的窗口里只有昨晚的桶：空峰值（写「—」）")
}

/* ── ④ 排序与上限 ─────────────────────────────────────────────────── */
{
  eq(trafficTotal(node({ day_rx: 3, day_tx: 4 })), 7, "今日总量＝下行 + 上行")
  eq(trafficTotal(node({ day_rx: -3, day_tx: 4 })), 4, "坏字段（负数）按 0 算")
  eq(PEAK_LIMIT, 48, "浮层最多给 48 台取峰值（再多就把 hub 的历史闸门堵满了）")
}

if (failed) {
  console.error(`\n${failed} 处不符`)
  process.exit(1)
}
console.log("今日流量明细的口径：全部通过")

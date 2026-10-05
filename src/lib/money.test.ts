// 概览卡片「预算版」两个数的口径：折算、封顶、哪些机器不计入。
// 跑法同另外几个：`npm test`（Node 自己剥类型，不需要 runner）。
// 没有任何东西 import 它，所以不进 bundle。
import { budgetOf, cny, cycleDaysOf, cycleMonthsOf, fxNote, FX_CNY } from "./money.ts"
import type { Node } from "./api.ts"

let failed = 0
function eq(got: unknown, want: unknown, what: string) {
  const [a, b] = [JSON.stringify(got), JSON.stringify(want)]
  if (a !== b) {
    failed++
    console.error(`✗ ${what}\n    得到 ${a}\n    期望 ${b}`)
  }
}

/** 两位小数比一比：避免浮点尾差（0.1+0.2 那类）把断言变成噪音。 */
const round = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100)

function node(over: Partial<Node> = {}): Node {
  return {
    id: 1, name: "节点1", sort: 1, public: true, online: true, country: "", group: "",
    last_seen: 0, metrics: null, os: "", kernel: "", arch: "", virt: "", cpu_name: "",
    cpu_cores: 0, mem_total: 0, swap_total: 0, disk_total: 0, agent_version: "",
    price: 0, currency: "CNY", billing_cycle: "monthly", expires_at: null, expires_in: null,
    traffic_limit: 0, traffic_mode: "sum", traffic_reset_day: 1, total_rx: 0, total_tx: 0,
    month_rx: 0, month_tx: 0, month_start: "", day_rx: 0, day_tx: 0,
    ...over,
  }
}

/* 周期 → 月数 / 天数：认识的按表，一次性是 0，没写/不认识按月付。 */
eq([cycleMonthsOf("monthly"), cycleMonthsOf("quarterly"), cycleMonthsOf("semiannual"), cycleMonthsOf("yearly"), cycleMonthsOf("biennial"), cycleMonthsOf("triennial")],
  [1, 3, 6, 12, 24, 36], "周期月数表")
eq([cycleDaysOf("monthly"), cycleDaysOf("quarterly"), cycleDaysOf("semiannual"), cycleDaysOf("yearly"), cycleDaysOf("biennial"), cycleDaysOf("triennial")],
  [30, 90, 180, 365, 730, 1095], "周期天数表")
eq([cycleMonthsOf("once"), cycleMonthsOf(""), cycleMonthsOf("weird")], [0, 1, 1], "一次性 = 0；没写或不认识按月付")
eq([cycleDaysOf("once"), cycleDaysOf(""), cycleDaysOf("weird")], [0, 30, 30], "同上（天数）")

/* 空列表：两个数都是 null（卡片显示「—」），不是 ¥0.00。 */
eq(budgetOf([]), { monthly: null, remaining: null, monthlyCount: 0, remainingCount: 0, used: [], skipped: [] }, "空列表")

/* 月付人民币：月度预算就是价格本身；剩余价值按剩余天数折。 */
const monthly = budgetOf([node({ price: 8.79, currency: "CNY", billing_cycle: "monthly", expires_in: 25 })])
eq([round(monthly.monthly), round(monthly.remaining)], [8.79, 7.32], "月付 ¥8.79 / 剩 25 天 → 7.32")
eq([monthly.monthlyCount, monthly.remainingCount, monthly.used], [1, 1, ["CNY"]], "计数与用到的币种")

/* 年付摊到月：120 USD / 年 = 120 × 6.7179 ÷ 12；剩余价值按 365 天折。 */
const yearly = budgetOf([node({ price: 120, currency: "USD", billing_cycle: "yearly", expires_in: 100 })])
eq([round(yearly.monthly), round(yearly.remaining)], [round(120 * FX_CNY.USD / 12), round(120 * FX_CNY.USD * 100 / 365)],
  "年付 120 USD：月摊 + 剩 100 天")

/* 混合币种：各自折成人民币后相加，`used` 按字母序（提示里要按这个顺序写汇率）。 */
const mixed = budgetOf([
  node({ id: 1, price: 12, currency: "USD", billing_cycle: "monthly", expires_in: 10 }),
  node({ id: 2, price: 12, currency: "EUR", billing_cycle: "monthly", expires_in: 10 }),
  node({ id: 3, price: 12, currency: "CNY", billing_cycle: "monthly", expires_in: 10 }),
])
eq(round(mixed.monthly), round(12 * (FX_CNY.USD + FX_CNY.EUR + FX_CNY.CNY)), "三种币种折成人民币后相加")
eq(mixed.used, ["CNY", "EUR", "USD"], "用到的币种按字母序")

/* 没写周期（老数据 / 手填）按月付算：这台不该整台从合计里消失。 */
const noCycle = budgetOf([node({ price: 10, currency: "USD", billing_cycle: "", expires_in: 15 })])
eq([round(noCycle.monthly), round(noCycle.remaining), noCycle.monthlyCount], [round(10 * FX_CNY.USD), round(10 * FX_CNY.USD * 15 / 30), 1],
  "没写周期按月付：月摊 = 价格本身")

/* 一次性买断：没有「每月」可言，两个数都不计入。 */
const once = budgetOf([node({ price: 300, currency: "CNY", billing_cycle: "once", expires_in: 200 })])
eq([once.monthly, once.remaining, once.monthlyCount], [null, null, 0], "一次性买断不计入")

/* 没填价格：不计账（不是花 0 元），两个数都因此是 null。 */
const free = budgetOf([node({ price: 0, currency: "USD", billing_cycle: "monthly", expires_in: 30 })])
eq([free.monthly, free.remaining, free.monthlyCount, free.remainingCount], [null, null, 0, 0], "价格没填的不计账")

/* 汇率表里没有的币种：跳过并在 skipped 里点名，不静默算成一个错数。 */
const unknown = budgetOf([
  node({ id: 1, price: 10, currency: "XYZ", billing_cycle: "monthly", expires_in: 10 }),
  node({ id: 2, price: 10, currency: "CNY", billing_cycle: "monthly", expires_in: 10 }),
])
eq([round(unknown.monthly), unknown.used, unknown.skipped, unknown.monthlyCount], [10, ["CNY"], ["XYZ"], 1], "没有汇率的币种被跳过并点名")

/* 无到期日的机器：月度预算照算，剩余价值没有「剩多少」可说，不计入。 */
const eternal = budgetOf([
  node({ id: 1, price: 10, currency: "CNY", billing_cycle: "monthly", expires_in: null }),
  node({ id: 2, price: 20, currency: "CNY", billing_cycle: "monthly", expires_in: 30 }),
])
eq([round(eternal.monthly), round(eternal.remaining), eternal.remainingCount], [30, 20, 1], "无到期日只进月度预算")

/* 已过期：按 0 计（不出现负的剩余价值），也不写进机器数。 */
const expired = budgetOf([node({ price: 10, currency: "CNY", billing_cycle: "monthly", expires_in: -3 })])
eq([expired.monthly !== null, expired.remaining, expired.remainingCount], [true, null, 0], "已过期按 0 计")

/* 剩余天数超过一个周期（顺延 / 站长填了很远的日期）：封顶到整台价格。 */
const capped = budgetOf([node({ price: 100, currency: "CNY", billing_cycle: "yearly", expires_in: 500 })])
eq(round(capped.remaining), 100, "剩余天数超过周期时封顶为价格")

/* 旧 hub 没有 expires_in：退回按 expires_at 自己数（与卡片上的到期同一条路）。 */
// ★这个日期要按**本地**日历算（与 @/lib/money 里数天数的口径一致）。原来用 toISOString() 取的是
//   UTC 那天：本地 0–8 点之间它会比本地日期早一天，于是「剩 15 天」被数成 14 天——夹具自己的坑，
//   与运行时无关（每天凌晨必红，白天又自己变绿）。
const iso = (days: number) => {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
const legacy = budgetOf([{ ...node({ price: 30, currency: "CNY", billing_cycle: "monthly" }), expires_in: undefined, expires_at: iso(15) } as unknown as Node])
eq(round(legacy.remaining), 15, "旧 hub 按 expires_at 自己数（剩 15 天 → 一半）")

/* 金额与提示文案。 */
eq(cny(1234.5), "¥1,234.50", "人民币金额带千分位")
eq(cny(0), "¥0.00", "零也写两位小数")
eq(fxNote(["CNY"]), "按固定汇率折算成人民币", "只用人民币时不列汇率")
eq(fxNote(["CNY", "USD"]), `按固定汇率折算（1 USD = ¥${FX_CNY.USD}，2026-09-30）`, "列用到的汇率与取价日期")
eq(fxNote(["CNY"], ["XYZ"]), "按固定汇率折算成人民币；XYZ 没有汇率，未计入", "没有汇率的币种要点名")

if (failed) {
  console.error(`\n${failed} 处不符`)
  process.exit(1)
}
console.log("预算两个数的口径：全部通过")

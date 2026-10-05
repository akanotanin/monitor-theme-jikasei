import type { Node } from "@/lib/api"
// 相对路径（而不是 `@/lib/format`）：这个文件要能被 `node src/lib/money.test.ts`
// 直接跑（见 money.test.ts），而 Node 不认 tsconfig 里的 `@` 别名。
import { daysUntil } from "./format.ts"

/**
 * 概览卡片「预算版」那两块读数：月度预算、剩余价值。
 *
 * 两个数都来自 `/api/nodes` 里本来就有的 `price` / `currency` / `billing_cycle` /
 * `expires_in`，所以切成预算版不会多发任何请求。
 *
 * 口径：
 *   月度预算 = Σ 价格 × 汇率 ÷ 周期月数——把每个节点的账摊到一个月上再加起来
 *     （年付 $120 就是每月 $10；一个月按 30 天、一年按 365 天，两把尺子都写在 CYCLE 里）。
 *     一次性买断（`once`）没有「每月」可言，不计入；价格没填（0/空）的不计。
 *   剩余价值 = Σ 价格 × 汇率 × (剩余天数 ÷ 周期天数)——已经付掉、还没用掉的那一段。
 *     剩余天数取 hub 算好的 `expires_in`（它按 hub 的日历算，在线节点还会顺延到期日），
 *     旧 hub 没有这个字段时才退回按 `expires_at` 自己数。
 *     无到期日（`expires_in` 与 `expires_at` 都没有）的机器没有「剩多少价值」可说，
 *     不计入；已经过期的按 0 计（不会出现负数）。
 *   没写周期（空串 / 不认识的取值，老数据或手填）按最常见的**月付**算——它读起来
 *   最接近「这台机器一个月花多少」，也不会让那个节点整台从合计里消失。
 */
const CYCLE: Record<string, { months: number; days: number }> = {
  monthly: { months: 1, days: 30 },
  quarterly: { months: 3, days: 90 },
  semiannual: { months: 6, days: 180 },
  yearly: { months: 12, days: 365 },
  biennial: { months: 24, days: 730 },
  triennial: { months: 36, days: 1095 },
  // 一次性买断：没有「每月」也没有「剩多少天」，两块都不计入。
  once: { months: 0, days: 0 },
}

/** 实际周期是几「月份」。没写周期（老数据 / 手填）按月付——最常见的记法。 */
export function cycleMonthsOf(cycle: string): number {
  return CYCLE[cycle]?.months ?? 1
}

/** 实际周期是几天。用户的「剩余天数」按这把尺子折。 */
export function cycleDaysOf(cycle: string): number {
  return CYCLE[cycle]?.days ?? 30
}

/**
 * 固定汇率：1 单位该币种 = N 人民币。
 *
 * 主题是一个离线的静态包，访客的浏览器里不会（也不该）去查实时汇率，所以这里写死一份，
 * 只用来把站长填的各币种账折成同一把尺子求合计——卡片上的数字因此是「≈」。改这张表
 * 就够了，别处不用动（`FX_DATE` 只是给悬停提示用来自报取价日期）。
 *
 * 取值：2026-09-30 的公开汇率参考价，四舍五入到四位小数。
 */
export const FX_DATE = "2026-09-30"

export const FX_CNY: Record<string, number> = {
  CNY: 1,
  USD: 6.7179,
  EUR: 7.6172,
  GBP: 8.883,
  JPY: 0.0427,
  HKD: 0.8562,
  TWD: 0.211,
  SGD: 5.2585,
  AUD: 4.6909,
  CAD: 4.7351,
  RUB: 0.0795,
}

export type Budget = {
  /** 折成人民币的每月合计；一台可计的都没有时 null（卡片显示「—」而不是 ¥0.00）。 */
  monthly: number | null
  /** 折成人民币的剩余价值合计；同上。 */
  remaining: number | null
  /** 计入月度预算的机器数。 */
  monthlyCount: number
  /** 计入剩余价值的机器数（剩余天数 > 0 的）。 */
  remainingCount: number
  /** 真的折进去过的币种，按字母序（用来在提示里只列该报的那几条汇率）。 */
  used: string[]
  /** 填了价格、但汇率表里没有的那种币种（那台机器因此没计入，提示里会说明）。 */
  skipped: string[]
}

export function budgetOf(nodes: Node[]): Budget {
  let monthly = 0
  let remaining = 0
  let monthlyCount = 0
  let remainingCount = 0
  const used = new Set<string>()
  const skipped = new Set<string>()

  for (const node of nodes) {
    // 没填价格（0 / 空）＝这台不计账，不是「花 0 元」。
    if (!(node.price > 0)) continue
    const currency = (node.currency || "").toUpperCase()
    const fx = FX_CNY[currency]
    if (fx === undefined) {
      skipped.add(currency || "（空）")
      continue
    }
    used.add(currency)
    const months = cycleMonthsOf(node.billing_cycle)
    const days = cycleDaysOf(node.billing_cycle)
    if (months > 0) {
      monthly += (node.price * fx) / months
      monthlyCount++
    }
    if (days <= 0) continue
    // `expires_in` 是数字（含 0、负数）就用它；null / 缺字段才按 `expires_at` 自己数。
    const left = typeof node.expires_in === "number" ? node.expires_in : daysUntil(node.expires_at)
    if (typeof left === "number" && left > 0) {
      // 剩余天数超过一个周期（顺延、或站长填了个很远的日期）时按整期封顶：
      // 剩余价值不可能比这台机器买价还贵。
      remaining += node.price * fx * (Math.min(left, days) / days)
      remainingCount++
    }
  }

  return {
    monthly: monthlyCount ? monthly : null,
    remaining: remainingCount ? remaining : null,
    monthlyCount,
    remainingCount,
    used: [...used].sort(),
    skipped: [...skipped].sort(),
  }
}

/**
 * 人民币金额。三位一节的逗号是必要的：这是合计，几千块的时候没有分隔符要一位位去数。
 * 两位小数与卡片上单机的「价格」一致（`money()`）。
 */
export function cny(amount: number): string {
  return `¥${amount.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** 提示里那句汇率说明。只列真的用到的币种（人民币自身不必写「1 CNY = ¥1」）。 */
export function fxNote(used: string[], skipped: string[] = []): string {
  const rates = used
    .filter((code) => code !== "CNY")
    .map((code) => `1 ${code} = ¥${trimRate(FX_CNY[code])}`)
  const head = rates.length
    ? `按固定汇率折算（${rates.join("，")}，${FX_DATE}）`
    : "按固定汇率折算成人民币"
  const miss = skipped.length ? `；${skipped.join("、")} 没有汇率，未计入` : ""
  return head + miss
}

/** 6.7179 → 6.7179、1 → 1、0.2110 → 0.211：去掉没意义的尾零，别写成「1.0000」。 */
function trimRate(rate: number): string {
  return rate.toFixed(4).replace(/\.?0+$/, "")
}

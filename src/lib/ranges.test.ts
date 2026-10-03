// 时间范围按钮按 hub 的保留天数生成：老 hub（没有 history_days）必须与 1.15.x 那排完全一致，
// 新 hub 则要跟着站长设的保留天数走、绝不给出一枚超上限的窗口。
// 跑法同另外几个：`npm test`（Node 自己剥类型，不需要 runner）。没有任何东西 import 它，不进 bundle。
import { rangesFor } from "./ranges.ts"

let failed = 0
function eq(got: unknown, want: unknown, what: string) {
  const [a, b] = [JSON.stringify(got), JSON.stringify(want)]
  if (a !== b) {
    failed++
    console.error(`✗ ${what}\n    得到 ${a}\n    期望 ${b}`)
  }
}

const labels = (days: unknown) => rangesFor(days).map((r) => r.label)
const hours = (days: unknown) => rangesFor(days).map((r) => r.hours)

// 老 hub：没有这个字段 / 类型不对 → 按 7 天，算出来必须与 1.15.x 写死的那排逐字相同。
eq(labels(undefined), ["1 小时", "6 小时", "24 小时", "7 天"], "老 hub（无字段）＝原来那排按钮")
eq(labels(null), ["1 小时", "6 小时", "24 小时", "7 天"], "null 同上")
eq(labels("30"), ["1 小时", "6 小时", "24 小时", "7 天"], "类型不对（字符串）按 7 天")
eq(labels(7), ["1 小时", "6 小时", "24 小时", "7 天"], "保留 7 天＝原来那排")

// 新 hub 的默认值（1.3.2 起默认 30 天）。
eq(labels(30), ["1 小时", "6 小时", "24 小时", "7 天", "30 天"], "保留 30 天（默认）多一枚 30 天")
eq(hours(30), [1, 6, 24, 168, 720], "30 天那枚的 hours 是 720")

// 非整档的保留天数：最后补一枚「保留天数本身」，不给超上限的窗口。
eq(labels(14), ["1 小时", "6 小时", "24 小时", "7 天", "14 天"], "保留 14 天")
eq(hours(14), [1, 6, 24, 168, 336], "14 天那枚的 hours 是 336")
eq(labels(90), ["1 小时", "6 小时", "24 小时", "7 天", "30 天", "90 天"], "保留 90 天")
eq(labels(365), ["1 小时", "6 小时", "24 小时", "7 天", "30 天", "365 天"], "保留 365 天＝上限，最多 6 枚")

// 短保留：1 天 / 3 天都不能冒出超上限的窗口，也不能只剩一枚。
eq(labels(1), ["1 小时", "6 小时", "24 小时"], "保留 1 天：只剩三档，没有 25 小时的窗口")
eq(hours(1), [1, 6, 24], "保留 1 天的 hours")
eq(labels(3), ["1 小时", "6 小时", "24 小时", "3 天"], "保留 3 天补一枚 3 天")
eq(labels(2), ["1 小时", "6 小时", "24 小时", "2 天"], "保留 2 天补一枚 2 天")

// 越界与小数：hub 钳 1~365，这边同样钳住（手改库、别的版本写进来的值都必须兜住）。
eq(rangesFor(1000).at(-1)?.hours, 365 * 24, "超过 365 天按 365 天算")
eq(rangesFor(0).at(-1)?.hours, 24, "0 天按 1 天算")
eq(rangesFor(-5).at(-1)?.hours, 24, "负数按 1 天算")
eq(rangesFor(7.9).at(-1)?.hours, 168, "小数向下取整（7.9 → 7 天）")
eq(rangesFor(NaN).length, 4, "NaN 按 7 天")

// 每一排都必须：小时数严格递增、无重复、标签无重复——重复的 hours 会让页签点不动、图表永远停在同一窗口。
for (const days of [1, 2, 3, 7, 14, 30, 90, 365, undefined]) {
  const list = rangesFor(days)
  const hs = list.map((r) => r.hours)
  const ls = list.map((r) => r.label)
  eq(hs.every((h, i) => i === 0 || h > hs[i - 1]), true, `保留 ${days} 天：hours 严格递增`)
  eq(new Set(hs).size, hs.length, `保留 ${days} 天：hours 无重复`)
  eq(new Set(ls).size, ls.length, `保留 ${days} 天：标签无重复`)
  eq(list.length <= 6, true, `保留 ${days} 天：最多 6 枚（一行放得下）`)
}

if (failed) {
  console.error(`\n时间范围：${failed} 条不通过`)
  process.exit(1)
}
console.log("时间范围：全部通过")

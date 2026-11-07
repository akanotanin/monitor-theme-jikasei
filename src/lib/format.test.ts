// Every figure on the page passes through this file, making it the one place
// worth a check. Run it with `npm test`: Node strips the types itself, so this
// requires no runner, framework or dependency.
//
// Nothing imports it, so the bundle never includes it.
import {
  axisBytes, axisTop, bytes, clockBeijing, CYCLE_SHORT, cycleName, cycleNameShort, CYCLES, cpuName, daysUntil, despike, innerTicks, niceScale, osName, pair, quarters, rate, timeTicks, uptime, zoomSpan,
} from "./format.ts"

let failed = 0
function eq(got: unknown, want: unknown, what: string) {
  const [a, b] = [JSON.stringify(got), JSON.stringify(want)]
  if (a !== b) {
    failed++
    console.error(`✗ ${what}\n    得到 ${a}\n    期望 ${b}`)
  }
}

// bytes: the significant-digit ladder, and the sub-byte case that would
// otherwise print "512 undefined".
eq(bytes(0), "0 B", "bytes(0)")
eq(bytes(0.5), "0 B", "bytes(0.5) 不能落到 UNITS[-1]")
eq(bytes(-1), "0 B", "bytes(负数)")
eq(bytes(1023), "1023 B", "bytes 在 B 档不带小数")
eq(bytes(1024), "1.00 KB", "bytes(1 KiB)")
eq(bytes(10 * 1024), "10.0 KB", "两位数留一位小数")
eq(bytes(100 * 1024), "100 KB", "三位数不留小数")
eq(bytes(1024, 1), "1.0 KB", "digits 覆盖默认档位")
// ★2026-11-06：四舍五入顶到 1024 时必须进位（原先会印出「1024 B」「1024 KB」，
// 数值与单位对不上的那种坏数；rate() 早就有这条规则）。
eq(bytes(1023.6), "1.00 KB", "1023.6 B 四舍五入后进位，不印 1024 B")
eq(bytes(1048575), "1.00 MB", "1048575 B 不印 1024 KB")
eq(bytes(1023.4), "1023 B", "没顶到 1024 就留在原档")
eq(axisBytes(1048575), "1 MB", "axisBytes 同样进位（轴刻度用它）")

// pair: one unit when both sides share it, two when they do not.
eq(pair(300 * 1024 ** 2, 900 * 1024 ** 2), "300.00 / 900.00 MB", "同单位只写一次")
eq(pair(300 * 1024 ** 2, 3 * 1024 ** 3), "300 MB / 3.00 GB", "跨单位各写各的")
// ★2026-11-07：pair 与 bytes() 是同一套数字，两条规则也必须同源 —— 一是四舍五入顶到 1024 要
//   升一档（否则印「1024 / 1024 B」），二是两侧都 <1 时 unitOf 给 -1，不能落到 UNITS[-1]
//   （原先 pair(0.5, 0.9) 印的是「512.00 / 921.60 undefined」）。
eq(pair(0.5, 0.9), "0 B / 0 B", "亚字节两端退回 bytes()，不印 undefined")
eq(pair(1023.999, 1023.999), "1.00 / 1.00 KB", "四舍五入顶到 1024 时升一档")
eq(pair(1023.4, 1023.4), "1023 / 1023 B", "没顶到 1024 就留在原档")

// rate: the same three significant digits as bytes(), plus the two rules the
// summary cards forced on it -- the KB bin prints no decimal, and every bin stops
// at 999 so that no reading is ever four digits wide. The two rates share a 50/50
// row there, and the narrowest four-column cell leaves 77px for the text: an
// old-style "1023.9 KB/s" needed 122px and was silently ellipsised.
eq(rate(0), "0 B/s", "rate(0)")
eq(rate(0.5), "0 B/s", "rate(0.5) 不能落到 UNITS[-1]")
eq(rate(512), "512 B/s", "B 档整数")
eq(rate(5 * 1024), "5.0 KB/s", "10 以下留一位小数")
eq(rate(62.2 * 1024), "62 KB/s", "KB 档不给小数")
eq(rate(112.6 * 1024), "113 KB/s", "KB 档四舍五入到整数")
eq(rate(999.4 * 1024), "999 KB/s", "进位前最长的那串")
eq(rate(999.5 * 1024), "1.0 MB/s", "到 999.5 进位到上一档")
eq(rate(1023.9 * 1024), "1.0 MB/s", "1023.9 KB/s 不再印成四位数")
eq(rate(1.8 * 1024 ** 2), "1.8 MB/s", "MB 档 10 以下留一位")
eq(rate(20.5 * 1024 ** 2), "21 MB/s", "MB 档 10 以上不留小数")
eq(rate(999.4 * 1024 ** 2), "999 MB/s", "MB 档进位前最长的那串")
eq(rate(999.9 * 1024 ** 2), "1.0 GB/s", "MB 档同样封顶进位")

// axisBytes: ticks under three digits keep one decimal, or a narrow axis repeats
// a label; a trailing .0 adds nothing.
eq(axisBytes(3.2 * 1024 ** 3), "3.2 GB", "窄轴刻度保留一位")
eq(axisBytes(2 * 1024 ** 3), "2 GB", "整数刻度不写 .0")
eq(axisBytes(0), "0 B", "零刻度")

// axisTop: the top is derived from a round gridline, so quarters() lands on round
// values in the unit the axis is printed in.
eq(axisTop(0.4, 4, 10, 100), 4, "闲置机器拿到地板值")
eq(axisTop(63, 4, 10, 100), 80, "63% -> 0/20/40/60/80")
eq(axisTop(200, 4, 10, 100), 100, "百分比封顶")
eq(axisTop(25_000_000, 1024, 1024), 32 * 1024 ** 2, "字节轴按 1024 取整")
eq(quarters(32 * 1024 ** 2).map(axisBytes), ["0 B", "8 MB", "16 MB", "24 MB", "32 MB"], "四条网格线都是整值")
// 四条刻度为 step·[1,2,3,4]，约束落在第三条：3m 必须能被 axisBytes 精确打印，
// 而它只保留一位小数。2 的幂均满足；半档 384 与 768 不满足，其第三条刻度为
// 1.125 Ki 与 2.25 Ki，将被打印为 "1.1" 与 "2.3"。这两档恰好覆盖 1–1.5 MB/s
// 与 2–3 MB/s。断言针对标签本身，仅比较轴顶比例无法发现该问题。
eq(quarters(axisTop(2_621_440, 1024, 1024)).map(axisBytes),
   ["0 B", "1 MB", "2 MB", "3 MB", "4 MB"], "峰值 2.5 MB/s 的四条刻度")
eq(quarters(axisTop(1_258_291, 1024, 1024)).map(axisBytes),
   ["0 B", "512 KB", "1 MB", "1.5 MB", "2 MB"], "峰值 1.2 MB/s 的四条刻度")
// 轴顶必须取自梯子而非数据本身。十进制梯子配合 1024 进制的 scale 最大仅到
// 10·1024^k，越过该档后 find 落空，`?? target` 将轴顶回退为 max，网格线随之变为
// max/4 这类非整值，正是本函数要避免的情形。该回退仅在 [4,40)·1024^k 的窄带内
// 不出问题，而 40 KB/s–4 MB/s 恰是 VPS 最常见的区间。
for (const max of [3_000, 300_000, 3_000_000, 300_000_000]) {
  const top = axisTop(max, 1024, 1024)
  eq(top > max, true, `${max} B/s 的轴顶不能等于数据本身`)
  // 上界为 2 而非 1.5：梯子移除半档后，最坏情况是下一档 2 的幂。
  eq(top / max < 2, true, `${max} B/s 的轴顶不能浪费整块面板`)
}

// niceScale（自绘图的自动量程）：非负数据的下沿不许落到 0 以下 —— 平直且 <1ms 的线路
// 原先从 -0.5 起、刻度印「-0.5ms」「-1ms」（2026-11-07 审出来的；1.36.0 那条护栏写在 pad
// 之后，条件恒假，等于没修）。
{
  const flat = niceScale(0.5, 0.5)
  eq(flat.lo, 0, "平直 0.5ms：下沿是 0")
  eq(flat.hi, 1.5, "平直 0.5ms：上沿留 1ms 余量")
  eq(flat.ticks, [0, 0.5, 1, 1.5], "平直 0.5ms：刻度从 0 起")
  const zero = niceScale(0, 0)
  eq(zero.lo, 0, "平直 0ms：下沿是 0")
  eq(zero.ticks.every((v) => v >= 0), true, "平直 0ms：没有负刻度")
  // 绝对值 >1 的平直线仍贴着自己的 ±10%（20ms 的抖动要看得见，不被抬到 0 起）。
  eq(niceScale(20, 20).ticks, [18, 19, 20, 21, 22], "平直 20ms：±10% 余量")
  // 负数数据照旧落在 0 以下 —— 这条护栏只对非负数生效。
  const below = niceScale(-3, -3)
  eq(below.ticks.every((v) => v < 0), true, "负数数据：刻度仍在 0 以下")
  eq(below.ticks.some((v) => v <= -3) && below.ticks.some((v) => v >= -3), true, "负数数据：范围覆盖数据")
  // 普通量程：上下沿各向外扩到步长的整数倍（延迟轴不从 0 起）。
  eq(niceScale(184, 300), { lo: 150, hi: 300, ticks: [150, 200, 250, 300] }, "普通量程扩到整步长")
  eq(niceScale(184, 301).hi, 350, "轴顶盖得住数据（301 落在下一格）")
}

// timeTicks: round clock values, phased on local midnight rather than the epoch,
// and never more than requested.
{
  const day = 86_400_000
  const to = Date.now()
  const ticks = timeTicks(to - day, to)
  eq(ticks.length <= 8, true, `24 小时窗最多 8 个刻度（得到 ${ticks.length}）`)
  eq(
    ticks.every((t) => new Date(t).getMinutes() === 0 && new Date(t).getSeconds() === 0),
    true,
    "刻度落在整点上",
  )
  eq(
    ticks.every((t, i) => i === 0 || t - ticks[i - 1] === ticks[1] - ticks[0]),
    true,
    "刻度间距均匀",
  )
  eq(timeTicks(to, to - day), [], "反向区间不产出刻度")
}

// clockBeijing：「今日流量」浮层的峰值时刻用**固定 UTC+8**，与运行环境的时区无关
// （那个窗口本身按北京时间 0 点裁，见 @/lib/today-traffic 的 dayStart）。
eq(clockBeijing(Date.UTC(2026, 0, 1, 0, 5)), "08:05", "UTC 00:05 → 北京 08:05")
eq(clockBeijing(Date.UTC(2026, 0, 1, 20, 30)), "04:30", "UTC 20:30 → 次日北京 04:30")
eq(clockBeijing(Date.UTC(2026, 5, 30, 15, 59)), "23:59", "UTC 15:59 → 北京 23:59")

// daysUntil: whole days, negative once past, null when there is no date.
{
  const at = (days: number) => {
    const d = new Date()
    d.setDate(d.getDate() + days)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  }
  eq(daysUntil(at(10)), 10, "十天后")
  eq(daysUntil(at(-3)), -3, "已过期为负")
  eq(daysUntil(null), null, "无到期日")
  eq(daysUntil("不是日期"), null, "无法解析的日期")
}

eq(uptime(0), "—", "没上报过就不写时长")
eq(uptime(90), "1 分", "不足一小时")
eq(uptime(3 * 3600 + 25 * 60), "3 小时 25 分", "不足一天")
eq(uptime(2 * 86400 + 5 * 3600), "2 天 5 小时", "超过一天不再写分钟")

// despike：孤立的尖峰被拉回邻域，持续的高延迟保留，超时仍是缺口。
{
  const flat = [20, 21, 20, 22, 21, 20, 21]
  eq(despike(flat), flat, "没有离群点就原样返回")
  eq(despike([20, 21, 20, 900, 21, 20, 21])[3], 21, "孤立尖峰替换为窗口中位数")
  // 一段持续的高延迟是真实状况而非尖峰：窗口内多数样本同样高，中位数随之抬高。
  // 只断言尖峰那一点会漏掉这条——滑动中位数同样能通过前一条断言。
  eq(despike([20, 21, 300, 310, 305, 300, 21, 20]).slice(2, 6), [300, 310, 305, 300], "持续升高不被削掉")
  eq(despike([20, null, 900, null, 21]), [20, null, 21, null, 21], "超时保持为缺口，不参与比较")
  // 延迟以整毫秒存储，稳定线路的窗口内多数样本完全相同，绝对中位差为 0。不设下限
  // 时这条断言会失败，而它正是削峰要处理的形状：平直的线加一个 2 秒的桶。
  eq(despike([180, 180, 181, 180, 2000, 180, 180, 181, 180])[4], 180, "平直线路上的尖峰同样被削掉")
  // 下限不能低到把正常抖动也当成尖峰：整毫秒的数据里 1 ms 的起伏是常态。
  eq(despike([180, 181, 180, 180, 181, 180, 180]), [180, 181, 180, 180, 181, 180, 180], "1 ms 抖动原样保留")
}

eq(osName("Debian GNU/Linux 12 (bookworm)"), "Debian 12", "发行版名去掉代号")
eq(cpuName("Intel(R) Xeon(R) CPU E5-2680 8-Core Processor"), "Intel Xeon E5-2680", "CPU 名去掉商标和核数")

// CYCLE_SHORT：卡片底注那一档的短写法（整页详情的 CYCLES 仍写「月付」）。两组键必须一致 ——
// 卡片底注是在 CYCLES 的键上现查短写法的，缺一个键时同一台机器在详情页与卡片上就会一个写
// 「月付」、一个印出「价格 ¥x/」这种断尾。
eq(CYCLE_SHORT.monthly, "月", "月付短写法")
eq(CYCLE_SHORT.yearly, "年", "年付短写法")
eq(CYCLE_SHORT.once, "一次性", "一次性不缩")
// ★2026-11-06：hub 把非具名整月数存成 `<n>m`（5m / 18m / 60m），认不出来就会被当成月付。
eq(cycleName("5m"), "5 个月", "5m 写成 5 个月")
eq(cycleNameShort("18m"), "18 个月", "18m 的短写法")
eq(cycleName("yearly"), "年付", "具名周期照旧")
eq(cycleName("weird"), "weird", "认不出来的原样给回")
eq(cycleNameShort("weird"), null, "短写法认不出就不写")
// 到期天数按北京时间数：同一时刻换任何时区跑，结果都一样（不再随访客时区漂一天）。
eq(daysUntil("2999-01-01") !== null, true, "daysUntil 解析日期")
eq(Object.keys(CYCLE_SHORT).sort(), Object.keys(CYCLES).sort(), "短写法与 CYCLES 是同一组键")

// innerTicks / zoomSpan：滚轮纵缩那一档的刻度与量程数学。
// 2026-10-15 从 kanso 同步过来的两组边界用例 —— 上界放开半步会多吐越界刻度、
// 跨度下限固定值会让亚毫秒量程卡死，两条都是真踩过的。
{
  const all = (lo: number, hi: number) => {
    const t = innerTicks(lo, hi)
    return t.length > 0 && t.every((v) => v >= lo - 1e-9 && v <= hi + 1e-9)
  }
  eq(innerTicks(0, 1000), [0, 250, 500, 750, 1000], "整段量程：0/250/500/750/1000")
  eq(innerTicks(13.2, 38.2), [15, 20, 25, 30, 35], "窄量程只挑范围内的整齐数（首档只落得下 2 枚就退一档）")
  eq(all(280, 281.3), true, "压线窄量程：不许吐 281.5 那种越界刻度")
  eq(all(27.95, 52.95), true, "滚轮缩放后的任意边界：刻度全在范围内")
  eq(all(0, 1), true, "1ms 下限量程：0/0.25/0.5/0.75/1")
  eq(innerTicks(3, 3), [], "零跨度：不给刻度（免得画出一堆重叠）")
  const R = (lo: number, hi: number, anchor: number, ratio: number, factor: number, floor: number, cap = 1e5) =>
    zoomSpan({ lo, hi, anchor, ratio, factor, floor, cap })
  const spanOf = (r: { lo: number; hi: number }) => r.hi - r.lo
  const a1 = R(25, 50, 33, 0.4, 0.02, 1)
  eq(Math.abs(spanOf(a1) - 1) < 1e-9, true, `收窄到 1ms 下限即停（跨度 ${spanOf(a1)}）`)
  eq(Math.abs(a1.hi - 33 - 0.6) < 1e-9 && Math.abs(33 - a1.lo - 0.4) < 1e-9, true, "夹到下限时按锚点比例收：锚点在框里仍是 40%")
  eq(spanOf(R(25, 50, 33, 0.4, 2, 1)), 50, "外滚 2×：25 → 50")
  const b1 = R(1.1, 1.5, 1.3, 0.5, 0.835, 0.1)
  eq(spanOf(b1) < 0.4 && spanOf(b1) > 0.3, true, `亚毫秒收窄：0.4 → ${spanOf(b1).toFixed(3)}（旧版会放大到 1.0）`)
  eq(spanOf(R(0, 0.675, 0.27, 0.75, 1.148, 0.1)) > 0.675, true, "贴 0 外滚：跨度只会变大（旧版原地不动）")
  eq(R(0, 0.675, 0.1, 0.9, 0.5, 0.1).lo >= 0, true, "下沿不越 0")
  const c2 = R(900, 1000, 500000, 0.5, 4, 1, 1000)
  eq(c2.hi <= 1000 && spanOf(c2) > 0, true, "顶端不越 cap、跨度不为负")
  eq(spanOf(R(0, 0.02, 0.01, 0.5, 4, 1)) > 0.02, true, "比下限还窄的量程：外滚照样变大、不被地板卡住")
}

if (failed) {
  console.error(`\n${failed} 项不通过`)
  throw new Error("format 校验未通过")
}
console.log("format 校验通过")

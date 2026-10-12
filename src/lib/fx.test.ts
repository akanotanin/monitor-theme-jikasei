// 每日汇率模块（fx.ts）的口径：拣选安全阀、双源解析与回退、合并兜底、缓存往返。
// 跑法同其它几个：`npm test`（Node 自己剥类型，不需要 runner）。
// 没有任何东西 import 它，所以不进 bundle。Node 里没有 localStorage —— readCache / writeCache
// 走「安全空操作」那条路（下面一并断言，不许抛）。
import { fetchRates, fromCurrencyApi, fromErApi, pickRates, readCache, writeCache } from "./fx.ts"
import { FX_BUILTIN, type FxRates } from "./money.ts"

let failed = 0
function ok(cond: unknown, what: string, extra = "") {
  if (!cond) {
    failed++
    console.error(`✗ ${what}${extra ? `\n    ${extra}` : ""}`)
  }
}
const round4 = (n: number) => Math.round(n * 10000) / 10000

/* 拣选（pickRates）：合格子集全过；USD / EUR 缺一不可；个别离谱值只丢那一个。 */
const good: FxRates = { USD: 6.9, EUR: 7.5, GBP: 8.9, JPY: 0.043, HKD: 0.85, TWD: 0.21, SGD: 5.2, AUD: 4.7, CAD: 4.7, RUB: 0.08 }
ok(!!pickRates(good) && pickRates(good)!.USD === 6.9, "合格值全部通过")
ok(pickRates({ ...good, USD: 2.0 }) === null, "USD 离谱（低于 0.5×）→ 丢弃后整份不采用")
ok(pickRates({ ...good, EUR: 20 }) === null, "EUR 离谱（高于 2×）→ 整份不采用")
ok(pickRates({ ...good, USD: NaN }) === null, "USD 不是数 → 整份不采用")
const partial = pickRates({ USD: 6.9, EUR: 7.5, GBP: 999 })
ok(!!partial && partial.GBP === undefined && partial.USD === 6.9, "个别币种越界只丢那一个（不影响其余）")

/* 主源 er-api 形状：CNY 基准 → 要倒数；日期取自 time_last_update_utc。 */
const erBody = {
  result: "success",
  time_last_update_utc: "Sun, 11 Oct 2026 00:02:32 +0000",
  rates: { CNY: 1, USD: 0.14935, EUR: 0.13325, GBP: 0.11301, JPY: 23.642, HKD: 1.1727, TWD: 4.51, SGD: 0.19133, AUD: 0.21405, CAD: 0.21258, RUB: 12.44 },
}
const stub = (body: unknown, okFlag = true) => async () => ({ ok: okFlag, json: async () => body })
const er = await fromErApi(stub(erBody))
ok(!!er && round4(er.rates.USD) === round4(1 / 0.14935), "主源：倒数成「1 USD = N 人民币」", JSON.stringify(er?.rates))
ok(!!er && er.date === "2026-10-11" && er.live === true, "主源：日期取 UTC 那天、标 live", JSON.stringify(er && { date: er.date, live: er.live }))
ok((await fromErApi(stub({ result: "error" }))) === null, "主源：result 不是 success → null")
ok((await fromErApi(stub(erBody, false))) === null, "主源：HTTP 非 200 → null")
ok((await fromErApi(async () => { throw new Error("net down") })) === null, "主源：网络异常 → null（吞掉）")

/* 备源 currency-api 形状：键全小写。 */
const caBody = { date: "2026-10-11", cny: { usd: 0.14935, eur: 0.13325, gbp: 0.11301, jpy: 23.642, hkd: 1.1727, twd: 4.51, sgd: 0.19133, aud: 0.21405, cad: 0.21258, rub: 12.44 } }
const ca = await fromCurrencyApi(stub(caBody))
ok(!!ca && round4(ca.rates.USD) === round4(1 / 0.14935) && ca.date === "2026-10-11", "备源：小写键解析 + 倒数 + 自带日期", JSON.stringify(ca && { usd: ca.rates.USD, date: ca.date }))
ok((await fromCurrencyApi(stub({ noCny: true }))) === null, "备源：没有 cny 表 → null")

/* fetchRates：主源挂 → 备源顶上；源没给全的币种用内置值合并兜底；全挂 → null。 */
const route = (table: Record<string, unknown>) => async (url: string) => {
  for (const [part, body] of Object.entries(table)) if (url.includes(part)) return { ok: true, json: async () => body }
  return { ok: false, json: async () => ({}) }
}
const fallbackB = await fetchRates(route({ "open.er-api.com": { result: "error" }, "cdn.jsdelivr.net": caBody }))
ok(!!fallbackB && round4(fallbackB.rates.USD) === round4(1 / 0.14935), "主源挂 → 备源顶上", JSON.stringify(fallbackB && { usd: fallbackB.rates.USD }))
const merged = await fetchRates(route({
  "open.er-api.com": { result: "success", time_last_update_utc: "Sun, 11 Oct 2026 00:02:32 +0000", rates: { USD: 0.14935, EUR: 0.13325 } },
}))
ok(!!merged && merged.rates.GBP === FX_BUILTIN.rates.GBP, "源没给的币种用内置值顶上（不让那台机器掉出合计）", JSON.stringify(merged?.rates))
ok((await fetchRates(async () => { throw new Error("offline") })) === null, "两个源都够不着 → null（页面继续用内置表）")

/* 缓存：Node 没有 localStorage —— 两个函数都得是安全空操作。 */
ok(readCache() === null, "无 localStorage 环境：readCache 返回 null 不抛")
let threw = false
try {
  writeCache({ rates: good, date: "2026-10-11", live: true })
} catch {
  threw = true
}
ok(!threw, "无 localStorage 环境：writeCache 静默不抛")

if (failed) {
  console.error(`\n${failed} 处不符`)
  process.exit(1)
}
console.log("每日汇率：全部通过")

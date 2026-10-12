/**
 * 每日汇率。
 *
 * 「月度预算 / 剩余价值」要把各币种的账折成人民币求合计——之前用内置固定表（见 money.ts），
 * 数字会随行情慢慢失真。这模块在访客打开页面时**异步**拉一轮公开汇率（绝不阻塞首屏：
 * 先用新鲜缓存或内置表渲染，拉到了再无缝换上）：
 *   主源 open.er-api.com —— 免费无 key、每天多次更新、返回自带更新时刻；
 *   备源 @fawazahmed0/currency-api（走 jsdelivr CDN）—— 对国内网络友好、币种覆盖全。
 * 拉到的新值缓存进 localStorage 24 小时（「每天拿到最新」就是这么实现的：缓存过期后的
 * 下一次打开会重新拉）；两个源都够不着就沉默继续用内置表。任何一步失败访客都无感。
 *
 * 安全阀：拉回的值要过一遍**合理性区间**（与内置值相差不出一倍）——防 API 抽风或被投毒
 * 把「≈¥」算成天文数字；单个币种不过关就丢那个币种，USD / EUR 都拿不到才算整轮失败。
 */
import { useEffect, useState } from "react"
import { FX_BUILTIN, type FxRates, type FxSnapshot } from "./money.ts"

/** localStorage 缓存键（与主题其它键同前缀）。 */
const CACHE_KEY = "jikasei:fx"
/** 缓存有效 24 小时：过期后的下一次打开页面会重新拉一批。 */
const TTL_MS = 24 * 60 * 60 * 1000
/** 单个请求的超时——别让页面后台挂着等汇率。 */
const TIMEOUT_MS = 6000

/** 关心的币种 = 内置表的全部键（去掉人民币自身）：拉回的数据按这个收窄，界面口径才稳定。 */
const KEYS = Object.keys(FX_BUILTIN.rates).filter((k) => k !== "CNY")

/** fetch 的最小形状（为单测留出注入点）。 */
type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

/** 拣出「能用的」汇率子集：正数且与内置值相差不出一倍；USD / EUR 缺一不可。给单测导出。 */
export function pickRates(rates: FxRates): FxRates | null {
  const out: FxRates = {}
  for (const k of KEYS) {
    const v = rates[k]
    const b = FX_BUILTIN.rates[k]
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue
    if (v < b * 0.5 || v > b * 2) continue
    out[k] = v
  }
  return out.USD && out.EUR ? out : null
}

const ymdLocal = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

async function getJSON(f: FetchLike, url: string): Promise<Record<string, unknown> | null> {
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
    const res = await f(url, { signal: ctl.signal })
    clearTimeout(timer)
    if (!res.ok) return null
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * 主源：open.er-api.com。响应里的 `rates` 是「1 CNY 值多少外币」——要**倒数**成
 * 「1 外币 = N 人民币」才能进 budgetOf 的口径。`time_last_update_utc`（HTTP 日期格式）
 * 用来自报取价日期。给单测导出。
 */
export async function fromErApi(f: FetchLike): Promise<FxSnapshot | null> {
  const j = await getJSON(f, "https://open.er-api.com/v6/latest/CNY")
  if (!j || j.result !== "success" || typeof j.rates !== "object" || !j.rates) return null
  const table = j.rates as Record<string, number>
  const flipped: FxRates = {}
  for (const k of KEYS) {
    const v = table[k]
    if (typeof v === "number" && v > 0) flipped[k] = 1 / v
  }
  const picked = pickRates(flipped)
  if (!picked) return null
  const t = typeof j.time_last_update_utc === "string" ? Date.parse(j.time_last_update_utc) : NaN
  const date = Number.isNaN(t) ? ymdLocal(new Date()) : new Date(t).toISOString().slice(0, 10)
  return { rates: picked, date, live: true }
}

/** 备源：currency-api（jsdelivr）。键全小写，同样倒数；`date` 直接是 YYYY-MM-DD。给单测导出。 */
export async function fromCurrencyApi(f: FetchLike): Promise<FxSnapshot | null> {
  const j = await getJSON(f, "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/cny.json")
  const table = j && typeof j === "object" ? (j as Record<string, unknown>).cny : null
  if (!table || typeof table !== "object") return null
  const raw = table as Record<string, number>
  const flipped: FxRates = {}
  for (const k of KEYS) {
    const v = raw[k.toLowerCase()]
    if (typeof v === "number" && v > 0) flipped[k] = 1 / v
  }
  const picked = pickRates(flipped)
  if (!picked) return null
  const jd = (j as Record<string, unknown>).date
  const date = typeof jd === "string" ? jd : ymdLocal(new Date())
  return { rates: picked, date, live: true }
}

/**
 * 拉一轮：主源 → 备源 → null（null = 继续用内置表）。拉到之后与内置表**合并**：
 * 个别币种某个源没有（比如 ECB 体系缺 TWD）就用内置值顶上，不至于让那台机器掉出合计。
 * 给单测留了 fetch 注入。
 */
export async function fetchRates(f: FetchLike = fetch): Promise<FxSnapshot | null> {
  const snap = (await fromErApi(f)) ?? (await fromCurrencyApi(f))
  if (!snap) return null
  return { ...snap, rates: { ...FX_BUILTIN.rates, ...snap.rates } }
}

/** localStorage 的安全拿取（隐身模式 / Node 单测 / 被禁都返回 null）。 */
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

/** 读 24 小时内的缓存；坏了 / 过期 / 被手改过一律当作没有。给单测导出。 */
export function readCache(): FxSnapshot | null {
  const ls = storage()
  if (!ls) return null
  try {
    const raw = ls.getItem(CACHE_KEY)
    if (!raw) return null
    const j = JSON.parse(raw) as { rates?: FxRates; date?: string; at?: number }
    if (typeof j.at !== "number" || Date.now() - j.at > TTL_MS) return null
    if (typeof j.date !== "string" || typeof j.rates !== "object" || !j.rates) return null
    // 存回来的也过一遍同一道关（防手改、也防旧版本写坏）
    const picked = pickRates(j.rates)
    if (!picked) return null
    return { rates: { ...FX_BUILTIN.rates, ...picked }, date: j.date, live: true }
  } catch {
    return null
  }
}

/** 写缓存；写不进（隐身模式 / 配额满）就算了——下一次打开再拉一轮而已。给单测导出。 */
export function writeCache(snap: FxSnapshot): void {
  const ls = storage()
  if (!ls) return
  try {
    ls.setItem(CACHE_KEY, JSON.stringify({ rates: snap.rates, date: snap.date, at: Date.now() }))
  } catch {
    /* 静默 */
  }
}

/**
 * 概览卡用：拿「现在该用哪一份汇率」。初始值 = 新鲜缓存 ∪ 内置表（首屏渲染就有数）；
 * 缓存过期 / 没有时在后台拉一轮（拉到 → 写缓存 + 无缝换上新数字；拉不到 → 保持原样）。
 * 响应式在这里只影响两个数的重算，不产生任何额外的请求或闪烁。
 */
export function useFx(): FxSnapshot {
  const [snap, setSnap] = useState<FxSnapshot>(() => readCache() ?? FX_BUILTIN)
  useEffect(() => {
    if (readCache()) return
    let alive = true
    void fetchRates().then((fresh) => {
      if (!alive || !fresh) return
      writeCache(fresh)
      setSnap(fresh)
    })
    return () => {
      alive = false
    }
  }, [])
  return snap
}

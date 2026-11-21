// api() 的超时与取消：① 服务器永不回包时必须在限时内 reject（不能永远挂着）
// ② 取消信号与超时要能区分 ③ 200 但 body 非法 JSON 时的报错文案 ④ 正常路径不受影响
//
// ★为什么这条重要（2026-11-21 三审）：`today-traffic` 的浮层用 `Promise.all(workers)` 收口，
//   一个请求永不 settle 就会让整个浮层永远停在「读取中…」；`Latency` 的排队闸门里那一格
//   名额也永不归还。这条测试会真等 12 秒（轻请求档），是 `npm test` 里最慢的一条。
import { api, API_TIMEOUTS, ApiError } from "./api.ts"

let pass = 0, fail = 0
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? " — " + detail : ""}`)
  if (ok) pass++
  else fail++
}

const realFetch = globalThis.fetch
// 压到毫秒级（真实的 12s / 30s 只在生产里用）
const REAL_TIMEOUTS = { ...API_TIMEOUTS }
API_TIMEOUTS.fast = 60
API_TIMEOUTS.slow = 400
// Node 里 AbortSignal.timeout 的定时器是 unref 的：不挂一个活跃句柄，进程会在超时前退出。
const keepAlive = setInterval(() => {}, 1000)

/* ① 永不回包的服务器：必须在 ~12s 内 reject 成 408（轻请求档） */
{
  globalThis.fetch = ((_u: string, init?: RequestInit) => new Promise((_res, rej) => {
    // 模拟「连接被黑洞」：永不 resolve。但要响应 abort，否则 AbortSignal.timeout 无从生效。
    init?.signal?.addEventListener("abort", () => rej(init.signal!.reason))
  })) as typeof fetch
  const t0 = Date.now()
  let err: unknown = null
  try { await api("/nodes") } catch (e) { err = e }
  const ms = Date.now() - t0
  check("永不回包：在限时内 reject（不是永远挂住）", err !== null && ms < 2_000, `${ms}ms`)
  check("永不回包：报成 408 与一句人话", err instanceof ApiError && err.status === 408, String(err instanceof ApiError ? err.message : err))
  console.log(`   （实测等待 ${ms}ms，测试里把轻请求档压到 ${API_TIMEOUTS.fast}ms）`)
}

/* ② 历史窗口那一路给 30s（这里只验分类判据，不真等 30s） */
{
  globalThis.fetch = ((_u: string, init?: RequestInit) => new Promise((_res, rej) => {
    init?.signal?.addEventListener("abort", () => rej(init.signal!.reason))
  })) as typeof fetch
  const t0 = Date.now()
  const p = api("/nodes/1/metrics?hours=1&points=40&series=ping").catch(() => Date.now() - t0)
  // 12s 时它不该已经结束（说明走的是 30s 档）
  // 轻请求档 60ms、历史档 400ms：在 150ms 时它应当还在等（证明走的是慢档）
  const early = await Promise.race([p, new Promise((r) => setTimeout(() => r("still-pending"), 150))])
  check("历史窗口走慢档（150ms 时仍在等待，说明没按 60ms 那档超时）", early === "still-pending", String(early))
  await new Promise((r) => setTimeout(r, 400))   // 等它自己超时收尾，别把进程拖住
}

/* ③ 200 但 body 不是合法 JSON */
{
  globalThis.fetch = (async () => new Response("not json", { status: 200 })) as typeof fetch
  let err: unknown = null
  try { await api("/nodes") } catch (e) { err = e }
  check("200 但 body 非法：报成 ApiError 而不是裸 SyntaxError",
    err instanceof ApiError && /不是合法的 JSON/.test((err as ApiError).message),
    String(err instanceof ApiError ? `${err.status} ${err.message}` : err))
}

/* ④ 调用方自己的取消信号：不能被伪装成超时 */
{
  // ★这里必须把超时档调大（否则 60ms 的超时会比 300ms 的取消先到，测的就不是取消了）
  API_TIMEOUTS.fast = 5_000
  globalThis.fetch = ((_u: string, init?: RequestInit) => new Promise((_res, rej) => {
    init?.signal?.addEventListener("abort", () => rej(init.signal!.reason))
  })) as typeof fetch
  const ctl = new AbortController()
  const p = api("/nodes", { signal: ctl.signal }).catch((e) => e)
  setTimeout(() => ctl.abort(), 300)
  const err = await p
  check("调用方取消：抛的是 AbortError（不是 408 超时）",
    err instanceof DOMException && err.name === "AbortError",
    String(err instanceof Error ? `${err.name}: ${err.message}` : err))
}

/* ④b body 读到一半卡住：定时器必须管到 body 读完（反代 200 之后停止转发） */
{
  API_TIMEOUTS.fast = 80
  globalThis.fetch = ((_u: string, init?: RequestInit) => Promise.resolve({
    ok: true, status: 200,
    // 一个永远读不完的 body：`json()` 里等不到结束，只有 abort 能把它打断
    json: () => new Promise((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))
    }),
    text: async () => "",
  } as unknown as Response)) as typeof fetch
  const t0 = Date.now()
  let err: unknown = null
  try { await api("/nodes") } catch (e) { err = e }
  const ms = Date.now() - t0
  check("body 卡住：也有限时（定时器覆盖到 body 读完）", err !== null && ms < 2_000, `${ms}ms`)
  check("body 卡住：报成 408 而不是裸 AbortError",
    err instanceof ApiError && err.status === 408, String(err instanceof ApiError ? err.message : err))
}

/* ④c 取消发生在**读 body 阶段**：也不能被报成 408 超时 */
{
  API_TIMEOUTS.fast = 5_000
  globalThis.fetch = ((_u: string, init?: RequestInit) => Promise.resolve({
    ok: true, status: 200,
    json: () => new Promise((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))
    }),
    text: async () => "",
  } as unknown as Response)) as typeof fetch
  const ctl = new AbortController()
  const p = api("/nodes", { signal: ctl.signal }).catch((e) => e)
  setTimeout(() => ctl.abort(), 200)
  const err = await p
  check("读 body 阶段被取消：抛 AbortError，不伪装成 408 超时",
    err instanceof DOMException && err.name === "AbortError",
    err instanceof ApiError ? `ApiError(${err.status}) ${err.message}` : `${(err as Error)?.name}`)
  API_TIMEOUTS.fast = 60
}

/* ⑤ 正常响应仍然解析得出来（不要因为加了 try 而把正常路径弄坏） */
{
  API_TIMEOUTS.fast = 60
  globalThis.fetch = (async () => new Response(JSON.stringify({ nodes: [1, 2] }), {
    status: 200, headers: { "content-type": "application/json" },
  })) as typeof fetch
  const got = await api<{ nodes: number[] }>("/nodes")
  check("正常响应照常解析", JSON.stringify(got) === '{"nodes":[1,2]}', JSON.stringify(got))
}

globalThis.fetch = realFetch
Object.assign(API_TIMEOUTS, REAL_TIMEOUTS)
clearInterval(keepAlive)
console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail ? 1 : 0)

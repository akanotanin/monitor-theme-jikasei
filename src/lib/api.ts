import { useEffect, useState } from "react"

export type Metrics = {
  uptime: number
  cpu: number
  load: [number, number, number]
  mem_total: number
  mem_used: number
  swap_total: number
  swap_used: number
  disk_total: number
  disk_used: number
  net_rx: number
  net_tx: number
  total_rx: number
  total_tx: number
  month_rx: number
  month_tx: number
  /**
   * 连接数 / 进程数：hub 1.4.0 起才稳定带上（更早的 agent 可能整列不报）。缺了**不许**
   * 把整块实时数据作废 —— 见 safeNodes：这三列降级成 null，CPU / 内存 / 网速照常显示。
   */
  tcp?: number | null
  udp?: number | null
  procs?: number | null
}

export type Node = {
  id: number
  name: string
  sort: number
  public: boolean
  online: boolean
  /** ISO 3166-1 alpha-2, or empty when the hub could not locate the address. */
  country: string
  /** Set by the operator; empty is ungrouped. Absent from a hub predating groups. */
  group?: string
  /**
   * 站长在后台写给访客的一行说明（单行、≤100 字，留空是空串）。hub 1.3.2 起随**公开视图**
   * 一起下发，所以匿名也拿得到——与最下面那个私有的 `remark` 不是一回事。老 hub 没有这个 key。
   * 这是访客可见的那条备注（见 `@/lib/notes`）：主题这边没有备注设置项，只读 hub 下发的字段。
   */
  public_remark?: string | null
  last_seen: number
  /**
   * 距上次上报的秒数，按 **hub 的时钟**算（hub 1.4.0 起随公开视图一起下发；从未上报为 `null`，
   * 老 hub 没有这个 key）。显示「离线 N」要用它——拿 `last_seen` 减访客浏览器的时钟，在
   * 访客时钟偏了的时候会报出错误的时长（快 8 小时就显示成离线 8 小时）。
   */
  last_seen_ago?: number | null
  metrics: Metrics | null
  os: string
  kernel: string
  arch: string
  virt: string
  cpu_name: string
  cpu_cores: number
  mem_total: number
  swap_total: number
  disk_total: number
  agent_version: string
  price: number
  currency: string
  billing_cycle: string
  expires_at: string | null
  /**
   * Days until `expires_at` on the hub's calendar, negative once past, null
   * without a date. Absent on older hubs.
   */
  expires_in?: number | null
  traffic_limit: number
  traffic_mode: string
  traffic_reset_day: number
  total_rx: number
  total_tx: number
  month_rx: number
  month_tx: number
  /** This period's usage as the plan meters it (`traffic_mode`). Absent on older hubs. */
  month_used?: number
  month_start: string
  day_rx: number
  day_tx: number
  /** Panel only. */
  hostname?: string
  ip?: string
  remark?: string
}

/** Every group in use, in the order of the first node carrying it: the operator's node order decides the tab order. */
export function groupsOf(nodes: Pick<Node, "group">[]): string[] {
  return [...new Set(nodes.map((n) => n.group ?? "").filter(Boolean))]
}

/**
 * 分组筛选的一次求值：把「选中的那一档」归一化，并给出要显示的节点、标签行的内容与总台数。
 *
 * 归一化：选中的分组被改名/解散、或「未分组」里已经没人了，都回落「全部」而不是停在一个
 * 什么都看不见的筛选上，且不记住——以后出现同名分组也不会自己接手这个页面。
 * 标签行整行关掉（listTop 不含 groups）时 `current` 恒为 null：站长在后台一关，
 * 访客手里的分组选中态就作废。
 *
 * ★App 与 NodeList 读**同一次**求值：概览卡片取 `shown`、下面的列表也取 `shown`，
 * 两边不可能各说一套。早先概览卡片拿的是全量节点，切了分组后上面写着「3 / 4 · Node B」、
 * 下面却只剩一个分组那两张卡片 —— 参考站（monitor 内置 default 主题）的概览四格拿的
 * 就是筛选后的节点，这里对齐它。
 */
export function groupView(nodes: Node[], group: string | null, showTabs: boolean) {
  const groups = groupsOf(nodes)
  const ungrouped = nodes.filter((n) => !n.group).length
  const current = !showTabs ? null : group === null || (group === "" ? ungrouped > 0 : groups.includes(group)) ? group : null
  const shown = current === null ? nodes : nodes.filter((n) => (n.group ?? "") === current)
  const tabs = [
    [null, "全部", nodes.length] as const,
    ...groups.map((g) => [g, g, nodes.filter((n) => n.group === g).length] as const),
    ...(ungrouped ? [["", "未分组", ungrouped] as const] : []),
  ]
  return { groups, ungrouped, current, shown, tabs, total: nodes.length, showTabs }
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * 一次 API 调用。
 *
 * ★**必须带超时**（2026-11-21 三审）：原先只 `await fetch(...)`，一旦路径上的连接被黑洞
 *   （反代接受 TCP 但不回包、手机切网、NAT 掉表），这个 Promise 永不 settle。后果不是「一个
 *   请求慢」而是连锁的：
 *     · `today-traffic` 的浮层用 `Promise.all(workers)` 收口 —— 一个 worker 卡住，浮层永远
 *       停在「读取中…」（`loaded` 永远到不了 true，42 台的行全在等）；
 *     · `NodeDetail` 的历史请求卡住 → 页签一直显示骨架；
 *     · `Latency` 的排队闸门里那一格名额永不归还（`release` 在 finally 里，而 finally 等不到）。
 *   `AbortSignal.timeout` 在所有目标浏览器里都可用（Chrome 103+ / Safari 16+），不带 polyfill。
 *
 * 时长按「这条请求值多少等待」分两档（与工具链里其它仓同一口径）：历史窗口最贵（hub 要现场
 * 聚合，会 503），给 30s；其余轻请求 12s。调用方可以自己传 `signal`，两个信号会合并 ——
 * 外部取消与超时谁先到算谁。
 */
const SLOW_PATH = /\/metrics\?/
/**
 * 两档超时（毫秒）。**导出是为了单测**：真等 12 秒会让 `npm test` 与 CI 白等一轮，
 * 测试里把它调成几十毫秒就能验同一套逻辑（判据是「限时内 reject」而不是「等满 12 秒」）。
 * 生产代码不该改它。
 */
export const API_TIMEOUTS = { fast: 12_000, slow: 30_000 }

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // 一个控制器统管「外部取消」与「超时」两个来源 —— 用 `AbortSignal.any` 也行，但它只在
  // Chrome 116+/Safari 17.4+ 才有；缺它时若直接退回 `limit`，调用方的取消信号会被**静默
  // 吞掉**（拿不到取消能力）。所以统一走控制器的合并写法，判据也干净：
  //   `cancelled` 记「是谁触发的 abort」，catch 里不用去猜异常类型名。
  const ctl = new AbortController()
  const budget = SLOW_PATH.test(path) ? API_TIMEOUTS.slow : API_TIMEOUTS.fast
  let timedOut = false
  let cancelled = false
  const timer = setTimeout(() => { timedOut = true; ctl.abort() }, budget)
  const onAbort = () => { cancelled = true; ctl.abort() }
  if (init?.signal) {
    if (init.signal.aborted) onAbort()
    else init.signal.addEventListener("abort", onAbort, { once: true })
  }
  // 定时器要一直管到 body 读完才清 —— 只包住 `fetch()` 的话，响应头按时到达、body 却卡住时
  // 就没有超时保护了（反代 200 之后停止转发是常见故障）。
  try {
    let res: Response
    try {
      res = await fetch(`/api${path}`, {
        ...init,
        signal: ctl.signal,
        headers: init?.body ? { "content-type": "application/json", ...init?.headers } : init?.headers,
      })
    } catch (e) {
      // 超时与「调用方取消」都不是网络错误，要能分开说：前者给一句人话，后者原样抛
      // （调用方通常靠它判断「这次不算失败」，不能把取消伪装成超时）。
      // ★判据看**是哪个信号先触发**，不看异常的类型名（2026-11-21 三审）：经过信号合并后，
      //   abort 的 reason 会被换成合成信号自己的 `DOMException("This operation was aborted")`，
      //   拿 `name === "TimeoutError"` 去认超时永远认不出来（会把真超时当成取消）。
      if (cancelled) throw e            // 调用方自己取消的（可能伴随组件卸载）
      if (timedOut) throw new ApiError(408, "请求超时（服务器没有及时响应）")
      throw e
    }
    // ★三层回落（2026-11-07 二审）：`res.text()` 在有些反代/HTTP2 上是空串，
    //   `statusText` 在现代协议里又常常也是空串（HTTP/2 起没有 reason phrase）——
    //   于是 `error === ""`，页面上那行报错整行不渲染，看起来像「什么都没发生」。
    //   最后补一个带状态码的兜底，保证任何失败都有一句人话。
    if (!res.ok) {
      const body = (await res.text()).trim()
      throw new ApiError(res.status, body || res.statusText || `请求失败（HTTP ${res.status}）`)
    }
    // ★`res.json()` 也要包起来（2026-11-21 三审）：信号只覆盖到响应头到达，
    //   若 body 分块传输到一半断开（反代超时、手机切网），读 body 会挂住或抛 SyntaxError。
    //   这里把两种情况都收敛成 ApiError，调用方的 catch 才能统一处理。
    if (res.status === 204) return undefined as T
    try {
      return (await res.json()) as T
    } catch (e) {
      // 与上面 fetch 那段同一套判据（2026-11-21 三审）：先认「调用方取消」，再认「超时」。
      // 子审抓到的形状：`e.name === "AbortError"` 在两种情况下都成立，先判它会把**组件卸载
      // 时的取消**报成「服务器超时」—— 与这段代码自己的注释直接矛盾，也会在卸载后多一条
      // 假错误。所以这里仍然只信 timedOut / cancelled 两个布尔量。
      if (cancelled) throw e
      if (timedOut) throw new ApiError(408, "请求超时（数据没有传完）")
      throw new ApiError(res.status, "响应不是合法的 JSON")
    }
  } finally {
    clearTimeout(timer)
    init?.signal?.removeEventListener("abort", onAbort)
  }
}

/**
 * Throughput, one sample per push, as a series for every node (null) and one per
 * group ("" for the ungrouped), so the summary above a group tab draws that
 * group's line rather than the fleet's. Held beside the stream that feeds it
 * rather than in the tile that draws it: the summary unmounts while a node page
 * is open, so a buffer held there would restart empty on every return. Two
 * minutes at the hub's push interval; a group no node carries any more is
 * dropped. Keyed null rather than by any string, since a group may be named
 * anything, "*" included.
 */
const KEEP = 60
export const speedHistory = new Map<string | null, { rx: number; tx: number }[]>()

export function sample(nodes: Node[]) {
  const totals = new Map<string | null, { rx: number; tx: number }>()
  for (const n of nodes) {
    for (const key of [null, n.group ?? ""]) {
      const total = totals.get(key) ?? { rx: 0, tx: 0 }
      if (n.online && n.metrics) {
        total.rx += n.metrics.net_rx
        total.tx += n.metrics.net_tx
      }
      totals.set(key, total)
    }
  }
  for (const key of speedHistory.keys()) if (!totals.has(key)) speedHistory.delete(key)
  for (const [key, total] of totals) {
    const series = speedHistory.get(key) ?? []
    series.push(total)
    if (series.length > KEEP) series.shift()
    speedHistory.set(key, series)
  }
}

/** A malformed report must not remove every other node from the page. */
export function safeNodes(nodes: Node[]): Node[] {
  const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0
  // 承重的那几列：坏一个就整块 metrics 作废（卡片宁可不显示，也不显示一半的假读数）。
  const required = ["uptime", "cpu", "mem_total", "mem_used", "swap_total", "swap_used", "disk_total", "disk_used",
    "net_rx", "net_tx", "total_rx", "total_tx", "month_rx", "month_tx"] as const
  // 可有可无：agent 与 hub 版本不同步时可能整列不报（hub 自己的 check_contract 也只 warn）。
  // 缺了降级成 null —— 早先它们也算「必需」，一台少报 procs 的机器会连 CPU / 内存 / 网速一起消失，
  // 还会因为 `online && metrics` 这条沉底判据掉到列表最后一屏。
  const optional = ["tcp", "udp", "procs"] as const
  return nodes.map((node) => {
    const m = node.metrics
    if (!m) return node
    const valid = required.every((key) => number(m[key])) && Array.isArray(m.load) && m.load.length === 3 && m.load.every(number)
    if (!valid) return { ...node, metrics: null }
    // ★判据必须与下面那条兜底分支同一个（2026-11-21 三审）：原先这里是
    //   `typeof m[key] === "number"` —— NaN 与 Infinity 都是 number，于是
    //   `{"tcp":1e999}`（JSON.parse 得到 Infinity）和 NaN 全部原样放行到页面，
    //   而另一条分支用的是会夹住它们的 `number()`。NodeDetail 直接 `${m.tcp} / ${m.udp}`
    //   就印出「NaN / -1」。
    if (optional.every((key) => number(m[key]))) return node
    const metrics = { ...m }
    for (const key of optional) metrics[key] = number(m[key]) ? (m[key] as number) : null
    return { ...node, metrics }
  })
}

/**
 * Live node list. Uses the WebSocket the hub pushes every two seconds, falling
 * back to polling if it cannot be established.
 *
 * ★ 后台标签页不再养着这条连接（2026-10-09 起，hub 1.4.0 那轮适配清单里的「切回前台」一项）：
 *   藏起来就关掉 WS、停掉兜底轮询（每 2 秒一帧、每帧一次 React 重渲染，后台里白烧电）；
 *   回到前台立刻补一次 /api/nodes 再重连。另一头是**连接数**：反代按 IP 限并发 WS，
 *   同一个访客开着的一堆标签页会互相挤（那台的 limit_conn 就是被自己的浏览器打满过）。
 */
export function useNodes() {
  const [nodes, setNodes] = useState<Node[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // ★「实时通道断了」是一个**独立**的状态，不从 error 里借道（2026-11-07 二审）。
  //   原先看门狗把 warning 写进 error，紧接着它自己发起的 `/api/nodes` 成功回包走
  //   `receive()` → `setError(null)` → 提示只亮了 0.3 秒（一次 HTTP 往返）就被擦掉。
  //   而那次 200 证明的是「HTTP 这条链路通」，不是「WS 回来了」——两件事不能互相抵消。
  //   这里只由**真的读出一帧推送**解除（见 ws.onmessage），HTTP 快照不碰它。
  const [stalled, setStalled] = useState(false)

  // Set when the hub answers 401: the status page has been closed to anonymous
  // callers since this tab loaded. The hub also ends the stream, so this surfaces
  // on the fallback fetch the reconnect starts; a close allows a client to
  // re-query its state but cannot compel it.
  const [closed, setClosed] = useState(false)

  useEffect(() => {
    let socket: WebSocket | null = null
    let poll: ReturnType<typeof setInterval> | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    // 看门狗（见 watch）：一帧都没读到的定时器。
    let silent: ReturnType<typeof setTimeout> | null = null
    let closed = false
    // ★401 一旦发生就不再翻回去（2026-11-07 二审）：`receive()` 原先无条件
    //   `setClosed(false)`，于是一条迟到的推送就能把 `closed` 翻回来，App 的
    //   `useEffect([closed])` 再跑一次 `loadMe()` —— 反复打 401 接口。
    //   闭页是站长的决定，只有刷新这一页才该重新问。
    let unauthorized = false
    let visible = document.visibilityState !== "hidden"
    // 中断过（页面藏起来 / 连接静默死掉）：下一次收到数据时把走势线的采样清掉 ——
    // 它是按位置画的，中断前后的两个点会被连成「中间什么也没发生」的一段（见 sample）。
    let gap = false
    // ★看门狗重建的指数退避（2026-11-07 二审，与 H-1 同批）：半开连接下原先每 10 秒
    //   重建一条（5 分钟 30 条 WS + 30 次 HTTP），对一个按 IP 限并发 WS 的部署是实打实的
    //   压力。序列 10 → 20 → 40 → 60 秒封顶，**收到一帧就归零**；用户切回前台也归零
    //   （那是明确的人工动作，不该还等 60 秒）。
    const BACKOFF = [10_000, 20_000, 40_000, 60_000]
    let strikes = 0
    // 卸载后的迟到响应不许再写模块级的 speedHistory（见 L-5）：alive 一置假，
    // receive 就彻底不落地。
    let alive = true
    // ★是否真的收到过一帧（2026-11-21 三审）：用来区分「页面刚打开、WS 还在握手」与
    //   「本来好好的、现在断了」。前者不该闪「数据中断」，后者必须立刻说。
    let gotFrame = false
    // ★首连宽限（毫秒）：从 effect 启动算起，这段时间内的连接失败不报警。取 3 秒 ——
    //   正常的 WS 升级在局域网/反代上是几十毫秒，跨洋 + CF 也就几百毫秒；3 秒还没接上
    //   就是真有问题了，而 10 秒（看门狗那档）又太晚。
    const CONNECT_GRACE = 3_000
    const startedAt = Date.now()
    // ★宽限到期时的复查（2026-11-21 三审）：只靠 onclose 的现场判据会漏掉一种常见形状 ——
    //   **第一次**握手就失败，此刻离 `startedAt` 还不到 3 秒（宽限内），于是不报警；接着
    //   进入 10 秒退避，第二次失败要到 10 秒后才发生。结果「WS 完全连不上」这种最该立刻
    //   说明的情况，反而 19 秒才报（实测）。这里在首连失败时补一个「宽限到期再看一眼」
    //   的定时器：到点还没接过帧就报警。
    let graceTimer: ReturnType<typeof setTimeout> | null = null
    const armGrace = () => {
      if (graceTimer || gotFrame) return
      const left = Math.max(0, CONNECT_GRACE - (Date.now() - startedAt))
      graceTimer = setTimeout(() => {
        graceTimer = null
        if (!alive || gotFrame || closed || !visible) return
        setStalled(true)
      }, left + 20)
    }

    const receive = (list: Node[]) => {
      if (!alive) return
      const safe = safeNodes(list)
      if (gap) speedHistory.clear()
      gap = false
      sample(safe)
      setNodes(safe)
      setError(null)
      if (!unauthorized) setClosed(false)
    }

    const fetchOnce = () =>
      api<{ nodes: Node[] }>("/nodes")
        .then((d) => receive(d.nodes))
        .catch((e: Error) => {
          if (!alive) return
          // 空 body 的 502 会让 `e.message` 是空串，整行报错就不渲染了（api() 已经回落到
          // statusText，但 HTTP/2 起没有 reason phrase）—— 这里再兜一层。
          setError(e.message || "网络错误")
          if (e instanceof ApiError && e.status === 401) {
            unauthorized = true
            setClosed(true)
          }
        })

    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`
    /**
     * 一条连接要走人时先把回调摘掉：它随后报的死（以及迟到的帧）都不该被当成「现在这条」的事。
     * 换连接时**不**先 `close()` 再等握手 —— 真死掉的连接要等满 60 秒关闭握手才报死，
     * 那段时间页面就是一行不动的旧数据。
     */
    const letGo = (ws: WebSocket | null) => {
      if (!ws) return
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      try {
        ws.close()
      } catch {
        // 已经没了。
      }
    }
    const stopWatch = () => {
      if (silent) {
        clearTimeout(silent)
        silent = null
      }
    }
    /**
     * 看门狗：**10 秒没读到一帧**就当这条连接已经死了（hub 每 2 秒推一次，5 个周期）。
     *
     * 为什么必须有：连接可能半开 —— 路径上的 NAT 忘了这条连接、对端机器直接掉电/断网，
     * 浏览器既收不到帧也收不到 close（Chrome 要等 TCP keepalive，约 450 秒才认）。
     * 那时只靠 `onclose` 的重连与兜底轮询都不会启动，状态页就一直显示几分钟前的在线状态与
     * 流量，而且什么都不报 —— 比报错更糟。换一条新连接，并把旧的那条就地摘掉。
     *
     * 只有**真的读出一帧**才重新上弦：读不出来的帧（坏 JSON）也算静默。
     */
    const watch = () => {
      stopWatch()
      silent = setTimeout(() => {
        silent = null
        if (closed || !visible) return
        // ★只置 `stalled`，不写 `error`：这是「推送断了」而不是「请求失败了」，
        //   两者要分开表达（见 stalled 的声明处）。也**不**在这里把它解除 ——
        //   HTTP 补数成功不代表 WS 回来了。
        //   与 onclose 同一条判据：首连宽限内还没接过帧就不吵（见 CONNECT_GRACE）。
        if (gotFrame || Date.now() - startedAt > CONNECT_GRACE) setStalled(true)
        // ★半开连接这条路径也要计入退避（2026-11-07 二审）：它既不触发 onclose、
        //   也不会自己恢复，是「每 10 秒重建一条」的主要来源。原先 strikes 只在
        //   onclose 里加，于是这条路的退避完全没生效（探针量的还是 30 条 / 5 分钟）。
        strikes = Math.min(strikes + 1, BACKOFF.length - 1)
        gap = true
        letGo(socket)
        socket = null
        // 新连接建好之前先把数据补上（/api/nodes 与推送是同一份快照）。
        fetchOnce()
        connect()
      }, BACKOFF[Math.min(strikes, BACKOFF.length - 1)])
    }

    // A hub restart closes every stream. Without reconnecting, a page that
    // outlives a deploy would remain on the fallback poll for the rest of its
    // life, refreshing at a fifth of the live rate with no indication.
    const connect = () => {
      if (retry) {
        clearTimeout(retry)
        retry = null
      }
      let ws: WebSocket
      try {
        ws = new WebSocket(url)
      } catch {
        poll ??= setInterval(fetchOnce, 5000)
        return
      }
      // 换上新的一条之前把旧的那条摘干净：重连定时器与看门狗都可能走到这里，两条并存会白占
      // 一个 hub 的流名额（反代那头是按 IP 限并发的）。
      if (socket) letGo(socket)
      socket = ws
      watch()
      ws.onmessage = (event) => {
        // 重连换代之后，旧连接迟到的帧不算数。
        if (socket !== ws) return
        let list: Node[] | undefined
        try {
          list = JSON.parse(event.data).nodes
        } catch {
          return
        }
        if (!Array.isArray(list)) return
        // 这一帧读出来了，连接确实还活着：看门狗重新上弦、退避归零、
        // 并把「实时数据中断」那条提示撤掉（这里是它**唯一**的解除点）。
        strikes = 0
        gotFrame = true
        setStalled(false)
        watch()
        receive(list)
        // The stream has returned; the poll was only covering for it.
        if (poll) {
          clearInterval(poll)
          poll = null
        }
      }
      ws.onerror = () => ws.close()
      ws.onclose = () => {
        // 隐藏时我们自己关的连接（以及它随后报的死）都不该把轮询/重连挂回去 —— 那是回前台的事。
        if (closed || socket !== ws || !visible) return
        stopWatch()
        // ★连接断了也要把「实时数据中断」亮起来（2026-11-21 三审）：看门狗只覆盖「握手成功
        //   但一帧都不来」的半开连接；而**握手就失败 / 刚连上就被断**（反代 502、hub 重启、
        //   按 IP 限流把新流挡掉）走的是这条 onclose 路径 —— 原先这里只挂轮询和重连，一句
        //   话都不说。页面于是退回 5 秒一次的 HTTP 轮询，数字照样会动，访客完全看不出
        //   「你现在读的是 5 秒前的快照」。
        //   实测（真 Chrome + 桩 hub，WS 升级后立即 1006）：14 秒内提示一次都没出现。
        //   解除点仍然只有 ws.onmessage 真的读出一帧。
        //   ★判据（2026-11-21 三审）：只要「收到过帧」或「已过首连宽限」就提示 ——
        //     首连过程中（页面刚打开、握手还没完成）不闪提示，否则比不提示更误导；
        //     而一旦曾经有过实时数据，或已经等了 3 秒还没接上，就必须说清楚。
        if (gotFrame || Date.now() - startedAt > CONNECT_GRACE) setStalled(true)
        else armGrace()          // 还在首连宽限里：到点再看一眼，别等到 10 秒退避后才报
        // ★握手就没成功过的连接也计入退避（2026-11-07 二审）：反代挂了 / 端口不通时
        //   原先每 5 秒一条、2 分钟 12 条，与看门狗那条路各算各的。两条路共用一个 strikes
        //   —— 只要没读到过帧，就越退越慢。
        strikes = Math.min(strikes + 1, BACKOFF.length - 1)
        poll ??= setInterval(fetchOnce, 5000)
        retry = setTimeout(connect, BACKOFF[Math.min(strikes, BACKOFF.length - 1)])
      }
    }

    const onVisibility = () => {
      const next = document.visibilityState !== "hidden"
      if (next === visible) return
      visible = next
      if (visible) {
        // 回前台：先把数据补上（藏起来那段一帧都没收），再把连接接回去。
        // 退避也一起归零 —— 切回来是明确的人工动作，不该还等上一轮的 60 秒。
        strikes = 0
        gap = true
        fetchOnce()
        if (!socket || socket.readyState > WebSocket.OPEN) connect()
      } else {
        // 藏起来：连接让出去（它自己那条 onclose 见 visible=false，不会挂上轮询/重连），
        // 看门狗也一起停 —— 后台里不该有任何定时器。
        gap = true
        stopWatch()
        letGo(socket)
        socket = null
        if (poll) { clearInterval(poll); poll = null }
        if (retry) { clearTimeout(retry); retry = null }
      }
    }
    document.addEventListener("visibilitychange", onVisibility)

    // 后台打开的标签页（中键/⌘+点击一堆链接）连第一条都不建：等它真的露脸再补。
    if (visible) {
      fetchOnce()
      connect()
    }

    return () => {
      closed = true
      alive = false
      stopWatch()
      if (graceTimer) clearTimeout(graceTimer)
      document.removeEventListener("visibilitychange", onVisibility)
      letGo(socket)
      socket = null
      if (poll) clearInterval(poll)
      if (retry) clearTimeout(retry)
    }
  }, [])

  // 第三个字段是「实时通道断了」：页面要把它画成一条**持续存在**的提示（不是 error 那种
  // 一闪而过的红字），因为它代表「你看到的数字不再更新」——那正是看门狗存在的理由。
  return { nodes, error, closed, stalled }
}

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
  tcp: number
  udp: number
  procs: number
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

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...init?.headers } : init?.headers,
  })
  if (!res.ok) throw new ApiError(res.status, (await res.text()) || res.statusText)
  return res.status === 204 ? (undefined as T) : res.json()
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
  const fields = ["uptime", "cpu", "mem_total", "mem_used", "swap_total", "swap_used", "disk_total", "disk_used",
    "net_rx", "net_tx", "total_rx", "total_tx", "month_rx", "month_tx", "tcp", "udp", "procs"] as const
  return nodes.map((node) => {
    const m = node.metrics
    return !m || (fields.every((key) => number(m[key])) && Array.isArray(m.load) && m.load.length === 3 && m.load.every(number))
      ? node : { ...node, metrics: null }
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
  // Set when the hub answers 401: the status page has been closed to anonymous
  // callers since this tab loaded. The hub also ends the stream, so this surfaces
  // on the fallback fetch the reconnect starts; a close allows a client to
  // re-query its state but cannot compel it.
  const [closed, setClosed] = useState(false)

  useEffect(() => {
    let socket: WebSocket | null = null
    let poll: ReturnType<typeof setInterval> | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let closed = false
    let visible = document.visibilityState !== "hidden"

    const receive = (list: Node[]) => {
      const safe = safeNodes(list)
      sample(safe)
      setNodes(safe)
      setError(null)
      setClosed(false)
    }

    const fetchOnce = () =>
      api<{ nodes: Node[] }>("/nodes")
        .then((d) => receive(d.nodes))
        .catch((e: Error) => {
          setError(e.message)
          if (e instanceof ApiError && e.status === 401) setClosed(true)
        })

    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`
    // A hub restart closes every stream. Without reconnecting, a page that
    // outlives a deploy would remain on the fallback poll for the rest of its
    // life, refreshing at a fifth of the live rate with no indication.
    const connect = () => {
      let ws: WebSocket
      try {
        ws = new WebSocket(url)
      } catch {
        poll ??= setInterval(fetchOnce, 5000)
        return
      }
      socket = ws
      ws.onmessage = (event) => {
        // 重连换代之后，旧连接迟到的帧不算数。
        if (socket !== ws) return
        receive(JSON.parse(event.data).nodes)
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
        poll ??= setInterval(fetchOnce, 5000)
        retry = setTimeout(connect, 5000)
      }
    }

    const onVisibility = () => {
      const next = document.visibilityState !== "hidden"
      if (next === visible) return
      visible = next
      if (visible) {
        // 回前台：先把数据补上（藏起来那段一帧都没收），再把连接接回去。
        fetchOnce()
        if (!socket || socket.readyState > WebSocket.OPEN) connect()
      } else {
        // 藏起来：连接让出去（它自己那条 onclose 见 visible=false，不会挂上轮询/重连）。
        socket?.close()
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
      document.removeEventListener("visibilitychange", onVisibility)
      socket?.close()
      if (poll) clearInterval(poll)
      if (retry) clearTimeout(retry)
    }
  }, [])

  return { nodes, error, closed }
}

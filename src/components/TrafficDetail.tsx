import { useEffect, useRef, useState } from "react"
import { ArrowDown, ArrowUp } from "lucide-react"

import { DetailScroll } from "@/components/DetailScroll"
import { Country } from "@/components/NodeCard"
import type { Node } from "@/lib/api"
import { bytes, clockBeijing, rate } from "@/lib/format"
import {
  dayStart,
  fetchTrafficPeaks,
  peakTargets,
  type TrafficPeak,
} from "@/lib/today-traffic"

/**
 * 「今日流量」那张概览卡片的**节点明细**浮层（2026-10-30 站长要求，参照别家的流量页）：
 *
 *   每台一行两段 —— 上一行是今天的下行 / 上行总量（卡片面上那两个数的逐台拆分），
 *   下一行是今天的**采样峰值**与它发生的时刻（上 ↑ / 下 ↓ 各一枚）。
 *
 * 数据：今日总量来自 `/api/nodes`（现成字段，零请求）；峰值要一台一个历史请求
 * （见 `@/lib/today-traffic` 的注释）。所以这一块**只在浮层打开时挂载**（Block 的 detail
 * 是开着才渲染的），回来一台填一台 —— 七台机器也是先有总量、再逐台补上峰值，
 * 不会先摆一排「加载中」把整块撑成空白。
 *
 * 排序按今天的总量降序（谁在跑流量谁在前），与别家那张表的读法一致。
 */
export function TrafficDetail({ nodes }: { nodes: Node[] }) {
  // 只在 id 集合变了才重取：`nodes` 每两秒被 WS 推一次、数组身份每次都新，直接拿它当依赖
  // 会把请求打成连环炮（还会把已经填好的峰值一次次清空）。
  const key = nodes.map((node) => node.id).join(",")
  const [peaks, setPeaks] = useState<Map<number, TrafficPeak>>(() => new Map())
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(0)
  // 这一轮**真的取了峰值**的那几台：浮层列出来的名单就是它（见 @/lib/today-traffic 的
  // peakTargets）。不能跟着每两秒一次的推送重排 —— 排名一换，新挤进前 48 的那台没取过峰值，
  // 行里只能写「—」，读起来像「这台没有采样」（2026-11-07 修）。
  const [targets, setTargets] = useState<Node[]>(() => peakTargets(nodes))
  // 取数用的名单：跟着当前这一批走（**不能**在挂载那一刻锁死 —— 浮层开着时新增/下线一台，
  // id 集合变了、effect 会用旧名单重取，新那台永远等不到峰值、还白打一轮请求）。
  const listRef = useRef(nodes)
  useEffect(() => {
    listRef.current = nodes
  })

  /**
   * 跨零点重取（2026-11-07 二审）：峰值窗口是「北京时间今天 0 点起」，而这一块只在
   * **id 集合**变化时才重跑 —— 浮层开着跨过零点，行里的峰值与时刻会一直停在昨天。
   * 这里按「离下一个北京零点还有多久」排一个定时器，到点把 `round` 加一，effect 重跑。
   * 缓存项也带了日（见 @/lib/today-traffic），所以重取不会命中昨天那份。
   * 定时器最长 1 小时一跳：前台闲置的标签页不该养着一个 24 小时的定时器（也避开
   * setTimeout 超过 2^31ms 的平台上限），到点再算下一次。
   */
  const [round, setRound] = useState(0)
  useEffect(() => {
    let timer = 0
    const tick = () => {
      const now = Date.now()
      const next = dayStart(now) + 86_400_000
      timer = window.setTimeout(() => {
        if (Date.now() >= next) setRound((n) => n + 1)
        else tick()
      }, Math.min(next - now + 1_000, 3_600_000))
    }
    tick()
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    let alive = true
    // 这一轮要列的名单（与下面取峰值用的是同一份，两处不会各排各的）。
    const list = peakTargets(listRef.current)
    setTargets(list)
    setPeaks(new Map())
    setLoaded(false)
    setFailed(0)
    void fetchTrafficPeaks(list, {
      onPeak: (id, peak) => {
        if (!alive) return
        setPeaks((prev) => new Map(prev).set(id, peak))
      },
      // 浮层关掉了就别再往 hub 上排队（在飞的那几个照常收尾、结果留在缓存里）。
      stopped: () => !alive,
    }).then((result) => {
      if (!alive) return
      setFailed(result.failed.length)
      setLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [key, round])

  // 机器多时（2026-10-31 站长提「机器特别多的时候」）：**只列**今日流量最大的 PEAK_LIMIT 台，
  // 也就是「列出来的每一台都有峰值」。早先是全列、只给前 48 台取峰值 —— 两百台时后 152 行
  // 全写着「—」，那既不是「没有采样」也不是「没取」，读起来就是个错。
  const total = nodes.length
  // 名单与顺序固定成**取峰值的那一份**；行里的读数仍取当前这一帧（今日流量照常每两秒跳）。
  // 已经被删掉的台从行里落掉（id 集合一变，上面那个 effect 会重新取名单位）。
  const current = new Map(nodes.map((node) => [node.id, node]))
  const rows = targets.map((node) => current.get(node.id)).filter((node): node is Node => node !== undefined)

  return (
    <>
      <span data-detail-head="" className="block border-b px-2.5 py-1.5 text-muted-foreground">
        节点明细 · {total} 台
      </span>
      <DetailScroll>
      {rows.map((node) => {
        const peak = peaks.get(node.id)
        const pending = !peak && !loaded
        return (
          <span key={node.id} data-traffic-row="" className="block">
            <span className="flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-center gap-1.5">
                <Country node={node} />
                <span className="min-w-0 truncate">{node.name}</span>
              </span>
              <span className="tnum shrink-0">
                <span className="text-muted-foreground">↓</span> {bytes(node.day_rx)}{" "}
                <span className="text-muted-foreground">↑</span> {bytes(node.day_tx)}
              </span>
            </span>
            {/* 第二行：峰值一行写完（上行、下行各一枚带时刻）。不像上面那行分左右 —— 分到两端时
                右边那枚就没有标签了，读起来像「峰值」只管左半截。 */}
            <span className="mt-0.5 flex min-w-0 items-center gap-1 text-muted-foreground">
              <span className="shrink-0">峰值</span>
              <PeakArrow icon={ArrowUp} value={peak?.up} at={peak?.upAt} pending={pending} />
              <span className="shrink-0" aria-hidden>·</span>
              <PeakArrow icon={ArrowDown} value={peak?.down} at={peak?.downAt} pending={pending} />
            </span>
          </span>
        )
      })}
      </DetailScroll>
      <span data-detail-foot="" className="block border-t px-2.5 py-1.5 text-muted-foreground">
        峰值按北京时间今天 00:00 起的历史采样计算（两分钟一个点）
        {total > rows.length ? `；共 ${total} 台，只列今日流量最大的 ${rows.length} 台` : ""}
        {failed > 0 ? `；${failed} 台读取失败` : ""}
      </span>
    </>
  )
}

/** 一枚峰值：箭头 + 数值 + 时刻；还没回来写「读取中…」，没有采样写「—」。 */
function PeakArrow({ icon: Icon, value, at, pending }: {
  icon: typeof ArrowUp
  value?: number
  at?: number | null
  pending: boolean
}) {
  if (pending) return <span className="tnum">读取中…</span>
  // ★判据只看 `at`（2026-11-21 三审）：原先 `!value` 把「峰值确实是 0 B/s」也当成没有采样，
  //   印成「—」—— 一台整天没流量的机器明明有采样、峰值就是 0，却和「读取失败 / 没有数据」
  //   共用同一个符号（而尾巴又另有一句「N 台读取失败」表达第三种状态）。
  if (at === null || at === undefined || !Number.isFinite(at)) return <span className="tnum">—</span>
  return (
    <span className="tnum inline-flex min-w-0 items-center gap-1 truncate">
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{rate(value ?? 0)}</span>
      {/* 峰值窗口按北京时间今天 0 点裁，钟点也要用北京时间 —— 访客本机时区是另一把尺子。 */}
      <span className="shrink-0 text-muted-foreground">{clockBeijing(at)}</span>
    </span>
  )
}

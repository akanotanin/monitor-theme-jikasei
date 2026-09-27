import type { Node } from "@/lib/api"

/**
 * 列表页顶上那行概览卡片要用的合计值。
 *
 * 全部来自 `/api/nodes` 里本来就有的字段——`day_rx`、`total_rx`、`metrics.net_rx`——
 * 所以这一行开着也不多发一个请求（唯一的例外是实时网速下面那条走势线，它画的是
 * 访客自己攒下的采样，见 api.ts 的 `speedHistory`）。
 *
 * 一台机器都没接入时 `total_rx` 之类都还是 0：hub 会保留「曾经报过一次」的机器的
 * 累计流量，所以掉线的机器照样算进总量，只有从未接入的那台是全 0。
 */
export type Fleet = {
  /** 公开节点总数。 */
  total: number
  /** 其中在线的台数。 */
  online: number
  /** 今日流量：`day_rx` / `day_tx` 之和。 */
  dayRx: number
  dayTx: number
  /** 累计流量：`total_rx` / `total_tx` 之和。 */
  totalRx: number
  totalTx: number
  /** 此刻所有**在线且有指标**的节点的收发速率之和；掉线的机器不贡献读数。 */
  netRx: number
  netTx: number
  /**
   * CPU 占用最高的在线节点，用于「最忙节点」。没有一台报了指标时为 null，
   * 卡片那时显示「—」而不是 0%，0% 会被读成「有一台，而且它闲着」。
   */
  busiest: { name: string; cpu: number } | null
}

export function summarize(nodes: Node[]): Fleet {
  const fleet: Fleet = {
    total: nodes.length,
    online: 0,
    dayRx: 0,
    dayTx: 0,
    totalRx: 0,
    totalTx: 0,
    netRx: 0,
    netTx: 0,
    busiest: null,
  }
  for (const node of nodes) {
    // `|| 0`：老 hub 没有 day_rx/day_tx 这几个字段，缺一个就整行合计成 NaN，
    // 那时候 bytes(NaN) 会把四张卡片一起写成 0 B。
    fleet.dayRx += node.day_rx || 0
    fleet.dayTx += node.day_tx || 0
    fleet.totalRx += node.total_rx || 0
    fleet.totalTx += node.total_tx || 0
    if (!node.online) continue
    fleet.online++
    const m = node.metrics
    if (!m) continue
    fleet.netRx += m.net_rx
    fleet.netTx += m.net_tx
    // 严格大于：并列时留着先出现的那台（列表顺序由站长排，顺序就是他的偏好）。
    if (!fleet.busiest || m.cpu > fleet.busiest.cpu) fleet.busiest = { name: node.name, cpu: m.cpu }
  }
  return fleet
}

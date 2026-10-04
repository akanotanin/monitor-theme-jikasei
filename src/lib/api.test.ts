/// <reference types="node" />
import assert from "node:assert/strict"
import { groupView, groupsOf, safeNodes, sample, speedHistory, type Node } from "./api.ts"

const node = { id: 1, metrics: { uptime: 100, cpu: 1, load: [0.1, 0.2, 0.3],
  mem_total: 1024, mem_used: 512, swap_total: 0, swap_used: 0, disk_total: 2048, disk_used: 1024,
  net_rx: 10, net_tx: 20, total_rx: 100, total_tx: 200, month_rx: 50, month_tx: 100,
  tcp: 3, udp: 4, procs: 20 } } as Node
assert.equal(safeNodes([node])[0], node)
for (const patch of [{ load: null }, { load: [1, "bad", 3] }, { cpu: "bad" }, { net_rx: Infinity }]) {
  const bad = { ...node, metrics: { ...node.metrics, ...patch } } as unknown as Node
  const result = safeNodes([bad, node])
  assert.equal(result[0].metrics, null)
  assert.equal(result[1], node)
}
console.log("invalid live reports are isolated")

// Tabs follow the node order; ungrouped nodes and a hub without the field add none.
assert.deepEqual(groupsOf([{ group: "东京" }, { group: "" }, {}, { group: "香港" }, { group: "东京" }]), ["东京", "香港"])
console.log("groups follow the node order")

// 分组筛选的一次求值：概览卡片与列表吃的是同一份 `shown`，所以这个函数是两者口径的唯一来源。
const g = (id: number, group: string) => ({ ...node, id, group }) as Node
const four = [g(1, "东京"), g(2, "东京"), g(3, "香港"), g(4, "")]
assert.equal(groupView(four, "东京", true).shown.length, 2, "选中一档就只剩那一档")
assert.deepEqual(groupView(four, "香港", true).shown.map((n) => n.id), [3])
assert.deepEqual(groupView(four, "", true).shown.map((n) => n.id), [4], "未分组用空串表示")
assert.equal(groupView(four, null, true).shown.length, 4)
// 悬空 / 已空的选中档回落「全部」，而不是停在一个什么都看不见的筛选上
assert.equal(groupView(four, "已经解散的组", true).current, null)
assert.equal(groupView(four, "已经解散的组", true).shown.length, 4)
assert.equal(groupView([g(1, "东京")], "", true).current, null, "未分组里没人了也回落")
// 标签行含台数，顺序照节点顺序
assert.deepEqual(groupView(four, null, true).tabs.map((t) => `${t[1]}${t[2]}`), ["全部4", "东京2", "香港1", "未分组1"])
assert.deepEqual(groupView([g(1, ""), g(2, "")], null, true).tabs.map((t) => `${t[1]}${t[2]}`), ["全部2", "未分组2"])
// 标签行整行关掉时选中态作废（站长在后台一关，访客手里那一档就不算数了）
assert.equal(groupView(four, "东京", false).current, null)
assert.equal(groupView(four, "东京", false).shown.length, 4)
assert.equal(groupView(four, "东京", false).total, 4)
console.log("the group filter is one evaluation for both the summary and the list")

// Each group keeps its own throughput line beside the fleet's, and a group that
// empties stops being tracked.
const live = (group: string, rx: number) => ({ ...node, group, online: true, metrics: { ...node.metrics!, net_rx: rx, net_tx: 0 } }) as Node
sample([live("东京", 5), live("", 7), { ...live("东京", 9), online: false }])
assert.deepEqual([speedHistory.get(null)?.at(-1)?.rx, speedHistory.get("东京")?.at(-1)?.rx, speedHistory.get("")?.at(-1)?.rx], [12, 5, 7])
sample([live("", 1)])
assert.equal(speedHistory.has("东京"), false)
// A group may be named anything, the fleet's own key included.
sample([live("*", 5), live("", 7)])
assert.deepEqual([speedHistory.get(null)?.at(-1)?.rx, speedHistory.get("*")?.at(-1)?.rx], [12, 5])
console.log("throughput is kept per group")

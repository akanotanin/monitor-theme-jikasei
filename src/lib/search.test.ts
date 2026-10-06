// 搜索口径：名称 / 地区 / 系统三处命中即算中；多个关键词是「都要中」（AND）。
// 跑法同另外几个：`npm test`（Node 自己剥类型，不需要 runner）。
// 没有任何东西 import 它，所以不进 bundle。
import { searchNodes, searchText, searchTerms } from "./search.ts"
import type { Node } from "./api.ts"

let failed = 0
function eq(got: unknown, want: unknown, what: string) {
  const [a, b] = [JSON.stringify(got), JSON.stringify(want)]
  if (a !== b) {
    failed++
    console.error(`✗ ${what}\n    得到 ${a}\n    期望 ${b}`)
  }
}

function node(id: number, name: string, over: Partial<Node> = {}): Node {
  return {
    id, name, sort: id, public: true, online: true, country: "", group: "",
    last_seen: 0, metrics: null, os: "", kernel: "", arch: "", virt: "", cpu_name: "",
    cpu_cores: 0, mem_total: 0, swap_total: 0, disk_total: 0, agent_version: "",
    price: 0, currency: "", billing_cycle: "", expires_at: null, traffic_limit: 0,
    traffic_mode: "sum", traffic_reset_day: 1, total_rx: 0, total_tx: 0,
    month_rx: 0, month_tx: 0, month_start: "", day_rx: 0, day_tx: 0,
    ...over,
  }
}

// 六台，三处字段各不重样：
//   ①东京 ②东京（Ubuntu） ③香港（Ubuntu） ④法兰克福（Debian） ⑤新加坡（Alpine，名字里没有中文） ⑥美国（Windows，没有分组）
const nodes = [
  node(1, "东京一号", { group: "东京", country: "JP", os: "Debian GNU/Linux 12 (bookworm)" }),
  node(2, "东京二号", { group: "东京", country: "JP", os: "Ubuntu 22.04.4 LTS" }),
  node(3, "香港一号", { group: "香港", country: "HK", os: "Ubuntu 22.04.4 LTS" }),
  node(4, "法兰克福一号", { group: "法兰克福", country: "DE", os: "Debian GNU/Linux 12 (bookworm)" }),
  node(5, "SG-Edge", { group: "新加坡", country: "SG", os: "Alpine Linux 3.20" }),
  node(6, "US-Backup", { group: "", country: "US", os: "Windows Server 2022" }),
]
const ids = (query: string) => searchNodes(nodes, query).shown.map((n) => n.id)

// 没在搜：原样返回，连数组都不重建（同一份引用，React 才不会白重算）。
const idle = searchNodes(nodes, "")
eq([idle.active, idle.hit, idle.total, idle.shown === nodes], [false, 6, 6, true], "空词＝没在搜，原样返回")
eq(searchNodes(nodes, "   ").active, false, "只有空白也算没在搜")
eq(searchNodes(nodes, "\u3000").active, false, "全角空格也算空白")

// 名称。
eq(ids("东京一号"), [1], "按名称搜")
eq(ids("edge"), [5], "名称大小写不敏感")

// 地区：分组、中文城市名、城市英文名、国家码、中文国名，五条路都要通。
eq(ids("东京"), [1, 2], "分组/名称里的中文城市名")
eq(ids("tokyo"), [1, 2], "城市英文名（地区列表里显示的那个）")
eq(ids("HK"), [3], "国家码")
eq(ids("hk"), [3], "国家码小写")
eq(ids("日本"), [1, 2], "中文国名（美国/日本这类 alias 只给搜索用）")
eq(ids("美国"), [6], "中文国名对没有分组的机器也成立")
eq(ids("新加坡"), [5], "分组名里的中文城市名（名称里没有）")

// 系统。
eq(ids("debian"), [1, 4], "按系统搜")
eq(ids("DEBIAN"), [1, 4], "系统大小写不敏感")
eq(ids("ubuntu 22"), [2, 3], "系统里带空格的两个词也要能中")
eq(ids("windows"), [6], "系统带墙的那台也搜得到")

// 多词 AND：命中一路收窄。
eq(ids("东京 ubuntu"), [2], "两个词都要中（AND）")
eq(ids("东京 debian"), [1], "地区 + 系统叠起来")
eq(ids("东京 香港"), [], "两个地区并列＝没有一台同时是两地")

// 搜不到的：命中 0，但 total 还是原样的台数（空态文案要说得出「几台里一台都没中」）。
const miss = searchNodes(nodes, "zzz")
eq([miss.hit, miss.total, miss.active, miss.terms], [0, 6, true, ["zzz"]], "搜不到时命中 0、总数不变")
eq(miss.shown, [], "搜不到时列表为空")

// 搜到但被别的字段挡住：价格/备注这些不在搜索口径里。
const priced = [node(7, "备用机", { group: "东京", country: "JP", os: "Debian 12", price: 349, remark: "深港专线" })]
eq(searchNodes(priced, "349").hit, 0, "价格不参与搜索")
eq(searchNodes(priced, "深港专线").hit, 0, "备注不参与搜索")
eq(searchNodes(priced, "东京").hit, 1, "同一台按分组仍然搜得到")

// searchText 的组成部分逐项钉住（多了字段会被这条看见）。
const one = node(8, "机A", { group: "东京", country: "JP", os: "Debian 12" })
const text = searchText(one)
eq(["机a", "东京", "debian 12", "jp", "日本", "tokyo"].every((piece) => text.includes(piece)), true, "可搜文本含：名称/分组/系统/国家码/中文国名/城市英文名")
eq(searchTerms("  东京 \u3000debian  "), ["东京", "debian"], "拆词：全角空格、前后空白都吃掉")

if (failed) {
  console.error(`\n${failed} 处不符`)
  process.exit(1)
}
console.log("搜索口径：全部通过")

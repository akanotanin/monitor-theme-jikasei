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

// ── 同义替换（这一版的重点）：中文 ↔ 英文 ↔ 三字码/国家码，两个方向都要通 ──
eq(ids("東京"), [1, 2], "城市中文名（繁体，地球那张表里收了）")
eq(ids("TYO"), [1, 2], "城市三字码（东京）")
eq(ids("japan"), [1, 2], "英文国名 → 国家码 JP 的那两台")
eq(ids("JPN"), [1, 2], "英文国名缩写")
eq(ids("germany"), [4], "英文国名（德国）")
eq(ids("frankfurt"), [4], "城市英文名（地区列表里显示的那个）")
eq(ids("FRA"), [4], "城市三字码（法兰克福）")
eq(ids("法兰克福"), [4], "中文城市名（名称里就有）")
eq(ids("sg"), [5], "国家码小写（新加坡，同时又是城市三字码）")
// 整串名称不该被城市同义词扩散：东京那条正则不锚定的话，搜「东京一号」会把整个东京都捞出来。
eq(ids("东京一号"), [1], "整串名称不被城市同义词扩散（正则要锚定）")
// 洲：地球那张城市表认不出洲，靠洲→国家码那张表。
eq(ids("北美"), [6], "洲名（美国那台，没有分组）")
eq(ids("north america"), [6], "洲名的英文写法（带空格，拆词时要护着）")
eq(ids("asia"), [1, 2, 3, 5], "洲名英文（亚洲：日/港/新）")
eq(ids("大洋洲"), [], "洲名（大洋洲：本夹具里没有）")

// 洲/大区的边界夹具：**没有分组**、只靠国家码落位的机器。
const area = [
  node(11, "伦敦一号", { group: "", country: "GB", os: "Debian 12" }),
  node(12, "法兰克福一号", { group: "", country: "DE", os: "Ubuntu 22.04" }),
  node(13, "东京三号", { group: "", country: "JP", os: "Debian 12" }),
  node(14, "西雅图一号", { group: "美西", country: "US", os: "Debian 12" }),
]
const aids = (query: string) => searchNodes(area, query).shown.map((n) => n.id)
eq(aids("欧洲"), [11, 12], "洲名（中文）：英德那两台，哪怕没写分组")
eq(aids("europe"), [11, 12], "洲名英文")
eq(aids("EU"), [11, 12], "洲名缩写（大小写不敏感）")
eq(aids("欧洲 debian"), [11], "洲名与系统叠起来（AND）")
eq(aids("亚洲"), [13], "洲名（亚洲）")
eq(aids("美西"), [14], "分区名原样（按分组名匹配）")
eq(aids("west us"), [14], "分区名的英文写法（整串不拆）")
eq(aids("美东"), [], "分区名（美东：本夹具里没有）")
// ★短码按词边界：搜「欧洲」会展开出国家码 de，不许因此命中跑 Debian 的机器（实测过这个假命中）。
eq(searchNodes([node(15, "美东一号", { group: "", country: "US", os: "Debian 12" })], "欧洲").hit, 0, "「欧洲」展开的国家码不许命中 Debian（短码按词边界）")

// ── 英文名字的机器：名称与分组里都没有中文，靠地球那张表把城市中文写法摊进可搜文本 ──
//    （用户报过「搜东不出东京、搜圣不出圣何塞」—— 站长用英文起名时就是这个情况。）
const en = [
  node(21, "JP-TYO-01", { group: "", country: "JP", os: "Debian 12" }),
  node(22, "US-SJC-01", { group: "", country: "US", os: "Debian 12" }),
  node(23, "ZZ-01", { group: "", country: "ZZ", os: "Debian 12" }),
]
const eids = (query: string) => searchNodes(en, query).shown.map((n) => n.id)
eq(eids("东"), [21], "英文名：中文部分字也中（东 → 东京）")
eq(eids("京"), [21], "英文名：京 → 东京")
eq(eids("东京"), [21], "英文名：中文全名也中")
eq(eids("東京"), [21], "英文名：繁体也中")
eq(eids("tokyo"), [21], "英文名：英文城市名也中")
eq(eids("TYO"), [21], "英文名：三字码也中")
eq(eids("圣"), [22], "英文名：圣 → 圣何塞")
eq(eids("塞"), [22], "英文名：塞 → 圣何塞")
eq(eids("圣何塞"), [22], "英文名：中文全名也中")
eq(eids("SJC"), [22], "英文名：三字码（圣何塞）")
eq(eids("san jose"), [22], "英文名：英文城市名带空格也中")
eq(searchNodes([en[2]], "东").hit, 0, "认不出城市的机器：搜中文城市名不中（不硬猜）")
// ── 前缀扩散：关键词是别名的前缀也算（`tok`/`TY` → 东京）；反过来不算（见上面「东京一号」那条） ──
eq(eids("ty"), [21], "英文名：三字码前缀（ty → TYO → 东京）")
eq(eids("TY"), [21], "英文名：三字码前缀（大写）")
eq(eids("TOK"), [21], "英文名：城市名前缀（tok → Tokyo）")
eq(eids("sj"), [22], "英文名：三字码前缀（sj → SJC → 圣何塞）")
eq(eids("san"), [22], "英文名：城市名前缀（san → San Jose）")
eq(searchNodes([en[2]], "ty").hit, 0, "认不出城市的机器：三字码前缀也不中")
// 一个拉丁字母（`t`）不当前缀用 —— 但这条**测不出来**：城市的英文名本来就在可搜文本里，
// 一个字母总会被「原样子串」那枚命中（这里是 2 台）。规则留着是为了别把 `t` 扩成一串城市，
// 说明写在 `isCityPrefix` 的注释里，不假装有断言罩着它。
eq(searchText(en[0]).includes("东京") && searchText(en[0]).includes("東京"), true, "可搜文本含城市的中文写法（含繁体）")

if (failed) {
  console.error(`\n${failed} 处不符`)
  process.exit(1)
}
console.log("搜索口径：全部通过")

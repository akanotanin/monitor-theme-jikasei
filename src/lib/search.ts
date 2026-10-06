import type { Node } from "@/lib/api"
// ★相对路径（不是 `@/lib/globe`）：src/lib 下的单测是 `node xxx.test.ts` 直接跑的
// （Node 自己剥类型），而 Node 不认 tsconfig 里那个 `@/` 别名 —— 值导入一律写相对路径，
// 类型导入保留别名（会被剥掉，不影响运行）。本仓库已有的 lib 互引用也都是这么写的。
import { regionOf } from "./globe.ts"

/**
 * 顶栏右上角那个搜索框的口径：一台机器只要**名称 / 地区 / 系统**里有一处命中就算中。
 *
 * 三处的取值：
 *   名称 —— `node.name`（含站长写的中文城市名，如「测试节点·东京」）；
 *   地区 —— 与地球那套同一个来源（`regionOf`：地区键、城市英文名、国家码），
 *           外加**节点所属分组**与一张国家码→中文名的小表（搜「日本」也要找得到 JP 的机器；
 *           分组也算地区，因为 theme 自己就是从「名称 + 分组」里认城市的，见 globe.ts 的 cityHint）。
 *           中文国名只用于搜索，不参与页面显示（页面上显示的仍是那面旗子与地区列表里的英文城市名）。
 *   系统 —— `node.os`（如 `Debian GNU/Linux 12 (bookworm)`）。
 *
 * 关键词按空白（半角/全角都认）拆开，**全都要命中**（AND）：`东京 debian` 这样把地区与系统
 * 叠起来写，命中数会一路收窄到那一台。大小写不敏感（`debian` / `DEBIAN` 等价）。
 *
 * 不匹配的就这些以外的字段（价格、到期、CPU 型号、备注……）：搜索结果要能对上页面上看得见
 * 的那三样，搜到一台却看不出它为什么中，比搜不到更让人困惑。
 */
export type SearchResult = {
  /** 命中之后该显示的那几台；没在搜时就是原样。 */
  shown: Node[]
  /** 搜索框里那串词（原样留着，报空态时要原样回显给访客）。 */
  query: string
  /** 拆好的关键词（小写）。 */
  terms: string[]
  /** 在搜吗（关键词非空）。 */
  active: boolean
  /** 命中台数。 */
  hit: number
  /** 搜之前在看的台数（用来告诉访客「几台里中了几台」）。 */
  total: number
}

/** 国家码 → 中文名。只给搜索用；表里没有的国家就只剩 `node.country` 那个码可搜。 */
const COUNTRY_ALIASES: Record<string, string> = {
  HK: "香港", JP: "日本", DE: "德国", NL: "荷兰", US: "美国", TW: "台湾",
  AU: "澳大利亚", SG: "新加坡", KR: "韩国", GB: "英国", FR: "法国", CN: "中国",
}

/** 拆关键词：全角空格先换成半角，再按空白拆，去掉空片段、统一小写。 */
export function searchTerms(query: string): string[] {
  return query
    .replace(/[\u3000\u00a0]/g, " ")
    .split(/\s+/)
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
}

/** 一台机器**能被搜到的全部文本**（小写）。导出它是为了让单测逐字钉住都收了哪些字段。 */
export function searchText(node: Node): string {
  const region = regionOf(node)
  const code = (node.country || "").trim().toUpperCase()
  return [
    node.name,
    node.group ?? "",
    node.os,
    // 国家码两种写法都收（hub 给的是大写 ISO，访客手打可能是小写）。
    code,
    COUNTRY_ALIASES[code] ?? "",
    // 城市只认得出英文名（CITY_HINTS 的第三项）——中文城市名本来就在名称/分组里，上面已经收了。
    region?.label ?? "",
    region?.city ?? "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

/** 按关键词收窄一组节点。空词＝没在搜（原样返回，连数组都不必重建）。 */
export function searchNodes(nodes: Node[], query: string): SearchResult {
  const terms = searchTerms(query)
  if (terms.length === 0) {
    return { shown: nodes, query, terms, active: false, hit: nodes.length, total: nodes.length }
  }
  const shown = nodes.filter((node) => {
    const text = searchText(node)
    return terms.every((term) => text.includes(term))
  })
  return { shown, query, terms, active: true, hit: shown.length, total: nodes.length }
}

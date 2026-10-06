import type { Node } from "@/lib/api"
// ★相对路径（不是 `@/lib/globe`）：src/lib 下的单测是 `node xxx.test.ts` 直接跑的
// （Node 自己剥类型），而 Node 不认 tsconfig 里那个 `@/` 别名 —— 值导入一律写相对路径，
// 类型导入保留别名（会被剥掉，不影响运行）。本仓库已有的 lib 互引用也都是这么写的。
import { regionOf } from "./globe.ts"
import { CITY_HINTS } from "./world.ts"

/**
 * 顶栏右上角那个搜索框的口径：一台机器只要**名称 / 地区 / 系统**里有一处命中就算中。
 *
 * 三处的取值：
 *   名称 —— `node.name`（含站长写的中文城市名，如「测试节点·东京」）；
 *   地区 —— 与地球那套同一个来源（`regionOf`：地区键、城市英文名、国家码），外加**节点所属分组**；
 *   系统 —— `node.os`（如 `Debian GNU/Linux 12 (bookworm)`）。
 *
 * ★**中文/英文/代码都能搜**（这一版的重点）：访客写「东京」，站长那张表里写的是 `Tokyo`；
 * 访客写「日本」，机器上是 `JP`。所以除了原样子串匹配，每个关键词还会**展开成一族同义词**再匹配：
 *   ① 城市：直接问地球那张 `CITY_HINTS`（它本来就同时收了中文名、英文名与三字码，如
 *      `/东京|東京|TOKYO|TYO/`）—— 表是同一张，地球认得出的城市搜索就认得出，不会各写一套；
 *      那张表里的中文写法还会摊进每台机器的可搜文本，于是站长用英文起名（`JP-TYO-01`）时，
 *      访客打「东」「东京」「TYO」一样搜得到；
 *   ② 国家：`WORD_FAMILIES` 里一族一族写着（`["日本","japan","jpn","jp"]`），节点的国家码
 *      会把它那一族的词都摊进可搜文本里，于是两个方向都通；
 *   ③ 洲/大区：`["欧洲","europe","eu"]` 这样的族，另配一张 `AREA_CODES`（洲 → 国家码）——
 *      站长没写分组、机器在德国，搜「欧洲」也要能捞出来。
 *
 * 短码（≤3 个拉丁字符，如 `de`/`jp`/`eu`）按**词边界**匹配，其余按子串：不然「欧洲」展开出来的
 * `de` 会把每台跑 Debian 的机器都算成欧洲的（实测过这个假命中）。访客自己打的那串词仍按子串，
 * 所以 `deb` 照样能搜到 `Debian`。
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

/**
 * 词族：同一族里的词互相代替。一律小写（中文不受影响）。
 * 第一项是访客最常见的中文写法，后面是英文写法与国家码 —— 顺序只影响可读性，不影响匹配。
 */
const WORD_FAMILIES: string[][] = [
  // 洲与大区
  ["欧洲", "europe", "eu"],
  ["亚洲", "asia"],
  ["东亚", "east asia"],
  ["东南亚", "southeast asia", "south east asia", "asean"],
  ["南亚", "south asia"],
  ["中东", "middle east"],
  ["北美", "north america"],
  ["美西", "west us", "us west"],
  ["美东", "east us", "us east"],
  ["南美", "south america", "latin america"],
  ["大洋洲", "oceania"],
  ["非洲", "africa"],
  // 国家：中文名 / 英文名 / 国家码（码会被摊进节点文本，所以两个方向都通）
  ["中国", "china", "cn"],
  ["香港", "hong kong", "hk"],
  ["台湾", "taiwan", "tw"],
  ["日本", "japan", "jpn", "jp"],
  ["韩国", "korea", "south korea", "kr"],
  ["新加坡", "singapore", "sg"],
  ["印度", "india", "in"],
  ["马来西亚", "malaysia", "my"],
  ["泰国", "thailand", "th"],
  ["越南", "vietnam", "vn"],
  ["印尼", "indonesia", "id"],
  ["菲律宾", "philippines", "ph"],
  ["阿联酋", "uae", "united arab emirates", "ae"],
  ["以色列", "israel", "il"],
  ["土耳其", "turkey", "tr"],
  ["英国", "uk", "united kingdom", "britain", "england", "gb"],
  ["爱尔兰", "ireland", "ie"],
  ["德国", "germany", "de"],
  ["法国", "france", "fr"],
  ["荷兰", "netherlands", "holland", "nl"],
  ["西班牙", "spain", "es"],
  ["意大利", "italy", "it"],
  ["波兰", "poland", "pl"],
  ["瑞典", "sweden", "se"],
  ["挪威", "norway", "no"],
  ["芬兰", "finland", "fi"],
  ["丹麦", "denmark", "dk"],
  ["瑞士", "switzerland", "ch"],
  ["奥地利", "austria", "at"],
  ["捷克", "czech", "czechia", "cz"],
  ["乌克兰", "ukraine", "ua"],
  ["罗马尼亚", "romania", "ro"],
  ["俄罗斯", "russia", "ru"],
  ["美国", "usa", "america", "united states", "us"],
  ["加拿大", "canada", "ca"],
  ["墨西哥", "mexico", "mx"],
  ["巴西", "brazil", "br"],
  ["阿根廷", "argentina", "ar"],
  ["澳大利亚", "australia", "au"],
  ["新西兰", "new zealand", "nz"],
  ["南非", "south africa", "za"],
]

/**
 * 洲/大区 → 国家码：搜「欧洲」时，**没写分组**但机器在德/荷/英/法的也要中。
 * 只列这台主题认识的国家（地球那张 `COUNTRY_LL` 加上常见的那几个）；不认识的国家
 * 就只剩它自己的码可搜 —— 这里不硬猜。
 * 美西/美东那种一国之内的分区**不进这张表**：它们只按字面（分组名）匹配，
 * 不然搜「美西」会把全美国的机器都算进来。
 */
const AREA_CODES: Record<string, string[]> = {
  欧洲: ["de", "nl", "gb", "fr", "es", "it", "pl", "se", "no", "fi", "dk", "ch", "at", "cz", "ie", "ua", "ro", "ru"],
  亚洲: ["jp", "hk", "tw", "sg", "kr", "cn", "my", "th", "vn", "ph", "id", "in", "ae", "il"],
  中东: ["ae", "il", "tr"],
  北美: ["us", "ca", "mx"],
  南美: ["br", "ar"],
  大洋洲: ["au", "nz"],
  非洲: ["za"],
}

/** 族里所有**带空格**的词（`west us` / `hong kong` / `north america`…）——拆词时要护着它们。 */
const PHRASE_WORDS = new Set(WORD_FAMILIES.flat().filter((word) => word.includes(" ")))

/** 一个词落在哪一族里（不在任何族里就是空数组）。族里的词都是小写。 */
function familyWordsOf(word: string): string[] {
  const w = word.toLowerCase()
  for (const family of WORD_FAMILIES) if (family.includes(w)) return family
  return []
}

/**
 * 城市：把地球那张 `CITY_HINTS` 的正则**整串锚定**后再拿来试关键词。
 * 不锚定会出事：东京那条是 `/…|东京|東京/i`，于是访客打整串名称「东京一号」时它也算命中，
 * 就把整个东京的机器都当成同义词捞出来了（单测逮到过这条）。锚定后只有「正好是一个城市名」
 * 的词才会扩散 —— 中文名 / 英文名 / 三字码都算（东京 / Tokyo / TYO）。
 */
const CITY_EXACT = CITY_HINTS.map((hint) => ({ re: new RegExp(`^(?:${hint.match.source})$`, "i"), name: hint.name }))

/**
 * 每个城市的**中文写法**（东京/東京、圣何塞、法兰克福/法蘭克福…）：从地球那张表的正则里
 * 直接抠出汉字段，不另抄一份 —— 表里加城市，搜索这边自动跟上。
 *
 * 有了它，站长用英文给机器起名（`JP-TYO-01`）时访客打「东」「东京」也搜得到；反过来，
 * 名字/分组里本来就有中文的那几台照旧（那是子串匹配的事）。抠汉字段而不是手抄，是因为
 * 这类「两处数据要一致」的地方最容易悄悄跑偏（表里改了中文名，搜索那边忘了跟）。
 */
const CITY_CJK = (() => {
  const map = new Map<string, string[]>()
  for (const hint of CITY_HINTS) {
    const cjk = hint.match.source.match(/[\u4e00-\u9fff]+/g)
    if (!cjk) continue
    map.set(hint.name, [...new Set([...(map.get(hint.name) ?? []), ...cjk])])
  }
  return map
})()

/** 这个国家码落在哪些洲里（洲名连同英文写法一起摊进可搜文本：搜「北美」「north america」都该中）。 */
function areasOf(code: string): string[] {
  const c = code.toLowerCase()
  const out: string[] = []
  for (const [area, codes] of Object.entries(AREA_CODES)) {
    if (codes.includes(c)) out.push(...familyWordsOf(area))
  }
  return out
}

/** 拆关键词：全角/不换行空格先换成半角，再按空白拆，去掉空片段、统一小写。 */
export function searchTerms(query: string): string[] {
  const whole = query.replace(/[\u3000\u00a0]/g, " ").trim().toLowerCase()
  // 整串本身就是一个带空格的族词（`west us` / `hong kong` / `north america`）时**别拆**：
  // 拆成两个词就再也拼不回那个短语了（`west us` 拆开只剩两个谁也不认的词）。
  if (PHRASE_WORDS.has(whole)) return [whole]
  return whole.split(/\s+/).filter(Boolean)
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
    // 这个码所在那一族的全部词：中文名 + 英文名 + 码 —— 于是「日本」「japan」「jp」都搜得到它。
    ...familyWordsOf(code),
    // 这个码落在哪些洲里（含英文写法）：搜「欧洲」「north america」也要中，哪怕站长没写分组。
    ...areasOf(code),
    // 这个城市的中文写法（东京/東京、圣何塞…）：站长用英文给机器起名时，访客打「东」也要中。
    ...(region?.city ? CITY_CJK.get(region.city) ?? [] : []),
    // 城市只认得出英文名（CITY_HINTS 的第三项）——中文城市名本来就在名称/分组里，上面已经收了。
    region?.label ?? "",
    region?.city ?? "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
}

/** 一段文本里有没有这个词：短码按词边界（`de` 不许命中 `debian`），其余按子串。 */
function matchesWord(text: string, word: string): boolean {
  if (word.length <= 3 && /^[a-z0-9]+$/.test(word)) return new RegExp(`\\b${word}\\b`).test(text)
  return text.includes(word)
}

/**
 * 一个关键词对应的一组匹配器：**原样**那一枚排在最前（访客打的词永远按子串匹配，
 * 于是 `deb` 照样命中 `Debian`），后面是展开出来的同族词、洲内国家码与城市名（按上面那条规则）。
 * 这一组之间是「或」的关系，词与词之间是「且」。
 */
function matchersFor(term: string): ((text: string) => boolean)[] {
  const t = term.toLowerCase()
  const out: ((text: string) => boolean)[] = [(text) => text.includes(t)]
  const extra = new Set<string>()
  // ① 同族词（国家 / 洲 / 大区）
  for (const word of familyWordsOf(t)) extra.add(word)
  // ② 洲名 → 国家码
  for (const [area, codes] of Object.entries(AREA_CODES)) {
    if (familyWordsOf(area).includes(t)) for (const code of codes) extra.add(code)
  }
  // ③ 城市：直接问地球那张表（中文 / 英文 / 三字码都认，如 东京 / Tokyo / TYO）
  for (const city of CITY_EXACT) if (city.re.test(t)) extra.add(city.name.toLowerCase())
  extra.delete(t)
  for (const word of extra) out.push((text) => matchesWord(text, word))
  return out
}

/** 按关键词收窄一组节点。空词＝没在搜（原样返回，连数组都不必重建）。 */
export function searchNodes(nodes: Node[], query: string): SearchResult {
  const terms = searchTerms(query)
  if (terms.length === 0) {
    return { shown: nodes, query, terms, active: false, hit: nodes.length, total: nodes.length }
  }
  const matchers = terms.map(matchersFor)
  const shown = nodes.filter((node) => {
    const text = searchText(node)
    // 词之间「且」：每个词那一组里命中一枚就算这个词过了。
    return matchers.every((group) => group.some((match) => match(text)))
  })
  return { shown, query, terms, active: true, hit: shown.length, total: nodes.length }
}

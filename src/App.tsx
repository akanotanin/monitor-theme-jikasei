import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Globe as GlobeIcon, Moon, Sun, Wrench } from "lucide-react"

import { CardStyleMenu } from "@/components/CardStyleMenu"
import { NodeCard } from "@/components/NodeCard"
import { CompactList } from "@/components/CompactList"
import { Globe } from "@/components/Globe"
import { SearchBox, SearchRow } from "@/components/SearchBox"
import { SummaryCards } from "@/components/Summary"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { api, groupView, useNodes } from "@/lib/api"
import { regionView } from "@/lib/globe"
import { hasDetailRemarks } from "@/lib/notes"
import { searchNodes } from "@/lib/search"
import { hasGroupTabs, hasSummary, isBudgetLayout, useCardStyle, useGlobeVisible, useLocalFarm, useThemeConfig } from "@/lib/theme-config"
import { isBeijingNight, resolveDark, type ThemeMode } from "@/lib/site-settings"
import type { RemarkPlacement } from "@/lib/site-settings"
import { FarmIcon } from "@/components/FarmIcon"

type Me = {
  authed: boolean
  github: boolean
  site_name: string
  public_page: boolean
  /** hub 的历史保留天数（1~365，1.3.2 起默认 30）。老 hub 不给：时间范围按 7 天算（@/lib/ranges）。 */
  history_days?: number
}

// The tab title cache key, shared with the inline script in index.html. Kept as the
// theme's own key so two themes on one origin cannot fight over it.
const TITLE_CACHE_KEY = "jikasei:site_name"

// 页脚署名（右下角那行）里指向的源码仓库 —— 与 theme.json 的 `url` 是同一个地址
// （面板卡片上的「源码」也指这里）。两处一起改。
const REPO_URL = "https://github.com/akanotanin/monitor-theme-jikasei"

// Split out because the list page draws no chart: the detail view (with its own
// hand-drawn charts) travels as its own chunk — 17.8 kB raw / 6.9 kB gzipped as
// of 1.26.x (the recharts era's 391 kB is long gone; the split survives because
// visitors who never open a node still shouldn't pay for it). 取它的时机见 App 里的
// warmDetail：列表画完之后空闲时取、指针落到卡片上时立刻取、开页就在详情页时立刻取。
const loadDetail = () => import("@/components/NodeDetail").then((m) => ({ default: m.NodeDetail }))
const NodeDetail = lazy(loadDetail)

/**
 * 详情页的骨架：按详情页真实的那几块摆（标题行 + 规格格 + 备注块 + 页签行 + 四张图），
 * 不是一枚 `h-96`。它露面的场景只有一个 —— 点开时图表 chunk 还没到（见下面 warmDetail），
 * 所以它的高度必须跟加载完的内容一样，否则那一下会「先塌再撑」。
 *
 * 尺寸不另立一套，全跟着详情页自己那几块的类走：`dt` text-xs(16) + `dd` text-sm(20)、
 * 页签 py-1 + text-xs = 24、图块 = 小标题 mb-2 + `h-40`、四张图之间 space-y-5、
 * 规格格那层用同一套 grid 断点。于是手机上（一列六行）与桌面上（三列两行）都自动对上。
 *
 * ★两处「差一块就差 46px」的地方（2026-10-06 修，护栏 verify_detail_preload 一直在红）：
 *   ① **备注块**（22px）—— 真实页里那台机器有备注才占位，所以这里得按 `hasRemarks` 判一次，
 *      不能无条件画（没备注的机器会反过来高出 38px）；
 *   ② **四张图是页签块的兄弟、不是孩子** —— 嵌进去的话，页签与图之间那 16px 变成 8px，
 *      整页少 8px。①+② = 22+16+8 = 46px，正是当年那 46px 的差额。
 */
function DetailSkeleton({ hasRemarks = false }: { hasRemarks?: boolean }) {
  return (
    <div className="detail-skeleton space-y-4" aria-busy="true">
      <div className="flex items-center gap-2">
        <Skeleton className="size-6 shrink-0 rounded-[3px]" />
        <Skeleton className="h-7 w-44" />
      </div>
      <div className="grid gap-x-6 gap-y-3 md:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="min-w-0">
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-5 w-28" />
          </div>
        ))}
      </div>
      {/* 备注那一块：真实页里是 `flex flex-wrap items-center gap-1` 的一行小卡片（整行 22px），
          没写备注时一个像素都不占 —— 所以这里也按同一条件决定画不画（判据见 @/lib/notes）。 */}
      {hasRemarks && (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <Skeleton className="h-[22px] w-24 rounded-full" />
          <Skeleton className="h-[22px] w-16 rounded-full" />
        </div>
      )}
      <div className="space-y-2 border-t pt-4">
        <div className="flex gap-1">
          <Skeleton className="h-6 w-12" />
          <Skeleton className="h-6 w-16" />
        </div>
        <div className="flex gap-1">
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-6 w-16" />
        </div>
      </div>
      {/* 四张资源图：整页详情的默认页签就是它，所以骨架照它的高度来。
          ★它是上面那个页签块的**兄弟**（真实页里也是），别嵌进去。 */}
      <div className="space-y-5">
        {[0, 1, 2, 3].map((i) => (
          <div key={i}>
            <Skeleton className="mb-2 h-4 w-16" />
            <Skeleton className="h-40 w-full" />
          </div>
        ))}
      </div>
    </div>
  )
}

// `/node/{id}` is a real page: it survives a reload, can be linked to, and back
// leaves the detail view rather than the site. The hub serves index.html for any
// unknown path, so no server-side route is required.
//
// ★ 筛选三件套（分组 / 地区 / 搜索词）也在地址栏里（2026-10-12 起）：`/?group=…&region=…&q=…`。
//   刷新、收藏、分享都带着当时的筛选；详情页的地址同样带着它们（外加 `?tab=latency`），
//   于是「后退 / 前进」在列表与详情之间来回时，每一屏连筛选一起复原——URL 是状态的唯一来源，
//   内存只是它的一份镜像。只带**有值**的项：清掉筛选就回到干净的 `/`。
type ListState = { group: string | null; region: string | null; q: string }

/** 从地址栏读筛选三件套（首次加载与 popstate 各读一次）。 */
function readListState(): ListState {
  const p = new URLSearchParams(location.search)
  return { group: p.get("group"), region: p.get("region"), q: p.get("q") ?? "" }
}

/** 列表 / 详情共用的地址串：有值才带；详情页可选再带 `?tab=`。 */
function pageUrl(id: number | null, tab: string | null, s: ListState): string {
  const p = new URLSearchParams()
  if (s.group !== null) p.set("group", s.group)
  if (s.region !== null) p.set("region", s.region)
  if (s.q.trim() !== "") p.set("q", s.q)
  if (id !== null && tab) p.set("tab", tab)
  const qs = p.toString()
  return `${id === null ? "/" : `/node/${id}`}${qs ? `?${qs}` : ""}`
}

function useNodeRoute(onPop: (s: ListState) => void) {
  const read = () => {
    const match = location.pathname.match(/^\/node\/(\d+)/)
    return match ? Number(match[1]) : null
  }
  const [id, setId] = useState(read)
  useEffect(() => {
    const sync = () => {
      setId(read())
      // 后退/前进也把筛选三件套从地址栏恢复：历史里每个条目都记着当时的筛选，落在哪一条就回哪一屏。
      onPop(readListState())
    }
    addEventListener("popstate", sync)
    return () => removeEventListener("popstate", sync)
  }, [onPop])
  return [
    id,
    (next: number | null, url?: string) => {
      history.pushState({}, "", url ?? (next === null ? "/" : `/node/${next}`))
      setId(next)
      scrollTo(0, 0)
    },
  ] as const
}

const DARK_MEDIA = matchMedia("(prefers-color-scheme: dark)")

/**
 * The visitor's own choice, or the system's while there is none. Only the toggle
 * writes the choice down: persisting the system's answer on load would pin it,
 * leaving a visitor who never touched the toggle in whichever mode their system
 * happened to be in that day. The panel at `/admin/` shares this key on one
 * origin, so it has to hold to the same rule -- one app writing on load pins the
 * others.
 *
 * The system's answer is subscribed to rather than copied into state: a flip
 * landing between the first render and the effect that would have attached the
 * listener is otherwise never heard, and the next one is a day away.
 */
function useTheme(siteMode: ThemeMode) {
  // ★ 必须接住异常：浏览器禁用站点数据时，连 `localStorage` 的**读取**都会抛 SecurityError ——
  //   在 `useState` 初始化器里抛 = 首次渲染炸掉、整页空白（hub 1.4.1 release note 点名的那条，
  //   官方两个主题在随附新版里修的就是它）。读不到就当「没存过」，下面照常走站长那一档。
  const [saved, setSaved] = useState(() => {
    try {
      return localStorage.getItem("theme")
    } catch {
      return null
    }
  })
  const system = useSyncExternalStore(
    (notify) => {
      DARK_MEDIA.addEventListener("change", notify)
      return () => DARK_MEDIA.removeEventListener("change", notify)
    },
    () => DARK_MEDIA.matches,
  )
  // siteMode 变档时马上按新档校正一次「夜里没夜里」——不等下一分钟。
  // 写法用「渲染期调节 state」而不是在 effect 里同步 setState（后者要多一轮级联渲染，
  // oxlint 也点名这一条）；模式这一档运行时几乎不变，代价最多是一次立即重放。
  const [night, setNight] = useState(() => isBeijingNight())
  const [nightMode, setNightMode] = useState(siteMode)
  if (nightMode !== siteMode) {
    setNightMode(siteMode)
    setNight(isBeijingNight())
  }
  // 「随北京时间自动」要自己跨过 19:00 / 07:00：每分钟问一次现在几点（几乎不要钱），
  // 到点前后最多差一分钟。别的档不挂这个定时器。
  useEffect(() => {
    if (siteMode !== "auto") return
    const timer = setInterval(() => setNight(isBeijingNight()), 60_000)
    return () => clearInterval(timer)
  }, [siteMode])
  // 站长那一档是**默认**；访客点过那枚图标（localStorage 里有 `theme`）就以他的为准。
  const fromSite = siteMode === "auto" ? night : resolveDark(siteMode, system)
  const dark = saved ? saved === "dark" : fromSite

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
    /**
     * 手机浏览器那一圈（地址栏 / 状态栏）的配色（`theme-color`）跟着**页面实际用的**明暗走。
     *
     * index.html 里那两份是静态值、按**系统**明暗挑的；而本站的「随北京时间自动」在夜里
     * 与系统相反时两边会打架 —— 所以这里先把那两份摘掉，再挂一份没有 media 的。
     * 颜色取 `--background` 的**实际值**（oklch 交给 canvas 读回 sRGB），不手抄 hex，免得跟 token 漂移。
     */
    const head = document.head
    for (const old of head.querySelectorAll('meta[name="theme-color"]')) old.remove()
    const meta = document.createElement("meta")
    meta.name = "theme-color"
    let color = dark ? "#0d0c0a" : "#fafafa"
    const probe = document.createElement("canvas")
    probe.width = probe.height = 1
    const ctx = probe.getContext("2d")
    if (ctx) {
      // 先铺兜底色：老浏览器不认 oklch 时这次赋值会被忽略，留下的就是它。
      ctx.fillStyle = color
      ctx.fillStyle = getComputedStyle(document.body).backgroundColor
      ctx.fillRect(0, 0, 1, 1)
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
      color = `rgb(${r}, ${g}, ${b})`
    }
    meta.content = color
    head.append(meta)
  }, [dark])

  return [
    dark,
    () => {
      const next = dark ? "light" : "dark"
      // 点成与站长那一档一致时**删掉记录**（= 重新跟着站长走，与 useGlobeVisible 同一套口径）。
      const record = (next === "dark") === fromSite ? null : next
      try {
        if (record === null) localStorage.removeItem("theme")
        else localStorage.setItem("theme", record)
      } catch {
        // 存储被禁用（隐私模式）：这次会话照样切，只是记不住。
      }
      setSaved(record)
    },
  ] as const
}

export default function App() {
  const config = useThemeConfig()
  // 明暗：站长那一档（`themeMode`）当默认，访客点过顶栏那枚图标就以他的为准。
  const [dark, toggleTheme] = useTheme(config.themeMode)
  // 顶栏那枚入口图标（1.25.0 起没有设置项）：挂载即探一次本站约定的 `/chicken/`，
  // 装了那座小鸡农场才出现、没装不占位（判据是内容而不是状态码，见 useLocalFarm）。
  const farmUrl = useLocalFarm()
  const [me, setMe] = useState<Me | null>(null)
  const [meError, setMeError] = useState("")
  const { nodes, error, closed } = useNodes()
  // 筛选三件套（分组 / 地区 / 搜索词）：**初始值从地址栏读**（刷新、收藏、别人分享的链接
  // 都因此带着筛选进来），之后变化再写回去（见下面的 replaceState 那段）。
  const [group, setGroup] = useState<string | null>(() => readListState().group)
  // 地球侧栏里选中的地区：同理留在这儿，进详情页再回来不丢。
  const [region, setRegion] = useState<string | null>(() => readListState().region)
  // 顶栏那个搜索框：词与「窄屏那一行展开了没」都留在这儿 —— 进详情页再回来，搜到的那几台还在。
  const [query, setQuery] = useState(() => readListState().q)
  const [searchOpen, setSearchOpen] = useState(false)
  // 搜索键盘导航：↑↓ 在**命中列表**里移动的那一格（下标，null = 没选）。词一变就清零
  // （命中的那批换了，之前选到「第几台」已经没有意义）；显示时再按当前命中数夹一次。
  const [cursor, setCursor] = useState<number | null>(null)
  // popstate（后退/前进）时把筛选三件套从地址栏恢复 —— 与详情 id 同一趟同步。
  const onPop = useCallback((s: ListState) => {
    setGroup(s.group)
    setRegion(s.region)
    setQuery(s.q)
    setCursor(null)
  }, [])
  const [open, go] = useNodeRoute(onPop)
  // 访客自己的两个偏好（都只存在他自己浏览器里，见 @/lib/theme-config）：
  // 地球看不看，以及列表用哪种卡片形态 —— 后者没选过时跟着站长的设置走。
  // ★ 站长那档是「节点地球」的**闸门**：他关掉时 `globeOn` 一律是 false，顶栏那枚开关也一起
  //   不挂（见下面那段渲染条件）——关掉的整块不该在页面上留一枚点了没落点的按钮。
  const [globeOn, toggleGlobe] = useGlobeVisible(config.globeOn)
  const [cardStyle, chooseStyle] = useCardStyle(config.cardStyle)
  // 收起搜索（Esc 在空框上按的那一下）。**不清词**：收起是「让出顶栏那点宽度」，不是「别筛了」
  // —— 词留着，点开一台机器看清了再回来，那几台还在（收起态会看不见词，所以那枚放大镜会提色、
  // 悬停说明里带上词与命中数，见 SearchBox）。
  const collapseSearch = () => setSearchOpen(false)
  // 窄屏那枚方形图标＝顶栏下面那一行的开关；桌面什么都不用做（CSS 的 :focus-within 自己长开）。
  // 用 matchMedia 而不是把它存成 state：这里只在事件里问一次，没必要为它挂一条媒体查询订阅。
  const onSearchActivate = () => {
    const narrow = typeof matchMedia === "function" && matchMedia("(max-width: 639px)").matches
    setSearchOpen((was) => (narrow ? !was : false))
  }
  // 窄屏那一行收起：连词一起清掉 —— 那一行是「临时张开的一块地方」，收起后顶栏上看不见它，
  // 留着词就成了看不见的筛选。（桌面那套不一样：收起态本来就是那枚图标，词留着有据可依。）
  // 清词的同时把键盘光标也归零（见上面的 cursor）。
  const closeSearchRow = () => {
    setSearchOpen(false)
    setQuery("")
    setCursor(null)
  }
  // 搜索词的唯一入口：词一变就把键盘光标归零（↑↓ 选的「第几台」属于上一批命中，
  // 命中集合换了就不该悄悄指向另一台机器）。SearchBox / SearchRow 两处都走它。
  const changeQuery = (next: string) => {
    setQuery(next)
    setCursor(null)
  }

  const loadMe = useCallback(() => {
    // `|| "..."` because an empty message reads as no error: api() falls back to
    // res.statusText, which HTTP/2 and HTTP/3 removed, so a bodiless 502 from a
    // proxy arrives as "". The check below would then take the loading branch and
    // the retry button would never render.
    return api<Me>("/me")
      .then((next) => { setMe(next); setMeError("") })
      .catch((e: Error) => setMeError(e.message || "网络错误"))
  }, [])

  useEffect(() => {
    loadMe()
  }, [loadMe])

  /**
   * 详情页那块 chunk（自绘图表，17.8KB / gzip 6.9KB——recharts 那 391KB 已换掉，
   * 见上面 loadDetail）什么时候取：三条路，谁先到听谁的。
   *
   *   ① 开页就在详情页（书签、刷新、别人分享的链接）：立刻取 —— 它就是要画的那一块。
   *   ② 列表画出来之后：交给浏览器挑空闲时机取。放在这里而不是挂载时取，是不和首屏的
   *      入口包与第一批数据抢同一条链路；列表已经在眼前了，它才没有别的事可挤。
   *   ③ 指针或键盘落到某张卡片上（悬停、聚焦、触摸）：立刻取。真要打开一台机器的人，
   *      鼠标按下去之前通常已经摸过那张卡片了，所以点开时它多半已经在本地。
   *
   * 代价写在明面上：列表出来不到一秒就点开的那一下，看到的会是骨架屏而不是空白 ——
   * 换来的是**每个访客（包括从不点开任何一台机器的人）不再为一块用不上的代码付首屏带宽**。
   */
  const warmed = useRef(false)
  const warmDetail = useCallback(() => {
    warmed.current = true
    void loadDetail()
  }, [])
  const listReady = nodes !== null
  useEffect(() => {
    if (warmed.current) return
    if (open !== null) { warmDetail(); return }
    if (!listReady) return
    // 列表那一帧真的画出去之后才轮到这块 chunk：先连等两帧（第一帧的 rAF 回调还跑在
    // 「列表即将上屏」之前，第二帧才是它已经在屏幕上了），再交给浏览器的空闲回调。
    // 标签页不在前台时 rAF 会停住，切回来才补上——那时也正没人在点开任何一台机器。
    let idle = 0
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        // Safari 到 18 才补上 requestIdleCallback：没有它就直接取，效果一样。
        if (typeof requestIdleCallback === "function") idle = requestIdleCallback(warmDetail, { timeout: 2000 })
        else warmDetail()
      })
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
      if (idle) cancelIdleCallback(idle)
    }
  }, [open, listReady, warmDetail])

  // The status page was closed while this tab was open. `me` holds whatever it
  // reported at load, so it is re-queried; the effect below then directs an
  // anonymous visitor to the panel rather than leaving them on a list that
  // stopped updating with only a red line to explain it.
  useEffect(() => {
    if (closed) void loadMe()
  }, [closed, loadMe])

  useEffect(() => {
    if (me && !me.public_page && !me.authed) location.href = "/admin/"
  }, [me])

  // 在线优先：**离线的机器一律沉到列表最末尾**（站长 2026-10-14 的口径「离线服务器的卡片排到
  // 所有卡片的最末尾」）。组内仍按站长排序（`sort`，并列再按 `id`），所以这只是在排序键前面
  // 加了一层「在线 0 / 离线 1」——同一台机器在两次帧之间的位置是确定的，不会自己抖动。
  // 「离线」= hub 的 `online` 为假，包含「曾接入但掉线」与「从未接入」两种；它们在这里不再
  // 占在线机器前面的位置。分组/地区/搜索那几层筛选都从这份排好序的列表上切，所以每个页签里
  // 离线也都是垫底的。
  const sorted = [...(nodes ?? [])].sort(
    (a, b) => (a.online === b.online ? 0 : a.online ? -1 : 1) || a.sort - b.sort || a.id - b.id,
  )
  const selected = sorted.find((n) => n.id === open)
  // 分组筛选只求值一次（@/lib/api 的 groupView）：概览卡片与下面的列表吃的是同一份
  // 「该显示哪几台」，切分组时两边一起变——参考站的内置 default 主题就是这个口径。
  const view = groupView(sorted, group, hasGroupTabs(config.listTop))
  // 地区筛选叠在分组之上，两层是同一套「该显示哪几台」的延续：
  //   · 地球与右侧那列地区吃的是**当前分组**（`view.shown`）—— 与概览卡片同一口径，
  //     切分组时地球上的针与地区台数一起变；
  //   · 下面的列表再按地区收窄一层（`listView`）。
  // 这样「上头写着 JP 4 台、下面只剩 2 张卡片」不会出现：地球是分组的地图，不是列表的地图。
  const regions = regionView(view.shown, region)
  // 再叠一层搜索（口径见 @/lib/search）：这一层与地区筛选同一套——**下面那张列表与上面
  // 那行概览卡片一起收窄**，地球仍然是「分组的地图」（它画的是分组里有哪些地方，
  // 不是搜索结果热力图；地区列表点一行照样能把列表收窄到那个地区）。
  const found = searchNodes(regions.shown, query)
  const listView = { ...view, shown: found.shown }
  // 归一化后的当前筛选（地址栏更新与进详情都读它）。提成局部值再用：effect 的依赖数组里
  // 直接写 `view.current` 会踩 exhaustive-deps（规则只认对象，而对象每渲染都是新的）。
  const groupNow = view.current
  const regionNow = regions.current

  /**
   * 筛选变了就把地址栏跟手更新（`replaceState`）。
   *
   * 为什么是 replace 而不是 push：筛选的每一次调整（点分组、点地区、敲一个字）不该往历史里
   * 塞一整条条目 —— 否则「后退」得按十几下才退出这一页。replace 让历史里始终只留
   * 「列表（当时筛选）→ 详情」这种有意义的两跳，后退一步就是干净的回退。
   * 详情页时不写：那时的路径是 `/node/{id}`，筛选要留在它自己的查询串里（见 openNode）。
   * 值取**归一化后**的 `groupNow / regionNow` —— 悬空的选择（分组解散、地区没了）
   * 已经被回落成「全部」，地址栏里就不该还留着那个死值。
   */
  useEffect(() => {
    if (open !== null) return
    history.replaceState({}, "", pageUrl(null, null, { group: groupNow, region: regionNow, q: query }))
  }, [open, groupNow, regionNow, query])

  /**
   * 进详情 / 回列表都走这里，把**当前筛选**一并写进地址（刷新或分享详情链接时，列表那一屏
   * 也能原样复原）。延迟行那一下多带一个 `?tab=latency`（见 NodeCard 的 onOpenLatency）。
   */
  const openNode = (id: number, tab: "latency" | null = null) => {
    go(id, pageUrl(id, tab, { group: groupNow, region: regionNow, q: query }))
  }
  const openList = () => {
    go(null, pageUrl(null, null, { group: groupNow, region: regionNow, q: query }))
  }

  // 搜索键盘导航（↑↓ 选、Enter 开）：下标是「命中列表里的第几台」，不变式与清零时机见 cursor 的声明处。
  const moveCursor = (delta: 1 | -1) => {
    const count = found.shown.length
    if (count === 0) return
    setCursor((c) => (c === null ? (delta === 1 ? 0 : count - 1) : (c + delta + count) % count))
  }
  const enterCursor = () => {
    const node = cursor !== null ? found.shown[cursor] : undefined
    if (node) openNode(node.id)
  }
  // 显示时的当前选中：下标越界（命中数刚变过）就当作没选 —— 读的时候再夹一次，写的时候不用追。
  const cursorId = cursor !== null && cursor < found.shown.length ? found.shown[cursor].id : null

  // `/node/{id}` is a page people bookmark and share, so the tab needs the node's
  // name. The site name rather than a fixed string, since the hub lets an operator
  // rename the site.
  //
  // Nothing is written until `me` is in: while it is missing the only value we could
  // write is the placeholder, and that shows up as the tab flipping through one more
  // title on every load. One write, the right one — and it is remembered so that the
  // next reload starts on the real name instead of the placeholder (index.html).
  useEffect(() => {
    if (!me) return
    const siteName = me.site_name || "Monitor"
    // Claim the tab: index.html's inline script fetches /api/me on a cold visit and may
    // answer seconds later. Once this runs, that response must not overwrite the title —
    // on `/node/{id}` it would drop the node name.
    ;(window as unknown as { __titleOwned?: boolean }).__titleOwned = true
    document.title = [selected?.name, siteName].filter(Boolean).join(" · ")
    try {
      localStorage.setItem(TITLE_CACHE_KEY, siteName)
    } catch {
      // Private mode / storage disabled: the tab still gets its title, reloads just
      // fall back to the placeholder.
    }
  }, [selected?.name, me])

  // Only while there is nothing else to show. Once `me` has loaded, a later
  // failure belongs beside the page rather than over it.
  if (!me) return (
    <div className="grid min-h-svh place-items-center p-6 text-sm text-muted-foreground">
      {meError ? <div className="space-y-3 text-center"><p role="alert">加载失败：{meError}</p><Button onClick={loadMe}>重试</Button></div> : "加载中…"}
    </div>
  )

  // The status page is closed and nobody is signed in: redirect to the panel.
  if (!me.public_page && !me.authed) return null

  return (
    // 纵向排下来、页脚吊在最后（main 吃满剩余高度）：机器少、内容比一屏短时，
    // 署名也落在屏幕的右下角，而不是紧贴在列表底下浮在半空中。
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        {/* ★ 窄屏的横向余量很紧（390 宽上这一行原本要 407px，整页因此能横向拖动）。现在按
            「**站名优先展开、图标自己滑**」分：站名那格 max-w-[55%]（正常名字完整显示，
            只有长到离谱才轮到 truncate），搜索钉在它右边，剩下几枚图标装进一条能横向滑动的
            条带里 —— 与下面那行分组标签同一套做法：装不下就滑，不裁字、也不把整页撑宽。 */}
        <div className="mx-auto flex max-w-[1280px] items-center gap-2 px-4 py-3 sm:gap-3 sm:px-6">
          {/* The site name is the way back to the list, so a node page needs
              no back button of its own. A 32px disc of the site's icon leads
              it — `/favicon.svg` is the one address that answers with the
              panel's site icon (or the theme's own when none is set). */}
          <button className="tap tap-8 flex max-w-[55%] shrink-0 items-center gap-2.5 font-semibold transition-opacity hover:opacity-70" onClick={openList}>
            <SiteIcon />
            <span className="truncate">{me.site_name || "Monitor"}</span>
          </button>
          <div className="flex-1" />
          {/* 搜索（名称 / 地区 / 系统）：只长在列表页 —— 它收窄的就是下面那张列表，
              站在某台机器的详情页里按它没有落点。收起时是一枚方形图标，点开就地长成输入框
              （窄屏是顶栏下面多一行，见 SearchRow）。 */}
          {open === null && (
            <SearchBox
              value={query}
              onChange={changeQuery}
              onActivate={onSearchActivate}
              onClose={collapseSearch}
              hits={found.hit}
              onMove={moveCursor}
              onEnter={enterCursor}
            />
          )}
          {/* ★ 图标条带：装不下就**横向滑动**（与下面那行分组标签同一套做法）。
              py/px 是给 .tap 那圈 ±6px 的命中区留地方 —— 被 overflow 裁掉的话命中区只剩 36
              （护栏会当场报出来）；横向**不加**负 margin：那会让条带的盒子压到搜索那一格上，
              把搜索的命中区吃掉一半（实测 44 → 33）。条带里的间距固定 12px（与桌面同）：两枚
              图标的命中区各向外 6px，正好在缝里相接，不多不少（8px 会重叠、护栏也会报）。
              滑动条藏起来（见 index.css 的 .header-tools）：它长在 sticky 顶栏里，露出来
              就是一条横杠；「还能滑」的提示由露一半的那枚图标给，与分组标签行一致。 */}
          <div className="header-tools -my-1.5 flex min-w-0 items-center gap-3 overflow-x-auto px-1.5 py-1.5">
          {/* The panel is a separate app built into the hub, not part of this
              theme, so this is a navigation rather than a route. Icon only, with
              the wording in the tooltip: this row is a strip of icons, and a
              label here would push the site name aside on a phone. */}
          <Button variant="ghost" size="icon" asChild>
            <a
              href="/admin/"
              title={me.authed ? "进入后台" : "登录"}
              aria-label={me.authed ? "进入后台" : "登录"}
            >
              <Wrench />
            </a>
          </Button>
          {/* 卡片形态：访客自己挑列表用哪种排法（只长在列表页 —— 它就只影响那一页）。 */}
          {open === null && (
            <CardStyleMenu value={cardStyle} siteDefault={config.cardStyle} onPick={chooseStyle} />
          )}
          {/* 地球开关：只长在列表页 —— 地球就在那一页的顶上，站在某台机器页里按它没有落点。
              ★ 站长在「主题设置 → 节点地球」里关掉时**整枚按钮都不挂**（不是藏起来／不是禁用）：
              那一块功能是关着的，留着按钮就成了一件点了什么也不开的摆设（访客会以为「点不动」）。
              与农场入口、主题开关同规格（图标 + 悬停提示，不带文字，与顶栏其他图标一致）。 */}
          {open === null && config.globeOn && (
            <Button
              variant="ghost"
              size="icon"
              className="globe-toggle"
              aria-pressed={globeOn}
              onClick={() => {
                // ★关掉地球时**顺手把地区筛选清掉**：地区那列长在地球里，地球一藏，
                // 「怎么取消」就没地方点了（列表会一直只剩那个地区的机器，看着像站点坏了）。
                // 反过来说，地区筛选本来就属于那张地图，地图收起来它就该跟着走。
                if (globeOn) setRegion(null)
                toggleGlobe()
              }}
              title={globeOn ? "隐藏节点地球" : "显示节点地球"}
              aria-label={globeOn ? "隐藏节点地球" : "显示节点地球"}
            >
              <GlobeIcon />
            </Button>
          )}
          {/* 入口图标：本站 `/chicken/` 上真装了那座小鸡农场才出现（自动探测，见 useLocalFarm）；
              同域，就在当前标签页里打开。 */}
          {farmUrl && (
            <Button variant="ghost" size="icon" asChild>
              <a href={farmUrl} title="农场入口" aria-label="农场入口">
                <FarmIcon />
              </a>
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={toggleTheme} title="切换主题" aria-label="切换主题">
            {dark ? <Sun /> : <Moon />}
          </Button>
          </div>
        </div>
        {/* 窄屏点开搜索后在顶栏下面多出来的那一行：摆成 header 的直接子节点，
            于是它跟着这个 sticky 块一起吸顶（滚动时不会留在列表里被滚走）。 */}
        {open === null && searchOpen && (
          <SearchRow value={query} onChange={changeQuery} onClose={closeSearchRow} onMove={moveCursor} onEnter={enterCursor} />
        )}
      </header>

      <main className="mx-auto w-full max-w-[1280px] flex-1 space-y-5 px-4 py-4 sm:px-6">
        {error && <p className="text-sm text-destructive">{error}</p>}

        {open !== null ? (
          !nodes ? (
            <DetailSkeleton />
          ) : selected ? (
            <Suspense fallback={<DetailSkeleton hasRemarks={hasDetailRemarks(selected, config.remarkPlacement)} />}>
              {/* 整页详情与紧凑展开里是同一个组件：保留天数也要一起给它，
                  否则「展开里有 30 天、点进去只有 7 天」会显得不一致。 */}
              <NodeDetail node={selected} historyDays={me.history_days} remarkPlacement={config.remarkPlacement} />
            </Suspense>
          ) : (
            <p className="py-16 text-center text-sm text-muted-foreground">
              节点不存在或未公开。<button className="underline" onClick={openList}>返回列表</button>
            </p>
          )
        ) : !nodes ? (
          // 还在等节点列表：骨架按当前形态画。紧凑形态是一行一台，用几根细条比三张大卡片更像它。
          cardStyle === "compact" ? (
            <div className="space-y-2">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-9" />
              ))}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-72" />
              ))}
            </div>
          )
        ) : (
          <>
            {/* 概览卡片行：设置里没选它时整个不挂载（不是藏起来），首屏与没有这个功能时一致。
                「月度预算剩余价值版」只是同一行换一副面孔，组件另收一个 finance 开关。 */}
            {hasSummary(config.listTop) && <SummaryCards nodes={found.shown} group={view.current} finance={isBudgetLayout(config.listTop)} searching={found.active} />}
            {/* 节点地球：概览卡片之下、列表之上（上游就是这个次序）。 */}
            {globeOn && (
              <Globe nodes={view.shown} dark={dark} region={regions.current} onRegion={setRegion} onOpen={openNode} onWarm={warmDetail} />
            )}
            {/* 一台都剩不下时说清楚是谁把它筛没的，并指回去哪儿取消 —— 否则访客只看到
                一大片空白，会以为站点坏了。搜索那一层排在前面：它是最后叠上去、也是访客
                刚刚动手的那一层（文案写「当前筛选下」，地区那层也在时同样成立）。 */}
            {found.active && found.shown.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                当前筛选下没有匹配「{found.query.trim()}」的节点 —— 名称、地区、系统三处都能搜
                （多个词用空格隔开，要同时命中）；点搜索框里那枚 × 清掉。
              </p>
            ) : globeOn && regions.shown.length === 0 && view.shown.length > 0 ? (
              <p className="text-sm text-muted-foreground">
                这个地区里当前没有节点 —— 点上面那一列的「全部」取消筛选。
              </p>
            ) : null}
            <NodeList view={listView} group={group} onGroup={setGroup} onOpen={openNode} onWarm={warmDetail}
              latencyLines={config.pingLines}
              cardStyle={cardStyle}
              historyDays={me.history_days}
              remarkPlacement={config.remarkPlacement}
              terms={found.terms}
              cursorId={cursorId} />
          </>
        )}
      </main>

      {/* 页脚署名：一行浅色小字。桌面在右下角（右对齐、比内容右沿往左收 12px）；手机上**收进一个
          带上分割线的页脚带**里居中 —— 2026-10-07 站长两轮反馈：先嫌「右下角一行孤零零的灰字
          像水印」（改居中），再说「还是得改个位置、要和谐美观不突兀」。根因是它**没有结构**：
          一行灰字悬在卡片下面，既不像页脚、也不像卡片的一部分。加一条 1px 上分割线（与顶栏的
          border-b 呼应，页面上下就都框住了），留白按「卡→线 24px、线→字 16px、字→底 20px」
          拉开，它才读成一个明确的页脚区。分割线只出现在窄屏（<640px，与署名居中的断点同一档）
          —— 为手机改的东西不落到电脑端，桌面维持原样。
          （2026-10-12：站上短暂加过一枚「更新于 N 秒前」的数据年龄行，当天按站长要求撤掉 ——
           页脚回到这一行署名的最简形态。）
          「Jikasei」那截点开去本主题的源码仓库 —— 新标签页打开，别把访客从状态页带走
          （链接地址与 theme.json 的 url 是同一个，见上面的 REPO_URL）。样式见 index.css 的 .theme-credit。 */}
      <footer className="mx-auto mt-2 w-full max-w-[1280px] border-t px-4 pb-5 pt-4 sm:mt-0 sm:border-t-0 sm:px-6 sm:pb-5 sm:pt-1">
        <p className="theme-credit text-center sm:pr-3 sm:text-right">
          Theme:{" "}
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            Jikasei
          </a>
        </p>
      </footer>
    </div>
  )
}

/**
 * 顶栏的圆形站标：**就是站点图标本身**，而且用的是**标签页那条 `<link rel="icon">` 的地址**。
 *
 * hub 1.4.0 起这条路径由面板「设置 → 站点图标」管（没设时回落到主题自带的同名文件），
 * 而且 hub 送 index.html 时会把它改写成 `?v=<内容摘要>` —— 所以「取哪张图」这件事在静态
 * HTML 里就定下来了，主题只要沿用同一条地址即可：
 *
 *   · 页头与标签页是**同一个 URL** → 浏览器只取一次、缓存共用一份（弱链路上尤其重要，
 *     以前两处各取一次会把页头那张挤掉）；
 *   · 站长换了图，hub 给的版本号就变了，浏览器自己会重新取，不需要任何早跑脚本。
 *
 * 取不到就不占位：不留一枚破图。
 */
function SiteIcon() {
  const [href] = useState(() => document.querySelector('link[rel~="icon"]')?.getAttribute("href") || "/favicon.svg")
  const [broken, setBroken] = useState(false)
  if (broken) return null
  return (
    <span className="size-8 shrink-0 overflow-hidden rounded-full bg-muted ring-1 ring-border/60">
      <img src={href} alt="" className="size-full object-cover" onError={() => setBroken(true)} />
    </span>
  )
}

// Group tabs appear only once the operator has grouped something, so a hub
// without groups keeps the page it always had. The operator can also keep the
// row off outright (theme setting `listTop`), which leaves the page as one
// flat list.
//
// 「该显示哪几台」与标签行的内容都在 App 里算好（`view`，见 @/lib/api 的 groupView）：
// 概览卡片吃的是同一份，切分组时上面那行与下面这批卡片一起变。
/**
 * 列表**分批挂载**：先画一屏的量，剩下的分帧补上。
 *
 * 为什么不虚拟滚动：拿 100 台的夹具量过 —— 静置时每 5 秒一次的重渲染长任务是 **0**（卡片不多时
 * 重渲染本来就是免费的），DOM 11457 也撑得住；**唯一**真花钱的是首屏那一次 **255ms** 的长任务
 * （100 张卡片一次性挂上去）。虚拟滚动要处理变高卡片 + 响应式列数，改动大、风险高，却只为解决
 * 一个不存在的稳态开销。把首屏那次摊成十几小块，效果一样、代价小得多。
 *
 * 每块 12 张（约 30ms，短于 50ms 的长任务线），块与块之间用 `setTimeout(0)` 让浏览器先画一帧。
 * 少于一块的量（≤24 台）完全不改变行为 —— 护栏用的都是小夹具，不受影响。
 */
function useProgressive(total: number, first = 24, step = 12): number {
  const [limit, setLimit] = useState(() => Math.min(total, first))
  // 换了筛选/搜索（total 变了），列表换了，重新从第一批开始 —— 渲染期直接比，不放进 effect
  // （effect 里同步 setState 会白白多跑一轮渲染）。
  const [seenTotal, setSeenTotal] = useState(total)
  if (seenTotal !== total) {
    setSeenTotal(total)
    setLimit(Math.min(total, first))
  }
  useEffect(() => {
    if (limit >= total) return
    const timer = setTimeout(() => setLimit((n) => Math.min(total, n + step)), 0)
    return () => clearTimeout(timer)
  }, [limit, total, step])
  return limit
}

function NodeList({ view, group, onGroup, onOpen, onWarm, latencyLines, cardStyle, historyDays, remarkPlacement, terms, cursorId }: {
  /** 分组求值的结果：groups / current / shown / tabs / total（App 与概览卡片共用一份）。 */
  view: ReturnType<typeof groupView>
  /** 原始选中值（null = 全部，"" = 未分组）：只在归一化后回写时用，见下面的 effect。 */
  group: string | null
  onGroup: (group: string | null) => void
  /** 进详情。第二个参数给 "latency" 时，详情页落在「网络延迟」页签（卡面延迟行那一下）。 */
  onOpen: (id: number, tab?: "latency") => void
  /** 指针/键盘刚落到某一张卡片上：把详情那块 chunk 先取回来（见 App 的 warmDetail）。 */
  onWarm: () => void
  /** 卡片延迟块要显示哪几条线路（ping 任务名，换行分隔）；空串 = 自动。 */
  latencyLines: string
  /** 卡片形态：compact = 一行一台的表格；detailed = 在延迟形态上再加在线时长与元信息；latency 网络单行 + 延迟；classic 网络两行、无延迟；plain 与 classic 版式相同、只换一套视觉处理。 */
  cardStyle: "classic" | "latency" | "detailed" | "plain" | "compact"
  /** hub 的历史保留天数：透给「紧凑」形态展开行里那块详情图（时间范围那排按钮按它生成）。 */
  historyDays?: number
  /** 主题设置里的「备注显示位置」：卡片那一侧要不要摊备注（见 @/lib/site-settings）。 */
  remarkPlacement: RemarkPlacement
  /** 搜索命中词：卡片名字里描色（见 Highlight）。没在搜时是空数组 —— 一切照旧。 */
  terms: string[]
  /** 键盘选中的那台（↑↓ 选中的下标换算来的 id）：加一圈描边、并随光标滚进视野。 */
  cursorId: number | null
}) {
  const { groups, current, shown, tabs, total, showTabs } = view
  // 首屏先画一屏的量，剩下的分帧补上（见 useProgressive）。
  const list = shown.slice(0, useProgressive(shown.length))
  // 键盘选中（↑↓）的那台滚进视野：block: nearest —— 够不着才拉，不打断访客自己滚到的地方。
  // 分批挂载还没轮到它时（选择挂在第 25 台开外）查询落空，等下一批挂上来光标再动自然会被看见。
  useEffect(() => {
    if (cursorId === null) return
    document.querySelector(`[data-node-card="${cursorId}"]`)?.scrollIntoView({ block: "nearest" })
  }, [cursorId])
  // 归一化后的值回写给 App（悬空的选中态被回落时纠正一次，见 groupView 的注释）。
  useEffect(() => {
    if (current !== group) onGroup(current)
  }, [current, group, onGroup])
  return (
    <>
      {/* ★ 分组标签行的上下间距收紧（2026-10-07 站长说这一行夹在面板与卡片之间显得空）：
          主容器是 space-y-5（20px），一行 36px 高的细条被它夹着就像浮着。下面那行用
          -mt-2（上 20→12）+ mb-3（下 12）—— 它是**下面那张列表的筛选条**，贴着卡片更顺。
          Tailwind 的 space-y 用的是 :where()（零特异性），所以这里随手覆盖得动。 */}
      {showTabs && groups.length > 0 && (
        <div role="group" aria-label="分组" className="-mx-1 -mt-2 mb-3 flex gap-1 overflow-x-auto px-1 pb-1">
          {tabs.map(([value, label, count]) => (
            <Button
              // Group names are free text, so they carry a prefix no key of
              // the 全部 tab can share.
              key={value === null ? "*" : `=${value}`}
              aria-pressed={current === value}
              size="sm"
              variant={current === value ? "secondary" : "ghost"}
              className="shrink-0"
              onClick={() => onGroup(value)}
            >
              {label}
              <span className="tnum text-muted-foreground">{count}</span>
            </Button>
          ))}
        </div>
      )}
      {total === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">还没有节点</p>
      ) : cardStyle === "compact" ? (
        <CompactList nodes={list} onOpen={onOpen} onWarm={onWarm} historyDays={historyDays} remarkPlacement={remarkPlacement} terms={terms} cursorId={cursorId} />
      ) : (
        <div data-card-style={cardStyle} className={`grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-3 ${cardStyle === "detailed" ? "" : "xl:grid-cols-4"}`}>
          {list.map((n) => (
            <NodeCard key={n.id} node={n} onOpen={() => onOpen(n.id)} onOpenLatency={() => onOpen(n.id, "latency")} onWarm={onWarm} latencyLines={latencyLines} cardStyle={cardStyle} remarkPlacement={remarkPlacement} terms={terms} selected={n.id === cursorId} />
          ))}
        </div>
      )}
    </>
  )
}

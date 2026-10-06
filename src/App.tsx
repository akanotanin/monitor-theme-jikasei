import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Globe as GlobeIcon, Moon, Sun, Wrench } from "lucide-react"

import { CardStyleMenu } from "@/components/CardStyleMenu"
import { NodeCard } from "@/components/NodeCard"
import { CompactList } from "@/components/CompactList"
import { Globe } from "@/components/Globe"
import { SummaryCards } from "@/components/Summary"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { api, groupView, useNodes } from "@/lib/api"
import { regionView } from "@/lib/globe"
import { hasDetailRemarks } from "@/lib/notes"
import { DEFAULTS, FARM_OFF, hasGroupTabs, hasSummary, isBudgetLayout, useCardStyle, useGlobeVisible, useLocalFarm, useSiteFavicon, useThemeConfig } from "@/lib/theme-config"
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

// Split out because recharts is most of this bundle and the list page draws no
// chart. The landing page is 242 kB rather than 629 kB (77 kB gzipped against
// 188 kB). 取它的时机见 App 里的 warmDetail：列表画完之后空闲时取、指针落到卡片上时立刻取、
// 开页就在详情页时立刻取 —— 不再和首屏的入口包与第一批数据抢带宽。
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
function useNodeRoute() {
  const read = () => {
    const match = location.pathname.match(/^\/node\/(\d+)/)
    return match ? Number(match[1]) : null
  }
  const [id, setId] = useState(read)
  useEffect(() => {
    const sync = () => setId(read())
    addEventListener("popstate", sync)
    return () => removeEventListener("popstate", sync)
  }, [])
  return [
    id,
    (next: number | null) => {
      history.pushState({}, "", next === null ? "/" : `/node/${next}`)
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
function useTheme() {
  const [saved, setSaved] = useState(() => localStorage.getItem("theme"))
  const system = useSyncExternalStore(
    (notify) => {
      DARK_MEDIA.addEventListener("change", notify)
      return () => DARK_MEDIA.removeEventListener("change", notify)
    },
    () => DARK_MEDIA.matches,
  )
  const dark = saved ? saved === "dark" : system

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
  }, [dark])

  return [
    dark,
    () => {
      const next = dark ? "light" : "dark"
      localStorage.setItem("theme", next)
      setSaved(next)
    },
  ] as const
}

/**
 * 站内那套养鸡场（同域）用当前标签页打开就好，它属于本站导航；指向别的站时才开新标签页——
 * 默认值就是那样的一座公开养鸡场，不该把访客从状态页带走。
 */
function farmLinkProps(url: string) {
  try {
    if (new URL(url, location.href).origin === location.origin) return {}
  } catch {
    // 地址本身不合法就按外链处理：让它自己在新标签页里报错，别把本站带跑。
  }
  return { target: "_blank", rel: "noreferrer" }
}

export default function App() {
  const [dark, toggleTheme] = useTheme()
  const { config, loaded } = useThemeConfig()
  // 站长没填地址时，自动认本站约定的那个位置（`/chicken/`）有没有养鸡场；
  // 填了就以他填的为准，填 `off` 则一律不显示。**等设置到了再探**（loaded）——不然
  // 「关掉入口」「填了自己地址」的站都会白探一次，那两次探测还会让护栏分不清「该探没探」。
  const farmAuto = config.farmUrl === ""
  const detectedFarm = useLocalFarm(loaded && farmAuto)
  const farmUrl = farmAuto ? detectedFarm : config.farmUrl === FARM_OFF ? "" : config.farmUrl
  // 顶栏那张站标最终用的是哪个地址（加载成功才知道），标签页图标跟着它走。
  const [settledIcon, setSettledIcon] = useState<string | null>(null)
  useSiteFavicon(settledIcon)
  const [me, setMe] = useState<Me | null>(null)
  const [meError, setMeError] = useState("")
  const { nodes, error, closed } = useNodes()
  const [open, go] = useNodeRoute()
  // The list's group tab, held here so it survives a visit to a node's page.
  const [group, setGroup] = useState<string | null>(null)
  // 地球侧栏里选中的地区：同理留在这儿，进详情页再回来不丢。
  const [region, setRegion] = useState<string | null>(null)
  // 访客自己的两个偏好（都只存在他自己浏览器里，见 @/lib/theme-config）：
  // 地球看不看，以及列表用哪种卡片形态 —— 后者没选过时跟着站长的设置走。
  const [globeOn, toggleGlobe] = useGlobeVisible()
  const [cardStyle, chooseStyle] = useCardStyle(config.cardStyle)

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
   * 图表 chunk（recharts 那 391KB，见上面 loadDetail）什么时候取：三条路，谁先到听谁的。
   *
   *   ① 开页就在详情页（书签、刷新、别人分享的链接）：立刻取 —— 它就是要画的那一块。
   *   ② 列表画出来之后：交给浏览器挑空闲时机取。放在这里而不是挂载时取，是因为挂载那一刻
   *      入口包、样式、`/api/me`、`/api/nodes` 都还在路上（实测 391KB 的图表 chunk 在
   *      157ms 就起跑，和它们抢同一条链路）；列表已经在眼前了，它才没有别的事可挤。
   *   ③ 指针或键盘落到某张卡片上（悬停、聚焦、触摸）：立刻取。真要打开一台机器的人，
   *      鼠标按下去之前通常已经摸过那张卡片了，所以点开时它多半已经在本地。
   *
   * 代价写在明面上：列表出来不到一秒就点开的那一下，看到的会是骨架屏而不是空白 ——
   * 换来的是**每个访客（包括从不点开任何一台机器的人）不再为一块用不上的图表代码付首屏带宽**。
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

  const sorted = [...(nodes ?? [])].sort((a, b) => a.sort - b.sort || a.id - b.id)
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
  const listView = { ...view, shown: regions.shown }

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
        <div className="mx-auto flex max-w-[1280px] items-center gap-3 px-4 py-3 sm:px-6">
          {/* The site name is the way back to the list, so a node page needs
              no back button of its own. A 32px disc of the site's own icon leads
              it; the address is a theme setting, the built-in one is the
              fallback. */}
          <button className="flex items-center gap-2.5 font-semibold transition-opacity hover:opacity-70" onClick={() => go(null)}>
            <SiteIcon key={config.siteIcon} src={config.siteIcon} onSettle={setSettledIcon} />
            {me.site_name || "Monitor"}
          </button>
          <div className="flex-1" />
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
              与养鸡场入口、主题开关同规格（图标 + 悬停提示，不带文字，见 memory 里的顶栏惯例）。 */}
          {open === null && (
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
          {/* 养鸡场入口：站长填了地址就指向那里；留空则本站 `/chicken/` 上真装了养鸡场
              才出现（自动探测，见 useLocalFarm）；填 `off` 则一律不出现。 */}
          {farmUrl && (
            <Button variant="ghost" size="icon" asChild>
              <a href={farmUrl} title="养鸡场" aria-label="养鸡场" {...farmLinkProps(farmUrl)}>
                <FarmIcon />
              </a>
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={toggleTheme} title="切换主题">
            {dark ? <Sun /> : <Moon />}
          </Button>
        </div>
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
              节点不存在或未公开。<button className="underline" onClick={() => go(null)}>返回列表</button>
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
            {hasSummary(config.listTop) && <SummaryCards nodes={regions.shown} group={view.current} finance={isBudgetLayout(config.listTop)} />}
            {/* 节点地球：概览卡片之下、列表之上（上游就是这个次序）。 */}
            {globeOn && (
              <Globe nodes={view.shown} dark={dark} region={regions.current} onRegion={setRegion} onOpen={go} onWarm={warmDetail} />
            )}
            {/* 按地区筛完一台都不剩：说清楚是筛选造成的，并指回去哪儿取消 ——
                否则访客只看到一大片空白，会以为站点坏了。 */}
            {globeOn && regions.shown.length === 0 && view.shown.length > 0 && (
              <p className="text-sm text-muted-foreground">
                这个地区里当前没有节点 —— 点上面那一列的「全部」取消筛选。
              </p>
            )}
            <NodeList view={listView} group={group} onGroup={setGroup} onOpen={go} onWarm={warmDetail}
              latencyLines={config.pingLines}
              cardStyle={cardStyle}
              historyDays={me.history_days}
              remarkPlacement={config.remarkPlacement} />
          </>
        )}
      </main>

      {/* 页脚署名：右下角一行浅色小字（样式见 index.css 的 .theme-credit），
          「jikasei」那截点开去本主题的源码仓库 —— 新标签页打开，别把访客从状态页带走
          （链接地址与 theme.json 的 url 是同一个，见上面的 REPO_URL）。 */}
      <footer className="mx-auto w-full max-w-[1280px] px-4 pb-5 pt-1 sm:px-6">
        <p className="theme-credit text-right">
          Theme by{" "}
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            jikasei
          </a>
        </p>
      </footer>
    </div>
  )
}

/**
 * 顶栏的圆形站标。默认用主题自带的 `/site-icon.png`，站长可以在后台换成任意地址；
 * 换的那个取不到就退回自带这张，两张都取不到就不占位——不留一枚破图。
 */
function SiteIcon({ src, onSettle }: { src: string; onSettle: (icon: string | null) => void }) {
  // 去重：站长填回默认地址时只有一个候选，出错就没有下一个。
  const candidates = [...new Set([src, DEFAULTS.siteIcon].filter(Boolean))]
  const [step, setStep] = useState(0)
  // 站长那一项到得比首帧晚：调用处用 key={src} 让它重挂，候选与步骤都从头来，
  // 不用在 effect 里回头改状态（那会多一轮渲染）。
  const current = candidates[step]
  // 候选全试完还把 onSettle 留在 null —— 标签页图标就维持静态值，不留破图。
  useEffect(() => { if (!current) onSettle(null) }, [current, onSettle])
  if (!current) return null
  return (
    <span className="size-8 shrink-0 overflow-hidden rounded-full bg-muted ring-1 ring-border/60">
      <img
        src={current}
        alt=""
        className="size-full object-cover"
        onLoad={() => onSettle(current)}
        onError={() => setStep((n) => n + 1)}
      />
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
function NodeList({ view, group, onGroup, onOpen, onWarm, latencyLines, cardStyle, historyDays, remarkPlacement }: {
  /** 分组求值的结果：groups / current / shown / tabs / total（App 与概览卡片共用一份）。 */
  view: ReturnType<typeof groupView>
  /** 原始选中值（null = 全部，"" = 未分组）：只在归一化后回写时用，见下面的 effect。 */
  group: string | null
  onGroup: (group: string | null) => void
  onOpen: (id: number) => void
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
}) {
  const { groups, current, shown, tabs, total, showTabs } = view
  // 归一化后的值回写给 App（悬空的选中态被回落时纠正一次，见 groupView 的注释）。
  useEffect(() => {
    if (current !== group) onGroup(current)
  }, [current, group, onGroup])
  return (
    <>
      {showTabs && groups.length > 0 && (
        <div role="group" aria-label="分组" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
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
        <CompactList nodes={shown} onOpen={onOpen} onWarm={onWarm} historyDays={historyDays} remarkPlacement={remarkPlacement} />
      ) : (
        <div data-card-style={cardStyle} className={`grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-3 ${cardStyle === "detailed" ? "" : "xl:grid-cols-4"}`}>
          {shown.map((n) => (
            <NodeCard key={n.id} node={n} onOpen={() => onOpen(n.id)} onWarm={onWarm} latencyLines={latencyLines} cardStyle={cardStyle} remarkPlacement={remarkPlacement} />
          ))}
        </div>
      )}
    </>
  )
}

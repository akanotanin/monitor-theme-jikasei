import { lazy, Suspense, useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { Moon, Sun, Wrench } from "lucide-react"

import { NodeCard } from "@/components/NodeCard"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { api, groupsOf, useNodes, type Node } from "@/lib/api"
import { DEFAULTS, useLocalFarm, useSiteFavicon, useThemeConfig } from "@/lib/theme-config"
import { FarmIcon } from "@/components/FarmIcon"

type Me = { authed: boolean; github: boolean; site_name: string; public_page: boolean }

// The tab title cache key, shared with the inline script in index.html. Kept as the
// theme's own key so two themes on one origin cannot fight over it.
const TITLE_CACHE_KEY = "jikasei:site_name"

// Split out because recharts is most of this bundle and the list page draws no
// chart. The landing page is 242 kB rather than 629 kB (77 kB gzipped against
// 188 kB), with the rest fetched immediately after it paints.
const loadDetail = () => import("@/components/NodeDetail").then((m) => ({ default: m.NodeDetail }))
const NodeDetail = lazy(loadDetail)

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
  // 填了就以他填的为准。**等设置到了再探**（loaded）——不然「关掉入口」「填了自己地址」
  // 的站都会白探一次，那两次探测还会让护栏分不清「该探没探」。
  const detectedFarm = useLocalFarm(loaded && config.showFarmEntry && !config.farmUrl)
  const farmUrl = config.showFarmEntry ? config.farmUrl || detectedFarm : ""
  // 顶栏那张站标最终用的是哪个地址（加载成功才知道），标签页图标跟着它走。
  const [settledIcon, setSettledIcon] = useState<string | null>(null)
  useSiteFavicon(settledIcon)
  const [me, setMe] = useState<Me | null>(null)
  const [meError, setMeError] = useState("")
  const { nodes, error, closed } = useNodes()
  const [open, go] = useNodeRoute()
  // The list's group tab, held here so it survives a visit to a node's page.
  const [group, setGroup] = useState<string | null>(null)

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
    // Warmed here rather than left to Suspense, which requests the chunk only
    // once a render reaches the detail view, itself waiting on /me. Without this
    // the split trades its first paint for a full-page skeleton over the first
    // node opened: 2.6s click-to-chart on 4G against 1.4s unsplit, 1.7s warm.
    void loadDetail()
  }, [loadMe])

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
    <div className="min-h-svh">
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
          {/* 养鸡场入口：站长填了地址就指向那里；留空则本站 `/chicken/` 上真装了养鸡场
              才出现（自动探测，见 useLocalFarm），开关关掉则一律不出现。 */}
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

      <main className="mx-auto max-w-[1280px] space-y-5 px-4 py-4 sm:px-6">
        {error && <p className="text-sm text-destructive">{error}</p>}

        {open !== null ? (
          !nodes ? (
            <Skeleton className="h-96" />
          ) : selected ? (
            <Suspense fallback={<Skeleton className="h-96" />}>
              <NodeDetail node={selected} />
            </Suspense>
          ) : (
            <p className="py-16 text-center text-sm text-muted-foreground">
              节点不存在或未公开。<button className="underline" onClick={() => go(null)}>返回列表</button>
            </p>
          )
        ) : !nodes ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-72" />
            ))}
          </div>
        ) : (
          <NodeList nodes={sorted} group={group} onGroup={setGroup} onOpen={go} showTabs={config.showGroupTabs}
            latencyLines={config.pingLines}
            cardStyle={config.cardStyle} />
        )}
      </main>
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
// without groups keeps the page it always had. The operator can also switch the
// row off outright (theme setting `showGroupTabs`), which leaves the page as one
// flat list.
function NodeList({ nodes, group, onGroup, onOpen, showTabs, latencyLines, cardStyle }: {
  nodes: Node[]
  /** null is every node, "" the ungrouped. */
  group: string | null
  onGroup: (group: string | null) => void
  onOpen: (id: number) => void
  showTabs: boolean
  /** 卡片延迟块要显示哪几条线路（ping 任务名，换行分隔）；空串 = 自动。 */
  latencyLines: string
  /** 卡片形态：detail 网络单行 + 延迟；classic 网络两行、无延迟。 */
  cardStyle: "detail" | "classic"
}) {
  const groups = groupsOf(nodes)
  const ungrouped = nodes.filter((n) => !n.group).length
  // A tab that has since emptied or been renamed -- 未分组 included -- falls back
  // to every node rather than to an empty page, and is forgotten, so a later
  // group of the same name does not take the page over.
  //
  // 关掉标签行时同样回到全部：站长在后台一关，访客手里的分组选中态就作废。
  const current = !showTabs ? null : group === null || (group === "" ? ungrouped > 0 : groups.includes(group)) ? group : null
  useEffect(() => {
    if (current !== group) onGroup(current)
  }, [current, group, onGroup])
  const shown = current === null ? nodes : nodes.filter((n) => (n.group ?? "") === current)
  const tabs = [
    [null, "全部", nodes.length] as const,
    ...groups.map((g) => [g, g, nodes.filter((n) => n.group === g).length] as const),
    ...(ungrouped ? [["", "未分组", ungrouped] as const] : []),
  ]
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
      {nodes.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">还没有节点</p>
      ) : (
        <div className="grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {shown.map((n) => (
            <NodeCard key={n.id} node={n} onOpen={() => onOpen(n.id)} latencyLines={latencyLines} cardStyle={cardStyle} />
          ))}
        </div>
      )}
    </>
  )
}

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

import {
  camera, clampLat, globeCaption, globeNodes, globeProfile, graticule, inkWidthWith, landPaths, layoutLabels,
  links, prepareRings, regionRows, sweepLonAt, sweepOpacity, VIEW, wrapLon, type Placed, type Quality,
} from "@/lib/globe"
import { COARSE_WORLD_OUTLINES, WORLD_OUTLINES } from "@/lib/world"
import type { Node } from "@/lib/api"

/**
 * 列表页顶部的「节点地球」：正射投影的一颗地球，每台机器一枚针、一条引线连到左右两摞
 * 标签上，旁边一条一条列着地区。整套是从上游复刻过来的，几何与排布在 `@/lib/globe` 里（那里的注释写了逐点比对的办法）。
 *
 * 这一层只管四件事：**什么时候重画**、**指针怎么转它**、**点哪里开哪台机器**、
 * **地区侧栏怎么筛**。数据（节点 → 针的落点）只在节点列表变了时算一次。
 *
 * 重画的节奏（这是它能不能在手机上呆着的关键，别随手改成每帧）：
 *   · 空闲时按档位的 `idleMs` 重画（medium 64ms ≈ 15fps，low 90ms ≈ 11fps），
 *     每帧只把经纬度往前推一点点，看起来是匀速自转，实际画的是 11~15 张/秒；
 *   · 拖拽时跟着指针事件走（指针多快就多快，一次事件一张）；
 *   · 钉住某个地区（点过侧栏）就**不再自转**，也不再重画 —— 扫掠经线随之停住，
 *     与上游一致（上游钉住后连空闲定时器都不重画）。
 *   · 滚出视口、标签页在后台、系统开了「减弱动态效果」，都停。
 *
 * 拖动只接管**横向**（`touch-action: pan-y`）：竖着划是滚页面。上游把整个地球的
 * 触摸手势全部吃掉（`touch-action: none`），在手机上等于在一块 280px 高的区域里
 * 划不动页面 —— 地球是拿来看的，不值得挡住滚动。
 */
/**
 * 标签的真实字宽（用户单位）：`canvas.measureText` 按 `.globe-label` 那一套字体量一次。
 *
 * 为什么要真量：上游那套「半角 5.05 / 全角 8.6」的估法**偏小一成**，而判「这行字放不放得下」
 * 是拿它算的 —— 估小了就把长名字留在原地，溢出的半句话被 SVG 的视口**直接裁掉**，
 * 页面上什么都不报（见 references/svg-globe-port.md 第 2 条）。真量之后：
 * 放得下的不再截、放不下的截到真放得下，两侧都不再有「半个字」。
 *
 * 字体串与 index.css 的 `.globe-label` 必须一致（字号也在这里，改一处要改两处）。
 * 量不出来（老浏览器 / 没有 canvas）返回 null，调用方退回估法。
 */
const LABEL_FONT = '9.35px ui-monospace, SFMono-Regular, "IBM Plex Mono", monospace'
let labelCtx: CanvasRenderingContext2D | null | undefined
function measureLabel(text: string): number | null {
  if (labelCtx === undefined) {
    try {
      labelCtx = document.createElement("canvas").getContext("2d")
      if (labelCtx) labelCtx.font = LABEL_FONT
    } catch {
      labelCtx = null
    }
  }
  if (!labelCtx) return null
  return labelCtx.measureText(text).width
}

export function Globe({ nodes, dark, region, onRegion, onOpen, onWarm }: {
  /** 当前分组里的节点（与概览卡片、下面的列表同一批）。 */
  nodes: Node[]
  /** 深色模式：只影响扫掠经线的透明度。 */
  dark: boolean
  /** 选中的地区键（null = 全部）。 */
  region: string | null
  onRegion: (key: string | null) => void
  onOpen: (id: number) => void
  /** 指针已经落到某台机器上：提前把详情那块 chunk 取回来（见 App 的 warmDetail）。 */
  onWarm: () => void
}) {
  const narrow = useNarrow()
  /**
   * ★ 窄屏（≤720px）**不再降档**。2026-10-07 站长看过手机上的 low 档之后说「地球太简陋了」——
   * 那一档只有 104 个点的粗岸线（一格 60° 的网、不画扫掠、不画引线），确实就是一张草图。
   * 现在跟桌面同档：detailed 岸线（79 环 / 1483 点，但每帧只投影**正面那一半**，约 500 点）、
   * 30° 经纬网、1 条扫掠、引线。代价是手机上每帧多做约 4 倍的点与路径字符串 ——
   * **真机若发烫或掉帧，回退就是下面那个开关改回 `true`（一行）**，别犹豫。
   */
  const NARROW_LOW_TIER = false
  const quality: Quality = narrow && NARROW_LOW_TIER ? "low" : "medium"
  const profile = useMemo(() => globeProfile(quality), [quality])
  const prep = useMemo(
    () => prepareRings(profile.land === "coarse" ? COARSE_WORLD_OUTLINES : WORLD_OUTLINES),
    [profile],
  )
  const points = useMemo(() => globeNodes(nodes), [nodes])
  const rows = useMemo(() => regionRows(nodes), [nodes])
  // 「全部」那一行的悬停说明：合计里有多少台认不出国家（不上地球与地区列表）——
  // 「全部 N」与地区分项合计对不上这件事，就在那里有一句明面上的说法。
  const unplaced = nodes.length - rows.reduce((sum, row) => sum + row.count, 0)

  // 初始视角与上游一致：东经 80°、北纬 30°（亚洲那一面，机器最密的地方）。
  const [view, setView] = useState({ lon: 80, lat: 30 })
  // 点过侧栏的地区就钉住：不再自转（否则刚飞过去又转走了）。
  const [pinned, setPinned] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [inView, setInView] = useState(true)
  // 画布的实际像素尺寸：只用来算"两摞标签各自的文字还有多少余量"（见 viewBox 那段）。
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  const reduced = useReducedMotion()
  // 标签左右侧的记忆：跨帧保留，圆心附近 ±18 的机器才不会左右闪。布局函数就地写它。
  const sides = useRef(new Map<string, "L" | "R">())
  const host = useRef<HTMLDivElement>(null)
  const drag = useRef<{
    id: number; x: number; y: number; lon: number; lat: number; moved: boolean
    /** pointerdown 那一刻压在谁身上（见 endDrag 的注释：click 的 target 不能再信）。 */
    pressed: number | null
  } | null>(null)

  useEffect(() => {
    const el = host.current
    if (!el || typeof ResizeObserver !== "function") return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setBox({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 滚出视口就别再转了：列表很长时它一直在屏幕外空转，白烧 CPU。
  useEffect(() => {
    const el = host.current
    if (!el || typeof IntersectionObserver !== "function") return
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { rootMargin: "120px" })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const spinning = inView && !dragging && !pinned && !reduced

  useEffect(() => {
    if (!spinning) return
    let raf = 0
    let last = 0
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      // 按档位的节奏重画，不是每帧：地球一转就要把整块岸线重算一遍。
      if (last && now - last < profile.idleMs) return
      // 后台标签页回来时 now-last 会很大：掐在 1 秒，免得地球"跳"过去一大截
      // （上游同此，1 秒 ≈ 7.5°）。
      const dt = last ? Math.min(1000, now - last) : profile.idleMs
      last = now
      setView((v) => ({ ...v, lon: wrapLon(v.lon + dt * 0.0075) }))
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [spinning, profile.idleMs])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button) return
    // ★ 命中要在这里认下来，不能等 click：下面 `setPointerCapture` 之后，浏览器把 click 的
    // target 改写成"抓着指针的那个元素"（也就是这个容器），于是 `closest('[data-node]')`
    // 永远返回空 —— 点针开机器会静默失效（实测过一次，页面什么都不报）。
    const pressed = (e.target as Element).closest?.("[data-node]")
    drag.current = {
      id: e.pointerId, x: e.clientX, y: e.clientY, lon: view.lon, lat: view.lat, moved: false,
      pressed: pressed ? Number(pressed.getAttribute("data-node")) : null,
    }
    setDragging(true)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // 指针已经没了（触屏上很常见）：照常走后面的 move/up，不影响拖拽。
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    // 3px 以内不算拖：手指点一下总要抖一两个像素，当成拖就成了"点不动"。
    if (!d.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
    d.moved = true
    e.preventDefault()
    // 系数与上游同（0.48 度/像素横向、0.36 纵向）；纬度夹在 ±78。
    setView({ lon: wrapLon(d.lon - dx * 0.48), lat: clampLat(d.lat + dy * 0.36) })
  }

  /**
   * 收尾。`open` 为假是手势被浏览器接管（手机上竖着划滚页面走的是 pointercancel）——
   * 那一下绝不能当成"点了这台机器"。
   */
  const endDrag = (e: React.PointerEvent<HTMLDivElement>, open: boolean) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    // 没拖（3px 以内）且按在一枚针上：这才是"点开那台机器"。
    if (open && !d.moved && d.pressed !== null) {
      onWarm()
      onOpen(d.pressed)
    }
    drag.current = null
    setDragging(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // 同上：没抓着就没什么可放的。
    }
  }

  const pick = (key: string | null, aim?: [number, number]) => {
    // 再点一次同一个地区、或点「全部」= 取消筛选并放它继续自转（上游同此）。
    if (!key || key === region) {
      onRegion(null)
      setPinned(false)
      return
    }
    onRegion(key)
    if (aim) {
      setView({ lon: wrapLon(aim[0]), lat: clampLat(aim[1]) })
      setPinned(true)
    }
  }

  /**
   * 画布留白。★ 这不是装饰，是**防裁**：
   *
   * SVG 根元素的视口就是它的裁切框，`preserveAspectRatio="xMidYMid meet"` 只在
   * **容器比画布宽**（桌面那种 830px 宽的格子）时才会在两侧留下空白 —— 那时标签可以
   * 溢到 viewBox 外面去，上游正是靠这块空白吸收长名字的。窄屏（手机上 390 宽、画布
   * 460）是"按宽度贴合"的，两侧一个像素的空白都没有，于是比 126 个用户单位还长的名字
   * 会被直接裁掉 —— 屏幕上只看到半句话，页面什么都不会报。
   *
   * 所以这里量出容器实际比例、算出每侧还剩多少余量，不够就把 viewBox 往两边撑开
   * （最多各 140，再长宁可小一点也不能裁）。宽屏上算出来是负的 → 撑开 0，与上游逐像素相同。
   */
  // 真量函数：一次量不出来（老浏览器）就整个退回估法，别每帧都试。
  const measured = useMemo(() => {
    const probe = measureLabel("W")
    return probe === null ? undefined : (text: string) => measureLabel(text) as number
  }, [])
  const canvas = useMemo(() => {
    const plain = { pad: 0, room: Number.POSITIVE_INFINITY, viewBox: `0 0 ${VIEW.w} ${VIEW.h}` }
    if (!box || !points.length) return plain
    const ink = Math.max(0, ...points.map((p) => Math.max(
      inkWidthWith(measured, `${p.name} · ${p.code}`),
      inkWidthWith(measured, `${p.code} · ${p.name}`),
    )))
    const scale = Math.min(box.w / VIEW.w, box.h / VIEW.h)
    // 一侧还剩多少余量（用户单位）：宽屏是"容器比画布宽"留下的空白，窄屏约等于 0。
    const room = (box.w / scale - VIEW.w) / 2
    // 撑开最多 36：再长宁可截字（见 labelMax），也不能让地球被挤小一圈 ——
    // 460 的画布撑到 532 已经让圆盘小 13%，再多就不是"复刻"那个地球了。
    // （123 = 两摞标签各自距画布边缘的距离，与 globe.ts 的 stack 同一组数。）
    const pad = Math.max(0, Math.min(36, ink + 6 - (123 + room)))
    return {
      pad,
      room,
      viewBox: pad ? `${-pad.toFixed(1)} 0 ${(VIEW.w + pad * 2).toFixed(1)} ${VIEW.h}` : `0 0 ${VIEW.w} ${VIEW.h}`,
    }
  }, [box, points, measured])
  /**
   * 两摞标签各自距画布边缘 123（见 globe.ts 的 stack），这一行长最多能有多宽 ——
   * ★ 是 `max(room, pad)`，**不是** `room + pad`（这里踩过一次，`clipped` 那条护栏当时
   * 因为正则写错静默失效，一直没报）：
   *
   *   · 容器比画布**高**（桌面）：缩放由高度定死，撑开 viewBox 只改坐标框、不改缩放，
   *     但两侧的余量会**正好少掉 pad** —— 撑开的 pad 是从余量里拿的，两者相加等于
   *     把同一段空白算两遍。可用的就是 `123 + room`。
   *   · 容器比画布**宽**（手机按宽度贴合）：`room = 0`，撑开的 pad 让整个画布（含标签）
   *     等比缩小，标签反而多出 pad 的余量 —— 可用的是 `123 + pad`。
   *
   * 取 max 两种情况都对；再用 -6 留一点墨迹余量（描边是 3，见 inkWidthWith）。
   */
  const labelMax = 123 + Math.max(canvas.room, canvas.pad) - 6

  // ★ 每一帧在这里算一遍：岸线（几百个点）、经纬网、标签堆叠、连线。
  // 这些函数都是纯的（标签左右侧的记忆那个 Map 由调用方持有），没有副作用。
  const cam = camera(view.lon, view.lat)
  const land = landPaths(cam, prep)
  const wires = graticule(cam, profile, profile.sweepCount ? sweepLonAt(Date.now()) : null)
  // ★ 这里读 ref 是有意的，也是这套排布必须的：那两个字是**跨帧记忆**——
  // 圆心附近 ±18 的机器（正在转到中缝上的那几台）如果每帧重新判左右，标签会在两摞之间
  // 来回跳。读它是幂等的：同一帧算多少次结果都一样，只是把"上一帧选的那一侧"记下来。
  // eslint-disable-next-line react/refs -- 跨帧记忆，见上
  const placed = layoutLabels(cam, points, sides.current, labelMax, VIEW.cx, measured)
  const arcs = links(placed, profile.linkMode)
  const aim = pinned && region ? rows.find((row) => row.region.key === region)?.aim : undefined
  const marker = aim ? cam.at(aim[0], aim[1]) : null

  return (
    <section className="globe-panel" aria-label="节点地球">
      <div
        ref={host}
        className="globe-atlas"
        data-drag={dragging ? "true" : "false"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endDrag(e, true)}
        onPointerCancel={(e) => endDrag(e, false)}
      >
        {/* 地球是下面那张列表的另一种画法，不是唯一的入口：对读屏隐藏，免得 26 枚针
            变成 26 个无名可点项。地区侧栏那几个是真按钮，留着。 */}
        <svg viewBox={canvas.viewBox} preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
          <defs>
            {/* 圆盘里那层明暗：中心几乎透明、边上压到 `--globe-rim`（上游同一套停点）。 */}
            <radialGradient id="globe-shade" cx="38%" cy="36%" r="68%">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.06" />
              <stop offset="70%" stopColor="currentColor" stopOpacity="0" />
              <stop offset="100%" stopColor="var(--globe-rim)" stopOpacity="1" />
            </radialGradient>
          </defs>
          <circle className="globe-ocean" cx={VIEW.cx} cy={VIEW.cy} r={VIEW.r} />
          <circle className="globe-disk" cx={VIEW.cx} cy={VIEW.cy} r={VIEW.r} fill="url(#globe-shade)" />
          {land.fill && <path className="globe-land" d={land.fill} />}
          {land.stroke && <path className="globe-coast" d={land.stroke} />}
          {wires.map((wire, i) => (
            <path
              key={i}
              className={wire.sweep >= 0 ? "globe-sweep" : "globe-wire"}
              d={wire.d}
              strokeWidth={wire.width}
              style={wire.sweep >= 0 ? { strokeOpacity: sweepOpacity(dark, wire.sweep) } : undefined}
            />
          ))}
          <line className="globe-base" x1={110} y1={VIEW.cy + VIEW.r + 16} x2={350} y2={VIEW.cy + VIEW.r + 16} />
          {arcs.map((arc, i) => (
            <path key={i} className="globe-link" d={arc.d} />
          ))}
          {placed.map((p) => (
            <Pin key={p.key} p={p} />
          ))}
          {marker && (
            <g className="globe-selected">
              <circle className="globe-selected-ring" cx={marker.x} cy={marker.y} r={7} />
              <circle className="globe-selected-core" cx={marker.x} cy={marker.y} r={2.4} />
            </g>
          )}
          <text className="globe-caption" x={VIEW.cx} y={VIEW.cy + VIEW.r + 28} textAnchor="middle">
            {globeCaption(view.lon, view.lat, profile.key)}
          </text>
        </svg>
      </div>

      <aside className="globe-side">
        <div className="globe-side-title">
          地区{pinned && region ? " · 已定位" : ""}
        </div>
        <button
          type="button"
          className="globe-reg globe-reg-all"
          aria-pressed={!region}
          onClick={() => pick(null)}
          title={unplaced > 0 ? `共 ${nodes.length} 台，其中 ${unplaced} 台认不出国家（不上地球与地区列表）` : `共 ${nodes.length} 台`}
        >
          <span>全部</span>
          <b>{nodes.length}</b>
        </button>
        <div className="globe-rows">
          {rows.map((row) => (
            <button
              key={row.region.key}
              type="button"
              className="globe-reg"
              aria-pressed={region === row.region.key}
              onClick={() => pick(row.region.key, row.aim)}
              title={row.offline > 0 ? `${row.count} 台 · ${row.offline} 台离线` : undefined}
            >
              <span>
                <RegionFlag code={row.region.code} />
                {row.region.label}
              </span>
              <b>
                {row.count}
                {row.offline > 0 && <i className="globe-reg-dot" aria-hidden="true" />}
              </b>
            </button>
          ))}
        </div>
      </aside>
    </section>
  )
}

/**
 * 一枚针：引线 + 空心圆 + 标签，外加一枚透明的命中圆（半径 9，比 2.1 的针大多了，
 * 手指点得中）。标签的文字外侧对齐（左侧那一摞往左收 3px，右侧往右推 3px），
 * 所以它永远不会压到引线。
 *
 * 大机群时被行数上限省掉的行（见 globe.ts 的 MAX_LABEL_ROWS）只画针 —— 引线与标签
 * 都不画，针边上的台数角标照留：那一行字没了，但这枚针是哪里、有几台仍然读得出来。
 */
function Pin({ p }: { p: Placed }) {
  const cx = p.px.toFixed(1)
  const cy = p.py.toFixed(1)
  return (
    <g>
      {!p.hidden && (
        <path className="globe-stem" d={`M ${cx} ${cy} L ${p.lx.toFixed(1)} ${p.ly.toFixed(1)}`} />
      )}
      <circle className="globe-pin" cx={cx} cy={cy} r={2.1} />
      {/* 多台地区：针边上挂一个小小的台数（标签里也写着「地区 ×N」，两处都在，
          因为标签可能被挤掉、针本身也常常落在标签的另一头）。 */}
      {p.count > 1 && (
        <text className="globe-count" x={p.px + 4.5} y={p.py - 3.5}>
          {p.count}
        </text>
      )}
      {!p.hidden && (
        <text className="globe-label" x={p.lx + (p.end ? -3 : 3)} y={p.ly + 3} textAnchor={p.end ? "end" : "start"}>
          {p.label}
        </text>
      )}
      <circle className="hit" cx={cx} cy={cy} r={9} fill="transparent" data-node={p.id} data-index={p.index} data-region={p.region.key} data-online={p.online ? "1" : "0"} data-count={p.count}>
        <title>{p.count > 1 ? `${p.region.label}：${p.count} 台（打开其中第一台）` : `打开 ${p.name}`}</title>
      </circle>
    </g>
  )
}

/** 地区那一行的旗子：与卡片上那面是同一套文件（`public/flags/<CC>.svg`）。取不到就不占位。 */
function RegionFlag({ code }: { code: string }) {
  const [missing, setMissing] = useState(false)
  if (!code || missing) return null
  return (
    <img
      className="globe-reg-flag"
      src={`/flags/${code}.svg`}
      alt=""
      width={16}
      height={12}
      loading="lazy"
      onError={() => setMissing(true)}
    />
  )
}

const NARROW = matchMedia("(max-width: 720px)")
const REDUCE = matchMedia("(prefers-reduced-motion: reduce)")

function subscribe(query: MediaQueryList, notify: () => void) {
  query.addEventListener("change", notify)
  return () => query.removeEventListener("change", notify)
}

/** 窄屏（≤720px）走 low 档。与上游不同的是：上游在这个宽度上干脆不画地球。 */
function useNarrow(): boolean {
  return useSyncExternalStore((notify) => subscribe(NARROW, notify), () => NARROW.matches)
}

/** 系统开了「减弱动态效果」就不自转（跟着系统设的改变，不是只在挂载时读一次）。 */
function useReducedMotion(): boolean {
  return useSyncExternalStore((notify) => subscribe(REDUCE, notify), () => REDUCE.matches)
}

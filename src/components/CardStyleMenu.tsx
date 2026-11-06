import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Activity, AlignJustify, Check, Grid2x2, LayoutGrid, RectangleHorizontal, Rows3, Table } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { ThemeConfig } from "@/lib/site-settings"

type CardStyle = ThemeConfig["cardStyle"]

/**
 * 顶栏那枚「卡片形态」菜单：访客自己挑列表用哪一种排法（六种与后台设置里那六档一一对应、
 * 名字也照抄，站长在后台选了哪档，访客在这儿的同一行上会看到一枚「默认」）。
 *
 * 为什么是"图标 + 菜单"而不是页面上摆一行分段控件：这一行属于**看的人**的偏好，不是内容；
 * 摆进列表工具栏会把它往下推一行、每台机器都跟着矮一截。摆顶栏与旁边那枚地球、那枚明暗开关
 * 是同一处，也就同一套规格（36×36、只有图标、说明放 title）。
 *
 * 选中的东西不进 hub（那是站长的设置项，见 `@/lib/theme-config` 的 useCardStyle）：
 * 只写访客自己的浏览器。
 */
const STYLES: { value: CardStyle; label: string; hint: string; Icon: typeof Grid2x2 }[] = [
  { value: "classic", label: "经典", hint: "速率与总量各占一行，底部是 2×2 四格；不含延迟", Icon: Grid2x2 },
  { value: "plain", label: "简约", hint: "网络合成一行，标签提亮、进度条更细，不含延迟", Icon: Rows3 },
  { value: "latency", label: "延迟", hint: "网络一行，下方带三网延迟", Icon: Activity },
  { value: "detailed", label: "详细", hint: "在延迟之上再加在线时长、价格与到期", Icon: AlignJustify },
  { value: "wide", label: "宽卡", hint: "一行三张的宽卡：四格读数、上传下载两栏与总流量条，底注摊价格与备注", Icon: RectangleHorizontal },
  { value: "compact", label: "紧凑", hint: "一行一台的表格，密度最高", Icon: Table },
]

export function CardStyleMenu({ value, siteDefault, onPick }: {
  /** 现在生效的那一档。 */
  value: CardStyle
  /** 站长在「主题设置」里设的那一档：它那一行标「默认」，也是访客回到"跟着站长走"的那一项。 */
  siteDefault: CardStyle
  onPick: (next: CardStyle) => void
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  const menu = useRef<HTMLSpanElement>(null)
  // 浮层的落点（宿主 + 坐标），开着的时候才非空；见下面 useLayoutEffect 那段注释。
  const [spot, setSpot] = useState<{ host: HTMLElement; top: number; right: number } | null>(null)

  // ★ 浮层**不能**长在按钮里：按钮住在顶栏那条 `overflow-x-auto` 的图标带里，而条带会把
  //   越界的子元素裁掉 —— 实测这枚菜单 144×170，点开后只有 2px 高的一条边露在条带下沿，
  //   看着就是「点了没反应」（站长报的「按钮打不开」，桌面与手机都中招）。所以浮层经
  //   portal 挂到 header 上：header 是 sticky（本身就是绝对定位的锚点），这条路径不经过
  //   任何裁剪。坐标照按钮的实时矩形算，条带横向滑动 / 窗口缩放时要重新摆（滑动会让按钮动）。
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const b = box.current?.getBoundingClientRect()
      const host = box.current?.closest<HTMLElement>("header")
      const h = host?.getBoundingClientRect()
      if (b && host && h) setSpot({ host, top: b.bottom - h.top + 4, right: h.right - b.right })
    }
    place()
    const strip = box.current?.closest<HTMLElement>(".header-tools")
    window.addEventListener("resize", place)
    strip?.addEventListener("scroll", place)
    return () => {
      window.removeEventListener("resize", place)
      strip?.removeEventListener("scroll", place)
    }
  }, [open])

  // 点别处、按 Esc 都要收起（与卡片右上角那枚浮层同一套做法：只在浮层外按下时收）。
  // 浮层现在挂在 header 上（不在 box 里）—— 判「浮层外」要多看它自己一眼，否则按下选项
  // 那一下会先把浮层卸掉、click 就丢了。
  // 别写 `e.target as Node` —— 本仓库的 `Node` 是节点类型（@/lib/api），会跟 DOM 的撞名。
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const el = e.target
      if (!(el instanceof HTMLElement) || !(box.current?.contains(el) || menu.current?.contains(el))) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onDown)
    document.addEventListener("keydown", onKey)
    // ★2026-11-06：role="menu" 得有菜单该有的键盘行为 —— 打开时焦点落到当前那一档，
    // ↑↓ / Home / End 在选项间移动，Esc 收起来并把焦点还给触发按钮。原先只有「点别处 /
    // 按 Esc 收起」，键盘用户 Tab 进来之后方向键毫无反应、Tab 走开菜单还挂在屏幕上。
    const items = () => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("[data-style-option]") ?? [])
    const start = items().find((el) => el.getAttribute("aria-checked") === "true") ?? items()[0]
    start?.focus()
    const onNav = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false)
        box.current?.querySelector<HTMLElement>(".card-style-toggle")?.focus()
        return
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return
      const list = items()
      if (!list.length) return
      e.preventDefault()
      const at = list.indexOf(document.activeElement as HTMLButtonElement)
      const to = e.key === "Home" ? 0 : e.key === "End" ? list.length - 1
        : (at + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length
      list[to]?.focus()
    }
    document.addEventListener("keydown", onNav)
    return () => {
      document.removeEventListener("pointerdown", onDown)
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("keydown", onNav)
    }
  }, [open])

  return (
    <span className="relative inline-flex" ref={box}>
      <Button
        variant="ghost"
        size="icon"
        className="card-style-toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="卡片形态"
        title="卡片形态"
        onClick={() => setOpen((v) => !v)}
      >
        <LayoutGrid />
      </Button>
      {open && spot && createPortal(
        <span
          ref={menu}
          role="menu"
          aria-label="卡片形态"
          data-style-menu=""
          // 绝对定位挂在 header 上（见 place() 那段注释）；right 贴住按钮右缘（窄屏也不会
          // 出界），top 落在按钮下沿 4px —— 与原本 top-10 的落点一致。
          style={{ top: spot.top, right: spot.right }}
          // 焦点离开这一块（Tab 走开）就收起：菜单开着却停在别处，读屏的焦点与视觉对不上。
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setOpen(false)
          }}
          className="absolute z-20 block w-36 overflow-hidden rounded-md border bg-popover py-1 text-sm shadow-md"
        >
          {STYLES.map(({ value: v, label, hint, Icon }) => (
            <button
              key={v}
              type="button"
              role="menuitemradio"
              aria-checked={v === value}
              data-style-option={v}
              title={hint}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent"
              onClick={() => {
                onPick(v)
                setOpen(false)
              }}
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate">{label}</span>
              {v === siteDefault && <span className="shrink-0 text-[10px] text-muted-foreground">默认</span>}
              {v === value && <Check className="size-3.5 shrink-0" />}
            </button>
          ))}
        </span>,
        spot.host,
      )}
    </span>
  )
}

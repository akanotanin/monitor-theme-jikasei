import { Search, X } from "lucide-react"
import { useRef } from "react"

import { Button } from "@/components/ui/button"

/**
 * 顶栏右上角那个搜索框：按**名称 / 地区 / 系统**把列表收窄到要看的那几台
 * （口径全在 `@/lib/search`，UI 只负责把词交出去）。
 *
 * 收起时只占一枚 36×36 的放大镜（与旁边那几枚图标同规格），**点它才就地长出输入框**：
 * 输入框在图标**左边**长出来，右边那几枚图标一枚都不动 —— 顶栏是 flex，多出来的那 210px
 * 由站名与图标之间那段空白吸收，所以开合时图标不会左右跳。
 *
 * **收起＝不筛**：收起的动作会把词一并清掉（与窄屏那一行同一条规则）。不这样就会出现
 * 「列表还筛着、输入框却不见了」的状态，访客找不到「怎么取消」—— 空态那句提示也是照着
 * 「框开着」写的。Esc 是两段式：有词先清词、框还开着；空框上再按一下才收起。
 * 点框外**不收起**（也不清词）：搜索是「这一眼看哪几台」，去点开一台机器看清了再回来，
 * 那几台理应还在。
 *
 * 窄屏（<640px）顶栏塞不下输入框，点开是在顶栏**下面多一行**（`SearchRow`，由 App 摆在
 * header 里，跟着那个 sticky 块一起吸顶）；那枚图标在两种屏宽下都在原位，开合的落点始终是同一处。
 *
 * 只长在列表页（与旁边那枚地球开关同一条件）：搜索的对象就是下面那张列表，站在某台机器的
 * 详情页里按它没有落点。
 *
 * 词不进 localStorage、也不进 hub：它是「这一眼要看哪几台」，不是偏好；刷新就回到全量，
 * 与卡片形态那种「访客自己的偏好」是两回事。
 */
export function SearchBox({ value, onChange, open, onToggle, onClose }: {
  value: string
  onChange: (next: string) => void
  /** 展开了没（桌面＝输入框长出来了没；窄屏＝下面那一行在不在）。 */
  open: boolean
  /** 点那枚图标：收起时开、开着时收起（收起那一下由 App 一并清词）。 */
  onToggle: () => void
  /** 收起（Esc 在空框上按的那一下）。 */
  onClose: () => void
}) {
  return (
    <>
      {/* 点开之后**才渲染**（不是先渲染再用 CSS 藏起来）：收起时这一行里除了一枚图标什么都没有。
          它只在 ≥640px 露面，窄屏那份在下面的 SearchRow 里 —— 两处共用同一个受控值，
          量可见性的人用 offsetParent 分辨（见 tools/verify_search.mjs）。 */}
      {open && (
        <Field value={value} onChange={onChange} onClose={onClose} autoFocus className="search-field-wide hidden w-[210px] sm:flex" />
      )}
      {/* 那枚图标：桌面与窄屏共用同一枚，收起/展开都在同一个位置（收起的落点一眼可见）。 */}
      <Button
        variant="ghost"
        size="icon"
        className="search-toggle"
        aria-expanded={open}
        aria-label={open ? "收起搜索" : "搜索节点"}
        title={open ? "收起搜索" : "搜索（名称 / 地区 / 系统）"}
        onClick={onToggle}
      >
        <Search />
      </Button>
    </>
  )
}

/**
 * 窄屏展开后的那一整行。摆成 header 的直接子节点（不是顶栏那一行的孩子）：
 * 它要占满整个宽度，也要跟着 header 一起吸顶。
 *
 * `autoFocus`：点开就是为了打字，不该再让访客点第二下。
 */
export function SearchRow({ value, onChange, onClose }: {
  value: string
  onChange: (next: string) => void
  /** 收起这一行（App 那边会顺手把词清掉，免得留下一个看不见的筛选）。 */
  onClose: () => void
}) {
  return (
    <div className="search-row border-t px-4 py-2 sm:hidden">
      <Field value={value} onChange={onChange} onClose={onClose} autoFocus className="search-field-row flex w-full" />
    </div>
  )
}

/**
 * 输入框本体：左边一枚放大镜（不吃指针事件）、右边一枚清空（有词才出现）。
 *
 * `type="search"` + 自己那枚清空：iOS/WebKit 会自带的那个小叉被 index.css 里的
 * `::-webkit-search-cancel-button` 关掉，两个叉并排就成了「一模一样的按钮做两件事」。
 */
function Field({ value, onChange, onClose, autoFocus, className }: {
  value: string
  onChange: (next: string) => void
  onClose?: () => void
  autoFocus?: boolean
  className?: string
}) {
  const box = useRef<HTMLInputElement>(null)
  return (
    <span className={`search-field relative items-center ${className ?? ""}`}>
      <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" aria-hidden="true" />
      <input
        ref={box}
        type="search"
        className="search-input h-9 w-full rounded-md border bg-transparent pr-8 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return
          // Esc：有词先清词（这一步谁都用得上）；本来就是空的，窄屏上再顺手把那行收起来。
          if (value !== "") onChange("")
          else onClose?.()
        }}
        placeholder="搜索名称/地区/系统"
        aria-label="搜索节点：名称、地区、系统"
      />
      {value !== "" && (
        <button
          type="button"
          className="search-clear absolute right-1.5 grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          onClick={() => {
            onChange("")
            // 清完把焦点留在框里：接着打下一个词不用再点一次。
            box.current?.focus()
          }}
          title="清空"
          aria-label="清空搜索"
        >
          <X className="size-3.5" />
        </button>
      )}
    </span>
  )
}

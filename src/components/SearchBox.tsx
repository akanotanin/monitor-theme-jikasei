import { Search, X } from "lucide-react"
import { useRef } from "react"

import { Button } from "@/components/ui/button"

/**
 * 顶栏右上角那个搜索框：按**名称 / 地区 / 系统**把列表收窄到要看的那几台
 * （口径全在 `@/lib/search`，UI 只负责把词交出去）。
 *
 * 两副面孔，按屏宽切换 —— 顶栏里已经有站标 + 五枚按钮，390px 上再塞一个输入框会挤爆：
 *   · ≥640px：直接摆一个输入框（放大镜在框里，右侧是清空）；
 *   · <640px：只占一枚图标按钮，点开是顶栏下面**多一行**（`SearchRow`，由 App 摆在
 *     header 里，跟着那个 sticky 块一起吸顶）。
 *
 * 只长在列表页（与旁边那枚地球开关同一条件）：搜索的对象就是下面那张列表，站在某台机器的
 * 详情页里按它没有落点。
 *
 * 词不进 localStorage、也不进 hub：它是「这一眼要看哪几台」，不是偏好；刷新就回到全量，
 * 与卡片形态那种「访客自己的偏好」是两回事。
 */
export function SearchBox({ value, onChange, open, onToggle }: {
  value: string
  onChange: (next: string) => void
  /** 窄屏那行展开了没（桌面上这个状态没用 —— 输入框一直都在）。 */
  open: boolean
  onToggle: () => void
}) {
  return (
    <>
      <Field value={value} onChange={onChange} className="search-field-wide hidden w-[210px] sm:flex" />
      {/* 窄屏那枚按钮：与旁边那几枚同规格（36×36、只有图标、说明放 title）。 */}
      <Button
        variant="ghost"
        size="icon"
        className="search-toggle sm:hidden"
        aria-expanded={open}
        aria-label="搜索节点"
        title="搜索（名称 / 地区 / 系统）"
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

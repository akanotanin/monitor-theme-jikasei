import { Search, X } from "lucide-react"
import { useRef } from "react"

/**
 * 顶栏右上角那个搜索框：按**名称 / 地区 / 系统**把列表收窄到要看的那几台
 * （口径全在 `@/lib/search`，UI 只负责把词交出去）。
 *
 * 形态与手感：**收起时是一枚 36×36 的方形图标**（与旁边那几枚同规格：无边框、悬停一层浅底、
 * 放大镜正好居中），**点它就地长开成 240px 的输入框** —— 往**左边**长（右边那几枚图标一枚都不动，
 * 多出来的宽度由站名与图标之间那段空白吸收），边框、占位文案、焦点圈在这 150ms 里一起淡入；
 * 失焦再收回去（CSS 的 `:focus-within` 驱动，见下面 Field 的 className），**词留着**。
 *
 * 词留着是刻意的：搜索是「这一眼看哪几台」，点开一台机器看清了再回来，那几台理应还在。
 * 收起态看不见词，所以那枚放大镜会**提色**（弱化的灰 → 前景色），悬停说明也换成
 * `搜索：东京（2 台）` —— 收起来的筛选不至于变成「看不见的筛选」。
 * 清词只有两处：框里那枚 ×，或 Esc（Esc 两段式：有词先清词、框还开着；空框上再按一下才收起）。
 *
 * 窄屏（<640px）顶栏塞不下 240px 的输入框，长开那份只在 ≥640px 生效；窄屏点那枚图标是在顶栏
 * **下面多一行**（`SearchRow`，由 App 摆成 header 的直接子节点，跟着那个 sticky 块一起吸顶）。
 *
 * 只长在列表页（与旁边那枚地球开关同一条件）：搜索的对象就是下面那张列表，站在某台机器的
 * 详情页里按它没有落点。
 *
 * 词不进 localStorage、也不进 hub：它是「这一眼要看哪几台」，不是偏好；刷新就回到全量，
 * 与卡片形态那种「访客自己的偏好」是两回事。
 */
export function SearchBox({ value, onChange, onActivate, onClose, hits }: {
  value: string
  onChange: (next: string) => void
  /** 焦点落到框里（＝点了那枚方形图标）：桌面上什么都不用做（CSS 自己长开）；窄屏＝把那一行开/关。 */
  onActivate: () => void
  /** 收起（Esc 在空框上按的那一下）。 */
  onClose: () => void
  /** 命中台数：只用在收起态的悬停说明里（`搜索：东京（2 台）`）。 */
  hits: number
}) {
  return (
    <Field
      value={value}
      onChange={onChange}
      onActivate={onActivate}
      onClose={onClose}
      /* 长开只在 ≥640px 生效：`sm:focus-within:` 那个变体就是这道闸。 */
      className="search-field-wide w-9 sm:focus-within:w-60"
      title={value === "" ? "搜索（名称 / 地区 / 系统）" : `搜索：${value}（${hits} 台）`}
    />
  )
}

/**
 * 窄屏展开后的那一整行。摆成 header 的直接子节点（不是顶栏那一行的孩子）：
 * 它要占满整个宽度，也要跟着 header 一起吸顶。
 *
 * `autoFocus`：点开就是为了打字，不该再让访客点第二下。
 * 它**不收** onActivate：那一行刚挂上就自动聚焦，接上 onActivate 会当场又把自己关掉。
 */
export function SearchRow({ value, onChange, onClose }: {
  value: string
  onChange: (next: string) => void
  /** 收起这一行。 */
  onClose: () => void
}) {
  return (
    <div className="search-row border-t px-4 py-2 sm:hidden">
      <Field value={value} onChange={onChange} onClose={onClose} autoFocus variant="row" className="search-field-row flex w-full" />
    </div>
  )
}

/**
 * 输入框本体。左边一枚放大镜（不吃指针事件，落在框的左沿 10px 处 —— 收起时 36px 的框里
 * 它正好居中，长开时它跟着左沿走到输入位置之前）、右边一枚清空（有词**且框长开着**才出现，
 * 那条规则写在 index.css 的 `.search-field .search-clear` 里）。
 *
 * 两副长相（`variant`）：
 *   square —— 顶栏那格。收起时是一枚方形图标：内边距收紧（px-2.5）、字色与占位文案都透明；
 *             ≥640px 且拿到焦点时松到 px-8、露出一圈边框与焦点圈；<640px 不长开（那一行另开）。
 *   row    —— 窄屏下面那一行里的普通输入框：边框、占位文案、焦点圈一直在。
 *
 * 三处刻意的取舍：
 *   ① 收起态**收紧内边距**（`px-2.5`）并让字色透明，长开时再松到 `px-8`：两者都不收的话，
 *      36px 的框里那 64px 的内边距会把输入框的**盒子**顶到 66px（内容区被压成 0，但 padding 挤不掉，
 *      多出来的 30px 会盖住旁边那枚扳手 —— 实测到的），所以「靠 padding 把词挤出可视区」走不通。
 *      字色透明只在收起态生效，光标不会跟着透明（收起＝没焦点，本来就没有光标）。
 *   ② 长开的那一套样式全部挂在 `sm:` 下面：窄屏那格的宽度没变，若让它在窄屏也吃 focus 的样式，
 *      它就会长到 66px 顶到旁边去 —— 窄屏的落点是下面那一行，不是这一格。
 *   ③ `type="search"` 自带的那个小叉由 index.css 的 `::-webkit-search-cancel-button` 关掉，
 *      两个长得差不多、做同一件事的按钮并排只会让人犹豫点哪个。
 */
const SQUARE_INPUT = "search-input h-9 w-full min-w-0 rounded-md border border-transparent bg-transparent px-2.5 text-sm text-transparent outline-none transition-all placeholder:text-transparent hover:bg-accent focus:bg-transparent sm:focus:border-input sm:focus:px-8 sm:focus:text-foreground sm:focus:ring-[3px] sm:focus:ring-ring/30 sm:focus:placeholder:text-muted-foreground dark:hover:bg-accent/50"
const ROW_INPUT = "search-input h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-8 text-sm outline-none transition-all placeholder:text-muted-foreground focus:ring-[3px] focus:ring-ring/30"

function Field({ value, onChange, onActivate, onClose, autoFocus, className, title, variant = "square" }: {
  value: string
  onChange: (next: string) => void
  onActivate?: () => void
  onClose?: () => void
  autoFocus?: boolean
  className?: string
  title?: string
  variant?: "square" | "row"
}) {
  const box = useRef<HTMLInputElement>(null)
  const square = variant === "square"
  return (
    <span className={`search-field relative flex items-center transition-all duration-150 ${className ?? ""}`}>
      {/* 有词时提色（前景色）：收起态看不见词，这一枚颜色就是「正在筛」的唯一视觉信号。 */}
      <Search className={`pointer-events-none absolute left-2.5 size-4 ${square && value !== "" ? "text-foreground" : "text-muted-foreground"}`} aria-hidden="true" />
      <input
        ref={box}
        type="search"
        className={square ? SQUARE_INPUT : ROW_INPUT}
        value={value}
        autoFocus={autoFocus}
        onFocus={onActivate}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return
          // Esc 两段式：有词先清词（这一步谁都用得上）；空框上再按一下才收起。
          if (value !== "") onChange("")
          else {
            // 桌面那格是靠焦点长开的 —— 收起就是把它 blur 掉（窄屏那一行则由 onClose 摘掉）。
            box.current?.blur()
            onClose?.()
          }
        }}
        placeholder="搜索名称/地区/系统"
        title={title}
        aria-label="搜索节点：名称、地区、系统"
      />
      {value !== "" && (
        <button
          type="button"
          className="search-clear absolute right-1.5 size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
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

/**
 * 顶栏那枚「养鸡场」图标：Lucide `bird` 的描边路径 + 补一道鸡冠。
 *
 * 不用 lucide-react 的 `<Bird />`，是因为上游那只鸟没有冠——补上才认得出是鸡，
 * 而自己拼「椭圆身体 + 圆头」在 24px 下就是一坨（描边互相压住，试过四个变体）。
 *
 * 描边属性照 Lucide 的规格写（24×24 viewBox、`stroke-width: 2`、圆头圆角、
 * `currentColor`），尺寸交给 Button 的 `[&_svg:not([class*='size-'])]:size-4`——
 * 这样它与相邻那两枚图标按钮的尺寸、颜色、间距完全一致，不用手调。
 */
export function FarmIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M16 7h.01" />
      <path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20" />
      <path d="m20 7 2 .5-2 .5" />
      <path d="M10 18v3" />
      <path d="M14 17.75V21" />
      <path d="M7 18a6 6 0 0 0 3.84-10.61" />
      <path d="M13.6 3.4c.3-1.2 1-1.9 2-1.9.9 0 1.6.7 1.9 1.8" />
    </svg>
  )
}

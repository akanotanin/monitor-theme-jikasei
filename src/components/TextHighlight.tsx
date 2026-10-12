import type { ReactNode } from "react"

import { highlightRanges } from "@/lib/search"

/**
 * 搜索命中处描色：把 text 里命中词（字面出现、大小写不敏感）的片段包成 `<mark>`。
 *
 * 词为空、或一个字面命中都没有时**原样返回** —— 不改变任何现有渲染（护栏里那批文案断言
 * 因此不受影响：mark 不改变 `textContent`）。
 *
 * `<mark>` 的浏览器默认样式（黑底黄字）由 Tailwind 的 preflight 折掉了大半，但留着的背景
 * 仍显眼，所以这里显式给一套：前景色的 10% 浅底 + 前景色文字 —— 深浅两套主题都跟着同一个
 * token 走，与「命中处提一下、但别把卡片变成荧光笔」的观感一致。
 */
export function TextHighlight({ text, terms }: { text: string; terms?: string[] }) {
  if (!terms?.length || !text) return <>{text}</>
  const ranges = highlightRanges(text, terms)
  if (!ranges.length) return <>{text}</>
  const out: ReactNode[] = []
  let pos = 0
  ranges.forEach(([from, to], i) => {
    if (from > pos) out.push(text.slice(pos, from))
    out.push(
      <mark key={i} className="rounded-[3px] bg-foreground/10 px-px text-foreground">
        {text.slice(from, to)}
      </mark>,
    )
    pos = to
  })
  if (pos < text.length) out.push(text.slice(pos))
  return <>{out}</>
}

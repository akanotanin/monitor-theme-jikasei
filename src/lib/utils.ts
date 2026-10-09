import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

// twMerge 是**承重**的，别当「可以省掉的 8.5 KB gzip」删（2026-10-09 审计过一轮）：
// 几个调用点正是靠它裁决类冲突——Skeleton 的 `rounded-[3px]/rounded-full` 对基类
// `rounded-md`、Card 的 `gap-0` 对基类 `gap-6`、Badge 的 `font-normal` 对基类
// `font-semibold`。而生成样式表里的顺序**不站在覆盖方**（实测：
// rounded-[3px] < rounded-full < rounded-md、gap-0 < gap-6、font-normal < font-semibold），
// 删掉它这几处覆盖会静默失效。真要省这份字节，得先把这些调用点的冲突消掉，光删依赖不行。
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

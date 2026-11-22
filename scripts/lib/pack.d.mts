// scripts/lib/pack.mjs 的类型声明（只有单测 import 它；运行时不参与构建）。
//
// 为什么手写而不是 `checkJs`：`tsc -b` 只编 src/，把整个 scripts/ 纳进程序会连带要求
// 那些一次性工具脚本也过严格类型检查 —— 收益不成比例。这里只描述单测用到的那两个函数。

export declare const packDirectory: (
  root: string,
  archive: string,
  options: { files: string[] },
) => { digest: string; size: number }

export declare const listArchive: (archive: string) => { name: string; dir: boolean; size: number }[]

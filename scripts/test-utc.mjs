// 用 UTC 跑那几支「按日历日数天数」的单测（2026-11-21 加）。
//
// 为什么需要：`daysUntil` 按**北京**日历日算，而单测夹具若按**本地**日历日拼日期字符串，
// 在 UTC+8 的开发机上恰好一致、到了 UTC 的 CI 上就整体差一天（实测：十天后得到 9、
// 已过期得到 -4）。这类回归本机看不出来，所以单列一条能在本机跑同一套口径的命令。
//
// 不用 `TZ=UTC node ...` 前缀：Windows 的 cmd/npm 不认这种写法。这里直接改进程环境再
// 派生，跨平台一致。
import { spawnSync } from "node:child_process"

const files = [
  "src/lib/format.test.ts",
  "src/lib/money.test.ts",
  "src/lib/today-traffic.test.ts",
]
for (const file of files) {
  const r = spawnSync(process.execPath, [file], {
    stdio: "inherit",
    env: { ...process.env, TZ: "UTC" },
  })
  if (r.status !== 0) {
    console.error(`\n${file} 在 TZ=UTC 下未通过（本地时区能过、UTC 过不了 = 夹具依赖了本地日历日）`)
    process.exit(r.status ?? 1)
  }
}
console.log("\nTZ=UTC 口径：全部通过")

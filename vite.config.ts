import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // import.meta.dirname rather than new URL(...).pathname: the latter is
  // URL-encoded, so a checkout under a path containing a space or a non-ASCII
  // name resolves to %20 and the alias silently points nowhere.
  resolve: { alias: { "@": import.meta.dirname + "/src" } },
  build: {
    chunkSizeWarningLimit: 900,
    // 没有 assetsInlineLimit 例外了：国旗从 public/flags/ 原样伺服，不经过打包器。
    // 上游把国旗当模块导入，所以要点名别让 Vite 把每面旗塞成 data URL —— 那样整个
    // 旗表会随入口包一起下发；现在只有页面上真正出现的那几面会被下载。
  },
  // A theme reads public data only, so any hub with its status page open can
  // serve as the source: MONITOR_HUB=https://hub.example.com npm run dev.
  // changeOrigin sends that hub its own name as Host, which the proxy or CDN in
  // front of it routes by.
  server: {
    // ★三条都要代理（2026-11-21 三审）：应用除了 `/api` 还会请求
    //   `/themes/<short>/config`（主题设置）与 `/chicken/api/nodes`（小鸡农场入口探测）。
    //   原先只代理 `/api`，于是 `npm run dev` 下站点设置永远取不到（静默回落 DEFAULTS）、
    //   农场入口永远不出现 —— 而上面那段注释恰恰写着「any hub with its status page open
    //   can serve as the source」，实际做不到。
    proxy: Object.fromEntries(
      ["/api", "/themes", "/chicken"].map((path) => [
        path,
        { target: process.env.MONITOR_HUB || "http://127.0.0.1:9911", changeOrigin: true, ws: path === "/api" },
      ]),
    ),
  },
})

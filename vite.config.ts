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
    proxy: { "/api": { target: process.env.MONITOR_HUB || "http://127.0.0.1:9911", changeOrigin: true, ws: true } },
  },
})

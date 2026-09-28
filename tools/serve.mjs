// 本地静态伺服 dist/ + 桩掉 /api/*：不依赖任何远端 hub 也能验主题的渲染与设置项。
//
// 用法：node tools/serve.mjs [端口=5199] [config JSON 文件] [nodes JSON 文件] [上游 hub]
//   node tools/serve.mjs 5199 '{"siteIcon":"/site-icon.png","listTop":"groups"}'
//   node tools/serve.mjs 5199 cfg.json ../fake_nodes.json
//   node tools/serve.mjs 5199 '' '' http://127.0.0.1:28081     # /api/* 转给真 hub（经隧道），静态仍走本机
//
// 为什么要有「上游 hub」这一档：桩数据只有节点列表，历史指标全是空对象，图表相关的断言
// （例如延迟页签 7 天窗口）在桩上跑不出结论。把 /api/* 转给真 hub，静态文件仍走本机，
// 就能在**部署到线上之前**拿真实数据验一版新构建，同时避开 CDN 与隧道对静态文件的干扰。
//
// 为什么要它：经 SSH 隧道取静态文件时，同一个地址被并发请求（标签页图标 + 顶栏图标）
// 偶发只回来一半，会让人误判成主题的问题。把静态资源换成走本机，就能把两边分开看。
import { createServer, request } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'

const PORT = Number(process.argv[2] || 5199)
const UPSTREAM = (process.argv[5] || '').replace(/\/$/, '')
const asJson = (arg) => {
  if (!arg) return null
  return existsSync(arg) ? JSON.parse(readFileSync(arg, 'utf8')) : JSON.parse(arg)
}
const CONFIG = asJson(process.argv[3]) ?? {}
const NODES = asJson(process.argv[4]) ?? { nodes: [] }

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
}

createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  if (path.startsWith('/api/')) {
    if (UPSTREAM) {
      // 转给真 hub：方法与查询串原样带走，只把 Host 换成上游自己的。
      const up = new URL(UPSTREAM + path + url.search)
      const proxied = request(up, { method: req.method, headers: { host: up.host, accept: req.headers.accept || '*/*' } }, (r) => {
        res.writeHead(r.statusCode || 502, { 'Content-Type': r.headers['content-type'] || 'application/json', 'Cache-Control': 'no-store' })
        r.pipe(res)
      })
      proxied.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e) })) })
      return req.pipe(proxied)
    }
    const body =
      path === '/api/me' ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: 'jikasei 本地' } :
      path === '/api/nodes' ? NODES :
      path.endsWith('/config') ? CONFIG :
      path === '/api/version' ? { version: '1.3.0' } : {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  const file = path === '/' ? '/index.html' : path
  const full = join('dist', normalize(file).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(full) || statSync(full).isDirectory()) {
    // 和 hub 一样：未知路径回落 index.html（SPA 的客户端路由）。
    res.writeHead(200, { 'Content-Type': TYPES['.html'] })
    return res.end(readFileSync('dist/index.html'))
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(full)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(full))
}).listen(PORT, '127.0.0.1', () => console.log(`dist/ 已伺服在 http://127.0.0.1:${PORT}/  config=${JSON.stringify(CONFIG)}${UPSTREAM ? `  /api/* → ${UPSTREAM}` : '  （/api/* 用桩数据）'}`))

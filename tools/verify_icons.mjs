// 站点图标与标签页图标的验收：本机起一个静态+桩接口的服务器（**不经隧道**），
// 用 headless Chrome 断言「一处设置、两处图标」真的同时生效，以及取不到时的兜底。
//
// 用法：node tools/verify_icons.mjs [configJSON|config文件] [nodes文件]
//   node tools/verify_icons.mjs                                  # 默认值
//   node tools/verify_icons.mjs '{"siteIcon":"/no-such.png"}'    # 取不到 -> 退回主题自带那张
//
// 为什么不用远端 hub 验这一条：经 SSH 隧道取静态文件时，同一个地址那几条并发请求
// 偶发只回一半（页头那张当场失败），会把隧道的问题算到主题头上。静态资源走本机就能分开。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const asJson = (arg, fallback) => {
  if (!arg) return fallback
  return existsSync(arg) ? JSON.parse(readFileSync(arg, 'utf8')) : JSON.parse(arg)
}
const CONFIG = asJson(process.argv[2], {})
const NODES = asJson(process.argv[3], { nodes: [] })
const DEFAULT_ICON = '/site-icon.png'
const PORT = 5199
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }

const server = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  if (path.startsWith('/api/')) {
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '图标验收' }
      : path === '/api/nodes' ? NODES
      : path.endsWith('/config') ? CONFIG : {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] })
    return res.end(readFileSync('dist/index.html'))
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
console.log(`dist/ 伺服在 http://127.0.0.1:${PORT}/  config=${JSON.stringify(CONFIG)}`)

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p)) || 'chrome'

// 机器上常有别的 Chrome 在跑（用户自己的 + 之前测试残留），端口与资源都紧张：
// 起不来就换个端口再来一次，别让一次偶发把整条验收判死。
let chrome, dbgPort, wsUrl = null
for (let attempt = 0; attempt < 2 && !wsUrl; attempt++) {
  dbgPort = 9910 + Math.floor(Math.random() * 80)
  chrome?.kill()
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, '--remote-allow-origins=*',
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/iconcheck-' + dbgPort + '-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch {}
    if (!wsUrl) await sleep(300)
  }
  if (!wsUrl) console.log(`第 ${attempt + 1} 次启动 Chrome（端口 ${dbgPort}）没起来，换端口重试`)
}
if (!wsUrl) throw new Error('Chrome 起不来：先看看是不是堆了太多测试实例（按 --user-data-dir 前缀清一遍）')

let id = 0
const pending = new Map()
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')
const errors = []
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text) })

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
for (let i = 0; i < 40; i++) { await sleep(400); if (await js(`document.querySelectorAll('[role=button]').length > 0`)) break }
await sleep(2500)

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }
const state = JSON.parse(await js(`JSON.stringify({
  headerIcon: (() => { const i = document.querySelector('header img'); return i ? { src: i.getAttribute('src'), loaded: i.complete && i.naturalWidth > 0, w: i.naturalWidth } : null })(),
  favicon: document.querySelector('link[rel~="icon"]')?.getAttribute('href') ?? null,
  touch: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href') ?? null,
  icons: [...document.querySelectorAll('link[rel~="icon"],link[rel="apple-touch-icon"]')].length,
})`))

// 期望值：站长填了就用它；没填/取不到就用主题自带那张（与顶栏同一套兜底）。
const want = CONFIG.siteIcon && !String(CONFIG.siteIcon).includes('no-such') ? CONFIG.siteIcon : DEFAULT_ICON
console.log(`期望图标: ${want}`)
check('顶栏图标加载成功（页头那枚真的画出来了）', !!state.headerIcon?.loaded, JSON.stringify(state.headerIcon))
check('标签页图标 = 站点图标设置', state.favicon === want, `favicon=${state.favicon}`)
check('apple-touch-icon 与它同值（手机加到主屏也是这张）', state.touch === want, `touch=${state.touch}`)
check('控制台无异常', errors.length === 0, errors.join(' | '))
console.log(`结果: PASS ${pass} / FAIL ${fail}`)
ws.close(); chrome.kill(); server.close()
process.exit(fail ? 1 : 0)

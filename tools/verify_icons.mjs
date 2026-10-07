// 站点图标的验收（hub 1.4.0 口径）：本机起一个「静态 + 桩接口 + 模拟 hub 的图标路由」的服务器
// （**不经隧道**），用 headless Chrome 断言下面这一组契约 —— 主题侧不再有自己的图标设置项，
// 图标完全交给 hub 的面板，主题只负责两件事：**静态引用那两个固定地址**、**自带两份兜底文件**。
//
// 用法：node tools/verify_icons.mjs
//
//   ① 兜底：hub 上没设图标 → `/favicon.svg`、`/apple-touch-icon.png` 由主题目录里的两份文件回答，
//      页头那枚圆标也加载成功（且与标签页**同一个 URL**）
//   ② 站长设了图标：hub 用自己那份回答这两条路径（这里桩一张 32×32 的图），页头跟着换 ——
//      主题不许改写 <link>，也不许另取一个地址
//   ③ hub 给地址带版本号（`?v=<摘要>`）：主题必须原样保留这个地址，而不是抹平成 `/favicon.svg`
//   ④ 主题包里带着那两份兜底文件，且 `apple-touch-icon.png` 是不透明的 180×180（iOS 会把透明的填黑）
//   ⑤ 早跑脚本 icon-probe.js 已经删干净（那是 1.24.x 为了「不闪娃娃头」写的，hub 的版本号接管了）
//
// 为什么不用远端 hub 验：经 SSH 隧道取静态文件时，同一地址的并发请求偶发只回一半，
// 会把链路的问题算到主题头上。静态资源走本机就能分开看。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = Number(process.env.ICON_PORT || 5199)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }
const NODES = { nodes: [] }
/** 桩出来的「站长上传的那张」：32×32，与主题自带那张（96×96 的 SVG）靠 naturalWidth 分得开。 */
const HUB_ICON = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAJUlEQVR42u3OMQEAAAgDoC25k/'
  + 'A3GhC0N+QAAAAAAAAAAAAAAAAAgLcBHrQAAX0hV78AAAAASUVORK5CYII=',
  'base64',
)
const THEME_FAVICON = readFileSync('dist/favicon.svg')
const THEME_TOUCH = readFileSync('dist/apple-touch-icon.png')

/** hub 的站点图标设置（`favicon` / `touch_icon`）：空 = 没设，回落到主题自带那两份。 */
let hubIcon = null
const stamp = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 8)
/** hub 送 index.html 时会把这两个地址改写成 `?v=<内容摘要>`（`stamp_icons`）。 */
const stampIcons = (html) => html
  .replaceAll('"/favicon.svg"', `"/favicon.svg?v=${stamp(hubIcon ?? THEME_FAVICON)}"`)
  .replaceAll('"/apple-touch-icon.png"', `"/apple-touch-icon.png?v=${stamp(hubIcon ?? THEME_TOUCH)}"`)

const hits = new Map()
const resetHits = () => hits.clear()

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  if (path.startsWith('/api/')) {
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '图标验收' }
      : path === '/api/nodes' ? NODES : path.endsWith('/config') ? {} : {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  hits.set(path, (hits.get(path) ?? 0) + 1)
  // 模拟 hub 的图标路由：设了就用站长那份回答，没设就落到主题目录里的同名文件（下面那条静态分支）。
  if (hubIcon && (path === '/favicon.svg' || path === '/apple-touch-icon.png')) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' })
    return res.end(hubIcon)
  }
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] })
    return res.end(readFileSync('dist/index.html'))
  }
  const body = path === '/index.html' || path === '/' ? Buffer.from(stampIcons(readFileSync(file, 'utf8'))) : readFileSync(file)
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(body)
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${PORT}`
console.log(`dist/ 伺服在 ${BASE}/`)

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p)) || 'chrome'
let chrome, dbgPort, wsUrl = null
for (let attempt = 0; attempt < 2 && !wsUrl; attempt++) {
  dbgPort = 9910 + Math.floor(Math.random() * 80)
  chrome?.kill()
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, '--remote-allow-origins=*',
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900',
    '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/iconcheck-' + dbgPort + '-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { }
    if (!wsUrl) await sleep(300)
  }
  if (!wsUrl) console.log(`第 ${attempt + 1} 次启动 Chrome（端口 ${dbgPort}）没起来，换端口重试`)
}
if (!wsUrl) throw new Error('Chrome 起不来：先按 --user-data-dir 前缀清一遍自己堆的实例')

let id = 0
const pending = new Map()
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
const errors = []
/** 这一次导航里浏览器真的发出去的图标类请求（favicon 在 CDP 里是 Other 类型）。 */
let iconReqs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text)
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url
    if (/favicon|apple-touch/.test(u)) iconReqs.push({ url: new URL(u).pathname + new URL(u).search, type: m.params.type })
  }
}
await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }
const readState = async () => JSON.parse(await js(`JSON.stringify({
  headerIcon: (() => { const i = document.querySelector('header img'); return i ? { src: i.getAttribute('src'), w: i.naturalWidth, h: i.naturalHeight, loaded: i.complete && i.naturalWidth > 0 } : null })(),
  favicon: document.querySelector('link[rel~="icon"]')?.getAttribute('href') ?? null,
  touch: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href') ?? null,
  links: document.querySelectorAll('link[rel~="icon"]').length,
  probe: typeof window.__iconProbeConfigPromise !== 'undefined' || typeof window.__iconProbeSource !== 'undefined',
})`))

async function load({ hub }) {
  hubIcon = hub
  resetHits(); iconReqs = []
  await send('Page.navigate', { url: `${BASE}/` })
  for (let i = 0; i < 40; i++) { await sleep(250); if (await js('document.querySelectorAll("[role=button]").length > 0')) break }
  await sleep(2500)
  const s = await readState()
  s.hits = hits
  s.iconReqs = iconReqs.slice()
  s.errs = [...errors]
  console.log(`    图标请求: ${s.iconReqs.length ? s.iconReqs.map((r) => `${r.url}[${r.type}]`).join('  ') : '(无)'}`)
  console.log(`    favicon=${s.favicon}  touch=${s.touch}  页头=${JSON.stringify(s.headerIcon)}`)
  return s
}

// ── ① hub 上没设图标：兜底就是主题自带那两份 ─────────────────────────────
console.log('\n① hub 没设图标（主题自带兜底）')
let s = await load({ hub: null })
check('① 页头那枚圆标加载成功', !!s.headerIcon?.loaded, JSON.stringify(s.headerIcon))
check('① 页头那张是主题自带那份（版本号 = 主题文件的摘要，方形图，不是 ② 那份 32×32）',
  s.favicon === `/favicon.svg?v=${stamp(THEME_FAVICON)}` && s.headerIcon?.w === s.headerIcon?.h, `favicon=${s.favicon} w=${s.headerIcon?.w} h=${s.headerIcon?.h}`)
check('① 页头地址 = 标签页地址（hub 带了版本号，主题原样沿用）',
  !!s.favicon && s.headerIcon?.src === s.favicon, `页头=${s.headerIcon?.src} favicon=${s.favicon}`)
check('① 标签页图标 = /favicon.svg（带 hub 的版本号）', /^\/favicon\.svg\?v=[0-9a-f]{8}$/.test(s.favicon ?? ''), `favicon=${s.favicon}`)
check('① apple-touch-icon = /apple-touch-icon.png（带版本号）', /^\/apple-touch-icon\.png\?v=[0-9a-f]{8}$/.test(s.touch ?? ''), `touch=${s.touch}`)
check('① 只有一条 icon 地址被请求（页头与标签页共用同一个 URL，不重复取）',
  s.iconReqs.length > 0 && new Set(s.iconReqs.map((r) => r.url)).size === 1, s.iconReqs.map((r) => r.url).join(' '))
check('① 没有被抹平成不带版本号的地址', !s.iconReqs.some((r) => r.url === '/favicon.svg'), s.iconReqs.map((r) => r.url).join(' '))
check('① 页面里只有一条 <link rel="icon">', s.links === 1, `${s.links} 条`)
check('① 早跑脚本 icon-probe 已经不在页面里', s.probe === false, `probe=${s.probe}`)
check('① 控制台无异常', s.errs.length === 0, s.errs.join(' | '))

// ── ② 站长设了图标：hub 用自己那份回答，页头跟着换 ──────────────────────
console.log('\n② 站长设了站点图标（hub 那份 32×32）')
s = await load({ hub: HUB_ICON })
check('② 页头换成了 hub 那份（32×32）', s.headerIcon?.w === 32, `naturalWidth=${s.headerIcon?.w}`)
check('② 页头地址仍是标签页地址（同一个 URL，换图靠版本号）',
  !!s.favicon && s.headerIcon?.src === s.favicon, `页头=${s.headerIcon?.src} favicon=${s.favicon}`)
check('② 标签页图标仍是 /favicon.svg（内容换成 hub 那份）', /^\/favicon\.svg\?v=[0-9a-f]{8}$/.test(s.favicon ?? ''), `favicon=${s.favicon}`)
check('② 版本号跟着内容变了（换了图 = 换了 URL）', s.favicon !== ``, `favicon=${s.favicon}`)
check('② 只有一条 icon 地址被请求', new Set(s.iconReqs.map((r) => r.url)).size === 1, s.iconReqs.map((r) => r.url).join(' '))
check('② 控制台无异常', s.errs.length === 0, s.errs.join(' | '))

// ── ③ 两份兜底文件本身 ────────────────────────────────────────────────
console.log('\n③ 主题自带的兜底文件')
const svg = THEME_FAVICON.toString('utf8')
check('③ dist/favicon.svg 是一张 SVG', svg.startsWith('<svg') && svg.includes('viewBox="0 0 96 96"'), svg.slice(0, 40))
const b64 = svg.match(/href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/)?.[1]
check('③ 它内嵌了一张 PNG（浏览器标签页与页头都按位图渲染）', !!b64 && Buffer.from(b64, 'base64').subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `内嵌 ${b64 ? Buffer.from(b64, 'base64').length : 0} 字节`)
const png = THEME_TOUCH
const w = png.readUInt32BE(16); const h = png.readUInt32BE(20); const colorType = png[25]
check('③ dist/apple-touch-icon.png 是 180×180', w === 180 && h === 180, `${w}×${h}`)
check('③ 它不透明（iOS 会把透明的填黑）', colorType === 2 || colorType === 3, `colorType=${colorType}`)
check('③ dist/favicon.ico 是真的 ICO（老客户端不看 <link> 直接来要这条）', readFileSync('dist/favicon.ico').subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])), `${readFileSync('dist/favicon.ico').length} 字节`)
check('③ 早跑脚本已删干净（文件不在 dist/ 里）', !existsSync('dist/icon-probe.js'))
const html = readFileSync('dist/index.html', 'utf8')
check('③ 构建产物里静态引用的是 hub 认的那两条路径', html.includes('href="/favicon.svg"') && html.includes('href="/apple-touch-icon.png"'), '')
check('③ 构建产物里没有 icon-probe.js 的引用', !html.includes('icon-probe.js'))

console.log(`\n结果: PASS ${pass} / FAIL ${fail}`)
ws.close(); chrome.kill(); server.close()
process.exit(fail ? 1 : 0)

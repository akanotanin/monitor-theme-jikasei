// hub 1.4.1 的主题侧适配验收（release note「第三方主题请适配」里与本站有关的三条）：
//
//   A. **浏览器禁用站点数据**（`localStorage` 访问抛 SecurityError）时页面必须照常渲染 ——
//      官方两个主题在 1.4.1 随附版里修的「整页空白」就是这个。夹具在页面任何脚本之前
//      把 `window.localStorage` 换成一枚会抛异常的 getter（并自证机制真的生效了）。
//   B. **匿名 `/api/ws` 握手回 503**（满 1000 条时 hub 的形态）：主题必须有轮询 `/api/nodes`
//      的兜底、并隔一段时间再试 WS —— 只做断线重连、没有轮询的主题会停在旧数据上。
//   C. **`/api/nodes/{id}/metrics` 每行新增 `swap_used`/`tcp`/`udp`/`procs`**：行里多出这几个
//      字段不许让详情页出错（判空由用到的主题负责；本站现在不用它们，这里锁的是「不认识也不崩」）。
//
// 反向自测底账：拿修复前的构建跑，A 组必须红（实测 2 FAIL：卡片 0 张 + 控制台 SecurityError）。
//
// 用法：node tools/verify_hub141.mjs [截图目录=shots/hub141]
//   先 `npm run build` —— 验的是 dist/，不是源码。
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

const OUT = process.argv[2] || 'shots/hub141'
mkdirSync(OUT, { recursive: true })
const PORT = 5223
const CDP_PORT = 29623
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.md': 'text/markdown' }

/* ------------------------------------------------------------------ 夹具（3 台，含 1 台离线） */
const mk = (id, name, country, online = true) => ({
  id, name, sort: id, public: true, online, country, group: '', last_seen: Math.floor(Date.now() / 1000),
  last_seen_ago: online ? 0 : 120,
  metrics: online ? { cpu: 20 + id, mem_used: 1073741824, mem_total: 2147483648, disk_used: 10737418240, disk_total: 42949672960, net_rx: 1024, net_tx: 2048, load: [0.1, 0.2, 0.3], uptime: 86400, procs: 100, tcp: 50, udp: 10 } : null,
  os: 'Debian', kernel: '6.1.0', arch: 'x86_64', virt: '', cpu_name: '', cpu_cores: 1,
  mem_total: 2147483648, swap_total: 1073741824, disk_total: 42949672960, agent_version: '1.2.1', price: 0, currency: 'CNY',
  billing_cycle: '', expires_at: null, traffic_limit: 0, traffic_mode: '', traffic_reset_day: 1,
  total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0, month_start: '', day_rx: 0, day_tx: 0,
})
const FLEET = [mk(1, '东京 01', 'JP'), mk(2, '法兰克福 01', 'DE'), mk(3, '马尼拉 01', 'PH', false)]

// 历史指标：照 1.4.1 的新形状（每行多 swap_used/tcp/udp/procs）。
const now = Math.floor(Date.now() / 1000)
const METRICS_ROWS = Array.from({ length: 30 }, (_, i) => ({
  ts: now - (30 - i) * 60, cpu: 20 + (i % 5), mem_used: 1073741824, disk_used: 10737418240,
  net_rx: 1024, net_tx: 2048, swap_used: 104857600, tcp: 40 + (i % 10), udp: 8, procs: 90 + i,
}))

/* ------------------------------------------------------------------ 桩服务器（含 WS 503 / 101 两种模式） */
const stats = { nodes: 0, upgrades: 0, metrics: 0 }
let wsMode = 'refuse' // 'refuse' = 握手回 503（B 组）；'accept' = 正常 101（A 组）
const server = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  if (path.startsWith('/api/')) {
    if (path === '/api/nodes') stats.nodes += 1
    if (/^\/api\/nodes\/\d+\/metrics$/.test(path)) stats.metrics += 1
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '适配验收', history_days: 30 }
      : path === '/api/nodes' ? { nodes: FLEET }
      : /^\/api\/nodes\/\d+\/metrics$/.test(path) ? { metrics: METRICS_ROWS, ping: [], probes: {}, loss: {}, step: 60 }
      : path.endsWith('/config') ? {}
      : {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\\.\\.[/\\\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) return sendHtml(res)
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
})
const sendHtml = (res) => { res.writeHead(200, { 'Content-Type': TYPES['.html'] }); res.end(readFileSync('dist/index.html')) }
// WS：'refuse' 回 503；'accept' 做最小 101 握手（此后不推任何帧，轮询兜底照常工作）。
server.on('upgrade', (req, socket) => {
  stats.upgrades += 1
  if (wsMode === 'refuse') {
    socket.write('HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\nconnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  const key = req.headers['sec-websocket-key'] || ''
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`)
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p)) || 'chrome'
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*', '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--no-proxy-server', `--user-data-dir=${join(tmpdir(), `hub141${CDP_PORT}`)}`, '--no-sandbox', 'about:blank'], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { /* 等它起来 */ }
  if (!wsUrl) await sleep(250)
}
if (!wsUrl) throw new Error('Chrome 没起来')
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
let id = 0, errors = []
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description ?? 'exception')
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args?.map((a) => a.value).join(' '))
}
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }
const waitFor = async (expr, ms = 20000) => {
  for (let i = 0; i < Math.ceil(ms / 150); i++) { if (await js(expr)) return true; await sleep(150) }
  return false
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  if (r.result?.data) writeFileSync(join(OUT, name), Buffer.from(r.result.data, 'base64'))
}
const cards = () => js(`document.querySelectorAll('[data-slot=card], article, .node-card').length`)

/* ---------------------------------------------------------------- A. 禁用站点数据：页面不许白屏 */
console.log('=== A、浏览器禁用站点数据（localStorage 抛 SecurityError）：页面照常渲染 ===')
wsMode = 'accept'
const BLOCK = `(() => {
  try {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('The operation is insecure.', 'SecurityError') },
    })
  } catch (e) { window.__storageBlockFailed = String(e) }
})()`
const blockId = (await send('Page.addScriptToEvaluateOnNewDocument', { source: BLOCK })).result?.identifier
let errBase = 0
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
const blocked = await js(`(() => {
  const mechanism = (() => { try { localStorage; return 'no-throw' } catch { return 'throws' } })()
  return JSON.stringify({ failed: window.__storageBlockFailed ?? null, mechanism })
})()`)
const bl = JSON.parse(blocked ?? '{}')
check('机制自检：localStorage 访问真的会抛（桩真的生效了）', bl.failed === null && bl.mechanism === 'throws', JSON.stringify(bl))
await waitFor(`document.querySelector('#root') && document.querySelector('#root').children.length > 0`, 12000)
await sleep(800)
const n = await cards()
check('★ 页面照常渲染（卡片 ≥ 3 张，不是空白页）', n >= 3, `卡片 ${n} 张`)
check('★ 顶栏在（页面没有整页卸载）', await js(`!!document.querySelector('header')`))
// 存储被禁时，会话内照样能切深浅色（只是记不住）。★ 点击后要等一拍：class 是 effect 里换的。
const beforeDark = await js(`document.documentElement.classList.contains('dark')`)
const clicked = await js(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => /切换主题/.test(b.getAttribute('title') || b.getAttribute('aria-label') || ''))
  if (!btn) return 'no-button'
  btn.click()
  return 'clicked'
})()`)
await sleep(300)
const afterDark = await js(`document.documentElement.classList.contains('dark')`)
check('★ 禁用存储时深浅色仍能切（这次会话内生效）', clicked === 'clicked' && afterDark !== beforeDark, `${clicked} / ${beforeDark} → ${afterDark}`)
check('A 组控制台无异常', errors.length === errBase, errors.slice(errBase).join(' | ').slice(0, 200))
errBase = errors.length
await shot('storage-disabled.png')

/* ---------------------------------------------------------------- B. WS 503：轮询兜底 + 隔段时间再试 */
console.log('\n=== B、/api/ws 握手回 503：轮询兜底继续、WS 隔一会儿重试 ===')
await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: blockId })
wsMode = 'refuse'
const before = { nodes: stats.nodes, upgrades: stats.upgrades }
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await waitFor(`document.querySelector('#root') && document.querySelector('#root').children.length > 0`, 12000)
await sleep(12000) // 覆盖两轮 5 秒：轮询 ≥2 次、WS 重试 ≥2 次
const dNodes = stats.nodes - before.nodes
const dUp = stats.upgrades - before.upgrades
check('★ WS 被拒后轮询继续在拉 /api/nodes（≥2 次）', dNodes >= 2, `窗口内 ${dNodes} 次`)
check('★ WS 隔一会儿会再试（≥2 次握手，含首次）', dUp >= 2, `窗口内 ${dUp} 次`)
check('★ 数据照常显示（卡片 ≥ 3 张）', (await cards()) >= 3, `卡片 ${await cards()} 张`)
check('B 组控制台无异常', errors.length === errBase, errors.slice(errBase).join(' | ').slice(0, 200))
errBase = errors.length

/* ---------------------------------------------------------------- C. metrics 新字段：不认识的字段不许崩 */
console.log('\n=== C、/api/nodes/{id}/metrics 行里多 swap_used/tcp/udp/procs：详情页照常画图 ===')
const mBefore = stats.metrics
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/node/1` })
await waitFor(`document.querySelectorAll('[data-chart], .chart').length > 0 || document.body.innerText.length > 200`, 15000)
await sleep(1200)
const charts = await js(`document.querySelectorAll('[data-chart]').length`)
check('★ 详情页取到了指标（服务端计数 ≥1）', stats.metrics - mBefore >= 1, `窗口内 ${stats.metrics - mBefore} 次`)
check('★ 详情页画出了图表（[data-chart] ≥ 1）', charts >= 1, `图表 ${charts} 个`)
check('★ 页面没有因为多出的字段报错', !errors.some((e) => /swap_used|procs/.test(e)), errors.join(' | ').slice(0, 200))
check('C 组控制台无异常', errors.length === errBase, errors.slice(errBase).join(' | ').slice(0, 200))
await shot('detail.png')

console.log(`\n${pass} PASS / ${fail} FAIL`)
chrome.kill()
server.close()
process.exit(fail ? 1 : 0)

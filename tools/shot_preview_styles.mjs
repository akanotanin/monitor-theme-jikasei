// 拍 README 画廊里那五张「卡片形态」预览图（preview-plain / -classic / -latency / -detailed / -compact）。
// 面板缩略图是 preview.png（tools/preview-cover.mjs 生成），地球与手机那几张是 tools/shot_preview_set.mjs。
//
// 用法：node tools/shot_preview_styles.mjs [nodes.json=tools/globe-nodes-fixture.json] [输出目录=.]
//
// 为什么要有这一份：
//   1. 公开仓库里的预览图**不能带真实机器名/IP/服务商名** —— 一律用仓库自带的
//      tools/globe-nodes-fixture.json 那套中性演示数据（Demo Node <城市>）。
//   2. 只桩 /api/* 的伺服会让页面顶部挂「实时连接中断」的提示条，而且它自己会消失 ——
//      同一份代码早晚两张图，一张干净一张带条。所以这里做**最小 WebSocket 握手**（不推数据）。
//   3. 五档必须**同数据、同视口、同机位**，只差卡片形态那一处；视口高度按量出来的内容高度定，
//      不猜坐标（不然底部会多出一大片空白，或把最后一行卡片裁断）。
//   4. 站点配置**由伺服自己回答**（每一档换一次），不碰站长存在 hub 里的那份配置。
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const NODES_PATH = process.argv[2] || 'tools/globe-nodes-fixture.json'
const OUTDIR = (process.argv[3] || '.').replace(/\/$/, '')
const PORT = 5213
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }
const NODES = JSON.parse(readFileSync(NODES_PATH, 'utf8'))
/** 每一档换一次；`listTop: 'none'` 与 `globeOn: false` 照旧图的口径（画廊只讲卡片本身）。 */
let CONFIG = { listTop: 'none', globeOn: false, cardStyle: 'detailed', remarkPlacement: 'both', pingLines: '', themeMode: 'system' }
let configHits = 0

/**
 * 三网延迟的桩数据：**必须给**，否则「延迟 / 详细」两档的卡片会少掉下面那三行（实测卡片矮 300px，
 * 与旧图一比就是「这一档怎么变短了」）。三条线路、60 个点、60 秒一步，数值是中性演示值。
 */
const pingPayload = (id) => {
  const now = Math.floor(Date.now() / 1000)
  const ping = []
  for (const [task, base] of [[1, 62], [2, 92], [3, 121]]) {
    for (let i = 59; i >= 0; i--) {
      const jitter = ((i * 7 + task * 13 + id * 5) % 17) - 8
      ping.push({ ts: now - i * 60, task_id: task, latency: Math.max(8, base + jitter) })
    }
  }
  return { metrics: [], ping, step: 60, probes: { 1: '电信', 2: '联通', 3: '移动' }, loss: {} }
}

const server = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  // 最小 WebSocket 握手：不推数据，但让页面认为连上了（否则顶部会挂重连提示条）
  if (path === '/api/ws' && (req.headers.upgrade || '').toLowerCase() === 'websocket') {
    const key = req.headers['sec-websocket-key'] || ''
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    res.writeHead(101, { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Accept': accept })
    const keep = setInterval(() => res.socket.write(Buffer.from([0x89, 0x00])), 5000)
    req.socket.on('close', () => clearInterval(keep))
    return
  }
  if (path.startsWith('/api/')) {
    if (path.includes('/config')) configHits += 1
    const body = path === '/api/me'
      ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: 'Monitor', history_days: 30 }
      : path === '/api/nodes' ? NODES
        : path.includes('/config') ? CONFIG
          : path.includes('/metrics') ? pingPayload(Number((path.match(/nodes\/(\d+)/) || [])[1] || 1))
            : { nodes: [] }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(body))
  }
  if (path.startsWith('/chicken/')) { res.writeHead(404); return res.end('no') }
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.[/\\])+/, ''))
  if (!existsSync(file)) { res.writeHead(200, { 'Content-Type': TYPES['.html'] }); return res.end(readFileSync('dist/index.html')) }
  res.writeHead(200, { 'Content-Type': TYPES[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream' })
  res.end(readFileSync(file))
})
await new Promise((r) => server.listen(PORT, r))

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p)) || 'chrome'
const dbg = 9971 + Math.floor(Math.random() * 9)
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, '--remote-allow-origins=*', '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--window-size=1440,900', '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/shotstyles-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { } ; if (!wsUrl) await sleep(300) }
if (!wsUrl) throw new Error('Chrome 起不来')
let id = 0; const pend = new Map(); const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
const errs = []
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.text) }
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const js = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true }); if (r.result?.exceptionDetails) console.log('JS 异常:', r.result.exceptionDetails.text, String(r.result.exceptionDetails.exception?.description || '').split(String.fromCharCode(10))[0]); if (r.result?.result?.value === undefined) console.log('DEBUG 表达式无值:', JSON.stringify(r).slice(0, 400)); return r.result?.result?.value }
await send('Runtime.enable'); await send('Page.enable')

// 数据是轮询来的、卡片有 500ms 的进度条过渡：等「卡片 ≥2 + 字体就绪 + 条已有宽度」再拍。
// ★ 判据里不要带 `%` —— 百分比是卡片的正常内容，带上就永远等不到。
const SETTLED = `(() => {
  const cards = document.querySelectorAll('[data-slot="card"]');
  if (cards.length < 2 && document.querySelectorAll('main table tbody tr').length < 2) return false;
  if (!document.fonts || document.fonts.status !== 'loaded') return false;
  const bars = [...document.querySelectorAll('div.overflow-hidden.rounded-full > div')];
  if (!bars.some((b) => b.getBoundingClientRect().width > 2)) return false;
  return true;
})()`

const STYLES = ['plain', 'classic', 'latency', 'detailed', 'compact']
for (const style of STYLES) {
  CONFIG = { ...CONFIG, cardStyle: style }
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  let ok = false
  for (let i = 0; i < 80; i++) { await sleep(300); if (await js(SETTLED)) { ok = true; break } }
  await sleep(1200)
  const facts = JSON.parse(await js(`JSON.stringify({
    style: document.querySelector('[data-card-style]')?.getAttribute('data-card-style') ?? null,
    cards: document.querySelectorAll('[data-slot="card"]').length,
    rows: document.querySelectorAll('main table tbody tr').length,
    // 内容高度取 main 的下沿（不含页脚）——body 有 min-h-svh，量 body 会永远得到视口高
    mainBottom: Math.ceil(document.querySelector('main').getBoundingClientRect().bottom + scrollY),
    // 内容下沿：最后一张卡片 / 表格的下沿（main 有 flex-1，短页面会被撑到视口高）
    contentBottom: Math.ceil(Math.max(
      ...[...document.querySelectorAll('[data-slot="card"]')].map((c) => c.getBoundingClientRect().bottom),
      ...[...document.querySelectorAll('main table')].map((t) => t.getBoundingClientRect().bottom),
      document.querySelector('main h1, main h2, main p')?.getBoundingClientRect().bottom ?? 0,
    ) + scrollY),
    fill: (() => {
      const bars = [...document.querySelectorAll('div.overflow-hidden.rounded-full > div')]
      const b = bars.sort((a, c) => c.getBoundingClientRect().width - a.getBoundingClientRect().width)[0]
      if (!b) return null
      const host = b.closest('[data-slot="card"]') || document.body
      const c = document.createElement('canvas'); c.width = c.height = 1; const x = c.getContext('2d')
      x.fillStyle = getComputedStyle(host).backgroundColor; x.fillRect(0, 0, 1, 1)
      x.fillStyle = getComputedStyle(b).backgroundColor; x.fillRect(0, 0, 1, 1)
      const d = x.getImageData(0, 0, 1, 1).data
      return 'rgb(' + d[0] + ',' + d[1] + ',' + d[2] + ')'
    })(),
  })`))
  const H = Math.max(Math.min(facts.contentBottom + 40, 4000), 400)
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: H, deviceScaleFactor: 2, mobile: false })
  await sleep(500)
  const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1440, height: H, scale: 1 }, captureBeyondViewport: true })
  const out = join(OUTDIR, `preview-${style}.png`)
  writeFileSync(out, Buffer.from(r.result.data, 'base64'))
  const bytes = Buffer.from(r.result.data, 'base64').length
  console.log(`${style.padEnd(9)} 卡片 ${String(facts.cards).padStart(2)}／表行 ${String(facts.rows).padStart(2)} ｜ data-card-style=${String(facts.style).padEnd(9)} ｜ 1440×${H}（内容下沿 ${facts.contentBottom}）@2x ｜ ${(bytes / 1024).toFixed(0)}KB ｜ 最满那根条的填色 ${facts.fill} ｜ 桩命中 ${configHits} ｜ ${ok ? '就绪' : '⚠ 等超时'}`)
}
console.log('控制台异常:', errs.length ? errs.join(' | ') : '无')
ws.close(); chrome.kill(); server.close()

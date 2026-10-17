// 暗色「面」的实测：页面底 / 卡片底 / 卡片描边（均为合成后的**有效色**）与两两对比度，
// 并附同机位截图（列表 1440 暗、390 暗）与卡片边缘 2× 特写 —— 给「背景和卡片要更容易区分」
// 这类暗色调值任务取证用：先试样、再定稿。
//
// 用法：node tools/probe_dark_surface.mjs <outDir> [cardL] [borderAlpha]
//   node tools/probe_dark_surface.mjs shots/dark-surface/before
//   node tools/probe_dark_surface.mjs shots/dark-surface/c23 0.23 15
// 两个可选覆盖值以**注入样式**的方式生效（token 同名、文档里更靠后 → 同选择器下后者胜），
// 与改源码后的效果一致，因此可以不改源码先试样。
// 自起桩伺服（与 shot_preview_set 同款的最小 WS 握手 + 中性夹具：别让「重连中」横幅进截图）；跑前先 npm run build。
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

const OUT = process.argv[2] || 'shots/dark-surface'
const CARD_L = process.argv[3] || ''
const BORDER_A = process.argv[4] || ''
mkdirSync(OUT, { recursive: true })

const PORT = Number(process.env.SURF_PORT || 5184)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2' }
const NODES = JSON.parse(readFileSync('tools/globe-nodes-fixture.json', 'utf8'))
const CONFIG = { listTop: 'bothBudget', cardStyle: 'detailed', remarkPlacement: 'both', pingLines: '', globeOn: true, themeMode: 'system' }

const server = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  // 最小 WebSocket 握手：不推数据，但让页面认为连上了（否则顶部会挂重连提示条、混进截图）。
  if (path === '/api/ws' && (req.headers.upgrade || '').toLowerCase() === 'websocket') {
    const key = req.headers['sec-websocket-key'] || ''
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    res.writeHead(101, { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Accept': accept })
    const keep = setInterval(() => res.socket.write(Buffer.from([0x89, 0x00])), 5000)
    req.socket.on('close', () => clearInterval(keep))
    return
  }
  if (path.startsWith('/api/')) {
    const body = path === '/api/me'
      ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: 'probe', history_days: 30 }
      : path === '/api/nodes' ? NODES
        : path.includes('/config') ? CONFIG
          : { nodes: [] }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.[/\\])+/, ''))
  if (!existsSync(file)) { res.writeHead(200, { 'Content-Type': TYPES['.html'] }); return res.end(readFileSync('dist/index.html')) }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
console.log(`桩服务在 ${PORT}（tools/globe-nodes-fixture.json）`)

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p)) || 'chrome'
const dbg = 9740 + Math.floor(Math.random() * 20)
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, '--remote-allow-origins=*', '--no-first-run',
  '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900', `--user-data-dir=${join(tmpdir(), 'jksurf-' + dbg)}`, 'about:blank'], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 100 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { /* 等它起 */ }
  if (!wsUrl) await sleep(300)
}
if (!wsUrl) { chrome.kill(); server.close(); throw new Error('Chrome 起不来') }
let id = 0
const pending = new Map()
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const js = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) console.error('页面探测抛异常：', (r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails)).slice(0, 600))
  return r.result?.result?.value
}
await send('Runtime.enable'); await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

// 先落地一次拿到同源（about:blank 上读 localStorage 会被拒），再写访客偏好、重载。
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(800)
await js("localStorage.setItem('theme','dark')")
await send('Page.reload')
for (let i = 0; i < 60; i++) { await sleep(250); if (await js('!!document.querySelector("main [data-node-card]")')) break }
await js('document.fonts.ready')
await sleep(1500)

// 试样：注入覆盖样式（改源码前的预演）；样式在文档里更靠后 → 同选择器下压过主题那份。
if (CARD_L || BORDER_A) {
  const decl = [
    CARD_L ? `--card: oklch(${CARD_L} 0.004 85); --popover: oklch(${CARD_L} 0.004 85); --primary-foreground: oklch(${CARD_L} 0.004 85);` : '',
    BORDER_A ? `--border: oklch(0.885 0.012 85 / ${BORDER_A}%);` : '',
  ].join('')
  await js(`(() => { const s = document.createElement('style'); s.textContent = '.dark { ' + ${JSON.stringify(decl)} + ' }'; document.head.appendChild(s) })()`)
  await sleep(400)
}

const dump = JSON.parse(await js(`(() => {
  const paint = (under, top) => {
    const c = document.createElement('canvas'); c.width = c.height = 1; const x = c.getContext('2d')
    if (under) { x.fillStyle = under; x.fillRect(0, 0, 1, 1) }
    x.fillStyle = top; x.fillRect(0, 0, 1, 1)
    const d = x.getImageData(0, 0, 1, 1).data
    return (d[3] < 255 ? 'rgba(' : 'rgb(') + d[0] + ',' + d[1] + ',' + d[2] + (d[3] < 255 ? ',' + (d[3] / 255).toFixed(3) : '') + ')'
  }
  const rgbOnly = (s) => { const i = s.indexOf('('); const seg = s.slice(i + 1, s.indexOf(')')); const p = seg.split(',').map(Number); return 'rgb(' + p[0] + ',' + p[1] + ',' + p[2] + ')' }
  const cs = getComputedStyle(document.body)
  const bodyBg = cs.backgroundColor
  const card = document.querySelector('main [data-node-card]')
  const cardBg = getComputedStyle(card).backgroundColor
  const cardEff = rgbOnly(paint(bodyBg, cardBg))
  const borderRaw = getComputedStyle(card).borderTopColor
  const lineEff = rgbOnly(paint(cardEff, borderRaw))
  const fgEff = rgbOnly(paint(cardEff, cs.color))
  const r = card.getBoundingClientRect()
  return JSON.stringify({
    raw: { bodyBg, cardBg, borderRaw },
    eff: { bodyBg: rgbOnly(paint(null, bodyBg)), card: cardEff, line: lineEff, fg: fgEff },
    cardRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    dark: document.documentElement.classList.contains('dark'),
  })
})()`))

const lum = (s) => { const [r, g, b] = s.slice(s.indexOf('(') + 1, s.indexOf(')')).split(',').slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return +((x + 0.05) / (y + 0.05)).toFixed(3) }
const e = dump.eff
console.log(`dark=${dump.dark}  覆盖：cardL=${CARD_L || '（源码原值）'} borderAlpha=${BORDER_A || '（源码原值）'}`)
console.log(`  页面底 ${e.bodyBg}  卡片底 ${e.card}  描边线 ${e.line}`)
console.log(`  对比度：卡片/底 ${contrast(e.card, e.bodyBg)}  描边线/底 ${contrast(e.line, e.bodyBg)}  描边线/卡片 ${contrast(e.line, e.card)}  正文/卡片 ${contrast(e.fg, e.card)}`)

const shot = async (name, w, h, mobile) => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile })
  await sleep(900)
  const res = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  writeFileSync(join(OUT, name), Buffer.from(res.result.data, 'base64'))
}
await shot('list-1440.png', 1440, 900, false)
// 卡片左上角 2× 特写：底/卡/描边同框，给「肉眼可见」的对照证据。
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await sleep(500)
const r = dump.cardRect
const clip = { x: Math.max(0, r.x - 40), y: Math.max(0, r.y - 40), width: 340, height: 220, scale: 2 }
const res2 = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip })
writeFileSync(join(OUT, 'corner-2x.png'), Buffer.from(res2.result.data, 'base64'))
await shot('list-390.png', 390, 844, true)
console.log(`截图 → ${OUT}/list-1440.png / corner-2x.png / list-390.png`)

ws.close(); chrome.kill(); server.close()

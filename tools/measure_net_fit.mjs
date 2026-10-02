// 只做量测：概览卡片里「今日流量 / 实时网速」那行两列数字，在哪些视口宽度下会被截断、截多少。
// 用法：cd <repo> && node tools/measure_net_fit.mjs
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 5401
const CDP_PORT = PORT + 4000
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
}
const GB = 1024 ** 3
const KB = 1024

const metrics = (over) => ({
  uptime: 400000, cpu: 5, load: [0.1, 0.2, 0.3], mem_total: 2 * GB, mem_used: 1 * GB,
  swap_total: 0, swap_used: 0, disk_total: 40 * GB, disk_used: 10 * GB,
  net_rx: 0, net_tx: 0, total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0,
  tcp: 10, udp: 2, procs: 100, ...over,
})
const node = (id, name, over) => ({
  id, name, sort: id, public: true, online: true, country: '', group: '',
  last_seen: Math.floor(Date.now() / 1000) - 5, metrics: metrics({}),
  os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'EPYC',
  cpu_cores: 2, mem_total: 2 * GB, swap_total: 0, disk_total: 40 * GB,
  agent_version: '1.4.0', price: 0, currency: 'CNY', billing_cycle: 'monthly', expires_at: null,
  expires_in: null, traffic_limit: 0, traffic_mode: 'sum', traffic_reset_day: 1,
  total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0, month_start: '', day_rx: 0, day_tx: 0,
  ...over,
})

// 用户截图里那份读数：↓62.2 KB/s ↑112.6 KB/s
const REAL = { nodes: [node(1, '东京', { metrics: metrics({ cpu: 12.5, net_rx: 62.2 * KB, net_tx: 112.6 * KB }), day_rx: 1.25 * GB, day_tx: 0.75 * GB })] }
// 最坏形状：KB 档四位数（bytes(n,1) 的天花板 = 1023.9 KB/s）
const WORST = { nodes: [node(1, '东京', { metrics: metrics({ cpu: 12.5, net_rx: 1023.9 * KB, net_tx: 1023.9 * KB }) })] }

// ③ 上行的常见放大形状：MB 档（9.9 MB/s 与 1023.9 MB/s）
const MB_ROW = { nodes: [node(1, '东京', { metrics: metrics({ cpu: 12.5, net_rx: 9.9 * 1024 * KB, net_tx: 1023.9 * 1024 * KB }) })] }

const FIXTURES = { real: REAL, worst: WORST, mb: MB_ROW }
let fixture = 'real'

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  const json = (body) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)) }
  if (path === '/__fixture') { fixture = url.searchParams.get('name') || 'real'; return json({ fixture }) }
  if (path.startsWith('/api/')) {
    if (path === '/api/me') return json({ authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '量测' })
    if (path === '/api/nodes') return json(FIXTURES[fixture])
    if (path.endsWith('/config')) return json({ listTop: 'summary' })
    if (/^\/api\/nodes\/\d+\/metrics/.test(path)) return json({ ping: [], probes: {}, loss: {} })
    return json({})
  }
  const file = path === '/' ? '/index.html' : path
  const full = join('dist', normalize(file).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(full) || statSync(full).isDirectory()) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] })
    return res.end(readFileSync('dist/index.html'))
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(full)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(full))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p)) || 'chrome'
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--no-proxy-server', `--user-data-dir=${process.env.LOCALAPPDATA || '/tmp'}/Temp/measure${CDP_PORT}`,
  'about:blank',
], { stdio: 'ignore' })

let id = 0
const pending = new Map()
let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl
  } catch { /* 等 Chrome */ }
  if (!wsUrl) await sleep(250)
}
if (!wsUrl) throw new Error('Chrome 没起来')
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value

await send('Runtime.enable')
await send('Page.enable')

// 卡片里那几块读数 = 卡片的直接子元素；两块并排的那一行是「grid + 恰好两个子元素」，
// 单块读数卡片的第二行（如「/ 1」那个 span）不是栅格，必须排除掉。
const PROBE = 'JSON.stringify((() => {' +
  'const TITLES=["节点","最忙节点","今日流量","实时网速"];' +
  'const title=(c)=>{const t=c.firstElementChild&&c.firstElementChild.firstElementChild;return ((t&&t.textContent)||"").trim()};' +
  'const out=[...document.querySelectorAll("[data-slot=card]")].filter(c=>TITLES.includes(title(c))).map(c=>{' +
  '  const b=c.children[0];const row=b.children[1];const cr=c.getBoundingClientRect();' +
  '  const isGrid=!!row&&getComputedStyle(row).display==="grid"&&row.children.length===2;' +
  '  const cells=!isGrid?null:[...row.children].map(v=>{const t=v.querySelector(".truncate")||v;' +
  '    return {text:t.innerText.trim(), cell:v.clientWidth, need:t.scrollWidth, clip:t.scrollWidth-t.clientWidth,' +
  '      icon:v.querySelector("svg")?Math.round(v.querySelector("svg").getBoundingClientRect().width):0};});' +
  '  return {title:title(c),cardW:Math.round(cr.width),pad:Math.round(b.getBoundingClientRect().left-cr.left),' +
  '    rowW:Math.round(row.getBoundingClientRect().width),rowGap:getComputedStyle(row).columnGap,fs:getComputedStyle(row).fontSize,cells:isGrid?cells:null};' +
  '});' +
  'return {cards:out};' +
'})())'

const VIEWPORTS = [390, 430, 640, 768, 860, 900, 1000, 1024, 1100, 1280, 1366, 1440, 1600, 1920]

async function render(width, fixtureName) {
  await fetch(`http://127.0.0.1:${PORT}/__fixture?name=${fixtureName}`)
  await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?w=${width}&f=${fixtureName}&t=${Date.now()}` })
  for (let i = 0; i < 80; i++) {
    await sleep(200)
    const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) throw new Error(`探针报错：${JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)}`)
    const raw = r.result?.result?.value
    if (!raw) continue
    const dom = JSON.parse(raw)
    const net = dom.cards.find((c) => c.title === '实时网速')
    const day = dom.cards.find((c) => c.title === '今日流量')
    if (net?.cells?.length === 2 && day?.cells?.length === 2 && net.cells.every((c) => c.text)) return dom
  }
  const diag = await js('JSON.stringify({title:document.title, ready:document.readyState, cards:document.querySelectorAll("[data-slot=card]").length, body:(document.body.innerText||"").slice(0,120)})')
  throw new Error(`视口 ${width} 页面没起来 — ${diag}`)
}

const fmtCell = (c) => `${c.text}［格${c.cell}／需${c.need}${c.clip > 0 ? `／截掉${c.clip}` : ''}］`

for (const fixtureName of ['real', 'worst', 'mb']) {
  const f = FIXTURES[fixtureName].nodes[0].metrics
  console.log(`\n=== 夹具 ${fixtureName}（下行 ${f.net_rx / KB} KB/s ／ 上行 ${f.net_tx / KB} KB/s）===`)
  for (const w of VIEWPORTS) {
    const dom = await render(w, fixtureName)
    const net = dom.cards.find((c) => c.title === '实时网速')
    const day = dom.cards.find((c) => c.title === '今日流量')
    console.log(
      `w=${String(w).padStart(4)} 卡${String(net.cardW).padStart(4)}px 行${String(net.rowW).padStart(4)}px 间距${net.rowGap} 字号${net.fs}  ` +
      `网速 ${net.cells.map(fmtCell).join('  ')}   流量 ${day.cells.map(fmtCell).join('  ')}`)
  }
}

ws.close()
chrome.kill()
server.close()

// 把地球那张 SVG **原样**（把计算样式内联进去）栅格化成 PNG：不依赖 Page.captureScreenshot
// 的 clip（实测它的坐标语义会飘：要 361px 的圆盘，拿到的是 480px 一块、还带着下面的卡片）。
// 做法是浏览器侧自己来：克隆 SVG → 逐元素把 getComputedStyle 的内联样式写上去 → 序列化成
// 独立 SVG → 画进 canvas → toDataURL。于是要哪一块（整张画布 / 只要圆盘）、放大几倍都精确可控。
//
// 用法：node tools/shot_globe_svg.mjs [角度数] [倍率] [full|disk|both]
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join, extname, normalize } from 'node:path'
import { regionRows, VIEW } from '../src/lib/globe.ts'

const PORT = 5482
const OUT = 'shots/globe-svg'
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CITIES = [
  ['东京一号', 'JP', '东京'], ['法兰克福一号', 'DE', '欧洲'], ['圣保罗一号', 'BR', '南美'],
  ['悉尼一号', 'AU', '亚太'], ['纽约一号', 'US', '纽约'], ['新加坡一号', 'SG', '新加坡'],
  ['孟买一号', 'IN', '孟买'], ['开普敦一号', 'ZA', '非洲'], ['伦敦一号', 'GB', '伦敦'],
  ['多伦多一号', 'CA', '多伦多'], ['迪拜一号', 'AE', '迪拜'], ['圣地亚哥一号', 'CL', '智利'],
]
const mk = (id, name, country, group) => ({
  id, name, country, group, os: 'Debian GNU/Linux 12', sort: id, online: true, public: true, country_pin: '',
  last_seen: 1790311292, kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'x', cpu_cores: 2, mem_total: 1, swap_total: 0,
  disk_total: 1, traffic_limit: 1, traffic_mode: 'sum', billing_cycle: 'monthly', currency: 'CNY', price: 1,
  expires_at: '2027-07-21', expires_in: 1, month_start: '2026-09-21', traffic_reset_day: 21,
  day_rx: 1, day_tx: 1, month_rx: 1, month_tx: 1, total_rx: 1, total_tx: 1,
  metrics: { cpu: 5, load: [0, 0, 0], mem_used: 1, mem_total: 1, swap_used: 0, swap_total: 0, disk_used: 1, disk_total: 1, net_rx: 1, net_tx: 1, procs: 1, tcp: 1, udp: 1, uptime: 1, month_rx: 1, month_tx: 1, total_rx: 1, total_tx: 1 },
})
const NODES = { nodes: CITIES.map(([name, cc, group], i) => mk(i + 1, name, cc, group)) }
const ROWS = regionRows(NODES.nodes)

const serveFile = (res, path) => {
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(200, { 'Content-Type': TYPES['.html'] }); return res.end(readFileSync('dist/index.html')) }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
}
const server = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  if (path.startsWith('/api/')) {
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '地球裁定' }
      : path === '/api/nodes' ? NODES : path.endsWith('/config') ? { listTop: 'none', cardStyle: 'compact' } : { metrics: [], ping: [], probes: {}, loss: {} }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  serveFile(res, path)
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p))
const dbgPort = 9950 + Math.floor(Math.random() * 9)
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, '--remote-allow-origins=*', '--no-first-run',
  '--disable-gpu', '--hide-scrollbars', '--window-size=1500,1400',
  '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/globesvg-' + dbgPort + '-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 120 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { }
  if (!wsUrl) await sleep(250)
}
let id = 0
const pending = new Map()
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1400, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(3200)

/**
 * 页面侧：克隆地球那张 svg，把每个元素的计算样式内联进去，再按指定 viewBox/尺寸栅格化。
 * `box` 为 null = 用 SVG 自己的 viewBox。
 */
const RASTER = (box, scale, dark) => `(async () => {
  const svg = document.querySelector('.globe-atlas svg')
  if (!svg) return null
  const PROPS = ['fill','fill-opacity','fill-rule','stroke','stroke-width','stroke-opacity','stroke-linecap','stroke-linejoin','stroke-dasharray','opacity','color','font-family','font-size','font-weight','letter-spacing','paint-order','stop-color','stop-opacity','text-anchor','display','visibility','shape-rendering']
  const clone = svg.cloneNode(true)
  const walk = (a, b) => {
    const cs = getComputedStyle(a)
    let st = ''
    for (const p of PROPS) st += p + ':' + cs.getPropertyValue(p) + ';'
    b.setAttribute('style', st)
    const ac = a.children, bc = b.children
    for (let i = 0; i < ac.length; i++) walk(ac[i], bc[i])
  }
  walk(svg, clone)
  // MASK=1：只留陆地那一块，填黑；再补一圈圆盘轮廓（灰）。形状问题在黑白图上最清楚。
  if (${process.env.MASK === '1'}) {
    const land = clone.querySelector('path.globe-land')
    const rim = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    rim.setAttribute('cx', ${VIEW.cx}); rim.setAttribute('cy', ${VIEW.cy}); rim.setAttribute('r', ${VIEW.r})
    rim.setAttribute('fill', 'none'); rim.setAttribute('stroke', '#bbb'); rim.setAttribute('stroke-width', '0.4')
    clone.innerHTML = ''
    if (land) { land.setAttribute('style', 'fill:#000;stroke:none'); clone.appendChild(land) }
    clone.appendChild(rim)
  }
  const box = ${JSON.stringify(box)}
  if (box) clone.setAttribute('viewBox', box.join(' '))
  const vb = clone.getAttribute('viewBox').split(/\\s+/).map(Number)
  const outW = Math.round(vb[2] * ${scale}), outH = Math.round(vb[3] * ${scale})
  clone.setAttribute('width', outW); clone.setAttribute('height', outH)
  const str = new XMLSerializer().serializeToString(clone)
  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str)
  await img.decode()
  const cv = document.createElement('canvas'); cv.width = outW; cv.height = outH
  const cx = cv.getContext('2d')
  cx.fillStyle = ${dark ? "'#141414'" : "'#ffffff'"}; cx.fillRect(0, 0, outW, outH)
  cx.drawImage(img, 0, 0, outW, outH)
  return cv.toDataURL('image/png')
})()`

mkdirSync(OUT, { recursive: true })
const target = Number(process.argv[2] ?? 6)
const scale = Number(process.argv[3] ?? 4)
const mode = process.argv[4] ?? 'both'
const dark = process.env.DARK === '1'
console.log('地区顺序：', ROWS.map((r) => `${r.region.label}(${r.aim[0].toFixed(0)},${r.aim[1].toFixed(0)})`).join(' '))
const written = []
for (let i = 0; i < Math.min(target, ROWS.length); i += 1) {
  await js(`(() => { const b = document.querySelectorAll('button.globe-reg')[${i + 1}]; if (b) b.click(); return true })()`)
  await sleep(450)
  await js(`(() => { const b = document.querySelector('.globe-reg-all'); if (b) b.click(); return true })()`)
  await sleep(350)
  const label = ROWS[i].region.label.replace(/[^\w\u4e00-\u9fa5-]/g, '')
  const pins = Number(await js(`document.querySelectorAll('.globe-atlas circle.hit').length`)) || 0
  const caption = String(await js(`document.querySelector('.globe-caption')?.textContent || ''`))
  const jobs = []
  if (mode !== 'disk') jobs.push(['full', null, 2])
  if (mode !== 'full') jobs.push(['disk', [VIEW.cx - VIEW.r - 6, VIEW.cy - VIEW.r - 6, VIEW.r * 2 + 12, VIEW.r * 2 + 12], scale])
  for (const [kind, box, k] of jobs) {
    const data = await js(RASTER(box, k, dark))
    if (!data) { console.log('★栅格化失败', label); continue }
    const file = `${String(i).padStart(2, '0')}-${label}-${kind}${dark ? '-dark' : ''}.png`
    writeFileSync(join(OUT, file), Buffer.from(String(data).split(',')[1], 'base64'))
    written.push(file)
  }
  console.log(`${label.padEnd(12)} ${caption.padEnd(44)} 针 ${pins}  → ${written.slice(-jobs.length).join(' ')}`)
}
console.log(`\n产物：${OUT}/（${written.length} 张）`)
chrome.kill()
server.close()
process.exit(0)

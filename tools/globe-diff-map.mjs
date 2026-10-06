// 误差分布图（**诊断用**，不是护栏：它不判 PASS/FAIL，只出图给人看）：给定角度，把地球画在 3 倍大的 canvas 上，再把采样点按
//   绿 = 该是陆地且画了｜红 = 该是陆地却没画（漏）｜蓝 = 不该是陆地却画了（多填）｜灰 = 都对的海
// 逐点上色。一眼看出缺的是什么形状（整块大陆？小岛？贴边一圈？放射状楔块？）。
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join, extname, normalize } from 'node:path'
import { camera, VIEW, landPaths, prepareRings } from '../src/lib/globe.ts'
import { WORLD_OUTLINES } from '../src/lib/world.ts'

const PORT = 5471
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mk = (id, name, country, group) => ({
  id, name, country, group, os: 'Debian GNU/Linux 12', sort: id, online: true, public: true, country_pin: '',
  last_seen: 1790311292, kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'x', cpu_cores: 2, mem_total: 1, swap_total: 0,
  disk_total: 1, traffic_limit: 1, traffic_mode: 'sum', billing_cycle: 'monthly', currency: 'CNY', price: 1,
  expires_at: '2027-07-21', expires_in: 1, month_start: '2026-09-21', traffic_reset_day: 21,
  day_rx: 1, day_tx: 1, month_rx: 1, month_tx: 1, total_rx: 1, total_tx: 1,
  metrics: { cpu: 5, load: [0, 0, 0], mem_used: 1, mem_total: 1, swap_used: 0, swap_total: 0, disk_used: 1, disk_total: 1, net_rx: 1, net_tx: 1, procs: 1, tcp: 1, udp: 1, uptime: 1, month_rx: 1, month_tx: 1, total_rx: 1, total_tx: 1 },
})
const NODES = { nodes: [mk(1, '新加坡一号', 'SG', '新加坡'), mk(2, '纽约一号', 'US', '纽约')] }
const serveFile = (res, path) => {
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(200, { 'Content-Type': TYPES['.html'] }); return res.end(readFileSync('dist/index.html')) }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
}
const server = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  if (path.startsWith('/api/')) {
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: 'x' }
      : path === '/api/nodes' ? NODES : path.endsWith('/config') ? {} : { metrics: [], ping: [], probes: {}, loss: {} }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  serveFile(res, path)
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const rings = WORLD_OUTLINES.filter((r) => r && r.length >= 3)
const inRing = (lon, lat, ring) => {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
const isLand = (lon, lat) => rings.some((r) => inRing(lon, lat, r))

const ANGLES = [[104, 1], [-74, 41], [140, 36], [9, 50]]
const SCALE = 3

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p))
const dbgPort = 9930 + Math.floor(Math.random() * 9)
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, '--remote-allow-origins=*', '--no-first-run',
  '--disable-gpu', '--hide-scrollbars', '--window-size=1500,1000',
  '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/diffmap-' + dbgPort + '-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
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
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(3000)

mkdirSync('shots/globe-diff', { recursive: true })
console.log('LIMB_K =', ' 页面里的 d 与 Node 算的是否一致：')
for (const [lon0, lat0] of ANGLES) {
  // Node 侧：自己算一遍路径 + 真值采样点
  const cam = camera(lon0, lat0)
  const land = landPaths(cam, prepareRings(WORLD_OUTLINES))
  const pts = []
  const a = (lon0 * Math.PI) / 180, b = (lat0 * Math.PI) / 180
  const sa = Math.sin(a), ca = Math.cos(a), sb = Math.sin(b), cb = Math.cos(b)
  const ex = [ca, 0, -sa], ey = [-sb * sa, cb, -sb * ca], ez = [cb * sa, sb, cb * ca]
  const S = 0.012
  for (let gy = -0.995; gy <= 0.995; gy += S) {
    for (let gx = -0.995; gx <= 0.995; gx += S) {
      const d2 = gx * gx + gy * gy
      if (d2 > 0.99) continue
      const w = Math.sqrt(Math.max(0, 1 - d2))
      const v = [0, 1, 2].map((i) => gx * ex[i] + gy * ey[i] + w * ez[i])
      const n = Math.hypot(...v) || 1
      const [x, y, z] = v.map((t) => t / n)
      const lat = (Math.asin(Math.max(-1, Math.min(1, y))) * 180) / Math.PI
      const lon = (Math.atan2(x, z) * 180) / Math.PI
      pts.push({ x: VIEW.cx + VIEW.r * gx, y: VIEW.cy - VIEW.r * gy, r: Math.sqrt(d2), land: isLand(lon, lat), lon, lat })
    }
  }
  // 浏览器侧：用页面里真正那条 path（确认与 Node 一致），并画放大版 + 误差点
  const same = await js(`(() => {
    const p = document.querySelector('path.globe-land')
    return JSON.stringify({ page: (p?.getAttribute('d') || '').slice(0, 120), pageLen: (p?.getAttribute('d') || '').length, nodeLen: ${land.fill.length} })
  })()`)
  const info = JSON.parse(same ?? '{}')
  const img = await js(`(() => {
    const pts = ${JSON.stringify(pts)}
    const d = ${JSON.stringify(land.fill)}
    const S = ${SCALE}
    const cv = document.createElement('canvas')
    cv.width = 480 * S; cv.height = 250 * S
    const cx = cv.getContext('2d')
    cx.scale(S, S)
    cx.fillStyle = '#f7f3ea'; cx.fillRect(0, 0, 480, 250)
    // 球体
    cx.beginPath(); cx.arc(${VIEW.cx}, ${VIEW.cy}, ${VIEW.r}, 0, Math.PI * 2); cx.fillStyle = '#e9eef3'; cx.fill()
    // 陆地（真路径）
    const path = new Path2D(d)
    cx.fillStyle = '#c8b48a'; cx.fill(path)
    // 采样点
    for (const pt of pts) {
      // ★注意：isPointInPath 的坐标是**画布空间**（不受当前变换影响），
      //   这里画布缩了 S 倍，所以要乘回去 —— 上一版忘了乘，于是把所有陆地点都判成了「漏」。
      const hit = cx.isPointInPath(path, pt.x * S, pt.y * S)
      let c
      if (pt.land && hit) c = 'rgba(40,160,80,0.55)'
      else if (pt.land && !hit) c = 'rgba(230,30,30,0.95)'
      else if (!pt.land && hit) c = 'rgba(30,80,230,0.95)'
      else c = 'rgba(150,150,150,0.20)'
      cx.fillStyle = c
      cx.fillRect(pt.x - 0.6, pt.y - 0.6, 1.2, 1.2)
    }
    // 球体轮廓
    cx.beginPath(); cx.arc(${VIEW.cx}, ${VIEW.cy}, ${VIEW.r}, 0, Math.PI * 2); cx.strokeStyle = '#333'; cx.lineWidth = 0.4; cx.stroke()
    return cv.toDataURL('image/png')
  })()`)
  const file = `shots/globe-diff/${lon0}_${lat0}.png`
  if (img) writeFileSync(file, Buffer.from(String(img).split(',')[1], 'base64'))
  const landN = pts.filter((p) => p.land).length
  const miss = pts.filter((p) => p.land)
  console.log(`角度 ${lon0},${lat0}：采样 ${pts.length}（陆地 ${landN}）｜页面 d 长 ${info.pageLen} / Node 算的 ${info.nodeLen} ${info.pageLen === info.nodeLen ? '一致' : '★不一致'}｜图 ${file}`)
  void miss
}
chrome.kill()
server.close()
process.exit(0)

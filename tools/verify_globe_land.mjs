// 地球「陆地覆盖」护栏：把地球停在固定角度，采样整个圆盘，逐点问
//   ① 这里**该是陆地**吗（屏幕点 → 球面 → lon/lat → 是否在岸线环内，独立算一遍）
//   ② 画出来的陆地填充**盖住它了吗**（把那条 path 丢进 canvas，`isPointInPath`）
// 两边对不上的比例就是「陆地残缺」的量。判据：两个方向都 ≤2.5%。
//
// 为什么要有它：这套岸线曾经按「每 N 个点取 1」抽稀（medium 档 N=3），实测有 **5.5% 的陆地
// 该画没画、5.0% 的海被填成陆地**（用户报的「陆地随着转动残缺」）。去掉抽稀后是 1.5% / 0.7%
// （且全在贴地平线那一圈，是七次二分找边缘的正常误差）—— 这条护栏就是钉这个的。
//
// ★这一份只测**首屏那一个角度**。单角度会骗人：岸线「收口拉直线」那个 bug 在首屏角度
// 只漏 1.5%，转到新加坡角度却是 22% —— 所以**整圈**那一份（tools/verify_globe_spin.mjs）
// 才是主护栏，它把地球依次定格到每个地区再逐点对账。这份留作最快的冒烟检查。
//
// 跑法：node tools/verify_globe_land.mjs
import { existsSync, readFileSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join, extname, normalize } from 'node:path'
import { camera, VIEW, regionOf } from '../src/lib/globe.ts'
import { WORLD_OUTLINES } from '../src/lib/world.ts'

const PORT = 5441
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
let failed = 0
const check = (what, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ' — ' + detail : ''}`)
  if (ok) passed++
  else failed++
}

const mk = (id, name, country, group) => ({
  id, name, country, group, os: 'Debian GNU/Linux 12', sort: id, online: true, public: true, country_pin: '',
  last_seen: 1790311292, kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'x', cpu_cores: 2, mem_total: 1, swap_total: 0,
  disk_total: 1, traffic_limit: 1, traffic_mode: 'sum', billing_cycle: 'monthly', currency: 'CNY', price: 1,
  expires_at: '2027-07-21', expires_in: 1, month_start: '2026-09-21', traffic_reset_day: 21,
  day_rx: 1, day_tx: 1, month_rx: 1, month_tx: 1, total_rx: 1, total_tx: 1,
  metrics: { cpu: 5, load: [0, 0, 0], mem_used: 1, mem_total: 1, swap_used: 0, swap_total: 0, disk_used: 1, disk_total: 1, net_rx: 1, net_tx: 1, procs: 1, tcp: 1, udp: 1, uptime: 1, month_rx: 1, month_tx: 1, total_rx: 1, total_tx: 1 },
})
// 针要落在**认得出来的城市**上，才能从屏幕位置反解相机角度
const NODES = { nodes: [mk(1, '东京一号', 'JP', '东京'), mk(2, '东京二号', 'JP', '东京'), mk(3, '东京三号', 'JP', '东京'), mk(4, '法兰克福一号', 'DE', '欧洲')] }

const serveFile = (res, path) => {
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(200, { 'Content-Type': TYPES['.html'] }); return res.end(readFileSync('dist/index.html')) }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
}
const server = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  if (path.startsWith('/api/')) {
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '地球' }
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

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p)) || 'chrome'
const dbgPort = 9910 + Math.floor(Math.random() * 9)
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, '--remote-allow-origins=*', '--no-first-run',
  '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900',
  '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/globeland-' + dbgPort + '-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 120 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { }
  if (!wsUrl) await sleep(250)
}
if (!wsUrl) throw new Error('Chrome 起不来')
let id = 0
const pending = new Map()
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')
// 关掉自转（跟着系统的「减少动态效果」），相机停在原地好对账
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(3200)

const pins = JSON.parse((await js(`(() => JSON.stringify([...document.querySelectorAll('circle.hit')].map((c) => ({ id: c.getAttribute('data-node'), x: +c.getAttribute('cx'), y: +c.getAttribute('cy') }))))()`)) ?? '[]')
const known = pins.map((p) => {
  const n = NODES.nodes.find((x) => String(x.id) === String(p.id))
  const r = n ? regionOf(n) : null
  return r ? { ...p, ll: r.base } : null
}).filter(Boolean)
check('从针反解相机（至少两枚针认得出来）', known.length >= 2, `${known.length} 枚`)

let best = null
for (let lon0 = -180; lon0 < 180; lon0 += 2) {
  for (let lat0 = -80; lat0 <= 80; lat0 += 2) {
    const cam = camera(lon0, lat0)
    let err = 0
    for (const k of known) {
      const p = cam.at(k.ll[0], k.ll[1])
      if (!p) { err += 9999; continue }
      err += (p.x - k.x) ** 2 + (p.y - k.y) ** 2
    }
    if (!best || err < best.err) best = { lon0, lat0, err }
  }
}
check('相机角度对得上（误差平方和 < 1px²）', best.err < 1, `lon=${best.lon0} lat=${best.lat0} err=${best.err.toFixed(2)}`)

const expected = []
{
  const a = (best.lon0 * Math.PI) / 180
  const b = (best.lat0 * Math.PI) / 180
  const sa = Math.sin(a), ca = Math.cos(a), sb = Math.sin(b), cb = Math.cos(b)
  const ex = [ca, 0, -sa]
  const ey = [-sb * sa, cb, -sb * ca]
  const ez = [cb * sa, sb, cb * ca]
  for (let gy = -0.96; gy <= 0.96; gy += 0.06) {
    for (let gx = -0.96; gx <= 0.96; gx += 0.06) {
      const d2 = gx * gx + gy * gy
      if (d2 > 0.94) continue
      const w = Math.sqrt(Math.max(0, 1 - d2))
      const v = [0, 1, 2].map((i) => gx * ex[i] + gy * ey[i] + w * ez[i])
      const n = Math.hypot(...v) || 1
      const [x, y, z] = v.map((t) => t / n)
      const lat = (Math.asin(Math.max(-1, Math.min(1, y))) * 180) / Math.PI
      const lon = (Math.atan2(x, z) * 180) / Math.PI
      expected.push({ x: VIEW.cx + VIEW.r * gx, y: VIEW.cy - VIEW.r * gy, r: Math.sqrt(d2), land: isLand(lon, lat) })
    }
  }
}
const rows = JSON.parse((await js(`(() => {
  const land = document.querySelector('path.globe-land')
  const d = land ? land.getAttribute('d') || '' : ''
  const cv = document.createElement('canvas')
  cv.width = 460; cv.height = 240
  const cx = cv.getContext('2d')
  const p = new Path2D(d)
  return JSON.stringify(${JSON.stringify(expected)}.map((pt) => ({ r: pt.r, land: pt.land, filled: cx.isPointInPath(p, pt.x, pt.y) })))
})()`)) ?? 'null')

const landPts = rows.filter((r) => r.land)
const seaPts = rows.filter((r) => !r.land)
const missing = landPts.filter((r) => !r.filled)
const extra = seaPts.filter((r) => r.filled)
const missRate = (missing.length / Math.max(1, landPts.length)) * 100
const extraRate = (extra.length / Math.max(1, seaPts.length)) * 100
console.log(`   采样 ${rows.length} 点（陆地 ${landPts.length} / 海 ${seaPts.length}）`)
check('该是陆地却没画出来的 ≤1.5%（抽稀那版 5.5%）', missRate <= 1.5, `${missing.length} 个 = ${missRate.toFixed(1)}%`)
check('不该是陆地却填成陆地的 ≤1.5%（抽稀那版 5.0%）', extraRate <= 1.5, `${extra.length} 个 = ${extraRate.toFixed(1)}%`)
// 缺的那些应当都在贴地平线那一圈（≥0.8 半径）—— 那是七次二分找边缘的正常误差，不是形状被砍
const inner = missing.filter((r) => r.r < 0.8).length
check('缺的点都在贴地平线一圈（内侧没有成片缺失）', inner <= 4, `内侧缺 ${inner} 个`)

/*
 * ── 同城多台：**聚成一枚针**（针边挂台数、标签写「地区 ×N」） ──
 * 夹具里东京有三台、法兰克福一台；初始视角就在亚洲那一面（而且这里关了自转，角度是定的），
 * 所以东京一定看得见。
 */
const pinList = JSON.parse((await js(`(() => JSON.stringify([...document.querySelectorAll('circle.hit')].map((c) => ({
  region: c.getAttribute('data-region'),
  count: Number(c.getAttribute('data-count') || 1),
  x: +c.getAttribute('cx'), y: +c.getAttribute('cy'),
}))))()`)) ?? '[]')
const tokyo = pinList.filter((p) => p.region === 'JP · Tokyo')
check('三台同城只出一枚针', tokyo.length === 1, `东京那枚针 ${tokyo.length} 个`)
check('针上写着 3 台（data-count）', tokyo[0]?.count === 3, `data-count=${tokyo[0]?.count}`)
const badge = await js(`(() => {
  const t = [...document.querySelectorAll('text.globe-count')].map((e) => e.textContent)
  const labels = [...document.querySelectorAll('text.globe-label')].map((e) => e.textContent)
  return JSON.stringify({ badges: t, labels })
})()`)
const seen = JSON.parse(badge ?? 'null')
check('针边上挂着「3」那枚小字', seen?.badges?.includes('3') === true, JSON.stringify(seen?.badges))
// 标签是布局层拼的「国家 · 名字」，所以多台那行是「JP · Tokyo ×3」
check('标签里带「Tokyo ×3」', (seen?.labels ?? []).some((l) => /Tokyo ×3$/.test(l)), JSON.stringify(seen?.labels))
check('一台的地区没有台数小字（法兰克福）', pinList.filter((p) => p.region === 'DE · Frankfurt am Main').every((p) => p.count === 1),
  JSON.stringify(pinList.map((p) => `${p.region}:${p.count}`)))


console.log(`\n结果: PASS ${passed} / FAIL ${failed}`)
chrome.kill()
server.close()
process.exit(failed ? 1 : 0)

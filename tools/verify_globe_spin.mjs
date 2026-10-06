// 地球「整圈」审计：把地球依次停到每个地区的角度（点地区行 = 定格到那个 aim），
// 每个角度都做一次「该是陆地 / 画出来是不是陆地」的采样对账，并截图。
//
// 与 verify_globe_land.mjs 的区别：那个只测首屏那一个角度，这个测一整圈 ——
// 用户报的是「随着转动消失」，所以必须把角度转遍。
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join, extname, normalize } from 'node:path'
import { camera, VIEW, regionRows } from '../src/lib/globe.ts'
import { WORLD_OUTLINES } from '../src/lib/world.ts'

const PORT = 5461
const OUT = 'shots/globe-spin'
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0
let failed = 0

// 12 个城市铺满全球：每个角度都能把地球转到有陆地的一面。
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
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(200, { 'Content-Type': TYPES['.html'] }); return res.end(readFileSync('dist/index.html')) }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
}
const server = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  if (path.startsWith('/api/')) {
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '整圈' }
      : path === '/api/nodes' ? NODES : path.endsWith('/config') ? {} : { metrics: [], ping: [], probes: {}, loss: {} }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  serveFile(res, path)
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

// ── 真值：独立算一遍「这个经纬度是不是陆地」（射线法，点太多就只判前 N 个环无所谓）
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

/** 给定相机角度，生成圆盘上的采样点（含真值）。 */
const sampleDisk = (lon0, lat0) => {
  const a = (lon0 * Math.PI) / 180
  const b = (lat0 * Math.PI) / 180
  const sa = Math.sin(a), ca = Math.cos(a), sb = Math.sin(b), cb = Math.cos(b)
  const ex = [ca, 0, -sa]
  const ey = [-sb * sa, cb, -sb * ca]
  const ez = [cb * sa, sb, cb * ca]
  const pts = []
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
      pts.push({ x: +(VIEW.cx + VIEW.r * gx).toFixed(2), y: +(VIEW.cy - VIEW.r * gy).toFixed(2), r: +Math.sqrt(d2).toFixed(3), land: isLand(lon, lat) })
    }
  }
  return pts
}

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p))
const dbgPort = 9920 + Math.floor(Math.random() * 9)
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, '--remote-allow-origins=*', '--no-first-run',
  '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900',
  '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/spin-' + dbgPort + '-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
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
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(3200)

// 先从针反解一次相机（用于校验「点行真的把地球转过去了」）
const solve = async () => {
  const pins = JSON.parse((await js(`(() => JSON.stringify([...document.querySelectorAll('circle.hit')].map((c) => ({ id: c.getAttribute('data-node'), x: +c.getAttribute('cx'), y: +c.getAttribute('cy') }))))()`)) ?? '[]')
  const known = pins.map((p) => {
    const n = NODES.nodes.find((x) => String(x.id) === String(p.id))
    const r = n ? regionRows([n])[0] : null
    return r ? { ...p, ll: r.region.base } : null
  }).filter(Boolean)
  if (known.length < 2) return null
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
  return best && best.err < 4 ? { ...best, n: known.length } : null
}

const measure = async (lon0, lat0) => {
  const pts = sampleDisk(lon0, lat0)
  const rows = JSON.parse((await js(`(() => {
    const land = document.querySelector('path.globe-land')
    const d = land ? land.getAttribute('d') || '' : ''
    const cv = document.createElement('canvas'); cv.width = 460; cv.height = 240
    const cx = cv.getContext('2d'); const p = new Path2D(d)
    // 同一份路径数据，两种填充规则各量一遍：非零绕数 vs 奇偶
    return JSON.stringify(${JSON.stringify(pts)}.map((pt) => ({ r: pt.r, land: pt.land, nz: cx.isPointInPath(p, pt.x, pt.y), eo: cx.isPointInPath(p, pt.x, pt.y, 'evenodd') })))
  })()`)) ?? 'null')
  const landPts = rows.filter((r) => r.land)
  const seaPts = rows.filter((r) => !r.land)
  const rule = process.env.FILLRULE === 'evenodd' ? 'eo' : 'nz'
  const missing = landPts.filter((r) => !r[rule])
  const extra = seaPts.filter((r) => r[rule])
  const segs = Number(await js(`(() => ((document.querySelector('path.globe-land')?.getAttribute('d') || '').match(/M /g) || []).length)()`)) || 0
  return {
    lon0, lat0,
    n: rows.length, land: landPts.length, sea: seaPts.length,
    miss: missing.length, missRate: (missing.length / Math.max(1, landPts.length)) * 100,
    extra: extra.length, extraRate: (extra.length / Math.max(1, seaPts.length)) * 100,
    missInner: missing.filter((r) => r.r < 0.8).length,
    extraInner: extra.filter((r) => r.r < 0.8).length,
    missFar: missing.filter((r) => r.r >= 0.8).length,
    extraFar: extra.filter((r) => r.r >= 0.8).length,
    segs,
    missPts: missing.slice(0, 4).map((r) => `r=${r.r}`).join(','),
  }
}

mkdirSync(OUT, { recursive: true })
const report = []
console.log('地区行顺序：', ROWS.map((r) => `${r.region.label}(${r.aim[0].toFixed(0)},${r.aim[1].toFixed(0)})`).join(' '))
for (let i = 0; i < ROWS.length; i += 1) {
  const row = ROWS[i]
  await js(`(() => { const b = document.querySelectorAll('button.globe-reg')[${i + 1}]; if (b) b.click(); return true })()`)
  await sleep(700)
  const cam = await solve()
  // 点地区行会把地球**定格**在那个地区的 aim 上，所以真值就用 aim 算（反解只用来体检「真的转过去了没」）
  const use = row.aim
  const m = await measure(use[0], use[1])
  m.want = `${row.aim[0].toFixed(0)},${row.aim[1].toFixed(0)}`
  m.solved = cam ? `${cam.lon0},${cam.lat0} err=${cam.err.toFixed(2)} n=${cam.n}` : '解不出（用 aim）'
  const shot = (await send('Page.captureScreenshot', { format: 'png' })).result?.data
  if (shot) writeFileSync(join(OUT, `${String(i).padStart(2, '0')}-${row.region.code}.png`), Buffer.from(shot, 'base64'))
  const anglePass = m.missRate <= 2 && m.extraRate <= 2 && m.missInner <= 8
  if (anglePass) passed += 1
  else failed += 1
  report.push(m)
  console.log(`${row.region.label.padEnd(16)} 角度 ${m.want.padEnd(10)} 解出 ${String(m.solved).padEnd(26)} 陆地${String(m.land).padStart(3)} 漏 ${String(m.miss).padStart(3)}(${m.missRate.toFixed(1)}%) 内侧${m.missInner} 贴边${m.missFar} | 多填 ${String(m.extra).padStart(3)}(${m.extraRate.toFixed(1)}%) 内侧${m.extraInner} | 段 ${m.segs}`)
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
const worst = report.reduce((a, b) => (b.missRate > a.missRate ? b : a), report[0])
const worstExtra = report.reduce((a, b) => (b.extraRate > a.extraRate ? b : a), report[0])
console.log(`\n最差：漏 ${worst.missRate.toFixed(1)}%（${worst.want}）｜多填 ${worstExtra.extraRate.toFixed(1)}%（${worstExtra.want}）`)
console.log(`结果: PASS ${passed} / FAIL ${failed}（判据：每个角度 漏 ≤2%、多填 ≤2%、内侧漏 ≤8 个）`)
console.log(`截图：${OUT}/`)
chrome.kill()
server.close()
process.exit(failed ? 1 : 0)

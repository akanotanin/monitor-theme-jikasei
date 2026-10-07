// 地球的**陆海配色**验收：站长 2026-10-07 报「有些原本该是灰块的地方变白、原本白的变灰」——
// 根因是 `--globe-land` / `--globe-ocean` 两档透明度让陆地与海面的**亮度几乎相同**
// （实测 228.5 对 228.8），只靠冷暖分开：哪一块看着像灰块全看它周围有什么（挨着海岸线的海
// 被深色描边衬成灰、大片陆地内部反倒发白），于是「灰白互换」。
//
// 这条护栏量的是**真渲染出来的颜色**：浏览器侧把地球那张 SVG 连同计算样式栅格化到 canvas
// （先铺一层卡片底色），再在「已知是陆地 / 已知是海」的经纬度上取像素、比亮度。
// 判据：亮色下陆地明显比海面暗（≥18），暗色下陆地明显比海面亮（≥12）。
//
// 用法：node tools/verify_globe_colors.mjs
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { camera, VIEW } from '../src/lib/globe.ts'
import { WORLD_OUTLINES } from '../src/lib/world.ts'

const PORT = Number(process.env.COLOR_PORT || 5202)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }
const NODES = { nodes: [{ id: 'a', name: '演示节点', country: 'JP', group: '亚太', os: 'Debian 12', cpu_name: 'EPYC', cpu_cores: 2, mem_total: 2147483648, disk_total: 42949672960, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, online: true }] }

/**
 * 取样点**按世界数据自己挑**：视角固定（组件初始就是东经 80°、北纬 30°），
 * 在半径 0.75 以内扫一遍经纬网格，用射线法判它该是陆地还是海，再只留
 * **四周 ±2.5 个用户单位都是同一类**的点 —— 这样量到的才是填充色，而不是海岸线描边或
 * 圆盘边缘的暗影。手挑坐标会挑错（地球在转，静态坐标取到的是别处）。
 */
const VIEW_LON = 80
const VIEW_LAT = 30
const RINGS = WORLD_OUTLINES.filter((r) => r && r.length >= 3)
const inRing = (lon, lat, ring) => {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
const isLand = (lon, lat) => RINGS.some((r) => inRing(lon, lat, r))

function pickSamples() {
  const cam = camera(VIEW_LON, VIEW_LAT)
  const land = []
  const sea = []
  for (let lon = -180; lon < 180; lon += 1.5) {
    for (let lat = -85; lat <= 85; lat += 1.5) {
      const p = cam.at(lon, lat)
      if (!p) continue
      if (Math.hypot(p.x - VIEW.cx, p.y - VIEW.cy) > VIEW.r * 0.75) continue
      const me = isLand(lon, lat)
      // 四周 ±2.5 用户单位必须同类：否则这个点挨着海岸线
      let clean = true
      for (const [dx, dy] of [[2.5, 0], [-2.5, 0], [0, 2.5], [0, -2.5]]) {
        const q = [p.x + dx, p.y + dy]
        // 反解：这里不做逆投影，改用经纬度上的近似 —— 2.5 用户单位 ≈ 2.5/cos 度，够用
        const dLat = dy * 0.9
        const dLon = dx * 0.9 / Math.max(0.2, Math.cos((lat * Math.PI) / 180))
        if (isLand(lon + dLon, lat - dLat) !== me) { clean = false; break }
        void q
      }
      if (!clean) continue
      const rec = [Math.round(lon * 10) / 10, Math.round(lat * 10) / 10, p.x, p.y]
      if (me) { if (land.length < 14) land.push(rec) } else if (sea.length < 14) sea.push(rec)
    }
  }
  return { land, sea }
}
const { land: LAND_PTS, sea: SEA_PTS } = pickSamples()

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  if (path.startsWith('/api/')) {
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '配色验收' }
      : path === '/api/nodes' ? NODES : path.endsWith('/config') ? { listTop: 'none', cardStyle: 'plain' } : {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] })
    return res.end(readFileSync('dist/index.html'))
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p)) || 'chrome'
const dbg = 9990 + Math.floor(Math.random() * 20)
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, '--remote-allow-origins=*', '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--window-size=1280,900', '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/globeColor-' + dbg, 'about:blank'], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 100 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { }
  if (!wsUrl) await sleep(300)
}
if (!wsUrl) throw new Error('Chrome 起不来')
let id = 0
const pending = new Map()
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const js = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
await send('Runtime.enable'); await send('Page.enable')
// ★ 先把自转冻住：`prefers-reduced-motion` 一开，组件就不再自转（见 Globe.tsx 的 spinning），
// 视角因此固定成初始的东经 80°、北纬 30°，静态算出来的取样坐标才落在原处。
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
for (let i = 0; i < 60; i++) { await sleep(250); if (await js('!!document.querySelector(".globe-atlas svg")')) break }
await sleep(1200)

// 目标经纬度 → 画布（用户单位）坐标
const cam = camera(VIEW_LON, VIEW_LAT)
const at = (lon, lat) => { const p = cam.at(lon, lat); return p ? { x: +p.x.toFixed(2), y: +p.y.toFixed(2) } : null }

const RASTER = `(async (pts, dark) => {
  document.documentElement.classList.toggle('dark', dark)
  await new Promise((r) => setTimeout(r, 300))
  const svg = document.querySelector('.globe-atlas svg')
  const panel = document.querySelector('.globe-panel')
  const bg = getComputedStyle(panel).backgroundColor || 'rgb(255,255,255)'
  const clone = svg.cloneNode(true)
  const walk = (src, dst) => {
    const cs = getComputedStyle(src)
    dst.setAttribute('style', 'fill:' + cs.fill + ';stroke:' + cs.stroke + ';stroke-width:' + cs.strokeWidth +
      ';stroke-opacity:' + cs.strokeOpacity + ';fill-opacity:' + cs.fillOpacity + ';opacity:' + cs.opacity +
      ';font:' + cs.font + ';font-size:' + cs.fontSize + ';font-family:' + cs.fontFamily + ';text-anchor:' + cs.textAnchor)
    const s = src.children, d = dst.children
    for (let i = 0; i < s.length; i += 1) walk(s[i], d[i])
  }
  walk(svg, clone)
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  const vb = (svg.getAttribute('viewBox') || '0 0 460 240').split(/\\s+/).map(Number)
  const S = 4
  const cv = document.createElement('canvas')
  cv.width = vb[2] * S; cv.height = vb[3] * S
  const ctx = cv.getContext('2d')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, cv.width, cv.height)
  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone))
  await img.decode()
  ctx.drawImage(img, -vb[0] * S, -vb[1] * S, vb[2] * S, vb[3] * S)
  const root = getComputedStyle(document.documentElement)
  const cardPx = ctx.getImageData(4, 4, 1, 1).data
  const out = []
  for (const [lon, lat, x, y] of pts) {
    if (x === null) { out.push(null); continue }
    const d = ctx.getImageData(Math.round(x * S), Math.round(y * S), 1, 1).data
    out.push([d[0], d[1], d[2]])
  }
  return { bg, out, landToken: root.getPropertyValue('--globe-land').trim(), oceanToken: root.getPropertyValue('--globe-ocean').trim(), card: [cardPx[0], cardPx[1], cardPx[2]] }
})`

console.log(`取样点（自动挑）：陆地 ${LAND_PTS.length} 个、海面 ${SEA_PTS.length} 个 —— 都离海岸线 ≥2.5 用户单位、且在半径 0.75 以内`)
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b
let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }

for (const dark of [false, true]) {
  const pts = [...LAND_PTS, ...SEA_PTS].map(([lon, lat]) => { const p = at(lon, lat); return [lon, lat, p ? p.x : null, p ? p.y : null] })
  const res = await js(`(${RASTER})(${JSON.stringify(pts)}, ${dark})`)
  const land = res.out.slice(0, LAND_PTS.length).filter(Boolean)
  const sea = res.out.slice(LAND_PTS.length).filter(Boolean)
  const ml = land.reduce((s, c) => s + lum(c), 0) / Math.max(1, land.length)
  const ms = sea.reduce((s, c) => s + lum(c), 0) / Math.max(1, sea.length)
  const tag = dark ? '暗色' : '亮色'
  console.log(`\n=== ${tag}（卡片底 ${res.bg} → 实测 rgb(${res.card})；token 陆地 ${res.landToken}｜海面 ${res.oceanToken}）===`)
  console.log(`  陆地 ${land.length} 点，平均亮度 ${ml.toFixed(1)}｜海面 ${sea.length} 点，平均亮度 ${ms.toFixed(1)}｜差 ${Math.abs(ml - ms).toFixed(1)}`)
  const show = (name, arr, base) => console.log(`    ${name}：` + arr.map((c, i) => `(${LAND_PTS.concat(SEA_PTS)[base + i].slice(0, 2)}) rgb(${c}) 亮度 ${lum(c).toFixed(0)}`).join('  '))
  show('陆地', land, 0)
  show('海面', sea, LAND_PTS.length)
  if (dark) {
    check(`${tag} 渲染出来：陆地明显比海面亮（≥12）`, ml - ms >= 12, `陆地 ${ml.toFixed(1)} - 海面 ${ms.toFixed(1)} = ${(ml - ms).toFixed(1)}`)
  } else {
    check(`${tag} 渲染出来：陆地明显比海面暗（≥18）`, ms - ml >= 18, `海面 ${ms.toFixed(1)} - 陆地 ${ml.toFixed(1)} = ${(ms - ml).toFixed(1)}`)
  }
  // ★ 主判据：**两个 token 合成到卡片底色后的亮度差**。取样难免蹭到海岸线（实测把陆地压暗
  //   约 20），所以渲染出来的那条只能当辅证；真正决定观感的是 CSS 里那两个 rgba 的透明度 ——
  //   站长报的就是旧值（0.16 / 0.18）合成后亮度 228.5 对 228.8、几乎一样。
  // Chrome 把计算样式里的 rgba() 归一化成 `#rrggbbaa`（实测），两种都得认。
  const nums = (v) => {
    if (v.startsWith('#')) {
      const h = v.slice(1)
      const at = (i) => parseInt(h.slice(i, i + 2), 16)
      return [at(0), at(2), at(4), h.length >= 8 ? at(6) / 255 : 1]
    }
    return (v.match(/[0-9.]+/g) || []).map(Number)
  }
  const over = (c, bg) => c.slice(0, 3).map((x, i) => x * (c[3] ?? 1) + bg[i] * (1 - (c[3] ?? 1)))
  const tl = over(nums(res.landToken), res.card)
  const ts = over(nums(res.oceanToken), res.card)
  const gap = dark ? lum(tl) - lum(ts) : lum(ts) - lum(tl)
  const need = dark ? 18 : 25
  check(`${tag} token 合成后的亮度差 ≥${need}`, gap >= need, `陆地 ${lum(tl).toFixed(1)} / 海面 ${lum(ts).toFixed(1)} → 差 ${gap.toFixed(1)}`)
  check(`${tag} 取样点都在可见的那一面`, land.length === LAND_PTS.length && sea.length === SEA_PTS.length, `陆地 ${land.length}/${LAND_PTS.length}｜海面 ${sea.length}/${SEA_PTS.length}`)
}

console.log(`\n结果: PASS ${pass} / FAIL ${fail}`)
ws.close(); chrome.kill(); server.close()
process.exit(fail ? 1 : 0)

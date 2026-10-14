// 延迟图「最近视距」下限的护栏（2026-10-14，来自论坛反馈：130ms 上下只抖几 ms 的线被画成满屏地震波）。
//
// 改动：自动量程加下限 AUTO_MIN_SPAN_RATIO（= 顶端值 1/4，见 src/components/Chart.tsx）——
// 量程最多放大到「最近视距」这一档就不再往里怼；跨度本来就超过下限的线路（真在抖的）不受影响。
// 详情图与卡片走势线同一口径。这里用两台夹具机器把两头都钉住：
//
//   ① 稳定线（128~136ms，顶 136 → 下限 34）：详情图轴跨度 ≥ 34；线高占绘图区 ≤ 35%
//   ② 波动线（20~180ms，量程 160 超过下限）：轴跨度照吃满数据（≥ 160）；线高 ≥ 65%（不受影响）
//   ③ 卡片小线（viewBox 高 20、可画区 16 单位）：稳定线占高 ≤ 6 且 ≥ 1.5；波动线照旧 ≥ 13
//
// 跑法：node tools/verify_latency_min_span.mjs [端口]     # dist/ 取自当前目录
// ★ 对照纪律：拿**改动前的 dist** 跑这一版，①②③ 里的「≤ / ≥ 下限」判据共 3 条必须 FAIL
//   （改前稳定线在详情图占 6 成高、在卡片上顶满 16 单位），全绿只在改动后成立——
//   判据分不了两头，就等于没钉。
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = Number(process.argv[2] || 5317)
const CDP_PORT = PORT + 4000
const SHOTS = process.env.SHOT_DIR || 'shots/latency-min-span'
mkdirSync(SHOTS, { recursive: true })

let passed = 0
let failed = 0
function check(what, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ' — ' + detail : ''}`)
  if (ok) passed++
  else failed++
}
const pct = (f) => (f === null || f === undefined ? '?' : Math.round(f * 100) + '%')

/* ------------------------------------------------------------------ 桩数据 */

const GB = 1024 ** 3
const node = (id, name) => ({
  id, name, sort: id, public: true, online: true, country: 'JP', group: '',
  last_seen: Math.floor(Date.now() / 1000) - 5,
  metrics: {
    uptime: 400000, cpu: 12.5, load: [0.1, 0.2, 0.3], mem_total: 2 * GB, mem_used: 1 * GB,
    swap_total: 0, swap_used: 0, disk_total: 40 * GB, disk_used: 10 * GB,
    net_rx: 512 * 1024, net_tx: 128 * 1024, total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0,
    tcp: 10, udp: 2, procs: 100,
  },
  os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'Xeon', cpu_cores: 2,
  mem_total: 2 * GB, swap_total: 0, disk_total: 40 * GB, agent_version: '1.3.0',
  price: 0, currency: 'CNY', billing_cycle: 'monthly', expires_at: null, expires_in: null,
  traffic_limit: 0, traffic_mode: 'sum', traffic_reset_day: 1,
  total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0, month_start: '', day_rx: 0, day_tx: 0,
})
const NODES = { nodes: [node(1, '稳定一号'), node(2, '波动二号')] }

// 稳定线：40 个点全活在 128~136ms（顶 136 → 下限 136×1/4 = 34）；波动线：20~180ms（量程 160 超下限）。
// 显式数组循环取点：别写乘同余——步长与模数不互素时会凑不齐 min/max 两头（161=7×23，很容易踩）。
const STABLE = [0, 2, 5, 8, 1, 6, 3, 7, 4, 2]
const WILD = [0, 30, 160, 80, 120, 10, 50, 140, 90, 20]
const series = (taskId, vals, base, band) => Array.from({ length: 40 }, (_, i) => {
  const v = base + vals[i % vals.length]
  return { task_id: taskId, ts: Math.floor(Date.now() / 1000) - (40 - i) * 90, latency: v, band: [v - band, v + band], loss: 0 }
})
const PING = {
  1: { ping: series(11, STABLE, 128, 1), probes: { 11: '测试稳定' }, loss: { 11: 0 } },
  2: { ping: series(12, WILD, 20, 5), probes: { 12: '测试波动' }, loss: { 12: 0 } },
}

/* ------------------------------------------------------------------ 伺服 */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
}
const serveFile = (res, path) => {
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] })
    return res.end(readFileSync('dist/index.html'))
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
}
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  if (path.startsWith('/api/')) {
    let body = {}
    if (path === '/api/me') body = { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '最小量程校验' }
    else if (path === '/api/nodes') body = NODES
    else if (path.endsWith('/config')) body = { cardStyle: 'latency', pingLines: '' }
    else if (path === '/api/version') body = { version: '1.3.0' }
    else if (/^\/api\/nodes\/\d+\/metrics/.test(path)) {
      const id = Number(path.match(/^\/api\/nodes\/(\d+)\/metrics/)[1])
      const ping = PING[id] ?? { ping: [], probes: {}, loss: {} }
      // 响应形状跟真 hub 对齐：**四个键每次都带齐**（缺键会把切页签炸成整页白，见 verify_detail_charts 的教训）。
      body = url.searchParams.get('series') === 'ping'
        ? { metrics: [], ...ping }
        : { metrics: [], ping: [], probes: {}, loss: {} }
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  serveFile(res, path)
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

/* ------------------------------------------------------------------ 浏览器 */

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((p) => existsSync(p)) || 'chrome'
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--no-proxy-server', '--window-size=1200,1300',
  `--user-data-dir=${join(tmpdir(), `minspan${CDP_PORT}`)}`,
  '--no-sandbox',
  'about:blank',
], { stdio: 'ignore' })

let id = 0
const pending = new Map()
let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl
  } catch { /* 等 Chrome 起来 */ }
  if (!wsUrl) await sleep(250)
}
if (!wsUrl) throw new Error('Chrome 没起来')
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
const errors = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.exception?.description || '异常')
}
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1300, deviceScaleFactor: 2, mobile: false })

const BASE = `http://127.0.0.1:${PORT}`

/** 进详情页并点开「网络延迟」页签，等到曲线真的画出来。 */
async function loadDetail(nodeId) {
  await send('Page.navigate', { url: `${BASE}/node/${nodeId}` })
  await sleep(1300)
  await send('Page.navigate', { url: `${BASE}/node/${nodeId}` })
  let clicked = false
  for (let i = 0; i < 40 && !clicked; i++) {
    await sleep(250)
    clicked = await js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '网络延迟'); if (!b) return false; b.click(); return true })()`)
  }
  for (let i = 0; i < 40; i++) {
    await sleep(300)
    const ok = await js(`(() => { const svg = document.querySelector('svg[aria-label="节点延迟走势"]'); return !!(svg && svg.querySelector('path[stroke-width="1.5"]')) })()`)
    if (ok) { await sleep(250); return true }
  }
  return false
}

/** 详情图读数：Y 刻度、线条高度 / 绘图区高度。 */
const LAT = `(() => {
  const svg = document.querySelector('svg[aria-label="节点延迟走势"]')
  if (!svg) return 'null'
  const ys = [...svg.querySelectorAll('text')].filter((t) => t.getAttribute('text-anchor') === 'end').map((t) => t.textContent)
  const line = svg.querySelector('path[stroke-width="1.5"]')
  const plot = svg.querySelector('rect[fill="transparent"]')
  const lb = line ? line.getBoundingClientRect() : null
  const pb = plot ? plot.getBoundingClientRect() : null
  const nums = ys.map((s) => parseFloat(s)).filter((n) => Number.isFinite(n))
  return JSON.stringify({
    ys,
    tickSpan: nums.length > 1 ? Math.round((Math.max(...nums) - Math.min(...nums)) * 100) / 100 : null,
    lineH: lb ? Math.round(lb.height * 10) / 10 : null,
    plotH: pb ? Math.round(pb.height * 10) / 10 : null,
    frac: lb && pb && pb.height ? Math.round((lb.height / pb.height) * 1000) / 1000 : null,
  })
})()`

/** 卡片走势线读数：按线路名取 polyline 的纵向占高（viewBox 单位，可画区 16）。 */
const CARD_LINES = `(() => {
  const rows = [...document.querySelectorAll('[data-latency] [data-probe-name]')].map((el) => {
    const pl = el.parentElement.querySelector('svg polyline')
    const ys = pl ? (pl.getAttribute('points') || '').trim().split(' ').map((p) => Number(p.split(',')[1])).filter((n) => Number.isFinite(n)) : []
    return { name: el.textContent, extent: ys.length ? Math.round((Math.max(...ys) - Math.min(...ys)) * 100) / 100 : null }
  })
  return JSON.stringify(rows)
})()`

async function shot(name, selector) {
  // 同 verify_detail_charts：★captureBeyondViewport 在无头 + --disable-gpu 下不可靠，
  // 先把目标滚进视口再拍（超出视口的部分会拍到空白）。
  await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el && el.scrollIntoView({ block: 'center' }); return !!el })()`)
  await sleep(350)
  const clip = await js(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.max(0, Math.round(r.x - 8)), y: Math.round(r.y + scrollY - 8), width: Math.round(r.width + 16), height: Math.round(r.height + 16), scale: 2 }
  })()`)
  if (!clip) { console.log(`   （${name}：没找到要拍的区域，跳过）`); return }
  const r = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false })
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.result.data, 'base64'))
  console.log(`   已拍 ${SHOTS}/${name}.png`)
}

/* ------------------------------------------------------------------ ① / ② 详情图 */

console.log(`\n延迟图「最近视距」下限（夹具：稳定线 128~136 / 波动线 20~180；dist 取自当前目录）:`)
const ok1 = await loadDetail(1)
check('详情页（稳定线）曲线画出来了', ok1, '')
const d1 = JSON.parse(await js(LAT) ?? 'null')
check('① 稳定线：轴跨度吃到下限以上（≥ 136×1/4 ≈ 34.2ms）', !!d1 && d1.tickSpan !== null && d1.tickSpan >= 34.2, `刻度 ${JSON.stringify(d1?.ys)}`)
check('① 稳定线：不再怼满全高（线高 ≤ 绘图区 35%）', !!d1 && d1.frac !== null && d1.frac <= 0.35, `线 ${d1?.lineH}px / 绘图区 ${d1?.plotH}px = ${pct(d1?.frac)}`)
check('① 稳定线：也不是一根死线（线高 ≥ 5%）', !!d1 && d1.frac !== null && d1.frac >= 0.05, `= ${pct(d1?.frac)}`)
await shot('detail-stable', 'svg[aria-label="节点延迟走势"]')

const ok2 = await loadDetail(2)
check('详情页（波动线）曲线画出来了', ok2, '')
const d2 = JSON.parse(await js(LAT) ?? 'null')
check('② 波动线：量程没被压（轴跨度 ≥ 数据量程 160ms）', !!d2 && d2.tickSpan !== null && d2.tickSpan >= 160, `刻度 ${JSON.stringify(d2?.ys)}`)
check('② 波动线：照旧满高（线高 ≥ 绘图区 65%）', !!d2 && d2.frac !== null && d2.frac >= 0.65, `= ${pct(d2?.frac)}`)
await shot('detail-wild', 'svg[aria-label="节点延迟走势"]')

/* ------------------------------------------------------------------ ③ 卡片小线 */

await send('Page.navigate', { url: `${BASE}/` })
let cardRows = []
for (let i = 0; i < 40; i++) {
  await sleep(300)
  cardRows = JSON.parse(await js(CARD_LINES) ?? '[]')
  if (cardRows.length >= 2 && cardRows.every((r) => r.extent !== null)) break
}
const stableCard = cardRows.find((r) => r.name === '测试稳定')
const wildCard = cardRows.find((r) => r.name === '测试波动')
check('③ 两张卡各有一行（测试稳定 / 测试波动）', cardRows.length === 2 && !!stableCard && !!wildCard, JSON.stringify(cardRows.map((r) => r.name)))
check('③ 卡片稳定线：占高 ≤ 6/20 单位（同口径、不再怼满）', stableCard?.extent != null && stableCard.extent <= 6, `占高 ${stableCard?.extent}`)
check('③ 卡片稳定线：不至于压成直线（≥ 1.5/20）', stableCard?.extent != null && stableCard.extent >= 1.5, `占高 ${stableCard?.extent}`)
check('③ 卡片波动线：照旧满高（≥ 13/20）', wildCard?.extent != null && wildCard.extent >= 13, `占高 ${wildCard?.extent}`)
await shot('cards', '[data-card-style]')

/* ------------------------------------------------------------------ 手机视口 */

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
await send('Page.navigate', { url: `${BASE}/` })
for (let i = 0; i < 40; i++) {
  await sleep(300)
  if (await js(`document.querySelectorAll('[data-latency] svg polyline').length >= 1`)) break
}
await shot('m-card', '[data-card-style] > *')
const okM = await loadDetail(1)
check('手机视口：详情页稳定线也画出来（截图留档）', okM, '')
await shot('m-detail-stable', 'svg[aria-label="节点延迟走势"]')

check('没有控制台异常', errors.length === 0, errors.slice(0, 2).join(' | '))

console.log(`\n结果: PASS ${passed} / FAIL ${failed}`)
chrome.kill()
server.close()
process.exit(failed ? 1 : 0)

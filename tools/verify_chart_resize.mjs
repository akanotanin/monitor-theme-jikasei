// 详情页图表列「高度按视口剩余撑满」的 RO 护栏：chartTop 要跟着上方信息格的增减重算，
// 而且**切页签之后**仍然有效。
//
// ★为什么单列一条（2026-11-22 三审）：1.37.0 给这一列加了 ResizeObserver，但实现是
//   「effect 首跑后一帧 attach 一次」。这一列只在「网络延迟」页签里存在：
//     · 详情页默认落在「资源」页签 → `chartColRef.current` 还是 null → RO 从未观察任何元素；
//     · 切到延迟再切回来 → 观察的仍是已离线的旧父节点（`disconnect` 掉之后没再 observe）。
//   于是「TCP/UDP 那一格出现/消失时重算 chartTop」只覆盖「?tab=latency 直接进入且不切页签」。
//   修法见 NodeDetail 的 `attachChartObserver`：观察器跟着元素的 callback ref 走。
//
// 判据（只认几何，不认具体数值）：
//   ① 延迟页签下图表列的高度 ≈ 视口 − chartTop − 1rem（它确实是「撑满剩余」的）；
//   ② 把上方信息区撑高 120px（模拟「TCP/UDP 那格出现」这类增减），图表列高度要跟着缩 ≈120px；
//   ③ 从「资源」切到「延迟」之后再做同一件事，仍然跟着变 —— 这一条就是本次修的路径。
//
// 用法：cd <repo> && node tools/verify_chart_resize.mjs（先 npm run build）
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'

const PORT = Number(process.env.CHARTRESIZE_PORT || 5277)
const CDP_PORT = PORT + 4000
const BASE = `http://127.0.0.1:${PORT}`
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2' }
const GB = 1024 ** 3

const node = {
  id: 1, name: '图高探针', sort: 1, public: true, online: true, country: 'JP', group: '',
  last_seen: Math.floor(Date.now() / 1000) - 3, last_seen_ago: 3,
  os: 'Debian GNU/Linux 12 (bookworm)', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm',
  cpu_name: 'AMD EPYC', cpu_cores: 2, mem_total: 2 * GB, swap_total: 0, disk_total: 40 * GB,
  agent_version: '1.4.0', currency: 'CNY', expires_at: '2027-07-21', expires_in: 299,
  metrics: {
    uptime: 318521, cpu: 3.2, load: [0.08, 0.03, 0.01], mem_total: 2 * GB, mem_used: 431800320,
    swap_total: 0, swap_used: 0, disk_total: 40 * GB, disk_used: 9214510720,
    net_rx: 866000, net_tx: 464000, total_rx: 5707805336, total_tx: 5203609923,
    month_rx: 4650258264, month_tx: 4351673970, tcp: 16, udp: 3, procs: 75,
  },
}
const START = Math.floor(Date.now() / 1000) - 6 * 3600
// 延迟数据：两条探测，够画出图（否则落到「这段时间没有延迟数据」，没有图表列）。
const ping = Array.from({ length: 40 }, (_, i) => [
  { ts: START + i * 300, task_id: 1, value: 30 + (i % 5) },
  { ts: START + i * 300, task_id: 2, value: 55 + (i % 7) },
]).flat()
const metrics = Array.from({ length: 40 }, (_, i) => ({
  ts: START + i * 300, cpu: 4 + (i % 7) * 2, load: [0.1, 0.1, 0.1],
  mem_used: 400_000_000 + i * 1_000_000, mem_total: 2 * GB, swap_used: 0, swap_total: 0,
  disk_used: 1_500_000_000, disk_total: 40 * GB, net_rx: 800 + i, net_tx: 400 + i,
  tcp: 16, udp: 3, procs: 75,
}))

const server = createServer((req, res) => {
  const url = new URL(req.url, BASE)
  const path = url.pathname
  if (path.startsWith('/api/')) {
    let body = {}
    if (path === '/api/me') body = { authed: false, github: false, public_page: true, site: BASE, site_name: '图高探针', history_days: 7 }
    else if (path === '/api/nodes') body = { nodes: [node] }
    else if (path.includes('/config')) body = { cardStyle: 'plain', listTop: 'none' }
    else if (path === '/api/version') body = { version: '1.5.2' }
    else if (path.includes('/metrics')) body = { metrics, ping, probes: { 1: '线路甲', 2: '线路乙' }, loss: {} }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  const file = path === '/' ? '/index.html' : path
  const full = join('dist', normalize(file).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(full) || statSync(full).isDirectory()) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] })
    return res.end(readFileSync('dist/index.html'))
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(full)] || 'application/octet-stream' })
  res.end(readFileSync(full))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const profile = join(tmpdir(), `jikasei-chartresize-${Date.now()}`)
mkdirSync(profile, { recursive: true })
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const chrome = spawn(chromePath, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1280,900', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', 'about:blank',
], { stdio: 'ignore' })

let dbg = null
for (let i = 0; i < 100 && !dbg; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    dbg = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl
  } catch { }
  if (!dbg) await sleep(300)
}
if (!dbg) throw new Error('Chrome 起不来')

const ws = new WebSocket(dbg)
await new Promise((r) => { ws.onopen = r })
let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
}
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value

await send('Page.enable')
await send('Runtime.enable')

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); pass += ok ? 1 : 0; fail += ok ? 0 : 1 }

/**
 * 图表列（延迟页签那一列）的高度与 top。它没有 data 锚点，用「装了 svg[aria-label=节点延迟走势]
 * 的那一列的最近一个带内联 height 的祖先」定位 —— 那正是 `style={{height: calc(100svh - …)}}`。
 */
const COL = `(() => {
  const svg = document.querySelector('svg[aria-label="节点延迟走势"]')
  if (!svg) return null
  let el = svg.parentElement
  while (el && !el.style.height) el = el.parentElement
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { height: Math.round(r.height), top: Math.round(r.top + scrollY), inline: el.style.height }
})()`

const clickTab = (label) => js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)}); b && b.click(); return !!b })()`)
const waitChart = async () => {
  for (let i = 0; i < 40; i++) {
    if (await js('document.querySelector(\'svg[aria-label="节点延迟走势"]\') !== null')) return true
    await sleep(250)
  }
  return false
}

await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })

// ── ① 直接以资源页签进入，再切到延迟（这是报告说的「未被覆盖」的那条路）──
await send('Page.navigate', { url: `${BASE}/node/1` })
for (let i = 0; i < 60; i++) { if (await js('document.querySelector(\'[data-remark-block]\') !== null || document.querySelector(\'svg[aria-label="节点延迟走势"]\') !== null || document.querySelectorAll(\'[data-chart] svg\').length > 0')) break; await sleep(250) }
await sleep(700)
const onResources = await js('document.querySelector(\'svg[aria-label="节点延迟走势"]\') === null')
check('起点：默认落在「资源」页签（还没有延迟图表列）', onResources === true, `onResources=${onResources}`)

await clickTab('网络延迟')
check('切到「网络延迟」：图表画出来了', await waitChart())
await sleep(500)
const before = await js(COL)
check('① 延迟图表列按「视口剩余」撑满（高度 = 视口 − top − 1rem 的近似）',
  !!before && Math.abs(before.height - (900 - before.top - 16)) <= 2, JSON.stringify(before))

// ── ② 把上方信息区撑高 120px，模拟「TCP/UDP 那一格出现」──（切页签之后的路径）
const grow = `(() => {
  const svg = document.querySelector('svg[aria-label="节点延迟走势"]')
  if (!svg) return 'no-svg'
  // 找那一列（带内联 height 的祖先），把撑高块插到它**前面** —— 模拟「上面的信息格多一格」。
  let col = svg.parentElement
  while (col && !col.style.height) col = col.parentElement
  if (!col || !col.parentElement) return 'no-col'
  const pad = document.createElement('div')
  pad.id = 'probe-pad'
  pad.style.height = '120px'
  col.parentElement.insertBefore(pad, col)
  return 'ok'
})()`
const grew = await js(grow)
await sleep(600)
const after = await js(COL)
// 撑高 120px 会同时多出一个父级 gap（space-y-*），实测总位移 ≈136px —— 判据取 118~150。
const shrink = before && after ? before.height - after.height : null
check('② 上方撑高 120px：图表列跟着缩短（120 + 父级 gap，实测 ≈136）',
  grew === 'ok' && !!after && shrink !== null && shrink >= 118 && shrink <= 150,
  `grow=${grew} before=${before?.height} after=${after?.height} 差=${shrink ?? 'n/a'}`)
await js('document.getElementById(\'probe-pad\')?.remove()')
await sleep(500)

// ── ③ 在「资源」与「延迟」之间往返后再做一次：这一条是本次修的路径（旧实现在这里失效）──
await clickTab('资源')
await sleep(600)
await clickTab('网络延迟')
await waitChart()
await sleep(600)
const before2 = await js(COL)
const grew2 = await js(grow)
await sleep(600)
const after2 = await js(COL)
check('③★ 页签往返之后再撑高 120px：图表列仍然跟着缩短（旧实现：RO 盯着已离线的旧父节点）',
  grew2 === 'ok' && !!before2 && !!after2 && (() => { const d = before2.height - after2.height; return d >= 118 && d <= 150 })(),
  `before=${before2?.height} after=${after2?.height} 差=${before2 && after2 ? before2.height - after2.height : 'n/a'}`)

// ── ④ 窗口缩放（window.resize 那条老路）──
await js('document.getElementById(\'probe-pad\')?.remove()')
await sleep(400)
const before3 = await js(COL)
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 700, deviceScaleFactor: 1, mobile: false })
await sleep(700)
const after3 = await js(COL)
check('④ 视口从 900 缩到 700：图表列照样跟着缩（window.resize 这条路没坏）',
  !!before3 && !!after3 && Math.abs((before3.height - after3.height) - 200) <= 8,
  `before=${before3?.height} after=${after3?.height} 差=${before3 && after3 ? before3.height - after3.height : 'n/a'}`)

console.log(`\n结果: PASS ${pass} / FAIL ${fail}`)
ws.close()
chrome.kill()
server.close()
process.exit(fail ? 1 : 0)

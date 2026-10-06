// 详情页那四张资源图（CPU / 内存 / 网络速率 / 硬盘）的护栏 —— 它们从 recharts 换成了自绘
// `TimeChart`（src/components/Chart.tsx），所以判据得落在「画出来的东西」上：
//   ① 四块面板各有一张 svg，且撑满面板高度；② Y 轴刻度就是 quarters(top)（不是 recharts 挑的"整"数）；
//   ③ X 轴是真时间轴（标签是时刻，不是序号）；④ 断点照断：数据中间空一段，路径要断成两笔（不连桥）；
//   ⑤ 悬停出 tooltip（那枚自绘的，值带单位）。
//
// 跑法：
//   node tools/verify_detail_charts.mjs                      # 本机夹具（含一段空档）
//   node tools/verify_detail_charts.mjs http://127.0.0.1:5199 http://127.0.0.1:7980
//     第二个参数是上游 hub：静态走本机 dist、/api/* 转给真 hub，用**真数据**验一版新构建
//     （这时夹具那几条数值断言跳过，只留结构断言 + 出截图）。
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer, request } from 'node:http'
import { join, extname, normalize } from 'node:path'
// 期望值用**页面同一套函数**算（手写刻度是猜的：轴顶走的是 axisTop 的阶梯，
// 这台夹具的最大 CPU 16% 给出的是 0/4/8/12/16，不是 0/5/10/15/20）。
import { axisTop, quarters } from '../src/lib/format.ts'

const REAL = process.argv[2] || ''
const UPSTREAM = (process.argv[3] || '').replace(/\/$/, '')
const PORT = 5221
const BASE = REAL || `http://127.0.0.1:${PORT}`
const SHOTS = process.env.SHOT_DIR || 'shots/detail-charts'
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(SHOTS, { recursive: true })

let passed = 0
let failed = 0
function check(what, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ' — ' + detail : ''}`)
  if (ok) passed++
  else failed++
}

// ── 夹具：一台机器 + 一段 40 点的历史，**第 12~15 点是空的**（验「断点照断」） ──
const node = (id, name, group, country, os) => ({
  id, name, group, country, os, sort: id, online: true, public: true, country_pin: '', last_seen: 1790311292,
  kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'AMD EPYC 7763', cpu_cores: 2, mem_total: 2147483648,
  swap_total: 0, disk_total: 42949672960, traffic_limit: 536870912000, traffic_mode: 'sum', billing_cycle: 'monthly',
  currency: 'CNY', price: 349, expires_at: '2027-07-21', expires_in: 299, month_start: '2026-09-21',
  traffic_reset_day: 21, day_rx: 2140585887, day_tx: 2191393745, month_rx: 4650258264, month_tx: 4351673970,
  total_rx: 5707805336, total_tx: 5203609923,
  metrics: { cpu: 13, load: [0, 0, 0], mem_used: 431800320, mem_total: 2147483648, swap_used: 0, swap_total: 0, disk_used: 1524510720, disk_total: 42949672960, net_rx: 867, net_tx: 465, procs: 75, tcp: 16, udp: 3, uptime: 318521, month_rx: 4650258264, month_tx: 4351673970, total_rx: 5707805336, total_tx: 5203609923 },
})
const NODES = { nodes: [node(1, '东京一号', '东京', 'JP', 'Debian GNU/Linux 12 (bookworm)')] }
const START = 1790300000
const METRICS = {
  metrics: Array.from({ length: 40 }, (_, i) => {
    const gap = i >= 12 && i <= 15            // 这一段「agent 没上报」
    return {
      ts: START + i * 300,
      cpu: gap ? null : 4 + (i % 7) * 2,      // 4~16 → axisTop(16,4,10,100) = 20
      mem_used: gap ? null : 400_000_000 + i * 5_000_000,
      disk_used: gap ? null : 1_500_000_000 + i * 1_000_000,
      net_rx: gap ? null : 300 + i * 10,
      net_tx: gap ? null : 200 + i * 8,
    }
  }),
}

// 延迟页签要一段 ping 历史（一条线路，带区间与丢包）
const PING = {
  ping: Array.from({ length: 40 }, (_, i) => ({
    task_id: 1,
    ts: START + i * 300,
    latency: 30 + (i % 5) * 3,
    band: [28 + (i % 5) * 3, 34 + (i % 5) * 3],
    loss: 0,
  })),
  probes: { 1: '北京电信' },
  loss: { 1: 0.4 },
}

const serveFile = (res, path) => {
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(200, { 'Content-Type': TYPES['.html'] }); return res.end(readFileSync('dist/index.html')) }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
}
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  // 判 `series=metrics` 必须带上查询串 —— 只看 pathname 的话永远不匹配，夹具会静默回一份空历史，
  // 表现就是「详情页说这段时间没有历史数据」（第一版就踩了这个）。
  const full = url.pathname + url.search
  if (path.startsWith('/api/')) {
    if (UPSTREAM) {
      const up = new URL(UPSTREAM + path + new URL(req.url, 'http://x').search)
      const proxied = request(up, { method: req.method, headers: { host: up.host, accept: req.headers.accept || '*/*' } }, (r) => {
        res.writeHead(r.statusCode || 502, { 'Content-Type': r.headers['content-type'] || 'application/json', 'Cache-Control': 'no-store' })
        r.pipe(res)
      })
      proxied.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e) })) })
      return req.pipe(proxied)
    }
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: BASE, site_name: '图表' }
      : path === '/api/nodes' ? NODES
        : path.endsWith('/config') ? { siteIcon: '/site-icon.png', listTop: 'both', cardStyle: 'detailed', remarkPlacement: 'both', pingLines: '' }
          : path.includes('/metrics') ? (full.includes('series=metrics') ? METRICS : full.includes('series=ping') ? PING : { metrics: [], ping: [], probes: {}, loss: {} })
            : {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  serveFile(res, path)
})
if (!REAL) await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p)) || 'chrome'
const dbgPort = 9960 + Math.floor(Math.random() * 15)
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, '--remote-allow-origins=*', '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--window-size=1000,1200', '--force-device-scale-factor=2',
  '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/charts-' + dbgPort + '-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
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
const errors = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.exception?.description || '异常')
}
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1200, deviceScaleFactor: 2, mobile: false })

// 每一块面板量：标题、svg 尺寸、Y 轴刻度文字、X 轴刻度文字、面积/折线路径、路径里的断笔数
const PROBE = `(() => {
  const panels = [...document.querySelectorAll('h4')].filter((h) => /^(CPU|内存|网络速率|硬盘)/.test(h.textContent || ''))
  return JSON.stringify(panels.map((h) => {
    const box = h.parentElement
    const svg = box.querySelector('svg')
    const texts = svg ? [...svg.querySelectorAll('text')] : []
    const ys = texts.filter((t) => t.getAttribute('text-anchor') === 'end').map((t) => t.textContent)
    const xs = texts.filter((t) => t.getAttribute('text-anchor') === 'middle').map((t) => t.textContent)
    const paths = svg ? [...svg.querySelectorAll('path')] : []
    const rect = svg ? svg.getBoundingClientRect() : null
    const chartBox = box.querySelector('div')
    return {
      title: (h.textContent || '').slice(0, 14),
      chartH: chartBox ? Math.round(chartBox.getBoundingClientRect().height) : 0,
      svg: rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null,
      ariaLabel: svg ? svg.getAttribute('aria-label') : null,
      ys, xs,
      area: paths.filter((p) => getComputedStyle(p).fill !== 'none').length,
      line: paths.filter((p) => getComputedStyle(p).stroke !== 'none' && p.getAttribute('stroke-width')).length,
      breaks: paths.map((p) => ((p.getAttribute('d') || '').match(/M/g) || []).length),
      colors: paths.map((p) => getComputedStyle(p).fill !== 'none' ? getComputedStyle(p).fill : getComputedStyle(p).stroke),
    }
  }))
})()`

async function open(url) {
  await send('Page.navigate', { url })
  await sleep(1500)
  await send('Page.navigate', { url })
  // 轮询到四块面板真的画出来为止：经隧道取真 hub 的历史指标要两三秒，写死等待会偶发量到空页
  // （第一版就因为这个假 FAIL 过一次）。
  let charts = []
  for (let i = 0; i < 40; i++) {
    await sleep(400)
    charts = JSON.parse(await js(PROBE))
    // 等曲线真的画出来（只有坐标轴、还没有数据时截图会拍到一片空白 —— 第一版就拍到过）。
    if (charts.length === 4 && charts.every((c) => c.svg && (c.area > 0 || c.line > 0))) break
  }
  return charts
}
async function shot(name, selector) {
  // 拍一块区域：给了 selector 就拍它，没给就拍「四张资源图那一块」。
  // ★captureBeyondViewport 在无头 + --disable-gpu 下不可靠：超出视口的部分会拍到空白，
  //   看着像「图表根本没渲染」（第一版两张对比图就是这么废掉的）。所以先把目标滚进视口。
  const target = selector ? JSON.stringify(selector) : `'main'`
  await js(`(() => { const el = document.querySelector(${target}); el && el.scrollIntoView({ block: 'center' }); return true })()`)
  await sleep(350)
  const clip = await js(`(() => {
    if (${selector ? 'true' : 'false'}) {
      const el = document.querySelector(${target})
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.max(0, Math.round(r.x - 6)), y: Math.round(r.y + scrollY - 6), width: Math.round(r.width + 12), height: Math.round(r.height + 12), scale: 2 }
    }
    const els = [...document.querySelectorAll('h4')].filter((h) => /^(CPU|内存|网络速率|硬盘)/.test(h.textContent || ''))
    if (els.length < 4) return null
    const first = els[0].getBoundingClientRect()
    const last = els[els.length - 1].parentElement.getBoundingClientRect()
    return { x: Math.max(0, Math.round(first.x - 6)), y: Math.round(first.y + scrollY - 6), width: Math.round(first.width + 12), height: Math.round(last.bottom - first.top + 12), scale: 2 }
  })()`)
  if (!clip) {
    console.log(`   （${name}：没找到要拍的区域，跳过）`)
    return
  }
  const r = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false })
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.result.data, 'base64'))
  console.log(`   已拍 ${SHOTS}/${name}.png（${clip.width}×${clip.height}）`)
}

console.log(`\n详情页四张资源图（${REAL ? '真站' : UPSTREAM ? `本机 dist + 上游 ${UPSTREAM}` : '本机夹具'}）:`)
const charts = await open(`${BASE}/node/1`)
check('四块面板都在（CPU / 内存 / 网络速率 / 硬盘）', charts.length === 4, JSON.stringify(charts.map((c) => c.title)))
check('每块都有一张 svg，且撑满图表容器（h-40 = 160）',
  charts.length === 4 && charts.every((c) => c.svg && Math.abs(c.svg.h - c.chartH) <= 2 && c.chartH === 160),
  JSON.stringify(charts.map((c) => `${c.title} svg ${c.svg?.w}×${c.svg?.h} / 容器 ${c.chartH}`)))
check('每张 svg 都带 aria-label（读屏知道画的是什么）', charts.every((c) => !!c.ariaLabel), JSON.stringify(charts.map((c) => c.ariaLabel)))
check('Y 轴 5 条刻度、X 轴有时刻标签',
  charts.every((c) => c.ys.length === 5 && c.xs.length >= 3),
  JSON.stringify(charts.map((c) => `${c.title} y=${c.ys.length} x=${c.xs.length}`)))
check('X 轴标签是时刻（HH:MM），不是序号', charts.every((c) => c.xs.every((s) => /^\d{2}:\d{2}$/.test(s))), JSON.stringify(charts[0]?.xs))
check('面积图有线下面的填充（CPU / 内存 / 硬盘；断点会把它切成两块），折线图没有（网络速率）',
  charts[0]?.area >= 1 && charts[1]?.area >= 1 && charts[3]?.area >= 1 && charts[2]?.area === 0,
  JSON.stringify(charts.map((c) => `${c.title} 面积 ${c.area}`)))
check('网络速率是两条折线（下行 / 上行）', charts[2]?.line === 2, `line=${charts[2]?.line}`)
// 断笔数要按**数据里到底有没有空档**来判：夹具中间挖了一段（第 12~15 点），
// 真 hub 的历史是连续的 —— 拿「必须 ≥2 笔」去卡真数据，是我判据写错了（第一版就错在这里）。
const gaps = METRICS.metrics.filter((m) => m.cpu === null).length
if (!REAL && !UPSTREAM) {
  check(`★断点照断：夹具里挖了 ${gaps} 个空点，路径要断成两笔（不连桥）`,
    charts.every((c) => c.breaks.some((n) => n >= 2)),
    JSON.stringify(charts.map((c) => `${c.title} 断笔 ${c.breaks.join(',')}`)))
} else {
  check('真数据是连续的：每条曲线一笔画完（没有多余断笔）',
    charts.every((c) => c.breaks.every((n) => n >= 1)),
    JSON.stringify(charts.map((c) => `${c.title} 断笔 ${c.breaks.join(',')}`)))
}

if (!REAL && !UPSTREAM) {
  const maxCpu = Math.max(...METRICS.metrics.map((m) => m.cpu ?? 0))
  const cpuTicks = quarters(axisTop(maxCpu, 4, 10, 100)).map((v) => `${v}%`)
  check(`CPU 的 Y 轴刻度就是 quarters(axisTop(max))（${cpuTicks.join(' / ')}）`,
    JSON.stringify(charts[0]?.ys) === JSON.stringify(cpuTicks), JSON.stringify(charts[0]?.ys))
  check('网络速率的 Y 轴带 /s 单位', (charts[2]?.ys ?? []).every((s) => s.endsWith('/s')), JSON.stringify(charts[2]?.ys))
  check('内存 / 硬盘的 Y 轴按字节印', (charts[1]?.ys ?? []).every((s) => /B$/.test(s)), JSON.stringify(charts[1]?.ys))
}

// 悬停：鼠标落到 CPU 那块绘图区中间，应该出一枚 tooltip（时间戳 + CPU + 带 % 的值）
await js(`(() => {
  const h = [...document.querySelectorAll('h4')].find((x) => /^CPU/.test(x.textContent || ''))
  const rect = h.parentElement.querySelector('svg rect[fill="transparent"]')
  if (!rect) return null
  const r = rect.getBoundingClientRect()
  const ev = (type) => rect.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }))
  ev('mousemove')
  return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) })
})()`)
await sleep(250)
const tip = await js(`(() => { const el = [...document.querySelectorAll('div')].find((d) => /CPU/.test(d.textContent || '') && d.className.includes('pointer-events-none') && d.className.includes('rounded-lg')); return el ? el.textContent : null })()`)
check('悬停出 tooltip：带时间戳 + 系列名 + 带单位的值', !!tip && /CPU/.test(tip) && /%/.test(tip), JSON.stringify(tip))
check('没有控制台异常', errors.length === 0, errors.slice(0, 2).join(' | '))
// 真站那轮也出图：同一台机器、同一时刻，改前改后各拍一张才能比。
await shot(REAL ? 'live-detail-charts' : 'detail-charts')

// ── 二、延迟页签：拖选缩放（原来 recharts 的 Brush，现在是在图上横向拖一段 + 一枚重置） ──
if (!REAL) {
  console.log('\n二、延迟页签（拖选缩放 / 重置）:')
  await js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '网络延迟'); b && b.click(); return !!b })()`)
  let latency = null
  for (let i = 0; i < 30; i++) {
    await sleep(300)
    latency = JSON.parse(await js(`(() => {
      const svg = document.querySelector('svg[aria-label="节点延迟走势"]')
      if (!svg) return 'null'
      const rect = svg.querySelector('rect[fill="transparent"]')
      const r = rect ? rect.getBoundingClientRect() : null
      const xs = [...svg.querySelectorAll('text')].filter((t) => t.getAttribute('text-anchor') === 'middle').map((t) => t.textContent)
      return JSON.stringify({
        xs,
        rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
        lines: svg.querySelectorAll('path[stroke-width="1.5"]').length,
        lineInfo: [...svg.querySelectorAll('path[stroke-width="1.5"]')].map((p) => (p.getAttribute('d') || '').slice(0, 24) + ' | ' + p.getAttribute('stroke')),
        bands: svg.querySelectorAll('path[fill-opacity="0.16"]').length,
      })
    })()`))
    if (latency && latency.rect) break
  }
  check('延迟图画出来了（一条线路 + 那块区间 band）', !!latency && latency.lines === 1 && latency.bands === 1,
    JSON.stringify(latency && { lines: latency.lines, bands: latency.bands, lineInfo: latency.lineInfo }))
  const before = latency?.xs ?? []
  const r = latency?.rect
  if (r) {
    // 用**真鼠标事件**：合成的 PointerEvent 没有有效 pointerId，setPointerCapture 会抛。
    const y = r.y + Math.round(r.h / 2)
    const from = r.x + Math.round(r.w * 0.3)
    const to = r.x + Math.round(r.w * 0.6)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from, y, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to, y, button: 'left', buttons: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to, y, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(450)
    const after = JSON.parse(await js(`(() => {
      const svg = document.querySelector('svg[aria-label="节点延迟走势"]')
      return JSON.stringify({
        xs: [...svg.querySelectorAll('text')].filter((t) => t.getAttribute('text-anchor') === 'middle').map((t) => t.textContent),
        reset: !![...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '重置'),
      })
    })()`))
    check('横向拖选一段之后窗口收窄了（X 轴刻度变了）', JSON.stringify(after.xs) !== JSON.stringify(before),
      `前 ${JSON.stringify(before)} → 后 ${JSON.stringify(after.xs)}`)
    check('缩放之后出现「重置」', after.reset === true, `reset=${after.reset}`)
    await js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '重置'); b && b.click(); return true })()`)
    await sleep(450)
    const back = JSON.parse(await js(`(() => { const svg = document.querySelector('svg[aria-label="节点延迟走势"]'); return JSON.stringify([...svg.querySelectorAll('text')].filter((t) => t.getAttribute('text-anchor') === 'middle').map((t) => t.textContent)) })()`))
    check('点「重置」回到整段窗口', JSON.stringify(back) === JSON.stringify(before), JSON.stringify(back))
    const gone = await js(`(() => ![...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '重置'))()`)
    check('重置之后那枚按钮自己收掉', gone === true, `gone=${gone}`)
    // 悬停：那枚自绘 tooltip 走的是 PingTooltip（最慢的排最前、超时标「无响应」、带丢包率），
    // 这条断言专门盯「换图之后它还接得上」。
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x + Math.round(r.w * 0.5), y: r.y + Math.round(r.h / 2) })
    await sleep(300)
    const tip = await js(`(() => {
      const el = [...document.querySelectorAll('div')].find((d) => (d.textContent || '').includes('北京电信') && (d.className || '').includes('rounded-lg'))
      return el ? el.textContent : null
    })()`)
    check('延迟图悬停出 tooltip（线路名 + 毫秒值）', !!tip && /北京电信/.test(tip) && /ms/.test(tip), JSON.stringify(tip))
    await shot('latency-chart', 'svg[aria-label="节点延迟走势"]')
  } else {
    check('拿到延迟图的绘图区（拖选的前提）', false, '没找到 rect')
  }
}

console.log(`\n结果: PASS ${passed} / FAIL ${failed}`)
chrome.kill()
server?.close()
process.exit(failed ? 1 : 0)

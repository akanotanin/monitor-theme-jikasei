// 标签页标题的验收：把一次加载里 <title> 的每一次变化连时间点录下来，
// 断言「刷新时一次到位、不再出现中间态」，以及详情页标题是「节点名 · 站名」。
//
// 用法：node tools/verify_title.mjs ['站名'] [baseUrl]
//   不给 baseUrl：本机起一个静态+桩接口的服务器（不经隧道），跑三种情况。
//   给了 baseUrl：直接打在真 hub 上（只做「刷新一次到位」与「详情页」两项，仍需你告知站名）。
//
// 环境变量 TITLE_PROBE_FILE_MS（默认 150）：人为拖慢 /title-probe.js 这个独立文件的响应，
// 模拟线上「访客要多等一次往返才轮到它改标题」——内联那一段有没有真的顶上，就靠它验。
//
// 为什么能这么录：标题的三次写入发生在三个地方（静态 HTML、App 的 effect、缓存里的旧值），
// headless 里靠 Page.addScriptToEvaluateOnNewDocument 在文档刚建好时挂一个 5ms 的轮询，
// 记下每一次真的变了的时间点——肉眼看到的那几跳，就是这几条记录。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const SITE = process.argv[2] || "自家の探针"
const PORT = 5200
// 每一步等页面安静的时长。本机毫秒级就够；经隧道打真 hub 时要给大些（隧道一小文件要秒级）。
const SETTLE = Number(process.env.TITLE_WAIT_MS || 4000)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }
const node = (id, name, group) => ({
  id, name, group, online: true, public: true, sort: id, country: 'JP', country_pin: '', os: 'Debian GNU/Linux 12 (bookworm)',
  virt: 'vm', arch: 'x86_64', cpu_name: 'AMD EPYC Processor', cpu_cores: 1, kernel: '6.1.0-53-cloud-amd64', agent_version: '1.0.0',
  mem_total: 1020526592, swap_total: 0, disk_total: 10485864448, traffic_limit: 536870912000, traffic_mode: 'sum',
  billing_cycle: 'yearly', currency: 'CNY', price: 349, expires_at: '2027-07-21', expires_in: 299, month_start: '2026-09-21', traffic_reset_day: 21,
  day_rx: 2140585887, day_tx: 2191393745, month_rx: 4650258264, month_tx: 4351673970, total_rx: 5707805336, total_tx: 5203609923, last_seen: 1790311292,
  metrics: { cpu: 0, load: [0, 0, 0], mem_used: 431800320, mem_total: 1020526592, swap_used: 0, swap_total: 0, disk_used: 1524510720, disk_total: 10485864448, net_rx: 867, net_tx: 465, procs: 75, tcp: 16, udp: 3, uptime: 318521, month_rx: 4650258264, month_tx: 4351673970, total_rx: 5707805336, total_tx: 5203609923 },
})
const NODES = { nodes: [node(1, '节点一', '东京'), node(2, '节点二', '')] }

// 内联脚本那条 /api/me 带 ?theme-title=1（hub 不看查询串），可以单独被拖慢：
// 让 App 先写好「节点名 · 站名」、内联那条随后才回来，就能稳定地造出「迟到的响应」竞态。
let titleProbeDelay = 0
let titleProbeHits = 0            // 内联那条请求真发出去几次（防止这一项空跑）
// /title-probe.js 是**独立文件**，线上实测访客要多等一次往返（164ms）才轮到它改标题，
// 那段时间标签页上就是占位值。本机是毫秒级、量不出这个差，所以按线上量级人为拖慢它——
// 「缓存那一段有没有走内联」这件事只有这样才验得出来。
const PROBE_FILE_DELAY = Number(process.env.TITLE_PROBE_FILE_MS || 150)
let probeFileHits = 0
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
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  if (path.startsWith('/api/')) {
    if (path === '/api/me') {
      const reply = () => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: SITE }))
      }
      if (req.url.includes('theme-title')) titleProbeHits++
      const late = titleProbeDelay && req.url.includes('theme-title')
      return late ? void setTimeout(reply, titleProbeDelay) : void reply()
    }
    const body = path === '/api/nodes' ? NODES
      : path.endsWith('/config') ? {}
      : path.includes('/metrics') ? { metrics: [], probes: [], loss: {} } : { nodes: [] }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  if (path === '/title-probe.js') { probeFileHits++; if (PROBE_FILE_DELAY) return void setTimeout(() => serveFile(res, path), PROBE_FILE_DELAY) }
  serveFile(res, path)
})
const BASE = process.argv[3] || `http://127.0.0.1:${PORT}`
// 打在真 hub 上时：桩服务器的计数和假节点名都不适用，只留「刷新一次到位」这几项。
const REAL_HUB = !!process.argv[3]
if (!process.argv[3]) {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
  console.log(`dist/ 伺服在 ${BASE}/  站名=${SITE}`)
} else {
  console.log(`直接打真 hub: ${BASE}  站名=${SITE}（本机不伺服 dist）`)
}

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p)) || 'chrome'
let chrome, dbgPort, wsUrl = null
for (let attempt = 0; attempt < 2 && !wsUrl; attempt++) {
  dbgPort = 9920 + Math.floor(Math.random() * 60)
  chrome?.kill()
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, '--remote-allow-origins=*',
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/titlecheck-' + dbgPort + '-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch {}
    if (!wsUrl) await sleep(300)
  }
}
if (!wsUrl) throw new Error('Chrome 起不来：先看看是不是堆了太多测试实例（按 --user-data-dir 前缀清一遍）')

let id = 0
const pending = new Map()
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')

// 文档一建好就装上记录器：5ms 轮一次 document.title，变了就连时刻记下来。
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__titleLog = []
  let __last = null
  setInterval(() => {
    const t = document.title
    if (t !== __last) { __last = t; window.__titleLog.push([Math.round(performance.now()), t]) }
    // App 什么时候接手的（src/App.tsx 写标题前会置这个标志）——用来判断标题是不是
    // 由那条「早问」的路贴上的，而不是等 App 把入口包跑完才写。
    if (window.__titleOwned && !window.__ownedAt) window.__ownedAt = Math.round(performance.now())
  }, 5)` })

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }
const log = async () => (JSON.parse(await js('JSON.stringify(window.__titleLog || [])')) || []).filter(([, t]) => t !== '')
const show = (lines) => lines.map(([t, title]) => `    +${String(t).padStart(5)}ms  ${title}`).join('\n')
// App 什么时候接手的（每次导航后重置）。判据用它而不是绝对毫秒：绝对值随链路浮动，
// 而「标题是在 App 接手之前就贴上的吗」与链路无关。
const ownedAt = async () => Number(await js('window.__ownedAt || 0'))

// 一、首次访问：这个 origin 上还没有缓存（全新 profile），静态 HTML 只能先给占位值，
//    内联脚本会抢在入口包之前去问一次 /api/me，所以这一跳应当发生得很早。
await send('Page.navigate', { url: `${BASE}/` })
await sleep(SETTLE)
let lines = await log()
let owned = await ownedAt()
console.log(`\n首次访问（无缓存）:\n${show(lines)}` + `\n    App 接手=${owned || '—'}ms`)
check('首次访问末值 = 站名', lines.at(-1)?.[1] === SITE, `末值=${lines.at(-1)?.[1]}`)
check('首次访问里没有主题名那一跳（jikasei）', !lines.some(([, t]) => t.includes('jikasei')))
check('首次访问最多一跳（占位值 → 站名）', lines.length <= 2, `${lines.length} 条记录`)
console.log(`    占位值存活 ${lines.length > 1 ? lines[1][0] - lines[0][0] : 0}ms（跳变点 ${lines[1]?.[0] ?? '—'}ms）`)
// 用机制断言而不是时间断言：时间随机器/链路浮动，而「那条早问的请求发没发」是确定的。
// （打真 hub 时这条跳过：请求进了 hub，本机桩服务器数不到。）
check('首次访问的站名是在 App 接手之前贴上的（占位值不必等到入口包执行完）',
  owned > 0 && (lines.at(-1)?.[0] ?? 0) <= owned, `跳变 ${lines.at(-1)?.[0]}ms vs App 接手 ${owned}ms`)
if (!REAL_HUB) check('首次访问时早问那条 /api/me 真的发出去了（占位值不必等到入口包执行完）',
  titleProbeHits >= 1, `${titleProbeHits} 次`)
const probesAfterFirstVisit = titleProbeHits

// 二、刷新：这次 localStorage 里已经有站名了，首帧就该是真站名——不该再有可见跳变。
await send('Page.reload')
await sleep(SETTLE)
lines = await log()
owned = await ownedAt()
console.log(`\n刷新（有缓存）:\n${show(lines)}` + `\n    App 接手=${owned || '—'}ms`)
check('刷新后末值 = 站名', lines.at(-1)?.[1] === SITE, `末值=${lines.at(-1)?.[1]}`)
// 站长反馈的正是这一条：刷新时标签页先亮出占位值（"Monitor"），几百毫秒后才跳成自己设的站名。
// 根因不是那三跳本身，而是缓存那一段写在**独立文件**里，要多等一次往返（线上实测 164ms）——
// 占位值就先被画上去了。判据：第一条记录直接就是站名，且来源是内联那一段。
check('刷新时第一条记录就是站名（占位值一次都没被画出来）',
  lines[0]?.[1] === SITE, `首帧=${lines[0]?.[1]}（共 ${lines.length} 条：${lines.map(([, t]) => t).join(' → ')}）`)
const titleSource = await js('window.__titleProbeSource || "(未设)"')
check('刷新时是内联那一段贴上的（不等那次额外往返）', titleSource === 'inline', `来源=${titleSource}`)
check('那一项不是空跑：被拖慢的 /title-probe.js 确实被请求过（模拟线上的额外往返）',
  REAL_HUB || probeFileHits >= 1, `${probeFileHits} 次`)
check('刷新时站名也是 App 接手之前就贴上的（没在等那个大包）',
  owned > 0 && (lines.at(-1)?.[0] ?? 0) <= owned, `落定 ${lines.at(-1)?.[0]}ms vs App 接手 ${owned}ms`)
if (!REAL_HUB) check('刷新时没有再多问一次（缓存命中就不发那条请求了）',
  titleProbeHits === probesAfterFirstVisit, `首次访问后 ${probesAfterFirstVisit} 次 → 现在 ${titleProbeHits} 次`)

if (REAL_HUB) {
  console.log(`\n（打真 hub：桩服务器的计数与假节点名都不适用，详情页两项已跳过）`)
  console.log(`\n结果: PASS ${pass} / FAIL ${fail}`)
  ws.close(); chrome.kill(); process.exit(fail ? 1 : 0)
}

// 三、详情页：标题要变成「节点名 · 站名」，首帧仍是站名（缓存），随后补上节点名。
await send('Page.navigate', { url: `${BASE}/node/1` })
await sleep(SETTLE)
lines = await log()
console.log(`\n详情页 /node/1:\n${show(lines)}`)
check('详情页末值 = 节点名 · 站名', lines.at(-1)?.[1] === `节点一 · ${SITE}`, `末值=${lines.at(-1)?.[1]}`)
check('详情页首帧是站名（用的缓存，不是空窗）', lines[0]?.[1] === SITE, `首帧=${lines[0]?.[1]}`)

// 四、详情页 + 把内联那次 /api/me 拖到 1.5s 之后：App 早就写好了「节点名 · 站名」，
//    迟到的响应若还去改标题，就会把节点名抹掉——这里断言它没有（靠 window.__titleOwned）。
// 清缓存必须在**新文档的内联脚本跑之前**：App 会随手把缓存写回，在旧文档里 clear 会被它补上。
await send('Page.addScriptToEvaluateOnNewDocument', { source: 'try { localStorage.clear() } catch (e) {}' })
titleProbeDelay = 1500
titleProbeHits = 0
await send('Page.navigate', { url: `${BASE}/node/1` })
await sleep(6000)
lines = await log()
console.log(`\n详情页 + 内联那条 /api/me 迟到 1.5s:\n${show(lines)}`)
check('内联那条迟到的请求真的发出去了（这一项不是空跑）', titleProbeHits >= 1, `${titleProbeHits} 次`)
check('迟到的内联响应没把标题盖回纯站名', lines.at(-1)?.[1] === `节点一 · ${SITE}`, `末值=${lines.at(-1)?.[1]}`)
check('迟到的响应没再动标题（记录停在 App 那一次，没有第三条）',
  lines.length === 2 && lines.at(-1)?.[1] === `节点一 · ${SITE}`, `${lines.length} 条记录：${lines.map(([, t]) => t).join(' → ')}`)

console.log(`\n结果: PASS ${pass} / FAIL ${fail}`)
ws.close(); chrome.kill(); server.close()
process.exit(fail ? 1 : 0)

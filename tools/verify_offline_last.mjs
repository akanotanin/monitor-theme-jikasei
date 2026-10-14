// 离线服务器沉底的护栏（2026-10-14 站长要求：「把离线服务器的卡片排到所有卡片的最末尾」）。
//
// 判据（夹具里的排序是**交错**的：离线机器在 sort 序里本来就排在中间 —— 不沉底的话第一
// 条断言必红）：
//   ① 列表页顺序 = 在线（按站长 sort）在前、离线的全部垫底（组内仍按 sort）；
//   ② 分组页签里同样成立（切到「甲」组：在线在前、离线的那个仍在组内垫底）；
//   ③ 紧凑档（一行一台的表格）同一口径；
//   ④ 一键动态：把一台离线机器「恢复在线」后（等兜底轮询带新数据进来），它自己升回在线段
//      —— 沉底不是快照，是对实时状态的排序。
//
// 夹具还含一台「从未接入」（cpu_cores 0 / metrics null）的机器：它在 `online` 里也是 false，
// 与掉线机一样沉底。
// 用法：cd <repo> && node tools/verify_offline_last.mjs
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 5523
const CDP_PORT = PORT + 4000
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2' }
const GB = 1024 ** 3, MB = 1024 ** 2

const metrics = (o) => ({ uptime: 1966200, cpu: 1.0, load: [0.03, 0.01, 0.0], mem_total: 960 * MB, mem_used: 430 * MB, swap_total: 0, swap_used: 0, disk_total: 10 * GB, disk_used: 1.4 * GB, net_rx: 1517, net_tx: 530, total_rx: 44.2 * GB, total_tx: 42.9 * GB, month_rx: 43.1 * GB, month_tx: 42.0 * GB, tcp: 16, udp: 3, procs: 76, ...o })
const base = (id, name, o) => ({
  id, name, sort: id, public: true, online: true, country: 'JP', group: '',
  last_seen: Math.floor(Date.now() / 1000) - 5, last_seen_ago: 5,
  metrics: metrics({}), os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'EPYC', cpu_cores: 1,
  mem_total: 960 * MB, swap_total: 0, disk_total: 10 * GB, agent_version: '1.4.0', price: 0, currency: 'CNY', billing_cycle: 'monthly',
  expires_at: null, expires_in: null, traffic_limit: 0, traffic_mode: 'sum', traffic_reset_day: 1,
  total_rx: 44.2 * GB, total_tx: 42.9 * GB, month_rx: 43.1 * GB, month_tx: 42.0 * GB, month_start: '2026-10-01', day_rx: 6.06 * GB, day_tx: 2.5 * GB,
  ...o,
})

// sort 序里离线机交错在中间（Bravo sort1 / Delta sort3），沉底之后应当整体甩到末尾。
const nodes = [
  base(1, 'Alpha', { sort: 0, online: true, group: '甲' }),
  base(2, 'Bravo', { sort: 1, online: false, group: '甲', metrics: null, last_seen_ago: 3600 }),
  base(3, 'Charlie', { sort: 2, online: true, group: '乙' }),
  base(4, 'Delta', { sort: 3, online: false, group: '乙', metrics: null, last_seen_ago: 7200 }),
  base(5, 'Echo', { sort: 4, online: true, group: '' }),
  // 从未接入：cpu_cores / mem_total 都是 0，卡片形态是那行「还没有接入」。
  base(6, 'Foxtrot', { sort: 5, online: false, group: '', metrics: null, last_seen: 0, last_seen_ago: null, cpu_cores: 0, mem_total: 0 }),
]
const EXPECT_ALL = [1, 3, 5, 2, 4, 6]
const EXPECT_G1 = [1, 2]
// ④ 用的那台：翻转后 Bravo 应当升到在线段（sort1 → 排在 Charlie(sort2) 前面）。
const EXPECT_FLIPPED = [1, 2, 3, 5, 4, 6]

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  const json = (b) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(b)) }
  if (path.startsWith('/api/')) {
    if (path === '/api/me') return json({ authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '离线沉底', history_days: 30 })
    if (path === '/api/nodes') return json({ nodes })
    if (path.endsWith('/config')) return json({ cardStyle: 'detailed' })
    if (/\/metrics/.test(path)) return json({ metrics: [], ping: [], probes: {}, loss: {} })
    if (path === '/api/flip') { nodes[1] = { ...nodes[1], online: true, metrics: metrics({}), last_seen: Math.floor(Date.now() / 1000), last_seen_ago: 2 }; return json({ ok: true }) }
    return json({})
  }
  const file = path === '/' ? '/index.html' : path
  const full = join('dist', normalize(file).replace(/^(\.[/\\])+/, ''))
  if (!existsSync(full) || statSync(full).isDirectory()) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] })
    return res.end(readFileSync('dist/index.html'))
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(full)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(full))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p)) || 'chrome'
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*', '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--no-proxy-server', `--user-data-dir=${join(tmpdir(), `offlinelast${CDP_PORT}`)}`, '--no-sandbox', 'about:blank'], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { /* 等 */ }
  if (!wsUrl) await sleep(250)
}
if (!wsUrl) throw new Error('Chrome 没起来')
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
let id = 0
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false })
// 访客偏好钉到「详细」（两个主题各自的键都写一遍，脚本两侧通用）。
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try{for(const k of ['jikasei:card_style','rakugaki:card_style'])localStorage.setItem(k,'detailed')}catch(e){}" })

// 列表顺序：卡片与紧凑行共用同一个锚点 data-node-card（值是节点 id）。
const ORDER = `[...document.querySelectorAll('[data-node-card]')].map((c) => +c.getAttribute('data-node-card'))`

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }
const waitFor = async (expr, ms = 15000) => {
  for (let i = 0; i < ms / 150; i++) {
    if (await js(expr)) return true
    await sleep(150)
  }
  return false
}

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
const loaded = await waitFor(`document.querySelectorAll('[data-node-card]').length === 6`, 20000)
check('列表渲染出来了（六台都在）', loaded)
await sleep(600)

const order = JSON.parse(await js(`JSON.stringify(${ORDER})`) ?? '[]')
console.log(`    ① 列表顺序: ${order.join(', ')}（期望 ${EXPECT_ALL.join(', ')}）`)
check('★ 离线机器沉底：在线按 sort 在前、离线的全在末尾（含「从未接入」那台）',
  JSON.stringify(order) === JSON.stringify(EXPECT_ALL), order.join(','))

// ② 分组页签「甲」：Alpha 在线、Bravo 离线 —— 组内离线也垫底。
const clicked = await js(`(() => {
  const strip = document.querySelector('[role="group"][aria-label="分组"]')
  const btn = strip ? [...strip.querySelectorAll('button')].find((b) => (b.textContent || '').trim().startsWith('甲')) : null
  if (btn) btn.click()
  return !!btn
})()`)
await sleep(500)
const g1 = JSON.parse(await js(`JSON.stringify(${ORDER})`) ?? '[]')
console.log(`    ② 「甲」组顺序: ${g1.join(', ')}（期望 ${EXPECT_G1.join(', ')}）`)
check('★ 分组页签内同样成立（离线在组内垫底）', clicked === true && JSON.stringify(g1) === JSON.stringify(EXPECT_G1), `点击=${clicked} 顺序=${g1.join(',')}`)

// ③ 紧凑档：一行一台的表格，同一口径。
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try{for(const k of ['jikasei:card_style','rakugaki:card_style'])localStorage.setItem(k,'compact')}catch(e){}" })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
const compactReady = await waitFor(`document.querySelectorAll('tr[data-node-card]').length === 6`, 20000)
const cOrder = JSON.parse(await js(`JSON.stringify(${ORDER})`) ?? '[]')
console.log(`    ③ 紧凑档顺序: ${cOrder.join(', ')}（期望 ${EXPECT_ALL.join(', ')}）`)
check('★ 紧凑档同一口径（表格里的离线也在最末尾）',
  compactReady && JSON.stringify(cOrder) === JSON.stringify(EXPECT_ALL), cOrder.join(','))

// ④ 动态：Bravo 恢复在线 → 兜底轮询（WS 起不来时每 5s 一次 /api/nodes）把新状态带进来后，
//    它自己升回在线段（sort1 的位置，Charlie 之前）。
await fetch(`http://127.0.0.1:${PORT}/api/flip`)
const flipped = await waitFor(`JSON.stringify(${ORDER}) === ${JSON.stringify(JSON.stringify(EXPECT_FLIPPED))}`, 12000)
const fOrder = JSON.parse(await js(`JSON.stringify(${ORDER})`) ?? '[]')
console.log(`    ④ 翻转后顺序: ${fOrder.join(', ')}（期望 ${EXPECT_FLIPPED.join(', ')}）`)
check('★ 沉底是对实时状态排序：离线机恢复在线后自己升回在线段', flipped === true, fOrder.join(','))

console.log(`\n结果: PASS ${pass} / FAIL ${fail}`)
ws.close(); chrome.kill(); server.close()
process.exit(fail ? 1 : 0)

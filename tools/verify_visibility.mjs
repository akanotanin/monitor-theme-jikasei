// 后台标签页策略的验收（hub 1.4.0 适配清单里的「切回前台」一项，2026-10-09 落地）：
//   藏起来 → WebSocket 关掉、兜底轮询停掉、不重连（不再每 2 秒一帧、每帧一次 React 重渲染，
//   也不再占着反代按 IP 限的并发 WS 名额）；回到前台 → 立刻补一次 /api/nodes，再把连接接回去。
//
// 两个场景，分开跑：
//   A. WS 可用（主路径）：隐藏后 socket 必须进入 CLOSING/CLOSED、服务端看到关闭；隐藏 4 秒里
//      /api/nodes 与重连计数一个都不涨；回前台 2 秒内恰好 +1 次 /api/nodes、+1 条新 WS，
//      且新的实时帧（帧名序号更大）真的画出来。
//   B. WS 不可用（兜底路径）：轮询在跑（5 秒一拉）；隐藏后轮询停（计数冻结）、连重试都不发；
//      回前台先 +1（补一次）再 +1（轮询接回来）。
// 桩服务器把 WS 推的节点名做成「帧<序号>」、把 /api/nodes 的节点名做成「快照」——两者可从
// 页面上区分「数据是从哪条路来的」。
// 用法：cd <repo> && node tools/verify_visibility.mjs
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { extname, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 5398
const CDP_PORT = PORT + 4000
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }
const GB = 1024 ** 3

const mkNode = (name) => ({
  id: 1, name, sort: 1, public: true, online: true, country: 'JP', group: '',
  last_seen: Math.floor(Date.now() / 1000) - 3, last_seen_ago: 3,
  metrics: {
    uptime: 400000, cpu: 12.5, load: [0.1, 0.2, 0.3], mem_total: 2 * GB, mem_used: 1 * GB,
    swap_total: 0, swap_used: 0, disk_total: 40 * GB, disk_used: 10 * GB,
    net_rx: 512 * 1024, net_tx: 128 * 1024, total_rx: 1 * GB, total_tx: 512 * 1024 ** 2,
    month_rx: 8 * GB, month_tx: 4 * GB, tcp: 10, udp: 2, procs: 100,
  },
  os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'Xeon',
  cpu_cores: 2, mem_total: 2 * GB, swap_total: 0, disk_total: 40 * GB, agent_version: '1.4.0',
  price: 0, currency: 'CNY', billing_cycle: 'monthly', expires_at: null, expires_in: null,
  traffic_limit: 0, traffic_mode: 'sum', traffic_reset_day: 1,
  total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0, month_start: '', day_rx: 0, day_tx: 0,
})

/* ------------------------------------------------------------------ 桩服务器（含真 WS） */

let wsEnabled = true
let nodesHits = 0, wsOpens = 0, wsClosed = 0, wsAttempts = 0, framesSent = 0, frameSeq = 0
let openSockets = 0

// 服务端帧不做掩码；长度按 125/65535/以上三档。
const sendFrame = (socket, text) => {
  const payload = Buffer.from(text)
  let header
  if (payload.length < 126) header = Buffer.from([0x81, payload.length])
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2) }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2) }
  try { socket.write(Buffer.concat([header, payload])); framesSent++ } catch { /* 对端已走 */ }
}

const server = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  if (path === '/__stats') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify({ wsEnabled, nodesHits, wsOpens, wsClosed, wsAttempts, framesSent, frameSeq, openSockets }))
  }
  if (path === '/__ws') {
    wsEnabled = new URL(req.url, `http://x`).searchParams.get('on') === '1'
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify({ wsEnabled }))
  }
  if (path.startsWith('/api/')) {
    let body = {}
    if (path === '/api/me') body = { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '可见性校验', history_days: 30 }
    else if (path === '/api/nodes') { nodesHits++; body = { nodes: [mkNode('快照')] } }
    else if (path.endsWith('/config')) body = {}
    else if (path.includes('/metrics')) body = { metrics: [], ping: [], probes: {}, loss: {} }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
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
// ★ 握手要挂在 'upgrade' 上：Node 的 http server 没有这个监听器时会直接掐掉带 Upgrade 头的连接
// （客户端收 1006、一个字节都收不到），「WS 连着」这件事就永远测不到（这条坑在别处也踩过）。
server.on('upgrade', (req, socket) => {
  wsAttempts++
  if (!wsEnabled) { socket.destroy(); return }
  const key = req.headers['sec-websocket-key']
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
  wsOpens++
  openSockets++
  const timer = setInterval(() => sendFrame(socket, JSON.stringify({ nodes: [mkNode(`帧${++frameSeq}`)] })), 300)
  socket.on('data', (buf) => {
    // 客户端发关闭帧（0x88）：回一条空的再断开，别让 TCP 半开着（否则 close 要等超时）。
    if ((buf[0] & 0x0f) === 0x8) { try { socket.write(Buffer.from([0x88, 0x00])) } catch { /* 已断 */ } socket.destroy() }
  })
  socket.on('close', () => { clearInterval(timer); openSockets--; wsClosed++ })
  socket.on('error', () => {})
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
const stats = async () => (await (await fetch(`http://127.0.0.1:${PORT}/__stats`)).json())

/* ------------------------------------------------------------------ 浏览器 */

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p)) || 'chrome'
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*', '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--no-proxy-server', `--user-data-dir=${join(tmpdir(), `vischeck${CDP_PORT}`)}`, '--no-sandbox', 'about:blank'], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { /* 等 */ }
  if (!wsUrl) await sleep(250)
}
if (!wsUrl) throw new Error('Chrome 没起来')
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
let id = 0, exceptions = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') exceptions++
}
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })

// 每个新文档开头都装两样：① hook window.WebSocket 收实例（看 readyState）；
// ② 可切换的 document.visibilityState + 派发 visibilitychange 的开关。
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  const O = window.WebSocket, list = []
  window.__sockets = list
  window.WebSocket = class extends O { constructor(...a) { super(...a); list.push(this) } }
  window.__visState = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__visState })
  window.__setVis = (v) => { window.__visState = v; document.dispatchEvent(new Event('visibilitychange')); return document.visibilityState }
})()` })

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }
const waitFor = async (expr, ms = 5000) => {
  for (let i = 0; i < Math.ceil(ms / 120); i++) {
    if (await js(expr)) return true
    await sleep(120)
  }
  return false
}
const waitStats = async (fn, ms = 6000) => {
  for (let i = 0; i < Math.ceil(ms / 200); i++) {
    const s = await stats()
    if (fn(s)) return s
    await sleep(200)
  }
  return await stats()
}
const readyStates = `JSON.stringify((window.__sockets || []).map((s) => s.readyState))`
const readFrameSeq = async () => {
  const m = String(await js('document.body.innerText')).match(/帧(\d+)/)
  return m ? Number(m[1]) : 0
}

/* ------------------------------------------------------------- 场景 A：WS 可用 */

console.log('=== A. WS 可用（主路径） ===')
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
const a1 = await waitStats((s) => s.wsOpens >= 1 && s.nodesHits >= 1)
check('加载后 WS 连上、/api/nodes 拉过初始快照', a1.wsOpens >= 1 && a1.nodesHits >= 1, JSON.stringify({ wsOpens: a1.wsOpens, nodesHits: a1.nodesHits }))
await waitFor(`/帧\\d+/.test(document.body.innerText)`, 6000)
const seqBefore = await readFrameSeq()
check('实时帧画出来了（数据来自 WS 推送）', seqBefore > 0, `帧${seqBefore}`)
check('隐藏前 socket 处于 OPEN（探针本身没问题）', (JSON.parse(await js(readyStates))).some((s) => s === 1), await js(readyStates))

console.log(`    → 切隐藏（__setVis('hidden')）`)
await js(`window.__setVis('hidden')`)
const rs = JSON.parse(await js(readyStates))
check('隐藏后 socket 立刻进入 CLOSING/CLOSED（不再收推送）', rs.length > 0 && rs.every((s) => s >= 2), JSON.stringify(rs))
const closeSeen = await waitStats((s) => s.wsClosed >= 1, 3000)
check('服务端看到了这条连接的关闭', closeSeen.wsClosed >= 1, `wsClosed=${closeSeen.wsClosed}`)

const snapA = await stats()
await sleep(4000)
const afterA = await stats()
check('★ 隐藏 4 秒里没有再拉 /api/nodes（兜底轮询没在后台空转）', afterA.nodesHits === snapA.nodesHits, `${snapA.nodesHits} → ${afterA.nodesHits}`)
check('★ 隐藏期间没有偷偷重连 WS', afterA.wsOpens === snapA.wsOpens && afterA.wsAttempts === snapA.wsAttempts, `opens ${snapA.wsOpens}→${afterA.wsOpens}, attempts ${snapA.wsAttempts}→${afterA.wsAttempts}`)

console.log(`    → 切回前台（__setVis('visible')）`)
await js(`window.__setVis('visible')`)
const backA = await waitStats((s) => s.nodesHits >= snapA.nodesHits + 1, 2500)
check('★ 回前台立刻补一次 /api/nodes（恰好 +1）', backA.nodesHits === snapA.nodesHits + 1, `${snapA.nodesHits} → ${backA.nodesHits}`)
const reopenA = await waitStats((s) => s.wsOpens >= snapA.wsOpens + 1, 2500)
check('★ 回前台把 WS 接回来了（+1 条新连接）', reopenA.wsOpens >= snapA.wsOpens + 1, `wsOpens ${snapA.wsOpens} → ${reopenA.wsOpens}`)
const resumed = await waitFor(`(document.body.innerText.match(/帧(\\d+)/) || [0, '0'])[1] > ${seqBefore}`, 3000)
check('实时帧重新画出来（序号大于隐藏前那一帧）', resumed, `隐藏前 帧${seqBefore}`)

/* ------------------------------------------------------------- 场景 B：WS 不可用 */

console.log('\n=== B. WS 不可用（兜底轮询路径） ===')
const beforeB = (await stats()).nodesHits
await fetch(`http://127.0.0.1:${PORT}/__ws?on=0`)
await send('Page.reload')
const poll = await waitStats((s) => s.nodesHits >= beforeB + 2, 9000)
check('WS 不可用时兜底轮询在跑（5 秒一拉，重新加载后至少 +2 次）', poll.nodesHits >= beforeB + 2, `${beforeB} → ${poll.nodesHits}`)

await js(`window.__setVis('hidden')`)
await sleep(1200)  // 让在途的收尾干净
const snapB = await stats()
await sleep(5800)
const afterB = await stats()
check('★ 隐藏期间轮询真的停了（跨过一个 5 秒周期计数不涨）', afterB.nodesHits === snapB.nodesHits, `${snapB.nodesHits} → ${afterB.nodesHits}`)
check('★ 隐藏期间连 WS 重试都不发', afterB.wsAttempts === snapB.wsAttempts, `attempts ${snapB.wsAttempts} → ${afterB.wsAttempts}`)

await js(`window.__setVis('visible')`)
const backB = await waitStats((s) => s.nodesHits >= snapB.nodesHits + 1, 2500)
check('★ 回前台补一次（轮询不可用时的「立刻拉一下」）', backB.nodesHits >= snapB.nodesHits + 1, `${snapB.nodesHits} → ${backB.nodesHits}`)
const againB = await waitStats((s) => s.nodesHits >= snapB.nodesHits + 2, 7500)
check('轮询也接回来了（回前台后 5 秒周期恢复）', againB.nodesHits >= snapB.nodesHits + 2, `${snapB.nodesHits} → ${againB.nodesHits}`)

check('全程没有未捕获异常', exceptions === 0, `${exceptions} 条`)

console.log(`\n结果: PASS ${pass} / FAIL ${fail}`)
ws.close(); chrome.kill(); server.close()
process.exit(fail ? 1 : 0)

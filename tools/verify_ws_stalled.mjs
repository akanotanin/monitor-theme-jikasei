// 「推送通道断了要自己说」的护栏：覆盖三条失败路径，且都在**桩环境**里可控复现。
//
//   ① hub 停机（WS 连不上）：横幅亮起
//   ② WS 构造器直接抛（广告拦截 / 隐私扩展把 WebSocket 换成一调就 throw 的桩）：
//      横幅也要亮 —— 1.37.0 只挂 5 秒轮询，一句话都不说，关掉扩展还得刷新页面才恢复。
//   ③ 真帧回来：横幅撤掉（唯一解除点）
//
// ★②这条是 2026-11-22 三审补的：`connect()` 的 `catch { poll ??= ...; return }` 原先既不
//   报警也不排重连，与「推送断了自己说」的意图在覆盖矩阵上不一致。桩里把 `window.WebSocket`
//   换成构造即抛的实现，就能稳定踩到那条分支。
//
// 用法：cd <repo> && node tools/verify_ws_stalled.mjs（先 npm run build）
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'

const PORT = Number(process.env.WSSTALL_PORT || 5275)
const CDP_PORT = PORT + 4000
const BASE = `http://127.0.0.1:${PORT}`
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2' }
const GB = 1024 ** 3

const nodes = Array.from({ length: 3 }, (_, i) => ({
  id: i + 1, name: `node-${i + 1}`, sort: i + 1, public: true, online: true,
  country: 'JP', group: '', last_seen: Math.floor(Date.now() / 1000) - 3, last_seen_ago: 3,
  os: 'Debian GNU/Linux 12 (bookworm)', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm',
  cpu_name: 'AMD EPYC', cpu_cores: 2, mem_total: 2 * GB, swap_total: 0, disk_total: 40 * GB,
  agent_version: '1.4.0', currency: 'CNY', expires_at: '2027-07-21', expires_in: 299,
  metrics: {
    uptime: 318521, cpu: 3.2, load: [0.08, 0.03, 0.01], mem_total: 2 * GB, mem_used: 431800320,
    swap_total: 0, swap_used: 0, disk_total: 40 * GB, disk_used: 9214510720,
    net_rx: 866000, net_tx: 464000, total_rx: 5707805336, total_tx: 5203609923,
    month_rx: 4650258264, month_tx: 4351673970, tcp: 16, udp: 3, procs: 75,
  },
}))

// ★这个桩**不提供** /api/ws 的升级：WebSocket 握手会失败（①的路子）。
const server = createServer((req, res) => {
  const url = new URL(req.url, BASE)
  const path = url.pathname
  if (path.startsWith('/api/')) {
    const body =
      path === '/api/me' ? { authed: false, github: false, public_page: true, site: BASE, site_name: 'ws 桩' } :
      path === '/api/nodes' ? { nodes } :
      path.endsWith('/config') ? { cardStyle: 'plain', listTop: 'none' } :
      path === '/api/version' ? { version: '1.5.2' } : {}
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

const profile = join(tmpdir(), `jikasei-wsstall-${Date.now()}`)
mkdirSync(profile, { recursive: true })
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const chrome = spawn(chromePath, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,900',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', 'about:blank',
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

/** 横幅（琥珀色的「实时数据中断」那一行）在不在。 */
const STALL = `(() => {
  const el = [...document.querySelectorAll('[role=status]')].find((n) => /实时数据中断/.test(n.textContent || ''))
  return { shown: !!el, text: el ? (el.textContent || '').trim().slice(0, 60) : null }
})()`
/** 按「轮询还在供数」判活：卡片数与第一台的名字都在。 */
const CARDS = `document.querySelectorAll('[data-node-card]').length`

const waitFor = async (expr, ms, what) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await js(expr)) return true
    await sleep(200)
  }
  console.log(`   （等「${what}」超时 ${ms}ms）`)
  return false
}

// ── ① hub 停机 / WS 握手失败：横幅要亮 ──
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: BASE })
await waitFor(`document.querySelectorAll('[data-node-card]').length > 0`, 15000, '首屏卡片')
const lit = await waitFor(`(() => { const el = [...document.querySelectorAll('[role=status]')].find((n) => /实时数据中断/.test(n.textContent || '')); return !!el })()`, 12000, '横幅亮起')
check('① WS 握手失败（桩不提供 /api/ws）：横幅「实时数据中断」亮起', lit, JSON.stringify(await js(STALL)))
check('① 横幅期间 HTTP 轮询仍在供数（卡片没消失）', (await js(CARDS)) === 3, `卡片 ${await js(CARDS)}`)

// ── ② WS 构造器直接抛：同样要亮（1.37.0 的漏洞）──
await send('Page.navigate', { url: 'about:blank' })
await sleep(200)
// 换掉 WebSocket：构造即抛（广告拦截 / 隐私扩展的常见形态）
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const Real = window.WebSocket
    window.WebSocket = function (...args) {
      throw new DOMException('blocked by extension', 'SecurityError')
    }
    window.WebSocket.OPEN = Real.OPEN
    window.WebSocket.CLOSED = Real.CLOSED
    window.WebSocket.CONNECTING = Real.CONNECTING
    window.WebSocket.CLOSING = Real.CLOSING
  })()`,
})
await send('Page.navigate', { url: BASE })
await waitFor(`document.querySelectorAll('[data-node-card]').length > 0`, 15000, '首屏卡片')
const lit2 = await waitFor(`(() => { const el = [...document.querySelectorAll('[role=status]')].find((n) => /实时数据中断/.test(n.textContent || '')); return !!el })()`, 12000, '横幅亮起（构造器抛）')
check('②★ WS 构造器直接抛：横幅同样亮起（旧实现一句话都不说）', lit2, JSON.stringify(await js(STALL)))
check('② 横幅期间轮询仍在供数', (await js(CARDS)) === 3, `卡片 ${await js(CARDS)}`)

// ── ③ 修复版还会排重连：把 WebSocket 换回真的、且让 /api/ws 能升级 ──
//     stub 不再拦，改由页内脚本把 WebSocket 还原成真的 —— 若实现排了 retry，最迟 10s 后
//     （BACKOFF[0]）会再试一次；这里只验「重连被排上了」这个可观测后果：
//    在一次重试窗口内恢复 -> 真帧到达 -> 横幅撤掉。为了不依赖真 WS 服务器，
//    用页内假 WebSocket 冒充：构造成功、随后派发一帧合法 nodes 消息。
await send('Page.navigate', { url: 'about:blank' })
await sleep(200)
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    // 假 WS：构造成功，50ms 后自己派一帧（模拟「扩展关掉后连接恢复正常」）。
    window.__wsAttempts = 0
    window.WebSocket = function (url) {
      window.__wsAttempts++
      const self = this
      this.readyState = 0
      this.onmessage = null; this.onerror = null; this.onclose = null
      this.close = () => { this.readyState = 3 }
      setTimeout(() => {
        self.readyState = 1
        if (self.onopen) self.onopen({})
        const frame = JSON.stringify({ nodes: ${JSON.stringify(nodes)} })
        if (self.onmessage) self.onmessage({ data: frame })
      }, 50)
    }
    window.WebSocket.OPEN = 1
    window.WebSocket.CLOSED = 3
    window.WebSocket.CONNECTING = 0
    window.WebSocket.CLOSING = 2
  })()`,
})
await send('Page.navigate', { url: BASE })
await waitFor(`document.querySelectorAll('[data-node-card]').length > 0`, 15000, '首屏卡片')
await sleep(900)
const attempts = await js('window.__wsAttempts')
const stallAfter = await js(STALL)
check('③ 真帧到达后横幅撤掉（唯一解除点）', stallAfter.shown === false, JSON.stringify(stallAfter))
check('③ 只建了一条连接（没有因重连风暴堆实例）', attempts === 1, `__wsAttempts=${attempts}`)

console.log(`\n结果: PASS ${pass} / FAIL ${fail}`)
ws.close()
chrome.kill()
server.close()
process.exit(fail ? 1 : 0)

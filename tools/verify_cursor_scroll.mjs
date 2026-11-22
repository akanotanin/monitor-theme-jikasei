// 键盘光标「按方向键就滚进视野」的护栏 —— 专挑**纯静态桩**环境（没有任何数据更新来源）。
//
// ★为什么单列一条（2026-11-22 三审）：1.37.0 修「搜索框 ↑↓ 选中未挂载的卡片时看起来没反应」，
//   但滚动是与 `reveal()`（setLimit）挤在同一个 effect 里同步做的 —— 那一轮渲染还没提交，
//   新卡不在 DOM 里，`?.` 静默跳过，本次按键必落空。真机上连续按 ↓ 看起来没问题，是因为按键
//   序列里穿插了 WS 帧（≤2s 一帧）把滚动补上了；而**没有 WS、没有轮询**的环境里症状一直在。
//
// ★怎么把那个场景稳定复现出来（关键，别删）：
//   分批挂载是 `setTimeout(..., 0)` 链，真机上几十毫秒就补完，交互之前早就 60 张全挂上了 ——
//   那样子光标根本落不到「未挂载」的卡上，护栏就变成真空通过（实测：变异回旧写法也全绿）。
//   这里用 `Page.addScriptToEvaluateOnNewDocument` 把那类 0ms 定时器压成 500ms，于是页面
//   稳定停在「只挂首屏 24 张」的状态；再按一次 **↑**（`moveCursor(-1)` 从 null 直接绕到
//   最后一台）—— 光标一步落到第 60 台，它还没挂载。这正是原症状的最小复现。
//   修好的实现：`reveal` 先把 limit 抬到它之后、滚动在 limit 变化的那一轮补跑 → 进视口。
//   旧实现：同一拍里 querySelector 落空，且 deps 不含 limit 不会重跑 → 停在视口外。
//
// 用法：cd <repo> && node tools/verify_cursor_scroll.mjs（先 npm run build）
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'

const PORT = Number(process.env.CURSOR_PORT || 5273)
const CDP_PORT = PORT + 4000
const BASE = `http://127.0.0.1:${PORT}`
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2' }
const GB = 1024 ** 3
const TOTAL = 60

// 60 台同构机器：名字统一前缀，每台都带完整 metrics，免得「沉底排序」打乱顺序
// （这一条测的是滚动，不是排序）。
const nodes = Array.from({ length: TOTAL }, (_, i) => ({
  id: i + 1, name: `node-${String(i + 1).padStart(2, '0')}`, sort: i + 1, public: true, online: true,
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
const CONFIG = { cardStyle: 'plain', listTop: 'none' }

const server = createServer((req, res) => {
  const url = new URL(req.url, BASE)
  const path = url.pathname
  if (path.startsWith('/api/')) {
    // ★不提供 WS、不给任何随时间变化的响应：这就是「纯静态桩」。
    const body =
      path === '/api/me' ? { authed: false, github: false, public_page: true, site: BASE, site_name: 'cursor 桩' } :
      path === '/api/nodes' ? { nodes } :
      path.endsWith('/config') ? CONFIG :
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

const profile = join(tmpdir(), `jikasei-cursor-${Date.now()}`)
mkdirSync(profile, { recursive: true })
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const chrome = spawn(chromePath, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1440,900', '--disable-background-timer-throttling',
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

const errors = []
await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')
/** 桩环境没有 /api/ws（这正是「纯静态」的意思）—— 它握手失败的那条是预期的，不算异常。 */
const EXPECTED = /WebSocket connection to .*\/api\/ws.*failed|WebSocket is closed before the connection is established|Error during WebSocket handshake/i
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') {
    const text = m.params.exceptionDetails?.text || 'exception'
    if (!EXPECTED.test(text)) errors.push(text)
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    const text = m.params.entry.text || ''
    if (!EXPECTED.test(text)) errors.push(text)
  }
})

// ★把 0ms / 极短的定时器压慢：分批挂载用的是 `setTimeout(..., 0)`，不压就几十毫秒补完全部 60 张，
//   光标永远落不到「未挂载」的卡上（护栏会真空通过）。只压 <50ms 的，React 自身的调度走
//   MessageChannel，不受影响。
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const real = window.setTimeout
    window.setTimeout = function (fn, delay, ...rest) {
      const ms = Number(delay) || 0
      return real.call(this, fn, ms >= 0 && ms < 50 ? 500 : ms, ...rest)
    }
  })()`,
})

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); pass += ok ? 1 : 0; fail += ok ? 0 : 1 }

await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: BASE })
for (let i = 0; i < 80; i++) {
  const ready = await js('!!document.querySelector(\'.search-input\') && document.querySelectorAll(\'[data-node-card]\').length > 0')
  if (ready) break
  await sleep(100)
}
await sleep(150)

/** 光标卡的视口位置 + 当前挂载数（判据只看「这一张在不在视口里」）。 */
const PROBE = `(() => {
  const sel = document.querySelector('[data-node-card][data-selected]')
  const mounted = document.querySelectorAll('[data-node-card]').length
  if (!sel) return { selected: null, mounted, inView: false }
  const r = sel.getBoundingClientRect()
  return {
    selected: (sel.querySelector('h3')?.textContent || '').trim(),
    mounted,
    inView: r.top >= 0 && r.bottom <= innerHeight + 1 && r.height > 0,
    top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight, scrollY: Math.round(scrollY),
  }
})()`
const key = async (k, code, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk })
}

// 焦点放进搜索框（键盘导航只在框里生效）。
await js('document.querySelector(\'.search-input\').focus()')

// ── 一、前置条件：分批挂载被压住，页面只挂首屏那一批 ──
const atStart = await js(PROBE)
check(`前置条件：定时器被压慢，首屏没挂满 ${TOTAL} 张`,
  atStart.mounted > 0 && atStart.mounted < TOTAL, `挂载 ${atStart.mounted} / ${TOTAL}`)

// ── 二、按一次 ↑：光标从 null 一步绕到**最后一台**（未挂载）──
//    这是原症状的最小复现：旧实现在同一拍里查不到元素、deps 又不含 limit，滚动不补。
await key('ArrowUp', 'ArrowUp', 38)
await sleep(200)
const jumped = await js(PROBE)
check(`按 ↑ 绕到最后一台：光标落到 node-${TOTAL}（一台按键前还没挂载的卡）`,
  jumped.selected === `node-${String(TOTAL).padStart(2, '0')}`,
  `selected=${JSON.stringify(jumped.selected)}；现在挂了 ${jumped.mounted} 张`)
check('★ 这一台被挂上并滚进视口（旧写法：查不到元素且不会补跑，停在视口外）',
  jumped.inView, `inView=${jumped.inView} top=${jumped.top} bottom=${jumped.bottom} vh=${jumped.vh} scrollY=${jumped.scrollY}`)

// ── 三、连按 ↓ 若干次：每次都要留在视口内（常规路径）──
let worst = null
for (let i = 1; i <= 12; i++) {
  await key('ArrowDown', 'ArrowDown', 40)
  await sleep(150)
  const now = await js(PROBE)
  if (!now.inView) worst = worst ?? { i, ...now }
}
check('连按 12 次 ↓：每一次都在视口内',
  worst === null, worst ? `第 ${worst.i} 次落在视口外：top=${worst.top} bottom=${worst.bottom} vh=${worst.vh}` : '12 次全部在视口内')

// ── 四、搜索收窄把 limit 打回 24：再按 ↓ 同样要滚进视野 ──
const type = async (text) => {
  for (const ch of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) })
    await sleep(60)
  }
}
await js('document.querySelector(\'.search-input\').focus()')
await type('node-2')
await sleep(400)
const narrowed = await js('document.querySelectorAll(\'[data-node-card]\').length')
await js('document.querySelector(\'.search-input\').focus()')
await key('ArrowDown', 'ArrowDown', 40)
await sleep(200)
const first = await js(PROBE)
check('收窄后按 ↓：选中第一台且它在视口内', first.selected !== null && first.inView, JSON.stringify(first))
let worst2 = null
for (let i = 2; i <= 16; i++) {
  await key('ArrowDown', 'ArrowDown', 40)
  await sleep(120)
  const now = await js(PROBE)
  if (!now.inView) worst2 = worst2 ?? { i, ...now }
}
check('★ 收窄后连按 ↓：每一次都在视口内', worst2 === null,
  worst2 ? `第 ${worst2.i} 次：top=${worst2.top} bottom=${worst2.bottom} vh=${worst2.vh}` : `命中集 ${narrowed} 张，全部在视口内`)

check('全程没有控制台异常', errors.length === 0, errors.slice(0, 3).join(' | '))

console.log(`\n结果: PASS ${pass} / FAIL ${fail}`)
ws.close()
chrome.kill()
server.close()
process.exit(fail ? 1 : 0)

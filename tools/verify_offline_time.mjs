// 离线时长的验收：显示「离线 N」必须用 hub 算好的 `last_seen_ago`（hub 1.4.0 起下发，
// 按 hub 时钟算），而不是拿 `last_seen` 减浏览器时钟——访客时钟偏了就会报出错误的时长。
//
// 夹具（三条都按「详细」档默认卡片检查）：
//   ① 时钟偏 8 小时的访客 + 一台离线 2 分钟的机器：页面必须写「离线 2 分」，
//      且**不许**出现「8 小时」（旧构建：按浏览器时钟算，正好显示成离线 8 小时 → 必红）。
//   ② 老 hub（没有 `last_seen_ago` 这个 key）：退回按 `last_seen` 自己算，显示「离线 3 分」
//      —— 回退路径在两种构建上都该是绿的（证明没把老 hub 弄坏）。
//   ③ 详情页 /node/1 的「在线时间」格：与卡面同一口径，「离线 2 分」。
// 用法：cd <repo> && node tools/verify_offline_time.mjs
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 5399
const CDP_PORT = PORT + 4000
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }
const GB = 1024 ** 3
const now = Math.floor(Date.now() / 1000)

// 完整到卡片能画的节点；metrics 为 null（离线机器没有实时值，但「已接入过」要由 cpu_cores 证明）。
const offlineNode = (id, name, extra) => ({
  id, name, sort: id, public: true, online: false, country: 'JP', group: '', metrics: null,
  os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'Xeon',
  cpu_cores: 2, mem_total: 2 * GB, swap_total: 0, disk_total: 40 * GB, agent_version: '1.4.0',
  price: 0, currency: 'CNY', billing_cycle: 'monthly', expires_at: null, expires_in: null,
  traffic_limit: 0, traffic_mode: 'sum', traffic_reset_day: 1,
  total_rx: 100 * GB, total_tx: 50 * GB, month_rx: 8 * GB, month_tx: 4 * GB, month_start: '2026-09-01',
  day_rx: 1 * GB, day_tx: GB / 2,
  ...extra,
})

const NODES = {
  nodes: [
    // ① 时钟偏 8 小时：last_seen 看上去是 8 小时前，但 hub 明说「2 分钟前还在」（last_seen_ago）。
    offlineNode(1, '时钟偏移机', { last_seen: now - 8 * 3600, last_seen_ago: 120 }),
    // ② 老 hub：没有 last_seen_ago 这个 key，退回按 last_seen 算（3 分钟前）。
    offlineNode(2, '老Hub机', { last_seen: now - 180 }),
  ],
}

const server = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  if (path.startsWith('/api/')) {
    let body = {}
    if (path === '/api/me') body = { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '离线时长校验', history_days: 30 }
    else if (path === '/api/nodes') body = NODES
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
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p)) || 'chrome'
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*', '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--no-proxy-server', `--user-data-dir=${join(tmpdir(), `offlinetime${CDP_PORT}`)}`, '--no-sandbox', 'about:blank'], { stdio: 'ignore' })
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
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false })

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }
const waitFor = async (expr, ms = 8000) => {
  for (let i = 0; i < ms / 120; i++) {
    if (await js(expr)) return true
    await sleep(120)
  }
  return false
}

// 卡片 / 详情页里按名字取那台机器的文本（表达式直接返回字符串，别再套 JSON.stringify——
// 那会把引号带进比较值）
const cardText = (name) => `(() => {
  const card = [...document.querySelectorAll('[role=button]')].find((c) => c.innerText.includes(${JSON.stringify(name)}))
  return card ? card.innerText.replace(/\\n/g, ' | ') : null
})()`
const factText = (label) => `(() => {
  const dt = [...document.querySelectorAll('dt')].find((d) => d.textContent.trim() === ${JSON.stringify(label)})
  return dt && dt.nextElementSibling ? dt.nextElementSibling.textContent.trim() : null
})()`

// ---- 列表页（默认「详细」档卡片） ----
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
const loaded = await waitFor(`document.body.innerText.includes('时钟偏移机')`, 12000)
check('列表渲染出来了（夹具出现）', loaded)
await sleep(600)

const card1 = (await js(cardText('时钟偏移机'))) ?? ''
console.log(`    ① 时钟偏移机的卡：${card1}`)
check('★ 时钟偏 8 小时的访客看到的是「离线 2 分」（按 hub 的 last_seen_ago）', card1.includes('离线 2 分'))
check('★ 不许出现浏览器时钟算出来的「8 小时」', !card1.includes('8 小时'))

const card2 = (await js(cardText('老Hub机'))) ?? ''
console.log(`    ② 老 hub 机器的卡：${card2}`)
check('老 hub（没有 last_seen_ago）退回按 last_seen 算：仍显示「离线 3 分」', card2.includes('离线 3 分'))

// ---- 详情页 /node/1 ----
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/node/1` })
const detailLoaded = await waitFor(`!!document.querySelector('dt')`, 10000)
check('详情页渲染出来了', detailLoaded)
await sleep(600)
const fact = (await js(factText('在线时间'))) ?? ''
console.log(`    ③ 详情页「在线时间」=${fact}`)
check('★ 详情页同一口径：在线时间 =「离线 2 分」', fact === '离线 2 分')
const bodyText = (await js('document.body.innerText')) ?? ''
check('★ 详情页整页不许出现「8 小时」', !bodyText.includes('8 小时'))

console.log(`\n结果: PASS ${pass} / FAIL ${fail}`)
ws.close(); chrome.kill(); server.close()
process.exit(fail ? 1 : 0)

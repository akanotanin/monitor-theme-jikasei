// 拍「概览卡片」两副面孔的对照图：原版 / 月度预算剩余价值版，桌面 + 手机 + 暗色。
//
// 用法：node tools/shot_summary.mjs [输出前缀=shots/summary] [端口=5333] [注入的 CSS]
//
// 第 4 个参数是**只给候选图用**的 CSS 覆盖：它把一堆规则塞进 <style> 再截图，用来在同一份
// 真实标记 + 真实样式表上比较几种排法（挑定之后再落回 Summary.tsx 的类名）。
//   例：node tools/shot_summary.mjs shots/v1 5333 '[data-slot="card"] > div:nth-child(2){width:50% !important}'
//   产物：<前缀>-classic.png（原版行，2× 裁切）
//         <前缀>-budget.png（预算版行，2× 裁切）
//         <前缀>-budget-dark.png（预算版行，暗色）
//         <前缀>-budget-page.png（预算版整屏，1440）
//         <前缀>-budget-mobile.png（预算版整屏，390）
//
// 为什么单独一个脚本：概览卡片的两副面孔差别全在「一张卡里排了几块读数、各自落在哪儿」，
// 整屏截图里那一行只有几十像素高，看不出对齐；所以这里按**那一行的包围盒**裁切，并放大到 2×。
// 数据是中性夹具（东京 / 香港 / 法兰克福 / 圣何塞，价格与币种混着记），不含任何真实机器名。
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PREFIX = process.argv[2] || 'shots/summary'
const PORT = Number(process.argv[3] || 5333)
// 候选图用的 CSS 覆盖（见文件头）；留空就是主题当前的排法。
const VARIANT_CSS = process.argv[4] || ''
const CDP_PORT = PORT + 4000

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
}

const GB = 1024 ** 3
const TB = 1024 ** 4

const metrics = (over) => ({
  uptime: 400000, cpu: 5, load: [0.1, 0.2, 0.3], mem_total: 2 * GB, mem_used: 1 * GB,
  swap_total: 0, swap_used: 0, disk_total: 40 * GB, disk_used: 10 * GB,
  net_rx: 0, net_tx: 0, total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0,
  tcp: 10, udp: 2, procs: 100, ...over,
})

const node = (id, name, over) => ({
  id, name, sort: id, public: true, online: true, country: '',
  last_seen: Math.floor(Date.now() / 1000) - 5, metrics: metrics({}),
  os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'EPYC 7763',
  cpu_cores: 2, mem_total: 2 * GB, swap_total: 0, disk_total: 40 * GB,
  agent_version: '1.4.0', price: 0, currency: 'CNY', billing_cycle: 'monthly', expires_at: null,
  expires_in: null, traffic_limit: 0, traffic_mode: 'sum', traffic_reset_day: 1,
  total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0, month_start: '', day_rx: 0, day_tx: 0,
  group: '', ...over,
})

// 中性夹具：四台不同地区、三种币种、三种计费周期。
const NODES = {
  nodes: [
    node(1, '东京', { group: '亚洲', country: 'JP', price: 8.79, currency: 'CNY', billing_cycle: 'monthly', expires_in: 25, day_rx: 12 * GB, day_tx: 3 * GB, total_rx: 3 * TB, total_tx: 1 * TB, metrics: metrics({ cpu: 12.5, net_rx: 2 * 1024 * 1024, net_tx: 512 * 1024 }) }),
    node(2, '香港', { group: '亚洲', country: 'HK', price: 14.94, currency: 'USD', billing_cycle: 'yearly', expires_in: 263, day_rx: 4 * GB, day_tx: 2 * GB, total_rx: 2 * TB, total_tx: 1 * TB, metrics: metrics({ cpu: 24.9, net_rx: 1024 * 1024, net_tx: 256 * 1024 }) }),
    node(3, '法兰克福', { group: '欧洲', country: 'DE', price: 29, currency: 'EUR', billing_cycle: 'yearly', expires_in: 160, day_rx: 1024 ** 2, day_tx: 1024 ** 2, total_rx: TB, total_tx: TB, metrics: metrics({ cpu: 4.2, net_rx: 64 * 1024, net_tx: 32 * 1024 }) }),
    node(4, '圣何塞', { group: '美洲', country: 'US', price: 30, currency: 'USD', billing_cycle: 'biennial', expires_in: 56, day_rx: 3 * GB, day_tx: 1024 ** 2, total_rx: TB, total_tx: 0.5 * TB, metrics: metrics({ cpu: 51.0, net_rx: 4 * 1024 * 1024, net_tx: 1024 * 1024 }) }),
  ],
}

let config = {}
let dark = false

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  const json = (body) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  if (path === '/__config') {
    config = url.searchParams.get('listTop') ? { listTop: url.searchParams.get('listTop') } : {}
    dark = url.searchParams.get('dark') === '1'
    return json({ config, dark })
  }
  if (path.startsWith('/api/')) {
    if (path === '/api/me') return json({ authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: 'jikasei' })
    if (path === '/api/nodes') return json(NODES)
    if (path.endsWith('/config')) return json(config)
    if (/^\/api\/nodes\/\d+\/metrics/.test(path)) return json({ ping: [], probes: {}, loss: {} })
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

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((p) => existsSync(p)) || 'chrome'

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--no-proxy-server',
  `--user-data-dir=${process.env.LOCALAPPDATA || '/tmp'}/Temp/shotsummary${CDP_PORT}`,
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
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value

await send('Runtime.enable')
await send('Page.enable')

mkdirSync(PREFIX.split('/').slice(0, -1).join('/') || '.', { recursive: true })

/** 那一行的包围盒（四张卡片所在的栅格），外加一点外边距。 */
const ROW_BOX = `(() => {
  const card = document.querySelector('[data-slot=card]')
  const row = card ? card.parentElement : null
  if (!row) return null
  const r = row.getBoundingClientRect()
  const pad = 8
  return JSON.stringify({ x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad + window.scrollY), width: r.width + pad * 2, height: r.height + pad * 2 })
})()`

async function shot(out, { listTop, width, height, dpr = 2, mobile = false, dark = false, clip = null }) {
  await fetch(`http://127.0.0.1:${PORT}/__config?listTop=${listTop}${dark ? '&dark=1' : ''}`)
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?t=${encodeURIComponent(out)}` })
  // 等卡片出来 + 数字落定（骨架态会被拍成一张看着像坏了的图）。
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    const ok = await js(`(() => {
      const digits = [...document.querySelectorAll('[data-slot=card] div')].filter((d) => d.children.length === 0 && /^≈?¥?[0-9]/.test(d.textContent.trim()))
      return digits.length >= 4 && getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)'
    })()`)
    if (ok) break
  }
  // 候选图：把覆盖规则塞进来再量再拍（同一份真实标记与样式表，只多一层 <style>）。
  if (VARIANT_CSS) {
    await js(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(VARIANT_CSS)}; document.head.append(s); return true })()`)
    await sleep(250)
  }
  let box = null
  if (clip === 'row') {
    const raw = await js(ROW_BOX)
    if (!raw) throw new Error('量不到概览行的包围盒（这一行没渲染出来？）')
    box = JSON.parse(raw)
  }
  const params = { format: 'png' }
  if (box) params.clip = { ...box, scale: 1 }
  const image = await send('Page.captureScreenshot', params)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(`${out}.png`, Buffer.from(image.result.data, 'base64'))
  console.log(`  ${out}.png${box ? `  裁切 ${Math.round(box.width)}×${Math.round(box.height)} @${dpr}×` : `  ${width}×${height} @${dpr}×`}`)
}

await shot(`${PREFIX}-classic`, { listTop: 'summary', width: 1440, height: 900, clip: 'row' })
await shot(`${PREFIX}-budget`, { listTop: 'budget', width: 1440, height: 900, clip: 'row' })
await shot(`${PREFIX}-budget-dark`, { listTop: 'budget', width: 1440, height: 900, dark: true, clip: 'row' })
await shot(`${PREFIX}-budget-page`, { listTop: 'budget', width: 1440, height: 1000 })
await shot(`${PREFIX}-budget-mobile`, { listTop: 'budget', width: 390, height: 844, dpr: 2, mobile: true })

ws.close()
chrome.kill()
server.close()

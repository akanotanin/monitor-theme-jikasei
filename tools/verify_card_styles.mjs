// 验「卡片形态」四档（经典 / 延迟 / 详细 / 紧凑）在真实渲染里各自的形状，以及旧值 detail → latency 的迁移。
//
// 用法：node tools/verify_card_styles.mjs [port]
//
// 为什么要它：各档的差别全在 NodeCard / CompactList 里的条件分支上，改一处分支很容易让另一档跟着变
// （或让 classic 悄悄开始拉延迟数据）。这里用本机静态伺服 + 桩 /api/*（含带 ping 历史的
// /api/nodes/{id}/metrics）跑真 React 组件，逐档断言 DOM 形状、访客端请求数与列表上的读数：
//
//   经典   —— 网络 2×2 那格在；不发任何 ping 请求
//   延迟   —— 网络合成一行 + 三网延迟块；每节点恰好 1 次 ping 请求；指定线路按填写顺序、名字对不上跳过
//   详细   —— 元信息行 + 三枚读数盒 + 三网延迟块；标题行不再有状态点；网格不再有 xl 四列
//   紧凑   —— 一张表、一行一台，表头与列随屏宽收放；不发 ping 请求
//   旧值   —— 配置里存 detail（1.2.9 的值）时必须渲染成「延迟」，不能掉回经典
//   非法值 —— 回落经典（含不发延迟请求）
//
// 判据全部走 DOM（类名/属性/文本），不靠看图。
//
// 坑：桩数据别用位移写 2 的幂——JS 的位移按 32 取模，`1 << 40` 等于 256，卡片上会显示
// 「256 B」，看起来像主题算错了单位（第一版就是这么误判的）。用 2 ** n 或十进制。
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = Number(process.argv[2] || 5311)
const CDP_PORT = PORT + 4000

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
}

/* ------------------------------------------------------------------ 桩数据 */

const GB = 1024 ** 3
const TB = 1024 ** 4

// 三节点：①在线带指标与计费 ②刚接入还没上报（online 真、metrics 空） ③从没接入（deployed 假）
const NODES = {
  nodes: [
    {
      id: 1, name: '节点一', sort: 1, public: true, online: true, country: 'JP', group: '',
      last_seen: Math.floor(Date.now() / 1000) - 5,
      metrics: {
        uptime: 400000, cpu: 12.5, load: [0.1, 0.2, 0.3], mem_total: 2 * GB, mem_used: 1 * GB,
        swap_total: 0, swap_used: 0, disk_total: 40 * GB, disk_used: 10 * GB,
        net_rx: 512 * 1024, net_tx: 128 * 1024, total_rx: 1 * TB, total_tx: 256 * GB,
        month_rx: 8 * GB, month_tx: 4 * GB, tcp: 10, udp: 2, procs: 100,
      },
      os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'Xeon',
      cpu_cores: 2, mem_total: 2 * GB, swap_total: 0, disk_total: 40 * GB,
      agent_version: '1.3.0', price: 12.5, currency: 'CNY', billing_cycle: 'monthly',
      expires_at: '2027-01-01', expires_in: 95, traffic_limit: 1 * TB, traffic_mode: 'sum',
      traffic_reset_day: 1, total_rx: 1 * TB, total_tx: 256 * GB,
      month_rx: 8 * GB, month_tx: 4 * GB, month_start: '2026-09-01', day_rx: 1 * GB, day_tx: GB / 2,
    },
    {
      id: 2, name: '节点二', sort: 2, public: true, online: true, country: 'US', group: '',
      last_seen: Math.floor(Date.now() / 1000) - 3, metrics: null,
      os: '', kernel: '', arch: '', virt: '', cpu_name: '', cpu_cores: 1,
      mem_total: 1 * GB, swap_total: 0, disk_total: 20 * GB, agent_version: '1.3.0',
      price: 0, currency: 'USD', billing_cycle: '', expires_at: null, expires_in: null,
      traffic_limit: 0, traffic_mode: 'sum', traffic_reset_day: 1,
      total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0, month_start: '', day_rx: 0, day_tx: 0,
    },
    {
      id: 3, name: '节点三', sort: 3, public: true, online: false, country: '', group: '',
      last_seen: 0, metrics: null, os: '', kernel: '', arch: '', virt: '', cpu_name: '',
      cpu_cores: 0, mem_total: 0, swap_total: 0, disk_total: 0, agent_version: '',
      price: 0, currency: '', billing_cycle: '', expires_at: null, expires_in: null,
      traffic_limit: 0, traffic_mode: 'sum', traffic_reset_day: 1,
      total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0, month_start: '', day_rx: 0, day_tx: 0,
    },
  ],
}

// 每条线路 12 个点，够画一条走势线（Sparkline 至少要 2 个非 null 点）。
const pingPoints = (taskId, base) => Array.from({ length: 12 }, (_, i) => ({
  task_id: taskId, ts: Math.floor(Date.now() / 1000) - (12 - i) * 300,
  latency: Math.round(base + Math.sin(i) * 6), band: [base - 10, base + 10], loss: 0,
}))

const PING = {
  ping: [...pingPoints(11, 42), ...pingPoints(12, 88), ...pingPoints(13, 130), ...pingPoints(14, 210)],
  probes: { 11: '北京电信', 12: '上海电信', 13: '广州电信', 14: '成都电信' },
  loss: { 11: 0, 12: 1.2, 13: 0, 14: 3.4 },
}

let config = {}
let pingHits = []

/* ------------------------------------------------------------------ 伺服 */

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  if (path === '/__stats') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify({ pingHits }))
  }
  if (path === '/__reset') {
    pingHits = []
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end('{}')
  }
  if (path.startsWith('/api/')) {
    let body = {}
    if (path === '/api/me') body = { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '形态校验' }
    else if (path === '/api/nodes') body = NODES
    else if (path.endsWith('/config')) body = config
    else if (path === '/api/version') body = { version: '1.3.0' }
    else if (/^\/api\/nodes\/\d+\/metrics/.test(path)) {
      pingHits.push(path)
      body = url.searchParams.get('series') === 'ping' ? PING
        : { ts: [], cpu: [], mem_used: [], disk_used: [], net_rx: [], net_tx: [] }
    }
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
  '--disable-renderer-backgrounding', '--no-proxy-server',
  `--user-data-dir=${join(tmpdir(), `cardstyles${CDP_PORT}`)}`,
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
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJS = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false })
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })

/* ------------------------------------------------------------------ 逐档探测 */

// 形态断言只看「已接入」的卡片（第三台没接入，卡片里没有用量格）。
const PROBE = `JSON.stringify((() => {
  const all = [...document.querySelectorAll('[role=button]')]
  const cards = all.filter((c) => /CPU/.test(c.innerText))
  const first = cards[0]
  const q = (sel) => first ? first.querySelectorAll(sel).length : -1
  return {
    cards: cards.length,
    allCards: all.length,
    grid: document.querySelector('.grid')?.className ?? '',
    classicNet: q('[class*="gap-y-2"][class*="border-t"]'),
    latencyRow: q('[class*="gap-x-3"]'),
    infoBox: q('[class*="bg-muted/60"]'),
    infoGrid: q('[class*="grid-cols-3"]'),
    dots: all.reduce((n, c) => n + c.querySelectorAll('span[aria-label="在线"],span[aria-label="离线"],span[aria-label="刚接入"]').length, 0),
    dotLabels: all.map((c) => [...c.querySelectorAll('span[aria-label]')].map((s) => s.getAttribute('aria-label')).join('+')),
    polylines: document.querySelectorAll('svg polyline').length,
    rows: [...(first?.querySelectorAll('[class*="border-t"] span.w-16') ?? [])].map((s) => s.textContent.trim()),
    text: first ? first.innerText.replace(/\\n/g, ' | ') : '',
  }
})())`

async function render(cfg, tag = '') {
  config = cfg
  await fetch(`http://127.0.0.1:${PORT}/__reset`)
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?m=${encodeURIComponent(tag)}` })
  let dom = null
  for (let i = 0; i < 60; i++) {
    await sleep(300)
    const raw = await evalJS(PROBE)
    if (!raw) continue
    dom = JSON.parse(raw)
    if (dom.cards > 0 && dom.text.includes('CPU')) break
  }
  if (!dom || dom.cards === 0) throw new Error(`形态 ${tag}：页面没渲染出卡片`)
  await sleep(1000) // 让延迟请求落地（每节点 1 次，三条并发）
  const { pingHits: hits } = await (await fetch(`http://127.0.0.1:${PORT}/__stats`)).json()
  return { dom, ping: hits.length }
}

/* ------------------------------------------------------------------ 紧凑形态探测 */

// 紧凑形态的行是 tr[role=button]（不是卡片），探针另写一份：表头/单元格各自数「没被 display:none 收掉」的那些，
// 它们正是访客看得见的列。
const COMPACT_PROBE = `JSON.stringify((() => {
  const table = document.querySelector('table')
  const rows = [...document.querySelectorAll('tbody tr[role=button]')]
  const visible = (el) => !!el && getComputedStyle(el).display !== 'none'
  const heads = table ? [...table.querySelectorAll('thead tr > *')].filter(visible).map((h) => h.textContent.trim()) : []
  const cells = rows[0] ? [...rows[0].children].filter(visible).length : 0
  const html = document.documentElement
  return {
    tables: document.querySelectorAll('table').length,
    rows: rows.length,
    heads,
    cells,
    grid4: [...document.querySelectorAll('*')].some((e) => typeof e.className === 'string' && e.className.includes('xl:grid-cols-4')),
    overflowX: html.scrollWidth > html.clientWidth,
    bars: rows.reduce((n, r) => n + r.querySelectorAll('.h-full.rounded-full').length, 0),
    text: rows[0] ? rows[0].innerText.replace(/\\n/g, ' | ') : '',
  }
})())`

async function renderCompact(cfg, width, tag) {
  config = cfg
  await fetch(`http://127.0.0.1:${PORT}/__reset`)
  await send('Emulation.setDeviceMetricsOverride', { width, height: 1400, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?m=${encodeURIComponent(tag)}` })
  let dom = null
  for (let i = 0; i < 60; i++) {
    await sleep(300)
    const raw = await evalJS(COMPACT_PROBE)
    if (!raw) continue
    dom = JSON.parse(raw)
    if (dom.rows > 0) break
  }
  if (!dom || dom.rows === 0) throw new Error(`紧凑 ${tag}：页面没渲染出行`)
  await sleep(900) // 让延迟请求落地（紧凑形态应当一次都不发）
  const { pingHits: hits } = await (await fetch(`http://127.0.0.1:${PORT}/__stats`)).json()
  return { dom, ping: hits.length }
}

const results = []
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }

/* 1) 经典 */
{
  const { dom, ping } = await render({ cardStyle: 'classic' }, 'classic')
  check('桩数据已落到卡片（CPU 13% / 内存 1.00 / 2.00 GB / 总量 1.00 TB 与 256 GB）',
    /1[23]%/.test(dom.text) && /1\.00 \/ 2\.00 GB/.test(dom.text) && /1\.00 TB/.test(dom.text) && /256 GB/.test(dom.text),
    dom.text)
  check('经典：网络 2×2 那格在', dom.classicNet === 1, `找到 ${dom.classicNet} 个`)
  check('经典：没有延迟块', dom.latencyRow === 0 && dom.polylines === 0, `行 ${dom.latencyRow} / polyline ${dom.polylines}`)
  check('经典：不发延迟请求', ping === 0, `实测 ${ping} 次`)
  check('经典：无状态点、无读数盒', dom.dots === 0 && dom.infoBox === 0, `点 ${dom.dots} / 盒 ${dom.infoBox}`)
  check('经典：网格保留 xl 四列', dom.grid.includes('xl:grid-cols-4'), dom.grid)
}

/* 2) 延迟（新名字） */
{
  const { dom, ping } = await render({ cardStyle: 'latency' }, 'latency')
  check('延迟：网络合成一行', dom.latencyRow === 1, `找到 ${dom.latencyRow} 个`)
  check('延迟：经典那格不在', dom.classicNet === 0, `找到 ${dom.classicNet} 个`)
  check('延迟：三网延迟块已渲染（每张卡片 3 条线路）', dom.polylines === 3 * dom.cards, `polyline ${dom.polylines} / 卡 ${dom.cards}`)
  check('延迟：每节点恰好 1 次延迟请求', ping === 2, `实测 ${ping} 次`)
  check('延迟：线路按后台顺序取前三条', dom.rows.join('/') === '北京电信/上海电信/广州电信', dom.rows.join('/'))
  check('延迟：无状态点、无读数盒', dom.dots === 0 && dom.infoBox === 0, `点 ${dom.dots} / 盒 ${dom.infoBox}`)
  check('延迟：网格保留 xl 四列', dom.grid.includes('xl:grid-cols-4'), dom.grid)
}
{
  // 指定线路：按填写顺序、名字对不上的跳过、超过三条截断
  const { dom } = await render({ cardStyle: 'latency', pingLines: '广州电信\n不存在的线路\n上海电信\n成都电信\n北京电信' }, 'latency-lines')
  check('延迟：指定线路按填写顺序渲染、名字对不上跳过、封顶三条',
    dom.rows.join('/') === '广州电信/上海电信/成都电信', dom.rows.join('/'))
}
{
  // 四条都对得上：仍然只渲染三条（上限卡在渲染出来的行数上）
  const { dom } = await render({ cardStyle: 'latency', pingLines: '北京电信\n上海电信\n广州电信\n成都电信' }, 'latency-cap')
  check('延迟：指定四条有效线路也只显示三条', dom.rows.join('/') === '北京电信/上海电信/广州电信', dom.rows.join('/'))
}

/* 3) 详细（新档） */
{
  const { dom, ping } = await render({ cardStyle: 'detailed' }, 'detailed')
  check('详细：标题行不再挂状态点', dom.dots === 0, `点 ${dom.dots}`)
  check('详细：三枚读数盒', dom.infoBox === 3 && dom.infoGrid === 1, `盒 ${dom.infoBox} / 栅格 ${dom.infoGrid}`)
  check('详细：元信息行（在线时长 · 价格/周期）', /在线 /.test(dom.text) && /¥12\.50 \/ 月付/.test(dom.text), dom.text)
  check('详细：读数盒里是真实读数（速率 / 总量 / 到期）',
    /512\.0 KB\/s/.test(dom.text) && /1\.00 TB/.test(dom.text) && /剩余 95 天/.test(dom.text), dom.text)
  check('详细：三网延迟块也照旧', dom.polylines === 3 * dom.cards, `polyline ${dom.polylines} / 卡 ${dom.cards}`)
  check('详细：每节点恰好 1 次延迟请求', ping === 2, `实测 ${ping} 次`)
  check('详细：网格不再有四列（卡片更宽）', !dom.grid.includes('xl:grid-cols-4'), dom.grid)
  check('详细：经典那格不在', dom.classicNet === 0, `找到 ${dom.classicNet} 个`)
}

/* 3b) 详细 + 服务器备注（备注开启）：到期位换价格、在线位让给备注标签 */
{
  const notes = '节点一=东京 · 三网优化\n节点二=备用机'
  const { dom, ping } = await render({ cardStyle: 'detailed', serverNotes: notes }, 'detailed-notes')
  check('详细+备注：备注标签渲染在第一行下方', dom.text.includes('东京 · 三网优化'), dom.text)
  check('详细+备注：在线时长仍在（移到右侧）', /在线 /.test(dom.text), dom.text)
  // 第三格拆成两行来断，别拿整卡文本去匹配 `¥12.50` ——符号被拆成单独一列之后，
  // innerText 在符号与数字之间会多出一个换行（实测 `剩余 95 天 | ¥ | 12.50 / 月付`），
  // 看着像布局坏了、其实是断言写死了「符号紧贴数字」这个旧排版。
  const box3 = JSON.parse(await evalJS(`(() => {
    const card = [...document.querySelectorAll('[role=button]')].find((c) => /CPU/.test(c.innerText))
    const box = [...card.querySelectorAll('[class*="bg-muted/60"]')][2]
    return JSON.stringify({ lines: box ? box.innerText.split('\\n').map((s) => s.trim()).filter(Boolean) : [] })
  })()`))
  check('详细+备注：第三枚读数盒＝上面剩余时间、下面价格 / 周期',
    box3.lines.length === 3 && box3.lines[0] === '剩余 95 天' && box3.lines[1] === '¥' && box3.lines[2] === '12.50 / 月付',
    box3.lines.join(' | '))
  check('详细+备注：到期日（日期那一行）不再显示', !/2027-01-01/.test(dom.text), dom.text)
  check('详细+备注：三枚读数盒与三网延迟照旧', dom.infoBox === 3 && dom.polylines === 3 * dom.cards,
    `盒 ${dom.infoBox} / polyline ${dom.polylines}`)
  check('详细+备注：每节点恰好 1 次延迟请求', ping === 2, `实测 ${ping} 次`)
  // 货币符号单独占一列（不缩进在数字里），左边缘要和上面「剩余时间」前的时钟图标对齐。
  const align = JSON.parse(await evalJS(`(() => {
    const card = [...document.querySelectorAll('[role=button]')].find((c) => /CPU/.test(c.innerText))
    const box = [...card.querySelectorAll('[class*="bg-muted/60"]')][2]
    const clock = box.querySelector('svg')
    const sym = [...box.querySelectorAll('span')].find((s) => s.children.length === 0 && s.textContent.trim() === '¥')
    if (!clock || !sym) return JSON.stringify({ ok: false })
    return JSON.stringify({ ok: true, d: Math.round(sym.getBoundingClientRect().left - clock.getBoundingClientRect().left) })
  })()`))
  check('详细+备注：货币符号单独一列、与时钟图标左对齐', !!align.ok && Math.abs(align.d) <= 2, `左边缘差 ${align?.d}px`)
  // 第三格两行同色：价格行是读数，不该被压成弱化灰（其余两格的第二行都是前景色）。
  const colors = JSON.parse(await evalJS(`(() => {
    const card = [...document.querySelectorAll('[role=button]')].find((c) => /CPU/.test(c.innerText))
    const boxes = [...card.querySelectorAll('[class*="bg-muted/60"]')]
    const top = boxes[2].children[0].querySelector('span.tnum')
    const amt = boxes[2].children[1].querySelector('span.tnum')
    const ref = boxes[0].children[0].querySelector('span.tnum')
    const col = (el) => el ? getComputedStyle(el).color : null
    return JSON.stringify({ top: col(top), amt: col(amt), ref: col(ref) })
  })()`))
  check('详细+备注：第三格两行同色（价格行不再是弱化灰）',
    !!colors.top && colors.top === colors.amt && colors.amt === colors.ref, JSON.stringify(colors))
}
{
  // 备注只影响「详细」档：切到经典/延迟时清单存在也不改卡片形状。
  const { dom } = await render({ cardStyle: 'classic', serverNotes: '节点一=东京 · 三网优化' }, 'classic-notes')
  check('备注不影响经典档（不冒出读数盒与标签）',
    dom.classicNet === 1 && dom.infoBox === 0 && !dom.text.includes('东京 · 三网优化'), dom.text)
}

/* 3c) 详细 + 多枚标签：备注里用逗号分隔＝多枚独立胶囊（写法 `节点一=测试测试,222,333`）。
   这一块的病根是「一枚胶囊里塞着带逗号的整串」——只看文本在不在抓不到，必须数胶囊。 */
const TAGS_PROBE = `(() => {
  const card = [...document.querySelectorAll('[role=button]')].find((c) => /CPU/.test(c.innerText))
  const first = card ? card.querySelector('[data-slot="badge"]') : null
  const wrap = first ? first.parentElement : null
  const row = wrap ? wrap.parentElement : null
  const list = wrap ? [...wrap.querySelectorAll('[data-slot="badge"]')] : []
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), r: Math.round(r.right), y: Math.round(r.top) } }
  const online = row ? [...row.querySelectorAll('span')].find((s) => /^在线 /.test(s.textContent.trim())) : null
  return JSON.stringify({
    n: list.length,
    texts: list.map((b) => b.innerText.trim()),
    boxes: list.map(box),
    rowLeft: row ? Math.round(row.getBoundingClientRect().left) : null,
    rowRight: row ? Math.round(row.getBoundingClientRect().right) : null,
    onlineRight: online ? Math.round(online.getBoundingClientRect().right) : null,
    onlineText: online ? online.textContent.trim() : null,
  })
})()`
{
  const notes = '节点一=测试测试,222,333'
  const { dom } = await render({ cardStyle: 'detailed', serverNotes: notes }, 'tags-three')
  const b = JSON.parse(await evalJS(TAGS_PROBE))
  const tops = [...new Set(b.boxes.map((x) => x.y))]
  check('多标签：逗号分隔的备注挂成 3 枚独立胶囊', b.n === 3, `${b.n} 枚：${b.texts.join(' / ')}`)
  check('多标签：每枚只装自己那一段（逗号不再糊进胶囊里）',
    b.texts.join('|') === '测试测试|222|333' && !b.texts.some((t) => t.includes(',')), b.texts.join('|'))
  check('多标签：三枚在同一行、互不重叠、间距一致',
    tops.length === 1 && b.boxes.every((x, i) => i === 0 || x.x - b.boxes[i - 1].r === 4),
    JSON.stringify(b.boxes))
  check('多标签：末尾那枚没撞上右侧「在线时长」',
    b.onlineRight !== null && b.boxes.at(-1).r <= b.onlineRight, `末枚右 ${b.boxes.at(-1)?.r} / 在线右 ${b.onlineRight}（${b.onlineText}）`)
  check('多标签：「在线时长」仍贴右（与备注关时同一位置）',
    b.onlineRight !== null && Math.abs(b.onlineRight - b.rowRight) <= 1, `在线右 ${b.onlineRight} / 行右 ${b.rowRight}`)
  check('多标签：胶囊没越出卡片左边', b.boxes[0].x >= b.rowLeft, `${b.boxes[0].x} vs ${b.rowLeft}`)
  check('多标签：卡片文本里仍是三段（不是带逗号的整串）', !dom.text.includes('测试测试,222,333'), dom.text)
}
{
  // 排不下要折行，而不是把胶囊压扁或顶出卡片；折行时「在线时长」仍贴右。
  const notes = `节点一=${Array.from({ length: 6 }, (_, i) => `标签${i + 1}号`).join(',')}`
  const { dom } = await render({ cardStyle: 'detailed', serverNotes: notes }, 'tags-wrap')
  const b = JSON.parse(await evalJS(TAGS_PROBE))
  const tops = [...new Set(b.boxes.map((x) => x.y))]
  check('多标签：排不下时折行（六枚都在、分了多行）', b.n === 6 && tops.length >= 2, `行 ${tops.length} / 枚 ${b.n}`)
  check('多标签：折行后「在线时长」仍贴右', b.onlineRight !== null && Math.abs(b.onlineRight - b.rowRight) <= 1,
    `在线右 ${b.onlineRight} / 行右 ${b.rowRight}`)
  check('多标签：折行后没有横向溢出（每枚都在行内、不撞在线时长）',
    b.boxes.every((x) => x.x >= b.rowLeft - 1 && x.r <= b.onlineRight + 1), JSON.stringify(b.boxes))
  check('多标签：整体不超过卡片（备注区不撑破卡片）', b.boxes.every((x) => x.r <= b.rowRight + 1), JSON.stringify(b.boxes))
  check('多标签：长清单下经典那格仍不在（只是多了标签）', dom.classicNet === 0, `${dom.classicNet}`)
}
{
  // 没写逗号的单枚备注不许变成多枚，也不许换行。
  const { dom } = await render({ cardStyle: 'detailed', serverNotes: '节点一=东京 · 三网优化' }, 'tags-one')
  const b = JSON.parse(await evalJS(TAGS_PROBE))
  check('单标签：一枚就是一枚（不因为改功能而多出胶囊）', b.n === 1 && b.texts[0] === '东京 · 三网优化', `${b.n} 枚：${b.texts.join('/')}`)
  check('单标签：仍与左侧对齐、在线时长贴右', b.boxes[0].x >= b.rowLeft && Math.abs(b.onlineRight - b.rowRight) <= 1,
    `X ${b.boxes[0].x}/${b.rowLeft} 在线右 ${b.onlineRight}/${b.rowRight}`)
  check('单标签：卡片文本照旧（备注关这一档没被这次改动碰到）', /剩余 95 天/.test(dom.text), dom.text)
}

/* 4) 旧值 detail 必须迁到延迟，不能掉回经典 */
{
  const { dom, ping } = await render({ cardStyle: 'detail' }, 'detail-old')
  check('旧值 detail → 延迟（三网延迟块在）', dom.polylines === 3 * dom.cards && dom.latencyRow === 1, `polyline ${dom.polylines} / 行 ${dom.latencyRow}`)
  check('旧值 detail → 延迟（不是经典）', dom.classicNet === 0, `经典格 ${dom.classicNet}`)
  check('旧值 detail → 延迟（不发多次请求）', ping === 2, `实测 ${ping} 次`)
  check('旧值 detail → 延迟（不显示详细档的状态点与读数盒）', dom.dots === 0 && dom.infoBox === 0, `点 ${dom.dots} / 盒 ${dom.infoBox}`)
}

/* 5) 完全没有配置 / 非法值 → 回落经典 */
for (const [cfg, tag] of [[{}, 'empty'], [{ cardStyle: 'bogus' }, 'bogus']]) {
  const { dom, ping } = await render(cfg, tag)
  check(`非法值 ${tag} → 回落经典（含不发延迟请求）`,
    dom.classicNet === 1 && dom.latencyRow === 0 && dom.infoBox === 0 && ping === 0,
    `经典 ${dom.classicNet} / 行 ${dom.latencyRow} / 盒 ${dom.infoBox} / 请求 ${ping}`)
}

/* 6) 紧凑形态：一行一台的表格 */
{
  const { dom, ping } = await renderCompact({ cardStyle: 'compact' }, 1440, 'compact')
  check('紧凑：渲染成一张表、一行一台（3 台 = 3 行）', dom.tables === 1 && dom.rows === 3, `表 ${dom.tables} / 行 ${dom.rows}`)
  check('紧凑：宽屏十一列齐全（列序对齐源站，另加续费价）', dom.heads.join('/') === '名称/系统/在线/剩余/价格/负载/网速 ↓|↑/CPU/内存/硬盘/流量', dom.heads.join('/'))
  check('紧凑：不再是卡片网格（没有 xl 四列）', !dom.grid4, '仍带 xl:grid-cols-4')
  check('紧凑：每行四根进度条（CPU / 内存 / 硬盘 / 流量）', dom.bars === 4 * dom.rows, `条 ${dom.bars} / 行 ${dom.rows}`)
  check('紧凑：表头与数值都在（读到 CPU 与流量读数）', /13%/.test(dom.text) && /1\.00 TB/.test(dom.text), dom.text)
  check('紧凑：不发延迟请求（这一档不含三网延迟）', ping === 0, `实测 ${ping} 次`)
}

/* 6b) 列随屏宽收放 */
{
  const { dom } = await renderCompact({ cardStyle: 'compact' }, 1100, 'compact-lg')
  check('紧凑 lg（1100）：剩余与价格回来、系统还收着，十列',
    dom.cells === 10 && dom.heads.includes('剩余') && dom.heads.includes('价格') && !dom.heads.includes('系统'), `${dom.cells} 列：${dom.heads.join('/')}`)
  check('紧凑 lg：无横向溢出', !dom.overflowX, '横向溢出')
}
{
  const { dom } = await renderCompact({ cardStyle: 'compact' }, 900, 'compact-md')
  check('紧凑 md（900）：系统 / 剩余 / 价格 收掉，剩八列',
    dom.cells === 8 && !dom.heads.includes('系统') && !dom.heads.includes('剩余') && !dom.heads.includes('价格'), `${dom.cells} 列：${dom.heads.join('/')}`)
  check('紧凑 md：无横向溢出', !dom.overflowX, '横向溢出')
}
{
  const { dom, ping } = await renderCompact({ cardStyle: 'compact' }, 700, 'compact-sm')
  check('紧凑 sm（700）：在线 / 负载 / 硬盘 收掉，剩五列',
    dom.cells === 5 && !dom.heads.includes('在线') && !dom.heads.includes('负载') && !dom.heads.includes('硬盘'), `${dom.cells} 列：${dom.heads.join('/')}`)
  check('紧凑 sm：无横向溢出', !dom.overflowX, '横向溢出')
  check('紧凑 sm：仍不发延迟请求', ping === 0, `实测 ${ping} 次`)
}
{
  const { dom } = await renderCompact({ cardStyle: 'compact' }, 480, 'compact-xs')
  check('紧凑窄屏（480）：只留名称 / CPU / 流量三列', dom.cells === 3, `${dom.cells} 列：${dom.heads.join('/')}`)
  check('紧凑窄屏：表头仍在（窄屏也告诉访客哪列是什么）', dom.heads.join('/') === '名称/CPU/流量', dom.heads.join('/'))
  check('紧凑窄屏：无横向溢出', !dom.overflowX, '横向溢出')
}

/* 6c) 超长机器名不把表格撑出屏幕 */
{
  await renderCompact({ cardStyle: 'compact' }, 1000, 'compact-long')
  const long = JSON.parse(await evalJS(`(() => {
    const span = document.querySelector('tbody tr[role=button] td span.truncate')
    span.textContent = '超长机器名'.repeat(40)
    return JSON.stringify({
      tableW: Math.round(document.querySelector('table').getBoundingClientRect().width),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      clipped: span.scrollWidth > span.clientWidth,
    })
  })()`))
  check('紧凑：超长机器名被截断、不把表格撑出屏幕', long.clipped && !long.overflowX, JSON.stringify(long))
}

/* 6d) 点一行就地展开延迟，不跳详情页（源站的做法） */
{
  await renderCompact({ cardStyle: 'compact' }, 1440, 'compact-open')
  await evalJS(`(() => { const r = document.querySelector('tbody tr[role=button]'); if (r) r.click(); return r ? 'ok' : 'no-row' })()`)
  await sleep(2000) // 等 NodeDetail 那个 chunk 与延迟图落地
  // 包一层 try：求值撞上重渲染时会丢上下文，直接 JSON.parse(undefined) 会让整脚本莫名地断在这里。
  const raw = await evalJS(`(() => { try { return JSON.stringify({
    path: location.pathname,
    expanded: !!document.querySelector('tbody tr[aria-expanded="true"]'),
    rows: document.querySelectorAll('tbody tr').length,
    detailLink: [...document.querySelectorAll('button')].some((b) => /完整详情/.test(b.textContent)),
    svg: document.querySelectorAll('tbody tr td[colspan] svg').length,
    rangePills: /1 小时/.test(document.body.innerText) && /7 天/.test(document.body.innerText),
  }) } catch (e) { return JSON.stringify({ error: String(e), path: location.pathname }) } })()`)
  const state = JSON.parse(raw ?? '{"error":"eval 返回 undefined"}')
  check('紧凑：点一行就地展开、不跳详情页', state.path === '/' && state.expanded === true && state.rows === 4, raw)
  check('紧凑：展开里是延迟图（含 1/6/24/7 天范围）', state.svg > 0 && state.rangePills === true, raw)
  check('紧凑：展开行留有去整页详情的入口', state.detailLink === true, raw)
}

ws.close()
chrome.kill()
server.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} PASS / ${failed.length} FAIL`)
process.exit(failed.length ? 1 : 0)

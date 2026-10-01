// 验「卡片形态」五档（经典 / 简约 / 延迟 / 详细 / 紧凑）在真实渲染里各自的形状，以及旧值 detail → latency 的迁移。
//
// 用法：node tools/verify_card_styles.mjs [port]
//
// 为什么要它：各档的差别全在 NodeCard / CompactList 里的条件分支上，改一处分支很容易让另一档跟着变
// （或让 classic 悄悄开始拉延迟数据）。这里用本机静态伺服 + 桩 /api/*（含带 ping 历史的
// /api/nodes/{id}/metrics）跑真 React 组件，逐档断言 DOM 形状、访客端请求数与列表上的读数：
//
//   经典   —— 底部网络收成一行（左实时速率 / 右累计，文字箭头 ↓↑）；不发任何 ping 请求；
//             标签弱化灰 / 条 6px / 底注 12px / 名字 500
//   简约   —— 与经典同结构、同文本，只换视觉：标签前景色 / 条 4px（上下 6px）/ 底注 11px /
//             名字 600 / 格行距 12px；同样不发 ping 请求（两边都钉住，才叫「只换了这一套」）
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
    netRow: q('[data-net="row"]'),
    netGrid: q('[data-net="grid"]'),
    // 经典档底部那 2×2 四格：格子数 / 栅格列数 / 有没有 svg（箭头应该是文字）/ 两端配色。
    // 找不到时返回**空壳**而不是 null：否则旧构建上第一条断言就抛 TypeError，
    // 把后面几十条一起带走，反向自测时看不出到底该报哪些（这条踩过）。
    netG: (() => {
      const g = first ? first.querySelector('[data-net="grid"]') : null
      const empty = { cells: 0, cols: 0, svg: 0, text: '', mt: '', pt: '', fs: '', border: '', rateColor: null, arrowColor: null, totalColor: null }
      if (!g) return empty
      const cs = (el) => el ? getComputedStyle(el) : null
      const cells = [...g.children]
      return {
        cells: cells.length,
        cols: cs(g).gridTemplateColumns.split(' ').filter(Boolean).length,
        svg: g.querySelectorAll('svg').length,
        text: g.innerText.replace(/\\n/g, ' | '),
        mt: cs(g).marginTop, pt: cs(g).paddingTop, fs: cs(g).fontSize, border: cs(g).borderTopWidth,
        rateColor: cells[0] ? cs(cells[0]).color : null,
        arrowColor: cells[0] && cells[0].children[0] ? cs(cells[0].children[0]).color : null,
        totalColor: cells[2] ? cs(cells[2]).color : null,
      }
    })(),
    // 卡片底部那一行网络（经典/简约档）：子元素数、有没有 svg 图标、左右两端的配色与间距。
    net: (() => {
      const row = first ? first.querySelector('[data-net="row"]') : null
      if (!row) return null
      const cs = (el) => el ? getComputedStyle(el) : null
      const spans = [...row.children]
      return {
        children: row.children.length,
        svg: row.querySelectorAll('svg').length,
        text: row.innerText.replace(/\\n/g, ' | '),
        leftColor: spans[0] ? cs(spans[0]).color : null,
        rightColor: spans[1] ? cs(spans[1]).color : null,
        marginTop: cs(row).marginTop,
        paddingTop: cs(row).paddingTop,
        borderTop: cs(row).borderTopWidth,
        font: cs(row).fontSize,
        justify: cs(row).justifyContent,
      }
    })(),
    infoBox: q('[class*="bg-muted/60"]'),
    infoGrid: q('[class*="grid-cols-3"]'),
    dots: all.reduce((n, c) => n + c.querySelectorAll('span[aria-label="在线"],span[aria-label="离线"],span[aria-label="刚接入"]').length, 0),
    dotLabels: all.map((c) => [...c.querySelectorAll('span[aria-label]')].map((s) => s.getAttribute('aria-label')).join('+')),
    polylines: document.querySelectorAll('svg polyline').length,
    rows: [...(first?.querySelectorAll('[class*="border-t"] span.w-16') ?? [])].map((s) => s.textContent.trim()),
    text: first ? first.innerText.replace(/\\n/g, ' | ') : '',
  }
})())`

// 简约档专用探针：结构断言仍借 PROBE，这里量的是它换掉的那几把尺子。
// 取数一律**按结构**（卡片第 2 个孩子 = 读数格，格里的第 1 块 = CPU），不认 Tailwind 类名。
const PLAIN_PROBE = `JSON.stringify((() => {
  const card = [...document.querySelectorAll('[role=button]')].find((c) => /CPU/.test(c.innerText))
  if (!card) return null
  const grid = card.children[1]
  const box = grid ? grid.children[0] : null
  const label = box ? box.children[0].children[0].children[0] : null
  const bar = box ? box.children[1] : null
  const foot = box ? box.children[2] : null
  const name = card.querySelector('h3')
  const cs = (el) => el ? getComputedStyle(el) : null
  return {
    radius: cs(card).borderRadius,
    shadow: cs(card).boxShadow,
    cardBorder: cs(card).borderColor,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    fillColor: bar && bar.firstElementChild ? cs(bar.firstElementChild).backgroundColor : null,
    nameWeight: name ? cs(name).fontWeight : null,
    labelColor: label ? cs(label).color : null,
    pctColor: box ? cs(box.children[0].lastElementChild).color : null,
    footColor: foot ? cs(foot).color : null,
    barH: bar ? cs(bar).height : null,
    barTop: bar ? cs(bar).marginTop : null,
    barBottom: bar ? cs(bar).marginBottom : null,
    footSize: foot ? cs(foot).fontSize : null,
    rowGap: grid ? cs(grid).rowGap : null,
    text: card.innerText.replace(/\\n/g, ' | '),
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

/* 1) 经典（顺带量一遍它的四项视觉值，作为简约档那几条的对照——两边都钉住才叫「只换了这一套」） */
let classicStyle = null
{
  const { dom, ping } = await render({ cardStyle: 'classic' }, 'classic')
  classicStyle = JSON.parse(await evalJS(PLAIN_PROBE))
  check('卡片壳：圆角 10px（rounded-lg；参考站是这个，不是 rounded-xl 的 14px）',
    classicStyle.radius === '10px', classicStyle.radius)
  check('卡片壳：无投影（参考站靠「浅灰页 + 白卡 + 一道描边」托出来，不用阴影）',
    classicStyle.shadow === 'none', classicStyle.shadow)
  check('卡片壳：页面底色是浅灰 oklch(0.985 0 0)（原来是纯白，卡片浮不出来）',
    classicStyle.bodyBg === 'oklch(0.985 0 0)', classicStyle.bodyBg)
  check('卡片壳：描边是那一档冷灰 oklch(0.92 0.004 286.32)',
    classicStyle.cardBorder === 'oklch(0.92 0.004 286.32)', classicStyle.cardBorder)
  check('桩数据已落到卡片（CPU 13% / 内存 1.00 / 2.00 GB / 总量 1.00 TB 与 256 GB）',
    /1[23]%/.test(dom.text) && /1\.00 \/ 2\.00 GB/.test(dom.text) && /1\.00 TB/.test(dom.text) && /256 GB/.test(dom.text),
    dom.text)
  // ── 经典档底部 = **原本的 2×2 四格**（速率一行、总量一行），与「简约」那条一行两段不是一回事。
  check('经典：底部是 2×2 四格，不是简约那条一行两段',
    dom.netGrid === 1 && dom.netRow === 0, `四格 ${dom.netGrid} / 一行 ${dom.netRow}`)
  check('经典：两列四格、箭头是文字不是图标',
    dom.netG.cells === 4 && dom.netG.cols === 2 && dom.netG.svg === 0,
    JSON.stringify({ cells: dom.netG.cells, cols: dom.netG.cols, svg: dom.netG.svg }))
  // 归一化要连单位一起吃掉（KB/s、GB、TB 会随数据变），只留「箭头 + 数值」的次序与空格。
  check('经典：四格文案＝↓ 速率 / ↑ 速率 / ↓ 总量 / ↑ 总量（箭头与数值之间有空格）',
    dom.netG.text.replace(/[0-9][0-9.,]*(\s*[A-Za-z/]+)?/g, '#') === '↓ # | ↑ # | ↓ # | ↑ #', dom.netG.text)
  check('经典：速率那行是前景色、箭头弱化；总量那行整格弱化',
    dom.netG.arrowColor !== dom.netG.rateColor && dom.netG.totalColor === dom.netG.arrowColor,
    JSON.stringify({ arrow: dom.netG.arrowColor, rate: dom.netG.rateColor, total: dom.netG.totalColor }))
  check('经典：四格的分隔线与间距（mt 16px / pt 16px / 12px 字号 / 一道分隔线）',
    dom.netG.mt === '16px' && dom.netG.pt === '16px' && dom.netG.fs === '12px' && dom.netG.border === '1px',
    JSON.stringify({ mt: dom.netG.mt, pt: dom.netG.pt, fs: dom.netG.fs, border: dom.netG.border }))
  check('经典：没有延迟块', dom.polylines === 0, `polyline ${dom.polylines}`)
  check('经典：不发延迟请求', ping === 0, `实测 ${ping} 次`)
  check('经典：无状态点、无读数盒', dom.dots === 0 && dom.infoBox === 0, `点 ${dom.dots} / 盒 ${dom.infoBox}`)
  check('经典：网格保留 xl 四列', dom.grid.includes('xl:grid-cols-4'), dom.grid)
  check('经典：标签与底注同为弱化灰（标签没被提亮）',
    classicStyle.labelColor === classicStyle.footColor, `${classicStyle.labelColor} vs ${classicStyle.footColor}`)
  check('经典：条 6px、底注 12px、名字 500、格行距 16px',
    classicStyle.barH === '6px' && classicStyle.footSize === '12px' && classicStyle.nameWeight === '500' && classicStyle.rowGap === '16px',
    JSON.stringify({ barH: classicStyle.barH, footSize: classicStyle.footSize, nameWeight: classicStyle.nameWeight, rowGap: classicStyle.rowGap }))
}

/* 1b) 简约：与经典**同结构、同内容**，只换一套视觉处理（标签提亮 / 条压细 / 底注变小 / 名字加粗 / 行距收紧） */
{
  const { dom, ping } = await render({ cardStyle: 'plain' }, 'plain')
  const s = JSON.parse(await evalJS(PLAIN_PROBE))
  check('简约：底部是一行两段、无延迟块、无读数盒',
    dom.netRow === 1 && dom.netGrid === 0 && dom.polylines === 0 && dom.infoBox === 0,
    `网络行 ${dom.netRow} / 四格 ${dom.netGrid} / 盒 ${dom.infoBox} / polyline ${dom.polylines}`)
  // 经典档恢复成 2×2 四格之后，两档**不再是同版式**，所以这里不再比「文本逐字相同」——
  // 改成断简约自己那条一行两段的形状（上面那条）＋下面几条视觉尺子。
  check('简约：一行两段是「左实时速率 + 右累计总量」（与经典的四格不同形状）',
    dom.net !== null && dom.net.children === 2 && dom.net.justify === 'space-between' && dom.net.svg === 0,
    `子元素 ${dom.net?.children} / 对齐 ${dom.net?.justify} / svg ${dom.net?.svg}`)
  check('简约：不发延迟请求（这一档与经典一样不含三网延迟）', ping === 0, `实测 ${ping} 次`)
  check('简约：网格保留 xl 四列（版式没被这一档改掉）', dom.grid.includes('xl:grid-cols-4'), dom.grid)
  check('简约：标签提亮成前景色（与底注那层弱化灰不同）',
    s.labelColor !== s.footColor, `${s.labelColor} vs ${s.footColor}`)
  check('简约：标签与百分比同色（同一行左右两截亮度一致）',
    s.labelColor === s.pctColor, `${s.labelColor} vs ${s.pctColor}`)
  check('简约：进度条压到 4px、上下各留 6px',
    s.barH === '4px' && s.barTop === '6px' && s.barBottom === '6px',
    JSON.stringify({ h: s.barH, top: s.barTop, bottom: s.barBottom }))
  check('简约：底注降到 11px', s.footSize === '11px', s.footSize)
  check('简约：名字加粗一档（600，经典是 500）', s.nameWeight === '600', s.nameWeight)
  check('简约：读数格行距收紧到 12px（经典 16px）', s.rowGap === '12px', s.rowGap)
}

/* 2) 延迟（新名字） */
{
  // 对照组：**简约**档底部那一行的量值（经典档已恢复成 2×2 四格，不再是这一档的参照）。
  // 判据写成**逐项等价**（结构 / 两端配色 / 间距 / 分隔线 / 两端对齐 + 文案形状），
  // 而不是「形状差不多」——只断自己等于没证明「看齐了」。
  const base = await render({ cardStyle: 'plain' }, 'latency-vs-plain')
  const { dom, ping } = await render({ cardStyle: 'latency' }, 'latency')
  const geom = (n) => JSON.stringify({
    seg: n.children, svg: n.svg, left: n.leftColor, right: n.rightColor,
    mt: n.marginTop, pt: n.paddingTop, border: n.borderTop, fs: n.font, justify: n.justify,
    text: n.text.replace(/[0-9][0-9.,]*/g, '#'),
  })
  check('延迟：底部那行与「简约」逐项相同（结构 · 配色 · 间距 · 两端对齐 · 文案形状）',
    dom.net !== null && base.dom.net !== null && geom(dom.net) === geom(base.dom.net),
    `延迟 ${geom(dom.net)} / 简约 ${geom(base.dom.net)}`)
  check('延迟：不是经典档那 2×2 四格', dom.netGrid === 0, `四格 ${dom.netGrid}`)
  check('延迟：那行是「实时速率在左、累计总量在右」两段，两端配色不同',
    dom.net.children === 2 && dom.net.leftColor !== dom.net.rightColor,
    `${dom.net.children} 段 / ${dom.net.leftColor} vs ${dom.net.rightColor}`)
  check('延迟：不再是从前那条「速率 · 总量」分隔点式（图标箭头也没了，箭头是文字）',
    !/·/.test(dom.net.text) && dom.net.svg === 0 && /↓/.test(dom.net.text) && /↑/.test(dom.net.text),
    `svg ${dom.net.svg} / ${dom.net.text}`)
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

/* 2b) 延迟档右上角那枚「信息」控件：悬停 / 点击弹浮层，里面是备注 + 在线时间 + 价格 + 到期。
   判据三件套：① 控件是原生 button + aria-expanded（不是静态文本，也不是装饰图标）；
   ② 默认关闭时卡片与没有备注时**逐像素相同**（浮层不占位）；③ 悬停/点击/键盘都不会打开详情页
   （卡片自己是 role=button），并带**对照组**证明这条判据不是恒真。 */
const PEEK_PROBE = `JSON.stringify((() => {
  const card = [...document.querySelectorAll('[role=button]')].find((c) => /CPU/.test(c.innerText))
  if (!card) return { missing: true }
  const btn = card.querySelector('[data-note-popover]')
  const panel = card.querySelector('[data-note-panel]')
  const rect = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), r: Math.round(b.right), mid: Math.round(b.top + b.height / 2), bottom: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) } }
  const grid = card.querySelector('.grid.grid-cols-2')
  const cRect = card.getBoundingClientRect()
  const h3 = card.querySelector('h3')
  return {
    cardH: Math.round(cRect.height),
    cardTop: Math.round(cRect.top),
    cardRight: Math.round(cRect.right),
    cardBottom: Math.round(cRect.bottom),
    gridTop: grid ? Math.round(grid.getBoundingClientRect().top - cRect.top) : null,
    rowH: h3 ? Math.round(h3.parentElement.getBoundingClientRect().height) : null,
    badges: card.querySelectorAll('[data-slot="badge"]').length,
    nameClipped: h3 ? h3.scrollWidth > h3.clientWidth + 1 : null,
    btn: btn ? { tag: btn.tagName, expanded: btn.getAttribute('aria-expanded'), ...rect(btn) } : null,
    panel: panel ? { text: panel.innerText.replace(/\\n/g, ' | '), ...rect(panel) } : null,
    path: location.pathname,
    text: card.innerText.replace(/\\n/g, ' | '),
  }
})())`

// 悬停那一步走真鼠标（CDP Input.dispatchMouseEvent）——比在页面里派发合成事件可信，
// 也顺带证明 onPointerEnter/onPointerLeave 这套真的接上了。
const hover = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await sleep(400)
}
const moveAway = async () => hover(4, 4)

{
  await render({ cardStyle: 'latency' }, 'peek-base')
  const base = JSON.parse(await evalJS(PEEK_PROBE))
  await render({ cardStyle: 'latency', serverNotes: '节点一=东京 · 三网优化,备用' }, 'peek-closed')
  const closed = JSON.parse(await evalJS(PEEK_PROBE))
  check('延迟+浮层：右上角有一枚原生 button 控件（aria-expanded=false，浮层默认不渲染）',
    closed.btn?.tag === 'BUTTON' && closed.btn.expanded === 'false' && closed.panel === null,
    JSON.stringify(closed.btn) + ' / 浮层 ' + (closed.panel ? '在' : '不在'))
  // ★两个坐标别混用：btn.mid 是视口坐标，gridTop 是「相对卡片上沿」的偏移 —— 直接比会得出
  // 「控件在读数格下面」这种假红（第一版就是这么写的）。要么都换成视口坐标，要么都换相对值。
  // 判的是「贴着右上角」，不是「与内边距分毫不差」：卡片内边距 16px，两套皮肤实测 17 / 18px
  // （皮肤自带描边与位移类），所以给到 3px 容差，别为这两像素去改代码。
  check('延迟+浮层：控件贴在卡片右上角、且在读数格之上',
    closed.btn !== null && Math.abs(closed.cardRight - closed.btn.r - 16) <= 3 && closed.btn.mid < closed.cardTop + closed.gridTop,
    `卡右 ${closed.cardRight} / 控件右 ${closed.btn?.r}（差 ${closed.cardRight - (closed.btn?.r ?? 0)}px）/ 控件中线 ${closed.btn?.mid} vs 读数格上沿 ${closed.cardTop + closed.gridTop}`)
  check('延迟+浮层：标题行不再挂备注胶囊（备注只在浮层里）', closed.badges === 0, `胶囊 ${closed.badges} 枚`)
  check('延迟+浮层：默认状态与「没有备注」时逐像素相同（浮层不占位）',
    closed.cardH === base.cardH && closed.gridTop === base.gridTop && closed.rowH === base.rowH,
    `高 ${closed.cardH}/${base.cardH} 格上沿 ${closed.gridTop}/${base.gridTop} 行高 ${closed.rowH}/${base.rowH}`)
  check('延迟+浮层：卡片正文里没有备注文字（没填备注的站点看不到任何痕迹）',
    !closed.text.includes('三网优化') && !closed.text.includes('备用'), closed.text)
  check('延迟+浮层：名字没被控件挤到截断', closed.nameClipped === false, `截断=${closed.nameClipped}`)

  if (closed.btn) await hover(closed.btn.x + closed.btn.w / 2, closed.btn.mid)
  const hovered = JSON.parse(await evalJS(PEEK_PROBE))
  check('延迟+浮层：悬停即弹出（aria-expanded=true，浮层渲染出来）',
    hovered.btn?.expanded === 'true' && hovered.panel !== null, JSON.stringify(hovered.btn))
  const t = hovered.panel?.text ?? ''
  check('延迟+浮层：浮层里备注列全（两枚胶囊都在）', t.includes('东京 · 三网优化') && t.includes('备用'), t)
  check('延迟+浮层：浮层里有在线时间（口径同「详细」档）', /在线 4 天/.test(t), t)
  check('延迟+浮层：浮层里有价格与计费周期', t.includes('¥12.50 / 月付'), t)
  check('延迟+浮层：浮层里有到期（按 hub 的 expires_in 算）', t.includes('剩余 95 天'), t)
  check('延迟+浮层：悬停不会跳详情页（仍在列表页）', hovered.path === '/', hovered.path)

  await moveAway()
  const away = JSON.parse(await evalJS(PEEK_PROBE))
  check('延迟+浮层：鼠标移开就收起（回到与关闭态一致）',
    away.panel === null && away.btn?.expanded === 'false' && away.cardH === closed.cardH,
    `浮层 ${away.panel ? '在' : '不在'} / 高 ${away.cardH}/${closed.cardH}`)

  // 点击：手机端没有悬停，这条路必须能开；且点它**不许**连带打开详情页。
  const clickedPath = await evalJS(`(() => { const b = document.querySelector('[data-note-popover]'); if (!b) return 'no-btn'; b.click(); return location.pathname })()`)
  await sleep(300)
  const clicked = JSON.parse(await evalJS(PEEK_PROBE))
  check('延迟+浮层：点一下就开（手机端的唯一入口）', clicked.panel !== null && clicked.btn?.expanded === 'true', JSON.stringify(clicked.btn))
  check('延迟+浮层：点这枚控件不会打开详情页（仍在列表页）', clickedPath === '/' && clicked.path === '/', `点击那一刻 ${clickedPath} / 复测 ${clicked.path}`)
  check('延迟+浮层：浮层不越出卡片（右沿与下沿都在卡片内）',
    clicked.panel !== null && clicked.panel.r <= clicked.cardRight + 1 && clicked.panel.x >= 0,
    `浮层 ${clicked.panel?.x}~${clicked.panel?.r} / 卡右 ${clicked.cardRight}`)

  // 键盘：Escape 收起；Enter 冒泡不许把详情页打开（卡片自己是 role=button）。
  const esc = await evalJS(`(() => {
    const b = document.querySelector('[data-note-popover]')
    b.focus()
    b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    return location.pathname
  })()`)
  await sleep(300)
  const afterEsc = JSON.parse(await evalJS(PEEK_PROBE))
  check('延迟+浮层：Escape 收起，且不跳详情页', afterEsc.panel === null && esc === '/' && afterEsc.path === '/', `浮层 ${afterEsc.panel ? '在' : '不在'} / ${esc}`)
  const enterPath = await evalJS(`(() => {
    const b = document.querySelector('[data-note-popover]')
    b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return location.pathname
  })()`)
  await sleep(300)
  const afterEnter = JSON.parse(await evalJS(PEEK_PROBE))
  check('延迟+浮层：Enter 冒泡到控件上不会打开详情页', enterPath === '/' && afterEnter.path === '/', `${enterPath} / ${afterEnter.path}`)
  // 对照组：同样的点击/Enter 打在**卡片本体**上确实会跳详情页（证明上面两条不是恒真）。
  const cardClick = await evalJS(`(() => {
    const c = [...document.querySelectorAll('[role=button]')].find((el) => /CPU/.test(el.innerText))
    if (!c) return 'no-card'
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return location.pathname
  })()`)
  await sleep(400)
  check('延迟+浮层：对照组——同样的 Enter 打在卡片本体上确实会跳详情页（判据不是恒真）',
    typeof cardClick === 'string' && cardClick.startsWith('/node'), `卡片上 ${cardClick}`)
}
{
  // 手机窄屏（390）：控件在、点得开、无横向溢出、浮层不越出卡片。
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1200, deviceScaleFactor: 1, mobile: true })
  await render({ cardStyle: 'latency', serverNotes: '节点一=东京 · 三网优化,备用' }, 'peek-mobile')
  const before = JSON.parse(await evalJS(PEEK_PROBE))
  await evalJS(`(() => { const b = document.querySelector('[data-note-popover]'); if (b) b.click(); return true })()`)
  await sleep(300)
  const after = JSON.parse(await evalJS(PEEK_PROBE))
  const overflow = await evalJS(`document.documentElement.scrollWidth > document.documentElement.clientWidth`)
  check('延迟+浮层（手机 390）：控件在、点得开、四段信息齐',
    before.btn?.tag === 'BUTTON' && after.panel !== null && /在线 /.test(after.panel?.text ?? '') && (after.panel?.text ?? '').includes('剩余 95 天'),
    after.panel?.text)
  check('延迟+浮层（手机 390）：无横向溢出、浮层不越出卡片、名字不被挤断',
    overflow === false && after.panel !== null && after.panel.r <= after.cardRight + 1 && after.nameClipped === false,
    `溢出 ${overflow} / 浮层右 ${after.panel?.r} / 卡右 ${after.cardRight}`)
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false })
}
{
  // 这枚控件只属于「延迟」档：详细档本来就有这些信息，经典/简约两档也不该冒出它。
  for (const [cfg, tag] of [[{ cardStyle: 'detailed' }, 'peek-not-detailed'], [{ cardStyle: 'classic' }, 'peek-not-classic'], [{ cardStyle: 'plain' }, 'peek-not-plain']]) {
    await render({ ...cfg, serverNotes: '节点一=东京 · 三网优化' }, tag)
    const dom = JSON.parse(await evalJS(PEEK_PROBE))
    check(`浮层控件只在延迟档：${cfg.cardStyle} 档上没有它`, dom.btn === null && dom.panel === null, JSON.stringify(dom.btn))
  }
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
  check('详细：经典的四格不在', dom.netRow === 0 && dom.netGrid === 0, `一行 ${dom.netRow} / 四格 ${dom.netGrid}`)
}

/* 3b) 「详细」档 + 服务器备注：备注挂在**标题行右端**（2026-10-02 起的落点）。
   这一版的关键判据是「**不重排**」：以前备注开启会把价格挤进第三枚读数盒、把到期日藏起来，
   现在这些位置一个都不许动 —— 在线时长仍在第二行左、价格仍在右、第三枚读数盒下面仍是到期日。 */
const TITLE_PROBE = `JSON.stringify((() => {
  const card = [...document.querySelectorAll('[role=button]')].find((c) => /CPU/.test(c.innerText))
  if (!card) return { missing: true }
  const h3 = card.querySelector('h3')
  const row = h3 ? h3.parentElement : null
  const badges = row ? [...row.querySelectorAll('[data-slot="badge"]')] : []
  const rect = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), r: Math.round(b.right), mid: Math.round(b.top + b.height / 2), w: Math.round(b.width) } }
  const cRect = card.getBoundingClientRect()
  const grid = card.querySelector('.grid.grid-cols-2')
  const boxes = [...card.querySelectorAll('[class*="bg-muted/60"]')]
  const row2 = card.querySelector('.grid.grid-cols-2')?.previousElementSibling ?? null
  // ★别用「货币符号正则」去这一行里找价格：模板字面量里写的反斜杠美元会被吞成裸的美元号，
  // 而美元号在正则里是「行尾」锚点，整个正则就退化成「匹配任何字符串」—— 第一版就这样拿到了
  // 「在线时长」那一枚，报出「价格没贴右」的假红。直接取这一行的最后一枚 span（就是价格那截）。
  // （注意：这段注释是写在页面侧的探针里的，别在这里写反引号 —— 会把外层模板字面量截断。）
  const spans = row2 ? [...row2.querySelectorAll('span')] : []
  const price = spans.length > 0 ? spans[spans.length - 1] : null
  return {
    cardH: Math.round(cRect.height),
    cardTop: Math.round(cRect.top),
    cardRight: Math.round(cRect.right),
    rowH: row ? Math.round(row.getBoundingClientRect().height) : null,
    name: h3 ? h3.innerText.trim() : null,
    nameBox: h3 ? rect(h3) : null,
    nameClipped: h3 ? h3.scrollWidth > h3.clientWidth + 1 : null,
    badges: badges.map((b) => ({ text: b.innerText.trim(), ...rect(b) })),
    gridTop: grid ? Math.round(grid.getBoundingClientRect().top - cRect.top) : null,
    row2Text: row2 ? row2.innerText.replace(/\\n/g, ' | ') : null,
    priceRight: price ? Math.round(price.getBoundingClientRect().right) : null,
    priceText: price ? price.textContent.trim() : null,
    row2Right: row2 ? Math.round(row2.getBoundingClientRect().right) : null,
    box3: boxes[2] ? boxes[2].innerText.split('\\n').map((t) => t.trim()).filter(Boolean) : null,
    boxes: boxes.length,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    text: card.innerText.replace(/\\n/g, ' | '),
  }
})())`

let detailedBase = null
{
  await render({ cardStyle: 'detailed' }, 'detailed-base')
  detailedBase = JSON.parse(await evalJS(TITLE_PROBE))
  const { dom } = await render({ cardStyle: 'detailed', serverNotes: '节点一=测试测试,222,333' }, 'detailed-notes-title')
  const b = JSON.parse(await evalJS(TITLE_PROBE))
  // 空壳兜底 + **每条都带 length 判据**：拿不到标签时 `[].every(...)` 会恒真、`[0].x` 会抛，
  // 两种毛病都要避掉（本文件里「反向自测时看不出一共该报几条」的坑复发过一次）。
  const fb = b.badges?.[0] ?? { x: 0, r: 0, mid: null, w: 0, text: '' }
  const fl = b.badges?.at(-1) ?? fb
  const nm = b.nameBox ?? { x: 0, r: 0, mid: null, w: 0 }
  check('详细+备注：三枚标签都挂在标题行右端（同一行、跟着名字）',
    b.badges?.length === 3 && b.badges.map((x) => x.text).join('|') === '测试测试|222|333',
    b.badges?.map((x) => x.text).join('|') || '(没有标签)')
  check('详细+备注：标签与名字在同一水平线上',
    b.badges?.length > 0 && b.badges.every((x) => Math.abs(x.mid - nm.mid) <= 1),
    `名字中线 ${nm.mid} / 标签 ${b.badges?.map((x) => x.mid).join(',')}`)
  check('详细+备注：标签排在名字右边、贴卡片右沿（不与名字重叠）',
    b.badges?.length === 3 && fb.x >= nm.r && Math.abs(b.cardRight - fl.r - 16) <= 3,
    `名字右 ${nm.r} / 首枚左 ${fb.x} / 末枚右 ${fl.r} / 卡右 ${b.cardRight}`)
  check('详细+备注：卡片总高与标题行高都与不开备注时逐像素相同（这一版不重排、不加高）',
    b.cardH === detailedBase.cardH && b.rowH === detailedBase.rowH && b.gridTop === detailedBase.gridTop,
    `高 ${b.cardH}/${detailedBase.cardH} 行高 ${b.rowH}/${detailedBase.rowH} 格上沿 ${b.gridTop}/${detailedBase.gridTop}`)
  // ★这条是这次改动的核心：老版会把价格挤进第三枚读数盒、把到期日藏起来。
  check('详细+备注：在线时长仍在第二行左、价格仍在右（没有重排）',
    /^在线 /.test(b.row2Text ?? '') && /¥12\.50 \/ 月付/.test(b.row2Text ?? '')
      && (b.priceText ?? '').includes('¥12.50') && b.priceRight !== null && Math.abs(b.priceRight - b.row2Right) <= 1,
    `第二行「${b.row2Text}」/ 末枚 span「${b.priceText}」右 ${b.priceRight} vs 行右 ${b.row2Right}`)
  check('详细+备注：第三枚读数盒下面**仍是到期日**（不再是价格）',
    Array.isArray(b.box3) && b.box3[0] === '剩余 95 天' && b.box3[1] === '2027-01-01',
    (b.box3 ?? []).join(' | '))
  check('详细+备注：三枚读数盒与三网延迟照旧', b.boxes === 3 && dom.polylines === 3 * dom.cards,
    `盒 ${b.boxes} / polyline ${dom.polylines}`)
  check('详细+备注：正文里没有把三枚标签糊成一串（逗号不再进正文）',
    !b.text.includes('测试测试,222,333'), b.text)
}
{
  // 单枚：一枚就是一枚。
  const { dom } = await render({ cardStyle: 'detailed', serverNotes: '节点一=东京 · 三网优化' }, 'detailed-notes-one')
  const b = JSON.parse(await evalJS(TITLE_PROBE))
  check('详细+备注：单枚备注就一枚胶囊（不因为改功能多出来）',
    b.badges.length === 1 && b.badges[0].text === '东京 · 三网优化', b.badges.map((x) => x.text).join('/'))
  check('详细+备注：单枚时卡片高度也不变', b.cardH === detailedBase.cardH, `${b.cardH}/${detailedBase.cardH}`)
  check('详细+备注：单枚时三网延迟与请求数照旧', dom.polylines === 3 * dom.cards, `polyline ${dom.polylines}`)
}
{
  // 超长清单（六枚）：标题行是**不能换行**的，所以标签区要能被限宽/截断，
  // 判据是「行高不变 + 不横向溢出 + 名字还在」——不能靠把标签压扁或把卡片撑宽来过关。
  const notes = `节点一=${Array.from({ length: 6 }, (_, i) => `标签${i + 1}号`).join(',')}`
  await render({ cardStyle: 'detailed', serverNotes: notes }, 'detailed-notes-many')
  const b = JSON.parse(await evalJS(TITLE_PROBE))
  check('详细+备注（六枚）：标题行不换行、卡片高度与标题行高都不变',
    b.rowH === detailedBase.rowH && b.cardH === detailedBase.cardH,
    `行高 ${b.rowH}/${detailedBase.rowH} 卡片 ${b.cardH}/${detailedBase.cardH}`)
  check('详细+备注（六枚）：没有横向溢出、标签没越出卡片右沿',
    b.overflowX === false && b.badges?.length > 0 && b.badges.every((x) => x.r <= b.cardRight + 1), `溢出 ${b.overflowX} / 枚 ${b.badges?.length}`)
  check('详细+备注（六枚）：名字仍在（没被标签挤没）',
    (b.nameBox?.w ?? 0) > 0 && (b.badges?.length ?? 0) > 0 && b.badges[0].x >= b.nameBox.r,
    `名字宽 ${b.nameBox?.w} / 首枚左 ${b.badges?.[0]?.x}`)
}
{
  // 手机窄屏：同样要有、同样不许溢出。
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1200, deviceScaleFactor: 1, mobile: true })
  await render({ cardStyle: 'detailed', serverNotes: '节点一=测试测试,222' }, 'detailed-notes-mobile')
  const b = JSON.parse(await evalJS(TITLE_PROBE))
  check('详细+备注（手机 390）：标签在标题行右端、两枚都在',
    b.badges.length === 2 && b.badges.map((x) => x.text).join('|') === '测试测试|222', b.badges.map((x) => x.text).join('|'))
  check('详细+备注（手机 390）：无横向溢出、卡片不高、名字仍在',
    b.overflowX === false && b.rowH === 24 && b.nameBox !== null && b.nameBox.w > 0,
    `溢出 ${b.overflowX} / 行高 ${b.rowH} / 名字宽 ${b.nameBox?.w}`)
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false })
}
{
  // ★手机窄屏 + **长名字**：这条是现站真机验收抓出来的（本文件的桩原先只有短名字，手机那条用例恒过）。
  // 判据不是「名字不许截断」（长名字本来就可能截断），而是**开备注不许让名字变短**：
  // 名字占的宽度与截断状态，开备注 / 不开备注必须完全一样。
  // 名字临时改长（英文长名与现站那几台同量级），不改桩数据——桩里多添一台会把别的「3 台」断言一起带红。
  const LONG_NAME = 'Node Alpha Long Name'
  const rename = () => evalJS(`(() => {
    const c = [...document.querySelectorAll('[role=button]')].find((el) => /CPU/.test(el.innerText))
    const h = c && c.querySelector('h3')
    if (!h) return false
    h.textContent = ${JSON.stringify(LONG_NAME)}
    return true
  })()`)
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1400, deviceScaleFactor: 1, mobile: true })
  await render({ cardStyle: 'detailed' }, 'detailed-longname-base')
  await rename(); await sleep(150)
  const base = JSON.parse(await evalJS(TITLE_PROBE))
  await render({ cardStyle: 'detailed', serverNotes: '节点一=三网优化,备用,流媒体解锁' }, 'detailed-longname-notes')
  await rename(); await sleep(150)
  const on = JSON.parse(await evalJS(TITLE_PROBE))
  check('手机 390（长名字）：三枚标签都挂上了', on.badges?.length === 3, `${on.badges?.length ?? 0} 枚`)
  // 宽度给 1px 容差：标签那格的上限是百分比（40% of 311px），字宽会有亚像素取整；
  // 真正的判据是**截断状态一致**（名字没被挤断），以及差值不超过这 1px 的取整噪声。
  check('手机 390（长名字）：开备注后名字没被挤短（宽度差 ≤1px 且截断状态相同）',
    (base.nameBox?.w ?? 0) > 0 && Math.abs(base.nameBox.w - on.nameBox.w) <= 1 && base.nameClipped === on.nameClipped,
    `关 ${base.nameBox?.w}px/截${base.nameClipped} vs 开 ${on.nameBox?.w}px/截${on.nameClipped}`)
  check('手机 390（长名字）：卡片不高、标题行不换行、无横向溢出',
    on.rowH === 24 && on.cardH === base.cardH && on.overflowX === false,
    `行高 ${on.rowH} 卡片 ${on.cardH}/${base.cardH} 溢出 ${on.overflowX}`)
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false })
}
{
  // 备注只影响「详细」档：经典/简约两档不冒出标签；「延迟」档的标签只在浮层里，正文里没有。
  const classic = await render({ cardStyle: 'classic', serverNotes: '节点一=东京 · 三网优化' }, 'classic-notes')
  check('备注不影响经典档（仍是四格、不冒出标签）',
    classic.dom.netGrid === 1 && classic.dom.netRow === 0 && classic.dom.infoBox === 0 && !classic.dom.text.includes('东京 · 三网优化'),
    classic.dom.text)
  const plain = await render({ cardStyle: 'plain', serverNotes: '节点一=东京 · 三网优化' }, 'plain-notes')
  check('备注不影响简约档（仍是那一行两段、不冒出标签）',
    plain.dom.netRow === 1 && plain.dom.polylines === 0 && !plain.dom.text.includes('东京 · 三网优化'), plain.dom.text)
  await render({ cardStyle: 'latency', serverNotes: '节点一=东京 · 三网优化' }, 'latency-notes-body')
  const lat = JSON.parse(await evalJS(TITLE_PROBE))
  check('「延迟」档的备注不进正文（只在右上角浮层里，标题行不挂胶囊）',
    lat.badges.length === 0 && !lat.text.includes('东京 · 三网优化'), lat.badges.map((x) => x.text).join('/'))
}

/* 4) 旧值 detail 必须迁到延迟，不能掉回经典 */
{
  const { dom, ping } = await render({ cardStyle: 'detail' }, 'detail-old')
  check('旧值 detail → 延迟（三网延迟块在）', dom.polylines === 3 * dom.cards, `polyline ${dom.polylines} / 卡 ${dom.cards}`)
  check('旧值 detail → 延迟（不是经典：底部那行照样在、下面还挂着三网延迟）',
    dom.netRow === 1 && dom.polylines > 0, `网络行 ${dom.netRow} / polyline ${dom.polylines}`)
  check('旧值 detail → 延迟（不发多次请求）', ping === 2, `实测 ${ping} 次`)
  check('旧值 detail → 延迟（不显示详细档的状态点与读数盒）', dom.dots === 0 && dom.infoBox === 0, `点 ${dom.dots} / 盒 ${dom.infoBox}`)
}

/* 5) 完全没有配置 / 非法值 → 回落经典 */
for (const [cfg, tag] of [[{}, 'empty'], [{ cardStyle: 'bogus' }, 'bogus']]) {
  const { dom, ping } = await render(cfg, tag)
  check(`非法值 ${tag} → 回落「简约」这一档（含不发延迟请求）`,
    dom.netRow === 1 && dom.netGrid === 0 && dom.polylines === 0 && dom.infoBox === 0 && ping === 0,
    `网络行 ${dom.netRow} / 四格 ${dom.netGrid} / polyline ${dom.polylines} / 盒 ${dom.infoBox} / 请求 ${ping}`)
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

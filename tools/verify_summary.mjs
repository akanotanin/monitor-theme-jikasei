// 验「概览卡片行」的两副面孔、合计口径与开关。
//
// 用法：node tools/verify_summary.mjs [port]
//
// 为什么要它：这一行有六处只能靠实测确认——
//   ① 开关关着时**整个不挂载**（不是 display:none 藏起来），首屏与没有这个功能时一致；
//   ② 原版四张卡片各一块读数，数字口径（总数/在线、最忙按 CPU 选、今日与累计、速率只算在线且有指标的）
//      都在 summarize 里，改一处很容易让另一处跟着变；
//   ③ 预算版（1.10.0）把前两张各排两块读数：第一张「月度预算 + 剩余价值」、第二张「节点 + 最忙节点」，
//      且照参考图节点在左、最忙节点在右，两块分居卡片两端、下沿对齐——这是纯几何，只能量；
//   ④ 金额口径（各币种按固定汇率折成人民币、一次性买断/没填价格/没有到期日的不计入）与降级
//      （一个可计的都没有时写「—」而不是 ¥0.00）；
//   ⑤ 走势线要等采样攒到两个点才画，冷启动那儿是空的——这条得等出来，不能看着空就当坏了；
//   ⑥ 全站掉线时的降级（「—」「无在线节点」而不是 0%）。
//
// 判据全部走 DOM 文本、子元素计数与矩形，不靠看图。
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = Number(process.argv[2] || 5321)
const CDP_PORT = PORT + 4000

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
}

/* ------------------------------------------------------------------ 桩数据 */

const KB = 1024
const MB = 1024 ** 2
const GB = 1024 ** 3
const TB = 1024 ** 4

const metrics = (over) => ({
  uptime: 400000, cpu: 5, load: [0.1, 0.2, 0.3], mem_total: 2 * GB, mem_used: 1 * GB,
  swap_total: 0, swap_used: 0, disk_total: 40 * GB, disk_used: 10 * GB,
  net_rx: 0, net_tx: 0, total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0,
  tcp: 10, udp: 2, procs: 100, ...over,
})

const base = (id, name, over) => ({
  id, name, sort: id, public: true, online: false, country: 'JP', group: '',
  last_seen: Math.floor(Date.now() / 1000) - 5, metrics: null,
  os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'Xeon',
  cpu_cores: 2, mem_total: 2 * GB, swap_total: 0, disk_total: 40 * GB,
  agent_version: '1.4.0', price: 0, currency: 'USD', billing_cycle: '', expires_at: null,
  expires_in: null, traffic_limit: 0, traffic_mode: 'sum', traffic_reset_day: 1,
  total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0, month_start: '', day_rx: 0, day_tx: 0,
  ...over,
})

// 四台，两两覆盖：
//   ① 在线带指标（最慢的 CPU、速率小头、今日/累计的大头）+ 月付 $12
//   ② 在线带指标（CPU 最高 → 最忙节点；速率大头）+ 年付 $120（＝每月 $10）
//   ③ 在线但还没上报指标（不计入速率，也不参与选最忙）+ 季付 €300（＝每月 €100）
//   ④ 掉线（有累计流量、不贡献速率）→「1 台离线」+ 月付 ¥30，**没有到期日**（也没分组，供分组标签行用）
//
// 预算两块的期望值（照 FX_CNY：USD 6.7179、EUR 7.6172；手工可复算）：
//   月度预算 = 12×6.7179 + 120×6.7179÷12 + 300×7.6172÷3 + 30
//            = 80.6148 + 67.179 + 761.72 + 30 = 939.5138 → ≈¥939.51（4 台计费）
//   剩余价值 = 12×6.7179×15÷30 + 120×6.7179×73÷365 + 300×7.6172×30÷90
//            = 40.3074 + 161.2296 + 761.72 = 963.257 → ≈¥963.26（3 台未到期：掉线那台没到期日）
const MIXED = {
  nodes: [
    base(1, 'Node A', {
      online: true, group: '美国', day_rx: 1 * GB, day_tx: 0.5 * GB,
      total_rx: 2 * TB, total_tx: 1 * TB,
      price: 12, currency: 'USD', billing_cycle: 'monthly', expires_in: 15,
      metrics: metrics({ cpu: 12.5, net_rx: 512 * KB, net_tx: 128 * KB }),
    }),
    base(2, 'Node B', {
      online: true, group: '欧洲', day_rx: 0.25 * GB, day_tx: 0.25 * GB,
      total_rx: 0.5 * TB, total_tx: 0.25 * TB,
      price: 120, currency: 'USD', billing_cycle: 'yearly', expires_in: 73,
      metrics: metrics({ cpu: 51.04, net_rx: 20 * MB, net_tx: 40 * MB }),
    }),
    base(3, 'Node C', {
      online: true, group: '欧洲',
      price: 300, currency: 'EUR', billing_cycle: 'quarterly', expires_in: 30,
    }),
    base(4, 'Node D', {
      online: false, total_rx: 1 * TB, total_tx: 1 * TB, day_rx: 0, day_tx: 0,
      price: 30, currency: 'CNY', billing_cycle: 'monthly', expires_in: null,
    }),
  ],
}

// 全掉线：最忙节点与速率都无从谈起。
const ALL_DOWN = { nodes: MIXED.nodes.map((n) => ({ ...n, online: false, metrics: null })) }

/** 「最忙」并列：两台同为 30%，应该留列表里先出现的那台。 */
const TIED = {
  nodes: [
    base(1, '先出现的', { online: true, metrics: metrics({ cpu: 30, net_rx: MB, net_tx: MB }) }),
    base(2, '后出现的', { online: true, metrics: metrics({ cpu: 30, net_rx: MB, net_tx: MB }) }),
  ],
}

/** 没填价格：两个数都该是「—」，而不是 ¥0.00。 */
const NO_PRICE = { nodes: MIXED.nodes.map((n) => ({ ...n, price: 0 })) }

/** 汇率表里没有的币种：那台不计入，提示里点名，页面照常。 */
const EXOTIC = {
  nodes: [
    base(1, 'X 币机', { online: true, price: 10, currency: 'XYZ', billing_cycle: 'monthly', expires_in: 10 }),
    base(2, '人民币机', { online: true, price: 20, currency: 'CNY', billing_cycle: 'monthly', expires_in: 10 }),
  ],
}

/** 一次性买断：两块都不计入（那是「买断」，没有每月、也没有剩余天数）。 */
const ONCE_ONLY = {
  nodes: [base(1, '买断机', { online: true, price: 300, currency: 'CNY', billing_cycle: 'once', expires_in: 200 })],
}

const VARIANTS = { mixed: MIXED, down: ALL_DOWN, tied: TIED, free: NO_PRICE, exotic: EXOTIC, once: ONCE_ONLY }

let config = {}
let variant = 'mixed'

/* ------------------------------------------------------------------ 伺服 */

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  const json = (body) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  if (path === '/__variant') {
    variant = url.searchParams.get('name') || 'mixed'
    return json({ variant })
  }
  if (path.startsWith('/api/')) {
    if (path === '/api/me') return json({ authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '概览校验' })
    if (path === '/api/nodes') return json(VARIANTS[variant])
    if (path.endsWith('/config')) return json(config)
    if (path === '/api/version') return json({ version: '1.4.0' })
    // 延迟请求（详细 / 延迟形态才会发）：空数据，主题那边整块不渲染。
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
  `--user-data-dir=${process.env.LOCALAPPDATA || '/tmp'}/Temp/summary${CDP_PORT}`,
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
const WIDE = { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false }
await send('Emulation.setDeviceMetricsOverride', WIDE)
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })

/* ------------------------------------------------------------------ 探测 */

const PROBE = `JSON.stringify((() => {
  const TITLES = ["月度预算", "剩余价值", "节点", "最忙节点", "今日流量", "实时网速"]
  const first = (el) => (el.innerText.split('\\n')[0] || '').trim()
  // 卡片里那几块读数就是卡片的直接子元素（Tile 一块 / Pair 两块）——按结构取，不认类名。
  const card = (c) => {
    const r = c.getBoundingClientRect()
    const blocks = [...c.children].map((b) => {
      const br = b.getBoundingClientRect()
      const num = b.children[1] || null
      const foot = b.children[2] || null
      const fr = foot ? foot.getBoundingClientRect() : null
      // 单块读数的卡片（今日流量 / 实时网速）里，第二行是一张两列的小栅格：取它第二列的
      // 起点，用来断「预算版那两张卡的右列与它们同一节奏」（都是 50/50 + 同一个 gap）。
      const inner = num && num.children.length === 2 ? num.children[1] : null
      return {
        title: first(b),
        text: b.innerText.replace(/\\n/g, ' | '),
        x: Math.round(br.left), right: Math.round(br.right), w: Math.round(br.width),
        hint: b.getAttribute('title') || '',
        innerCol: inner ? Math.round(inner.getBoundingClientRect().left) : null,
        // 主数字那个盒子带 truncate：真装不下时 scrollWidth 会大于 clientWidth。
        clip: num ? num.scrollWidth - num.clientWidth : 0,
        // 主数字那行是两列小栅格时，两个格子里各自的截断量——栅格自己不溢出，格子里的
        // truncate 会静默把「40.1 MB/s」变省略号，只看上面那个 clip 是看不见的。
        cellClip: num && num.children.length === 2
          ? [...num.children].map((v) => { const t = v.querySelector('.truncate') || v; return t.scrollWidth - t.clientWidth })
          : null,
        // 一块读数由几段组成：参考站那种「小标签 / 大数 / 一行小字」= 3 段。
        parts: b.children.length,
        foot: fr ? Math.round(fr.bottom) : null,
      }
    })
    return {
      titles: blocks.map((b) => b.title),
      text: c.innerText.replace(/\\n/g, ' | '),
      x: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top),
      h: Math.round(r.height), blocks,
      polylines: c.querySelectorAll('svg polyline').length,
    }
  }
  const cards = [...document.querySelectorAll('[data-slot=card]')]
  const nodes = cards.filter((c) => c.getAttribute('role') === 'button')
  const tiles = cards.filter((c) => TITLES.includes(first(c)))
  return {
    cards: cards.length,
    nodeCards: nodes.length,
    tiles: tiles.map(card),
    polylines: tiles.reduce((n, c) => n + c.querySelectorAll('svg polyline').length, 0),
    tileHeights: [...new Set(tiles.map((c) => Math.round(c.getBoundingClientRect().height)))],
    above: tiles.length && nodes.length ? tiles[0].getBoundingClientRect().top < nodes[0].getBoundingClientRect().top : null,
    scroll: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
    body: document.body.innerText.replace(/\\n/g, ' | '),
  }
})())`

async function render(cfg, tag = '', v = 'mixed') {
  config = cfg
  await fetch(`http://127.0.0.1:${PORT}/__variant?name=${v}`)
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?m=${encodeURIComponent(tag)}` })
  let dom = null
  for (let i = 0; i < 60; i++) {
    await sleep(300)
    const raw = await evalJS(PROBE)
    if (!raw) continue
    dom = JSON.parse(raw)
    // 「页面起来了」认节点卡片，不认概览卡片——开关关着那一行本来就没有（踩过这个坑：
    // 拿概览当加载条件会把「开关生效」误判成「页面没渲染」）。
    if (dom.nodeCards > 0) break
    dom = null
  }
  if (!dom || dom.nodeCards === 0) throw new Error(`【${tag}】页面没渲染出节点卡片`)
  return dom
}

/** 等到走势线画出来（桩没有 WebSocket，靠 5 秒一次的兜底轮询攒采样）。 */
async function waitForSparkline(timeoutMs = 26000) {
  const started = Date.now()
  for (;;) {
    const dom = JSON.parse(await evalJS(PROBE))
    if (dom.polylines >= 2) return { dom, waited: Date.now() - started }
    if (Date.now() - started > timeoutMs) return { dom, waited: Date.now() - started }
    await sleep(1000)
  }
}

const results = []
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }
// 找不到那张卡片 / 那块读数时返回一个空壳而不是 undefined：断言要报出一行 FAIL，
// 而不是在第 12 条上抛 TypeError 把后面几十条一起带走（反向自测时尤其明显——
// 旧构建上「月度预算」根本不存在，护栏得把所有该报的都报出来）。
const MISSING = {
  titles: [], text: '(页面上没有这张卡片)', x: 0, right: 0, top: 0, h: 0, polylines: 0,
  blocks: [
    { title: '(没有)', text: '(页面上没有这张卡片)', x: 0, right: 0, w: 0, hint: '', clip: 0, foot: null },
    { title: '(没有)', text: '(页面上没有这张卡片)', x: 0, right: 0, w: 0, hint: '', clip: 0, foot: null },
  ],
}
const multi = (dom) => dom.tiles.filter((t) => t.titles.length > 1)
const tile = (dom, title) => dom.tiles.find((t) => t.titles.includes(title)) ?? MISSING
/** 一块读数自己的文本（卡片里有两块时不能拿整张卡片的文本去比）。 */
const block = (dom, title) => tile(dom, title).blocks.find((b) => b.title === title) ?? MISSING.blocks[0]

/** 一张卡里两块读数：左块贴左、右块贴右、两块不重叠、下沿对齐、数字没被截断。 */
function checkPair(where, t, cardPad = 16) {
  const [a, b] = t.blocks
  check(`${where}：两块读数在同一张卡片里`, t.titles.length > 0 && t.blocks.length === 2, JSON.stringify(t.titles))
  check(`${where}：左边那块贴卡片左沿、右边那块贴卡片右沿`,
    Math.abs(a.x - t.x - cardPad) <= 2 && Math.abs(t.right - b.right - cardPad) <= 2,
    `左 ${a.x - t.x}px / 右 ${t.right - b.right}px（卡片内边距应为 ${cardPad}px）`)
  check(`${where}：右边那块落在卡片右半边（两块不在同一半）`,
    b.x - t.x >= (t.right - t.x) / 2 - 2 && b.x >= a.right,
    `右块起点 ${Math.round(b.x - t.x)}px / 卡片半宽 ${Math.round((t.right - t.x) / 2)}px（左块宽 ${a.w} / 右块宽 ${b.w}）`)
  check(`${where}：两块的下沿对齐（同一条基线）`, a.foot === b.foot && a.foot !== null, `左 ${a.foot} / 右 ${b.foot}`)
  check(`${where}：两块里的数字都没被截断`, a.clip <= 0 && b.clip <= 0, `裁掉 ${a.clip}/${b.clip}px`)
}

/**
 * 两张卡片里的「第二块读数」必须落在同一条竖线上——它们看起来是同一列。
 * 只断「各自落在右半边」是不够的：块宽按内容走时，剩余价值（≈¥191.94）比最忙节点（51.0%）
 * 宽，两块起点会差十几像素，红框标注出来就是「这一列没对齐」。
 */
function checkColumn(where, cards) {
  const rel = cards.map((t) => Math.round(t.blocks[1].x - t.x))
  const spread = Math.max(...rel) - Math.min(...rel)
  check(`${where}：两张卡的第二块读数起于同一条竖线（同一列）`, spread <= 1,
    `距各自卡片左沿 ${rel.join(' / ')}px（相差 ${spread}px）`)
}

/**
 * 「和谐的节奏」：预算版那两张卡的右列，与「今日流量」「实时网速」两张卡里那张两列小栅格的
 * 第二列，落点应当相同（都是 50/50 拆分 + 同一个 gap-x-3）。差几像素说明前两张卡自成一个
 * 节奏，整行读起来就不是一个栅格（站长要的就是这个）。
 */
function checkRhythm(where, dom) {
  const pair = tile(dom, '月度预算').blocks[1].x - tile(dom, '月度预算').x
  const day = tile(dom, '今日流量').blocks[0].innerCol
  const net = tile(dom, '实时网速').blocks[0].innerCol
  const ok = day !== null && net !== null && Math.abs(pair - (day - tile(dom, '今日流量').x)) <= 1 &&
    Math.abs(pair - (net - tile(dom, '实时网速').x)) <= 1
  check(`${where}：预算版右列与今日流量 / 实时网速的第二列同一落点（整行一个栅格）`, ok,
    `右列 ${pair}px ／ 今日流量第二列 ${day === null ? '—' : day - tile(dom, '今日流量').x}px ／ 实时网速第二列 ${net === null ? '—' : net - tile(dom, '实时网速').x}px`)
}

/* 1) 默认（后台没存过：GET config 回 {}）→ 概览行整个不挂载 */
{
  const dom = await render({}, 'default')
  const ALL = ['月度预算', '剩余价值', '节点', '最忙节点', '今日流量', '实时网速']
  check('默认关：一张概览卡片都没有', dom.tiles.length === 0 && dom.polylines === 0, `概览 ${dom.tiles.length} 张 / polyline ${dom.polylines}`)
  check('默认关：六个标题一个都不在页面上', ALL.every((t) => !dom.body.includes(t)),
    ALL.filter((t) => dom.body.includes(t)).join('、') || '（都不在）')
  check('默认关：节点卡片照常四张', dom.nodeCards === 4, `节点卡片 ${dom.nodeCards} 张`)
}

/* 2) 原版（summary）：四张卡片各一块读数 + 逐个数字 */
let classicDay = null
let classicNet = null
{
  const dom = await render({ listTop: 'summary' }, 'classic')
  const titles = dom.tiles.map((t) => t.titles.join('+'))
  check('原版：四张概览卡片，各一块读数', dom.tiles.length === 4 && dom.tiles.every((t) => t.blocks.length === 1), titles.join(' / '))
  check('原版：顺序仍是 节点 / 最忙节点 / 今日流量 / 实时网速',
    titles.join(',') === '节点,最忙节点,今日流量,实时网速', titles.join(','))
  check('原版：概览行排在节点卡片之前', dom.above === true, String(dom.above))
  check('原版：节点卡「在线 / 总数 + 离线台数」', tile(dom, '节点').text === '节点 | 3 / 4 | 1 台离线', tile(dom, '节点').text)
  check('原版：最忙节点卡 = CPU 最高的那台（51.0% / Node B）',
    tile(dom, '最忙节点').text === '最忙节点 | 51.0% | Node B', tile(dom, '最忙节点').text)
  check('原版：今日流量卡：今日 1.25 GB ↓ / 768 MB ↑，总流量 3.50 TB ↓ / 2.25 TB ↑',
    tile(dom, '今日流量').text === '今日流量 | 1.25 GB | 768 MB | 总流量 | 3.50 TB | 2.25 TB', tile(dom, '今日流量').text)
  check('原版：实时网速卡 = 在线且有指标的节点之和（20.5 MB/s ↓ / 40.1 MB/s ↑）',
    tile(dom, '实时网速').text === '实时网速 | 20.5 MB/s | 40.1 MB/s', tile(dom, '实时网速').text)
  // ── 与参考站对齐的三条：每块读数都是「小标签 / 大数 / 一行小字」三段、四张卡等高、
  //    24px 的主数字在两列栅格里不被截断（栅格自己不溢出，格子里的 truncate 是静默的）。
  check('原版：每块读数都是三段（小标签 / 大数 / 一行小字，照参考站）',
    dom.tiles.every((t) => t.blocks.every((b) => b.parts === 3)),
    JSON.stringify(dom.tiles.map((t) => t.blocks.map((b) => b.parts))))
  check('原版：四张卡片等高（同一行里没有谁比谁高）',
    dom.tileHeights.length === 1, `高度 ${JSON.stringify(dom.tileHeights)}`)
  check('原版：今日流量 / 实时网速两格里的大数没被截断（24px 数字放得下）',
    ['今日流量', '实时网速'].every((n) =>
      (tile(dom, n).blocks[0].cellClip ?? []).every((c) => c <= 0) && tile(dom, n).blocks[0].clip <= 0),
    ['今日流量', '实时网速'].map((n) => `${n} 格子截断 ${JSON.stringify(tile(dom, n).blocks[0].cellClip)}`).join('；'))
  check('原版：页面上没有月度预算 / 剩余价值（新功能没被顺手带出来）',
    !dom.body.includes('月度预算') && !dom.body.includes('剩余价值'))
  classicDay = tile(dom, '今日流量').text
  classicNet = tile(dom, '实时网速').text
}

/* 3) 预算版（budget）：前两张各两块读数 + 金额 */
{
  const dom = await render({ listTop: 'budget' }, 'budget')
  const titles = dom.tiles.map((t) => t.titles.join('+'))
  check('预算版：还是四张概览卡片', dom.tiles.length === 4, titles.join(' / '))
  check('预算版：顺序是 月度预算+剩余价值 / 节点+最忙节点 / 今日流量 / 实时网速',
    titles.join(',') === '月度预算+剩余价值,节点+最忙节点,今日流量,实时网速', titles.join(','))
  check('预算版：节点与最忙节点在同一张卡片里', (tile(dom, '节点')?.titles ?? []).includes('最忙节点'),
    JSON.stringify(tile(dom, '节点')?.titles ?? []))
  check('预算版：月度预算与剩余价值在同一张卡片里', (tile(dom, '月度预算')?.titles ?? []).includes('剩余价值'),
    JSON.stringify(tile(dom, '月度预算')?.titles ?? []))
  check('预算版：月度预算 ≈¥939.51（年付摊到月、季付摊到月、掉线那台也算）+ 4 台计费',
    block(dom, '月度预算').text === '月度预算 | ≈¥939.51 | 4 台计费', block(dom, '月度预算').text)
  check('预算版：剩余价值 ≈¥963.26（按剩余天数折）+ 3 台未到期（没有到期日的那台不计）',
    block(dom, '剩余价值').text === '剩余价值 | ≈¥963.26 | 3 台未到期', block(dom, '剩余价值').text)
  check('预算版：节点与最忙节点两块与原版逐字一致',
    tile(dom, '节点').blocks.map((b) => b.text).join(' | ') === '节点 | 3 / 4 | 1 台离线 | 最忙节点 | 51.0% | Node B',
    tile(dom, '节点').blocks.map((b) => b.text).join(' | '))
  check('预算版：今日流量 / 实时网速两张与原版逐字一致（没被误伤）',
    tile(dom, '今日流量').text === classicDay && tile(dom, '实时网速').text === classicNet,
    `${tile(dom, '今日流量').text} ／ ${tile(dom, '实时网速').text}`)
  check('预算版：概览行排在节点卡片之前', dom.above === true, String(dom.above))
  check('预算版：四张卡片等高（下沿对齐）', dom.tileHeights.length === 1, `高度 ${JSON.stringify(dom.tileHeights)}`)

  // 几何：两张卡片里各两块读数，一左一右；两张卡的第二块还要在同一条竖线上（同一列），
  // 且与「今日流量 / 实时网速」那两张卡的第二列同一落点（整行一个栅格）。
  checkPair('预算版·第一张卡', tile(dom, '月度预算'))
  checkPair('预算版·第二张卡', tile(dom, '节点'))
  checkColumn('预算版', [tile(dom, '月度预算'), tile(dom, '节点')])
  checkRhythm('预算版', dom)

  // 悬停提示：口径与汇率都得写清（面板上看不出「≈」是怎么来的）
  const budgetHint = tile(dom, '月度预算').blocks[0].hint
  const valueHint = tile(dom, '剩余价值').blocks[1].hint
  check('预算版：月度预算的提示写明口径（计费周期 / 一次性买断不计入）与实际用到的汇率',
    budgetHint.includes('计费周期') && budgetHint.includes('一次性买断') &&
    budgetHint.includes('1 EUR = ¥7.6172') && budgetHint.includes('1 USD = ¥6.7179') &&
    !budgetHint.includes('1 CNY'),
    budgetHint)
  check('预算版：剩余价值的提示写明口径（价格 × 剩余天数 ÷ 周期天数）',
    valueHint.includes('剩余天数') && valueHint.includes('无到期日') && valueHint.includes('折算'), valueHint)
  check('预算版：折算日期与来源写在提示里', budgetHint.includes('2026-09-30') && budgetHint.includes('open.er-api.com'), budgetHint)
}

/* 4) 一块都没有 / 一次性买断 / 没有汇率的降级 */
{
  const free = await render({ listTop: 'budget' }, 'free', 'free')
  check('没填价格：月度预算写「— / 未记录价格」，不是 ¥0.00',
    block(free, '月度预算').text === '月度预算 | — | 未记录价格', block(free, '月度预算').text)
  check('没填价格：剩余价值写「— / 无预付到期」',
    block(free, '剩余价值').text === '剩余价值 | — | 无预付到期', block(free, '剩余价值').text)
  check('没填价格：提示里只写「按固定汇率折算成人民币」（没有汇率可列）',
    block(free, '月度预算').hint === '各节点的价格按计费周期摊到每个月后相加；一次性买断与没填价格的不计入。按固定汇率折算成人民币',
    block(free, '月度预算').hint)

  const once = await render({ listTop: 'budget' }, 'once', 'once')
  check('一次性买断：两块都不计入（没有「每月」也没有「剩余天数」）',
    block(once, '月度预算').text === '月度预算 | — | 未记录价格' && block(once, '剩余价值').text === '剩余价值 | — | 无预付到期',
    `${block(once, '月度预算').text} ／ ${block(once, '剩余价值').text}`)

  const exotic = await render({ listTop: 'budget' }, 'exotic', 'exotic')
  check('没有汇率的币种：只算人民币那台（月 ≈¥20.00 / 剩 ≈¥6.67）',
    block(exotic, '月度预算').text === '月度预算 | ≈¥20.00 | 1 台计费' && block(exotic, '剩余价值').text === '剩余价值 | ≈¥6.67 | 1 台未到期',
    `${block(exotic, '月度预算').text} ／ ${block(exotic, '剩余价值').text}`)
  check('没有汇率的币种：提示里点名（XYZ 没有汇率，未计入）',
    block(exotic, '月度预算').hint.includes('XYZ 没有汇率，未计入'), block(exotic, '月度预算').hint)
}

/* 5) 全掉线：最忙节点与网速的降级（两副面孔都要） */
{
  const down = await render({ listTop: 'summary' }, 'down-classic', 'down')
  check('全掉线·原版：0 / 4 + 4 台离线', tile(down, '节点').text === '节点 | 0 / 4 | 4 台离线', tile(down, '节点').text)
  check('全掉线·原版：最忙节点显示「— / 无在线节点」，不是 0%',
    tile(down, '最忙节点').text === '最忙节点 | — | 无在线节点', tile(down, '最忙节点').text)
  check('全掉线·原版：网速是 0 B/s（不是 NaN/undefined）',
    tile(down, '实时网速').text === '实时网速 | 0 B/s | 0 B/s', tile(down, '实时网速').text)

  const downB = await render({ listTop: 'budget' }, 'down-budget', 'down')
  check('全掉线·预算版：节点与最忙节点两块照旧降级',
    tile(downB, '节点').blocks[0].text === '节点 | 0 / 4 | 4 台离线' &&
    tile(downB, '节点').blocks[1].text === '最忙节点 | — | 无在线节点',
    tile(downB, '节点').blocks.map((b) => b.text).join(' | '))
  check('全掉线·预算版：月度预算照样算得出来（掉线的机器也在付钱）',
    block(downB, '月度预算').text === '月度预算 | ≈¥939.51 | 4 台计费', block(downB, '月度预算').text)

  const tied = await render({ listTop: 'summary' }, 'tied', 'tied')
  check('最忙并列：留列表里先出现的那台', tile(tied, '最忙节点').text === '最忙节点 | 30.0% | 先出现的', tile(tied, '最忙节点').text)
}

/* 6) 走势线：冷启动没有（一个采样画不出走势），攒到两个点才画；卡片高度不因此变 */
{
  const first = await render({ listTop: 'budget' }, 'sparkline')
  check('走势线：刚打开时不画（采样不足两个点）', first.polylines === 0, `polyline ${first.polylines}`)
  const { dom, waited } = await waitForSparkline()
  check('走势线：采样攒够后画两条（下行 + 上行）', dom.polylines === 2, `polyline ${dom.polylines}，等待 ${(waited / 1000).toFixed(1)}s`)
  check('走势线：画出来前后卡片高度不变（位置是预留的，不是撑开的）',
    dom.tileHeights[0] === first.tileHeights[0], `${first.tileHeights[0]}px → ${dom.tileHeights[0]}px`)
}

/* 7) 与分组标签行共存：两种概览各自的「两个都显示」 */
{
  const coexist = await render({ listTop: 'both', cardStyle: 'latency', pingLines: '北京电信' }, 'coexist-classic')
  check('原版 + 分组标签行：该在的都在',
    coexist.tiles.length === 4 && coexist.body.includes('全部') && coexist.tiles.every((t) => t.blocks.length === 1) && coexist.nodeCards === 4,
    `概览 ${coexist.tiles.length} / 卡片 ${coexist.nodeCards} / 分组行 ${coexist.body.includes('全部')}`)

  const coexistB = await render({ listTop: 'bothBudget', cardStyle: 'latency', pingLines: '北京电信' }, 'coexist-budget')
  check('预算版 + 分组标签行：该在的都在（前两张各两块读数）',
    coexistB.tiles.length === 4 && coexistB.body.includes('全部') && multi(coexistB).length === 2 && coexistB.nodeCards === 4,
    `概览 ${coexistB.tiles.length} / 多块卡 ${multi(coexistB).length} / 分组行 ${coexistB.body.includes('全部')}`)
  check('预算版 + 分组标签行：金额与单独显示时一致',
    block(coexistB, '月度预算').text === '月度预算 | ≈¥939.51 | 4 台计费', block(coexistB, '月度预算').text)
}

/* 8) 机位：四列（1440）/ 两列（1000）/ 手机（390）——数字不能被截断，页面不能横向滚 */
{
  const wide = await render({ listTop: 'budget' }, 'wide')
  checkPair('预算版 @1440（四列）', tile(wide, '月度预算'))
  checkPair('预算版 @1440（四列，第二张）', tile(wide, '节点'))
  checkColumn('预算版 @1440（四列）', [tile(wide, '月度预算'), tile(wide, '节点')])
  checkRhythm('预算版 @1440（四列）', wide)

  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1000, deviceScaleFactor: 1, mobile: false })
  const mid = await render({ listTop: 'budget' }, 'mid')
  checkPair('预算版 @1000（两列）', tile(mid, '月度预算'))
  check('预算版 @1000：无横向滚动', mid.scroll[0] <= mid.scroll[1], `scrollWidth ${mid.scroll[0]} / clientWidth ${mid.scroll[1]}`)

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  const narrow = await render({ listTop: 'budget' }, 'narrow-budget')
  check('预算版 @390：无横向滚动', narrow.scroll[0] <= narrow.scroll[1], `scrollWidth ${narrow.scroll[0]} / clientWidth ${narrow.scroll[1]}`)
  check('预算版 @390：四张卡片仍都在', narrow.tiles.length === 4, `概览 ${narrow.tiles.length} 张`)
  checkPair('预算版 @390（手机）', tile(narrow, '月度预算'))
  checkColumn('预算版 @390（手机）', [tile(narrow, '月度预算'), tile(narrow, '节点')])
  checkRhythm('预算版 @390（手机）', narrow)

  const narrowClassic = await render({ listTop: 'both', cardStyle: 'detailed' }, 'narrow-classic')
  check('原版 @390（详细形态）：无横向滚动', narrowClassic.scroll[0] <= narrowClassic.scroll[1],
    `scrollWidth ${narrowClassic.scroll[0]} / clientWidth ${narrowClassic.scroll[1]}`)
  check('原版 @390：四张卡片仍都在', narrowClassic.tiles.length === 4, `概览 ${narrowClassic.tiles.length} 张`)
  await send('Emulation.setDeviceMetricsOverride', WIDE)
}

/* 9) 档位本身的读回：六选一每一档都认（认不出就会静默掉回默认「都不显示」） */
{
  for (const [value, want] of [['budget', '预算版'], ['bothBudget', '预算版 + 分组标签']]) {
    const dom = await render({ listTop: value }, `keep-${value}`)
    check(`新档位 ${value} 原样生效（${want}）`,
      dom.tiles.length === 4 && multi(dom).length === 2 && dom.body.includes('月度预算'),
      `概览 ${dom.tiles.length} 张 / 多块卡 ${multi(dom).length}`)
  }
}

/* 10) 旧配置迁移：≤1.4.0 存的是 showSummary / showGroupTabs 两个布尔开关 */
// 这两个键现在读不出来了（列表页顶部合成一个六选一），必须按组合迁过来——
// 不迁的表现不是报错，而是「站长开着的那一行自己关了」。1.10.0 加档位时尤其要保住：
// 老站迁过来必须落到**原版**，不能因为多了新档位就默认变成预算版。
{
  const onlySummary = await render({ showSummary: true }, 'legacy-summary')
  check('旧键迁移：只存 showSummary=true → 概览行在、且是原版（不是预算版）',
    onlySummary.tiles.length === 4 && onlySummary.tiles.every((t) => t.blocks.length === 1) && !onlySummary.body.includes('月度预算'),
    `概览 ${onlySummary.tiles.length} 张 / 多块卡 ${multi(onlySummary).length}`)

  const onlyTabs = await render({ showGroupTabs: true }, 'legacy-tabs')
  check('旧键迁移：只存 showGroupTabs=true → 分组标签行在、概览行不在',
    onlyTabs.tiles.length === 0 && onlyTabs.body.includes('未分组'),
    `概览 ${onlyTabs.tiles.length} 张 / 分组行 ${onlyTabs.body.includes('未分组')}`)

  const both = await render({ showSummary: true, showGroupTabs: true }, 'legacy-both')
  check('旧键迁移：两个旧键都开 → 两个都显示（原版）',
    both.tiles.length === 4 && both.body.includes('未分组') && !both.body.includes('月度预算'),
    `概览 ${both.tiles.length} 张 / 分组行 ${both.body.includes('未分组')}`)

  const none = await render({ showSummary: false, showGroupTabs: false }, 'legacy-none')
  check('旧键迁移：两个旧键都关 → 两个都不显示', none.tiles.length === 0 && !none.body.includes('未分组'),
    `概览 ${none.tiles.length} 张 / 分组行 ${none.body.includes('未分组')}`)
}

ws.close()
chrome.kill()
server.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} PASS / ${failed.length} FAIL`)
process.exit(failed.length ? 1 : 0)

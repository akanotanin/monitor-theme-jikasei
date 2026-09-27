// 验「概览卡片行」（节点 / 最忙节点 / 今日流量 / 实时网速）的渲染、合计口径与开关。
//
// 用法：node tools/verify_summary.mjs [port]
//
// 为什么要它：这一行有四处只能靠实测确认——
//   ① 开关关着时**整个不挂载**（不是 display:none 藏起来），首屏与没有这个功能时一致；
//   ② 四张卡片的数字口径（总数/在线、最忙按 CPU 选、今日与累计、速率只算在线且有指标的节点）
//      都在 summarize 里，改一处很容易让另一处跟着变；
//   ③ 走势线要等采样攒到两个点才画，冷启动那儿是空的——这条得等出来，不能看着空就当坏了；
//   ④ 全站掉线时的降级（「—」「无在线节点」而不是 0%）。
//
// 判据全部走 DOM 文本与元素计数，不靠看图。
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
//   ① 在线带指标（最慢的 CPU、速率小头、今日/累计的大头）
//   ② 在线带指标（CPU 最高 → 最忙节点；速率大头 ≈ 参考图里那几个量级）
//   ③ 在线但还没上报指标（不计入速率，也不参与选最忙）
//   ④ 掉线（有累计流量、不贡献速率）→ 「1 台离线」
const MIXED = {
  nodes: [
    base(1, 'Kirino San Jose', {
      online: true, group: '美国', day_rx: 1 * GB, day_tx: 0.5 * GB,
      total_rx: 2 * TB, total_tx: 1 * TB,
      metrics: metrics({ cpu: 12.5, net_rx: 512 * KB, net_tx: 128 * KB }),
    }),
    base(2, 'Kyubey London', {
      online: true, group: '欧洲', day_rx: 0.25 * GB, day_tx: 0.25 * GB,
      total_rx: 0.5 * TB, total_tx: 0.25 * TB,
      metrics: metrics({ cpu: 51.04, net_rx: 20 * MB, net_tx: 40 * MB }),
    }),
    base(3, 'Kaname Osaka', { online: true, group: '欧洲' }),
    base(4, 'Mami Sakura', { online: false, total_rx: 1 * TB, total_tx: 1 * TB, day_rx: 0, day_tx: 0 }),
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

const VARIANTS = { mixed: MIXED, down: ALL_DOWN, tied: TIED }

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
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false })
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })

/* ------------------------------------------------------------------ 探测 */

const TITLES = ['节点', '最忙节点', '今日流量', '实时网速']

// 「概览卡片」认的是**首行文本恰好是那四个标题**的卡片：节点卡片的首行是旗子 + 机器名，
// 不会撞上；反过来也不靠类名（类名一改断言就假红）。
const PROBE = `JSON.stringify((() => {
  const cards = [...document.querySelectorAll('[data-slot=card]')]
  const head = (c) => (c.innerText.split('\\n')[0] || '').trim()
  const titles = ${JSON.stringify(TITLES)}
  const tiles = cards.filter((c) => titles.includes(head(c)))
  const text = (t) => {
    const el = tiles.find((c) => head(c) === t)
    return el ? el.innerText.replace(/\\n/g, ' | ') : null
  }
  const nodeCards = cards.filter((c) => c.getAttribute('role') === 'button')
  const top = (el) => el ? Math.round(el.getBoundingClientRect().top) : -1
  const order = [...cards].map((c) => titles.includes(head(c)) ? head(c) : 'node')
  return {
    cards: cards.length,
    tiles: tiles.length,
    tileText: Object.fromEntries(titles.map((t) => [t, text(t)])),
    tileHeights: Object.fromEntries(tiles.map((c) => [head(c), Math.round(c.getBoundingClientRect().height)])),
    nodeCards: nodeCards.length,
    summaryPolylines: tiles.reduce((n, c) => n + c.querySelectorAll('svg polyline').length, 0),
    order: order.join(','),
    tilesAboveNodes: tiles.length && nodeCards.length ? top(tiles[0]) < top(nodeCards[0]) : null,
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
  }
  if (!dom || dom.nodeCards === 0) throw new Error(`【${tag}】页面没渲染出节点卡片`)
  return dom
}

/** 等到走势线画出来（桩没有 WebSocket，靠 5 秒一次的兜底轮询攒采样）。 */
async function waitForSparkline(timeoutMs = 26000) {
  const started = Date.now()
  for (;;) {
    const dom = JSON.parse(await evalJS(PROBE))
    if (dom.summaryPolylines >= 2) return { dom, waited: Date.now() - started }
    if (Date.now() - started > timeoutMs) return { dom, waited: Date.now() - started }
    await sleep(1000)
  }
}

const results = []
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }

/* 1) 默认（后台没存过：GET config 回 {}）→ 概览行整个不挂载 */
{
  const dom = await render({}, 'default')
  check('默认关：一张概览卡片都没有', dom.tiles === 0 && dom.summaryPolylines === 0, `概览 ${dom.tiles} 张 / polyline ${dom.summaryPolylines}`)
  check('默认关：四个标题一个都不在页面上', TITLES.every((t) => !dom.body.includes(t)), TITLES.filter((t) => dom.body.includes(t)).join('、') || '（都不在）')
  check('默认关：节点卡片照常四张', dom.nodeCards === 4, `节点卡片 ${dom.nodeCards} 张`)
}

/* 2) 打开 → 四张卡片 + 逐个数字 */
{
  // 1.5.0 起「列表页顶部」是一个四选一下拉（listTop）：summary = 只显示概览卡片。
  const dom = await render({ listTop: 'summary' }, 'on')
  check('打开：四张概览卡片都在', dom.tiles === 4, `概览 ${dom.tiles} 张`)
  check('打开：概览行排在节点卡片之前', dom.tilesAboveNodes === true && dom.order.startsWith('节点,最忙节点,今日流量,实时网速,'), `顺序 ${dom.order.slice(0, 60)}`)
  check('节点卡：在线 / 总数 + 离线台数', dom.tileText['节点'] === '节点 | 3 / 4 | 1 台离线', dom.tileText['节点'])
  check('最忙节点卡：CPU 最高的那台（51.0% / Kyubey London）',
    dom.tileText['最忙节点'] === '最忙节点 | 51.0% | Kyubey London', dom.tileText['最忙节点'])
  check('今日流量卡：今日 1.25 GB ↓ / 768 MB ↑，总流量 3.50 TB ↓ / 2.25 TB ↑',
    dom.tileText['今日流量'] === '今日流量 | 1.25 GB | 768 MB | 总流量 | 3.50 TB | 2.25 TB', dom.tileText['今日流量'])
  check('实时网速卡：在线且有指标的节点之和（20.5 MB/s ↓ / 40.1 MB/s ↑）',
    dom.tileText['实时网速'] === '实时网速 | 20.5 MB/s | 40.1 MB/s', dom.tileText['实时网速'])
}

/* 3) 和别的开关共存：概览 + 分组标签行 + 延迟形态 + 延迟线路 */
{
  const dom = await render({ listTop: 'both', cardStyle: 'latency', pingLines: '北京电信' }, 'coexist')
  check('与分组标签行 / 延迟形态共存：该在的都在',
    dom.tiles === 4 && dom.body.includes('全部') && dom.body.includes('未分组') && dom.nodeCards === 4,
    `概览 ${dom.tiles} / 卡片 ${dom.nodeCards} / 分组行 ${dom.body.includes('全部')}`)
}

/* 4) 走势线：冷启动没有（一个采样画不出走势），攒到两个点才画；卡片高度不因此变 */
{
  const first = await render({ listTop: 'summary' }, 'sparkline')
  check('走势线：刚打开时不画（采样不足两个点）', first.summaryPolylines === 0, `polyline ${first.summaryPolylines}`)
  const { dom, waited } = await waitForSparkline()
  check('走势线：采样攒够后画两条（下行 + 上行）', dom.summaryPolylines === 2, `polyline ${dom.summaryPolylines}，等待 ${(waited / 1000).toFixed(1)}s`)
  check('走势线：画出来前后卡片高度不变（位置是预留的，不是撑开的）',
    dom.tileHeights['实时网速'] === first.tileHeights['实时网速'], `${first.tileHeights['实时网速']}px → ${dom.tileHeights['实时网速']}px`)
  check('四张卡片等高（底部那行靠 mt-auto 对齐）',
    new Set(Object.values(dom.tileHeights)).size === 1, JSON.stringify(dom.tileHeights))
}

/* 5) 空数据与降级：全站掉线时「—」而不是 0%；并列时留先出现的 */
{
  const down = await render({ listTop: 'summary' }, 'down', 'down')
  check('全掉线：0 / 4 + 4 台离线', down.tileText['节点'] === '节点 | 0 / 4 | 4 台离线', down.tileText['节点'])
  check('全掉线：最忙节点显示「— / 无在线节点」，不是 0%',
    down.tileText['最忙节点'] === '最忙节点 | — | 无在线节点', down.tileText['最忙节点'])
  check('全掉线：网速是 0 B/s（不是 NaN/undefined）',
    down.tileText['实时网速'] === '实时网速 | 0 B/s | 0 B/s', down.tileText['实时网速'])

  const tied = await render({ listTop: 'summary' }, 'tied', 'tied')
  check('最忙并列：留列表里先出现的那台', tied.tileText['最忙节点'] === '最忙节点 | 30.0% | 先出现的', tied.tileText['最忙节点'])
}

/* 6) 窄屏 390：概览的多列栅格不能把页面撑出横向滚动 */
{
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  const dom = await render({ listTop: 'both', cardStyle: 'detailed' }, 'narrow')
  check('窄屏 390：无横向滚动', dom.scroll[0] === dom.scroll[1], `scrollWidth ${dom.scroll[0]} / clientWidth ${dom.scroll[1]}`)
  check('窄屏 390：四张卡片仍都在', dom.tiles === 4, `概览 ${dom.tiles} 张`)
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false })
}

/* 7) 旧配置迁移：≤1.4.0 存的是 showSummary / showGroupTabs 两个布尔开关 */
// 这两个键现在读不出来了（列表页顶部合成一个 listTop 四选一），必须按组合迁过来——
// 不迁的表现不是报错，而是「站长开着的那一行自己关了」。
{
  const onlySummary = await render({ showSummary: true }, 'legacy-summary')
  check('旧键迁移：只存 showSummary=true → 概览行照常出现、分组标签行不出现',
    onlySummary.tiles === 4 && !onlySummary.body.includes('未分组'),
    `概览 ${onlySummary.tiles} 张 / 分组行 ${onlySummary.body.includes('未分组')}`)

  const onlyTabs = await render({ showGroupTabs: true }, 'legacy-tabs')
  check('旧键迁移：只存 showGroupTabs=true → 分组标签行在、概览行不在',
    onlyTabs.tiles === 0 && onlyTabs.body.includes('未分组'),
    `概览 ${onlyTabs.tiles} 张 / 分组行 ${onlyTabs.body.includes('未分组')}`)

  const both = await render({ showSummary: true, showGroupTabs: true }, 'legacy-both')
  check('旧键迁移：两个旧键都开 → 两个都显示',
    both.tiles === 4 && both.body.includes('未分组'),
    `概览 ${both.tiles} 张 / 分组行 ${both.body.includes('未分组')}`)

  const none = await render({ showSummary: false, showGroupTabs: false }, 'legacy-none')
  check('旧键迁移：两个旧键都关 → 两个都不显示', none.tiles === 0 && !none.body.includes('未分组'),
    `概览 ${none.tiles} 张 / 分组行 ${none.body.includes('未分组')}`)
}

ws.close()
chrome.kill()
server.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} PASS / ${failed.length} FAIL`)
process.exit(failed.length ? 1 : 0)

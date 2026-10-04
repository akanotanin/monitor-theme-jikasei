// 「经典」档浮层底部那块三网延迟的护栏（2026-10-04 定的口径）。
//
// 用法：node tools/verify_peek_latency.mjs [端口]
//   自带静态伺服（本机 dist + 桩 /api，未知路径回落入口 HTML）——与 verify_card_styles.mjs 同一路子，
//   并顺手数 /api/nodes/<id>/metrics 的请求数（「按需取」那几条判据全靠它）。
//
// 站长定的口径（这一份就是它的判据）：
//   · 只有「经典」档挂这块：排在「到期」下面，两者之间一条 1px 分隔线，**不写「三网延迟」四个字**；
//     「延迟」档卡面本来就有这三条，它的浮层保持原样（224 宽、内容不变）；简约/详细/紧凑都不挂。
//   · 三条线路与卡面共用同一份口径：后台「三网延迟」里填名字就按名字取、按填写顺序，留空取前三条，
//     最多三条；名字对不上就跳过、不占位。
//   · **打开浮层才取数**：页面加载后一动不动时一个 ping 请求都不发；点开那一下恰好 1 条；
//     关掉之后不再有新的；再点开再取 1 条（不是「只在页面加载时取一次」）。
//   · 浮层是绝对定位：开与不开，卡片总高逐像素相同。
//   · 取不到延迟数据（或这台没有延迟）→ 整块**连分隔线一起**不渲染，计费那几行照旧。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = Number(process.argv[2] || 5591)
const CDP_PORT = PORT + 4200

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
}

/* ------------------------------------------------------------------ 桩数据 */
const GB = 1024 ** 3
const TB = 1024 ** 4
const node = (id, name) => ({
  id, name, sort: id, public: true, online: true, country: 'JP', group: '',
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
  public_remark: '',
})
const NODES = { nodes: [node(1, '节点一'), node(2, '节点二'), node(3, '节点三')] }

// 四条线路：延迟与丢包各不相同，便于断「逐行同序」与「按 name 挑」。
// ★ 最后一个点**必须正好是 base**：浮层里显示的是「最新一个非空样本」，
// 让正弦那点起伏落在倒数第二个点上，断言才写得成固定的数字（否则会差个 2ms，看着像实现坏了）。
const pingPoints = (taskId, base) => Array.from({ length: 12 }, (_, i) => ({
  task_id: taskId, ts: Math.floor(Date.now() / 1000) - (12 - i) * 300,
  latency: i === 11 ? base : Math.round(base + Math.sin(i) * 2), band: [base - 10, base + 10], loss: 0,
}))
const PING = {
  ping: [...pingPoints(11, 42), ...pingPoints(12, 88), ...pingPoints(13, 130), ...pingPoints(14, 210)],
  probes: { 11: '北京电信', 12: '北京联通', 13: '北京移动', 14: '上海电信' },
  loss: { 11: 0, 12: 1.2, 13: 0, 14: 3.4 },
}
const PING_EMPTY = { ping: [], probes: {}, loss: {} }

let config = {}
let pingHits = []
let pingEmpty = false

/* ------------------------------------------------------------------ 伺服 */
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  if (path === '/__stats' || path === '/__reset' || path === '/__empty') {
    if (path === '/__reset') pingHits = []
    if (path === '/__empty') pingEmpty = url.searchParams.get('on') === '1'
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify({ pingHits, pingEmpty }))
  }
  if (path.startsWith('/api/')) {
    let body = {}
    if (path === '/api/me') body = { authed: false, github: false, history_days: 30, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '浮层延迟校验' }
    else if (path === '/api/nodes') body = NODES
    else if (path.endsWith('/config')) body = config
    else if (path === '/api/version') body = { version: '1.3.0' }
    else if (/^\/api\/nodes\/\d+\/metrics/.test(path)) {
      pingHits.push(path)
      body = url.searchParams.get('series') === 'ping'
        ? (pingEmpty ? PING_EMPTY : PING)
        : { ts: [], cpu: [], mem_used: [], disk_used: [], net_rx: [], net_tx: [] }
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  const file = path === '/' ? '/index.html' : path
  const full = join('dist', normalize(file).replace(/^(\\.[/\\\\])+/, ''))
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
  `--user-data-dir=${join(tmpdir(), `peeklat${CDP_PORT}`)}`, '--no-sandbox', 'about:blank',
], { stdio: 'ignore' })

let id = 0
const pending = new Map()
const problems = []
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
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') problems.push(`[exception] ${m.params.exceptionDetails.text}`)
}
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJS = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable')
await send('Page.enable')

/* ------------------------------------------------------------------ 探针 */
// 全部按结构取（卡片第 1 个 [data-slot=card]、浮层的直接子元素、块里每行的子 span），不认 Tailwind 类名。
const PEEK = `JSON.stringify((() => {
  const card = [...document.querySelectorAll('[data-slot="card"]')].find((c) => /CPU/.test(c.innerText));
  const empty = { card: false, hasPopover: false, open: false, block: false, labels: [], rows: [], panelText: '', border: null, padTop: null, cardH: 0, panel: null, overflowX: false, vw: innerWidth };
  if (!card) return empty;
  const btn = card.querySelector('[data-note-popover]');
  const panel = card.querySelector('[data-note-panel]');
  const block = card.querySelector('[data-peek-latency]');
  const cs = (el) => el ? getComputedStyle(el) : null;
  const rect = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom), right: Math.round(b.right) }; };
  const kids = panel ? [...panel.children] : [];
  const labelOf = (el) => { const s = el.querySelector('span'); return (s ? s.textContent : el.textContent).trim(); };
  return {
    card: true, hasPopover: !!btn, open: !!panel, block: !!block,
    cardH: Math.round(card.getBoundingClientRect().height),
    panel: panel ? rect(panel) : null,
    panelW: panel ? cs(panel).width : null,
    labels: kids.map(labelOf),
    blockIndex: block ? kids.indexOf(block) : -1,
    blockY: block ? Math.round(block.getBoundingClientRect().y) : null,
    rowY: (() => { const row = kids.find((k) => !/^\\s*$/.test(labelOf(k)) && labelOf(k) === '到期'); return row ? Math.round(row.getBoundingClientRect().y) : null })(),
    border: block ? [cs(block).borderTopWidth, cs(block).borderRightWidth, cs(block).borderBottomWidth, cs(block).borderLeftWidth].join(',') : null,
    padTop: block ? cs(block).paddingTop : null,
    rows: block ? [...block.children].map((row) => {
      const spans = [...row.children];
      return { name: (spans[0] || {}).textContent?.trim() ?? '', ms: (spans[1] || {}).textContent?.trim() ?? '',
               spark: row.querySelectorAll('svg').length, loss: (spans[spans.length - 1] || {}).textContent?.trim() ?? '',
               clipped: row.scrollWidth > row.clientWidth + 1 };
    }) : [],
    panelText: panel ? panel.innerText.replace(/\\n/g, ' / ') : '',
    overflowX: document.documentElement.scrollWidth > window.innerWidth,
    vw: window.innerWidth,
  };
})())`

const hits = async () => (await (await fetch(`http://127.0.0.1:${PORT}/__stats`)).json()).pingHits.length
const setEmpty = (on) => fetch(`http://127.0.0.1:${PORT}/__empty?on=${on ? 1 : 0}`)

/** 打开第一张卡片右上角那枚 ⓘ，等到浮层（可选：等到延迟块里出现数字）。 */
async function openPeek({ waitBlock = false } = {}) {
  await evalJS(`document.querySelector('[data-slot="card"] [data-note-popover]')?.click()`)
  for (let i = 0; i < 40; i++) {
    await sleep(150)
    const raw = JSON.parse(await evalJS(PEEK))
    if (raw.open && (!waitBlock || (raw.block && raw.rows.some((r) => /ms|超时/.test(r.ms))))) return raw
  }
  return JSON.parse(await evalJS(PEEK))
}
async function closePeek() {
  await evalJS(`document.querySelector('[data-slot="card"] [data-note-popover]')?.click()`)
  await sleep(300)
  return JSON.parse(await evalJS(PEEK))
}
async function render(cfg, { width = 1440, height = 1200 } = {}) {
  config = cfg
  await fetch(`http://127.0.0.1:${PORT}/__reset`)
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?m=${encodeURIComponent(JSON.stringify(cfg))}` })
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    const raw = await evalJS(`document.querySelectorAll('[data-slot="card"], table tbody tr[role=button]').length`)
    if (raw > 0) break
  }
  await sleep(700)
}

const results = []
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }
const rowsOf = (r) => r.rows.map((x) => `${x.name}|${x.ms}|${x.loss}`).join(' ; ')

/* ───────────────── ① 经典档：按需取数 + 三行的形状 ───────────────── */
console.log('\n── 经典档：点开浮层才取数 ──')
await render({ cardStyle: 'classic' })
const closed = JSON.parse(await evalJS(PEEK))
check('经典（浮层关着）：卡片上有那枚 ⓘ，但没有浮层、也没有延迟块', closed.hasPopover && !closed.open && !closed.block,
  JSON.stringify({ btn: closed.hasPopover, open: closed.open, block: closed.block }))
check('经典（浮层关着）：页面加载后一个 ping 请求都不发', (await hits()) === 0, `实测 ${await hits()} 次`)
const cardH = closed.cardH

const opened = await openPeek({ waitBlock: true })
check('经典（点开）：浮层与延迟块都渲染出来了', opened.open && opened.block, JSON.stringify({ open: opened.open, block: opened.block }))
const afterOpen = await hits()
check('经典（点开）：恰好 1 条 ping 请求（按需取，不是常驻）', afterOpen === 1, `实测 ${afterOpen} 次`)
check('经典：三条线路逐行同序（名 / 延迟 / 走势线 / 丢包）',
  rowsOf(opened) === '北京电信|42 ms|0.0% ; 北京联通|88 ms|1.2% ; 北京移动|130 ms|0.0%', rowsOf(opened))
check('经典：每行都画了走势线（3 条 polyline 所在的 svg）', opened.rows.every((r) => r.spark === 1),
  JSON.stringify(opened.rows.map((r) => r.spark)))
check('经典：浮层里**没有**「三网延迟」这四个字', opened.panelText.indexOf('三网延迟') < 0, opened.panelText.slice(0, 120))
check('经典：延迟块排在「到期」下面（是浮层的最后一格）',
  opened.blockIndex === opened.labels.length - 1 && opened.labels[opened.blockIndex - 1] === '到期',
  JSON.stringify({ labels: opened.labels, blockIndex: opened.blockIndex }))
check('经典：分隔线只在块的上面（1px，其余三边 0）', opened.border === '1px,0px,0px,0px', String(opened.border))
check('经典：块自己带 8px 上内边距（线和第一行之间不贴）', opened.padTop === '8px', String(opened.padTop))
check('经典：在线时间 / 价格 / 到期 三行都还在（没被这块挤走）',
  ['在线时间', '价格', '到期'].every((l) => opened.labels.includes(l)), JSON.stringify(opened.labels))
check('经典：开了浮层卡片总高也不变（绝对定位、不给卡片加高）', opened.cardH === cardH, `${closed.cardH} → ${opened.cardH}`)

console.log('\n── 经典档：关掉之后不再取数、再点开再取一次 ──')
const reclosed = await closePeek()
check('经典（关掉）：延迟块从 DOM 里消失', !reclosed.block && !reclosed.open, JSON.stringify({ block: reclosed.block, open: reclosed.open }))
await sleep(1300)
check('经典（关掉 1.3 秒后）：没有新的 ping 请求（不是关着也在轮询）', (await hits()) === afterOpen, `实测 ${await hits()} 次（关之前 ${afterOpen}）`)
await openPeek({ waitBlock: true })
check('经典（再点开）：又取了 1 条（不是「只在页面加载时取一次」）', (await hits()) === afterOpen + 1, `实测 ${await hits()} 次`)

/* ───────────────── ② 站长的线路清单：与卡面共用同一份口径 ───────────────── */
console.log('\n── 经典档：后台「三网延迟」里填了名字 ──')
await render({ cardStyle: 'classic', pingLines: '上海电信\n北京联通' })
const picked = await openPeek({ waitBlock: true })
check('填了两个名字 → 浮层里就只有这两条、按填写的顺序（含丢包那一列）',
  rowsOf(picked) === '上海电信|210 ms|3.4% ; 北京联通|88 ms|1.2%', rowsOf(picked))
await render({ cardStyle: 'classic', pingLines: '北京移动\n不存在的线路\n北京电信' })
const skipped = await openPeek({ waitBlock: true })
check('名单里有一个对不上的名字 → 跳过它、不占位，其余两条仍按填写顺序',
  rowsOf(skipped) === '北京移动|130 ms|0.0% ; 北京电信|42 ms|0.0%', rowsOf(skipped))

/* ───────────────── ③ 取不到延迟数据：整块连分隔线一起不渲染 ───────────────── */
console.log('\n── 经典档：这台没有延迟数据 ──')
await setEmpty(true)
await render({ cardStyle: 'classic' })
const noData = await openPeek()
check('桩里 ping 为空：整块不渲染（连分隔线也没有）', !noData.block && noData.open, JSON.stringify({ block: noData.block, open: noData.open }))
check('桩里 ping 为空：计费那三行照旧（浮层不是空的）',
  ['在线时间', '价格', '到期'].every((l) => noData.labels.includes(l)), JSON.stringify(noData.labels))
check('桩里 ping 为空：卡片总高仍与平时相同', noData.cardH === cardH, `${cardH} → ${noData.cardH}`)
check('桩里 ping 为空：请求照发（证明是「没数据不渲染」，不是「没取数」）', (await hits()) === 1, `实测 ${await hits()} 次`)
await setEmpty(false)

/* ───────────────── ④ 只有经典档有这块 ───────────────── */
console.log('\n── 其余四档：一个都不挂这块 ──')
for (const style of ['plain', 'latency', 'detailed', 'compact']) {
  await render({ cardStyle: style })
  const before = await hits()
  const got = await openPeek()
  const after = await hits()
  check(`${style}：浮层（或卡面）里没有 [data-peek-latency]`, !got.block, JSON.stringify({ block: got.block }))
  if (style === 'latency') {
    check('latency：浮层保持原来的 224px 宽（没跟着经典档加宽）', got.panelW === '224px', String(got.panelW))
    check('latency：浮层里仍是在线时间 / 价格 / 到期', ['在线时间', '价格', '到期'].every((l) => got.labels.includes(l)), JSON.stringify(got.labels))
    check('latency：卡面本来就有三网延迟（每张卡各取一条 → 三张卡 3 次），浮层不额外取数',
      before === 3 && after === 3, `${before} → ${after}`)
  } else if (style === 'detailed') {
    check('detailed：卡面也有三网延迟（同样三张卡 3 次），浮层里没有第二块',
      before === 3 && after === 3, `${before} → ${after}`)
  } else {
    check(`${style}：全程不发 ping 请求`, before === 0 && after === 0, `${before} → ${after}`)
  }
}

/* ───────────────── ⑤ 手机 390：浮层不出视口、三行不被截 ───────────────── */
console.log('\n── 手机 390（触屏机位）──')
await render({ cardStyle: 'classic' }, { width: 390, height: 844 })
const mob = await openPeek({ waitBlock: true })
check('手机：浮层在视口内（右沿不越界、左沿不为负）', mob.panel.right <= mob.vw && mob.panel.x >= 0,
  JSON.stringify({ panel: mob.panel, vw: mob.vw }))
check('手机：页面没有横向溢出', mob.overflowX === false, String(mob.overflowX))
check('手机：三行都没被截断（每行 scrollWidth ≤ clientWidth）', mob.rows.length === 3 && mob.rows.every((r) => !r.clipped),
  JSON.stringify(mob.rows.map((r) => r.clipped)))
check('手机：三行逐字同序与桌面一致', rowsOf(mob) === '北京电信|42 ms|0.0% ; 北京联通|88 ms|1.2% ; 北京移动|130 ms|0.0%', rowsOf(mob))

/* ───────────────── 收尾 ───────────────── */
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} PASS / ${failed.length} FAIL`)
if (problems.length) console.log(`控制台异常 ${problems.length} 条：\n  ${problems.slice(0, 5).join('\n  ')}`)
else console.log('全程没有控制台异常')
ws.close()
chrome.kill()
server.close()
process.exit(failed.length || problems.length ? 1 : 0)

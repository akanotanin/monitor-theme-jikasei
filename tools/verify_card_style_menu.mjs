// 「卡片形态」那枚菜单的验收：本机伺服 dist/ + 桩 /api/*（含延迟数据），用 headless Chrome
// 把「访客自己切换五种形态」这条路走一遍。
//
// 用法：node tools/verify_card_style_menu.mjs [截图目录=shots/card-style]
//   先 `npm run build` —— 验的是 dist/，不是源码。
//
// 四条最要紧的断言：
//   · **点了哪一档，卡片真的换成了那一档**（不是只把菜单打个勾）。判据用**结构**：
//     经典 = 2×2 四格（`[data-net=grid]`）、简约/延迟 = 一行两段（`[data-net=row]`）、
//     延迟与详细才摊三网延迟（`[data-latency]`）、详细才多那一行元信息（`[data-meta]`）、
//     紧凑 = 一行一台的表格。任何一条只按类名找，改版后会静默失配。
//   · **访客的选择一个字节都不进 hub**（桩服务器数着非 GET 请求）：它是访客偏好（localStorage），
//     写进站点设置就成了"一个人改、全站变"，也正是主题铁律 4 要防的事。
//   · **挑成与站长设置相同的那一档 = 删掉记录**（重新"跟着站长走"），这样站长以后改默认，
//     这位访客也会跟着变 —— 只把那一档记下来会让"跟着站长"再也回不去。
//   · **认不出来的存值不能顶掉站长的默认**（读坏了 → 视为没选过），这是 `cardStyleOrNull`
//     与 `cardStyleOf` 唯一的差别，也是这条最容易写错的地方。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const OUT = process.argv[2] || 'shots/card-style'
const PORT = 5203
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }

// 站长的设置（每个场景换一次）。默认档是 plain —— 与 DEFAULTS 一致。
let CONFIG = { cardStyle: 'plain' }
// 桩服务器数着：非 GET 的 /api 请求（= 谁想写 hub）与延迟请求（LatencyPanel 要有数据才会画）。
let writes = []
let pings = 0

const node = (id, name, country) => ({
  id, name, sort: id, public: true, online: true, country, group: '', last_seen: Math.floor(Date.now() / 1000),
  metrics: { uptime: 90000, cpu: 12, load: [0.1, 0.2, 0.3], mem_total: 1e9, mem_used: 4e8, swap_total: 0, swap_used: 0, disk_total: 2e10, disk_used: 5e9, net_rx: 2048, net_tx: 1024, total_rx: 3e9, total_tx: 1e9, month_rx: 2e8, month_tx: 1e8, tcp: 30, udp: 4, procs: 90 },
  os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'Xeon', cpu_cores: 2,
  mem_total: 1e9, swap_total: 0, disk_total: 2e10, agent_version: '1.2.0', price: 30, currency: 'CNY',
  billing_cycle: 'month', expires_at: '2027-01-01', expires_in: 87, traffic_limit: 1e12, traffic_mode: 'sum',
  traffic_reset_day: 1, total_rx: 3e9, total_tx: 1e9, month_rx: 2e8, month_tx: 1e8, month_used: 3e8, month_start: '2026-10-01',
  day_rx: 1e7, day_tx: 5e6,
})
const NODES = { nodes: [node(1, '测试节点 · 东京', 'JP'), node(2, '测试节点 · 法兰克福', 'DE'), node(3, '测试节点 · 圣何塞', 'US')] }
// 一小时窗口的延迟：三条探测任务，够 LatencyPanel 画出来。
const PING = {
  ping: Array.from({ length: 20 }, (_, i) => [1, 2, 3].map((task) => ({ ts: Math.floor(Date.now() / 1000) - (19 - i) * 60, task_id: task, latency: 30 + task * 40 + (i % 5) }))).flat(),
  probes: { 1: '电信', 2: '联通', 3: '移动' },
  loss: { 1: 0, 2: 0, 3: 0 },
}

// 资源历史：详情页那四张图要吃它（点数、字段名照 hub 的真实响应来）。
const RESOURCES = {
  step: 60,
  metrics: Array.from({ length: 30 }, (_, i) => ({
    ts: Math.floor(Date.now() / 1000) - (29 - i) * 60,
    cpu: 10 + (i % 7), mem_used: 4e8 + i * 1e6, disk_used: 5e9 + i * 1e5,
    net_rx: 1024 + i * 10, net_tx: 512 + i * 5,
  })),
}

const server = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  if (path.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') writes.push(`${req.method} ${path}`)
    // ★ /metrics 有两个系列：`series=ping` 是延迟（LatencyPanel 用），别的一律是资源历史
    //   （详情页用）。两者返回同一个形状的话，详情页会拿到一个没有 `metrics` 数组的响应、
    //   当场抛 "Cannot read properties of undefined (reading 'length')" 而整页空白 ——
    //   而"页面空白"在 CDP 里只表现为 innerText 为空，很容易被当成"还没加载完"。
    if (path.includes('/metrics')) {
      const series = new URL(req.url, 'http://x').searchParams.get('series')
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      if (series === 'ping') { pings++; return res.end(JSON.stringify(PING)) }
      return res.end(JSON.stringify(RESOURCES))
    }
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '形态验收', history_days: 30 }
      : path === '/api/nodes' ? NODES
      : path.endsWith('/config') ? CONFIG
      : {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] })
    return res.end(readFileSync('dist/index.html'))
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
mkdirSync(OUT, { recursive: true })

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
].find((p) => existsSync(p)) || 'chrome'

let chrome, dbgPort, wsUrl = null
for (let attempt = 0; attempt < 2 && !wsUrl; attempt++) {
  dbgPort = 9950 + Math.floor(Math.random() * 40)
  chrome?.kill()
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, '--remote-allow-origins=*',
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/stylecheck-' + dbgPort + '-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 80 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { /* 等它起来 */ }
    if (!wsUrl) await sleep(300)
  }
}
if (!wsUrl) throw new Error('Chrome 起不来：先看看是不是堆了太多测试实例（按 --user-data-dir 前缀清一遍）')

let id = 0
const pending = new Map()
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')
let errors = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails
    errors.push(`${d.text} ${d.exception?.description?.split('\n')[0] ?? ''} @${d.url ?? ''}:${d.lineNumber ?? ''}`)
  }
})

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  if (r.result?.data) writeFileSync(join(OUT, name), Buffer.from(r.result.data, 'base64'))
}

// 页面上要断言的都在这一段里取回来。**别在模板字符串里写反引号或正则**（踩过）。
const READ = `(() => {
  const btn = document.querySelector('.card-style-toggle');
  const menu = document.querySelector('[data-style-menu]');
  const opts = menu ? [...menu.querySelectorAll('[data-style-option]')] : [];
  const grid = document.querySelector('[data-card-style]');
  const table = document.querySelector('table');
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) } };
  return JSON.stringify({
    style: grid ? grid.getAttribute('data-card-style') : null,
    toggle: btn ? { title: btn.getAttribute('title'), expanded: btn.getAttribute('aria-expanded'), box: box(btn), cls: btn.className } : null,
    menu: !!menu,
    menuBox: menu ? box(menu) : null,
    options: opts.map((b) => ({
      value: b.getAttribute('data-style-option'),
      label: b.textContent.replace('默认', '').trim(),
      checked: b.getAttribute('aria-checked') === 'true',
      tag: b.textContent.indexOf('默认') >= 0,
      hint: b.getAttribute('title'),
      icons: b.querySelectorAll('svg').length,
    })),
    cards: document.querySelectorAll('[data-slot="card"][role="button"]').length,
    netGrid: document.querySelectorAll('[data-net="grid"]').length,
    netRow: document.querySelectorAll('[data-net="row"]').length,
    latency: document.querySelectorAll('[data-latency]').length,
    meta: document.querySelectorAll('[data-meta]').length,
    tableHead: table ? table.querySelector('thead').innerText.replace(/\\s+/g, ' ').trim() : null,
    icons: [...document.querySelectorAll('header button[title], header a[title]')].map((b) => b.getAttribute('title')),
    stored: (() => { try { return localStorage.getItem('jikasei:card_style') } catch (e) { return 'ERR' } })(),
    url: location.pathname,
    width: window.innerWidth,
  });
})()`

const open = async (opts = {}) => {
  errors = []
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    const raw = await js(READ)
    if (!raw) continue
    const st = JSON.parse(raw)
    // 列表真的画出来了（有卡片、且形态锚点已定）才算到齐；延迟那两档还要等 LatencyPanel 取到数据。
    if (st.cards > 0 && st.style && (!opts.wantLatency || st.latency > 0)) return st
  }
  return JSON.parse(await js(READ))
}

/**
 * ★ 五种形态各自的**结构判据**：`all` = 每一张卡片都有它，`none` = 一张都没有。
 * 写成"每张都有"而不是写死个数：整页有几张卡是数据决定的，写死 1 会在节点数一变就假失败
 * （第一版就是这么写的，三张卡时 net-row 是 3，于是每一条都红）。
 */
const SHAPE = {
  classic: { all: ['netGrid'], none: ['netRow', 'latency', 'meta'] },
  plain: { all: ['netRow'], none: ['netGrid', 'latency', 'meta'] },
  latency: { all: ['netRow', 'latency'], none: ['netGrid', 'meta'] },
  detailed: { all: ['latency', 'meta'], none: ['netGrid', 'netRow'] },
  compact: { all: [], none: ['netGrid', 'netRow', 'latency', 'meta'], table: true },
}
const shapeOk = (st, style) => {
  const want = SHAPE[style]
  const every = (key) => st.cards > 0 && st[key] === st.cards
  const none = (key) => st[key] === 0
  if (!want.all.every(every)) return false
  if (!want.none.every(none)) return false
  if (want.table && !st.tableHead) return false
  return true
}
const shapeWhy = (st) => `卡 ${st.cards} 张 / net-grid=${st.netGrid} net-row=${st.netRow} latency=${st.latency} meta=${st.meta} table=${!!st.tableHead}`
const LABELS = { classic: '经典', plain: '简约', latency: '延迟', detailed: '详细', compact: '紧凑' }

console.log('\n=== 一、站长设置 = 简约（默认档），访客没选过 ===')
let s = await open()
check('顶栏有那枚菜单按钮（纯图标、36×36，与相邻两枚同规格）', s.toggle?.title === '卡片形态' && s.toggle?.box.w === 36 && s.toggle?.box.h === 36, JSON.stringify(s.toggle?.box))
check('菜单默认是收起的（aria-expanded=false，DOM 里没有菜单）', s.toggle?.expanded === 'false' && s.menu === false)
check('★ 访客没选过 → 列表就是站长设置的那一档（简约）', s.style === 'plain' && shapeOk(s, 'plain'), `${s.style} net-row=${s.netRow}`)
// 搜索框（名称 / 地区 / 系统）从本版起排在图标区最前 —— 与卡片形态那枚同属「看哪几台」的工具，
// 也同条件（只在列表页出现）；顺序钉住，谁被挪走了才一眼可见。
check('顶栏顺序：搜索框 → 登录 → 卡片形态 → 地球 → 切换主题', JSON.stringify(s.icons) === JSON.stringify(['搜索（名称 / 地区 / 系统）', '登录', '卡片形态', '隐藏节点地球', '切换主题']), JSON.stringify(s.icons))
check('访客还没选择，localStorage 里没有记录', s.stored === null, String(s.stored))

console.log('\n=== 二、打开菜单：五档、名字与顺序、默认标在哪 ===')
await js(`document.querySelector('.card-style-toggle').click()`)
await sleep(250)
s = JSON.parse(await js(READ))
check('点一下打开', s.toggle?.expanded === 'true' && s.menu === true)
check('五种形态一个不多一个不少，顺序与 CARD_STYLES 一致',
  JSON.stringify(s.options.map((o) => o.value)) === JSON.stringify(['classic', 'plain', 'latency', 'detailed', 'compact']),
  JSON.stringify(s.options.map((o) => o.value)))
check('名字与后台设置里那五档逐字一致',
  JSON.stringify(s.options.map((o) => o.label)) === JSON.stringify(Object.values(LABELS)),
  JSON.stringify(s.options.map((o) => o.label)))
check('每一行都有图标与悬停说明', s.options.every((o) => o.icons >= 1 && o.hint), JSON.stringify(s.options.map((o) => [o.icons, o.hint])))
check('「默认」标在站长设置的那一档上（简约）', s.options.filter((o) => o.tag).map((o) => o.value).join(',') === 'plain', JSON.stringify(s.options.filter((o) => o.tag).map((o) => o.value)))
check('勾在当前生效的那一档上，且只有一个勾', s.options.filter((o) => o.checked).map((o) => o.value).join(',') === 'plain', JSON.stringify(s.options.filter((o) => o.checked).map((o) => o.value)))
await shot('01-menu-open.png')

console.log('\n=== 三、逐档点一遍：卡片真的换成那一档 ===')
const pick = (v) => js(`(() => { const b = document.querySelector('[data-style-option="${v}"]'); if (!b) return false; b.click(); return true })()`)
for (const style of ['classic', 'plain', 'latency', 'detailed', 'compact']) {
  writes = []
  pings = 0
  // 菜单可能还开着（上一段就是开着收尾的）：只在"没开"时才点开，否则这一下会把它关掉。
  await js(`(() => { if (!document.querySelector('[data-style-menu]')) document.querySelector('.card-style-toggle').click(); return true })()`)
  await sleep(250)
  const clicked = await pick(style)
  await sleep(style === 'latency' || style === 'detailed' ? 1200 : 500)
  s = JSON.parse(await js(READ))
  check(`点「${LABELS[style]}」→ 列表换成那一档`, clicked === true && s.style === style, `${s.style}`)
  check(`  「${LABELS[style]}」的形状对（结构判据：每张卡都有 ${SHAPE[style].all.join('+') || '（表格）'}、都没有 ${SHAPE[style].none.join('+')}）`,
    shapeOk(s, style), shapeWhy(s))
  check('  点完菜单自己收起', s.menu === false && s.toggle?.expanded === 'false')
  // ★ 选成与站长设置相同的那一档时**记录要被删掉**（= 重新"跟着站长走"，见下面第四段）：
  //   这一轮站长的默认是「简约」，所以点「简约」时留 null 才是对的。
  const expectStored = style === CONFIG.cardStyle ? null : style
  check('  记录只进访客自己的浏览器' + (style === CONFIG.cardStyle ? '（选成站长那档 → 记录删掉）' : ''), s.stored === expectStored, `${s.stored}`)
  check('  ★ hub 一个字节都没写（非 GET 的 /api 请求数 = 0）', writes.length === 0, writes.join(' | '))
  // 延迟/详细两档才要延迟数据（上面那条形状断言已经证明它到手了）。这里只把请求次数打出来：
  // 从「延迟」切到「详细」时同一个 <LatencyPanel> 被复用、数据还在（TTL 60 秒），所以那一下
  // **不该**再发请求 —— 一开始我按"每一档都该重新取"写，红了才明白。
  if (pings) console.log(`  INFO  本轮 /metrics?series=ping 请求 ${pings} 次`)
  if (style === 'compact') { check('  紧凑档的表头是那一行（名称/系统/在线…）', (s.tableHead || '').indexOf('名称') === 0, String(s.tableHead)); await shot('02-compact.png') }
  if (style === 'classic') await shot('03-classic.png')
  if (style === 'detailed') await shot('04-detailed.png')
}

console.log('\n=== 四、挑成与站长设置相同的那一档 = 删掉记录（重新跟着站长走） ===')
s = JSON.parse(await js(READ))
check('此刻存的是「紧凑」', s.stored === 'compact', String(s.stored))
await js(`document.querySelector('.card-style-toggle').click()`)
await sleep(200)
await pick('plain')
await sleep(400)
s = JSON.parse(await js(READ))
check('★ 选成站长那档（简约）后记录被删掉', s.stored === null, String(s.stored))
check('列表仍是简约', s.style === 'plain')

console.log('\n=== 五、刷新之后还记得 ===')
await js(`document.querySelector('.card-style-toggle').click()`)
await sleep(200)
await pick('compact')
await sleep(400)
check('先选成紧凑', JSON.parse(await js(READ)).stored === 'compact')
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1200)
s = JSON.parse(await js(READ))
check('★ 刷新后仍是紧凑（访客的选择记住了）', s.style === 'compact' && s.stored === 'compact', `${s.style} / ${s.stored}`)
check('刷新后菜单里有且只有一个勾（落在紧凑上）', await js(`(() => { document.querySelector('.card-style-toggle').click(); return true })()`) && (await sleep(150), true) &&
  (JSON.parse(await js(READ)).options.filter((o) => o.checked).map((o) => o.value).join(',') === 'compact'), '勾的位置')
await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
await sleep(200)
check('Esc 能收起菜单', JSON.parse(await js(READ)).menu === false)

console.log('\n=== 六、站长换默认档：访客没选过就跟着变，选过的保持自己的 ===')
await js(`localStorage.clear()`)
CONFIG = { cardStyle: 'classic' }
s = await open()
check('换默认成「经典」后，没选过的访客看到经典', s.style === 'classic' && shapeOk(s, 'classic'), s.style)
await js(`document.querySelector('.card-style-toggle').click()`)
await sleep(200)
check('「默认」那枚标跟着挪到经典上', JSON.parse(await js(READ)).options.find((o) => o.tag)?.value === 'classic')
await pick('compact')
await sleep(400)
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1200)
s = JSON.parse(await js(READ))
check('★ 选过的访客不受站长改默认影响（仍是紧凑）', s.style === 'compact', s.style)

console.log('\n=== 七、旧名与野值 ===')
await js(`localStorage.setItem('jikasei:card_style','detail')`)
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1200)
s = JSON.parse(await js(READ))
check('存过旧名 detail 的访客迁到「延迟」', s.style === 'latency' && shapeOk(s, 'latency'), `${s.style}`)
await js(`localStorage.setItem('jikasei:card_style','nope')`)
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1200)
s = JSON.parse(await js(READ))
check('★ 认不出的存值 → 视为没选过，跟着站长的默认（经典）', s.style === 'classic', `${s.style} / ${s.stored}`)
check('野值不被写回（也不会被当成有效档）', s.stored === 'nope', String(s.stored))

console.log('\n=== 八、详情页上不该有这枚菜单 ===')
await js(`localStorage.clear()`)
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/node/1` })
await sleep(2500)
s = JSON.parse(await js(READ))
check('详情页没有卡片形态菜单（它只影响列表页）', s.toggle === null, JSON.stringify(s.toggle))
check('详情页也没有地球（上一版就是如此）', (s.icons || []).indexOf('隐藏节点地球') < 0, JSON.stringify(s.icons))
const detailText = await js(`document.body.innerText.slice(0, 120)`)
check('1 号机器的详情页画出来了', String(detailText).indexOf('测试节点 · 东京') >= 0, JSON.stringify(detailText))

console.log('\n=== 九、手机 390×844 ===')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await js(`localStorage.setItem('jikasei:card_style','compact')`)
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1400)
s = JSON.parse(await js(READ))
check('窄屏仍按访客的选择渲染（紧凑）', s.style === 'compact', s.style)
await js(`(() => { if (!document.querySelector('[data-style-menu]')) document.querySelector('.card-style-toggle').click(); return true })()`)
await sleep(300)
s = JSON.parse(await js(READ))
check('窄屏菜单不出界（左右都在视口内）', s.menuBox.x >= 0 && s.menuBox.right <= s.width, `${JSON.stringify(s.menuBox)} / 宽 ${s.width}`)
check('窄屏顶栏没有横向溢出', await js('document.documentElement.scrollWidth <= 390'), await js('String(document.documentElement.scrollWidth)'))
await shot('05-mobile-menu.png')
await pick('detailed')
await sleep(1200)
s = JSON.parse(await js(READ))
check('窄屏上选「详细」也真的换过去', s.style === 'detailed' && shapeOk(s, 'detailed'), `${s.style} latency=${s.latency} meta=${s.meta}`)
await send('Emulation.clearDeviceMetricsOverride')

check('全程控制台无异常', errors.length === 0, errors.slice(0, 3).join(' | '))
console.log(`\n${fail ? '✗' : '✓'} 卡片形态菜单：${pass} 条通过 / ${fail} 条失败（截图在 ${OUT}/）`)
chrome?.kill()
server.close()
process.exit(fail ? 1 : 0)

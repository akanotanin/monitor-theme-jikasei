// 备注（hub 后台的「公开备注」+ 主题设置里的「服务器备注」，取舍见 @/lib/notes）在五种卡片形态、
// 「紧凑」就地展开与整页详情上的落点护栏，外加「时间范围按保留天数生成」（见 @/lib/ranges）。
//
// 用法：node tools/verify_public_remark.mjs [端口]
//   自带静态伺服（本机 dist + 桩 /api，未知路径回落入口 HTML）——与 verify_card_styles.mjs 同一路子。
//   ★别改成「CDP 拦 *api/*」：那会把顶栏那个 `/chicken/api/nodes` 探测也拦进来，它期待
//     `{nodes:[…]}`，喂错形状整页当场崩（症状是页面上只剩一行 TypeError 文案）。
//
// 站长 2026-10-03 定的口径（这一份护栏就是它的判据）：
//   · 来源两处，**主题设置优先**：主题设置里写了这台就用那里的，没写才用 hub 的公开备注；
//   · 「经典」「延迟」两档**右上角常驻**一枚信息图标：点开是在线时间/价格/到期，写了备注就多一排小卡片；
//   · 「详细」档备注挂在标题行右端（多枚小卡片）；「简约」档不显示备注、也不挂那枚图标；
//   · 「紧凑」档并排在展开行量程栏右端（手机收成一枚图标 + 浮层）；
//   · **整页详情不摊备注**（只留规格与图表）；
//   · 没写备注的机器该处零占位；时间范围按 hub 的 `history_days` 生成（老 hub 按 7 天）。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = Number(process.argv[2] || 5461)
const SHOT_DIR = 'shots/remark'
const CDP_PORT = PORT + 4400
mkdirSync(SHOT_DIR, { recursive: true })

const GB = 1024 ** 3
const TB = 1024 ** 4
/**
 * 三种样张（写法与 1.15.x 那份「服务器备注」逐字相同：逗号分隔＝多枚小卡片）：
 *   · SHORT —— 三枚，卡片 / 浮层上该看到三枚；
 *   · MANY  —— 六枚，标题行与量程栏那格放不下的极端形状；
 *   · LONG  —— 一枚正好 100 字（hub 的上限），且**不含逗号**：一枚也能被截断 + 悬停看全。
 */
const SHORT = 'CN2 GIA,三网优化,晚高峰也稳'
const MANY = '备注1,备注测试2,备注333,流媒体解锁,IPv6 双栈,高防'
const LONG = '这是一条刚好一百字的公开备注用来验证详细档标题行右端的截断与悬停提示是否按预期工作；同时检查经典档新增的那枚小卡片在没有备注时是否零占位、以及延迟与紧凑两档的浮层里这几枚卡片会不会把价格和到期挤走。。'
if (LONG.length !== 100) throw new Error(`长备注样张必须是 100 字，现在是 ${LONG.length}`)
if (/[,，]/.test(LONG)) throw new Error('长备注样张不能含逗号，否则会被切成多枚')
const tagsOf = (v) => v.split(/[,，]/).map((t) => t.trim()).filter(Boolean)
const SAME = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ── 桩数据 ────────────────────────────────────────────────────────────────
// 三台：① 已接入（备注挂在它身上）② 在线但还没上报 ③ 从没接入。
const node1 = {
  id: 1, name: '节点一', sort: 1, public: true, online: true, country: 'JP', group: '',
  last_seen: Math.floor(Date.now() / 1000) - 5,
  metrics: {
    uptime: 400000, cpu: 12.5, load: [0.1, 0.2, 0.3], mem_total: 2 * GB, mem_used: GB,
    swap_total: 0, swap_used: 0, disk_total: 40 * GB, disk_used: 10 * GB,
    net_rx: 512 * 1024, net_tx: 128 * 1024, total_rx: TB, total_tx: 256 * GB,
    month_rx: 8 * GB, month_tx: 4 * GB, tcp: 10, udp: 2, procs: 100,
  },
  os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'Xeon',
  cpu_cores: 2, mem_total: 2 * GB, swap_total: 0, disk_total: 40 * GB,
  agent_version: '1.3.0', price: 12.5, currency: 'CNY', billing_cycle: 'monthly',
  expires_at: '2027-01-01', expires_in: 95, traffic_limit: TB, traffic_mode: 'sum',
  traffic_reset_day: 1, total_rx: TB, total_tx: 256 * GB,
  month_rx: 8 * GB, month_tx: 4 * GB, month_start: '2026-09-01', day_rx: GB, day_tx: GB / 2,
}
const node2 = {
  id: 2, name: '节点二', sort: 2, public: true, online: true, country: 'US', group: '',
  last_seen: Math.floor(Date.now() / 1000) - 3, metrics: null, os: '', kernel: '', arch: '', virt: '',
  cpu_name: '', cpu_cores: 1, mem_total: GB, swap_total: 0, disk_total: 20 * GB, agent_version: '1.3.0',
  price: 0, currency: 'USD', billing_cycle: '', expires_at: null, expires_in: null,
}
const node3 = {
  id: 3, name: '节点三', sort: 3, public: true, online: false, country: '', group: '',
  last_seen: 0, metrics: null, os: '', kernel: '', arch: '', virt: '', cpu_name: '',
  cpu_cores: 0, mem_total: 0, swap_total: 0, disk_total: 0, agent_version: '',
  price: 0, currency: '', billing_cycle: '', expires_at: null, expires_in: null,
}

const PROBES = { 11: '北京电信', 12: '上海电信', 13: '广州电信' }
const pingPoints = (taskId, base) => Array.from({ length: 60 }, (_, i) => ({
  task_id: taskId, ts: Math.floor(Date.now() / 1000) - (60 - i) * 300,
  latency: Math.round(base + Math.sin(i) * 6), band: [base - 10, base + 10], loss: 0,
}))
const PING = {
  ping: [...pingPoints(11, 42), ...pingPoints(12, 88), ...pingPoints(13, 130)],
  probes: PROBES, loss: { 11: 0, 12: 1.2, 13: 0 },
}

// ── 伺服（本机 dist + 桩 /api） ──────────────────────────────────────────
let remark = ''            // 节点一的 hub 公开备注（空串 = 没写）
let themeConfig = {}       // 站点配置（cardStyle / serverNotes）。★必须由本伺服自己回答：见 render()
let meExtra = {}           // /api/me 上多出来的字段（history_days）
let metricHits = []        // 详情页发出的历史请求（断「窗口按保留天数生成」用）
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' }
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  if (path === '/__hits') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify({ metricHits }))
  }
  if (path === '/__reset') {
    metricHits = []
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end('{}')
  }
  if (path.startsWith('/api/')) {
    let body = {}
    if (path === '/api/me') body = { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '备注校验', ...meExtra }
    // ★形状是 `{nodes:[…]}` 而不是裸数组：App 那边是 `api<{nodes:Node[]}>('/nodes')`。
    else if (path === '/api/nodes') body = { nodes: [{ ...node1, public_remark: remark }, node2, node3] }
    else if (path.endsWith('/config')) body = themeConfig
    else if (path === '/api/version') body = { version: '1.3.2' }
    else if (/^\/api\/nodes\/\d+\/metrics/.test(path)) {
      metricHits.push(url.search)
      if (url.searchParams.get('series') === 'ping') body = PING
      else {
        // 资源序列给一串跨**整个请求窗口**的点：刻度是按数据的首尾时间戳算的（见 format.ts 的
        // timeTicks），空数组会让 x 轴没东西可画，365 天那条「刻度不是 52 条」就断了个寂寞。
        const hours = Number(url.searchParams.get('hours') || 6)
        const n = 40
        const now = Math.floor(Date.now() / 1000)
        body = {
          metrics: Array.from({ length: n }, (_, i) => ({
            ts: Math.round(now - hours * 3600 + (i * hours * 3600) / n),
            cpu: 5 + (i % 7), mem_used: GB, disk_used: 10 * GB, net_rx: 1024, net_tx: 512,
          })),
          ping: [], probes: PROBES, loss: {},
        }
      }
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

// ── 浏览器 ────────────────────────────────────────────────────────────────
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p)) || 'chrome'
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--no-proxy-server', `--user-data-dir=${join(tmpdir(), `pubremark${CDP_PORT}`)}`,
  '--no-sandbox', 'about:blank'], { stdio: 'ignore' })

let target = null
for (let i = 0; i < 80 && !target; i++) {
  await sleep(300)
  try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page') } catch { /* 等 Chrome 起来 */ }
}
if (!target) throw new Error('Chrome 没起来')

const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const consoleErrors = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '异常')
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map((a) => a.value || a.description || '').join(' '))
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJS = async (expr) => {
  const r = (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result
  // 探针抛异常时别只回一个 undefined（那会让 JSON.parse 崩在一行看不懂的地方）——把异常打出来。
  if (r?.exceptionDetails) console.log('⚠ 页面侧异常：', r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r?.result?.value
}
const waitFor = async (expr, timeout = 40000) => { const d = Date.now() + timeout; while (Date.now() < d) { if ((await evalJS(expr)) === true) return true; await sleep(250) } return false }
let pass = 0, fail = 0
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ' — ' + info : ''}`)
  if (ok) pass += 1
  else fail += 1
}

await new Promise((r) => ws.addEventListener('open', r))
await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })

// ── 页面侧探针 ────────────────────────────────────────────────────────────
/** 按名字取卡片：DOM 顺序在分组/延迟行到达时会变，别拿「第一张卡」跨两次导航比。 */
const CARD = (name) => `[...document.querySelectorAll('[role=button]')].find((c) => ((c.querySelector('h3') || {}).textContent || '').trim() === ${JSON.stringify(name)})`

/**
 * 卡片几何 + 备注那几处。判「零占位」靠的是 cardH / rowH / gridTop 三个数与基线逐项相等：
 * 只断「元素不在」证明不了卡片没被撑高（浮层用绝对定位时不占位，可标题行里多一截是会占的）。
 */
const CARD_PROBE = (name) => `JSON.stringify((() => {
  const card = ${CARD(name)}
  if (!card) return { missing: true }
  const rect = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), r: Math.round(b.right), mid: Math.round(b.top + b.height / 2), w: Math.round(b.width | 0) } }
  const c = card.getBoundingClientRect()
  const h3 = card.querySelector('h3')
  const row = h3 ? h3.parentElement : null
  const grid = card.querySelector('.grid.grid-cols-2')
  const note = card.querySelector('[data-public-remark="title"]')
  const tagEls = note ? [...note.querySelectorAll('[data-slot="badge"]')] : []
  const boxes = [...card.querySelectorAll('[class*="bg-muted/60"]')]
  return {
    cardH: Math.round(c.height), cardRight: Math.round(c.right), cardTop: Math.round(c.top),
    rowH: row ? Math.round(row.getBoundingClientRect().height) : null,
    gridTop: grid ? Math.round(grid.getBoundingClientRect().top - c.top) : null,
    nameBox: h3 ? rect(h3) : null,
    nameClipped: h3 ? h3.scrollWidth > h3.clientWidth + 1 : null,
    note: !!note,
    noteAnchors: card.querySelectorAll('[data-public-remark]').length,
    tags: tagEls.map((b) => b.innerText.trim()),
    tagTitles: tagEls.map((b) => b.getAttribute('title')),
    tagBoxes: tagEls.map((b) => rect(b)),
    tagClipped: tagEls.map((b) => { const inner = b.querySelector('span'); return inner ? inner.scrollWidth > inner.clientWidth + 1 : null }),
    popover: !!card.querySelector('[data-note-popover]'),
    badges: card.querySelectorAll('[data-slot="badge"]').length,
    boxes: boxes.length,
    box3: boxes[2] ? boxes[2].innerText.split(String.fromCharCode(10)).map((t) => t.trim()).filter(Boolean) : null,
    row2: grid && grid.previousElementSibling ? grid.previousElementSibling.innerText.split(String.fromCharCode(10)).join(' | ') : null,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    text: card.innerText.split(String.fromCharCode(10)).join(' | '),
  }
})())`

/** 经典 / 延迟 / 紧凑 那枚浮层控件：控件本身、浮层内容、以及「点它不跳页」。 */
const POPOVER_PROBE = (scope) => `JSON.stringify((() => {
  const root = ${scope}
  if (!root) return { missing: true }
  const btn = root.querySelector('[data-note-popover]')
  const panel = root.querySelector('[data-note-panel]')
  const strip = root.querySelector('[data-note-strip]')
  const rect = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), r: Math.round(b.right), mid: Math.round(b.top + b.height / 2), bottom: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) } }
  return {
    btn: btn ? { tag: btn.tagName, expanded: btn.getAttribute('aria-expanded'), label: btn.getAttribute('aria-label'), ...rect(btn) } : null,
    panel: panel ? { tags: [...panel.querySelectorAll('[data-slot="badge"]')].map((b) => b.innerText.trim()), text: panel.innerText.trim(), ...rect(panel) } : null,
    strip: strip ? { tags: [...strip.querySelectorAll('[data-slot="badge"]')].map((b) => b.innerText.trim()), clipped: [...strip.querySelectorAll('[data-slot="badge"] span')].map((sp) => sp.scrollWidth > sp.clientWidth + 1), overflow: strip.scrollWidth > strip.clientWidth + 1, ...rect(strip) } : null,
    path: location.pathname,
  }
})())`

/** 「紧凑」展开行里那块内容：`aria-expanded=true` 的那个 tr 是**表头那一行**，内容在它下一个兄弟里。 */
const EXPANDED_ROW = `document.querySelector('tbody tr td[colspan]')?.closest('tr')`

// ── 取景与渲染 ────────────────────────────────────────────────────────────
let shotSeq = 0
async function shot(name) {
  shotSeq += 1
  const png = await send('Page.captureScreenshot', { format: 'png' })
  const bytes = Buffer.from(png.result.data, 'base64')
  const file = `${SHOT_DIR}/${String(shotSeq).padStart(2, '0')}-${name}.png`
  writeFileSync(file, bytes)
  if (bytes.length < 12_000) console.log(`⚠ ${file} 只有 ${Math.round(bytes.length / 1024)}KB，八成是空白图`)
  return file
}

/** 渲染一档并等到「内容出来 + 字体落定 + 数字不是动画中间态」。 */
async function render(cfg, tag, { w = 1440, h = 1200, mobile = false, path = '/' } = {}) {
  // ★配置桩必须自己答（别去问上游 hub）：新的主题根本没装在那台 hub 上 → 回 `{}`，
  //   桩里设的 cardStyle / serverNotes 一个字不生效，整轮判据会全落在默认档上（踩过）。
  themeConfig = cfg
  await fetch(`http://127.0.0.1:${PORT}/__reset`)
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}${path}?s=${encodeURIComponent(tag)}` })
  // 详情页没有卡片，判据换成「规格格出来了 + 字体落定」——不然会按卡片那套一路等到 40 秒超时。
  const ready = path.startsWith('/node')
    ? `(() => !!document.querySelector('dl') && (!document.fonts || document.fonts.status === 'loaded'))()`
    : `(() => {
        const cs = document.querySelectorAll('[data-slot="card"]')
        if (cs.length < 2 || !document.fonts || document.fonts.status !== 'loaded') return false
        const t = [...document.querySelectorAll('.tnum')].map((e) => e.textContent.trim())
        return t.length > 0 && !t.some((x) => !x) && !t.some((x) => /[#&@!*^~]/.test(x))
      })()`
  const ok = await waitFor(ready)
  await sleep(600)
  return ok
}
const json = async (expr) => {
  const raw = await evalJS(expr)
  if (!raw) return { missing: true }
  // 页面侧多套一层 JSON.stringify 时解出来是字符串而不是对象：兜一层，别让字段全是 undefined。
  const once = JSON.parse(raw)
  return typeof once === 'string' ? JSON.parse(once) : once
}
/** 探针拿不到那张卡片时别继续读字段，直接报清楚。 */
const card = async (name) => {
  const got = await json(CARD_PROBE(name))
  if (got.missing) throw new Error(`页面上找不到「${name}」这张卡片：${JSON.stringify(got)}`)
  return got
}
const hover = async (x, y) => { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }); await sleep(400) }

/* ────────────────── ① 经典：右上角常驻浮层（备注也在里面） ────────────────── */
console.log('\n── 经典档：右上角常驻信息图标，点开是 在线时间/价格/到期（+备注） ──')
{
  remark = ''
  await render({ cardStyle: 'classic' }, 'classic-base')
  const base = await card('节点一')
  const basePop = await json(POPOVER_PROBE(CARD('节点一')))
  check('经典（没写备注）：右上角那枚控件照样在（原生 button、默认收起）',
    basePop.btn?.tag === 'BUTTON' && basePop.btn?.expanded === 'false' && basePop.panel === null, JSON.stringify(basePop.btn))
  check('经典（没写备注）：标题行上没有备注元素（备注只在浮层里）', base.note === false && base.tags.length === 0, JSON.stringify(base.tags))
  check('经典（没写备注）：控件贴在卡片右上角、且在读数格之上',
    basePop.btn !== null && Math.abs(base.cardRight - basePop.btn.r - 16) <= 3 && basePop.btn.mid < base.cardTop + base.gridTop,
    `卡右 ${base.cardRight} / 控件右 ${basePop.btn?.r} / 控件中线 ${basePop.btn?.mid} vs 读数格上沿 ${base.cardTop + base.gridTop}`)

  // 点开：没有备注时就是那三项，没有备注那一排
  // 控件不在时（实现被弄坏/被判据打回）别让整轮崩在这儿：跳过悬停，让下面几条自己报 FAIL。
  if (basePop.btn) await hover(basePop.btn.x + basePop.btn.w / 2, basePop.btn.mid)
  const bOpen = await json(POPOVER_PROBE(CARD('节点一')))
  const bt = bOpen.panel?.text ?? ''
  check('经典（没写备注）：浮层里是在线时间 / 价格 / 到期（与「详细」档同一口径）',
    /在线 /.test(bt) && bt.includes('¥12.50 / 月付') && bt.includes('剩余 95 天'), bt)
  check('经典（没写备注）：浮层里没有备注那一排', (bOpen.panel?.tags ?? []).length === 0, JSON.stringify(bOpen.panel?.tags))
  await shot('classic-popover-noremark-1440')
  await hover(4, 4)

  remark = SHORT
  await render({ cardStyle: 'classic' }, 'classic-note')
  const on = await card('节点一')
  const onPop = await json(POPOVER_PROBE(CARD('节点一')))
  check('经典（写了备注）：标题行上仍然没有备注元素（备注进浮层，不在卡面）', on.note === false && on.tags.length === 0, JSON.stringify(on.tags))
  check('经典（写了备注）：卡片几何与没写备注时逐像素相同（浮层不占位）',
    on.cardH === base.cardH && on.rowH === base.rowH && on.gridTop === base.gridTop,
    `高 ${on.cardH}/${base.cardH} 行 ${on.rowH}/${base.rowH} 格上沿 ${on.gridTop}/${base.gridTop}`)
  if (onPop.btn) await hover(onPop.btn.x + onPop.btn.w / 2, onPop.btn.mid)
  const oOpen = await json(POPOVER_PROBE(CARD('节点一')))
  const ot = oOpen.panel?.text ?? ''
  check('经典（写了备注）：浮层里多出备注那三枚小卡片（逐枚同序）',
    SAME(oOpen.panel?.tags, tagsOf(SHORT)), JSON.stringify(oOpen.panel?.tags))
  check('经典（写了备注）：备注与在线时间/价格/到期同在（三项没被挤走）',
    /在线 /.test(ot) && ot.includes('¥12.50 / 月付') && ot.includes('剩余 95 天'), ot)
  await shot('classic-popover-remark-1440')
  await hover(4, 4)
}

/* ────────────────────────────── ② 简约档 ────────────────────────────── */
console.log('\n── 简约档：按站长口径不挂备注，也不挂那枚图标 ──')
{
  remark = ''
  await render({ cardStyle: 'plain' }, 'plain-base')
  const base = await card('节点一')
  remark = LONG
  await render({ cardStyle: 'plain' }, 'plain-note')
  const on = await card('节点一')
  check('简约：写了备注也不渲染备注元素、也没有那枚图标（保持原样）',
    on.note === false && on.tags.length === 0 && on.popover === false, JSON.stringify({ note: on.note, popover: on.popover }))
  check('简约：卡片几何与没写备注时逐像素相同',
    on.cardH === base.cardH && on.rowH === base.rowH && on.gridTop === base.gridTop,
    `高 ${on.cardH}/${base.cardH} 行 ${on.rowH}/${base.rowH} 格上沿 ${on.gridTop}/${base.gridTop}`)
  check('简约：正文里没有混进备注文字', !on.text.includes(LONG.slice(0, 12)), on.text.slice(0, 120))
}

/* ────────────────────────────── ③ 详细档 ────────────────────────────── */
console.log('\n── 详细档：备注在标题行右端（不挂浮层图标） ──')
let detailedBase = null
{
  remark = ''
  await render({ cardStyle: 'detailed' }, 'detailed-base')
  detailedBase = await card('节点一')
  check('详细（没写备注）：标题行上没有备注元素（零占位）、也没有那枚图标',
    detailedBase.note === false && detailedBase.tags.length === 0 && detailedBase.popover === false, JSON.stringify(detailedBase.tags))

  remark = SHORT
  await render({ cardStyle: 'detailed' }, 'detailed-note')
  const on = await card('节点一')
  check('详细（写了备注）：标题行右端三枚小卡片逐枚同序',
    SAME(on.tags, tagsOf(SHORT)), JSON.stringify(on.tags))
  check('详细（写了备注）：每枚都挂着整枚的 title（截断时悬停可看全）', SAME(on.tagTitles, tagsOf(SHORT)), JSON.stringify(on.tagTitles))
  check('详细（写了备注）：卡片总高 / 标题行高 / 读数格上沿与没写备注时逐像素相同（不重排、不加高）',
    on.cardH === detailedBase.cardH && on.rowH === detailedBase.rowH && on.gridTop === detailedBase.gridTop,
    `高 ${on.cardH}/${detailedBase.cardH} 行 ${on.rowH}/${detailedBase.rowH} 格上沿 ${on.gridTop}/${detailedBase.gridTop}`)
  check('详细（写了备注）：三枚读数盒照旧', on.boxes === 3, `盒 ${on.boxes}`)
  check('详细（写了备注）：第二行仍是「在线时长 / 价格」（备注没把它顶掉）',
    /^在线 /.test(on.row2 ?? '') && /¥12\.50 \/ 月付/.test(on.row2 ?? ''), on.row2)
  check('详细（写了备注）：第三枚读数盒下面**仍是到期日**（不是价格）',
    Array.isArray(on.box3) && on.box3[0] === '剩余 95 天' && on.box3[1] === '2027-01-01', (on.box3 ?? []).join(' | '))
  check('详细（写了备注）：备注在卡片上只出现一处，且没有那枚浮层图标',
    on.noteAnchors === 1 && on.badges === tagsOf(SHORT).length && on.popover === false,
    `锚点 ${on.noteAnchors} / 胶囊 ${on.badges} / 图标 ${on.popover}`)
  await shot('detailed-remark-1440')

  // 100 字一枚：标题行放不下就截断，整枚仍挂在 title 上
  remark = LONG
  await render({ cardStyle: 'detailed' }, 'detailed-long')
  const long = await card('节点一')
  check('详细（100 字一枚）：被截断，但整枚挂在 title 上、卡片没被撑高',
    long.tags.length === 1 && long.tagClipped[0] === true && long.tagTitles[0] === LONG && long.cardH === detailedBase.cardH,
    `枚 ${long.tags.length} / 截断 ${long.tagClipped[0]} / 高 ${long.cardH}/${detailedBase.cardH}`)
  check('详细（100 字一枚）：没有横向溢出', long.overflowX === false, `溢出 ${long.overflowX}`)

  // 手机 + 长名字：开备注不许让名字变短
  const LONG_NAME = 'Node Alpha Long Name'
  const rename = () => evalJS(`(() => { const c = ${CARD('节点一')}; const h = c && c.querySelector('h3'); if (!h) return false; h.textContent = ${JSON.stringify(LONG_NAME)}; return true })()`)
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1400, deviceScaleFactor: 1, mobile: true })
  remark = ''
  await render({ cardStyle: 'detailed' }, 'detailed-longname-base', { w: 390, h: 1400, mobile: true })
  await rename(); await sleep(150)
  const nb = await card(LONG_NAME)
  remark = LONG
  await render({ cardStyle: 'detailed' }, 'detailed-longname-note', { w: 390, h: 1400, mobile: true })
  await rename(); await sleep(150)
  const nn = await card(LONG_NAME)
  check('详细（手机 390 + 长名字）：开备注后名字没被挤短（宽度差 ≤1px、截断状态相同）',
    (nb.nameBox?.w ?? 0) > 0 && Math.abs((nb.nameBox?.w ?? 0) - (nn.nameBox?.w ?? 0)) <= 1 && nb.nameClipped === nn.nameClipped,
    `关 ${nb.nameBox?.w}px/截 ${nb.nameClipped} vs 开 ${nn.nameBox?.w}px/截 ${nn.nameClipped}`)
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false })
}

/* ────────────────────────────── ④ 延迟档 ────────────────────────────── */
console.log('\n── 延迟档：右上角常驻浮层（与经典同一套） ──')
{
  remark = ''
  await render({ cardStyle: 'latency' }, 'latency-base')
  const base = await card('节点一')
  const basePop = await json(POPOVER_PROBE(CARD('节点一')))
  check('延迟（没写备注）：那枚控件照样在（常驻，不是「有备注才有」）',
    basePop.btn?.tag === 'BUTTON' && base.popover === true, JSON.stringify(basePop.btn))
  check('延迟（没写备注）：卡片正文里没有备注文字、标题行上也没有备注元素',
    base.note === false && base.tags.length === 0, JSON.stringify(base.tags))

  remark = SHORT
  await render({ cardStyle: 'latency' }, 'latency-note')
  const on = await card('节点一')
  const onPop = await json(POPOVER_PROBE(CARD('节点一')))
  check('延迟（写了备注）：卡片几何与没写备注时逐像素相同（浮层与控件都不占位）',
    on.cardH === base.cardH && on.rowH === base.rowH && on.gridTop === base.gridTop,
    `高 ${on.cardH}/${base.cardH} 行 ${on.rowH}/${base.rowH} 格上沿 ${on.gridTop}/${base.gridTop}`)
  check('延迟（写了备注）：卡片正文里没有备注文字（只在浮层里）',
    !on.text.includes('三网优化') && on.note === false, on.text.slice(0, 120))
  check('延迟（写了备注）：控件贴在卡片右上角、且在读数格之上',
    onPop.btn !== null && Math.abs(on.cardRight - onPop.btn.r - 16) <= 3 && onPop.btn.mid < on.cardTop + on.gridTop,
    `卡右 ${on.cardRight} / 控件右 ${onPop.btn?.r} / 控件中线 ${onPop.btn?.mid} vs 读数格上沿 ${on.cardTop + on.gridTop}`)

  if (onPop.btn) await hover(onPop.btn.x + onPop.btn.w / 2, onPop.btn.mid)
  const hov = await json(POPOVER_PROBE(CARD('节点一')))
  check('延迟（写了备注）：悬停即弹出（aria-expanded=true，浮层渲染出来）',
    hov.btn?.expanded === 'true' && hov.panel !== null, JSON.stringify(hov.btn))
  const t = hov.panel?.text ?? ''
  check('延迟（写了备注）：浮层里三枚小卡片都在（逐枚同序）', SAME(hov.panel?.tags, tagsOf(SHORT)), JSON.stringify(hov.panel?.tags))
  check('延迟（写了备注）：浮层里另有在线时间 / 价格 / 到期（这三样没被备注挤走）',
    /在线 /.test(t) && t.includes('¥12.50 / 月付') && t.includes('剩余 95 天'), t)
  check('延迟（写了备注）：悬停不会跳详情页（仍在列表页）', hov.path === '/', hov.path)
  await shot('latency-popover-1440')

  // 手机没有悬停，点击是唯一入口；且点它不许连带打开详情页（卡片自己是 role=button）。
  // ★先把鼠标挪开：悬停那一步刚把浮层打开，指针还停在控件上时再点一下是「收起」。
  await hover(4, 4)
  const clickedPath = await evalJS(`(() => { const c = ${CARD('节点一')}; const b = c && c.querySelector('[data-note-popover]'); if (!b) return 'no-btn'; b.click(); return location.pathname })()`)
  await sleep(300)
  const clicked = await json(POPOVER_PROBE(CARD('节点一')))
  check('延迟（写了备注）：点一下就开（手机端的唯一入口）',
    clicked.panel !== null && clicked.btn?.expanded === 'true', JSON.stringify(clicked.btn))
  check('延迟（写了备注）：点这枚控件不会打开详情页', clickedPath === '/' && clicked.path === '/', `点击那一刻 ${clickedPath} / 复测 ${clicked.path}`)
  const esc = await evalJS(`(() => { const c = ${CARD('节点一')}; const b = c && c.querySelector('[data-note-popover]'); if (!b) return 'no-btn'; b.focus(); b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return location.pathname })()`)
  await sleep(300)
  const afterEsc = await json(POPOVER_PROBE(CARD('节点一')))
  check('延迟（写了备注）：Escape 收起、且不跳详情页', afterEsc.panel === null && esc === '/', `浮层 ${afterEsc.panel ? '在' : '不在'} / ${esc}`)
  // 对照组：同样的 Enter 打在卡片本体上确实会跳详情页（证明上面那条「不跳页」不是恒真）。
  const cardEnter = await evalJS(`(() => { const c = ${CARD('节点一')}; if (!c) return 'no-card'; c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return location.pathname })()`)
  await sleep(400)
  check('延迟（写了备注）：对照组——同样的 Enter 打在卡片本体上确实会跳详情页（判据不是恒真）',
    typeof cardEnter === 'string' && cardEnter.startsWith('/node'), `卡片上 ${cardEnter}`)
}

/* ────────────────────────────── ⑤ 紧凑档 ────────────────────────────── */
console.log('\n── 紧凑档：展开行量程栏右端并排（手机收成图标 + 浮层） ──')
const expandFirstRow = () => evalJS(`(() => { const r = document.querySelector('tbody tr[role=button]'); if (!r) return false; r.click(); return true })()`)
{
  remark = ''
  await render({ cardStyle: 'compact' }, 'compact-base', { h: 1400 })
  await expandFirstRow()
  await sleep(2500)
  const base = await json(`(() => { const tr = ${EXPANDED_ROW}; return JSON.stringify({ expanded: !!tr, h: tr ? Math.round(tr.getBoundingClientRect().height) : null }) })()`)
  const basePop = await json(POPOVER_PROBE(EXPANDED_ROW))
  check('紧凑（没写备注）：展开行里没有备注位', base.expanded === true && basePop.strip === null && basePop.btn === null, JSON.stringify(basePop.strip))

  remark = MANY
  await render({ cardStyle: 'compact' }, 'compact-note', { h: 1400 })
  await expandFirstRow()
  await sleep(2500)
  const pop = await json(POPOVER_PROBE(EXPANDED_ROW))
  const expandedH = await json(`(() => { const tr = ${EXPANDED_ROW}; return JSON.stringify({ h: tr ? Math.round(tr.getBoundingClientRect().height) : null }) })()`)
  check('紧凑（写了备注）：展开行桌面（≥sm）并排显示六枚小卡片（逐枚同序，放不下时逐枚截断）',
    SAME(pop.strip?.tags, tagsOf(MANY)) && (pop.strip?.clipped ?? []).some(Boolean), JSON.stringify(pop.strip))
  check('紧凑（写了备注）：手机那枚图标在 DOM 里（桌面被隐藏，同一处两套呈现）', pop.btn?.tag === 'BUTTON', JSON.stringify(pop.btn))
  check('紧凑（写了备注）：不新增行高（展开行高度与没写备注时相同，±2px）',
    expandedH.h !== null && base.h !== null && Math.abs(expandedH.h - base.h) <= 2, `开 ${expandedH.h} / 关 ${base.h}`)
  await shot('compact-remark-1440')

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1400, deviceScaleFactor: 1, mobile: true })
  await render({ cardStyle: 'compact' }, 'compact-note-mobile', { w: 390, h: 1400, mobile: true })
  await expandFirstRow()
  await sleep(2500)
  const mClosed = await json(POPOVER_PROBE(EXPANDED_ROW))
  const mVisible = await evalJS(`(() => { const s = document.querySelector('[data-note-popover]'); if (!s) return null; const b = s.getBoundingClientRect(); return b.width > 0 && getComputedStyle(s).display !== 'none' })()`)
  await evalJS(`(() => { const b = document.querySelector('[data-note-popover]'); if (b) b.click(); return true })()`)
  await sleep(300)
  const mOpen = await json(POPOVER_PROBE(EXPANDED_ROW))
  check('紧凑（手机 390）：桌面那条长文字收起来了，换成可见的一枚图标', mClosed.strip !== null && mVisible === true,
    JSON.stringify({ strip: mClosed.strip?.tags?.length, visible: mVisible }))
  check('紧凑（手机 390）：点开浮层，六枚小卡片都在（逐枚同序）', SAME(mOpen.panel?.tags, tagsOf(MANY)), JSON.stringify(mOpen.panel?.tags))
  check('紧凑（手机 390）：无横向溢出', (await evalJS('document.documentElement.scrollWidth > document.documentElement.clientWidth')) === false, '')
  await shot('compact-remark-390')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false })
}

/* ────────────────────── ⑥ 整页详情：不摊备注（站长口径） ────────────────── */
console.log('\n── 整页详情：不显示备注（备注只在列表卡片与紧凑展开那格） ──')
{
  remark = SHORT
  await render({ cardStyle: 'plain' }, 'detail-note', { path: '/node/1' })
  const on = await json(`JSON.stringify((() => ({
    page: document.querySelectorAll('[data-public-remark]').length,
    icons: document.querySelectorAll('[data-note-popover]').length,
    hasTags: document.body.querySelectorAll('[data-slot="badge"]').length,
    mentions: /三网优化|CN2 GIA/.test(document.body.innerText),
    tabs: /1 小时/.test(document.body.innerText),
  }))())`)
  check('整页详情（写了备注）：那一页**一个备注元素都没有**（备注块与图标都不挂）',
    on.page === 0 && on.icons === 0, JSON.stringify(on))
  check('整页详情（写了备注）：正文里也没有备注文字', on.mentions === false && on.hasTags === 0, JSON.stringify(on))
  check('整页详情：规格与量程照旧渲染出来', on.tabs === true, '')
  await shot('detail-page-1440')
}

/* ─────────────────── ⑦ 两个来源：主题设置优先，hub 兜底 ─────────────────── */
console.log('\n── 备注来源：主题设置里写了的优先，没写的用 hub 的公开备注 ──')
{
  remark = SHORT
  // ① 主题设置里写了这台 → 用它，hub 那条不出现
  await render({ cardStyle: 'detailed', serverNotes: '节点一=主题设置里的备注' }, 'src-theme-wins')
  const own = await card('节点一')
  check('主题设置里写了这台 → 用它（hub 那条让位）',
    SAME(own.tags, ['主题设置里的备注']) && !own.text.includes('CN2 GIA'), JSON.stringify(own.tags))
  // ② 主题设置里只写了别的机器 → 这台用 hub 的
  await render({ cardStyle: 'detailed', serverNotes: '节点二=别的机器的备注' }, 'src-hub-fallback')
  const fallback = await card('节点一')
  check('主题设置里没写这台 → 用 hub 的公开备注（三枚）',
    SAME(fallback.tags, tagsOf(SHORT)), JSON.stringify(fallback.tags))
  // ③ 两边都有 → 主题设置优先
  await render({ cardStyle: 'detailed', serverNotes: '节点一=覆盖用的备注,第二枚' }, 'src-both')
  const both = await card('节点一')
  check('两边都有 → 主题设置优先（两枚都来自主题设置）',
    SAME(both.tags, ['覆盖用的备注', '第二枚']), JSON.stringify(both.tags))
  // ④ 主题设置里写成空值 → 仍用 hub 的（「没在这里写」）
  await render({ cardStyle: 'detailed', serverNotes: '节点一=' }, 'src-empty')
  const empty = await card('节点一')
  check('主题设置里写成空值 → 仍用 hub 的公开备注',
    SAME(empty.tags, tagsOf(SHORT)), JSON.stringify(empty.tags))
  // ⑤ 老 hub（没有 public_remark）+ 主题设置里写了 → 照样显示
  remark = ''
  await render({ cardStyle: 'detailed', serverNotes: '节点一=老 hub 上的备注' }, 'src-oldhub')
  const oldHub = await card('节点一')
  check('老 hub（没有公开备注字段）+ 主题设置里写了 → 照样显示',
    SAME(oldHub.tags, ['老 hub 上的备注']), JSON.stringify(oldHub.tags))
  // ⑥ 两边都没有 → 零占位
  await render({ cardStyle: 'detailed', serverNotes: '' }, 'src-none')
  const none = await card('节点一')
  check('两边都没有 → 详细档零占位', none.note === false && none.tags.length === 0, JSON.stringify(none.tags))
  remark = SHORT
}

/* ────────────────────── ⑧ 时间范围按保留天数生成 ────────────────────── */
console.log('\n── 时间范围：按 hub 的 history_days 生成 ──')
const PILLS = `JSON.stringify([...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => /小时$|天$/.test(t)))`
const clickPill = (label) => evalJS(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return 'no-pill'; b.click(); return 'ok' })()`)
const hoursRequested = async () => {
  const { metricHits } = await (await fetch(`http://127.0.0.1:${PORT}/__hits`)).json()
  return metricHits.map((q) => Number(new URLSearchParams(q).get('hours')))
}
{
  // 老 hub（没有 history_days）：与 1.15.x 那排逐字相同，最长 168 小时。
  delete meExtra.history_days
  remark = SHORT
  await render({ cardStyle: 'plain' }, 'range-old', { path: '/node/1' })
  const pills = await json(PILLS)
  check('老 hub（没有 history_days）：量程仍是 1 / 6 / 24 小时 + 7 天',
    SAME(pills, ['1 小时', '6 小时', '24 小时', '7 天']), JSON.stringify(pills))
  await clickPill('7 天')
  await sleep(1200)
  check('老 hub：点「7 天」发出的确实是 hours=168 的请求（机制断言）',
    (await hoursRequested()).includes(168), JSON.stringify(await hoursRequested()))

  // 新 hub 默认保留 30 天：多出一枚「30 天」，点它发 hours=720。
  meExtra = { history_days: 30 }
  await render({ cardStyle: 'plain' }, 'range-30', { path: '/node/1' })
  const pills30 = await json(PILLS)
  check('保留 30 天：量程变成 1 / 6 / 24 小时 + 7 天 + 30 天',
    SAME(pills30, ['1 小时', '6 小时', '24 小时', '7 天', '30 天']), JSON.stringify(pills30))
  await clickPill('30 天')
  await sleep(1500)
  const hits = await hoursRequested()
  check('保留 30 天：点「30 天」发出的确实是 hours=720 的请求（机制断言）', hits.includes(720), JSON.stringify(hits))
  await shot('detail-range-30d-1440')

  // 短保留：不给出一枚超上限的窗口（hub 会对超上限的 hours 静默收窄，图与按钮上的字就对不上了）。
  meExtra = { history_days: 3 }
  await render({ cardStyle: 'plain' }, 'range-3', { path: '/node/1' })
  const pills3 = await json(PILLS)
  check('保留 3 天：量程收成 1 / 6 / 24 小时 + 3 天，没有 7 天',
    SAME(pills3, ['1 小时', '6 小时', '24 小时', '3 天']), JSON.stringify(pills3))

  // 上限：365 天那一档不能让阶梯崩掉（刻度数仍是几条，见 format.ts 的 TICK_STEPS）。
  meExtra = { history_days: 365 }
  await render({ cardStyle: 'plain' }, 'range-365', { path: '/node/1' })
  const pills365 = await json(PILLS)
  check('保留 365 天：量程是 1 / 6 / 24 小时 + 7 天 + 30 天 + 365 天（最多六枚，一行放得下）',
    SAME(pills365, ['1 小时', '6 小时', '24 小时', '7 天', '30 天', '365 天']), JSON.stringify(pills365))
  await clickPill('365 天')
  await sleep(1800)
  // 详情页有四张资源图，每张各有自己的 x 轴 —— 刻度会重复四遍，所以判据取**去重后**的条数。
  const ticks = (await json(`JSON.stringify([...document.querySelectorAll('.recharts-xAxis-tick-labels text')].map((t) => t.textContent.trim()))`)) || []
  const uniq = [...new Set(ticks)]
  check('保留 365 天：x 轴刻度去重后仍是稀疏的几条（不是每张 52 条糊成一片），且只写到日',
    uniq.length >= 3 && uniq.length <= 12 && uniq.every((t) => /^[0-9]{2}\/[0-9]{2}$/.test(t)) && ticks.length <= uniq.length * 4,
    `共 ${ticks.length} 条 / 去重 ${uniq.length} 条：${JSON.stringify(uniq)}`)
  await shot('detail-range-365d-1440')
  delete meExtra.history_days
}

/* ────────────────────────────── ⑨ 收尾 ────────────────────────────────── */
console.log('\n── 收尾 ──')
check('全程没有控制台异常', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' / '))

ws.close(); chrome.kill(); server.close()
console.log(`\n${pass} PASS / ${fail} FAIL　（截图在 ${SHOT_DIR}/）`)
process.exit(fail ? 1 : 0)

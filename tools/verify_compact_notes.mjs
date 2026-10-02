// 紧凑形态「展开的延迟栏」里那枚备注图标的护栏。
//   跑法：node tools/verify_compact_notes.mjs [端口]
// 自带静态伺服（本机 dist + 桩 /api，未知路径回落入口 HTML）—— 与 verify_card_styles.mjs 同一套路子。
// ★别改成「CDP 拦 *api/*」：那样会把顶栏那个 `/chicken/api/nodes` 探测也拦进来，
//   而它期待的是 `{nodes:[…]}`，喂错形状整页当场崩（症状是页面上只剩一行 TypeError 文案）。
// 判据核心两条：① 没有备注时那一行与改动前逐像素相同；② 有备注时不摊开也逐像素相同（零占位），
// 摊开只多出那枚浮层（绝对定位、不占布局），点外 / Esc 都能收起。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = Number(process.argv[2] || 5440)
const SHOT_DIR = 'shots/compact-notes'
const CDP_PORT = PORT + 4400
mkdirSync(SHOT_DIR, { recursive: true })

const GB = 1024 ** 3
const NODES = [
  {
    id: 1, name: '节点一', sort: 1, public: true, online: true, country: 'JP', group: '',
    last_seen: Math.floor(Date.now() / 1000) - 5,
    metrics: {
      cpu: 13, mem_used: 1 * GB, swap_used: 0, disk_used: 10 * GB, net_rx: 0, net_tx: 0,
      net_rx_total: 12 * GB, net_tx_total: 6 * GB, month_rx: 8 * GB, month_tx: 4 * GB, tcp: 10, udp: 2, procs: 100,
    },
    os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'Xeon', cpu_cores: 2,
    mem_total: 2 * GB, swap_total: 0, disk_total: 40 * GB, agent_version: '1.3.0',
    price: 12.5, currency: 'CNY', billing_cycle: 'monthly', expires_at: '2027-01-01', expires_in: 95,
  },
  {
    id: 2, name: '节点二', sort: 2, public: true, online: true, country: 'US', group: '',
    last_seen: Math.floor(Date.now() / 1000) - 3, metrics: null, os: '', kernel: '', arch: '', virt: '',
    cpu_name: '', cpu_cores: 1, mem_total: 1 * GB, swap_total: 0, disk_total: 20 * GB, agent_version: '1.3.0',
    price: 0, currency: 'USD', billing_cycle: '', expires_at: null, expires_in: null,
  },
]
const PROBES = { 11: '北京电信', 12: '上海电信', 13: '广州电信' }
const pingPoints = (taskId, base) => Array.from({ length: 90 }, (_, i) => {
  const t = Math.floor(Date.now() / 1000) - (90 - i) * 240
  return { task_id: taskId, ts: t, latency: Math.round(base + Math.sin(i) * 6), band: [base - 10, base + 10], loss: 0 }
})
const PING = {
  ping: [...pingPoints(11, 42), ...pingPoints(12, 88), ...pingPoints(13, 130)],
  probes: PROBES,
  loss: { 11: 0, 12: 1.2, 13: 0 },
}

let config = {}
const apiHits = []
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' }
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  if (path.startsWith('/api/')) {
    apiHits.push(path)
    let body = {}
    if (path === '/api/me') body = { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '紧凑备注校验' }
    // ★形状是 `{nodes:[…]}` 而不是裸数组：App 那边是 `api<{nodes:Node[]}>('/nodes')`，
    // 喂裸数组会让 `safeNodes(undefined)` 当场 `.map` 崩掉（整页只剩一行 TypeError 文案）。
    else if (path === '/api/nodes') body = { nodes: NODES }
    else if (path.endsWith('/config')) body = config
    else if (path === '/api/version') body = { version: '1.3.0' }
    else if (/^\/api\/nodes\/\d+\/metrics/.test(path)) {
      // `metrics` 是**点数组**（列式对象会让详情页在 `.length` 上崩）；延迟序列用 PING。
      body = url.searchParams.get('series') === 'ping' ? PING : { metrics: [], ping: [], probes: PROBES, loss: {} }
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

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p)) || 'chrome'
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--no-proxy-server', `--user-data-dir=${join(tmpdir(), `compactnotes${CDP_PORT}`)}`,
  '--no-sandbox', 'about:blank'], { stdio: 'ignore' })

let target = null
for (let i = 0; i < 80 && !target; i++) {
  await sleep(300)
  try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page') } catch {}
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
  if (r?.exceptionDetails) {
    console.log('⚠ 页面侧异常：', r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  }
  return r?.result?.value
}
const waitFor = async (expr, timeout = 40000) => { const d = Date.now() + timeout; while (Date.now() < d) { if ((await evalJS(expr)) === true) return true; await sleep(250) } return false }
let pass = 0, fail = 0
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ' — ' + info : ''}`); ok ? pass++ : fail++ }

await new Promise((r) => ws.addEventListener('open', r))
await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })

/** 渲染紧凑形态并展开第一行（行本身是 role=button，点它就地摊开，不跳页）。 */
async function renderAndExpand(cfg, label, w = 1440, h = 1200) {
  config = { pingLines: '北京电信', ...cfg }
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  const table = await waitFor(`(() => { const rs = document.querySelectorAll('tbody tr[role=button]'); return rs.length >= 2 && document.fonts.status === 'loaded' })()`)
  await sleep(500)
  const opened = await evalJS(`(() => {
    const row = document.querySelector('tbody tr[role=button]')
    if (!row) return 'no-row'
    if (row.getAttribute('aria-expanded') !== 'true') row.click()
    return row.getAttribute('aria-expanded')
  })()`)
  const chart = await waitFor(`(() => {
    const row = document.querySelector('tbody tr[role=button]')
    const box = row && row.nextElementSibling ? row.nextElementSibling.querySelector('td > div') : null
    return !!box && !!box.querySelector('svg.recharts-surface')
  })()`, 40000)
  await sleep(600)
  return { label, table, opened, chart }
}

/** 展开区几何 + 图标/浮层状态。 */
const PROBE = `JSON.stringify((() => {
  const row = document.querySelector('tbody tr[role=button]')
  const panel = row ? row.nextElementSibling : null
  const box = panel ? panel.querySelector('td > div') : null
  if (!box) return { missing: true }
  const ranges = box.querySelector('div.flex.flex-wrap.items-center')
  const strip = box.querySelector('[data-note-strip]')
  const btn = box.querySelector('[data-note-popover]')
  const pop = box.querySelector('[data-note-panel]')
  const detail = [...box.querySelectorAll('button')].find((b) => /完整详情/.test(b.innerText))
  // 「可见」= 真的占版面。★别只看元素自己的 computed display —— 收在 sm:hidden 的**父级**里时，
  // 子元素自己的 display 仍是 inline-flex，会得出「PC 上那枚图标还在」的假红。用 getClientRects 数框。
  const vis = (el) => !!el && el.getClientRects().length > 0
  const rect = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) } }
  return {
    stripVisible: vis(strip),
    stripBox: vis(strip) ? rect(strip) : null,
    // ★这里只能放文本，不能放 DOM 元素：JSON.stringify 撞上 React 挂在元素上的 Fiber 会「循环结构」当场抛；
    // 而且这段注释本身写在模板字面量里 —— 里面连反引号都不能有（写一个就把字符串截断）。
    stripBadges: strip ? [...strip.querySelectorAll('[data-slot="badge"]')].map((b) => b.innerText.trim()) : [],
    stripBadgeWidths: strip ? [...strip.querySelectorAll('[data-slot="badge"]')].map((b) => Math.round(b.getBoundingClientRect().width)) : [],
    detailLeft: detail ? Math.round(detail.getBoundingClientRect().left) : null,
    detailVisible: vis(detail),
    iconVisible: vis(btn),
    panelVisible: vis(pop),
    boxH: Math.round(box.getBoundingClientRect().height),
    rangesH: ranges ? Math.round(ranges.getBoundingClientRect().height) : null,
    hasBtn: !!btn,
    hasStrip: !!strip,
    btnTag: btn ? btn.tagName : null,
    expanded: btn ? btn.getAttribute('aria-expanded') : null,
    hasPanel: !!pop,
    panelBox: pop ? rect(pop) : null,
    badges: pop ? [...pop.querySelectorAll('[data-slot="badge"]')].map((b) => b.innerText.trim()) : [],
    boxRight: Math.round(box.getBoundingClientRect().right),
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    btnLabel: btn ? (btn.getAttribute('aria-label') || '') : '',
  }
})())`

const first = await renderAndExpand({ cardStyle: 'compact' }, '无备注')
const none = JSON.parse(await evalJS(PROBE))
if (none.missing) {
  const diag = await evalJS(`JSON.stringify({ rows: document.querySelectorAll('tbody tr').length, text: (document.body.innerText || '').slice(0, 160) })`)
  console.log('❌ 展开区没渲染出来（夹具问题）', diag, '夹具:', JSON.stringify(first))
  console.log('   页面报错：', consoleErrors.slice(0, 3).join(' / '))
  process.exit(2)
}

/* ── 1) 没有备注：那一行与改动前一样（没有标签带、也没有那枚图标） ─────────────── */
check('无备注：展开区里既没有标签带、也没有那枚备注图标',
  none.hasStrip === false && none.hasBtn === false && none.hasPanel === false,
  JSON.stringify({ strip: none.hasStrip, btn: none.hasBtn }))

/* ── 2) PC（1440）：备注**直接并排显示**在「完整详情 ›」左边，且不新增行高 ────── */
const NOTES = '节点一=测试测试,222,333'
await renderAndExpand({ cardStyle: 'compact', serverNotes: NOTES }, '有备注·PC')
const desk = JSON.parse(await evalJS(PROBE))
check('PC：三枚备注直接显示（标签带可见，不是浮层）',
  desk.stripVisible === true && desk.stripBadges.join('|') === '测试测试|222|333',
  `可见 ${desk.stripVisible} / ${desk.stripBadges.join('|')}`)
check('PC：标签带排在「完整详情 ›」左边（右沿不越过它的左沿）',
  desk.stripBox !== null && desk.detailLeft !== null && desk.stripBox.r <= desk.detailLeft + 1,
  `标签带右 ${desk.stripBox?.r} / 完整详情左 ${desk.detailLeft}`)
check('PC：三枚宽度都够读出内容（没被压成一个字）',
  desk.stripBadgeWidths.length === 3 && desk.stripBadgeWidths.every((w) => w >= 28),
  JSON.stringify(desk.stripBadgeWidths))
check('PC：那枚手机用的图标在这档不显示（display:none）', desk.iconVisible === false, `可见 ${desk.iconVisible}`)
check('PC：展开区高度与无备注时逐像素相同（并排显示也不新增行高）',
  desk.boxH === none.boxH && desk.rangesH === none.rangesH, `高 ${desk.boxH}/${none.boxH} 量程行 ${desk.rangesH}/${none.rangesH}`)
check('PC：没有横向溢出', desk.overflowX === false, '')

/* ── 3) PC 六枚长备注：不撑高、不越界，「完整详情 ›」仍在 ─────────────────── */
await renderAndExpand({ cardStyle: 'compact', serverNotes: `节点一=${Array.from({ length: 6 }, (_, i) => `标签${i + 1}号`).join(',')}` }, '六枚')
const many = JSON.parse(await evalJS(PROBE))
check('PC（六枚）：展开区高度不变、不横向溢出', many.boxH === none.boxH && many.overflowX === false, `高 ${many.boxH}/${none.boxH}`)
check('PC（六枚）：标签带不越出卡片、「完整详情 ›」仍可见',
  many.stripBox !== null && many.stripBox.r <= many.detailLeft + 1 && many.detailVisible === true,
  `标签带右 ${many.stripBox?.r} / 完整详情左 ${many.detailLeft}`)

/* ── 4) 手机 390：那一行放不下，收成图标 + 浮层 ─────────────────────────── */
const r390 = await renderAndExpand({ cardStyle: 'compact', serverNotes: NOTES }, '手机', 390, 1200)
const mobClosed = JSON.parse(await evalJS(PROBE))
check('手机 390：标签带不显示、那枚图标显示（两套形态按断点分开）',
  mobClosed.stripVisible === false && mobClosed.iconVisible === true && mobClosed.btnTag === 'BUTTON',
  `标签带 ${mobClosed.stripVisible} / 图标 ${mobClosed.iconVisible}`)
check('手机 390：不摊开时展开区高度与无备注时相同',
  mobClosed.boxH === JSON.parse(await evalJS(PROBE)).boxH && mobClosed.rangesH === mobClosed.rangesH, `高 ${mobClosed.boxH}`)
await evalJS(`(() => { document.querySelector('tbody tr[role=button]').nextElementSibling.querySelector('[data-note-popover]').click(); return true })()`)
await sleep(400)
const mob = JSON.parse(await evalJS(PROBE))
check('手机 390：点得开、三枚都在、浮层不越出视口、无横向溢出',
  mob.panelVisible === true && mob.badges.length === 3 && mob.panelBox.x >= 0 && mob.panelBox.r <= 390 + 1 && mob.overflowX === false,
  `${mob.badges.join('|')} 浮层 ${mob.panelBox.x}~${mob.panelBox.r}`)
check('手机 390：摊开也不改展开区高度（浮层是绝对定位）', mob.boxH === mobClosed.boxH, `${mob.boxH}/${mobClosed.boxH}`)
{ const shot = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${SHOT_DIR}/mobile.png`, Buffer.from(shot.result.data, 'base64')) }

/* ── 5) 手机那枚图标的交互（零占位 / 点外 / Esc / 聚焦 / 不收起这一行） ───────────── */
check('手机 390：图标的 aria-label 带上全部备注（读屏可读）',
  /测试测试/.test(mob.btnLabel) && /333/.test(mob.btnLabel), mob.btnLabel)
check('手机 390：那枚图标是原生 button、能被聚焦', mob.btnTag === 'BUTTON' && mob.expanded === 'true',
  `${mob.btnTag} aria-expanded=${mob.expanded}`)
await evalJS(`(() => {
  const b = document.querySelector('tbody tr[role=button]').nextElementSibling.querySelector('[data-note-popover]')
  b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  return true
})()`)
await sleep(300)
const afterEsc = JSON.parse(await evalJS(PROBE))
check('手机 390：Esc 收起（且仍在列表页）',
  afterEsc.panelVisible === false && (await evalJS('location.pathname')) === '/', `panel=${afterEsc.panelVisible}`)
await evalJS(`(() => { document.querySelector('tbody tr[role=button]').nextElementSibling.querySelector('[data-note-popover]').click(); return true })()`)
await sleep(300)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 30, y: 700, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 30, y: 700, button: 'left', clickCount: 1 })
await sleep(300)
const afterOutside = JSON.parse(await evalJS(PROBE))
check('手机 390：点浮层外面收起，且展开区高度回到与无备注时相同',
  afterOutside.panelVisible === false && afterOutside.boxH === mobClosed.boxH, `panel=${afterOutside.panelVisible} 高 ${afterOutside.boxH}/${mobClosed.boxH}`)
await evalJS(`(() => { document.querySelector('tbody tr[role=button]').nextElementSibling.querySelector('[data-note-popover]').click(); return true })()`)
await sleep(300)
const still = await evalJS(`(() => {
  const row = document.querySelector('tbody tr[role=button]')
  return JSON.stringify({ rowExpanded: row.getAttribute('aria-expanded'), panel: row.nextElementSibling.querySelector('[data-note-panel]') !== null, path: location.pathname })
})()`)
{ const j = JSON.parse(still)
  check('手机 390：点那枚图标只摊浮层，不会把这一行收起来、也不跳页',
    j.rowExpanded === 'true' && j.panel === true && j.path === '/', still) }

/* ── 9) 整页详情也挂同一枚（同一组件、非 embedded 模式） ───────────────── */
config = { pingLines: '北京电信', cardStyle: 'compact', serverNotes: NOTES }
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/node/1` })
// 详情页默认落在「资源」页签、桩里那条序列是空的（没有图）——所以只等那枚图标，
// 别把「有图」也写进等待条件（否则这一条会假红）。
const detailOk = await waitFor(`(() => !!document.querySelector('[data-note-strip]'))()`, 40000)
const detailDiag = await evalJS(`(() => {
  const strip = document.querySelector('[data-note-strip]')
  return JSON.stringify({
    path: location.pathname,
    stripVisible: !!strip && getComputedStyle(strip).display !== 'none',
    texts: strip ? [...strip.querySelectorAll('[data-slot="badge"]')].map((b) => b.innerText.trim()) : [],
  })
})()`)
check('整页详情（/node/1）上备注同样直接显示（同一份清单、同一落点）',
  detailOk === true && JSON.parse(detailDiag).stripVisible === true && JSON.parse(detailDiag).texts.length === 3, `${detailDiag}`)

/* ── 10) 控制台无报错 ────────────────────────────────────────────────── */
check('整轮下来控制台 0 报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' / '))

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===`)
ws.close(); chrome.kill(); server.close()
process.exit(fail ? 1 : 0)

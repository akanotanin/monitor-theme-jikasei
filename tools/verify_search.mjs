// 顶栏搜索（名称 / 地区 / 系统）的验收：在不在顶栏右上角、能不能按三样东西筛出那几台、
// 概览卡片跟不跟着收窄、窄屏能不能收成一枚图标再展开、空态说没说清怎么取消。
//
// 用法：node tools/verify_search.mjs [baseUrl]
//   不给 baseUrl：本机起静态服务器伺服 dist/ + 桩 /api/*（六台夹具机器，判据只由代码决定）。
//   给了 baseUrl：直接打在真站上 —— 夹具那些「搜出几台」的断言跳过（真站上的机器不由这里决定），
//                 只验结构：在顶栏里、靠右、与邻座图标同高、占位没被裁、窄屏能展开、无横向溢出。
//
// 环境变量：
//   SHOT_DIR=<目录>   把几个关键机位连图存下来（桌面顶栏、搜出结果、窄屏展开、深色）。
//   SEARCH_WAIT_MS    每一步等页面安静的时长（默认 2500，经隧道打真站时给大些）。
//
// 判据都是「形状」：卡片数、卡片名字、概览里那两行字、元素的位置与可见性 —— 不认具体色值。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 5240
const BASE = (process.argv[2] || `http://127.0.0.1:${PORT}`).replace(/\/$/, '')
const REAL = !!process.argv[2]
const SETTLE = Number(process.env.SEARCH_WAIT_MS || 2500)
const SHOT_DIR = process.env.SHOT_DIR || ''
// 夹具配置钉死（技能第 44 条：判据只由代码决定，不取自那台 hub 上存的配置）。
// `listTop: "both"` = 分组标签 + 概览卡片·原版：「概览跟着搜索收窄」这一条才验得到。
const CONFIG = { cardStyle: 'plain', listTop: 'both' }
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2' }

// 六台，三处字段各不重样：名称、分组（中文城市）、国家码、系统，四条路都要能搜到。
const NODES = {
  nodes: [
    node(1, '东京一号', '东京', 'JP', 'Debian GNU/Linux 12 (bookworm)'),
    node(2, '东京二号', '东京', 'JP', 'Ubuntu 22.04.4 LTS'),
    node(3, '香港一号', '香港', 'HK', 'Ubuntu 22.04.4 LTS'),
    node(4, '法兰克福一号', '法兰克福', 'DE', 'Debian GNU/Linux 12 (bookworm)'),
    node(5, 'SG-Edge', '新加坡', 'SG', 'Alpine Linux 3.20'),
    node(6, 'US-Backup', '', 'US', 'Windows Server 2022'),
  ],
}
function node(id, name, group, country, os) {
  return {
    id, name, group, country, os, online: true, public: true, sort: id, country_pin: '',
    virt: 'vm', arch: 'x86_64', cpu_name: 'AMD EPYC Processor', cpu_cores: 1, kernel: '6.1.0-53-cloud-amd64', agent_version: '1.0.0',
    mem_total: 1020526592, swap_total: 0, disk_total: 10485864448, traffic_limit: 536870912000, traffic_mode: 'sum',
    billing_cycle: 'yearly', currency: 'CNY', price: 349, expires_at: '2027-07-21', expires_in: 299, month_start: '2026-09-21', traffic_reset_day: 21,
    day_rx: 2140585887, day_tx: 2191393745, month_rx: 4650258264, month_tx: 4351673970, total_rx: 5707805336, total_tx: 5203609923, last_seen: 1790311292,
    metrics: { cpu: 3, load: [0, 0, 0], mem_used: 431800320, mem_total: 1020526592, swap_used: 0, swap_total: 0, disk_used: 1524510720, disk_total: 10485864448, net_rx: 867, net_tx: 465, procs: 75, tcp: 16, udp: 3, uptime: 318521, month_rx: 4650258264, month_tx: 4351673970, total_rx: 5707805336, total_tx: 5203609923 },
  }
}

let configHits = 0
const serveFile = (res, path) => {
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] })
    return res.end(readFileSync('dist/index.html'))
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
}
const server = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  if (path.startsWith('/api/')) {
    if (path.endsWith('/config')) configHits++
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: BASE, site_name: '探针' }
      : path === '/api/nodes' ? NODES
        : path.endsWith('/config') ? CONFIG
          : path.includes('/metrics') ? { metrics: [], probes: [], loss: {} } : {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  serveFile(res, path)
})
if (!REAL) {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
  console.log(`dist/ 伺服在 ${BASE}/（夹具配置 ${JSON.stringify(CONFIG)}，六台机器）`)
} else {
  console.log(`直接打真站: ${BASE}（本机不伺服 dist；夹具那些「搜出几台」的断言跳过）`)
}

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p)) || 'chrome'
let chrome, dbgPort, wsUrl = null
for (let attempt = 0; attempt < 2 && !wsUrl; attempt++) {
  dbgPort = 9970 + Math.floor(Math.random() * 40)
  chrome?.kill()
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, '--remote-allow-origins=*',
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    ...(process.env.PROXY ? [`--proxy-server=${process.env.PROXY}`] : []),
    '--user-data-dir=' + (process.env.TEMP || process.env.LOCALAPPDATA || '/tmp') + '/searchcheck-' + dbgPort + '-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { }
    if (!wsUrl) await sleep(300)
  }
}
if (!wsUrl) throw new Error('Chrome 起不来：先看看是不是堆了太多测试实例（按 --user-data-dir 前缀清一遍）')

let id = 0
const pending = new Map()
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const errors = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.exception?.description || '异常')
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') errors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '))
}
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')

// 一次把所有要看的都量出来：位置/可见性、列表里那几张卡与它们的名字、概览里「节点」那块、
// 空态那两句话、以及「占位文案会不会被裁」（canvas 量同款字体的文本宽度 vs 框里可用宽度）。
const PROBE = `(() => {
  const q = (s) => document.querySelector(s)
  // ★量的是**外面的壳**：窄屏上藏起来的是那层 hidden sm:flex 的 span，
  //   而 <input> 自己的 computed display 永远是 inline-block（就算父级 display:none）——
  //   拿 input 的 display 判「有没有藏起来」会一直判成「露着」。
  const wideWrap = q('.search-field-wide')
  const input = q('.search-field-wide .search-input')
  const rowWrap = q('.search-row')
  const rowInput = q('.search-field-row .search-input')
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right),
      display: cs.display, visibility: cs.visibility, focused: el === document.activeElement, rendered: el.offsetParent !== null,
      title: el.getAttribute('title'), expanded: el.getAttribute('aria-expanded'), fontWeight: cs.fontWeight }
  }
  const cards = [...document.querySelectorAll('[data-card-style] > [data-slot="card"]')]
  let fleet = null
  for (const card of document.querySelectorAll('[data-slot="card"]')) {
    const lines = card.innerText.split('\\n').map((s) => s.trim()).filter(Boolean)
    if (lines[0] === '节点') { fleet = lines; break }
  }
  const notes = [...document.querySelectorAll('main p')].map((p) => p.innerText.replace(/\\s+/g, ' ').trim()).filter((t) => t.includes('——'))
  let placeholder = null
  if (input) {
    const cs = getComputedStyle(input)
    const ctx = document.createElement('canvas').getContext('2d')
    ctx.font = cs.font
    const textW = ctx.measureText(input.placeholder).width
    const avail = input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    placeholder = { text: input.placeholder, textW: Math.round(textW), avail: Math.round(avail), fits: textW <= avail }
  }
  const live = rowInput && rowInput.offsetParent !== null ? rowInput : input
  // 顶栏那一行有没有被挤爆：整行 scrollWidth 应该等于 clientWidth；站名那枚按钮不该被压到换行
  // （390px 上现在是站名 + 六枚按钮，多一枚就会顶到边）。
  const rowEl = q('header > div')
  const headerRow = rowEl ? { scrollW: rowEl.scrollWidth, clientW: rowEl.clientWidth } : null
  return JSON.stringify({
    input: box(input), wideWrap: box(wideWrap), toggle: box(q('.search-toggle')), row: box(rowWrap), rowInput: box(rowInput), clear: box(q('.search-clear')),
    header: box(q('header')), headerRow, siteName: box(q('header button')), main: box(q('main')), themeButton: box(q('header button[title="切换主题"]')),
    inputInHeader: !!(input && q('header').contains(input)), rowInHeader: !!(rowWrap && q('header').contains(rowWrap)),
    count: cards.length, names: cards.map((el) => (el.querySelector('h3')?.textContent || '').trim()),
    fleet, notes, placeholder, value: live ? live.value : null,
    overflow: document.documentElement.scrollWidth - innerWidth, viewport: { w: innerWidth, h: innerHeight },
  })
})()`

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }
const probe = async () => JSON.parse(await js(PROBE))
const settle = async () => {
  for (let i = 0; i < Math.ceil(SETTLE / 200) + 10; i++) {
    const ok = await js('!!document.querySelector(\'.search-input\') && document.fonts.status === "loaded" && !!document.querySelector(\'[data-card-style] > [data-slot="card"]\')')
    if (ok) break
    await sleep(200)
  }
  await sleep(400)
}
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true })
// CDP 的 clip 是**文档坐标**（见 verify_footer_credit.mjs 里那条实测），所以这里一律用
// 元素自己的 rect 换算成文档坐标再加滚动偏移。
const shot = async (name, sel, pad = 12) => {
  if (!SHOT_DIR) return
  const b = JSON.parse(await js(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return 'null'
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.x + scrollX) - ${pad}, y: Math.round(r.y + scrollY) - ${pad}, width: Math.round(r.width) + ${pad * 2}, height: Math.round(r.height) + ${pad * 2} })
  })()`))
  if (!b) return
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...b, scale: 2 } })
  if (r.result?.data) { writeFileSync(join(SHOT_DIR, `${name}.png`), Buffer.from(r.result.data, 'base64')); console.log(`    已拍 ${join(SHOT_DIR, `${name}.png`)}`) }
}
// 打字走 CDP：先 Ctrl+A 再 Delete（真实按键，React 的受控值才跟着变），再 insertText。
// ★两个输入框（桌面那格 + 窄屏那一行）同时在 DOM 里，藏起来的那个 offsetParent 为 null ——
//   焦点与点击都要落到**看得见的那个**上，不然 Ctrl+A 与 insertText 会打到一个 display:none 的框里。
const VISIBLE = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.offsetParent !== null)`
const type = async (text) => {
  await js(`(() => { const el = ${VISIBLE('.search-input')}; el?.focus(); return el === document.activeElement })()`)
  for (const key of [['a', 'KeyA', 65, 2], ['Delete', 'Delete', 46, 0]]) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: key[0], code: key[1], windowsVirtualKeyCode: key[2], modifiers: key[3] })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: key[0], code: key[1], windowsVirtualKeyCode: key[2], modifiers: key[3] })
  }
  if (text) await send('Input.insertText', { text })
  await sleep(250)
}
const clickVisible = (sel) => js(`${VISIBLE(sel)}?.click()`)
// 真按键（Esc 两段式那种要看 React 的 keydown）：keyDown + keyUp 成对发。
const key = async (k, code, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk })
  await sleep(200)
}
// 真鼠标（「点框外」那一条必须是真的点击，不然等于自己给自己出题）：
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(250)
}
const goto = async (path, { w, h, dark, mobile = false }) => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] })
  await send('Page.navigate', { url: `${BASE}${path}` })
  await settle()
  return probe()
}
// 夹具里的「搜这个词该剩几台」——一处写清，断言只比对着它。
const EXPECT = [
  ['东京', ['东京一号', '东京二号']],
  ['tokyo', ['东京一号', '东京二号']],
  ['日本', ['东京一号', '东京二号']],
  ['HK', ['香港一号']],
  ['新加坡', ['SG-Edge']],
  ['debian', ['东京一号', '法兰克福一号']],
  ['windows', ['US-Backup']],
  ['东京 ubuntu', ['东京二号']],
  ['us-backup', ['US-Backup']],
  ['zzz', []],
]

console.log('\n一、桌面 1440×900（亮色，六台夹具机器）:')
let m = await goto('/', { w: 1440, h: 900, dark: false })
console.log('   ' + JSON.stringify({ toggle: m.toggle, input: m.input, cards: m.count, fleet: m.fleet, vp: m.viewport }))
// 一、收起状态：顶栏里除了一枚放大镜，什么都不该有（输入框是点开之后才渲染的）。
check('收起时：顶栏里没有输入框（DOM 里就没渲染），只多一枚放大镜图标',
  m.input === null && m.wideWrap === null && !!m.toggle && m.toggle.rendered, `input=${JSON.stringify(m.input)} toggle=${JSON.stringify(m.toggle)}`)
check('收起时：那枚图标在顶栏右半边、36×36、与邻座图标同高、说明挂在 title 上',
  m.toggle.x > m.viewport.w / 2 && m.toggle.right <= m.header.right && m.toggle.w === 36 && m.toggle.h === 36
  && m.toggle.h === m.themeButton?.h && m.toggle.title === '搜索（名称 / 地区 / 系统）' && m.toggle.expanded === 'false',
  `rect=${JSON.stringify({ x: m.toggle.x, right: m.toggle.right, w: m.toggle.w, h: m.toggle.h })} title=${m.toggle.title} aria-expanded=${m.toggle.expanded}`)
// 点开：输入框就地长出来。
await clickVisible('.search-toggle')
const opened = await probe()
console.log('   点开后：' + JSON.stringify({ input: opened.input, toggle: opened.toggle, cards: opened.count }))
check('点一下图标：输入框就地长出来、焦点已在框里、在顶栏里（不是另开一行）',
  !!opened.input && opened.input.w > 0 && opened.input.focused && opened.inputInHeader,
  `input=${JSON.stringify(opened.input)}`)
check('输入框与旁边那排图标同高（都是 36）', opened.input?.h === 36 && opened.input?.h === opened.themeButton?.h,
  `输入框 ${opened.input?.h} / 明暗开关 ${opened.themeButton?.h}`)
check('输入框长在图标**左边**（长出来往左边借空间，不是把图标顶走）',
  !!opened.input && !!opened.toggle && opened.input.right <= opened.toggle.x && opened.toggle.x - opened.input.right <= 20,
  `输入框右沿=${opened.input?.right} 图标左沿=${opened.toggle?.x}`)
check('开合时那枚图标一枚都没动（同一处落点）', opened.toggle.x === m.toggle.x && opened.toggle.y === m.toggle.y,
  `收起 ${m.toggle.x},${m.toggle.y} → 展开 ${opened.toggle.x},${opened.toggle.y}`)
check('点开后图标变成「收起搜索」（同一个按钮管开合）',
  opened.toggle.title === '收起搜索' && opened.toggle.expanded === 'true', `title=${opened.toggle.title} aria-expanded=${opened.toggle.expanded}`)
check('展开后仍在顶栏右半边、占位文案没被裁',
  opened.input.x > opened.viewport.w / 2 && opened.input.right <= opened.header.right && !!opened.placeholder && opened.placeholder.fits,
  `input.x=${opened.input?.x}；文案 ${opened.placeholder?.textW}px / 可用 ${opened.placeholder?.avail}px`)
check('刚展开时没有清空按钮（没词可清）', opened.clear === null)
if (!REAL) {
  check('点开这一下没有筛掉任何东西：六台都在，概览「节点」6 / 6 · 全部在线',
    opened.count === 6 && opened.fleet?.[1] === '6 / 6' && opened.fleet?.[2] === '全部在线',
    `卡片 ${opened.count} 张；概览 ${JSON.stringify(opened.fleet)}`)
  await shot('desktop-open', 'header', 8)
  for (const [term, want] of EXPECT) {
    await type(term)
    const now = await probe()
    check(`搜「${term}」→ ${want.length ? want.join(' / ') : '一台都不剩'}`,
      now.count === want.length && JSON.stringify(now.names) === JSON.stringify(want),
      `卡片 ${now.count} 张：${JSON.stringify(now.names)}`)
    if (want.length) {
      check(`搜「${term}」时概览跟着收窄（${want.length} / ${want.length}）`, now.fleet?.[1] === `${want.length} / ${want.length}`, `概览 ${JSON.stringify(now.fleet)}`)
    } else {
      check('搜不到时：说清了怎么取消（空态文案带原词、且提到 ×）',
        now.notes.length === 1 && now.notes[0].includes('zzz') && now.notes[0].includes('×'), JSON.stringify(now.notes))
      check('搜不到时概览底行写「没有匹配的节点」（不是「还没有节点」）', now.fleet?.[2] === '没有匹配的节点', `概览 ${JSON.stringify(now.fleet)}`)
      await shot('desktop-empty', 'main', 8)
    }
    if (term === '东京') await shot('desktop-hit', 'main [data-card-style]', 8)
  }
  // 清空：点输入框右边那个 ×
  await type('东京')
  await clickVisible(".search-clear")
  await sleep(250)
  const cleared = await probe()
  check('点清空：回到六台、概览回 6 / 6、清空按钮消失',
    cleared.count === 6 && cleared.fleet?.[1] === '6 / 6' && cleared.clear === null && cleared.value === '' && cleared.notes.length === 0,
    `卡片 ${cleared.count}；概览 ${JSON.stringify(cleared.fleet)}；value=${JSON.stringify(cleared.value)}`)

  // 收起：再点一次那枚图标 —— 收起＝不筛（词一并清掉），不留看不见的筛选。
  await type('东京')
  await clickVisible('.search-toggle')
  await sleep(250)
  const collapsed = await probe()
  check('再点一次图标＝收起，且词一并清掉（不留看不见的筛选）',
    collapsed.input === null && collapsed.wideWrap === null && collapsed.value === null && collapsed.count === 6 && collapsed.fleet?.[1] === '6 / 6',
    `input=${JSON.stringify(collapsed.input)} 卡片 ${collapsed.count} 概览 ${JSON.stringify(collapsed.fleet)}`)
  // Esc 两段式：有词先清词（框还开着），空框上再按一下才收起。
  await clickVisible('.search-toggle')
  await sleep(250)
  await type('东京')
  await key('Escape', 'Escape', 27)
  const esc1 = await probe()
  check('Esc 第一下：只清词，框还开着（接着打下一个词不用再点图标）',
    esc1.value === '' && !!esc1.input && esc1.count === 6, `value=${JSON.stringify(esc1.value)} 框还在=${!!esc1.input} 卡片 ${esc1.count}`)
  await key('Escape', 'Escape', 27)
  const esc2 = await probe()
  check('Esc 第二下：收起（顶栏又只剩那枚图标）', esc2.input === null && esc2.wideWrap === null, `input=${JSON.stringify(esc2.input)}`)
  // 点框外：不收起、也不清词 —— 去点开一台机器看清了再回来，那几台还在（所以点框外不接管）。
  await clickVisible('.search-toggle')
  await sleep(250)
  await type('东京')
  await clickAt(300, 30)   // 顶栏里、站名与图标之间那段空白：安全区（那里没有任何点击处理）
  const outside = await probe()
  check('点框外：不收起、也不清词（搜索跟着访客走，不被一次点击抹掉）',
    !!outside.input && outside.value === '东京' && outside.count === 2,
    `值=${JSON.stringify(outside.value)} 卡片 ${outside.count}`)
  await clickVisible('.search-toggle')
  await sleep(250)
}

// 搜着的时候进详情页再回来：词与结果都该留着（与分组、地区同一套记忆）。
if (!REAL) {
  await clickVisible('.search-toggle')
  await sleep(250)
  await type('东京')
  await js('document.querySelector(\'[data-card-style] > [data-slot="card"]\').click()')
  await sleep(700)
  const detail = await js('location.pathname')
  await js('document.querySelector("header button").click()')   // 点站名回列表
  await sleep(700)
  const back = await probe()
  check('搜索中进详情页、再回列表：词还在、还是那两台',
    detail.startsWith('/node/') && back.value === '东京' && back.count === 2,
    `详情页=${detail}；回来后 value=${JSON.stringify(back.value)}、卡片 ${back.count} 张`)
}

// 真站上再顺手打一个词（默认 debian）：这里**只打印命中数并截图，不做断言** ——
// 真站上有几台、名字叫什么由站长决定，拿它当判据等于把别人的数据写死进护栏。
// 想拍别的词就 `SEARCH_TERM=东京 node tools/verify_search.mjs <真站>`。
if (REAL) {
  console.log('\n（真站：夹具那些「搜出几台」的断言跳过；下面只打几个词看看效果）:')
  // 收起 / 展开两个状态各拍一张：收起时顶栏里只有一枚放大镜。
  await clickVisible('.search-toggle')
  await sleep(250)
  await shot('live-header-closed', 'header', 8)
  await clickVisible('.search-toggle')
  await sleep(250)
  await shot('live-header-open', 'header', 8)
  const terms = (process.env.SEARCH_TERMS || 'debian').split(',').map((t) => t.trim()).filter(Boolean)
  for (const [i, term] of terms.slice(0, 4).entries()) {
    await type(term)
    const hit = await probe()
    console.log(`    搜「${term}」→ 还剩 ${hit.count} 张卡片：${JSON.stringify(hit.names.slice(0, 8))}`)
    console.log(`      概览：${JSON.stringify(hit.fleet)}；空态：${hit.notes.length ? hit.notes[0].slice(0, 60) + '…' : '（无）'}`)
    await shot(`live-search-${i + 1}`, 'main', 8)
  }
  await type('')
}

m = await goto('/', { w: 390, h: 844, dark: false, mobile: true })
check('窄屏：顶栏里没有输入框（桌面那一格收起时压根不渲染），只有那枚 36×36 的图标',
  m.input === null && m.wideWrap === null && !!m.toggle && m.toggle.w === 36 && m.toggle.h === 36 && m.toggle.rendered,
  `输入框=${JSON.stringify(m.input)}；按钮 ${m.toggle?.w}×${m.toggle?.h}`)
check('窄屏：一开始没有那一行（没展开）', m.row === null, `row=${JSON.stringify(m.row)}`)
check('窄屏：顶栏那一行没被挤爆（站名仍是一行、输入框与图标都各就各位）',
  !!m.headerRow && m.headerRow.scrollW <= m.headerRow.clientW + 1 && !!m.siteName && m.siteName.h <= 44,
  `顶栏整行 scrollWidth=${m.headerRow?.scrollW} / clientWidth=${m.headerRow?.clientW}；站名 ${m.siteName?.w}×${m.siteName?.h}`)
await shot('mobile-closed', 'header', 8)
await js('document.querySelector(".search-toggle")?.click()')
await sleep(300)
m = await probe()
check('窄屏点开：多出一整行，且在顶栏那个 sticky 块里（滚下去也够得着）',
  !!m.row && m.rowInHeader && m.row.w === m.viewport.w && !!m.rowInput && m.rowInput.w > 0 && m.rowInput.focused,
  `row=${JSON.stringify(m.row)} 在 header 里=${m.rowInHeader} 行里的输入框=${JSON.stringify(m.rowInput)}`)
await shot('mobile-open', 'header', 8)
check('窄屏展开时：桌面那一格虽然渲染了，但被 CSS 藏着（宽度 0，不占地方）',
  !!m.wideWrap && m.wideWrap.display === 'none' && m.wideWrap.w === 0, `wideWrap=${JSON.stringify(m.wideWrap)}`)
if (!REAL) {
  await type('日本')
  const hits = await probe()
  check('窄屏搜「日本」：也收窄到那两台', hits.count === 2 && JSON.stringify(hits.names) === JSON.stringify(['东京一号', '东京二号']), `卡片 ${hits.count} 张：${JSON.stringify(hits.names)}`)
  await shot('mobile-hit', 'main', 8)
  await clickVisible(".search-clear")
  await sleep(250)
  const cleared = await probe()
  check('窄屏点清空：回到六台且这一行还开着', cleared.count === 6 && cleared.row !== null && cleared.value === '', `卡片 ${cleared.count}；row=${cleared.row !== null}`)
}
await js('document.querySelector(".search-toggle")?.click()')
await sleep(300)
m = await probe()
check('窄屏再点那枚图标：收起这一行、词也清掉（不留看不见的筛选）',
  m.row === null && m.count === (REAL ? m.count : 6) && m.input === null && m.value === null,
  `row=${JSON.stringify(m.row)} value=${JSON.stringify(m.value)} 卡片 ${m.count}`)
check('窄屏：没有横向溢出', m.overflow <= 0, `scrollWidth − innerWidth = ${m.overflow}`)

console.log('\n三、深色 1440×900:')
m = await goto('/', { w: 1440, h: 900, dark: true })
await clickVisible('.search-toggle')
await sleep(250)
m = await probe()
check('深色：点开后输入框在、可见、占位文案同样放得下',
  !!m.wideWrap && m.wideWrap.display !== 'none' && !!m.input && m.input.w > 0 && !!m.placeholder && m.placeholder.fits,
  m.input ? `rect=${JSON.stringify(m.input)}` : '找不到输入框')
if (!REAL) {
  await type('香港')
  const dark = await probe()
  check('深色：搜「香港」→ 一台', dark.count === 1 && dark.names[0] === '香港一号', `卡片 ${dark.count} 张：${JSON.stringify(dark.names)}`)
  await shot('desktop-dark', 'header', 8)
}

check('全程没有控制台异常', errors.length === 0, errors.slice(0, 3).join(' | '))
if (!REAL) check('夹具配置真的被用上了（那条 /config 是打到本机桩上的）', configHits >= 1, `${configHits} 次`)
console.log(`\n结果: PASS ${pass} / FAIL ${fail}`)
ws.close(); chrome.kill(); if (!REAL) server.close()
process.exit(fail ? 1 : 0)

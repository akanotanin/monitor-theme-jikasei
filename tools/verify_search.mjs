// 顶栏搜索（名称 / 地区 / 系统）的验收：收起是一枚方形图标、点开就地长成输入框（往左边长、
// 150ms 过渡）、失焦收回去但**词留着**、窄屏是顶栏下多一行、空态说没说清怎么取消。
//
// 用法：node tools/verify_search.mjs [baseUrl]
//   不给 baseUrl：本机起静态服务器伺服 dist/ + 桩 /api/*（六台夹具机器，判据只由代码决定）。
//   给了 baseUrl：直接打在真站上 —— 夹具那些「搜出几台」的断言跳过（真站上有什么机器不由这里决定），
//                 只验结构：方形/长开的几何、过渡时长、边框与占位文案的显隐、窄屏那一行、无横向溢出。
//
// 环境变量：
//   SHOT_DIR=<目录>       把关键机位连图存下（收起 / 长开 / 搜出结果 / 窄屏 / 深色）。
//   SEARCH_WAIT_MS        每一步等页面安静的时长（默认 2500，经隧道打真站时给大些）。
//   SEARCH_TERMS=a,b,c    真站模式下顺手打这几串词（默认 debian），只打印命中数并截图、不断言。
//
// 判据都是「形状」：元素的几何、计算样式、卡片数、概览里那两行字 —— 不认具体色值（除了「透明/不透明」
// 这种功能性的差别）。
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

// 一次把要看的都量出来：几何与可见性、列表里那几张卡与名字、概览「节点」那块、空态那两句话、
// 以及几处功能性的计算样式（透明/不透明、过渡时长、内容区宽度）。
const PROBE = `(() => {
  const q = (s) => document.querySelector(s)
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right),
      display: cs.display, visibility: cs.visibility, focused: el === document.activeElement, rendered: el.offsetParent !== null,
      title: el.getAttribute('title'), color: cs.color, bg: cs.backgroundColor, borderColor: cs.borderTopColor, borderWidth: cs.borderTopWidth,
      boxShadow: cs.boxShadow, transition: cs.transitionProperty + ' ' + cs.transitionDuration }
  }
  const wide = q('.search-field-wide')
  const input = q('.search-field-wide .search-input')
  const rowWrap = q('.search-row')
  const rowInput = q('.search-field-row .search-input')
  const icon = q('.search-field-wide svg')
  const pl = input ? getComputedStyle(input) : null
  const content = input ? input.clientWidth - parseFloat(pl.paddingLeft) - parseFloat(pl.paddingRight) : null
  const placeholderColor = input ? getComputedStyle(input, '::placeholder').color : null
  const transparent = (c) => !!c && (c === 'rgba(0, 0, 0, 0)' || c === 'transparent' || /\\/ 0\\)$/.test(c) || /,\\s*0\\)$/.test(c))
  const cards = [...document.querySelectorAll('[data-card-style] > [data-slot="card"]')]
  let fleet = null
  for (const card of document.querySelectorAll('[data-slot="card"]')) {
    const lines = card.innerText.split('\\n').map((s) => s.trim()).filter(Boolean)
    if (lines[0] === '节点') { fleet = lines; break }
  }
  const notes = [...document.querySelectorAll('main p')].map((p) => p.innerText.replace(/\\s+/g, ' ').trim()).filter((t) => t.includes('——'))
  const rowEl = q('header > div')
  const live = rowInput && rowInput.offsetParent !== null ? rowInput : input
  return JSON.stringify({
    input: box(input), wide: box(wide), icon: box(icon), neighborIcon: box(q('header .globe-toggle svg')), toggle: box(q('.search-toggle')), row: box(rowWrap), rowInput: box(rowInput), clear: box(q('.search-clear')),
    header: box(q('header')), headerRow: rowEl ? { scrollW: rowEl.scrollWidth, clientW: rowEl.clientWidth } : null, siteName: box(q('header button')),
    main: box(q('main')), themeButton: box(q('header button[title="切换主题"]')),
    inputInHeader: !!(input && q('header').contains(input)), rowInHeader: !!(rowWrap && q('header').contains(rowWrap)),
    padding: pl ? { l: pl.paddingLeft, r: pl.paddingRight } : null, contentWidth: content,
    placeholderColor, placeholderTransparent: transparent(placeholderColor),
    textColor: pl ? pl.color : null, textTransparent: pl ? transparent(pl.color) : null,
    borderTransparent: pl ? transparent(pl.borderTopColor) : null,
    bgTransparent: pl ? transparent(pl.backgroundColor) : null,
    count: cards.length, names: cards.map((el) => (el.querySelector('h3')?.textContent || '').trim()),
    fleet, notes, value: live ? live.value : null,
    overflow: document.documentElement.scrollWidth - innerWidth, viewport: { w: innerWidth, h: innerHeight },
  })
})()`

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); pass += ok ? 1 : 0; fail += ok ? 0 : 1 }
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
// CDP 的 clip 是**文档坐标**，所以用元素 rect 加上滚动偏移。
const shot = async (name, sel, pad = 12) => {
  if (!SHOT_DIR) return
  const b = JSON.parse(await js(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return 'null'
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.x + scrollX) - ${pad}, y: Math.round(r.y + scrollY) - ${pad}, width: Math.round(r.width) + ${pad * 2}, height: Math.round(r.height) + ${pad * 2} })
  })()`))
  if (!b) return console.log(`    （${name}: 没找到 ${sel}，跳过）`)
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...b, scale: 2 } })
  if (r.result?.data) { writeFileSync(join(SHOT_DIR, `${name}.png`), Buffer.from(r.result.data, 'base64')); console.log(`    已拍 ${join(SHOT_DIR, `${name}.png`)}`) }
}
// 两个输入框（桌面那格 + 窄屏那一行）同时在 DOM 里，窄屏上**两个都算「看得见」**（那格是 36px 的方形）。
// 所以这里取**最后一个**看得见的：DOM 里窄屏那一行排在桌面那格之后，正好是「当前真正在用的那个」。
// 拿错一个的后果实测过：窄屏上 type() 把字打进了顶栏那枚方形里，而那一枚一获得焦点就把下面那一行关掉。
const VISIBLE = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => e.offsetParent !== null).pop()`
// 顶栏那枚方形（桌面那格输入框）：窄屏点它＝开/关下面那一行，桌面上点它＝就地长开。
const SQUARE = '.search-field-wide .search-input'
// 真鼠标点击（点那枚方形图标＝点输入框本身；也用来点「框外」）：不是 el.click()，那样不会走
// 真实的 focus/blur 路径，而「失焦收起」这条正是要靠它。
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(450)   // 让 150ms 的长开/收起过渡走完
}
const clickSquare = async () => {
  const b = JSON.parse(await js(`(() => { const el = document.querySelector(${JSON.stringify(SQUARE)}); if (!el) return 'null'; const r = el.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }) })()`))
  if (!b) { console.log('    （找不到顶栏那格输入框，点不了）'); return }
  await clickAt(b.x, b.y)
}
// 打字：Ctrl+A 再 Delete（真实按键，React 的受控值才跟着变），再 insertText。
const type = async (text) => {
  await js(`(() => { const el = ${VISIBLE('.search-input')}; el?.focus(); return el === document.activeElement })()`)
  await sleep(250)   // 桌面那版要先把框长开（150ms 过渡）再打字
  for (const key of [['a', 'KeyA', 65, 2], ['Delete', 'Delete', 46, 0]]) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: key[0], code: key[1], windowsVirtualKeyCode: key[2], modifiers: key[3] })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: key[0], code: key[1], windowsVirtualKeyCode: key[2], modifiers: key[3] })
  }
  if (text) await send('Input.insertText', { text })
  await sleep(250)
}
const key = async (k, code, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk })
  await sleep(300)
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
console.log('   ' + JSON.stringify({ input: m.input, icon: m.icon, cards: m.count, fleet: m.fleet, vp: m.viewport }))
// 收起态：一枚 36×36 的方形（输入框本体），无边框、占位文案与词都看不见。
check('收起时：那一格是 36×36 的方形、排在顶栏右半边、与旁边那排图标同高',
  !!m.input && m.input.w === 36 && m.input.h === 36 && m.input.h === m.themeButton?.h && m.input.x > m.viewport.w / 2 && m.input.right <= m.header.right && m.inputInHeader,
  `rect=${JSON.stringify({ x: m.input?.x, right: m.input?.right, w: m.input?.w, h: m.input?.h })}`)
check('收起时：无边框（收起态看起来就是一枚图标按钮，不是一只小输入框）',
  m.borderTransparent === true && m.bgTransparent === true, `border=${m.input?.borderColor} bg=${m.input?.bg}`)
check('收起时：占位文案不显示（长开时才淡入）', m.placeholderTransparent === true, `::placeholder color=${m.placeholderColor}`)
check('收起时：词看不见 —— 字色透明（padding 也收紧了，盒子就是 36，不往外顶）',
  m.textTransparent === true && m.input?.w === 36 && m.padding?.l === '10px',
  `字色 ${m.textColor}（透明=${m.textTransparent}）；padding ${m.padding?.l}；盒子 ${m.input?.w}px`)
check('收起时：放大镜正好落在方框正中（左右各 10px）',
  !!m.icon && Math.abs((m.icon.x - m.input.x) - 10) <= 1 && Math.abs((m.input.right - m.icon.right) - 10) <= 1,
  `图标 x=${m.icon?.x}（框 ${m.input?.x}~${m.input?.right}，图标宽 ${m.icon?.w}）`)
// 用户报过的一条：这一排里只有放大镜是弱化灰，别的都是前景色 —— 同色是顶栏的规矩。
check('收起时：放大镜的颜色与旁边那几枚图标**逐字同色**（不给它单独的弱化灰）',
  !!m.icon && !!m.neighborIcon && m.icon.color === m.neighborIcon.color,
  `搜索 ${m.icon?.color} vs 邻座那枚 ${m.neighborIcon?.color}`)
check('收起时：悬停说明是「搜索（名称 / 地区 / 系统）」', m.input?.title === '搜索（名称 / 地区 / 系统）', `title=${m.input?.title}`)
check('收起时：没有清空按钮（那 36px 里放不下第二枚图标）', m.clear === null, JSON.stringify(m.clear))
if (!REAL) {
  check('收起时：六台都在，概览「节点」6 / 6 · 全部在线',
    m.count === 6 && m.fleet?.[1] === '6 / 6' && m.fleet?.[2] === '全部在线', `卡片 ${m.count}；概览 ${JSON.stringify(m.fleet)}`)
  await shot('desktop-collapsed', 'header', 8)
}
// 点它（真鼠标点方框中心）→ 就地长开。
await clickSquare()
const opened = await probe()
console.log('   长开后：' + JSON.stringify({ input: opened.input, icon: opened.icon, wide: opened.wide }))
check('点一下方框：就地长开成 240px 的输入框，焦点已在框里（点了就能打字）',
  opened.input?.w === 240 && opened.input?.focused === true, JSON.stringify(opened.input))
check('长开用的是 150ms 过渡（与参考站同一档手感）', /0\.15s/.test(opened.wide?.transition || ''), `transition=${opened.wide?.transition}`)
check('长开是往**左边**长：右沿一动不动（右边那排图标一枚都没被顶走）',
  opened.input?.right === m.input?.right && (opened.input?.x ?? 0) < (m.input?.x ?? 0),
  `收起 x=${m.input?.x}~${m.input?.right} → 长开 x=${opened.input?.x}~${opened.input?.right}`)
check('长开时：边框、占位文案、词都出现了（收起态那三样是透明的）',
  opened.borderTransparent === false && opened.placeholderTransparent === false && opened.textTransparent === false,
  `border=${opened.input?.borderColor} ::placeholder=${opened.placeholderColor} 字色=${opened.textColor}`)
check('长开时：焦点圈是一圈 3px（与参考站同量级）', /3px/.test(opened.input?.boxShadow || ''), opened.input?.boxShadow)
check('长开时：放大镜仍在输入位置之前（左沿 10px，文字从 32px 起）',
  !!opened.icon && !!opened.input && Math.abs((opened.icon.x - opened.input.x) - 10) <= 1 && opened.contentWidth > 100,
  `图标 x=${opened.icon?.x} 框 x=${opened.input?.x}；内容区 ${opened.contentWidth}px`)
check('长开时：还没词，所以清空按钮也不出现', opened.clear === null, JSON.stringify(opened.clear))
if (!REAL) {
  check('长开这一下没有筛掉任何东西：六台都在，概览「节点」6 / 6', opened.count === 6 && opened.fleet?.[1] === '6 / 6', `卡片 ${opened.count}`)
  await shot('desktop-expanded', 'header', 8)
  for (const [term, want] of EXPECT) {
    await type(term)
    const now = await probe()
    check(`搜「${term}」→ ${want.length ? want.join(' / ') : '一台都不剩'}`,
      now.count === want.length && JSON.stringify(now.names) === JSON.stringify(want),
      `卡片 ${now.count} 张：${JSON.stringify(now.names)}`)
    if (want.length) {
      check(`搜「${term}」时概览跟着收窄（${want.length} / ${want.length}）`, now.fleet?.[1] === `${want.length} / ${want.length}`, `概览 ${JSON.stringify(now.fleet)}`)
      check(`搜「${term}」时清空按钮出现了（有焦点、框长开着）`, !!now.clear, JSON.stringify(now.clear))
    } else {
      check('搜不到时：说清了怎么取消（空态文案带原词、且提到 ×）',
        now.notes.length === 1 && now.notes[0].includes('zzz') && now.notes[0].includes('×'), JSON.stringify(now.notes))
      check('搜不到时概览底行写「没有匹配的节点」（不是「还没有节点」）', now.fleet?.[2] === '没有匹配的节点', `概览 ${JSON.stringify(now.fleet)}`)
      await shot('desktop-empty', 'main', 8)
    }
    if (term === '东京') await shot('desktop-hit', 'main [data-card-style]', 8)
  }
  // 清空：点框里那枚 ×
  await type('东京')
  await js(`${VISIBLE('.search-clear')}?.click()`)
  await sleep(300)
  const cleared = await probe()
  check('点清空：回到六台、概览回 6 / 6、清空按钮消失、框还长开着',
    cleared.count === 6 && cleared.fleet?.[1] === '6 / 6' && cleared.clear === null && cleared.value === '' && cleared.input?.w === 240,
    `卡片 ${cleared.count}；概览 ${JSON.stringify(cleared.fleet)}；框宽 ${cleared.input?.w}`)
  // 失焦：收起但**词留着**（参考站就是这个手感），代价是收起态看不见词 —— 靠放大镜提色 + 悬停说明。
  await type('东京')
  await clickAt(300, 30)   // 顶栏里、站名与图标之间那段空白：安全区（那里没有任何点击处理）
  const blurred = await probe()
  check('点框外（失焦）：收回到 36px 的方形', blurred.input?.w === 36 && blurred.input?.focused === false, JSON.stringify(blurred.input))
  check('失焦收起后**词留着**：列表还筛着那两台，输入框里也还是「东京」',
    blurred.value === '东京' && blurred.count === 2, `value=${JSON.stringify(blurred.value)} 卡片 ${blurred.count}`)
  check('收起态那枚图标的颜色不随「有没有词」变（始终与邻座同色）', blurred.icon?.color === m.icon?.color, `空 ${m.icon?.color} → 有词 ${blurred.icon?.color}`)
  check('收起态的悬停说明带上词与命中数（`搜索：东京（2 台）`）', blurred.input?.title === '搜索：东京（2 台）', `title=${blurred.input?.title}`)
  await shot('desktop-collapsed-filtering', 'header', 8)
  // Esc 两段式：有词先清词（框还长开着），空框上再按一下才收起。
  await clickSquare()
  await key('Escape', 'Escape', 27)
  const esc1 = await probe()
  check('Esc 第一下：只清词，框仍长开着（接着打下一个词不用重新点开）',
    esc1.value === '' && esc1.input?.w === 240 && esc1.count === 6, `value=${JSON.stringify(esc1.value)} 框宽 ${esc1.input?.w}`)
  await key('Escape', 'Escape', 27)
  const esc2 = await probe()
  check('Esc 第二下：收起（回到 36px 的方形）', esc2.input?.w === 36 && esc2.input?.focused === false, JSON.stringify(esc2.input))
  // 搜着的时候进详情页再回来：词与结果都该留着（与分组、地区同一套记忆）。
  await type('东京')
  await js('document.querySelector(\'[data-card-style] > [data-slot="card"]\').click()')
  await sleep(700)
  const detail = await js('location.pathname')
  await js('document.querySelector("header button").click()')   // 点站名回列表
  await sleep(700)
  const back = await probe()
  check('搜着的时候进详情页、再回列表：词还在、还是那两台',
    detail.startsWith('/node/') && back.value === '东京' && back.count === 2,
    `详情页=${detail}；回来后 value=${JSON.stringify(back.value)}、卡片 ${back.count} 张`)
}

console.log('\n二、窄屏 390×844（亮色）:')
m = await goto('/', { w: 390, h: 844, dark: false, mobile: true })
check('窄屏：顶栏那格仍是那枚 36×36 的方形（窄屏不长开，长开式样只在 ≥640px 生效）',
  !!m.input && m.input.w === 36 && m.input.h === 36 && m.input.rendered && m.inputInHeader,
  JSON.stringify(m.input))
check('窄屏：一开始没有那一行（没展开）', m.row === null, `row=${JSON.stringify(m.row)}`)
check('窄屏：顶栏那一行没被挤爆（站名仍是一行、图标都各就各位）',
  !!m.headerRow && m.headerRow.scrollW <= m.headerRow.clientW + 1 && !!m.siteName && m.siteName.h <= 44,
  `顶栏整行 scrollWidth=${m.headerRow?.scrollW} / clientWidth=${m.headerRow?.clientW}；站名 ${m.siteName?.w}×${m.siteName?.h}`)
await shot('mobile-closed', 'header', 8)
await clickSquare()
m = await probe()
check('窄屏点开：多出一整行，且在顶栏那个 sticky 块里（滚下去也够得着）',
  !!m.row && m.rowInHeader && m.row.w === m.viewport.w && !!m.rowInput && m.rowInput.w > 0 && m.rowInput.focused,
  `row=${JSON.stringify(m.row)} 在 header 里=${m.rowInHeader} 行里的输入框=${JSON.stringify(m.rowInput)}`)
await shot('mobile-open', 'header', 8)
if (!REAL) {
  await type('日本')
  const hits = await probe()
  check('窄屏搜「日本」：也收窄到那两台', hits.count === 2 && JSON.stringify(hits.names) === JSON.stringify(['东京一号', '东京二号']), `卡片 ${hits.count} 张：${JSON.stringify(hits.names)}`)
  await shot('mobile-hit', 'main', 8)
  await js(`${VISIBLE('.search-clear')}?.click()`)
  await sleep(300)
  const cleared = await probe()
  check('窄屏点清空：回到六台且这一行还开着', cleared.count === 6 && cleared.row !== null && cleared.value === '', `卡片 ${cleared.count}；行还在=${cleared.row !== null}`)
}
await clickSquare()
m = await probe()
check('窄屏再点那枚方形图标：收起这一行', m.row === null && m.input?.w === 36, `row=${JSON.stringify(m.row)}`)
check('窄屏：没有横向溢出', m.overflow <= 0, `scrollWidth − innerWidth = ${m.overflow}`)

console.log('\n三、深色 1440×900:')
m = await goto('/', { w: 1440, h: 900, dark: true })
await clickSquare()
m = await probe()
check('深色：点开后长到 240px、边框与占位文案都出现了',
  m.input?.w === 240 && m.borderTransparent === false && m.placeholderTransparent === false,
  `宽 ${m.input?.w}；border=${m.input?.borderColor}`)
if (!REAL) {
  await type('香港')
  const dark = await probe()
  check('深色：搜「香港」→ 一台', dark.count === 1 && dark.names[0] === '香港一号', `卡片 ${dark.count} 张：${JSON.stringify(dark.names)}`)
  await shot('desktop-dark', 'header', 8)
}

// 真站上再顺手打几个词：**只打印命中数并截图，不做断言** —— 真站上有几台、名字叫什么由站长决定，
// 拿它当判据等于把别人的数据写死进护栏。想拍别的词就 `SEARCH_TERMS=东京,debian node ... <真站>`。
if (REAL) {
  console.log('\n（真站：夹具那些「搜出几台」的断言跳过；下面只打几个词看看效果）:')
  // 前面那个场景把媒体切到了深色，这里换回亮色再拍（两种都要看得到）。
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await clickAt(300, 30)   // 先失焦收起，拍一张收起态
  await shot('live-header-collapsed', 'header', 8)
  await clickSquare()
  await shot('live-header-expanded', 'header', 8)
  const terms = (process.env.SEARCH_TERMS || 'debian').split(',').map((t) => t.trim()).filter(Boolean)
  for (const [i, term] of terms.slice(0, 4).entries()) {
    await type(term)
    const hit = await probe()
    console.log(`    搜「${term}」→ 还剩 ${hit.count} 张卡片：${JSON.stringify(hit.names.slice(0, 8))}`)
    console.log(`      概览：${JSON.stringify(hit.fleet)}；空态：${hit.notes.length ? hit.notes[0].slice(0, 60) + '…' : '（无）'}`)
    await shot(`live-search-${i + 1}`, 'main', 8)
  }
  await clickAt(300, 30)
}

check('全程没有控制台异常', errors.length === 0, errors.slice(0, 3).join(' | '))
if (!REAL) check('夹具配置真的被用上了（那条 /config 是打到本机桩上的）', configHits >= 1, `${configHits} 次`)
console.log(`\n结果: PASS ${pass} / FAIL ${fail}`)
ws.close(); chrome.kill(); if (!REAL) server.close()
process.exit(fail ? 1 : 0)

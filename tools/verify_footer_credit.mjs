// 页脚署名的验收：右下角那行「Theme by jikasei」在不在、点不点得动、够不够「浅」。
//
// 用法：node tools/verify_footer_credit.mjs [baseUrl]
//   不给 baseUrl：本机起静态服务器伺服 dist/ + 桩 /api/*（不经隧道，判据只由代码决定）。
//   给了 baseUrl：直接打在真 hub / 真站上（位置与对比度照样量得出来，桩计数那几项跳过）。
//
// 环境变量：
//   SHOT_DIR=<目录>   每个场景把署名那一小块（右下角）连裁一张对照图，便于交改前/改后。
//   FOOTER_WAIT_MS    每一步等页面安静的时长（默认 2500，经隧道打真站时给大些）。
//
// 判据都是「形状」而不是具体色值：
//   ① 署名在、文案逐字、链接指向源码仓库、新标签页打开、锚文本就是「jikasei」；
//   ② 位置：贴着主内容的右沿、排在正文之后 —— 内容比一屏短时整个署名落在视口右下角；
//   ③ 「浅」用对比度说话：把颜色按 opacity 合成到页面底色上量 WCAG 对比度，
//      必须低于顶栏站名（= 比正文浅），但仍 ≥ 1.6（看得见，不是隐形字）；
//   ④ 窄屏 390 与深色下同样成立，且没有横向溢出。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 5230
const BASE = (process.argv[2] || `http://127.0.0.1:${PORT}`).replace(/\/$/, '')
const REAL = !!process.argv[2]
const SETTLE = Number(process.env.FOOTER_WAIT_MS || 2500)
const SHOT_DIR = process.env.SHOT_DIR || ''
// 与 App.tsx 的 REPO_URL / theme.json 的 url 同一个地址（三处必须一致，改时一起改）。
const REPO_URL = 'https://github.com/akanotanin/monitor-theme-jikasei'
// 夹具配置钉死（理由见技能第 44 条：让判据只由代码决定，不取自那台 hub 上存的配置）。
const CONFIG = { cardStyle: 'plain', listTop: 'none' }
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2' }
const node = (id, name, group) => ({
  id, name, group, online: true, public: true, sort: id, country: 'JP', country_pin: '', os: 'Debian GNU/Linux 12 (bookworm)',
  virt: 'vm', arch: 'x86_64', cpu_name: 'AMD EPYC Processor', cpu_cores: 1, kernel: '6.1.0-53-cloud-amd64', agent_version: '1.0.0',
  mem_total: 1020526592, swap_total: 0, disk_total: 10485864448, traffic_limit: 536870912000, traffic_mode: 'sum',
  billing_cycle: 'yearly', currency: 'CNY', price: 349, expires_at: '2027-07-21', expires_in: 299, month_start: '2026-09-21', traffic_reset_day: 21,
  day_rx: 2140585887, day_tx: 2191393745, month_rx: 4650258264, month_tx: 4351673970, total_rx: 5707805336, total_tx: 5203609923, last_seen: 1790311292,
  metrics: { cpu: 3, load: [0, 0, 0], mem_used: 431800320, mem_total: 1020526592, swap_used: 0, swap_total: 0, disk_used: 1524510720, disk_total: 10485864448, net_rx: 867, net_tx: 465, procs: 75, tcp: 16, udp: 3, uptime: 318521, month_rx: 4650258264, month_tx: 4351673970, total_rx: 5707805336, total_tx: 5203609923 },
})
// 两台机器：内容明显比一屏短，于是「内容短时署名仍落在视口右下角」这一条才验得出来。
const NODES = { nodes: [node(1, '节点一', '东京'), node(2, '节点二', '')] }

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
  console.log(`dist/ 伺服在 ${BASE}/（夹具配置 ${JSON.stringify(CONFIG)}，2 台机器）`)
} else {
  console.log(`直接打真站: ${BASE}（本机不伺服 dist）`)
}

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p)) || 'chrome'
let chrome, dbgPort, wsUrl = null
for (let attempt = 0; attempt < 2 && !wsUrl; attempt++) {
  dbgPort = 9940 + Math.floor(Math.random() * 60)
  chrome?.kill()
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, '--remote-allow-origins=*',
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    ...(process.env.PROXY ? [`--proxy-server=${process.env.PROXY}`] : []),
    '--user-data-dir=' + (process.env.TEMP || process.env.LOCALAPPDATA || '/tmp') + '/footercredit-' + dbgPort + '-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
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
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')

// 量什么：文案/链接/右沿/上下沿，以及把颜色按 opacity 合成到底色上之后与底色的对比度。
// 用 canvas 读回 sRGB：计算样式里那串 oklch() 自己解析容易出错，交给浏览器算。
const MEASURE = `(() => {
  const q = (s) => document.querySelector(s)
  const credit = q('.theme-credit')
  const footer = q('footer')
  const main = q('main')
  const link = credit ? credit.querySelector('a') : null
  const siteName = q('header button')
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]) }
  const ratio = (a, b) => { const la = lum(a), lb = lum(b); return Math.round(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) / 100 }
  const bgRGB = () => { ctx.globalAlpha = 1; ctx.fillStyle = getComputedStyle(document.body).backgroundColor; ctx.fillRect(0, 0, 1, 1); return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3) }
  const of = (el) => {
    if (!el) return null
    const cs = getComputedStyle(el)
    const bg = bgRGB()
    ctx.globalAlpha = Number(cs.opacity || 1); ctx.fillStyle = cs.color; ctx.fillRect(0, 0, 1, 1)
    const fg = Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3)
    const r = el.getBoundingClientRect()
    return { color: cs.color, opacity: cs.opacity, fontSize: cs.fontSize, fontWeight: cs.fontWeight, display: cs.display, visibility: cs.visibility,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) },
      ratio: ratio(fg, bg) }
  }
  const mb = main && main.getBoundingClientRect()
  const mcs = main && getComputedStyle(main)
  const fb = footer && footer.getBoundingClientRect()
  // 署名是「整行宽 + text-align:right」，块的盒宽跟容器一样 —— 判「在右边」必须量**文字**的盒
  // （Range 取内容盒），拿块盒会得出「左沿在 97px」这种自相矛盾的数。
  let creditText = null
  if (credit) {
    const range = document.createRange(); range.selectNodeContents(credit)
    const rb = range.getBoundingClientRect()
    creditText = { x: Math.round(rb.x), y: Math.round(rb.y), w: Math.round(rb.width), h: Math.round(rb.height), right: Math.round(rb.right), bottom: Math.round(rb.bottom) }
  }
  return JSON.stringify({
    exists: !!credit,
    text: credit ? credit.textContent.replace(/\\s+/g, ' ').trim() : null,
    linkText: link ? link.textContent.trim() : null,
    href: link ? link.getAttribute('href') : null,
    target: link ? link.getAttribute('target') : null,
    rel: link ? link.getAttribute('rel') : null,
    linkInside: !!(credit && link && credit.contains(link)),
    credit: of(credit),
    creditText,
    siteName: of(siteName),
    main: mb ? { left: Math.round(mb.left), right: Math.round(mb.right), bottom: Math.round(mb.bottom), contentRight: Math.round(mb.right - parseFloat(mcs.paddingRight)) } : null,
    footer: fb ? { top: Math.round(fb.top), bottom: Math.round(fb.bottom), right: Math.round(fb.right) } : null,
    viewport: { w: innerWidth, h: innerHeight },
    overflow: document.documentElement.scrollWidth - innerWidth,
    fontReady: document.fonts.status,
  })
})()`

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }

// 等页面安静：署名出来、字体加载完。判据里不带百分比之类会被数据直接命中的串。
const settle = async () => {
  for (let i = 0; i < Math.ceil(SETTLE / 200) + 10; i++) {
    const ok = await js(`!!document.querySelector('.theme-credit') && document.fonts.status === 'loaded'`)
    if (ok) break
    await sleep(200)
  }
  await sleep(400)
}
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true })
// 署名那一小块（右下角）：机位**不依赖署名在不在** —— 锚点取主内容右沿 + 页底，
// 所以改前（没有署名）与改后拍的是同一块，能直接并排看。
// ★CDP 的 clip 是**文档坐标**（不是视口坐标，实测过：ScrollY=606 时给的视口坐标裁出来的是
//   文档 y=834 处的一张卡片）——所以量完一律加上 scrollX/scrollY；同时先滚到页底，
//   保证这一块落在视口内（captureBeyondViewport:false 时视口外的像素拍不到）。
const shot = async (name, m) => {
  if (!SHOT_DIR) return
  const vp = m.viewport
  await js('scrollTo(0, document.documentElement.scrollHeight)')
  await sleep(250)
  const box = JSON.parse(await js(`(() => {
    const el = document.querySelector('.theme-credit')
    const main = document.querySelector('main')
    const r = el ? (() => { const g = document.createRange(); g.selectNodeContents(el); return g.getBoundingClientRect() })() : null
    const right = r ? r.right : (main ? main.getBoundingClientRect().right - parseFloat(getComputedStyle(main).paddingRight) : innerWidth - 16)
    const bottom = r ? r.bottom : innerHeight - 20
    return JSON.stringify({ right: Math.round(right + scrollX), bottom: Math.round(bottom + scrollY) })
  })()`))
  const clip = { x: Math.max(0, box.right - 280), y: Math.max(0, box.bottom - 46), width: 300, height: 66 }
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { ...clip, scale: 3 } })
  if (r.result?.data) { writeFileSync(join(SHOT_DIR, `${name}.png`), Buffer.from(r.result.data, 'base64')); console.log(`    已拍 ${join(SHOT_DIR, `${name}.png`)}  clip=${JSON.stringify(clip)}`) }
  // 再拍一张整屏（滚到页底之后的当前视口）：署名在页面里的位置、与内容的关系一眼看得全。
  const full = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: 0, y: Math.round(box.bottom + 20 - vp.h), width: vp.w, height: vp.h, scale: 1 } })
  if (full.result?.data) { writeFileSync(join(SHOT_DIR, `${name}-fullpage.png`), Buffer.from(full.result.data, 'base64')); console.log(`    已拍 ${join(SHOT_DIR, `${name}-fullpage.png`)}`) }
}

const goto = async (path, { w, h, dark, mobile = false }) => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] })
  await send('Page.navigate', { url: `${BASE}${path}` })
  await settle()
  return JSON.parse(await js(MEASURE))
}

const common = (m, where) => {
  check(`${where}：右下角那行署名在`, m.exists && !!m.credit && m.credit.display !== 'none' && m.credit.visibility === 'visible' && m.credit.rect.h > 0,
    m.credit ? `${m.credit.rect.w}×${m.credit.rect.h} @ ${m.credit.rect.x},${m.credit.rect.y}` : '找不到 .theme-credit')
  check(`${where}：文案逐字是「Theme by jikasei」`, m.text === 'Theme by jikasei', `实际=${JSON.stringify(m.text)}`)
  check(`${where}：链接指向源码仓库、新标签页、锚文本是「jikasei」`,
    m.href === REPO_URL && m.target === '_blank' && (m.rel || '').includes('noreferrer') && m.linkText === 'jikasei' && m.linkInside,
    `href=${m.href} target=${m.target} rel=${m.rel} 锚文本=${JSON.stringify(m.linkText)}`)
  // 对齐：桌面（≥640px）右对齐到主内容右沿；窄屏**居中** —— 2026-10-07 站长说手机上看
  // 右下角那行「位置不好看」（一行孤零零的灰字、左边整片空着，像水印），改成居中之后才像页脚。
  // 判据仍是「形状」：居中断左右留白对称（文字中线 ≈ 主内容中线），不判具体坐标。
  const narrow = m.viewport.w < 640
  const mid = m.creditText ? (m.creditText.x + m.creditText.right) / 2 : NaN
  const mainMid = m.main ? (m.main.left + m.main.right) / 2 : NaN
  check(narrow ? `${where}：窄屏下署名居中（文字中线 ≈ 主内容中线）` : `${where}：右沿与主内容右沿对齐（右对齐，不是居中/靠左）`,
    narrow
      ? !!m.creditText && !!m.main && Math.abs(mid - mainMid) <= 1.5 && m.creditText.w > 0 && m.creditText.w <= 300
      : !!m.creditText && !!m.main && Math.abs(m.creditText.right - m.main.contentRight) <= 1
        && m.creditText.x > m.main.left + (m.main.right - m.main.left) / 2
        && m.creditText.w > 0 && m.creditText.w <= 300,
    `文字 ${m.creditText?.x}→${m.creditText?.right}（中线 ${mid?.toFixed(1)}）｜主内容 ${m.main?.left}→${m.main?.right}（中线 ${mainMid?.toFixed(1)}）｜内容右沿 ${m.main?.contentRight}`)
  check(`${where}：排在正文之后（不是压在列表上）`, !!m.footer && !!m.main && m.footer.top >= m.main.bottom - 1,
    `footer.top=${m.footer?.top} main.bottom=${m.main?.bottom}`)
  check(`${where}：比顶栏站名浅（对比度更低），但仍看得见（≥1.6）`,
    !!m.credit && !!m.siteName && m.credit.ratio < m.siteName.ratio && m.credit.ratio >= 1.6,
    `署名 ${m.credit?.ratio}:1（${m.credit?.color} × ${m.credit?.opacity}） vs 站名 ${m.siteName?.ratio}:1；字号 ${m.credit?.fontSize}`)
  check(`${where}：没有横向溢出`, m.overflow <= 0, `scrollWidth − innerWidth = ${m.overflow}`)
}

console.log('\n一、列表页 1440×900（亮色，两台机器）:')
let m = await goto('/', { w: 1440, h: 900, dark: false })
console.log('   ' + JSON.stringify({ text: m.text, credit: m.credit?.rect, footer: m.footer, main: m.main, vp: m.viewport }))
common(m, '列表页')
// 内容比一屏短时，署名应当落在视口右下角（min-h-svh + main flex-1 那一手）；
// 长页（真 hub 上机器多）时它就该落在**整页的最后** —— 两种形状分开断，别拿一条判所有页。
const pageH = await js('document.documentElement.scrollHeight')
// m.footer 可能不存在（改之前那一版就是这样）——那种情况这一条必须是 FAIL 而不是抛异常，
// 否则「反向自测」跑到这里直接崩掉，后面几十条一条都报不出来。
const fits = !!m.footer && m.footer.bottom <= m.viewport.h + 1
check(`列表页：署名在页面最底下（${fits ? '内容不足一屏 → 贴视口右下角' : '长页 → 落在整页末尾'}）`,
  !!m.footer && (fits ? Math.abs(m.footer.bottom - m.viewport.h) <= 1 : Math.abs(m.footer.bottom - pageH) <= 2),
  `footer.bottom=${m.footer?.bottom ?? '（没有 footer）'} 视口高=${m.viewport.h} 整页高=${pageH}`)
await shot('list-light-1440', m)

console.log('\n二、详情页 /node/1（1440×900，亮色）:')
m = await goto('/node/1', { w: 1440, h: 900, dark: false })
common(m, '详情页')
await shot('detail-light-1440', m)

console.log('\n三、窄屏 390×844（亮色）:')
m = await goto('/', { w: 390, h: 844, dark: false, mobile: true })
common(m, '窄屏')
await shot('list-light-390', m)

console.log('\n四、深色（1440×900）:')
m = await goto('/', { w: 1440, h: 900, dark: true })
common(m, '深色')
await shot('list-dark-1440', m)

if (REAL) console.log('\n（打真站：桩服务器的计数不适用，已跳过）')
console.log(`\n结果: PASS ${pass} / FAIL ${fail}`)
ws.close(); chrome.kill(); if (!REAL) server.close()
process.exit(fail ? 1 : 0)

// 触屏命中区护栏：**视觉不动，只把可点范围撑到 44px**（手指比鼠标粗，44 是通行线）。
//
// 判据不靠几何推算，靠**真实命中测试**：从控件中心一格一格往外走，用
// `document.elementFromPoint` 看那一点还算不算这个控件（伪元素 ::before 撑出来的那圈，
// 命中时会返回它所属的那个元素）。这样「被祖先 overflow 裁掉」「被邻居盖住」都跑不掉。
//
// 同时钉住两件事：① 控件自己的盒子**尺寸一点没变**（外观不动的证据）
//              ② 相邻控件的有效命中区**不许重叠**（撑过头会点错邻居，比小按钮更糟）
//
// 跑法：node tools/verify_touch_targets.mjs [baseUrl]
//   不给 baseUrl：本机起静态服务器伺服 dist/ + 桩 /api/*；给了就打真站。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join, extname, normalize } from 'node:path'

const REAL = process.argv[2] || ''
const PORT = 5211
const BASE = REAL || `http://127.0.0.1:${PORT}`
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
let passed = 0
function check(what, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ' — ' + detail : ''}`)
  if (ok) passed++
  else failed++
}

// ── 夹具：四台机器就够（护栏看的是控件几何，不是数据量） ──
const node = (id, name, group, country, os) => ({
  id, name, group, country, os, sort: id, online: true, public: true, country_pin: '',
  last_seen: 1790311292, kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'AMD EPYC 7763', cpu_cores: 2,
  mem_total: 1020526592, swap_total: 0, disk_total: 10485864448, traffic_limit: 536870912000, traffic_mode: 'sum',
  billing_cycle: 'yearly', currency: 'CNY', price: 349, expires_at: '2027-07-21', expires_in: 299, month_start: '2026-09-21',
  traffic_reset_day: 21, day_rx: 2140585887, day_tx: 2191393745, month_rx: 4650258264, month_tx: 4351673970,
  total_rx: 5707805336, total_tx: 5203609923,
  metrics: { cpu: 3, load: [0, 0, 0], mem_used: 431800320, mem_total: 1020526592, swap_used: 0, swap_total: 0, disk_used: 1524510720, disk_total: 10485864448, net_rx: 867, net_tx: 465, procs: 75, tcp: 16, udp: 3, uptime: 318521, month_rx: 4650258264, month_tx: 4351673970, total_rx: 5707805336, total_tx: 5203609923 },
})
const NODES = { nodes: [node(1, '东京一号', '东京', 'JP', 'Debian GNU/Linux 12 (bookworm)'), node(2, '香港一号', '香港', 'HK', 'Ubuntu 22.04.4 LTS'), node(3, '法兰克福一号', '法兰克福', 'DE', 'Debian GNU/Linux 12 (bookworm)'), node(4, 'US-Backup', '', 'US', 'Windows Server 2022')] }
const CONFIG = { listTop: 'both', cardStyle: 'detailed', remarkPlacement: 'both', pingLines: '' }

const serveFile = (res, path) => {
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(200, { 'Content-Type': TYPES['.html'] }); return res.end(readFileSync('dist/index.html')) }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
}
const server = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  if (path.startsWith('/api/')) {
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: BASE, site_name: '命中区' }
      : path === '/api/nodes' ? NODES
        : path.endsWith('/config') ? CONFIG
          : path.includes('/metrics') ? { metrics: [], probes: [], loss: {} } : {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  serveFile(res, path)
})
if (!REAL) await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p)) || 'chrome'
const dbgPort = 9990 + Math.floor(Math.random() * 15)
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, '--remote-allow-origins=*', '--no-first-run',
  '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--window-size=390,844',
  '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/tap-' + dbgPort + '-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 120 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { }
  if (!wsUrl) await sleep(250)
}
if (!wsUrl) throw new Error('Chrome 起不来')
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
}
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')

// 一次把每个控件的「视觉盒子」与「有效命中区」都量出来。
const PROBE = `(() => {
  const box = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) })
  // 有效命中区：从中心往外一格一格走，看那点还算不算这个控件（伪元素撑出来的也算它）。
  const reach = (el) => {
    // 先滚到视口中间再量：靠下的控件中心点落在视口外时 elementFromPoint 返回 null，
    // 会把命中区量成 1×1（第一版就踩了这个坑，还以为是被什么盖住了）。
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const r = el.getBoundingClientRect()
    const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2)
    const owns = (x, y) => {
      const t = document.elementFromPoint(x, y)
      return !!t && (t === el || el.contains(t))
    }
    const walk = (dx, dy) => { let n = 0; while (n < 60) { const x = cx + dx * (n + 1), y = cy + dy * (n + 1); if (x < 0 || y < 0 || x > innerWidth || y > innerHeight || !owns(x, y)) break; n++ } return n }
    const l = walk(-1, 0), rr = walk(1, 0), u = walk(0, -1), d = walk(0, 1)
    return { w: l + rr + 1, h: u + d + 1, cx, cy }
  }
  const label = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || (el.querySelector('input') || {}).ariaLabel || (el.textContent || '').trim() || el.tagName).slice(0, 20)
  // 搜索那格的命中区挂在 「.search-field」 这个 span 上（输入框是替换元素，::before 不生成），
  // 所以它也要进来量 —— 量的是「手指点得到多大」，不是「输入框自己多大」。
  const pick = (root) => [...root.querySelectorAll('button, a, input, [role="button"], .search-field')].filter((el) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && el.offsetParent !== null
  })
  const describe = (el) => ({ label: label(el), tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 40), box: box(el.getBoundingClientRect()), hit: reach(el) })
  return JSON.stringify({
    header: pick(document.querySelector('header') || document.body).map(describe),
    main: pick(document.querySelector('main') || document.body).slice(0, 24).map(describe),
    vp: { w: innerWidth, h: innerHeight },
    // ★ 窄屏的横向溢出：内容比视口宽时整页能横向拖动（手机上看着就是「页面被推歪了」）。
    // 这个数必须拿 clientWidth 比（visualViewport 在移动模拟下会是放大后的值）。
    overflow: { scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth },
    // 地区行（地球右边那列）：原来只有 20px 高，手机上点不准。
    regions: [...document.querySelectorAll('.globe-reg')].map((el) => ({ label: (el.textContent || '').trim().slice(0, 10), box: +el.getBoundingClientRect().height.toFixed(1), hit: reach(el).h })),
    theme: document.documentElement.className,
  })
})()`

async function open(path, w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true })
  await send('Page.navigate', { url: BASE + path })
  await sleep(1500)
  await send('Page.navigate', { url: BASE + path })   // 第二轮量（第一轮偶发量到空壳）
  await sleep(3200)
  return JSON.parse(await js(PROBE))
}

const MIN = 44
console.log(`\n一、手机 390×844（亮色，四台夹具）${REAL ? ' —— 真站' : ''}:`)
let m = await open('/', 390, 844)
console.log(`   视口 ${m.vp.w}×${m.vp.h}；顶栏控件 ${m.header.length} 个`)

// ① 顶栏那几枚 36×36 的图标按钮：外观必须还是 36×36，命中区必须 ≥44。
const icons = m.header.filter((c) => c.box.w === 36 && c.box.h === 36 && (c.tag === 'button' || c.tag === 'a'))
check('顶栏 36×36 的图标按钮都在（登录 / 卡片形态 / 地球 / 主题）', icons.length >= 4, `${icons.length} 个：${JSON.stringify(icons.map((c) => c.label))}`)
check('外观一点没动：它们自己的盒子仍是 36×36', icons.length > 0 && icons.every((c) => c.box.w === 36 && c.box.h === 36), JSON.stringify(icons.map((c) => c.box.w + '×' + c.box.h)))
check(`命中区都撑到 ≥${MIN}×${MIN}`,
  icons.length > 0 && icons.every((c) => c.hit.w >= MIN && c.hit.h >= MIN),
  JSON.stringify(icons.map((c) => `${c.label} ${c.hit.w}×${c.hit.h}`)))

// ①b 搜索那一格：量外层 span（那圈挂它身上），并确认输入框自己还是 36×36（外观没动）
const field = m.header.find((c) => (c.cls || '').includes('search-field') && c.tag === 'span')
const input36 = m.header.find((c) => c.tag === 'input')
check('搜索那一格：命中区 ≥44×44（那圈挂在框外的 span 上）',
  !!field && field.hit.w >= MIN && field.hit.h >= MIN, field ? `${field.hit.w}×${field.hit.h}` : '没找到 .search-field')
check('搜索输入框自己仍是 36×36（外观没动）', !!input36 && input36.box.w === 36 && input36.box.h === 36, input36 ? `${input36.box.w}×${input36.box.h}` : '没找到')

// ② 站名（32 高）也是可点的，命中高度要够。
const site = m.header.find((c) => c.box.h === 32)
check('站名那格：盒子高度仍是 32（外观不动），命中高度 ≥44',
  !!site && site.box.h === 32 && site.hit.h >= MIN,
  site ? `盒子 ${site.box.w}×${site.box.h}，命中 ${site.hit.w}×${site.hit.h}` : '没找到 32 高的顶栏控件')

// ②b 窄屏不许横向溢出。390 宽上顶栏那一行原本要 407px（站名 101 + 搜索 22 + 五枚 36px 图标
//    + 六个 gap-3 = 72 + 左右内边距 32），整页因此能横向拖动 —— 桌面窗口够宽量不出来，
//    只有拿手机视口跑才看得见。收口是 gap-2 + 站名 truncate，这里把它钉死。
check('390 宽上页面没有横向溢出（顶栏那一行装得下）',
  m.overflow.scrollW <= m.overflow.clientW, `scrollW ${m.overflow.scrollW} vs clientW ${m.overflow.clientW}`)

// ②c 地区行：原 20px 高（≈4mm）手指点不准，现在 ≥32；行间留着 8px gap，命中区不叠邻居。
const regs = m.regions || []
check('地区行的命中高度 ≥32（原来 20px，手机上点不准）',
  regs.length >= 3 && regs.every((c) => c.hit >= 32), JSON.stringify(regs.map((c) => `${c.label} 盒子${c.box} 命中${c.hit}`)))

// ③ 相邻控件的命中区不许重叠：拿每个控件的中心点去问别人的命中区。
const overlap = []
// 只比「互相独立」的控件：搜索那格同时量了外层 span 与里面的 input（同一件事的两层），
// 盒子互相包含的一对直接跳过，不然自己跟自己算重叠。
const nested = (a, b) => a.box.x <= b.box.x && a.box.y <= b.box.y && a.box.right >= b.box.right && a.box.bottom >= b.box.bottom
for (const a of m.header) for (const b of m.header) {
  if (a === b || nested(a, b) || nested(b, a)) continue
  const inside = Math.abs(b.hit.cx - a.hit.cx) <= (a.hit.w - 1) / 2 && Math.abs(b.hit.cy - a.hit.cy) <= (a.hit.h - 1) / 2
  if (inside) overlap.push(`${b.label} 的中心落在 ${a.label} 的命中区里`)
}
check('相邻控件的命中区不重叠（撑过头会点错邻居）', overlap.length === 0, overlap.join('；') || '没有重叠')

// ④ 触屏上的输入框（窄屏那行）与清空按钮。
const row = await (async () => {
  await js(`(() => { const b = [...document.querySelectorAll('header button')].find((x) => (x.getAttribute('title') || '').startsWith('搜索')); b && b.click() })()`)
  await sleep(600)
  return JSON.parse(await js(PROBE))
})()
const rowField = row.header.find((c) => (c.cls || '').includes('search-field'))
check('窄屏那行输入框：命中区高度 ≥44（那圈挂在框外面的 span 上，输入框本身是替换元素不生成伪元素）',
  !!rowField && rowField.hit.h >= MIN, rowField ? `${rowField.hit.w}×${rowField.hit.h}` : '没找到')

console.log('\n二、详情页（量程 / 分段按钮）:')
let d = await open('/node/1', 390, 844)
const seg = d.main.filter((c) => c.box.h === 24)
check('详情页 24px 高的分段按钮还在（量程 / 资源 / 网络延迟）', seg.length >= 2, `${seg.length} 个：${JSON.stringify(seg.map((c) => c.label))}`)
check('外观一点没动：盒子仍是 24 高', seg.length > 0 && seg.every((c) => c.box.h === 24), JSON.stringify(seg.map((c) => c.box.h)))
check('外观一点没动：横向没被撑开（±2px 是测量噪声）', seg.length > 0 && seg.every((c) => Math.abs(c.hit.w - c.box.w) <= 2), JSON.stringify(seg.map((c) => `${c.label} ${c.hit.w} vs ${c.box.w}`)))
check('命中区都 ≥24（WCAG 2.2 硬线）', seg.length > 0 && seg.every((c) => c.hit.h >= 24), JSON.stringify(seg.map((c) => `${c.label} ${c.hit.h}`)))
check('详情页也没有横向溢出', d.overflow.scrollW <= d.overflow.clientW, `scrollW ${d.overflow.scrollW} vs clientW ${d.overflow.clientW}`)
const ranges = seg.filter((c) => /小时|天/.test(c.label))
check(`量程那几枚（${ranges.map((c) => c.label).join('/')}）命中区 ≥44`,
  ranges.length >= 3 && ranges.every((c) => c.hit.h >= MIN),
  JSON.stringify(ranges.map((c) => `${c.label} 命中 ${c.hit.w}×${c.hit.h}`)))
const tight = seg.filter((c) => c.hit.h < MIN)
check('没到 44 的那两枚是被邻居卡住（面板那行太密），仍 ≥24 —— 如实记着，不假装撑到 44',
  tight.every((c) => c.hit.h >= 24), JSON.stringify(tight.map((c) => `${c.label} ${c.hit.h}（盒子 ${c.box.h}）`)))

console.log('\n三、仍然 <44 的控件（信息，不判 FAIL）:')
const rest = [...d.main, ...d.header, ...row.main, ...row.header].filter((c) => c.hit.w < MIN || c.hit.h < MIN)
const uniq = [...new Map(rest.map((c) => [c.label + c.box.w + 'x' + c.box.h, c])).values()]
for (const c of uniq.slice(0, 10)) console.log(`   ${c.label} — 盒子 ${c.box.w}×${c.box.h}，命中 ${c.hit.w}×${c.hit.h}（.${c.cls}）`)
check('没有控制台异常', errors.length === 0, errors.slice(0, 2).join(' | '))

console.log(`\n结果: PASS ${passed} / FAIL ${failed}`)
chrome.kill()
server?.close()
process.exit(failed ? 1 : 0)

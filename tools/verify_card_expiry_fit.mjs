// 「详细」档卡片三枚读数盒（速率 / 总量 / 到期）的**完整展示**：逐宽度量每个读数 span 的
// scrollWidth 与 clientWidth，任何一处被截（scrollWidth > clientWidth + 1）就 FAIL。
//
// 形态约定（站长 2026-10-14 二改后）：三枚**永远同一行**；窄卡（统计区宽 < NARROW_T）里
// 到期枚的日历图标隐藏、日期行去掉缩进，读数超宽时在「剩余｜280 天」的空格处折行
// （数字+单位包成不折的整块，不会把「天」拆成孤字）——外形保持三枚一排。
// 桌面宽（1280/1440）与手机（320/360/390/430）都量：修窄不得改宽（桌面回归由本工具一并管）。
//
// 用法：cd <repo> && node tools/verify_card_expiry_fit.mjs
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 5521
const CDP_PORT = PORT + 4000
// 与 index.css 的 `@container stats (max-width: …)` 阈值一致（jikasei 350；rakugaki 版为 366）。
const NARROW_T = 350
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2' }
const GB = 1024 ** 3, MB = 1024 ** 2

const metrics = (o) => ({ uptime: 1966200, cpu: 1.0, load: [0.03, 0.01, 0.0], mem_total: 960 * MB, mem_used: 430 * MB, swap_total: 0, swap_used: 0, disk_total: 10 * GB, disk_used: 1.4 * GB, net_rx: 1517, net_tx: 530, total_rx: 44.2 * GB, total_tx: 42.9 * GB, month_rx: 43.1 * GB, month_tx: 42.0 * GB, tcp: 16, udp: 3, procs: 76, ...o })

// 形状照着现网那几台造：3 位数天数（280/303/337）、已过期、今天到期、无期限、极端 4 位数。
const node = (id, name, o) => ({
  id, name, sort: id, public: true, online: true, country: 'JP', group: '', last_seen: Math.floor(Date.now() / 1000) - 5, last_seen_ago: 5,
  metrics: metrics({}), os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'EPYC', cpu_cores: 1,
  mem_total: 960 * MB, swap_total: 0, disk_total: 10 * GB, agent_version: '1.4.0', price: 12.5, currency: 'USD', billing_cycle: 'monthly',
  expires_at: '2027-07-21', expires_in: 280, traffic_limit: 500 * GB, traffic_mode: 'sum', traffic_reset_day: 1,
  total_rx: 44.2 * GB, total_tx: 42.9 * GB, month_rx: 43.1 * GB, month_tx: 42.0 * GB, month_start: '2026-10-01', day_rx: 6.06 * GB, day_tx: 2.5 * GB,
  ...o,
})

const NODES = { nodes: [
  node(1, 'Alpha San Jose', { expires_in: 280, expires_at: '2027-07-21' }),
  node(2, 'Bravo Tokyo', { expires_in: -128, expires_at: '2026-06-08' }),
  node(3, 'Charlie Frankfurt', { expires_in: 27, expires_at: '2026-11-10' }),
  node(4, 'Delta Ashburn', { expires_in: 0, expires_at: '2026-10-14' }),
  node(5, 'Echo Tokyo Gen 2', { expires_in: null, expires_at: null, price: 0 }),
  node(6, 'Foxtrot San Jose', { expires_in: 1234, expires_at: '2029-12-31' }),
] }

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  const json = (b) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(b)) }
  if (path.startsWith('/api/')) {
    if (path === '/api/me') return json({ authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '到期读数', history_days: 30 })
    if (path === '/api/nodes') return json(NODES)
    if (path.endsWith('/config')) return json({ cardStyle: 'detailed' })
    if (/\/metrics/.test(path)) return json({ metrics: [], ping: [], probes: {}, loss: {} })
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

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p)) || 'chrome'
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*', '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--no-proxy-server', `--user-data-dir=${join(tmpdir(), `expiryfit${CDP_PORT}`)}`, '--no-sandbox', 'about:blank'], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { /* 等 */ }
  if (!wsUrl) await sleep(250)
}
if (!wsUrl) throw new Error('Chrome 没起来')
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
let id = 0
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')
// 访客偏好钉到「详细」档（两个主题各自的键都写一遍，脚本两侧通用）。
await send('Page.addScriptToEvaluateOnNewDocument', { source: "try{for(const k of ['jikasei:card_style','rakugaki:card_style'])localStorage.setItem(k,'detailed')}catch(e){}" })

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }
const waitFor = async (expr, ms = 10000) => {
  for (let i = 0; i < ms / 120; i++) {
    if (await js(expr)) return true
    await sleep(120)
  }
  return false
}

// 卡片里每个读数 span（.tnum）＋第三枚读数盒下面那行到期日（[data-stat-date]）都量一遍：
//   clip = scrollWidth - clientWidth > 1 即被截（等宽字体给 1px 亚像素余量）。
//   每条还带 fontSize（容器查询会把窄卡的读数降档，选阈值要看实际字号）与盒宽。
//   另取：统计区宽度（窄/宽卡判据）、到期枚图标是否隐藏、日期行缩进 —— 用来核对让位规则。
const PROBE = `JSON.stringify((() => {
  const cards = [...document.querySelectorAll('[data-node-card]')]
  const out = []
  for (const c of cards) {
    const name = c.querySelector('h3')?.textContent?.trim() ?? '?'
    const rows = []
    for (const t of [...c.querySelectorAll('.tnum')]) {
      const clip = t.scrollWidth - t.clientWidth
      if (clip > 1) rows.push({ text: t.textContent.trim(), clip, sw: t.scrollWidth, cw: t.clientWidth, fs: getComputedStyle(t).fontSize })
    }
    const dateLine = c.querySelector('[data-stats] [data-stat-date]')
    let dateClip = null
    if (dateLine) { const clip = dateLine.scrollWidth - dateLine.clientWidth; if (clip > 1) dateClip = { text: dateLine.textContent.trim(), clip, fs: getComputedStyle(dateLine).fontSize } }
    // 第三枚读数盒：值文本可写/需要宽度、图标在不在、日期行缩进、统计区宽度
    const box = c.querySelector('[data-stats] > [data-stat="expiry"]')
    const statsEl = c.querySelector('[data-stats]')
    let expiryInfo = null
    if (box) {
      const txt = box.querySelector('.tnum')
      const svg = box.querySelector('svg')
      const lh = txt ? parseFloat(getComputedStyle(txt).lineHeight) || 16 : 16
      expiryInfo = {
        box: Math.round(box.getBoundingClientRect().width),
        avail: txt ? txt.clientWidth : null, need: txt ? txt.scrollWidth : null,
        fs: txt ? getComputedStyle(txt).fontSize : null,
        lines: txt ? Math.round(txt.getBoundingClientRect().height / lh) : null,
        iconHidden: svg ? getComputedStyle(svg).display === 'none' : null,
        dateIndent: dateLine ? Math.round(parseFloat(getComputedStyle(dateLine).paddingLeft) || 0) : null,
      }
    }
    // 三枚读数盒各自的几何（x/y/w）：任何宽度下都应同一行（y 相等）。
    const stats = [...c.querySelectorAll('[data-stats] > *')].map((b) => {
      const r = b.getBoundingClientRect()
      return { stat: b.getAttribute('data-stat'), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
    })
    out.push({ name, statsW: statsEl ? Math.round(statsEl.getBoundingClientRect().width) : null, expiry: expiryInfo, stats, clipped: rows, dateClip })
  }
  return out
})())`

const WIDTHS = [320, 360, 390, 430, 640, 768, 1024, 1280, 1440, 1600]
for (const w of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 640 })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  const ok = await waitFor(`document.querySelectorAll('[data-node-card]').length >= 6`, 15000)
  if (!ok) { check(`${w}px 卡片渲染`, false, '没等到 6 张卡'); continue }
  await sleep(500)
  const rows = JSON.parse(await js(PROBE) ?? '[]')
  const bad = rows.filter((r) => r.clipped.length > 0 || r.dateClip)
  const detail = bad.map((r) => `${r.name}: ` + [...r.clipped.map((x) => `「${x.text}」截${x.clip}px(sw${x.sw}/cw${x.cw} @${x.fs})`), ...(r.dateClip ? [`日期「${r.dateClip.text}」截${r.dateClip.clip}px`] : [])].join('、')).join(' | ')
  check(`${w}px 详细卡读数无截断`, bad.length === 0, detail)
  // 形态①：三枚读数盒**永远同一行**（y 相等）。
  const shape = rows.filter((r) => {
    const [s, t, e] = r.stats
    if (!s || !t || !e) return true
    return !(s.y === t.y && s.y === e.y)
  })
  check(`${w}px 三枚读数盒同一行`,
    shape.length === 0, shape.map((r) => `${r.name}: ` + JSON.stringify(r.stats)).join(' | '))
  // 形态②：让位规则 —— 窄卡（统计区 < NARROW_T）到期枚图标隐藏、日期行缩进 0；宽卡原样（图标 + 18px）。
  const place = rows.filter((r) => {
    if (!r.expiry) return false
    const narrow = (r.statsW ?? 0) < NARROW_T
    const iconOk = r.expiry.iconHidden === narrow
    const indentOk = r.expiry.dateIndent === null || r.expiry.dateIndent === (narrow ? 0 : 18)
    return !(iconOk && indentOk)
  })
  check(`${w}px 让位规则（窄卡藏图标·去缩进／宽卡原样）`, place.length === 0,
    place.map((r) => `${r.name}: 统计区${r.statsW} 图藏${r.expiry?.iconHidden} 缩进${r.expiry?.dateIndent}`).join(' | '))
  if (w === 360 || w === 390 || w === 640 || w === 1280 || w === 1440) {
    console.log(`    ${w}px 到期盒: ` + rows.map((r) => `${r.name}: 盒${r.expiry?.box}px 可写${r.expiry?.avail} 需${r.expiry?.need} @${r.expiry?.fs}${r.expiry?.lines > 1 ? '·折行' : ''}${r.expiry?.iconHidden ? '·无图' : ''}`).join(' | '))
    console.log(`    ${w}px 盒几何: ` + (rows[0]?.stats ?? []).map((b) => `${b.stat}(x${b.x},y${b.y},w${b.w})`).join(' '))
  }
}

console.log(`\n结果: PASS ${pass} / FAIL ${fail}`)
ws.close(); chrome.kill(); server.close()
process.exit(fail ? 1 : 0)

// 地球的「看」的审计（诊断用，不判 PASS/FAIL）：把地球依次定格到每个地区，等自转停下后
// 把**圆盘那一块**按元素裁切、放大，再拼成一张大图交给视觉模型看。
//
// 为什么要它：verify_globe_spin.mjs 量的是「该是陆地/画出来是不是陆地」，漏 1% 也判绿；但
// 用户说的是「看上去有瑕疵」——贴地平线的锯齿、针/标签叠在一起、经纬线穿到陆地外面之类，
// 采样对账看不见。这里出图给人（和视觉模型）看。
//
// 用法：node tools/shot_globe_sheet.mjs [角度数] [裁剪倍率]
//   产出 shots/globe-sheet/sheet.png（总览，圆盘+标签）与 disk-<n>.png（只要圆盘，倍率更高）
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join, extname, normalize } from 'node:path'
import { regionRows, VIEW } from '../src/lib/globe.ts'

const PORT = 5481
const OUT = 'shots/globe-sheet'
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CITIES = [
  ['东京一号', 'JP', '东京'], ['法兰克福一号', 'DE', '欧洲'], ['圣保罗一号', 'BR', '南美'],
  ['悉尼一号', 'AU', '亚太'], ['纽约一号', 'US', '纽约'], ['新加坡一号', 'SG', '新加坡'],
  ['孟买一号', 'IN', '孟买'], ['开普敦一号', 'ZA', '非洲'], ['伦敦一号', 'GB', '伦敦'],
  ['多伦多一号', 'CA', '多伦多'], ['迪拜一号', 'AE', '迪拜'], ['圣地亚哥一号', 'CL', '智利'],
]
const mk = (id, name, country, group) => ({
  id, name, country, group, os: 'Debian GNU/Linux 12', sort: id, online: true, public: true, country_pin: '',
  last_seen: 1790311292, kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'x', cpu_cores: 2, mem_total: 1, swap_total: 0,
  disk_total: 1, traffic_limit: 1, traffic_mode: 'sum', billing_cycle: 'monthly', currency: 'CNY', price: 1,
  expires_at: '2027-07-21', expires_in: 1, month_start: '2026-09-21', traffic_reset_day: 21,
  day_rx: 1, day_tx: 1, month_rx: 1, month_tx: 1, total_rx: 1, total_tx: 1,
  metrics: { cpu: 5, load: [0, 0, 0], mem_used: 1, mem_total: 1, swap_used: 0, swap_total: 0, disk_used: 1, disk_total: 1, net_rx: 1, net_tx: 1, procs: 1, tcp: 1, udp: 1, uptime: 1, month_rx: 1, month_tx: 1, total_rx: 1, total_tx: 1 },
})
const NODES = { nodes: CITIES.map(([name, cc, group], i) => mk(i + 1, name, cc, group)) }
const ROWS = regionRows(NODES.nodes)

const serveFile = (res, path) => {
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(200, { 'Content-Type': TYPES['.html'] }); return res.end(readFileSync('dist/index.html')) }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
}
const server = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  if (path.startsWith('/api/')) {
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '地球裁定' }
      : path === '/api/nodes' ? NODES : path.endsWith('/config') ? { listTop: 'none', cardStyle: 'compact' } : { metrics: [], ping: [], probes: {}, loss: {} }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  serveFile(res, path)
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p))
const dbgPort = 9940 + Math.floor(Math.random() * 9)
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, '--remote-allow-origins=*', '--no-first-run',
  '--disable-gpu', '--hide-scrollbars', '--window-size=1500,1400',
  '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/globesheet-' + dbgPort + '-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 120 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { }
  if (!wsUrl) await sleep(250)
}
let id = 0
const pending = new Map()
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')
// 关掉自转：定格之后它才真的停在那个角度上
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1400, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(3200)

mkdirSync(OUT, { recursive: true })
const shots = []
const rect = async (sel) => JSON.parse((await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'null'; const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height }) })()`)) ?? 'null')
const clipShot = async (box, scale, file) => {
  const shot = (await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false, scale,
    clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale },
  })).result?.data
  if (!shot) { console.log('★截图失败', file); return false }
  writeFileSync(join(OUT, file), Buffer.from(shot, 'base64'))
  return true
}

await js(`(() => { document.querySelector('.globe-atlas')?.scrollIntoView({ block: 'start' }); window.scrollTo(0, 0); return true })()`)
await sleep(300)
const svgBox = await rect('.globe-atlas svg')
console.log('画布框：', JSON.stringify(svgBox))
// 圆盘那一块（用户单位 → 画布像素：svg 按 viewBox 460×240 等比缩放）
const k = svgBox ? svgBox.w / VIEW.w : 1
const disk = (pad = 6) => ({
  x: svgBox.x + (VIEW.cx - VIEW.r - pad) * k,
  y: svgBox.y + (VIEW.cy - VIEW.r - pad) * k,
  w: (VIEW.r * 2 + pad * 2) * k,
  h: (VIEW.r * 2 + pad * 2) * k,
})

const target = Number(process.argv[2] ?? 6)
const zoom = Number(process.argv[3] ?? 4)
const picks = ROWS.slice(0, target)
console.log('地区顺序：', ROWS.map((r) => `${r.region.label}(${r.aim[0].toFixed(0)},${r.aim[1].toFixed(0)})`).join(' '))
for (let i = 0; i < picks.length; i += 1) {
  await js(`(() => { const b = document.querySelectorAll('button.globe-reg')[${i + 1}]; if (b) b.click(); return true })()`)
  await sleep(450)
  // 点「全部」清掉筛选：针全回来，视角停在刚定格的那个角度（减弱动态已开，不会自己转走）
  await js(`(() => { const b = document.querySelector('.globe-reg-all'); if (b) b.click(); return true })()`)
  await sleep(350)
  const pins = Number(await js(`document.querySelectorAll('.globe-atlas circle.hit').length`)) || 0
  const caption = String(await js(`document.querySelector('.globe-caption')?.textContent || ''`))
  const name = picks[i].region.label.replace(/[^\w\u4e00-\u9fa5-]/g, '')
  await clipShot(svgBox, 3, `${String(i).padStart(2, '0')}-${name}-full.png`)
  await clipShot(disk(8), zoom, `disk-${String(i).padStart(2, '0')}-${name}.png`)
  shots.push({ i, name, caption, pins, full: `${String(i).padStart(2, '0')}-${name}-full.png`, disk: `disk-${String(i).padStart(2, '0')}-${name}.png` })
  console.log(`${name.padEnd(12)} ${caption.padEnd(46)} 针 ${pins}`)
}

// 拼图：总览每一张一行（圆盘那张放大图另存，视觉模型可以直接逐张看）
const cell = (s) => `<figure><img src="data:image/png;base64,${readFileSync(join(OUT, s.full)).toString('base64')}"><figcaption>${s.name} · ${s.pins} 针 · ${s.caption}</figcaption></figure>`
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#fff;font:12px/1.4 system-ui,sans-serif;width:1000px}
figure{margin:0 0 10px;padding:0 0 6px;border-bottom:1px solid #ddd}
img{display:block;width:1000px}
figcaption{padding:2px 4px;color:#333}
</style>${shots.map(cell).join('')}`
writeFileSync(join(OUT, 'sheet.html'), html)
await send('Page.navigate', { url: `file:///${join(process.cwd(), OUT, 'sheet.html').replace(/\\/g, '/')}` })
await sleep(1200)
const sheet = (await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).result?.data
if (sheet) writeFileSync(join(OUT, 'sheet.png'), Buffer.from(sheet, 'base64'))
console.log(`\n拼图：${OUT}/sheet.png ｜ 圆盘放大图：${OUT}/disk-*.png`)
writeFileSync(join(OUT, 'report.json'), JSON.stringify(shots, null, 2))
chrome.kill()
server.close()
process.exit(0)

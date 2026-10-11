// 「地区识别口径」的验收：一台机器认不出城市时，地区名到底写什么。
//
// 背景（2026-10-11）：站长收到第三方反馈 —— 他的站点地区列表里并排出现
//   🇺🇸 US 16 / 🇩🇪 DE 3 / 🇯🇵 Japan 2 / 🇺🇸 Phoenix 2 / 🇲🇾 MY 1 / 🇭🇰 Hong Kong 6 / …
// 「US」（国家码）、「Japan」（国名）、「Phoenix」（城市名）三种口径混在一列里，
// 看起来像坏了。本工具把那份截图的情形原样造成夹具（33 台），断言修复后的口径：
//
//   · 地区名 = 能认到的最准地名：城市优先，认不出城市按**国家名**（英文），
//     不再出现裸的两字国家码；
//   · 城市级条目带国家码前缀（`HK · Hong Kong ×6`），国家级条目就是国家名
//     （`United States ×16`，不加前缀 —— 加了就是 `US · United States` 这种冗余）；
//   · 大机群档（≥30 台）下，单台地区也按地区名显示（`US · San Francisco`），
//     不再混着机器名（`US · San Francisco 01`）—— 小队档保持机器名（那条不在本工具里）。
//
// 反向自测底账：拿修复前的构建跑，下面 6 条 FAIL（列表里 US/DE/MY/Japan 的口径、
// 裸码、`US · US ×16`、`MY · MY-01` 等）。
//
// 用法：node tools/verify_region_names.mjs [截图目录=shots/region-names]
//   先 `npm run build` —— 验的是 dist/，不是源码。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

const OUT = process.argv[2] || 'shots/region-names'
mkdirSync(OUT, { recursive: true })
const PORT = 5221
const CDP_PORT = 29621
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.md': 'text/markdown' }

/* ------------------------------------------------------------------ 33 台夹具（照着那份反馈截图造） */
// 16 台 US / 3 台 DE / 2 台 JP / 1 台 MY：名字里没有任何城市线索 → 只认得出国家；
// 6 台 HK / 1 台 SG：城市国家，永远给城名；2 台 Phoenix / 1 台 SF / 1 台 Seattle：认得出城市。
const mk = (id, name, country, online = true) => ({
  id, name, sort: id, public: true, online, country, group: '', last_seen: Math.floor(Date.now() / 1000),
  metrics: null, os: 'Debian', kernel: '6.1.0', arch: 'x86_64', virt: '', cpu_name: '', cpu_cores: 1,
  mem_total: 0, swap_total: 0, disk_total: 0, agent_version: '1.2.0', price: 0, currency: 'CNY',
  billing_cycle: '', expires_at: null, traffic_limit: 0, traffic_mode: '', traffic_reset_day: 1,
  total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0, month_start: '', day_rx: 0, day_tx: 0,
})
const FLEET = []
{
  let id = 0
  const add = (n, name, cc) => { for (let k = 1; k <= n; k += 1) { id += 1; FLEET.push(mk(id, `${name}${String(k).padStart(2, '0')}`, cc)) } }
  add(16, 'US-', 'US')
  add(3, 'DE-', 'DE')
  add(2, 'JP-', 'JP')
  add(1, 'MY-', 'MY')
  add(6, 'HK-', 'HK')
  add(1, 'SG-', 'SG')
  add(2, 'Phoenix ', 'US')
  add(1, 'San Francisco ', 'US')
  add(1, 'Seattle ', 'US')
}
if (FLEET.length !== 33) throw new Error(`夹具应为 33 台，现在 ${FLEET.length}`)

// 修复后应有的地区列表（名称, 台数）——顺序 = 台数降序、同台数按键升序（regionRows 的口径）。
const WANT_ROWS = [
  ['全部', 33], ['United States', 16], ['Hong Kong', 6], ['Germany', 3], ['Japan', 2], ['Phoenix', 2],
  ['Malaysia', 1], ['Singapore', 1], ['San Francisco', 1], ['Seattle', 1],
]
// 标签里允许出现的地名（剥掉国家码前缀与 ×N 之后）。
const WANT_NAMES = new Set(['United States', 'Hong Kong', 'Germany', 'Japan', 'Phoenix', 'Malaysia', 'Singapore', 'San Francisco', 'Seattle'])

/* ------------------------------------------------------------------ 伺服与浏览器 */
const sendHtml = (res) => { res.writeHead(200, { 'Content-Type': TYPES['.html'] }); res.end(readFileSync('dist/index.html')) }
const server = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  if (path.startsWith('/api/')) {
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '地区口径验收', history_days: 30 }
      : path === '/api/nodes' ? { nodes: FLEET }
      : path.endsWith('/config') ? {}
      : {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\\.\\.[/\\\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) return sendHtml(res)
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p)) || 'chrome'
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*', '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--no-proxy-server', `--user-data-dir=${join(tmpdir(), `regionnames${CDP_PORT}`)}`, '--no-sandbox', 'about:blank'], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { /* 等它起来 */ }
  if (!wsUrl) await sleep(250)
}
if (!wsUrl) throw new Error('Chrome 没起来')
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
let id = 0, errors = []
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description ?? 'exception')
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args?.map((a) => a.value).join(' '))
}
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }
const waitFor = async (expr, ms = 20000) => {
  for (let i = 0; i < Math.ceil(ms / 150); i++) { if (await js(expr)) return true; await sleep(150) }
  return false
}
const shot = async (name) => {
  const clip = await js(`(() => { const r = document.querySelector('.globe-panel').getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height } })()`)
  const r = await send('Page.captureScreenshot', clip ? { format: 'png', clip: { ...clip, scale: 2 }, captureBeyondViewport: true } : { format: 'png' })
  if (r.result?.data) writeFileSync(join(OUT, name), Buffer.from(r.result.data, 'base64'))
}
const clickRow = async (text) => js(`(() => { const b = [...document.querySelectorAll('.globe-reg')].find((x) => x.querySelector('span') && x.querySelector('span').textContent.indexOf(${JSON.stringify(text)}) >= 0); if (!b) return false; b.click(); return true })()`)

/* ------------------------------------------------------------------ 页面侧探针 */
const PROBE = `(() => {
  const panel = document.querySelector('.globe-panel')
  if (!panel) return null
  const rows = [...panel.querySelectorAll('.globe-reg')].map((b) => ({
    name: b.querySelector('span') ? b.querySelector('span').textContent : '',
    count: b.querySelector('b') ? Number((b.querySelector('b').textContent || '').replace(/[^0-9]/g, '')) : 0,
  }))
  const labels = [...panel.querySelectorAll('.globe-label')].map((t) => t.textContent)
  return JSON.stringify({ rows, labels })
})()`
const open = async () => {
  await waitFor(`document.querySelector('.globe-panel svg .globe-label') !== null`, 25000)
  await sleep(600)
  const raw = await js(PROBE)
  return raw ? JSON.parse(raw) : null
}
// 剥掉国家码前缀（`HK · X` / `X · HK`）与 ×N，剩下的是不是允许的地名。
const nameOf = (label) => label.replace(/^[A-Z]{2} · /, '').replace(/ · [A-Z]{2}$/, '').replace(/ ×\d+$/, '')

/* ---------------------------------------------------------------- 一、地区列表（桌面 1440） */
console.log('=== 一、地区列表：口径统一（城市 / 国家名），不再有裸国家码 ===')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
let s = await open()
check('地球面板画出来了（探针 sanity）', s && s.rows.length > 5 && s.labels.length > 0, s ? `地区行 ${s.rows.length} / 标签 ${s.labels.length}` : '探针拿不到')
if (s) {
  console.log('  地区列表：', s.rows.map((r) => `${r.name} ${r.count}`).join(' / '))
  console.log('  初始视角标签：', s.labels.join(' | '))
  const got = s.rows.map((r) => [r.name, r.count])
  check('★ 地区列表逐行口径（United States / Germany / Japan…）', JSON.stringify(got) === JSON.stringify(WANT_ROWS), JSON.stringify(got))
  check('★ 列表里没有裸的两字国家码（US/DE/JP/MY…）', s.rows.every((r) => !/^[A-Z]{2}$/.test(r.name)), JSON.stringify(s.rows.filter((r) => /^[A-Z]{2}$/.test(r.name)).map((r) => r.name)))
  check('★ 列表行合计 = 33 台', s.rows[0].count === 33 && s.rows.slice(1).reduce((sum, r) => sum + r.count, 0) === 33, `全部 ${s.rows[0].count} / 分项和 ${s.rows.slice(1).reduce((sum, r) => sum + r.count, 0)}`)
  check('★ 当前视角标签全是地名（无 `US · US ×16`、无 `JP · Japan`、无机器名）',
    s.labels.every((t) => WANT_NAMES.has(nameOf(t))), JSON.stringify(s.labels.filter((t) => !WANT_NAMES.has(nameOf(t)))))
  await shot('desktop-initial.png')
}

/* ---------------------------------------------------------------- 二、钉到美国：国家级标签不带码、单台按地名 */
console.log('\n=== 二、点「United States」：国家级条目与城市条目各就各位 ===')
if (s) {
  const okClick = await clickRow('United States')
  check('点得到「United States」那一行', okClick === true)
  await sleep(900)
  const raw = await js(PROBE)
  const us = raw ? JSON.parse(raw) : null
  if (us) {
    console.log('  美国视角标签：', us.labels.join(' | '))
    check('★ 国家级合并针写作「United States ×16」（不带 US 前缀）', us.labels.includes('United States ×16'), JSON.stringify(us.labels))
    check('★ 没有 `US · US ×16` 这种冗余', !us.labels.some((t) => /(US · US|US ×16 · US)/.test(t)), JSON.stringify(us.labels.filter((t) => /US · US|US ×16 · US/.test(t))))
    const side = (base) => us.labels.some((t) => t === `${base} · US` || t === `US · ${base}`)
    check('★ 城市级条目仍带国家码（Phoenix ×2 / San Francisco）', side('Phoenix ×2') && side('San Francisco'), JSON.stringify(us.labels))
    check('★ 大机群下单台地区不写机器名（没有 US-17 / Phoenix 01 这类）', !us.labels.some((t) => /\b[A-Z]{2}-\d{2}\b/.test(t) || / 01\b/.test(t)), JSON.stringify(us.labels.filter((t) => /\b[A-Z]{2}-\d{2}\b/.test(t) || / 01\b/.test(t))))
    await shot('desktop-us.png')
  } else check('美国视角探针拿得到', false)
}

/* ---------------------------------------------------------------- 三、钉到马来西亚：单台国家 = 国家名 */
console.log('\n=== 三、点「Malaysia」：单台的国家级条目 = 国家名 ===')
if (s) {
  await clickRow('United States') // 先取消，让视图能再飞
  await sleep(300)
  const okClick = await clickRow('Malaysia')
  check('点得到「Malaysia」那一行', okClick === true)
  await sleep(900)
  const raw = await js(PROBE)
  const my = raw ? JSON.parse(raw) : null
  if (my) {
    console.log('  马来视角标签：', my.labels.join(' | '))
    check('★ 单台的马来西亚写作「Malaysia」（不是 MY、不是 MY-04）', my.labels.includes('Malaysia'), JSON.stringify(my.labels))
    check('★ 没有 `MY · MY-04` 这类机器名标签', !my.labels.some((t) => /MY-\d{2}/.test(t)), JSON.stringify(my.labels.filter((t) => /MY-\d{2}/.test(t))))
  } else check('马来视角探针拿得到', false)
}

/* ---------------------------------------------------------------- 四、手机 390：同一份列表 */
console.log('\n=== 四、手机 390：地区列表口径一致 ===')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
s = await open()
check('手机上面板画出来了', s && s.rows.length > 5, s ? `地区行 ${s.rows.length}` : '探针拿不到')
if (s) {
  const got = s.rows.map((r) => [r.name, r.count])
  check('★ 手机端地区列表与桌面同一口径', JSON.stringify(got) === JSON.stringify(WANT_ROWS), JSON.stringify(got))
  await shot('mobile.png')
}

check('控制台无异常', errors.length === 0, errors.join(' | ').slice(0, 200))

console.log(`\n${pass} PASS / ${fail} FAIL`)
chrome.kill()
server.close()
process.exit(fail ? 1 : 0)

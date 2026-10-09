// 「大机群（100 台）」下节点地球的收口验收：本机伺服 dist/ + 桩 100 台合成机群，
// headless Chrome 把下面这些逐条断言（都是 2026-10-10 在 100 台演示站上量出来的问题）：
//
//   · **两摞标签封顶**：每侧 ≤ MAX_LABEL_ROWS、全部落在 12~204 的设计带里、不被画布裁
//     （旧版实测每侧 21/19 行、底端冲到 y=235，是一堵文字墙）；
//   · **省掉的行不留引线**（针 = 命中圆 > 标签 = 引线），且**离线的与多台地区优先留**；
//   · **连线收口**：可见针 ~40 枚时按老公式画 87 条（欧亚之间连成一张网），新公式 ≤ 60；
//   · **地区列表收进滚动区**（旧版 57 行把面板撑到 845px 高），桌面面板 ≤ 330px；
//   · **马德里不被「德里」抢走**（线索表顺序敏感的回归哨兵，单测在 globe.test.ts）。
//
// 用法：node tools/verify_globe_scale.mjs [截图目录=shots/globe-scale]
//   先 `npm run build` —— 验的是 dist/，不是源码。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

const OUT = process.argv[2] || 'shots/globe-scale'
mkdirSync(OUT, { recursive: true })
const PORT = 5219
const CDP_PORT = 29619
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.md': 'text/markdown' }

/* ------------------------------------------------------------------ 100 台合成机群 */
// 中性名（Demo + 城市 + 序号）；城市都取线索表里认得的写法。分布按一份常见的全球机队写。
const CITIES = [
  ['Tokyo', 'JP', 6, '亚太'], ['Hong Kong', 'HK', 5, '亚太'], ['Singapore', 'SG', 4, '亚太'],
  ['Seoul', 'KR', 3, '亚太'], ['Taipei', 'TW', 3, '亚太'], ['Osaka', 'JP', 2, '亚太'],
  ['Bangkok', 'TH', 2, '亚太'], ['Mumbai', 'IN', 2, '亚太'], ['Sydney', 'AU', 2, '亚太'],
  ['Jakarta', 'ID', 1, '亚太'], ['Manila', 'PH', 1, '亚太'], ['Hanoi', 'VN', 1, '亚太'],
  ['Los Angeles', 'US', 5, '美洲'], ['San Jose', 'US', 4, '美洲'], ['Ashburn', 'US', 4, '美洲'],
  ['Dallas', 'US', 3, '美洲'], ['Seattle', 'US', 2, '美洲'], ['Chicago', 'US', 2, '美洲'],
  ['New York', 'US', 2, '美洲'], ['Toronto', 'CA', 2, '美洲'], ['São Paulo', 'BR', 2, '美洲'],
  ['Frankfurt', 'DE', 4, '欧洲'], ['London', 'GB', 3, '欧洲'], ['Amsterdam', 'NL', 3, '欧洲'],
  ['Paris', 'FR', 2, '欧洲'], ['Milan', 'IT', 2, '欧洲'], ['Warsaw', 'PL', 2, '欧洲'],
  ['Helsinki', 'FI', 2, '欧洲'], ['Moscow', 'RU', 2, '欧洲'], ['Madrid', 'ES', 2, '欧洲'],
  ['Stockholm', 'SE', 1, '欧洲'], ['Zurich', 'CH', 1, '欧洲'], ['Vienna', 'AT', 1, '欧洲'], ['Prague', 'CZ', 1, '欧洲'],
  ['Dublin', 'IE', 1, '欧洲'], ['Oslo', 'NO', 1, '欧洲'], ['Riga', 'LV', 1, '欧洲'],
  ['Tallinn', 'EE', 1, '欧洲'], ['Sofia', 'BG', 1, '欧洲'],
  ['Dubai', 'AE', 2, '其他'], ['Tel Aviv', 'IL', 1, '其他'], ['Johannesburg', 'ZA', 1, '其他'],
  ['Auckland', 'NZ', 1, '其他'], ['Buenos Aires', 'AR', 1, '其他'], ['Kiev', 'UA', 1, '其他'],
  ['Lima', 'PE', 1, '其他'], ['Bangalore', 'IN', 1, '其他'], ['Ho Chi Minh', 'VN', 1, '其他'],
  ['Mexico City', 'MX', 1, '其他'],
]
const TOTAL = CITIES.reduce((sum, c) => sum + c[2], 0)
if (TOTAL !== 100) throw new Error(`夹具台数必须是 100，现在是 ${TOTAL}`)
const mk = (id, name, country, group, online = true) => ({
  id, name, sort: id, public: true, online, country, group, last_seen: Math.floor(Date.now() / 1000),
  metrics: null, os: 'Debian', kernel: '6.1.0', arch: 'x86_64', virt: '', cpu_name: '', cpu_cores: 1,
  mem_total: 0, swap_total: 0, disk_total: 0, agent_version: '1.2.0', price: 0, currency: 'CNY',
  billing_cycle: '', expires_at: null, traffic_limit: 0, traffic_mode: '', traffic_reset_day: 1,
  total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0, month_start: '', day_rx: 0, day_tx: 0,
})
const FLEET = []
{
  let id = 0
  for (const [city, cc, count, group] of CITIES) {
    for (let k = 1; k <= count; k += 1) {
      id += 1
      // 两个城市各塞一台中文名的机器：「马德里 02」盯线索顺序（别落到 Delhi）；
      // 中文名也顺带压一压标签的字宽（全角 8.6 的估法在这里要成立）。
      const name = city === 'Madrid' && k === 2 ? '马德里 02' : `Demo ${city} ${String(k).padStart(2, '0')}`
      FLEET.push(mk(id, name, cc, group))
    }
  }
}
// 四台离线，全部落在初始视角（80°E/30°N，可见 −10°E~170°E）里：
// 一台多台地区里的（香港）、一台单台地区（马尼拉）、东京一台、法兰克福一台 ——
// 用来断言「离线的与多台地区优先留」。
const OFFLINE = { 'Demo Hong Kong 01': 1, 'Demo Tokyo 01': 1, 'Demo Manila 01': 1, 'Demo Frankfurt 01': 1 }
for (const n of FLEET) if (OFFLINE[n.name]) n.online = false
if (FLEET.length !== 100) throw new Error(`机群应为 100 台，现在 ${FLEET.length}`)

let config = { listTop: 'none', cardStyle: 'plain', globeOn: true }

/* ------------------------------------------------------------------ 伺服与浏览器 */
const sendHtml = (res) => { res.writeHead(200, { 'Content-Type': TYPES['.html'] }); res.end(readFileSync('dist/index.html')) }
const server = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  if (path.startsWith('/api/')) {
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '大机群验收', history_days: 30 }
      : path === '/api/nodes' ? { nodes: FLEET }
      : path.endsWith('/config') ? config
      : {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) return sendHtml(res)
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p)) || 'chrome'
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*', '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--no-proxy-server', `--user-data-dir=${join(tmpdir(), `globescale${CDP_PORT}`)}`, '--no-sandbox', 'about:blank'], { stdio: 'ignore' })
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

/* ------------------------------------------------------------------ 页面侧探针 */
const PROBE = `(() => {
  const panel = document.querySelector('.globe-panel')
  const svg = panel && panel.querySelector('svg')
  if (!panel || !svg) return null
  const svgBox = svg.getBoundingClientRect()
  const labels = [...svg.querySelectorAll('.globe-label')].map((t) => {
    const r = t.getBoundingClientRect()
    return {
      text: t.textContent, y: +t.getAttribute('y'), end: t.getAttribute('text-anchor') === 'end',
      clipped: r.left < svgBox.left - 0.6 || r.right > svgBox.right + 0.6 || r.top < svgBox.top - 0.6 || r.bottom > svgBox.bottom + 0.6,
    }
  })
  const hits = [...panel.querySelectorAll('.hit')].map((h) => ({
    online: h.getAttribute('data-online') === '1', count: +h.getAttribute('data-count'),
    region: h.getAttribute('data-region'), index: +h.getAttribute('data-index'),
  }))
  const rows = panel.querySelector('.globe-rows')
  return JSON.stringify({
    labels, hits,
    pins: svg.querySelectorAll('.globe-pin').length,
    stems: svg.querySelectorAll('.globe-stem').length,
    links: svg.querySelectorAll('.globe-link').length,
    regs: [...panel.querySelectorAll('.globe-reg')].map((b) => b.querySelector('span').textContent + '|' + b.querySelector('b').textContent),
    rows: rows ? { clientH: rows.clientHeight, scrollH: rows.scrollHeight } : null,
    panelH: Math.round(panel.getBoundingClientRect().height),
  })
})()`

const open = async () => {
  await waitFor(`document.querySelector('.globe-panel svg .globe-label') !== null`, 25000)
  await sleep(600)
  const raw = await js(PROBE)
  return raw ? JSON.parse(raw) : null
}

/* ---------------------------------------------------------------- 一、桌面 1440 */
console.log('=== 一、桌面 1440：100 台（含 4 台离线）===')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
let s = await open()
check('地球面板画出来了（探针 sanity）', s && s.labels.length > 0 && s.pins > 0, s ? `针 ${s.pins} / 标签 ${s.labels.length}` : '探针拿不到')
if (s) {
  const L = s.labels.filter((l) => l.end), R = s.labels.filter((l) => !l.end)
  check('每枚可见针都可点（针 = 命中圆）', s.pins === s.hits.length, `${s.pins} vs ${s.hits.length}`)
  check('★ 两摞标签封顶：每侧 ≤ 14 行', L.length <= 14 && R.length <= 14, `左 ${L.length} / 右 ${R.length}`)
  check('★ 省掉的行不留引线（引线 = 标签 < 针）', s.stems === s.labels.length && s.labels.length < s.pins, `引线 ${s.stems} / 标签 ${s.labels.length} / 针 ${s.pins}`)
  check('★ 标签全在设计带里（y ∈ 12~204）', s.labels.every((l) => l.y >= 12 && l.y <= 204), JSON.stringify(s.labels.filter((l) => l.y < 12 || l.y > 204).map((l) => [l.text, l.y])))
  check('★ 没有被画布裁掉的标签', s.labels.every((l) => !l.clipped), JSON.stringify(s.labels.filter((l) => l.clipped).map((l) => l.text)))
  check('每侧标签互不重叠（y 不重复）', (() => { for (const side of [L, R]) { const ys = side.map((l) => l.y); if (new Set(ys).size !== ys.length) return false } return true })())
  check('★ 连线收口（可见针 ~40 枚时 ≤ 60 条）', s.links <= 60 && s.links > 0, `${s.links} 条（旧公式 87）`)
  const texts = s.labels.map((l) => l.text).join(' | ')
  check('★ 离线的与多台地区优先留（香港/东京/法兰克福/马尼拉四个都在）',
    ['Hong Kong', 'Tokyo', 'Frankfurt', 'Manila'].every((k) => texts.includes(k)), texts.slice(0, 160))
  check('★ 地区列表收进滚动区（桌面）', s.rows !== null && s.rows.scrollH > s.rows.clientH, s.rows ? `${s.rows.clientH} / ${s.rows.scrollH}` : '没有 .globe-rows')
  check('★ 面板不再被列表撑高（≤ 330px）', s.panelH <= 330, `${s.panelH}px（旧版 845）`)
  check('★ 马德里落在 Madrid（侧栏有 Madrid、全站没有 Delhi）',
    s.regs.some((r) => r.startsWith('Madrid|2')) && !s.regs.some((r) => r.includes('Delhi')), JSON.stringify(s.regs.filter((r) => /Madrid|Delhi/.test(r))))
  check('控制台无异常', errors.length === 0, errors.join(' | ').slice(0, 200))
  await shot('desktop.png')
}

/* ---------------------------------------------------------------- 二、手机 390 */
console.log('\n=== 二、手机 390：同样的机群 ===')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
s = await open()
check('手机上面板画出来了', s && s.labels.length > 0, s ? `标签 ${s.labels.length}` : '探针拿不到')
if (s) {
  check('★ 手机无横向溢出', (await js(`document.documentElement.scrollWidth`)) <= 391, `${await js(`document.documentElement.scrollWidth`)}`)
  check('★ 标签全在设计带里且不被裁', s.labels.every((l) => l.y >= 12 && l.y <= 204 && !l.clipped), JSON.stringify(s.labels.filter((l) => l.y < 12 || l.y > 204 || l.clipped).map((l) => l.text)))
  check('★ 地区列表在手机上同样收口（≤ 240px 滚动区）', s.rows !== null && s.rows.scrollH > s.rows.clientH && s.rows.clientH <= 240, s.rows ? `${s.rows.clientH} / ${s.rows.scrollH}` : '没有 .globe-rows')
  await shot('mobile.png')
}

console.log(`\n结果: PASS ${pass} / FAIL ${fail}（截图在 ${OUT}）`)
ws.close(); chrome.kill(); server.close()
process.exit(fail ? 1 : 0)

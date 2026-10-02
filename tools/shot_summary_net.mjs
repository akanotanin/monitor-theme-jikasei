// 「实时网速 / 今日流量」那行两列数字的候选排法对照图 + 几何表。
//
// 用法：cd <repo> && node tools/shot_summary_net.mjs [输出前缀=shots/netfit] [端口=5341]
//
// 为什么要有它：这一行是 `grid grid-cols-2` + `truncate`，两列各占卡片内容宽的一半，
// 而卡片在四列布局里最宽只有 299px（内容 265px）→ 每格最多 127px。24px 的
// 「1023.9 KB/s」要 122px、「1023.9 MB/s」要 129px，所以长读数一定会被静默截成
// 「112.6 K…」。候选排法用注入的 <style>（+ 一处 DOM 变换模拟「单位降档」）在同一份
// 真实标记与样式表上比较，每档都打印「格宽 / 需要多宽 / 截掉多少」，挑定后再落回代码。
//
// 候选（第一轮：挑出「单位降一档」= 现在的 now）：
//   now    现状（单位降一档已落地：数字 24px，「 KB/s」16px 弱化灰）
//   bp     四列断点从 lg(1024) 提到 xl(1280)：1024~1279 退回两列（卡片大得多）
//   unit   单位降一档（与 now 同义，第一轮的对照保留）
//   fs20   这一行字号 24px → 20px
//   bp+unit / bp+fs20  组合
//
// 候选（第二轮：在「单位降一档」之上继续收 1024~1279 那段）：
//   bp1160 四列断点改成「刚好够用」的 1160（只让 1024~1159 退回两列，比 1280 温和）
//   cq     容器查询自动缩字号：行宽不足时按 `clamp(1.2rem, 9.5cqw, 1.5rem)` 缩，
//          宽度够就仍是 24px（布局与断点都不动，只在窄四列下小 0~5px）
//   rate-int 读数口径：KB 档不给小数（112.6 → 113 KB/s）——字符串更短，字号不动
//   micro  几何微调：箭头 14→12px、图标间距 6→4px、两列间距 12→8px（共 +6~8px）
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PREFIX = process.argv[2] || 'shots/netfit'
const PORT = Number(process.argv[3] || 5341)
const CDP_PORT = PORT + 4000

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
}
const GB = 1024 ** 3
const KB = 1024

const metrics = (over) => ({
  uptime: 400000, cpu: 5, load: [0.1, 0.2, 0.3], mem_total: 2 * GB, mem_used: 1 * GB,
  swap_total: 0, swap_used: 0, disk_total: 40 * GB, disk_used: 10 * GB,
  net_rx: 0, net_tx: 0, total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0,
  tcp: 10, udp: 2, procs: 100, ...over,
})
const node = (id, name, over) => ({
  id, name, sort: id, public: true, online: true, country: '', group: '',
  last_seen: Math.floor(Date.now() / 1000) - 5, metrics: metrics({}),
  os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'EPYC',
  cpu_cores: 2, mem_total: 2 * GB, swap_total: 0, disk_total: 40 * GB,
  agent_version: '1.4.0', price: 0, currency: 'CNY', billing_cycle: 'monthly', expires_at: null,
  expires_in: null, traffic_limit: 0, traffic_mode: 'sum', traffic_reset_day: 1,
  total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0, month_start: '', day_rx: 0, day_tx: 0,
  ...over,
})

// 用户截图里那份读数：↓62.2 KB/s ↑112.6 KB/s
const REAL = { nodes: [node(1, '东京', { metrics: metrics({ cpu: 12.5, net_rx: 62.2 * KB, net_tx: 112.6 * KB }), day_rx: 1.25 * GB, day_tx: 0.75 * GB })] }
// 最坏形状：KB 档四位数（bytes(n,1) 在 [100,1024) 档给一位小数 → 1023.9 KB/s）
const WORST = { nodes: [node(1, '东京', { metrics: metrics({ cpu: 12.5, net_rx: 1023.9 * KB, net_tx: 1023.9 * KB }) })] }
const FIXTURES = { real: REAL, worst: WORST }

let fixture = 'real'
let config = { listTop: 'summary' }

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  const json = (body) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)) }
  if (path === '/__fixture') { fixture = url.searchParams.get('name') || 'real'; return json({ fixture }) }
  if (path === '/__config') { config = url.searchParams.get('listTop') ? { listTop: url.searchParams.get('listTop') } : {}; return json({ config }) }
  if (path.startsWith('/api/')) {
    if (path === '/api/me') return json({ authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: 'jikasei' })
    if (path === '/api/nodes') return json(FIXTURES[fixture])
    if (path.endsWith('/config')) return json(config)
    if (/^\/api\/nodes\/\d+\/metrics/.test(path)) return json({ ping: [], probes: {}, loss: {} })
    return json({})
  }
  const file = path === '/' ? '/index.html' : path
  const full = join('dist', normalize(file).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(full) || statSync(full).isDirectory()) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] })
    return res.end(readFileSync('dist/index.html'))
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(full)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(full))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p)) || 'chrome'
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--no-proxy-server', `--user-data-dir=${process.env.LOCALAPPDATA || '/tmp'}/Temp/shotnet${CDP_PORT}`,
  'about:blank',
], { stdio: 'ignore' })

let id = 0
const pending = new Map()
let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl
  } catch { /* 等 Chrome */ }
  if (!wsUrl) await sleep(250)
}
if (!wsUrl) throw new Error('Chrome 没起来')
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(`页面里报错：${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}`)
  return r.result?.result?.value
}

await send('Runtime.enable')
await send('Page.enable')

/* ---------------------------------------------------------------- 候选的注入 */

// ① 四列断点从 lg(1024) 提到 xl(1280)：1024~1279 这段退回两列。
const CSS_BP = `@media (min-width:1024px) and (max-width:1279px){
  .sm\\:grid-cols-2.lg\\:grid-cols-4{grid-template-columns:repeat(2,minmax(0,1fr))}
}`
// ② 这一行字号 24px → 20px（Tailwind text-xl）。
const CSS_FS20 = `[data-slot=card] > div > div.grid.grid-cols-2{font-size:20px;line-height:28px}`
// ④ 四列断点改成「刚好够用」的 1160（实测 1100 那档还差 7px、1152 才够）：只让
//    1024~1159 退回两列，比直接提到 1280 温和。
const CSS_BP1160 = `@media (min-width:1024px) and (max-width:1159px){
  .sm\\:grid-cols-2.lg\\:grid-cols-4{grid-template-columns:repeat(2,minmax(0,1fr))}
}`
// ⑤ 容器查询：把卡片内容盒当容器，行宽不够时按 cqw 缩字号——宽度够就仍是 24px，
//    布局、断点、字符串口径都不动。
const CSS_CQ = `[data-slot=card] > div{container-type:inline-size}
[data-slot=card] > div > div.grid.grid-cols-2{font-size:clamp(1.2rem, 9.5cqw, 1.5rem)}`
// 乙' 的下限更低（1024 那档要缩到 ~17.7px 才真放得下，代价是比同排另两张卡的 24px 明显小）。
const CSS_CQ2 = `[data-slot=card] > div{container-type:inline-size}
[data-slot=card] > div > div.grid.grid-cols-2{font-size:clamp(1.05rem, 9cqw, 1.5rem)}`
// ⑨ 容器查询切排法：卡片内容盒窄到放不下长读数时（<256px），两个方向竖排——
//    每个读数拿到整行宽度，任何读数都放得下；宽了就仍是并排。
const CSS_STACK = `[data-slot=card] > div{container-type:inline-size}
@container (max-width:255px){[data-slot=card] > div > div.grid.grid-cols-2{grid-template-columns:1fr;row-gap:2px}}`

// ⑥ 几何微调：箭头 14→12px、图标间距 6→4px、两列间距 12→8px。
const CSS_MICRO = `[data-slot=card] > div > div.grid.grid-cols-2{column-gap:8px}
[data-slot=card] > div > div.grid.grid-cols-2 > span{gap:4px}
[data-slot=card] > div > div.grid.grid-cols-2 svg{width:12px;height:12px}`
// ⑦ 读数口径：KB 档不给小数（模拟 rate() 改成整数 KB；MB 及以上不动）。
const RATE_INT = `(() => {
  let n = 0
  for (const v of document.querySelectorAll('[data-slot=card] > div > div.grid.grid-cols-2 > span')) {
    const t = v.querySelector('.truncate')
    if (!t) continue
    const m = t.innerText.match(/^([0-9]+)\\.([0-9]+) KB\\/s$/)
    if (!m) continue
    t.innerHTML = String(Math.round(parseFloat(m[1] + '.' + m[2]))) + '<span class="text-base font-normal text-muted-foreground"> KB/s</span>'
    n++
  }
  return n
})()`

// ③ 单位降档：数字保持 24px，单位与「/s」用小字弱化灰——DOM 变换，见 applyVariant()。
const VARIANTS = {
  now: { css: '', unit: false },
  bp: { css: CSS_BP, unit: false },
  unit: { css: '', unit: true },
  fs20: { css: CSS_FS20, unit: false },
  'bp+unit': { css: CSS_BP, unit: true },
  'bp+fs20': { css: CSS_BP, unit: false, fs20: true },
  bp1160: { css: CSS_BP1160 },
  cq: { css: CSS_CQ },
  'rate-int': { rateInt: true },
  'rate-cap': { rateCap: true },
  micro: { css: CSS_MICRO },
  cq2: { css: CSS_CQ2 },
  stack: { css: CSS_STACK },
}

/** 把「112.6 KB/s」拆成数字 + 小字单位：模拟「单位降一档」那种排法。 */
const SPLIT_UNIT = `(() => {
  const cells = [...document.querySelectorAll('[data-slot=card] > div > div.grid.grid-cols-2 > span')]
  let n = 0
  for (const v of cells) {
    const t = v.querySelector('.truncate')
    if (!t) continue
    const m = t.innerText.match(/^([0-9.,]+)\\s*([A-Za-z]+\\/s)$/)
    if (!m) continue
    t.innerHTML = m[1] + '<span class="text-base font-normal text-muted-foreground"> ' + m[2] + '</span>'
    n++
  }
  return n
})()`

// ⑧ 读数口径（更彻底）：封顶三位数字，KB 档整数、到 999.5 就进位到上一档两位小数
//    （1023.9 KB/s → 1.00 MB/s）——这样任何读数都不超过「999 KB/s」这个长度。
const RATE_CAP = `(() => {
  let n = 0
  const NEXT = { KB: 'MB', MB: 'GB', GB: 'TB' }
  for (const v of document.querySelectorAll('[data-slot=card] > div > div.grid.grid-cols-2 > span')) {
    const t = v.querySelector('.truncate')
    if (!t) continue
    const m = t.innerText.match(/^([0-9]+)\\.?([0-9]*) (KB|MB|GB)\\/s$/)
    if (!m) continue
    let val = parseFloat(m[1] + (m[2] ? '.' + m[2] : ''))
    let unit = m[3]
    if (val >= 999.5) { val = val / 1024; unit = NEXT[unit] }
    const num = unit === 'KB' ? String(Math.round(val)) : val.toFixed(val >= 100 ? 0 : 2)
    t.innerHTML = num + '<span class="text-base font-normal text-muted-foreground"> ' + unit + '/s</span>'
    n++
  }
  return n
})()`

/* ------------------------------------------------------------------ 量 + 拍 */

const PROBE = 'JSON.stringify((() => {' +
  'const TITLES=["今日流量","实时网速"];' +
  'const title=(c)=>{const t=c.firstElementChild&&c.firstElementChild.firstElementChild;return ((t&&t.textContent)||"").trim()};' +
  'return [...document.querySelectorAll("[data-slot=card]")].filter(c=>TITLES.includes(title(c))).map(c=>{' +
  '  const b=c.children[0];const row=b.children[1];const cr=c.getBoundingClientRect();' +
  '  const cells=[...row.children].map(v=>{const t=v.querySelector(".truncate")||v;' +
  '    return {text:t.innerText.trim(),cell:v.clientWidth,box:t.clientWidth,need:t.scrollWidth,clip:t.scrollWidth-t.clientWidth};});' +
  '  return {title:title(c),cardW:Math.round(cr.width),rowW:Math.round(row.getBoundingClientRect().width),' +
  '    fs:getComputedStyle(row).fontSize,cols:getComputedStyle(row).gridTemplateColumns,cells};' +
  '});' +
'})())'

const CARD_BOX = (t) => `(() => {
  const TITLES = ${JSON.stringify([t])}
  const title=(c)=>{const x=c.firstElementChild&&c.firstElementChild.firstElementChild;return ((x&&x.textContent)||"").trim()}
  const c=[...document.querySelectorAll('[data-slot=card]')].find((el)=>TITLES.includes(title(el)))
  if(!c) return null
  const r=c.getBoundingClientRect(); const pad=6
  return JSON.stringify({x:Math.max(0,r.x-pad),y:Math.max(0,r.y-pad+window.scrollY),width:r.width+pad*2,height:r.height+pad*2})
})()`

mkdirSync(PREFIX.split('/').slice(0, -1).join('/') || '.', { recursive: true })
const rows = []

async function shot(variantName, { fixtureName, width, cardTitle = '实时网速' }) {
  const v = VARIANTS[variantName]
  await fetch(`http://127.0.0.1:${PORT}/__fixture?name=${fixtureName}`)
  await fetch(`http://127.0.0.1:${PORT}/__config?listTop=summary`)
  await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 2, mobile: false })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?v=${variantName}&f=${fixtureName}&w=${width}&t=${Date.now()}` })
  for (let i = 0; i < 80; i++) {
    await sleep(200)
    const raw = await js(PROBE)
    if (!raw) continue
    const dom = JSON.parse(raw)
    if (dom.length === 2 && dom.every((c) => c.cells.length === 2 && c.cells.every((x) => x.text))) break
  }
  if (v.css) await js(`(() => { const s=document.createElement('style'); s.textContent=${JSON.stringify(v.css)}; document.head.append(s); return true })()`)
  if (v.fs20) await js(`(() => { const s=document.createElement('style'); s.textContent=${JSON.stringify(CSS_FS20)}; document.head.append(s); return true })()`)
  if (v.unit) {
    const n = await js(SPLIT_UNIT)
    if (!n) throw new Error(`候选 ${variantName}：一个格子都没拆开（选择器失配？）`)
  }
  if (v.rateInt) {
    const n = await js(RATE_INT)
    if (!n) throw new Error(`候选 ${variantName}：没有一条 KB 档读数被改写（夹具或选择器失配？）`)
  }
  if (v.rateCap) {
    const n = await js(RATE_CAP)
    if (!n) throw new Error(`候选 ${variantName}：没有一条速率读数被改写（夹具或选择器失配？）`)
  }
  await sleep(200)
  const dom = JSON.parse(await js(PROBE))
  const out = `${PREFIX}-${variantName}-${fixtureName}-${width}`
  const box = JSON.parse(await js(CARD_BOX(cardTitle)))
  if (!box) throw new Error('量不到卡片包围盒')
  const image = await send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1.5 } })
  writeFileSync(`${out}.png`, Buffer.from(image.result.data, 'base64'))
  const net = dom.find((c) => c.title === '实时网速')
  const day = dom.find((c) => c.title === '今日流量')
  rows.push({ variantName, fixtureName, width, net, day, out })
  console.log(`${variantName.padEnd(8)} ${fixtureName.padEnd(5)} w=${String(width).padStart(4)}  卡${String(net.cardW).padStart(4)}px 行${String(net.rowW).padStart(4)}px 字号${net.fs.padStart(4)}  ` +
    `网速 ${net.cells.map((c) => `${c.text}［格${c.cell}／文字框${c.box}／需${c.need}／${c.clip > 0 ? `截掉${c.clip}` : `余${-c.clip}`}］`).join(' ')}`)
  console.log(`         → ${out}.png  裁切 ${Math.round(box.width)}×${Math.round(box.height)} @3×`)
}

// 第二轮：问题区间 1024（最窄的四列）/ 1100 各来一遍
for (const variantName of ['now', 'bp1160', 'cq2', 'rate-cap', 'stack']) {
  await shot(variantName, { fixtureName: 'real', width: 1024 })
  await shot(variantName, { fixtureName: 'worst', width: 1024 })
}
for (const variantName of ['now', 'cq2', 'rate-cap', 'stack']) {
  await shot(variantName, { fixtureName: 'real', width: 1100 })
}
await shot('stack', { fixtureName: 'real', width: 1440 })
await shot('stack', { fixtureName: 'real', width: 640 })
// 常见宽度下的成品（丁 改过箭头尺寸与列距，宽屏也要留一张）
await shot('now', { fixtureName: 'real', width: 1440 })
await shot('now', { fixtureName: 'worst', width: 1440 })

ws.close()
chrome.kill()
server.close()

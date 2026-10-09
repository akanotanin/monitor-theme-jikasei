// 延迟页签的时间范围护栏：断言「网络延迟」页签能选到 7 天，并且真的按 168 小时取回数据。
//
// 用法：
//   node tools/verify_latency_range.mjs <baseUrl> <outPrefix> [节点id]
//   例：node tools/verify_latency_range.mjs https://<站点> shots/latency-range 3
//
// 为什么要有它：延迟页签的范围是 `RANGES_FOR.latency` 单独限定的，而「资源」页签一直有 7 天——
// 只盯着资源页看，会以为 7 天本来就在。所以这里两个页签都读一遍：资源页是**对照组**
// （本来就有 7 天），延迟页是**目标**。改动前跑必须 FAIL 在延迟页那条上。
//
// 判据不写绝对毫秒，只认「点下去之后真的发出了 hours=168 且 series=ping 的请求、且回 200」
// 与「图上真的画出了线、没有错误文案」——这三件事分别盯住 UI、请求、渲染。
//
// 站点在 Cloudflare 后面时，需要走本机代理（PROXY 环境变量，默认 127.0.0.1:2080）；
// baseUrl 是本机地址（127.0.0.1/localhost）时不加代理。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const BASE = (process.argv[2] || 'http://127.0.0.1:28081').replace(/\/$/, '')
const OUT = process.argv[3] || 'shots/latency-range'
const NODE_ID = process.argv[4] || ''
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(BASE)
const PROXY = process.env.PROXY || (LOCAL ? '' : 'http://127.0.0.1:2080')
const PORT = 9700 + Math.floor(Math.random() * 60)
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p)) || 'chrome'

mkdirSync(OUT, { recursive: true })

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  ...(PROXY ? [`--proxy-server=${PROXY}`] : []),
  // 每次都用全新的 profile：旧副本（index.html 是 no-cache、chunk 带哈希）会让人以为改动没生效。
  '--user-data-dir=' + (process.env.LOCALAPPDATA || '/tmp') + '/Temp/latencyrange' + PORT,
  'about:blank',
], { stdio: 'ignore' })

let id = 0
const pending = new Map()
let wsUrl = null
for (let i = 0; i < 60 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl
  } catch { /* 等 Chrome 起来 */ }
  if (!wsUrl) await sleep(300)
}
if (!wsUrl) throw new Error('Chrome 没起来')
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJS = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value

await send('Page.enable')
await send('Runtime.enable')
// 固定视口：改前/改后要同机位，默认的 800×600 会让两轮证据对不上。
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
const errors = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text)
})

let fails = 0
const check = (label, ok, detail = '') => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  |  ' + detail : ''}`)
}

// 找一台在线节点：优先用命令行给的 id，否则取接口里第一台在线的。
// ★ 先确认 baseUrl 真的打得开：隧道会死（默认那条 28081 就常死），死的时候页面停在
//   about:blank，后面 `fetch('/api/nodes')` 的失败会被 CDP 折成一句 "[object Object]"、
//   再让 JSON.parse 崩掉 —— 看着像工具坏了，其实只是 base 打不开（2026-10-09 修）。
const nav = await send('Page.navigate', { url: BASE + '/' })
if (nav.result?.errorText) {
  console.log(`FAIL  baseUrl 打不开：${BASE}（${nav.result.errorText}）——隧道死了就重开一条再跑`)
  ws.close(); chrome.kill(); process.exit(1)
}
await sleep(6000)
const picked = await evalJS(`(async () => {
  try {
    const r = await fetch('/api/nodes', { cache: 'no-store' })
    const j = await r.json()
    const nodes = Array.isArray(j) ? j : (j.nodes || [])
    const want = ${NODE_ID ? JSON.stringify(String(NODE_ID)) : 'null'}
    const n = want ? nodes.find((x) => String(x.id) === want) : nodes.find((x) => x.online)
    return n ? JSON.stringify({ id: n.id, name: n.name, online: !!n.online }) : ''
  } catch { return '' }
})()`)
check('取到一台节点（/api/nodes 可达）', !!picked && picked.startsWith('{'), picked || '接口没回节点')
if (!picked || !picked.startsWith('{')) { ws.close(); chrome.kill(); process.exit(1) }
const node = JSON.parse(picked)
console.log(`      节点：${node.name}（id ${node.id}，online=${node.online}）`)

await send('Page.navigate', { url: `${BASE}/node/${node.id}` })
for (let i = 0; i < 60; i++) { await sleep(400); if (await evalJS(`!![...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '网络延迟')`)) break }

// 范围按钮 = 文本形如「N 小时 / N 天」的那排胶囊；两个页签各读一遍。
const rangeLabels = () => `[...document.querySelectorAll('button')]
  .map((b) => b.textContent.trim())
  .filter((t) => /^\\d+ (小时|天)$/.test(t))`

const openTab = async (label) => {
  await evalJS(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click()`)
  await sleep(2500)
}

// 1.16.0 起量程按 hub 的保留天数生成（1 / 6 / 24 小时一直都在，够得着才多出 7 天、30 天与
// 保留天数本身）。所以这里不再写死「四枚」——那会在默认保留 30 天的 hub 上把**正确的实现**
// 报成 FAIL（实测 5 枚：1 小时 / 6 小时 / 24 小时 / 7 天 / 30 天）。判据换成**不变量**：
// 前三档都在；每一枚都不超过保留天数；7 天只在这条线够得着时出现；保留天数本身那枚在。
const me = await (await fetch(`${BASE}/api/me`)).json()
const days = typeof me.history_days === 'number' ? Math.min(365, Math.max(1, Math.floor(me.history_days))) : 7
const cap = days * 24
const hoursOf = (t) => Number(t.split(' ')[0]) * (t.endsWith('小时') ? 1 : 24)
const rangeOk = (list) =>
  ['1 小时', '6 小时', '24 小时'].every((t) => list.includes(t)) &&
  list.every((t) => hoursOf(t) <= cap) &&
  (days >= 7 ? list.includes('7 天') : !list.includes('7 天')) &&
  (days > 7 ? list.includes(`${days} 天`) : true) &&
  list.length <= 6
const why = `hub 保留 ${days} 天（history_days=${JSON.stringify(me.history_days)}）`

// 对照组：资源页在改动前就该是 PASS，用来证明护栏不是在瞎报。
await openTab('资源')
const resources = JSON.parse(await evalJS(`JSON.stringify(${rangeLabels()})`))
check(`资源页签的量程按保留天数生成（对照组）—— ${why}`, rangeOk(resources), resources.join(' '))

await openTab('网络延迟')
const latency = JSON.parse(await evalJS(`JSON.stringify(${rangeLabels()})`))
check(`延迟页签的量程按保留天数生成（目标）—— ${why}`, rangeOk(latency), latency.join(' '))
check('延迟页签的「削峰」开关仍在', await evalJS(`!![...document.querySelectorAll('label')].find((l) => l.textContent.trim() === '削峰')`))

// 范围行（含削峰）截一张，用作改前/改后同机位对照。
const clipOf = async (expr) => {
  const box = await evalJS(`(() => { const el = ${expr}; if (!el) return ''; const r = el.getBoundingClientRect(); return JSON.stringify({ x: Math.floor(r.left) - 8, y: Math.floor(r.top) - 8, width: Math.ceil(r.width) + 16, height: Math.ceil(r.height) + 16, scale: 2 }) })()`)
  return box ? JSON.parse(box) : null
}
const shotAt = async (file, clip) => {
  const png = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' })
  writeFileSync(file, Buffer.from(png.result.data, 'base64'))
}
const ROW = `[...document.querySelectorAll('button')][0]?.closest('div.flex.flex-wrap') || [...document.querySelectorAll('button')].find((b) => /^\\d+ (小时|天)$/.test(b.textContent.trim()))?.parentElement?.parentElement`
await shotAt(`${OUT}/row-before-click.png`, await clipOf(ROW))

// 目标：点「7 天」必须真的按 168 小时、ping 系列去取数。
const has7 = latency.includes('7 天')
if (has7) {
  // 只看这次点击之后新出现的请求。
  await evalJS(`window.__perfMark = performance.getEntriesByType('resource').length`)
  await evalJS(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '7 天')?.click()`)
  let hit = null
  for (let i = 0; i < 40 && !hit; i++) {
    await sleep(500)
    const raw = await evalJS(`(() => {
      const all = performance.getEntriesByType('resource').slice(window.__perfMark)
      const m = all.filter((e) => e.name.includes('/metrics?') && e.name.includes('hours=168'))
      return m.length ? JSON.stringify({ url: m[m.length - 1].name, status: m[m.length - 1].responseStatus ?? 0, n: m.length }) : ''
    })()`)
    if (raw) hit = JSON.parse(raw)
  }
  check('点「7 天」发出了 hours=168 的取数请求', !!hit, hit ? `${hit.n} 条，例：${hit.url.replace(BASE, '')}` : '没看到 hours=168 的请求')
  check('该请求带 series=ping 且回 200', !!hit && hit.url.includes('series=ping') && hit.status === 200, hit ? `series=ping=${hit.url.includes('series=ping')} status=${hit.status}` : '')
  // 图上真的画了线：自绘图表里就是带 stroke-width 的那条 <path>。
  // 一个都选不到——这是本护栏第一版红的真正原因，别改回去。
  const drawn = await evalJS(`JSON.stringify({
    // ★这里原来读的是 recharts 的类名（path.recharts-curve / .recharts-xAxis-tick-labels text）。
    //   延迟图换成自绘 SVG（src/components/Chart.tsx）之后那些类名整批消失，判据会**静默变成 0**
    //   —— 改读自家图表那张 svg 里的结构与文字（曲线带 stroke-width、x 刻度 text-anchor=middle、
    //   y 刻度 text-anchor=end）。这正是仓库里那句「按类名找会在改版后失配」。
    curves: document.querySelectorAll('svg[aria-label="节点延迟走势"] path[stroke-width="1.5"]').length,
    ticks: [...document.querySelectorAll('svg[aria-label="节点延迟走势"] text')].filter((t) => t.getAttribute('text-anchor') === 'middle').map((t) => t.textContent).slice(0, 6),
    ytick: [...document.querySelectorAll('svg[aria-label="节点延迟走势"] text')].filter((t) => t.getAttribute('text-anchor') === 'end').map((t) => t.textContent).slice(0, 3),
    texts: [...document.querySelectorAll('svg[aria-label="节点延迟走势"] text')].map((t) => t.textContent).slice(0, 20),
  })`)
  const d = JSON.parse(drawn)
  // 日期刻度形如「09/28 15:30」、24 小时内的刻度是纯「15:30」，两者靠有没有日期段区分。
  // 正则一律写成 [0-9]，不用 \\d —— 表达式要经 node 的模板字面量再进页面，反斜杠层数一多就会
  // 变成匹配字面量反斜杠，而它恒假（这里踩过：断言红了却看着像选择器的问题）。
  const hasDate = (t) => /[0-9]{1,2}[\/-][0-9]{1,2}/.test(t)
  const clockOnly = (t) => /^[0-9]{1,2}:[0-9]{2}$/.test(t)
  check('7 天窗口画出了曲线', d.curves > 0, `curves=${d.curves}`)
  check('x 轴按日期打刻度（不是 24 小时内的时刻）', d.ticks.length > 0 && d.ticks.every(hasDate) && !d.ticks.some(clockOnly), `ticks=${d.ticks.join(' ')} | 全部文本=${d.texts.join(' ')}`)
  check('y 轴有 ms 刻度', d.ytick.length > 0 && d.ytick.every((t) => t.endsWith('ms')), `y=${d.ytick.join(' ')}`)
  // 错误文案与「这段时间没有延迟数据」都是失败态。
  const bad = await evalJS(`document.body.innerText.includes('读取历史数据失败') || document.body.innerText.includes('这段时间没有延迟数据')`)
  check('没有失败/空数据文案', !bad)
  await sleep(500)
  await shotAt(`${OUT}/row-after-click.png`, await clipOf(ROW))
  await shotAt(`${OUT}/panel-latency-168.png`, null)
} else {
  console.log('SKIP  延迟页签没有 7 天，后面的请求/渲染断言无从跑起（这就是改动前的预期形态）')
  await shotAt(`${OUT}/panel-latency.png`, null)
}

check('页面无 JS 异常', errors.length === 0, errors.slice(0, 3).join(' | '))
console.log(`\n${fails ? `FAIL ${fails} 条` : 'ALL PASS'}  截图在 ${OUT}/`)
ws.close()
chrome.kill()
process.exit(fails ? 1 : 0)

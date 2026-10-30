// 验「机器特别多」时两枚明细浮层的表现（2026-10-31，站长：「还需要考虑到机器特别多的情况下的
// 显示效果哦」）。
//
// 用法：node tools/verify_many_nodes.mjs [台数=120] [port=5327]
//
// 三条机器一多就会露馅的地方，都只能拿真台数在真视口里量：
//   ① 浮层再长也不许吊出视口：高度上限 min(24rem, 60vh) 生效；这一行贴着视口下沿时**向上翻**；
//   ② 一百多行滚到底，还得知道自己在看什么：表头（「· N 台」）与尾巴（口径）不跟着滚走，
//      只有中间那节滚；最后一行滚到底要完整可见；
//   ③ 收口规则：预算只列前 48 条 + 一行「其余 N 台」（数字闭合）；「今日流量」只列流量最大的
//      48 台（列出来的每一台都有峰值，不再出现几十行「—」），尾巴写明共多少台。
//
// 判据全走 DOM 文本 / 矩形 / 计数，不靠看图。
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const N = Number(process.argv[2] || 120)
const PORT = Number(process.argv[3] || 5327)
const CDP_PORT = PORT + 4000

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
}

const KB = 1024
const GB = 1024 ** 3
const metrics = (over) => ({
  uptime: 400000, cpu: 5, load: [0.1, 0.2, 0.3], mem_total: 2 * GB, mem_used: 1 * GB,
  swap_total: 0, swap_used: 0, disk_total: 40 * GB, disk_used: 10 * GB,
  net_rx: 0, net_tx: 0, total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0,
  tcp: 10, udp: 2, procs: 100, ...over,
})

/** 第 i 台的桩：名字、今日流量、价格、到期全都各不相同（排序与收口才验得出来）。 */
function nodeAt(i) {
  const online = i % 10 !== 0
  return {
    id: i, name: i === 3 ? 'Node 003 一台名字特别特别长的机器用来试截断与列宽' : `Node ${String(i).padStart(3, '0')}`,
    sort: i, public: true, online, country: ['JP', 'US', 'DE'][i % 3], group: ['美国', '欧洲', '亚洲'][i % 3],
    last_seen: Math.floor(Date.now() / 1000) - 5,
    metrics: online ? metrics({ cpu: (i * 7) % 100, net_rx: ((i % 9) + 1) * 64 * KB, net_tx: ((i % 5) + 1) * 32 * KB }) : null,
    os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'Xeon',
    cpu_cores: 2, mem_total: 2 * GB, swap_total: 0, disk_total: 40 * GB,
    agent_version: '1.4.0',
    price: 3 + (i % 17) * 2.5, currency: i % 2 ? 'USD' : 'EUR', billing_cycle: 'monthly',
    expires_at: null, expires_in: 5 + (i % 40), traffic_limit: 0, traffic_mode: 'sum', traffic_reset_day: 1,
    total_rx: i * GB, total_tx: i * GB, month_rx: 0, month_tx: 0, month_start: '',
    // 今日流量：随 id 单调递减，前 48 台就是 i=1..48（正好能对上「只列最大的 48 台」）
    day_rx: (N + 1 - i) * 0.37 * GB, day_tx: (N + 1 - i) * 0.11 * GB,
  }
}

const nodes = Array.from({ length: N }, (_, k) => nodeAt(k + 1))

/** 每台都给两桶采样（峰值 = 桶里的 max，时刻 = 桶的 ts）。 */
function peaksFor(id) {
  const at = (h, m) => Math.floor(new Date().setHours(h, m, 0, 0) / 1000)
  return [
    { ts: at(1, 0), net_rx: 1 * KB, net_tx: 1 * KB, net_rx_max: (id % 7 + 1) * 1024 * KB, net_tx_max: (id % 5 + 1) * 1024 * KB },
    { ts: at(2, 0), net_rx: 1 * KB, net_tx: 1 * KB, net_rx_max: 512 * KB, net_tx_max: 256 * KB },
  ]
}

/** 桩被问过多少次历史（判「只给 48 台取峰值」）。 */
const hits = new Map()

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  const json = (body) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  if (path.startsWith('/api/')) {
    if (path === '/api/me') return json({ authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '多机校验' })
    if (path === '/api/nodes') return json({ nodes })
    if (path.endsWith('/config')) return json({})
    if (path === '/api/version') return json({ version: '1.4.0' })
    if (/^\/api\/nodes\/\d+\/metrics/.test(path)) {
      const id = Number(path.split('/')[3])
      // 只数「取峰值」那种（series=metrics）；卡片自己取延迟是 series=ping，不算。
      if (url.searchParams.get('series') === 'metrics') hits.set(id, (hits.get(id) || 0) + 1)
      const rows = url.searchParams.get('series') === 'metrics' ? peaksFor(id) : []
      return json({ metrics: rows, ping: [], probes: {}, loss: {} })
    }
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

/* ------------------------------------------------------------------ 浏览器 */

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((p) => existsSync(p)) || 'chrome'

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--no-proxy-server',
  `--user-data-dir=${process.env.LOCALAPPDATA || '/tmp'}/Temp/many${CDP_PORT}`,
  'about:blank',
], { stdio: 'ignore' })

let id = 0
const pending = new Map()
let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl
  } catch { /* 等 Chrome 起来 */ }
  if (!wsUrl) await sleep(250)
}
if (!wsUrl) throw new Error('Chrome 没起来')
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJS = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
// headless 里页面没有焦点，focus() 不派发事件（同 verify_summary 的注释）——上面那行就是为它开的。
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.removeItem('jikasei:fx') } catch {}
const __f = window.fetch.bind(window)
window.fetch = (u, o) => (String(u).startsWith('http') && !String(u).startsWith(location.origin))
  ? Promise.reject(new Error('stub: offsite blocked')) : __f(u, o)`,
})

const results = []
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`) }

async function boot(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  for (let i = 0; i < 80; i++) {
    await sleep(300)
    if ((await evalJS(`document.querySelectorAll('[data-node-card]').length`)) >= 1) return
  }
  throw new Error('页面没渲染出节点卡片')
}

/** 打开某一块读数（默认「月度预算」）的浮层，读几何与三段。 */
const readPop = (title) => evalJS(`(async () => {
  const b = [...document.querySelectorAll('[tabindex="0"]')].find((x) => x.innerText.startsWith(${JSON.stringify(title)}))
  if (!b) return null
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
  await new Promise((r) => setTimeout(r, 60))
  b.focus()
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 100))
    const d = b.querySelector('[data-budget-detail]')
    if (d && !/读取中/.test(d.innerText)) break
  }
  const d = b.querySelector('[data-budget-detail]')
  if (!d) return null
  const sc = d.querySelector('[data-detail-scroll]')
  const head = d.querySelector('[data-detail-head]')
  const foot = d.querySelector('[data-detail-foot]')
  const rows = [...d.querySelectorAll('[data-budget-row], [data-traffic-row]')]
  const rest = d.querySelector('[data-budget-rest]')
  const r = d.getBoundingClientRect()
  const br = b.getBoundingClientRect()
  const cs = getComputedStyle(d)
  return {
    flipped: d.hasAttribute('data-flip'),
    rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height) },
    blockRect: { top: Math.round(br.top), bottom: Math.round(br.bottom) },
    maxHeight: cs.maxHeight,
    vp: { w: innerWidth, h: innerHeight },
    rows: rows.length,
    rowTexts: rows.map((x) => x.innerText.replace(/\\n/g, ' | ')),
    restText: rest ? rest.innerText.replace(/\\n/g, ' | ') : null,
    headText: head ? head.innerText.replace(/\\n/g, ' | ') : null,
    footText: foot ? foot.innerText.replace(/\\n/g, ' | ') : null,
    scroll: sc ? { clientH: sc.clientHeight, scrollH: sc.scrollHeight, overflowY: getComputedStyle(sc).overflowY } : null,
    fade: !!sc?.hasAttribute('data-detail-more'),
    text: d.innerText.replace(/\\n/g, ' | '),
    scrollToEnd: (() => { if (!sc) return null; sc.scrollTop = sc.scrollHeight; return sc.scrollTop })(),
  }
})()`)

/** 滚到底之后再读一次：表头还在不在、最后一行是否完整、尾巴是否可见。 */
const readAfterScroll = (title) => evalJS(`(async () => {
  await new Promise((r) => setTimeout(r, 200))   // 等 scroll 事件回来、React 提交那一次 setState
  const b = [...document.querySelectorAll('[tabindex="0"]')].find((x) => x.innerText.startsWith(${JSON.stringify(title)}))
  const d = b && b.querySelector('[data-budget-detail]')
  if (!d) return null
  const sc = d.querySelector('[data-detail-scroll]')
  const head = d.querySelector('[data-detail-head]')
  const foot = d.querySelector('[data-detail-foot]')
  const popR = d.getBoundingClientRect()
  const scR = sc.getBoundingClientRect()
  const headR = head.getBoundingClientRect()
  const footR = foot.getBoundingClientRect()
  const rows = [...d.querySelectorAll('[data-budget-row], [data-traffic-row]')]
  const last = rows[rows.length - 1]
  const lastR = last ? last.getBoundingClientRect() : null
  return {
    fade: !!sc?.hasAttribute('data-detail-more'),
    scrollTop: Math.round(sc.scrollTop),
    headInside: headR.top >= popR.top - 1 && headR.bottom <= popR.bottom + 1,
    headAtTop: Math.abs(headR.top - popR.top) <= 6,
    footVisible: footR.bottom <= popR.bottom + 1 && footR.top >= scR.bottom - 1,
    footInsidePop: footR.top >= popR.top - 1,
    lastRowVisible: !!lastR && lastR.bottom <= scR.bottom + 1 && lastR.top >= scR.top - 1,
    popBottom: Math.round(popR.bottom), vpH: innerHeight,
  }
})()`)

const WIDE = { width: 1440, height: 900 }
const TALL = { width: 1440, height: 420 }      // 矮窗口：60vh 仍会顶穿屏幕下沿的那一档
const PHONE = { width: 390, height: 844 }

/* 1) 宽屏：预算浮层 */
await boot(WIDE.width, WIDE.height)
let pop = await readPop('月度预算')
check('多机·预算：浮层开得出来', !!pop, pop ? `${pop.rows} 行` : '没有浮层')
check(`多机·预算：只列前 48 条（共 ${N} 台）`, pop?.rows === Math.min(N, 48),
  `${pop?.rows} 行（应 ${Math.min(N, 48)}）`)
check('多机·预算：表头写真实台数', /台$/.test(pop?.headText || '') && (pop?.headText || '').includes(`${N} 台`), pop?.headText)
check('多机·预算：末尾有「其余 N 台」收口行', N > 48 ? /其余 \d+ 台/.test(pop?.restText || '') : pop?.restText === null, pop?.restText)
check('多机·预算：高度不超过 min(24rem, 60vh)', !!pop && pop.rect.h <= Math.min(384, Math.round(pop.vp.h * 0.6)) + 1,
  `${pop?.rect.h}px（上限 ${Math.min(384, Math.round((pop?.vp.h ?? 0) * 0.6))}px）`)
check('多机·预算：明细那节自己滚（overflow-y auto）', pop?.scroll?.overflowY === 'auto', pop?.scroll?.overflowY)
check('多机·预算：内容比窗口长（真的在滚）', !!pop?.scroll && pop.scroll.scrollH > pop.scroll.clientH + 40,
  `scrollH=${pop?.scroll?.scrollH} / clientH=${pop?.scroll?.clientH}`)
check('多机·预算：向下弹时整块落在视口里', !!pop && pop.rect.bottom <= pop.vp.h + 1 && pop.rect.top >= 0,
  `top=${pop?.rect.top} bottom=${pop?.rect.bottom} 视口 ${pop?.vp.h}`)

check('多机·预算：滚得动的时候有「下面还有」的渐隐', !!pop?.fade, String(pop?.fade))

const after = await readAfterScroll('月度预算')
check('多机·预算：滚到底后表头还在原位（没跟着滚走）', !!after && after.headInside && after.headAtTop,
  JSON.stringify(after))
check('多机·预算：滚到底后尾巴可见、且贴在浮层底', !!after && after.footVisible, JSON.stringify(after))
check('多机·预算：滚到底后最后一行完整可见', !!after && after.lastRowVisible, JSON.stringify(after))
check('多机·预算：滚到底后渐隐条收起（不再暗示还有）', !!after && after.fade === false, `fade=${after?.fade}`)

/* 金额闭合：列出的 48 条 + 其余 ≈ 卡片面那个合计 */
const closure = await evalJS(`(() => {
  const card = [...document.querySelectorAll('[data-slot=card]')].find((c) => c.innerText.startsWith('月度预算'))
  // 大数字是卡里那个 text-2xl（浮层也在卡里，按 .tnum 取会先撞上明细行）
  const big = Number(card.querySelector('.text-2xl').innerText.replace(/[^0-9.]/g, ''))
  const d = [...document.querySelectorAll('[data-budget-detail]')][0]
  // 金额一律取**行里最后一个 span**（名字里也有数字，整行扒数字就废了）
  const amount = (r) => Number((r.lastElementChild?.innerText || '').replace(/[^0-9.]/g, ''))
  const rows = [...d.querySelectorAll('[data-budget-row]')].map(amount)
  const restEl = d.querySelector('[data-budget-rest]')
  return JSON.stringify({ big, shown: rows.reduce((a, b) => a + b, 0), rest: restEl ? amount(restEl) : 0, rows: rows.length })
})()`)
const cl = JSON.parse(closure ?? '{}')
check('多机·预算：列出的 48 条 + 其余 = 卡片合计（差 ≤ 0.5 元，逐行四舍五入所致）',
  Math.abs((cl.shown ?? 0) + (cl.rest ?? 0) - (cl.big ?? 0)) <= 0.5,
  `${(cl.shown ?? 0).toFixed(2)} + ${(cl.rest ?? 0).toFixed(2)} vs ${(cl.big ?? 0).toFixed(2)}`)

/* 2) 宽屏：今日流量浮层 */
const traffic = await readPop('今日流量')
check(`多机·流量：只列今日流量最大的 48 台（共 ${N} 台）`, traffic?.rows === Math.min(N, 48), `${traffic?.rows} 行`)
check('多机·流量：表头写真实台数', (traffic?.headText || '').includes(`${N} 台`), traffic?.headText)
check('多机·流量：尾巴写明「共 N 台，只列…」', /共 \d+ 台，只列今日流量最大的 \d+ 台/.test(traffic?.footText || ''), traffic?.footText)
check('多机·流量：列出来的每一台都有峰值（没有一片「—」）',
  !!traffic && traffic.rowTexts.every((t) => !t.includes('—') && !t.includes('读取中')),
  traffic?.rowTexts.slice(0, 2).join(' / '))
check('多机·流量：历史请求只发给列出来的那些台', hits.size === Math.min(N, 48),
  `问过 ${hits.size} 台（应该 ${Math.min(N, 48)} 台）`)

/* 3) 矮窗口：按剩余空间压低，不吊出屏幕 */
await boot(TALL.width, TALL.height)
const cramped = await readPop('月度预算')
check('多机·矮窗：浮层压在视口里（不吊出下沿）', !!cramped && cramped.rect.bottom <= cramped.vp.h + 1 && cramped.rect.top >= -1,
  cramped ? `top=${cramped.rect.top} bottom=${cramped.rect.bottom} 视口高 ${cramped.vp.h}` : '没有浮层')
check('多机·矮窗：高度按剩余空间压（比 384 的常规上限矮）', !!cramped && cramped.rect.h < 384 && cramped.rect.h >= 120,
  `${cramped?.rect.h}px`)
check('多机·矮窗：压矮之后仍在滚（不是截断）', !!cramped?.scroll && cramped.scroll.scrollH > cramped.scroll.clientH,
  `scrollH=${cramped?.scroll?.scrollH} / clientH=${cramped?.scroll?.clientH}`)

/* 4) 手机：两枚浮层都不出屏 */
await boot(PHONE.width, PHONE.height)
for (const title of ['月度预算', '今日流量']) {
  const p = await readPop(title)
  check(`多机·手机：${title}浮层不出屏`, !!p && p.rect.right <= p.vp.w + 1 && p.rect.left >= -1 &&
    p.rect.top >= -1 && p.rect.bottom <= p.vp.h + 1,
    p ? `left=${p.rect.left} right=${p.rect.right} top=${p.rect.top} bottom=${p.rect.bottom} 视口 ${p.vp.w}×${p.vp.h}` : '没有浮层')
}

const fail = results.filter((r) => !r.ok)
console.log(`\n${results.length - fail.length} PASS / ${fail.length} FAIL`)
ws.close()
chrome.kill()
server.close()
process.exit(fail.length ? 1 : 0)

// 详情 chunk 的预热方式验收：静态走本机 dist/，数据走真 hub。
// 图表锚点用 `[data-chart]`（自绘 TimeChart 挂的），别再按 recharts 的类名找。
//
// 用法：ssh -f -N -L 28085:127.0.0.1:28080 <hub 那台机器>
//       node tools/verify_detail_preload.mjs http://127.0.0.1:28085 [节点id]
//
// 要证的四件事（前两件在改动前必然 FAIL，这就是反向自测）：
//   ① 冷启动时这块 chunk 不在首屏关键路径上：它的请求时刻晚于入口包下完与 /api/nodes 返回；
//      ② 空闲预热仍然会取它（不是干脆不取）——列表画完之后由浏览器挑空闲时取；
//   ③ 悬停到卡片上会立刻取它（这一天就该保住的「点开→图表」体感）；
//   ④ 点开时那块骨架屏的高度 == 详情页加载完的高度（否则会先塌再撑）；
//   ⑤ 直接落在 /node/{id}（书签、刷新）时立刻取，不等列表那条路。
// 判定一律用数字与网络事件，不看截图。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const UPSTREAM = process.argv[2]
const NODE_ID = process.argv[3] || '1'
const ONLY = process.argv[4] || ''
if (!UPSTREAM) { console.error('用法：node tools/verify_detail_preload.mjs <上游 hub 地址> [节点id] [只跑哪个用例:1|2|3]'); process.exit(2) }

const PORT = 5310 + Math.floor(Math.random() * 200)
const server = spawn('node', ['tools/serve.mjs', String(PORT), '{}', '', UPSTREAM], { stdio: ['ignore', 'pipe', 'pipe'] })
let serverLog = ''
server.stdout.on('data', (d) => { serverLog += d })
server.stderr.on('data', (d) => { serverLog += d })
const base = `http://127.0.0.1:${PORT}`
let up = false
for (let i = 0; i < 40 && !up; i++) { await sleep(300); try { up = (await fetch(`${base}/api/me`)).ok } catch { /* 等它起来 */ } }
if (!up) { console.error('本地伺服没起来：\n' + serverLog); server.kill(); process.exit(2) }
const wantNodes = (await (await fetch(`${base}/api/nodes`)).json()).nodes?.length ?? 0
console.log(`本地伺服装好：${base}（静态 = 本机 dist/，/api/* → ${UPSTREAM}，上游 ${wantNodes} 台）\n`)

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p)) || 'chrome'
const PORT_DBG = 9400 + Math.floor(Math.random() * 300)
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT_DBG}`, '--remote-allow-origins=*', '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/verify-detail-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
let ws = null
for (let i = 0; i < 80 && !ws; i++) {
  try { ws = (await (await fetch(`http://127.0.0.1:${PORT_DBG}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { /* 再等 */ }
  if (!ws) await sleep(250)
}
if (!ws) { console.error('Chrome 没起来'); chrome.kill(); server.kill(); process.exit(2) }
const sock = new WebSocket(ws)
await new Promise((r) => { sock.onopen = r })
let id = 0
const pending = new Map()
const errs = []
sock.onmessage = (m) => {
  const x = JSON.parse(m.data)
  if (x.id && pending.has(x.id)) { pending.get(x.id)(x.result); pending.delete(x.id); return }
  if (x.method === 'Runtime.exceptionThrown') errs.push(x.params.exceptionDetails.text)
}
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })) })
const js = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')

// 页面内自记：性能观察器抓那块 chunk、5ms 轮询问骨架与图表、以及空闲预热的调用次数。
// 骨架的取法**不认类名**：在详情路由上、第一张图出来之前，`main` 的最后一个子元素就是加载中
// 那一块（`h-96` 那枚 Skeleton，或按真实几何摆的骨架）；它一旦长出 h2 就说明详情已经渲染，
// 不再采样。**必须限定在 `/node/` 路由上**：点击到详情挂载之间那几毫秒里 `main` 的最后一个
// 子元素还是列表本身（手机上七张卡片摞起来近 1900px），拿它当骨架会量出一个假高度。
// stubIdle 时 requestIdleCallback 被换成永不回调的桩 —— 这样「悬停/点击触发了下载」才是干净的证据。
const probeSource = (stubIdle) => `(function () {
  window.__m = { cards: null, chunkMs: null, chunkCount: 0, skeletonMax: 0, skeletonAt: null, chart: null, idleCalls: 0, idleRequests: [], hoverAt: null, clickAt: null, enters: 0, navAt: performance.now() }
  document.addEventListener('pointerover', function (e) { if (e.target && e.target.closest && e.target.closest('[data-slot="card"][role="button"], table tbody tr[role="button"]')) window.__m.enters++ }, true)
  // 「列表出现」用 MutationObserver 记（dom 一变就是它），别用 5ms 轮询：主线程忙的时候
  // 那个轮询自己会被推后两百多毫秒，于是把「画完才取 chunk」误判成「取在画之前」。
  try {
    new MutationObserver(function () {
      if (window.__m.cards === null && document.querySelector('[data-slot="card"][role="button"], table tbody tr[role="button"]')) window.__m.cards = Math.round(performance.now())
    }).observe(document.documentElement, { childList: true, subtree: true })
  } catch (e) {}
  if (!${stubIdle}) {
    const ric = window.requestIdleCallback
    window.requestIdleCallback = function (cb, opt) { window.__m.idleRequests.push(Math.round(performance.now())); return ric.call(window, cb, opt) }
  }
  ${stubIdle ? `window.requestIdleCallback = function () { window.__m.idleCalls++; return 1 }
  window.cancelIdleCallback = function () {}` : ''}
  try {
    new PerformanceObserver(function (list) {
      for (const e of list.getEntries()) if (/NodeDetail-/.test(e.name)) { window.__m.chunkCount++; if (window.__m.chunkMs === null) window.__m.chunkMs = Math.round(e.startTime) }
    }).observe({ type: 'resource', buffered: true })
  } catch (e) {}
  setInterval(function () {
    if (window.__m.cards === null && document.querySelector('[data-slot="card"][role="button"], table tbody tr[role="button"]')) window.__m.cards = Math.round(performance.now())
    if (window.__m.chart === null && location.pathname.indexOf('/node/') === 0) {
      const main = document.querySelector('main')
      const el = main && main.lastElementChild
      if (el && !el.querySelector('h2')) {
        const h = Math.round(el.getBoundingClientRect().height)
        if (h > window.__m.skeletonMax) { window.__m.skeletonMax = h; window.__m.skeletonCls = String(el.className).slice(0, 60) }
        window.__m.skeletonAt = Math.round(performance.now())
      }
    }
    if (window.__m.chart === null && document.querySelector('[data-chart]')) window.__m.chart = Math.round(performance.now())
  }, 5)
})()`

let scriptId = null
async function load({ width, height, mobile, stubIdle, wait = 9000 }) {
  if (scriptId) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }).catch(() => {})
  scriptId = (await send('Page.addScriptToEvaluateOnNewDocument', { source: probeSource(stubIdle) })).identifier
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile })
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  await send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 256000, uploadThroughput: 65536 })
  await send('Page.navigate', { url: `${base}/?case=${Math.random().toString(36).slice(2)}` })
  const deadline = Date.now() + 40000
  while (Date.now() < deadline) { await sleep(200); if (await js('window.__m && window.__m.cards !== null')) break }
  await sleep(wait)
  return JSON.parse(await js('JSON.stringify(window.__m)'))
}
const res = async () => JSON.parse(await js(`JSON.stringify(performance.getEntriesByType('resource').map(e => ({ n: e.name.replace(location.origin, ''), t: Math.round(e.startTime), d: Math.round(e.duration), b: e.transferSize })))`))
const cardBox = async () => JSON.parse(await js(`(() => { const el = document.querySelector('[data-slot="card"][role="button"], table tbody tr[role="button"]'); if (!el) return 'null'; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + Math.min(r.width / 2, 60)), y: Math.round(r.y + Math.min(18, r.height / 2)) }) })()`))
const clickAt = async ({ x, y }) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

const results = []
const check = (ok, label, detail = '') => { results.push({ ok: !!ok, label, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  —  ' + detail : ''}`) }
/** 调试时只跑一个用例：第三个参数传 1 / 2 / 3。 */
const want = (n) => ONLY === '' || ONLY === String(n)
let m, box

// ── ① 冷启动：chunk 不该压在首屏关键路径上（首屏的入口包与第一批数据下完之前不许取），
//      但列表画出来之后仍要由空闲预热把它取回来
if (want(1)) {
  console.log('── 用例 1：冷启动（不悬停、不点击）')
  m = await load({ width: 1280, height: 900, mobile: false, stubIdle: false })
  const entries = await res()
  const chunk = entries.find((e) => /NodeDetail-/.test(e.n))
  const entry = entries.find((e) => /\/assets\/index-.*\.js$/.test(e.n))
  const nodesApi = entries.find((e) => e.n === '/api/nodes')
  const entryEnd = entry ? entry.t + entry.d : null
  const nodesEnd = nodesApi ? nodesApi.t + nodesApi.d : null
  const beforeCards = entries.filter((e) => e.t < (m.cards ?? 1e9)).reduce((a, b) => a + (b.b || 0), 0)
  const critical = entries.filter((e) => e === entry || /\.css$/.test(e.n) || e.n === '/api/nodes' || e.n === '/api/me').reduce((a, b) => a + (b.b || 0), 0)
  console.log(`  列表卡片 ${m.cards}ms 出现；详情 chunk 首次请求 ${m.chunkMs === null ? '（从未）' : m.chunkMs + 'ms'}（共 ${m.chunkCount} 次）`)
  console.log(`  入口包下完 ${entryEnd}ms、/api/nodes 返回 ${nodesEnd}ms、空闲预热登记于 ${JSON.stringify(m.idleRequests)}；关键请求合计 ${(critical / 1024).toFixed(0)}KB，含 chunk 的整页 ${(entries.reduce((a, b) => a + (b.b || 0), 0) / 1024).toFixed(0)}KB（列表出现前已发出 ${(beforeCards / 1024).toFixed(0)}KB）`)
  check(m.chunkMs !== null, '空闲预热仍然取到了这块 chunk（不是干脆不取）')
  check(m.chunkMs === null || (nodesEnd !== null && m.chunkMs >= nodesEnd), '节点数据回来之后才取它（不再和第一批数据抢那条链路）', `chunk=${m.chunkMs ?? '未取'}ms / /api/nodes=${nodesEnd}ms`)
  check(m.chunkMs === null || (entryEnd !== null && m.chunkMs >= entryEnd), '入口包下完之后才取它（不再和入口包抢那条链路，这一条改动前是碰运气）', `chunk=${m.chunkMs ?? '未取'}ms / 入口包下完=${entryEnd}ms`)
  check(chunk && chunk.t === m.chunkMs, '性能条目与 chunk 记录一致（护栏本身看得见这块 chunk）', `entry=${chunk?.t ?? '无'}ms`)
  const cards = await js(`document.querySelectorAll('[data-slot="card"][role="button"], table tbody tr[role="button"]').length`)
  check(cards === wantNodes, '列表卡片数 == 上游节点数（渲染结果没退化）', `${cards} / ${wantNodes}`)
}

// ── ② 悬停：空闲预热被打桩，只有悬停能让它开始下载
if (want(2)) {
  console.log('\n── 用例 2：悬停到卡片上（空闲预热已打桩）')
  m = await load({ width: 1280, height: 900, mobile: false, stubIdle: true, wait: 600 })
  check(m.chunkCount === 0 && m.idleCalls >= 1, '悬停之前一次都没取过该 chunk（空闲预热已打桩：它被调用过，但永远不回调）', `chunk=${m.chunkCount} / idle 桩调用=${m.idleCalls}`)
  box = await cardBox()
  const hit = await js(`(() => { const el = document.elementFromPoint(${box.x}, ${box.y}); return el ? (el.tagName + '.' + String(el.className).slice(0, 40)) : 'null' })()`)
  await js('window.__m.hoverAt = Math.round(performance.now())')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  // 轮询等它出现：这块 chunk 经限速要 1.5s 才下完，而性能条目是在下载结束时才入账的；
  // 固定等 1.5s 会把它判成「没取」，那是护栏自己的假红。
  for (let i = 0; i < 30; i++) { await sleep(200); m = JSON.parse(await js('JSON.stringify(window.__m)')); if (m.chunkMs !== null) break }
  console.log(`  悬停坐标 ${box.x},${box.y} 命中 ${hit}；卡片 pointerover 事件 ${m.enters} 次`)
  check(m.chunkCount >= 1, '悬停之后立刻开始取该 chunk', `悬停后 ${m.chunkMs - m.hoverAt}ms 发出`)
  check(m.chunkMs >= m.hoverAt, '这块 chunk 确实是悬停之后才请求的（不是开页时就取了）', `chunk=${m.chunkMs}ms / hover=${m.hoverAt}ms`)
  check(m.chunkMs - m.hoverAt <= 800, '悬停到发起请求 ≤ 800ms', `${m.chunkMs - m.hoverAt}ms`)
}

// ── ③ 未预热就点开：骨架几何 + 点击→图表
if (want(3)) for (const [w, h, mobile, tag] of [[390, 844, true, '手机 390×844'], [1280, 900, false, '桌面 1280×900']]) {
  console.log(`\n── 用例 3（${tag}）：没预热就点开，量骨架屏`)
  m = await load({ width: w, height: h, mobile, stubIdle: true, wait: 400 })
  await js('window.__m.skeletonMax = 0')
  box = await cardBox()
  await js('window.__m.clickAt = Math.round(performance.now())')
  await clickAt(box)
  const deadline = Date.now() + 40000
  while (Date.now() < deadline) { await sleep(200); if (await js('window.__m.chart !== null')) break }
  const raw = JSON.parse(await js('JSON.stringify(window.__m)'))
  const loaded = await js(`(() => { const h2 = document.querySelector('main h2'); if (!h2) return null; return Math.round(h2.parentElement.parentElement.getBoundingClientRect().height) })()`)
  const charts = await js(`document.querySelectorAll('[data-chart]').length`)
  console.log(`  骨架可见高度 ${raw.skeletonMax}px（停留到 ${raw.skeletonAt}ms）；点开→图表 ${raw.chart === null ? '未画出' : raw.chart - raw.clickAt + 'ms'}；加载完内容高 ${loaded}px、图表 ${charts} 张`)
  check(raw.skeletonMax > 0, `${tag} 点开时出现详情骨架（不是白屏）`)
  check(loaded !== null && Math.abs(raw.skeletonMax - loaded) <= 24, `${tag} 骨架高度 ≈ 加载完的高度（±24px）`, `骨架 ${raw.skeletonMax}px / 实际 ${loaded}px`)
  check(raw.chart !== null && charts > 0, `${tag} 点开后真的画出了图表`, `${charts} 张`)
}

// ── ④ 开页就在详情页（书签 / 刷新 / 别人分享的链接）：立刻取，不等列表
if (want(4)) {
  console.log(`\n── 用例 4：直接打开 /node/${NODE_ID}（详情路由本来就是它）`)
  // load() 里导航的是站点首页，这一条要自己导航到详情路由。
  if (scriptId) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }).catch(() => {})
  scriptId = (await send('Page.addScriptToEvaluateOnNewDocument', { source: probeSource(false) })).identifier
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false })
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  await send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 256000, uploadThroughput: 65536 })
  await send('Page.navigate', { url: `${base}/node/${NODE_ID}` })
  const deadline = Date.now() + 40000
  while (Date.now() < deadline) { await sleep(200); if (await js('window.__m && window.__m.chart !== null')) break }
  m = JSON.parse(await js('JSON.stringify(window.__m)'))
  const e4 = await res()
  const nodes4 = e4.find((e) => e.n === '/api/nodes')
  const chart4 = await js(`document.querySelectorAll('[data-chart]').length`)
  console.log(`  chunk 首次请求 ${m.chunkMs}ms（/api/nodes 返回 ${nodes4 ? nodes4.t + nodes4.d : '?'}ms）；图表 ${chart4} 张`)
  check(m.chunkMs !== null && nodes4 && m.chunkMs < nodes4.t + nodes4.d, '直接落在详情页时立刻取它（不等节点列表那条路）', `chunk=${m.chunkMs}ms / /api/nodes=${nodes4 ? nodes4.t + nodes4.d : '?'}ms`)
  check(m.chart !== null && chart4 > 0, '详情页正常画出来了（书签/刷新这条路没退化）', `${chart4} 张`)
}

// ── ⑤ 先悬停（预热）再点开：这是「点开→图表」的对照档，量它才说得出体感的取舍
if (want(5)) {
  const [w, h, mobile, tag] = [390, 844, true, '手机 390×844']
  console.log(`\n── 用例 5（${tag}）：先悬停预热，再点开（对照档）`)
  m = await load({ width: w, height: h, mobile, stubIdle: true, wait: 600 })
  box = await cardBox()
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  for (let i = 0; i < 30; i++) { await sleep(200); if ((await js('window.__m.chunkMs')) !== null) break }
  const warmMs = await js('window.__m.chunkMs')
  await js('window.__m.chart = null')
  box = await cardBox()
  await js('window.__m.clickAt = Math.round(performance.now())')
  await clickAt(box)
  const deadline = Date.now() + 40000
  while (Date.now() < deadline) { await sleep(200); if (await js('window.__m.chart !== null')) break }
  const raw = JSON.parse(await js('JSON.stringify(window.__m)'))
  const charts = await js(`document.querySelectorAll('[data-chart]').length`)
  console.log(`  悬停已取回 chunk（${warmMs}ms）；点开→图表 ${raw.chart === null ? '未画出' : raw.chart - raw.clickAt + 'ms'}（同一机位下，未预热那一档见用例 3）`)
  check(charts > 0, `${tag} 悬停预热之后点开，详情照样画出来（预热这条路没把 UI 弄坏）`, `${charts} 张`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n合计 ${results.length - failed.length} PASS / ${failed.length} FAIL` + (errs.length ? `；控制台异常 ${errs.length} 条：${errs.slice(0, 3).join(' | ')}` : '；控制台无异常'))
console.log(`本地伺服日志：${serverLog.trim().split('\n').slice(-2).join(' / ') || '(无)'}`)
sock.close(); chrome.kill(); server.kill()
process.exit(failed.length ? 1 : 0)

// 现网（真站 + 真 CDN）发版后的验收：详情 chunk 的预热时机、取的是不是这一版、页面画没画出来。
//
// 用法：node tools/check_live.mjs <站点URL> [期望的 chunk 文件名]
//   例：node tools/check_live.mjs https://<站点> NodeDetail-XXXXXXXX.js
//       （期望的文件名从本地 dist/assets/ 取，用来证明「公网取到的就是本地构建的那块」）
//
// 为什么要有它：`tools/verify_detail_preload.mjs` 验的是「本机 dist + 真数据」，跑在部署之前；
// 这一份跑在部署之后，对着**真的站点、真的 CDN**再确认一遍：那块 chunk 仍然是「节点数据回来之后」
// 才起跑（不是又回到和首屏抢链路）、文件哈希对得上、列表与详情都画得出来、控制台无异常。
// 站点在 CDN 后面时浏览器要走本机代理（与手工 curl 的 --noproxy 相对），这是本机策略决定的。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const SITE = (process.argv[2] || '').replace(/\/$/, '')
if (!SITE) { console.error('用法：node tools/check_live.mjs <站点URL> [期望的 chunk 文件名]'); process.exit(2) }
const WANT_CHUNK = process.argv[3] || ''
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p)) || 'chrome'
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9998', '--remote-allow-origins=*', '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--window-size=1280,900', '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/live-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
let ws = null
for (let i = 0; i < 80 && !ws; i++) {
  try { ws = (await (await fetch('http://127.0.0.1:9998/json/list')).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch {}
  if (!ws) await sleep(250)
}
if (!ws) { console.error('Chrome 没起来'); chrome.kill(); process.exit(2) }
const sock = new WebSocket(ws); await new Promise((r) => { sock.onopen = r })
let id = 0; const pending = new Map(); const errs = []; const net = []
sock.onmessage = (m) => {
  const x = JSON.parse(m.data)
  if (x.id && pending.has(x.id)) { pending.get(x.id)(x.result); pending.delete(x.id); return }
  if (x.method === 'Runtime.exceptionThrown') errs.push(x.params.exceptionDetails.text)
  if (x.method === 'Network.requestWillBeSent') net.push(x.params.request.url)
}
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })) })
const js = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(function () {
  window.__m = { cards: null, chunkUrl: null, chunkMs: null, chunkCount: 0, idleRequests: [], chart: null, clickAt: null, enters: 0, wsFirst: null }
  document.addEventListener('pointerover', function (e) { if (e.target && e.target.closest && e.target.closest('[data-slot="card"][role="button"], table tbody tr[role="button"]')) window.__m.enters++ }, true)
  // ★ observe 的目标必须是 **document**，不能是 document.documentElement：这段脚本在
  //   document 创建后、解析前执行，此时 documentElement 还是 null —— observe(null) 抛
  //   TypeError 并被下面的 catch 吞掉，这个观察器**从来没生效过**（m.cards 恒 null、
  //   打印成「卡片 nullms 出现」；2026-10-12 实测，改成 document 后正常记录）。
  //   verify_detail_preload 里同款观察器还配了一个 5ms 轮询兜底，所以那个脚本没暴露。
  try { new MutationObserver(function () { if (window.__m.cards === null && document.querySelector('[data-slot="card"][role="button"], table tbody tr[role="button"]')) window.__m.cards = Math.round(performance.now()) }).observe(document, { childList: true, subtree: true }) } catch (e) {}
  const ric = window.requestIdleCallback
  window.requestIdleCallback = function (cb, opt) { window.__m.idleRequests.push(Math.round(performance.now())); return ric.call(window, cb, opt) }
  // WS 首帧（数据另一条路）：HTTP 与 WS 并发，慢链路上谁先到都可能，判据要取较早者，
  // 所以这里把它的到达时刻也记下来（回调时刻＝数据对 JS 可用的时刻）。
  try {
    const OWS = window.WebSocket
    window.WebSocket = class extends OWS {
      constructor(...a) { super(...a); this.addEventListener('message', () => { if (window.__m.wsFirst === null) window.__m.wsFirst = Math.round(performance.now()) }) }
    }
  } catch (e) {}
  try { new PerformanceObserver(function (l) { for (const e of l.getEntries()) if (/NodeDetail-/.test(e.name)) { window.__m.chunkCount++; if (window.__m.chunkMs === null) { window.__m.chunkMs = Math.round(e.startTime); window.__m.chunkUrl = e.name } } }).observe({ type: 'resource', buffered: true }) } catch (e) {}
  setInterval(function () { if (window.__m.chart === null && document.querySelector('[data-chart]')) window.__m.chart = Math.round(performance.now()) }, 5)
})()` })
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Page.navigate', { url: SITE + '/' })
for (let i = 0; i < 150; i++) { await sleep(200); if (await js('window.__m && window.__m.cards !== null')) break }
await sleep(7000)
const m = JSON.parse(await js('JSON.stringify(window.__m)'))
const perf = JSON.parse(await js(`JSON.stringify(performance.getEntriesByType('resource').map(e => ({ n: e.name.replace(location.origin,''), t: Math.round(e.startTime), d: Math.round(e.duration), b: e.transferSize })))`))
const nodes = perf.find((e) => e.n === '/api/nodes')
const cards = await js(`document.querySelectorAll('[data-slot="card"][role="button"], table tbody tr[role="button"]').length`)
const title = await js('document.title')
console.log(`  站点 ${SITE}  标题「${title}」`)
// 「不与首屏数据抢链路」的锚用**数据完成时刻**：HTTP（resource timing —— 网络栈记录，不受主线程
// 影响）与 WS 首帧（回调时刻＝数据对 JS 可用的时刻）取**较早者**。两条路并发，慢链路上谁先到都
// 可能：只认 HTTP 会在 WS 先到时误报（实测 chunk 5788ms vs HTTP 5816ms）。
// ★ 别拿 MutationObserver 记录的时刻当锚 —— 它的回调是微任务、会被主线程长任务整体延误
// （同一批数据里实测偏差 545ms：chunk 3758ms 而记录的「卡片出现」4245ms，卡片其实早已上屏）。
// （const 有 TDZ：这两个量在下面的打印行里先用到，所以声明在这里。）
const httpDone = nodes ? nodes.t + nodes.d : null
const dataDone = [httpDone, m.wsFirst].filter((v) => typeof v === 'number').sort((a, b) => a - b)[0] ?? null
console.log(`  卡片 ${m.cards}ms 出现（${cards} 台）｜HTTP 完成 ${httpDone ?? '?'}ms｜WS 首帧 ${m.wsFirst ?? '?'}ms｜chunk 首次请求 ${m.chunkMs}ms`)
console.log(`  chunk 文件：${m.chunkUrl ? m.chunkUrl.replace(SITE, '') : '(未取)'}｜空闲预热登记 ${JSON.stringify(m.idleRequests)}`)
const ok1 = m.chunkCount > 0 && dataDone !== null && m.chunkMs >= dataDone
console.log(`  ${ok1 ? 'PASS' : 'FAIL'}  现网上：详情 chunk 在节点数据回来之后才取（不再和首屏数据抢链路）`)
const ok2 = !WANT_CHUNK || (m.chunkUrl || '').includes(WANT_CHUNK)
console.log(`  ${ok2 ? 'PASS' : 'FAIL'}  取的是这一版构建的那块 chunk（期望含 ${WANT_CHUNK}）`)
console.log(`  ${cards > 0 ? 'PASS' : 'FAIL'}  列表渲染出来了（${cards} 台）`)
// 点开一台机器
const box = JSON.parse(await js(`(() => { const el = document.querySelector('[data-slot="card"][role="button"], table tbody tr[role="button"]'); if (!el) return 'null'; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return JSON.stringify({x: Math.round(r.x + Math.min(r.width/2, 60)), y: Math.round(r.y + Math.min(18, r.height/2))}) })()`))
await js('window.__m.clickAt = Math.round(performance.now())')
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
for (let i = 0; i < 150; i++) { await sleep(200); if (await js('window.__m.chart !== null')) break }
const raw = JSON.parse(await js('JSON.stringify(window.__m)'))
const charts = await js(`document.querySelectorAll('[data-chart]').length`)
console.log(`  ${charts > 0 ? 'PASS' : 'FAIL'}  点开一台机器后画出了图表（${charts} 张，点击→图表 ${raw.chart === null ? '未画出' : raw.chart - raw.clickAt + 'ms'}）`)
const iconReqs = net.filter((u) => /favicon|apple-touch/.test(u))
console.log(`  图标请求：${JSON.stringify([...new Set(iconReqs.map((u) => u.replace(SITE, '')))])}`)
console.log(`  控制台异常：${errs.length ? errs.slice(0, 3).join(' | ') : '无'}`)
sock.close(); chrome.kill()
const failed = [!ok1, !ok2, !(cards > 0), !(charts > 0), errs.length > 0].filter(Boolean).length
process.exit(failed ? 1 : 0)

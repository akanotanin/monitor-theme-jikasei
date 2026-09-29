// 部署前的真机冒烟：静态 = 本机刚构建的 dist/，/api/* 转给真 hub（经隧道）。
//
// 用法：ssh -f -N -L 28085:127.0.0.1:28080 <hub 那台机器>
//       node tools/check_real_hub.mjs http://127.0.0.1:28085
//
// 看三件事：① 真 hub 的 /api/me 与主题设置下，标题/图标两处都对 ② 刷新时标签页首帧
// 就是站名、没有占位值闪过（innerHTML 内联那段的来源记成 inline）③ 控制台无异常。
// 静态走本机是为了把隧道对静态文件的那点干扰分开；数据仍是真的。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const UPSTREAM = process.argv[2]
const PORT = 5399
const server = spawn('node', ['tools/serve.mjs', String(PORT), '', '', UPSTREAM], { stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
server.stdout.on('data', (d) => { log += d })
server.stderr.on('data', (d) => { log += d })
let up = false
for (let i = 0; i < 40 && !up; i++) { await sleep(300); try { up = (await fetch(`http://127.0.0.1:${PORT}/api/nodes`)).ok } catch {} }
if (!up) { console.error('本地伺服没起来：\n' + log); server.kill(); process.exit(2) }
const base = `http://127.0.0.1:${PORT}`
console.log(`本地伺服装好：${base}（静态 = 本机 dist/，/api/* → ${UPSTREAM}）`)
const me = await (await fetch(`${base}/api/me`)).json()
const cfg = await (await fetch(`${base}/api/themes/jikasei/config`)).json()
console.log(`真 hub 的 /api/me: ${JSON.stringify(me)}\n真 hub 的主题设置: ${JSON.stringify(cfg)}`)

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p)) || 'chrome'
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9993', '--remote-allow-origins=*', '--no-first-run',
  '--disable-gpu', '--hide-scrollbars', '--window-size=1280,900', '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/realhub-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
let ws = null
for (let i = 0; i < 80 && !ws; i++) {
  try { ws = (await (await fetch('http://127.0.0.1:9993/json/list')).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch {}
  if (!ws) await sleep(250)
}
const sock = new WebSocket(ws)
await new Promise((r) => { sock.onopen = r })
let id = 0
const pending = new Map()
const errs = []
const iconReqs = []
sock.onmessage = (m) => {
  const x = JSON.parse(m.data)
  if (x.id && pending.has(x.id)) { pending.get(x.id)(x.result); pending.delete(x.id); return }
  if (x.method === 'Runtime.exceptionThrown') errs.push(x.params.exceptionDetails.text)
  if (x.method === 'Network.requestWillBeSent' && /site-icon|favicon/.test(x.params.request.url)) iconReqs.push(new URL(x.params.request.url).pathname)
}
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })) })
const js = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(function () {
  var t0 = performance.now(), last = null
  window.__titleLog = []
  setInterval(function () {
    var t = document.title
    if (t !== last) { last = t; window.__titleLog.push(Math.round(performance.now()) + 'ms ' + JSON.stringify(t)) }
  }, 5)
})()` })

for (const round of [1, 2]) {
  errs.length = 0; iconReqs.length = 0
  await send(round === 1 ? 'Page.navigate' : 'Page.reload', round === 1 ? { url: `${base}/` } : {})
  await sleep(9000)
  const d = JSON.parse(await js(`JSON.stringify({
    log: window.__titleLog,
    titleSource: window.__titleProbeSource ?? '(未设)',
    iconSource: window.__iconProbeSource ?? '(未设)',
    settledAt: window.__iconSettledAt ?? null,
    headerIcon: (() => { const i = document.querySelector('header img'); return i ? i.getAttribute('src') : null })(),
    favicon: document.querySelector('link[rel~="icon"]')?.getAttribute('href') ?? null,
    touch: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href') ?? null,
    ls: (() => { var o = {}; try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); o[k] = localStorage.getItem(k) } } catch (e) {} return o })(),
  })`))
  console.log(`\n=== 第 ${round} 次加载（${round === 1 ? '冷' : '热'}）===`)
  console.log('  标题: ' + d.log.join('  |  '))
  console.log(`  标题来源=${d.titleSource}  图标来源=${d.iconSource}  顶栏站标=${d.headerIcon}  favicon=${d.favicon}  touch=${d.touch}`)
  console.log(`  缓存=${JSON.stringify(d.ls)}  图标请求=[${iconReqs.join(', ')}]  控制台异常=${errs.length ? errs.join(' | ') : '无'}`)
}
sock.close(); chrome.kill(); server.kill()

// 真站视觉确认：连着抓几张（地球在自转，几张就是几个角度）。
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const URL = process.argv[2] || 'http://127.0.0.1:7980'
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p))
const dbg = 9950 + Math.floor(Math.random() * 9)
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, '--remote-allow-origins=*', '--no-first-run',
  '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900', '--proxy-server=http://127.0.0.1:2080',
  '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/live-shot-' + dbg + '-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
let ws = null
for (let i = 0; i < 120 && !ws; i++) {
  try { ws = (await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { }
  if (!ws) await sleep(250)
}
let id = 0
const pend = new Map()
const sock = new WebSocket(ws)
await new Promise((r) => { sock.onopen = r })
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); sock.send(JSON.stringify({ id: i, method: m, params: p })) })
sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
await send('Runtime.enable'); await send('Page.enable')
await send('Page.navigate', { url: URL })
await sleep(6000)
mkdirSync('shots/globe-live', { recursive: true })
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
const stats = await js(`(() => JSON.stringify({
  pins: [...document.querySelectorAll('circle.hit')].map((c) => ({ node: c.getAttribute('data-node'), region: c.getAttribute('data-region'), count: c.getAttribute('data-count') })),
  badges: [...document.querySelectorAll('text.globe-count')].map((e) => e.textContent),
  labels: [...document.querySelectorAll('text.globe-label')].map((e) => e.textContent),
  regions: [...document.querySelectorAll('button.globe-reg')].map((b) => b.textContent.trim()),
}))()`)
console.log('真站针数：' + JSON.parse(stats).pins.length + ' 枚；台数小字：' + JSON.stringify(JSON.parse(stats).badges) + '；带 × 的标签：' + JSON.stringify(JSON.parse(stats).labels.filter((l) => l.includes('×'))))
console.log('地区行：' + JSON.parse(stats).regions.join(' / '))
for (let i = 0; i < 3; i += 1) {
  const shot = (await send('Page.captureScreenshot', { format: 'png' })).result?.data
  if (shot) writeFileSync(`shots/globe-live/${i}.png`, Buffer.from(shot, 'base64'))
  await sleep(4000)
}
console.log('真站截图 3 张 → shots/globe-live/')
chrome.kill()
process.exit(0)

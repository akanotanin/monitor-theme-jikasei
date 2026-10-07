// 给「陆海配色」改前/改后拍同机位对照图：本机伺服 dist + 桩节点，冻住自转、拖到指定视角，
// 再按地球画布的元素框截一张 2× 的图。
// 用法：node shot_globe_view.mjs <输出.png> [相机经度 相机纬度]
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const OUT = process.argv[2] || 'shots/globe-colors/view.png'
const LON = Number(process.argv[3] ?? 200)
const LAT = Number(process.argv[4] ?? 60)
const PORT = 5215
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }
const mk = (id, name, country, region, lat, lon) => ({ id, name, country, group: '', region, lat, lon, os: 'Debian 12', cpu_name: 'EPYC', cpu_cores: 2, mem_total: 2147483648, disk_total: 42949672960, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, online: true })
// 与站长那台一样的分布（北极 / 北美 / 东亚），视角落在他截图那一带
const NODES = { nodes: [
  mk('a', 'Demo Anchorage', 'US', 'US · Anchorage', 61.2, -149.9),
  mk('b', 'Demo Seattle', 'US', 'US · Seattle', 47.6, -122.3),
  mk('c', 'Demo Tokyo', 'JP', 'JP · Tokyo', 35.7, 139.7),
  mk('d', 'Demo Frankfurt', 'DE', 'DE · Frankfurt', 50.1, 8.7),
] }

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  if (path.startsWith('/api/')) {
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '' }
      : path === '/api/nodes' ? NODES : path.endsWith('/config') ? { listTop: 'none', cardStyle: 'plain', globeOn: true } : {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] })
    return res.end(readFileSync('dist/index.html'))
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p)) || 'chrome'
const dbg = 9996
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, '--remote-allow-origins=*', '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--window-size=1280,900', '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/globeview-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 100 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { }
  if (!wsUrl) await sleep(300)
}
let id = 0
const pending = new Map()
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const js = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
await send('Runtime.enable'); await send('Page.enable')
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
for (let i = 0; i < 60; i++) { await sleep(250); if (await js('!!document.querySelector(".globe-atlas svg")')) break }
await sleep(1500)
const dx = Math.round((80 - LON) / 0.48)
const dy = Math.round((LAT - 30) / 0.36)
await js(`(() => {
  const el = document.querySelector('.globe-atlas')
  const r = el.getBoundingClientRect()
  const x = r.x + r.width / 2, y = r.y + r.height / 2
  const mk = (t, cx, cy) => new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: cx, clientY: cy, buttons: 1 })
  el.dispatchEvent(mk('pointerdown', x, y)); el.dispatchEvent(mk('pointermove', x + ${dx}, y + ${dy})); el.dispatchEvent(mk('pointerup', x + ${dx}, y + ${dy}))
  return true })()`)
await sleep(1200)
const box = JSON.parse(await js(`JSON.stringify((() => { const s = document.querySelector('.globe-atlas svg'); const r = s.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height, cap: document.querySelector('.globe-caption')?.textContent } })())`))
const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 2 }, captureBeyondViewport: true })
mkdirSync(OUT.split('/').slice(0, -1).join('/') || '.', { recursive: true })
writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'))
console.log(`${OUT}  ${Math.round(box.w * 2)}×${Math.round(box.h * 2)}  caption=${box.cap}`)
ws.close(); chrome.kill(); server.close()

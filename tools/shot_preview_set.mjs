// 拍 README 画廊用的那几张预览图（面板缩略图是 preview.png，由 preview-cover.mjs 生成）：
//   ① preview-globe.png   桌面 1440 下的「节点地球」整块（含右侧地区列表）
//   ② preview-globe-dark.png  同一块的深色版（明暗双色那一句的对照）
//   ③ preview-mobile.png  手机 390×844@2x 的列表页首屏
//
// 用法：node tools/shot_preview_set.mjs [输出目录=仓库根]
//
// 为什么要这一份（而不是直接对着现网拍）：
//   1. 公开仓库里的预览图**不能带真实机器名/IP**——这里用 tools/globe-nodes-fixture.json 那套
//      中性演示数据（「测试节点 · 城市」口径），拍出来的图可以直接进 README。
//   2. 只桩 /api/* 的伺服会让页面顶部挂「实时连接中断」的提示条，而且它是自己会消失的——
//      同一份代码早晚两张图，一张干净一张带条。所以这里做**最小 WebSocket 握手**（见技能
//      references/default-change-preview-shot.md 第 1 节）：握手成功、不推任何数据。
//   3. 视口按内容量、裁剪按**量出来的几何**（先 getBoundingClientRect 再 clip），不猜坐标。
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const OUTDIR = (process.argv[2] || '.').replace(/\/$/, '')
const PORT = 5212
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }
const NODES = JSON.parse(readFileSync('tools/globe-nodes-fixture.json', 'utf8'))
const CONFIG = { listTop: 'bothBudget', cardStyle: 'detailed', remarkPlacement: 'both', pingLines: '', globeOn: true, themeMode: 'system' }

const server = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  // 最小 WebSocket 握手：不推数据，但让页面认为连上了（否则顶部会挂重连提示条）
  if (path === '/api/ws' && (req.headers.upgrade || '').toLowerCase() === 'websocket') {
    const key = req.headers['sec-websocket-key'] || ''
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    res.writeHead(101, { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Accept': accept })
    const keep = setInterval(() => res.socket.write(Buffer.from([0x89, 0x00])), 5000)
    req.socket.on('close', () => clearInterval(keep))
    return
  }
  if (path.startsWith('/api/')) {
    const body = path === '/api/me'
      ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: 'Monitor', history_days: 30 }
      : path === '/api/nodes' ? NODES
        : path.includes('/config') ? CONFIG
          : { nodes: [] }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(body))
  }
  if (path.startsWith('/chicken/')) { res.writeHead(404); return res.end('no') }
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(file)) { res.writeHead(200, { 'Content-Type': TYPES['.html'] }); return res.end(readFileSync('dist/index.html')) }
  res.writeHead(200, { 'Content-Type': TYPES[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream' })
  res.end(readFileSync(file))
})
await new Promise((r) => server.listen(PORT, r))

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p)) || 'chrome'
const dbg = 9987
let wsUrl = null
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, '--remote-allow-origins=*', '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--window-size=1440,900', '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/shotset-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
for (let i = 0; i < 80 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { } ; if (!wsUrl) await sleep(300) }
let id = 0; const pend = new Map(); const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
const errs = []
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.text) }
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const js = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')

const shoot = async (name, clip) => {
  const r = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true })
  writeFileSync(join(OUTDIR, name), Buffer.from(r.result.data, 'base64'))
  const bytes = Buffer.from(r.result.data, 'base64').length
  console.log(`${name}  ${clip.width}×${clip.height} @${clip.scale}  ${(bytes / 1024).toFixed(0)}KB`)
}

const waitReady = async () => {
  for (let i = 0; i < 60; i++) { await sleep(400); if (await js('!!document.querySelector(".globe-panel")')) break }
  await sleep(3500)
}

// ① / ② 桌面：地球整块（亮 / 暗各一张，同一机位）
for (const [dark, name] of [[false, 'preview-globe.png'], [true, 'preview-globe-dark.png']]) {
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  await waitReady()
  const geo = JSON.parse(await js(`(() => { const el = document.querySelector('.globe-panel'); const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y + scrollY, w: r.width, h: r.height }) })()`))
  await shoot(name, { x: Math.round(geo.x), y: Math.round(geo.y), width: Math.round(geo.w), height: Math.round(geo.h), scale: 1 })
}

// ③ 手机 390×844@2x 的列表页首屏
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await waitReady()
await shoot('preview-mobile.png', { x: 0, y: 0, width: 390, height: 844, scale: 1 })

console.log('控制台异常:', errs.length ? errs.join(' | ') : '无')
ws.close(); chrome.kill(); server.close()

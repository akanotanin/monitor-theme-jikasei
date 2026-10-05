// 量一下价值版那两格数字在各机位到底差多少（本机 dist + 真 hub 数据，复现站长那组数字）。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const UPSTREAM = process.argv[2]
const PORT = 5612
const server = spawn('node', ['tools/serve.mjs', String(PORT), '{"listTop":"budget"}', '', UPSTREAM], { stdio: ['ignore', 'pipe', 'pipe'] })
server.stdout.on('data', () => {})
await sleep(1200)

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p)) || 'chrome'
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9995', '--remote-allow-origins=*', '--no-first-run',
  '--disable-gpu', '--hide-scrollbars', `--window-size=1440,1000`, `--user-data-dir=${process.env.TEMP || '.'}/meas-${Date.now()}`, 'about:blank'], { stdio: 'ignore' })
let ws = null
for (let i = 0; i < 80 && !ws; i++) {
  try { ws = (await (await fetch('http://127.0.0.1:9995/json/list')).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { /* 等 */ }
  if (!ws) await sleep(250)
}
const sock = new WebSocket(ws)
await new Promise((r) => { sock.onopen = r })
let id = 0
const pending = new Map()
sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })) })
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')

// 读数格：卡里那些 truncate 的大数字（含它们所在格的宽度）
const MEASURE = `JSON.stringify((() => {
  const tiles = [...document.querySelectorAll('[data-slot=card]')].filter((c) => /月度预算|剩余价值|节点|最忙节点|今日流量|实时网速/.test(c.innerText.slice(0, 12)))
  const out = []
  for (const c of tiles) {
    for (const d of c.querySelectorAll('div.tnum')) {
      const st = getComputedStyle(d)
      out.push({
        card: c.innerText.split('\\n')[0],
        text: d.innerText,
        cw: d.clientWidth, sw: d.scrollWidth, over: d.scrollWidth - d.clientWidth,
        fs: st.fontSize, ls: st.letterSpacing, ff: st.fontFamily.split(',')[0],
        parentW: Math.round(d.parentElement.getBoundingClientRect().width),
      })
    }
  }
  return out
})())`

for (const w of [360, 390, 430, 640, 768, 1024, 1280, 1440]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 1000, deviceScaleFactor: 1, mobile: w < 700 })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?w=${w}-${Date.now()}` })
  let rows = null
  for (let i = 0; i < 40; i++) {
    await sleep(400)
    const raw = await js(MEASURE)
    if (raw) { rows = JSON.parse(raw); if (rows.length) break }
  }
  console.log(`\n=== 视口 ${w}px ===`)
  for (const r of rows ?? []) {
    const flag = r.over > 0 ? `⚠ 溢出 ${r.over}px` : '放得下'
    console.log(`  ${r.card} · 「${r.text}」 格宽 ${r.cw} 文本宽 ${r.sw} → ${flag}（字号 ${r.fs} 字距 ${r.ls} 字体 ${r.ff} 块宽 ${r.parentW}）`)
  }
  if (!rows?.length) console.log('  （没量到读数格）页面：' + JSON.stringify(await js('document.body.innerText.slice(0,140)')) + ' 卡片数=' + await js("document.querySelectorAll('[data-slot=card]').length"))
}
sock.close(); chrome.kill(); server.kill(); process.exit(0)

// 「节点地球」开关 + 「主题模式」四档的验收（站点设置 → 页面行为）：
//   · themeMode = light / dark：页面直接照那一档上色（与访客的系统偏好无关）
//   · themeMode = system：跟访客系统的 prefers-color-scheme 走（两档各验一次）
//   · themeMode = auto：按**北京时间** 19:00–07:00 用暗色 —— 用 CDP 把时钟冻在
//     北京时间 22:00 与 14:00 各跑一次（冻结的是页面里的 Date，不改本机时间）
//   · globeOn = false：整个地球面板不渲染（不是藏起来）；true：渲染
//   · 访客自己的选择优先：站点设 light、访客 localStorage 记着 dark → 页面是暗的
//
// 用法：node tools/verify_appearance.mjs
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = Number(process.env.APPEAR_PORT || 5203)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }
const NODES = { nodes: [{ id: 'a', name: '演示节点', country: 'JP', group: '亚太', os: 'Debian 12', cpu_name: 'EPYC', cpu_cores: 2, mem_total: 2147483648, disk_total: 42949672960, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, online: true }] }
/** 当前这一轮要吐的站点配置（每次导航前改）。 */
let CONFIG = { listTop: 'none', cardStyle: 'plain' }

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  if (path.startsWith('/api/')) {
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '外观验收' }
      : path === '/api/nodes' ? NODES : path.endsWith('/config') ? CONFIG : {}
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
const BASE = `http://127.0.0.1:${PORT}`

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p)) || 'chrome'
const dbg = 9995 + Math.floor(Math.random() * 10)
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, '--remote-allow-origins=*', '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--window-size=1280,900', '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/appearance-' + dbg, 'about:blank'], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 100 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { }
  if (!wsUrl) await sleep(300)
}
if (!wsUrl) throw new Error('Chrome 起不来')
let id = 0
const pending = new Map()
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const js = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
await send('Runtime.enable'); await send('Page.enable')

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }

/** 冻结页面里的 Date（auto 档靠它判北京时间的钟点）。 */
async function setFrozen(iso) {
  await send('Page.removeScriptToEvaluateOnNewDocument', {}).catch(() => { })
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: iso
      ? `(() => { const R = Date; const fixed = new R(${JSON.stringify(iso)}).getTime(); class D extends R { constructor(...a) { if (!a.length) super(fixed); else super(...a) } static now() { return fixed } } window.Date = D })()`
      : 'true',
  })
}

async function load({ config, systemDark = false, visitor = null, freeze = null }) {
  CONFIG = config
  await setFrozen(freeze)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: systemDark ? 'dark' : 'light' }] })
  await send('Page.navigate', { url: `${BASE}/` })
  for (let i = 0; i < 60; i++) { await sleep(200); if (await js('!!document.querySelector("header")')) break }
  await sleep(1200)
  // ★ 访客那一项要**显式清掉**才算「没记过」：同一个 profile 里上一次场景写下的 theme 会留着，
  //   不清理就会把「跟着站点走」验成一个带残留值的状态（看着通过、其实没验到）。
  if (visitor === null) await js("localStorage.removeItem('theme')")
  else if (visitor !== undefined) await js(`localStorage.setItem('theme', ${JSON.stringify(visitor)})`)
  if (visitor !== undefined) { await send('Page.reload'); await sleep(1500) }
  return JSON.parse(await js(`JSON.stringify({
    dark: document.documentElement.classList.contains('dark'),
    globe: !!document.querySelector('.globe-atlas svg'),
    globePanel: !!document.querySelector('.globe-panel'),
    ls: (() => { const o = {}; try { for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i); o[k] = localStorage.getItem(k) } } catch {} return o })(),
  })`))
}

console.log('=== 主题模式四档 ===')
let s = await load({ config: { themeMode: 'light', globeOn: true }, systemDark: true })
check('light：站点设亮色，访客系统是暗色 → 页面仍是亮色', s.dark === false, `dark=${s.dark}`)
s = await load({ config: { themeMode: 'dark', globeOn: true }, systemDark: false })
check('dark：站点设暗色，访客系统是亮色 → 页面是暗色', s.dark === true, `dark=${s.dark}`)
s = await load({ config: { themeMode: 'system', globeOn: true }, systemDark: true })
check('system：跟访客系统走（暗）', s.dark === true, `dark=${s.dark}`)
s = await load({ config: { themeMode: 'system', globeOn: true }, systemDark: false })
check('system：跟访客系统走（亮）', s.dark === false, `dark=${s.dark}`)
// 北京时间 22:00（UTC 14:00）该是暗的；14:00（UTC 06:00）该是亮的
s = await load({ config: { themeMode: 'auto', globeOn: true }, systemDark: false, freeze: '2026-10-07T14:00:00Z' })
check('auto：北京时间 22:00（夜里）→ 暗色', s.dark === true, `dark=${s.dark}`)
s = await load({ config: { themeMode: 'auto', globeOn: true }, systemDark: true, freeze: '2026-10-07T06:00:00Z' })
check('auto：北京时间 14:00（白天）→ 亮色', s.dark === false, `dark=${s.dark}`)
s = await load({ config: { themeMode: 'auto', globeOn: true }, systemDark: false, freeze: '2026-10-07T23:30:00Z' })
check('auto：北京时间 07:30（刚过夜界）→ 亮色', s.dark === false, `dark=${s.dark}`)

console.log('\n=== 节点地球开关 ===')
s = await load({ config: { themeMode: 'light', globeOn: true } })
check('globeOn=true：地球渲染出来了', s.globe === true, `globe=${s.globe}`)
s = await load({ config: { themeMode: 'light', globeOn: false } })
check('globeOn=false：地球整块不渲染', s.globePanel === false && s.globe === false, `panel=${s.globePanel}`)
s = await load({ config: { themeMode: 'light', globeOn: false }, visitor: null })
// 老配置里没有 globeOn 这个键 → 走默认（显示）
s = await load({ config: { themeMode: 'light' } })
check('老站点配置（没有 globeOn）→ 按默认显示', s.globe === true, `globe=${s.globe}`)

console.log('\n=== 访客自己的选择优先 ===')
s = await load({ config: { themeMode: 'light', globeOn: false }, visitor: 'dark' })
check('站点设亮色、访客记着暗色 → 页面是暗色', s.dark === true, `dark=${s.dark}`)
s = await load({ config: { themeMode: 'dark', globeOn: false }, visitor: 'light' })
check('站点设暗色、访客记着亮色 → 页面是亮色', s.dark === false, `dark=${s.dark}`)
s = await load({ config: { themeMode: 'light', globeOn: true }, visitor: null })
check('访客没记过 → 跟着站点（亮）', s.dark === false, `dark=${s.dark} ls=${JSON.stringify(s.ls)}`)

console.log(`\n结果: PASS ${pass} / FAIL ${fail}`)
ws.close(); chrome.kill(); server.close()
process.exit(fail ? 1 : 0)

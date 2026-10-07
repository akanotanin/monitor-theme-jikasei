// 「节点地球」开关 + 「主题模式」四档的验收（站点设置 → 页面行为）：
//   · themeMode = light / dark：页面直接照那一档上色（与访客的系统偏好无关）
//   · themeMode = system：跟访客系统的 prefers-color-scheme 走（两档各验一次）
//   · themeMode = auto：按**北京时间** 19:00–07:00 用暗色 —— 用 CDP 把时钟冻在
//     北京时间 22:00 与 14:00 各跑一次（冻结的是页面里的 Date，不改本机时间）
//   · globeOn = false：整个地球面板不渲染（不是藏起来）、**顶栏那枚地球开关也不出现**
//     ——「面板即事实」：站长关掉这一块之后，页面上不该留一个点得动却什么也不开的按钮；
//     访客存在自己浏览器里的旧偏好也不许把站长关掉的整块顶回来。
//   · 访客自己的选择优先：站点设 light、访客 localStorage 记着 dark → 页面是暗的；
//     站点设 globeOn=开、访客自己关过 → 地球不渲染但**开关还在**（他自己能开回来）
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

async function load({ config, systemDark = false, visitor = null, globePref = undefined, freeze = null }) {
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
  // ★ 访客那枚地球偏好（`jikasei:globe`）同理要显式清掉才算「没动过」：同一个 profile 里
  //   上一轮写下的值会留着，不清理就会把「站长关掉」验成一个带残值的状态（看着通过、其实没验到）。
  if (globePref === undefined) await js("localStorage.removeItem('jikasei:globe')")
  else await js(`localStorage.setItem('jikasei:globe', ${JSON.stringify(String(globePref))})`)
  if (visitor !== undefined || globePref !== undefined) { await send('Page.reload'); await sleep(1500) }
  return JSON.parse(await js(`JSON.stringify({
    dark: document.documentElement.classList.contains('dark'),
    globe: !!document.querySelector('.globe-atlas svg'),
    globePanel: !!document.querySelector('.globe-panel'),
    globeToggle: !!document.querySelector('.globe-toggle'),
    ls: (() => { const o = {}; try { for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i); o[k] = localStorage.getItem(k) } } catch {} return o })(),
    // theme-color（手机浏览器那一圈）：App 起来之后应当只剩一份没有 media 的，值等于页面实际底色。
    themeColors: [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => ({ content: m.content, media: m.getAttribute('media') })),
    // 进度条填色的**有效颜色**：token 是 oklch()，正则抠数字会得到垃圾，颜色一律经 canvas 合成。
    // 卡片底还常常是透明的，先合成到页面底上，才是访客看到的那一层。
    meter: (() => {
      const card = [...document.querySelectorAll('[data-slot=card]')].find((c) => c.querySelector('div.overflow-hidden.rounded-full'))
      if (!card) return null
      const bar = card.querySelector('div.overflow-hidden.rounded-full')
      const fill = bar.firstElementChild
      if (!fill) return null
      const paint = (under, top) => {
        const c = document.createElement('canvas'); c.width = c.height = 1; const x = c.getContext('2d')
        if (under) { x.fillStyle = under; x.fillRect(0, 0, 1, 1) }
        if (top) { x.fillStyle = top; x.fillRect(0, 0, 1, 1) }
        const d = x.getImageData(0, 0, 1, 1).data
        return { rgb: 'rgb(' + d[0] + ',' + d[1] + ',' + d[2] + ')', alpha: +(d[3] / 255).toFixed(3) }
      }
      const body = getComputedStyle(document.body).backgroundColor
      const cardEff = paint(body, getComputedStyle(card).backgroundColor).rgb
      const text = card.querySelector('h3')
      const fillRaw = getComputedStyle(fill).backgroundColor
      return {
        alpha: paint(null, fillRaw).alpha,
        fill: paint(cardEff, fillRaw).rgb,
        text: text ? paint(cardEff, getComputedStyle(text).color).rgb : null,
        card: cardEff,
      }
    })(),
    bodyBg: (() => {
      const c = document.createElement('canvas'); c.width = c.height = 1
      const x = c.getContext('2d'); if (!x) return null
      x.fillStyle = getComputedStyle(document.body).backgroundColor
      x.fillRect(0, 0, 1, 1)
      const d = x.getImageData(0, 0, 1, 1).data
      return 'rgb(' + d[0] + ', ' + d[1] + ', ' + d[2] + ')'
    })(),
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


console.log('\n=== theme-color（手机浏览器那一圈）===')
// 判据：跟着**页面实际用的**档走（不是系统的）—— 站长的「随北京时间自动」在夜里与系统
// 相反时，只有这一步才对得上；index.html 那两份带 media 的静态兜底应当被摘掉。
const LIGHT_BG = 'rgb(250, 250, 250)'
const tcOf = (x) => ({ live: (x.themeColors || []).filter((m) => !m.media), all: x.themeColors, bg: x.bodyBg })
s = await load({ config: { themeMode: 'light', globeOn: true }, systemDark: true })
let tc = tcOf(s)
check('theme-color：只剩一份（App 起来后把 index.html 那两份静态兜底摘掉了）', tc.live.length === 1, JSON.stringify(tc.all))
check('theme-color：站点设亮色、访客系统是暗色 → 仍取页面的亮底色（不是系统的暗色）',
  tc.live[0]?.content === tc.bg && tc.bg === LIGHT_BG, `meta=${tc.live[0]?.content} 底色=${tc.bg}`)
s = await load({ config: { themeMode: 'dark', globeOn: true }, systemDark: false })
tc = tcOf(s)
check('theme-color：站点设暗色 → 取暗底色', tc.live[0]?.content === tc.bg && tc.bg !== LIGHT_BG, `meta=${tc.live[0]?.content} 底色=${tc.bg}`)
s = await load({ config: { themeMode: 'auto', globeOn: true }, systemDark: false, freeze: '2026-10-07T14:00:00Z' })
tc = tcOf(s)
check('theme-color：自动档夜里（与系统相反）→ 跟着页面的暗色走', tc.live[0]?.content === tc.bg && tc.bg !== LIGHT_BG, `meta=${tc.live[0]?.content} 底色=${tc.bg}`)

console.log('\n=== 进度条填色（两套主题各断一遍）===')
/**
 * 2026-10-08 站长反馈「进度条有些突兀，尤其服务器多的时候」：根因是填色＝正文本色
 * （亮 18.7:1 / 暗 12.6:1，卡片上最重的一笔），一页 4×N 根条会把读数压住。
 * 判据落在**合成后的有效对比度**上：3.5:1 起步（图形判读底线），8:1 封顶（必须明显轻于站名）。
 * 暗色单独断一遍——同一个 token 在暗底上的有效对比度与亮色不是一回事。
 */
const lumOf = (s) => {
  const [r, g, b] = s.match(/\d+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => { const [x, y] = [lumOf(a), lumOf(b)].sort((m, n) => n - m); return +((x + 0.05) / (y + 0.05)).toFixed(2) }
s = await load({ config: { themeMode: 'light', globeOn: true } })
check('亮色：进度条填色不是正文本色（有效对比 3.5–8:1 且轻于站名）',
  s.meter && s.meter.alpha < 1 && contrast(s.meter.fill, s.meter.card) >= 3.5 && contrast(s.meter.fill, s.meter.card) <= 8 &&
  contrast(s.meter.fill, s.meter.card) < contrast(s.meter.text, s.meter.card),
  JSON.stringify(s.meter) + ` 填色 ${s.meter && contrast(s.meter.fill, s.meter.card)}:1 / 站名 ${s.meter && contrast(s.meter.text, s.meter.card)}:1`)
s = await load({ config: { themeMode: 'dark', globeOn: true } })
check('暗色：同上（暗底上的有效对比度与亮色不是一回事，单独断）',
  s.meter && s.meter.alpha < 1 && contrast(s.meter.fill, s.meter.card) >= 3.5 && contrast(s.meter.fill, s.meter.card) <= 8 &&
  contrast(s.meter.fill, s.meter.card) < contrast(s.meter.text, s.meter.card),
  JSON.stringify(s.meter) + ` 填色 ${s.meter && contrast(s.meter.fill, s.meter.card)}:1 / 站名 ${s.meter && contrast(s.meter.text, s.meter.card)}:1`)

console.log('\n=== 节点地球开关 ===')
s = await load({ config: { themeMode: 'light', globeOn: true } })
check('globeOn=true：地球渲染出来了', s.globe === true, `globe=${s.globe}`)
check('globeOn=true：顶栏那枚地球开关在', s.globeToggle === true, `toggle=${s.globeToggle}`)
s = await load({ config: { themeMode: 'light', globeOn: false } })
check('globeOn=false：地球整块不渲染', s.globePanel === false && s.globe === false, `panel=${s.globePanel}`)
check('★ globeOn=false：顶栏那枚开关也不出现（没了一个点了什么也不开的按钮）', s.globeToggle === false, `toggle=${s.globeToggle}`)
// ★ 访客存在自己浏览器里的旧偏好不许把站长关掉的整块顶回来：老版本的访客可能存过 "1"（那时
//   站长那档是关的、他自己开过），站长现在关掉之后，页面必须是干净的关闭态。
s = await load({ config: { themeMode: 'light', globeOn: false }, globePref: '1' })
check('★ globeOn=false 且访客存过「要」：地球与那枚开关都不出现（面板即事实）',
  s.globePanel === false && s.globe === false && s.globeToggle === false, `panel=${s.globePanel} toggle=${s.globeToggle}`)
// 反过来：站长开着的时候，访客自己关过 → 地球不渲染，但那枚开关必须还在（不然他开不回来）
s = await load({ config: { themeMode: 'light', globeOn: true }, globePref: '0' })
check('globeOn=true 且访客自己关过：地球不渲染，但那枚开关还在（他开得回来）',
  s.globePanel === false && s.globeToggle === true, `panel=${s.globePanel} toggle=${s.globeToggle}`)
// 老配置里没有 globeOn 这个键 → 走默认（显示）
s = await load({ config: { themeMode: 'light' } })
check('老站点配置（没有 globeOn）→ 按默认显示', s.globe === true && s.globeToggle === true, `globe=${s.globe} toggle=${s.globeToggle}`)
check('上面那几轮没在访客浏览器里留下地球偏好（清理到位，判据才可信）',
  s.ls['jikasei:globe'] === undefined, JSON.stringify(s.ls))

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

// 主题验收取景器：一条命令把公开页的几种机位都拍下来，并顺手报几项 DOM 事实。
//
// 用法：
//   node tools/shots.mjs http://127.0.0.1:28081 shots
//   node tools/shots.mjs https://<你的站点> shots/live
//
// 拍什么：桌面亮/暗的列表页、节点详情页、延迟页，以及手机（390×844）的列表页与详情页。
// 报什么：国旗、自定义入口、站标这些「只有本主题才有」的元素在不在，以及控制台报错。
//
// 为什么不用 headless 的默认主题：暗色是 CSS 的 prefers-color-scheme 或 localStorage，
// 在 CDP 里用 Emulation.setEmulatedMedia 直接给，省得去点那颗月亮按钮。
//
// 只拍一张：第四个参数给名字片段，例如 `node tools/shots.mjs <url> shots cpu`。
// 全套连拍十几次请求时，hub 对并发的历史窗口有上限，偶尔会撞上 503 —— 那一张会拍到
// 「读取历史数据失败」，单拍重来即可，不是主题的问题。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const BASE = (process.argv[2] || 'http://127.0.0.1:28081').replace(/\/$/, '')
const OUT = process.argv[3] || 'shots'
// 第三个参数可选：只拍名字里含这个串的机位（调一张图时不用等全套）。
const ONLY = process.argv[4] || ''
const PORT = 9600 + Math.floor(Math.random() * 60)
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p)) || 'chrome'

mkdirSync(OUT, { recursive: true })

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  ...(process.env.PROXY ? [`--proxy-server=${process.env.PROXY}`] : []),
  '--user-data-dir=' + (process.env.LOCALAPPDATA || '/tmp') + '/Temp/themesshots' + PORT,
  'about:blank',
], { stdio: 'ignore' })

let id = 0
const pending = new Map()
let wsUrl = null
for (let i = 0; i < 60 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl
  } catch { /* 等 Chrome 起来 */ }
  if (!wsUrl) await sleep(300)
}
if (!wsUrl) throw new Error('Chrome 没起来')
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJS = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value

await send('Runtime.enable')
await send('Page.enable')
const errors = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description ?? ''))
})

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

const SHOTS = [
  { name: 'home-light', dark: false },
  { name: 'home-dark', dark: true },
  { name: 'detail-light', dark: false, open: 'node' },
  { name: 'detail-dark', dark: true, open: 'node' },
  { name: 'latency-light', dark: false, open: 'latency' },
  { name: 'cpu-tooltip', dark: false, open: 'node', hover: true },
  { name: 'latency-tooltip', dark: false, open: 'latency', hover: true },
  { name: 'mobile-home', dark: false, mobile: true },
  { name: 'mobile-detail', dark: false, mobile: true, open: 'node' },
]

const facts = {}
for (const shot of SHOTS.filter((s) => !ONLY || s.name.includes(ONLY))) {
  const w = shot.mobile ? 390 : 1440
  const h = shot.mobile ? 844 : 900
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: shot.mobile ? 3 : 1, mobile: !!shot.mobile })
  await send('Emulation.setUserAgentOverride', shot.mobile ? { userAgent: MOBILE_UA, platform: 'iPhone' } : { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36', platform: 'Windows' })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: shot.dark ? 'dark' : 'light' }] })
  await send('Page.navigate', { url: BASE + '/' })
  // 等卡片与数字滚动动画落定：数字还在变的时候截图会拍到乱码。
  for (let i = 0; i < 60; i++) { await sleep(400); if (await evalJS(`document.querySelectorAll('[role=button]').length > 0`)) break }
  await sleep(2500)
  if (shot.open) {
    await evalJS(`document.querySelectorAll('[role=button]')[0]?.click()`)
    await sleep(1200)
    if (shot.open === 'latency') {
      await evalJS(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '网络延迟')?.click()`)
      await sleep(3000)
    } else {
      await sleep(2500)
    }
  }
  if (shot.hover) {
    // 把鼠标移到图表中间，逼出自绘 tooltip：recharts 的 tooltip 由 mousemove 触发，
    // 而 headless 下没法真的移动指针，只能在图表上派发一次（冒泡到 React 根监听）。
    // 先等图表本体画出来——延迟图的数据到得比资源图晚，早派发就白发一次。
    for (let i = 0; i < 25; i++) { await sleep(400); if (await evalJS(`!!document.querySelector('.recharts-wrapper svg')`)) break }
    const moved = await evalJS(`(() => {
      const svg = document.querySelector('.recharts-wrapper svg')
      if (!svg) return 'no-chart'
      const r = svg.getBoundingClientRect()
      const x = r.left + r.width * 0.45, y = r.top + r.height * 0.45
      const target = document.elementFromPoint(x, y) || svg
      for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
        target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }))
      }
      return 'at ' + Math.round(x) + ',' + Math.round(y)
    })()`)
    await sleep(900)
    const tip = await evalJS(`(() => { const t = document.querySelector('.recharts-tooltip-wrapper'); return t ? t.innerText.replace(/\\s+/g, ' ') : '(没有 tooltip)' })()`)
    console.log(`  → tooltip: ${moved} | ${tip}`)
  }
  const png = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT}/${shot.name}.png`, Buffer.from(png.result.data, 'base64'))
  const f = await evalJS(`JSON.stringify({
    url: location.pathname,
    viewport: innerWidth + 'x' + innerHeight,
    dark: document.documentElement.classList.contains('dark'),
    flags: document.querySelectorAll('img[src^="/flags/"]').length,
    flagSrc: [...document.querySelectorAll('img[src^="/flags/"]')].slice(0, 3).map((i) => i.getAttribute('src')),
    farmEntry: !!document.querySelector('a[title="自定义入口"]'),
    farmHref: document.querySelector('a[title="自定义入口"]')?.getAttribute('href') || '(没有)',
    // 站标地址是主题设置项，可能被站长换掉；顺带报它有没有真的加载出来
    // （naturalWidth=0 就是取不到、已经退回默认或者空白）。
    siteIcon: document.querySelector('header img')?.getAttribute('src') || '(没有)',
    siteIconLoaded: (document.querySelector('header img')?.naturalWidth ?? 0) > 0,
    // 标签页图标跟站点图标是同一个地址（主题设置里改一处两处一起变）。
    favicon: document.querySelector('link[rel~="icon"]')?.getAttribute('href') || '(没有)',
    touchIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href') || '(没有)',
    // 分组标签行是主题设置项；关掉后这里应当是空数组。
    groupTabs: [...document.querySelectorAll('[role=group][aria-label=分组] button')].map((b) => b.innerText),
    cards: document.querySelectorAll('[role=button]').length,
    h3: [...document.querySelectorAll('h3')].slice(0, 3).map((h) => h.textContent),
    text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 220),
  })`)
  const parsed = JSON.parse(f)
  // 空白归一化放在 node 侧：写进页面表达式就要在模板字面量里再套一层转义，容易写坏（踩过）。
  if (Array.isArray(parsed.groupTabs)) parsed.groupTabs = parsed.groupTabs.map((t) => t.replace(/\s+/g, ' '))
  facts[shot.name] = parsed
  console.log(`${shot.name.padEnd(14)} ${JSON.stringify(facts[shot.name])}`)
}
console.log('控制台异常:', errors.length ? errors : '无')
ws.close()
chrome.kill()

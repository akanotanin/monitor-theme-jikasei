// 拍主题的预览图（preview.png）：固定视口 + DPR=2，等数字动画落定再截，拍完回报几何。
//
// 用法：node tools/shot_preview.mjs [baseUrl] [outPath] [width] [height] [DPR]
//   node tools/shot_preview.mjs http://127.0.0.1:28081 preview.png 1440 810 2
//
// 为什么要有它（而不是直接 Page.captureScreenshot）：
//   1. 数字滚动动画进行中 element.textContent 本身就是 # % & A 之类字符，截进去是乱码图 —
//      而且很容易误判成字库坏了。这里轮询到页面上再无那些字符，且字体已 ready 才拍。
//   2. 页面比视口高时右侧会冒出滚动条，旧图没有新图有，一眼就能看出来 — 默认 --hide-scrollbars。
//   3. 预览图要「最后一块内容没被裁」：拍完把最后一张卡片的 getBoundingClientRect().bottom
//      与视口高度一起打印出来，底边越界会明确报警。
//
// 数据来源：**拍照必须用中性环境**（隔离测试 hub 的测试节点），别拿现网 hub 实拍 ——
// 这张图会公开发在 GitHub 上，现网截图会连带暴露真实节点名与预付金额。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const BASE = (process.argv[2] || 'http://127.0.0.1:28081').replace(/\/$/, '')
const OUT = process.argv[3] || 'preview.png'
const W = Number(process.argv[4] || 1440)
const H = Number(process.argv[5] || 810)
const DPR = Number(process.argv[6] || 2)
// 可选（第 7 个参数）：把站点配置里的 cardStyle 钉成这个值再截。
// 三种形态要各拍一张，但线上同一时刻只能处在一种形态——与其来回改站长的站点配置
// （访客会跟着看到跳变、还要登录后台），不如只把这一条响应在浏览器层换掉：
// 站点配置原样取回来，只改 cardStyle 一个键，其余（延迟线路清单等）与线上完全一致。
// 线上配置一个字都不动。
//
// 可选（第 8 个参数）：再叠一组键值（JSON 字面量），同一套机制。
// 「开关默认关的新功能长什么样」就靠它拍：站点配置一个字都不用改，也不会让访客看到跳变。
//   node tools/shot_preview.mjs https://<站点> shots/summary.png 1440 900 2 "" '{"listTop":"summary"}'
const SHORT = 'jikasei'
const STYLE = process.argv[7] || null
const EXTRA = process.argv[8] ? JSON.parse(process.argv[8]) : {}
const PORT = 9700 + Math.floor(Math.random() * 200)
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p)) || 'chrome'

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  `--user-data-dir=${join(tmpdir(), `shotpreview${PORT}`)}`,
  '--no-sandbox',
  'about:blank',
], { stdio: 'ignore' })

let id = 0
const pending = new Map()
let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl
  } catch { /* 等 Chrome 起来 */ }
  if (!wsUrl) await sleep(250)
}
if (!wsUrl) throw new Error('Chrome 没起来')
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
// 覆写主题配置时的计数：拍完要断言「这条机制真的发生过」，否则可能是压根没生效却看着像成功。
const overridden = []
let SERVED_CONFIG = null
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Fetch.requestPaused') {
    const url = m.params.request.url
    ws.send(JSON.stringify({
      id: ++id, method: 'Fetch.fulfillRequest',
      params: {
        requestId: m.params.requestId, responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: Buffer.from(SERVED_CONFIG, 'utf8').toString('base64'),
      },
    }))
    overridden.push(url)
    return
  }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJS = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: false })
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })

// 要钉档位 / 叠设置项时：先把线上配置取回来（只改那几个键），再把这条请求交给 Fetch 域就地答复。
const OVERRIDE = { ...(STYLE ? { cardStyle: STYLE } : {}), ...EXTRA }
if (Object.keys(OVERRIDE).length) {
  const live = await (await fetch(`${BASE}/api/themes/${SHORT}/config`)).json()
  SERVED_CONFIG = JSON.stringify({ ...live, ...OVERRIDE })
  await send('Fetch.enable', { patterns: [{ urlPattern: `*api/themes/${SHORT}/config*`, requestStage: 'Request' }] })
  console.log(`就地覆写 ${JSON.stringify(OVERRIDE)}（其余键原样取自线上：${Object.keys(live).join(" / ")}）；线上配置未改动`)
}

await send('Page.navigate', { url: BASE + '/' })

// 1) 页面起来（卡片出来了）
let cards = 0
for (let i = 0; i < 60; i++) {
  await sleep(400)
  cards = await evalJS(`document.querySelectorAll('[role=button]').length`)
  if (cards > 0) break
}
if (!cards) throw new Error('卡片一直没出现，别拍了（这张图会是骨架态）')

// 2) 等数据与字体都到位：卡片已渲染、字体已 ready、每张卡片的数字节点非空，
//    且没有动画中的怪字符（`#`/`&`/`@`… 这类只有滚动动画会吐出来的东西）。
//    注意百分比里的 `%` 是正常内容，别把它当乱码 —— 放宽到整页文本就会把
//    「内存 15%」判成「还在动画中」（这一条踩过）。
//    也**不能**用「连续两次采样一致」当判据：hub 每 2 秒推一次快照，正文永远在变。
let settled = false
for (let i = 0; i < 60; i++) {
  const state = JSON.parse(await evalJS(`JSON.stringify({
    cards: document.querySelectorAll('[role=button]').length,
    fonts: document.fonts.status,
    tnum: [...document.querySelectorAll('.tnum')].map((el) => el.textContent.trim()),
    meters: [...document.querySelectorAll('[role=button] .h-full.rounded-full')].filter((el) => el.getBoundingClientRect().width > 0).length,
  })`))
  const garbage = state.tnum.some((t) => /[#&@!*^~]/.test(t))
  const empty = state.tnum.length === 0 || state.tnum.some((t) => !t)
  if (state.cards > 0 && state.fonts === 'loaded' && !garbage && !empty && state.meters > 0) { settled = true; break }
  await sleep(500)
}
if (!settled) throw new Error('页面一直没准备好（卡片/字体/数字/进度条），别拍（这张图会是骨架或乱码）')
await sleep(1200)

// 3) 拍之前把滚动条与滚动位置也钉住，别让鼠标位置影响截图
const geometry = JSON.parse(await evalJS(`JSON.stringify((() => {
  const cs = [...document.querySelectorAll('[role=button]')]
  const last = cs[cs.length - 1]?.getBoundingClientRect()
  return {
    viewport: innerWidth + 'x' + innerHeight,
    scrollY: Math.round(scrollY),
    scrollHeight: document.body.scrollHeight,
    scrollbar: innerWidth - document.documentElement.clientWidth,
    cards: cs.length,
    lastCardBottom: last ? Math.round(last.bottom) : null,
    h3: cs.slice(0, 3).map((c) => c.innerText.split('\\n')[0]),
    siteName: document.querySelector('header')?.innerText.trim().split('\\n')[0] || '(空)',
    groupTabs: [...document.querySelectorAll('[role=group][aria-label=分组] button')].length,
    farmEntry: !!document.querySelector('a[title="自定义入口"]'),
  }
})())`))

// 覆写过配置时，必须在按快门前确认那条覆写真的发生过（否则拍到的是线上原本那一档/原本的开关）。
if (Object.keys(OVERRIDE).length && overridden.length === 0) {
  throw new Error(`覆写了 ${JSON.stringify(OVERRIDE)}，但主题配置那条请求一次都没被拦到——这张图不是你要的样子，别用`)
}
if (Object.keys(OVERRIDE).length) console.log(`主题配置请求已就地覆写 ${overridden.length} 次：${overridden.map((u) => u.replace(BASE, '')).join(', ')}`)

const png = await send('Page.captureScreenshot', { format: 'png' })
await writeFile(OUT, Buffer.from(png.result.data, 'base64'))
const size = (await stat(OUT)).size

console.log(`已保存 ${OUT}（${W}×${H} @${DPR}x，${(size / 1024).toFixed(1)} KB）`)
console.log(JSON.stringify(geometry, null, 2))
const { lastCardBottom, scrollHeight } = geometry
if (lastCardBottom !== null && lastCardBottom > H) console.log(`⚠ 最后一张卡片底边 ${lastCardBottom} 超出视口 ${H}：这张图裁到了内容`)
else if (scrollHeight > H) console.log(`注意：body 高 ${scrollHeight} > 视口 ${H}（右侧滚动条已隐藏，但底部内容被裁了）`)
else console.log(`✅ 内容完好在视口内（最后一张卡片底边 ${lastCardBottom} / 视口 ${H}，底部留白 ${H - (lastCardBottom ?? 0)}px）`)
ws.close()
chrome.kill()

// 站点图标与标签页图标的验收：本机起一个静态+桩接口的服务器（**不经隧道**），
// 用 headless Chrome 断言「一处设置、两处图标」真的同时生效、取不到时的兜底，
// 以及**标签页不会先闪主题自带那张娃娃头再跳成自定图**（站长报过的 BUG）。
//
// 用法：node tools/verify_icons.mjs        # 五个场景跑在同一趟 Chrome 里，靠 localStorage 切冷热
//
//   ① 默认配置（站长没改）：标签页 = 主题自带那张，早跑脚本不折腾
//   ② 自定地址 + 无缓存：设置还没回来前就得贴上自定图（早跑脚本并行早问一次），
//      且这条设置请求只发一次（App 复用早跑那条，不许多发）
//   ③ 自定地址 + 有缓存：**主题自带那张一次都没被请求**（= 不闪娃娃头）← 这次的 BUG 就这条
//   ④ 地址取不到：不崩、顶栏兜底、缓存被改回默认（下一趟不再闪空白）
//   ⑤ 站长刚换过地址：缓存里那张先顶上，早跑脚本再把新地址换上（改一次不用等 1.6s）
//
// 为什么不用远端 hub 验这一条：经 SSH 隧道取静态文件时，同一个地址那几条并发请求
// 偶发只回一半（页头那张当场失败），会把隧道的问题算到主题头上。静态资源走本机就能分开。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 5199
const DEFAULT_ICON = '/site-icon.png'
const CUSTOM_ICON = '/custom-icon.png'
const CUSTOM_ICON_2 = '/custom-icon-2.png'
const DEAD_ICON = '/no-such.png'
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }
const NODES = { nodes: [] }

// 场景可切的桩：CONFIG 就是 GET /api/themes/jikasei/config 的响应内容。
let CONFIG = {}
const hits = { configAll: 0, configByProbe: 0, paths: new Map() }
const resetHits = () => { hits.configAll = 0; hits.configByProbe = 0; hits.paths = new Map() }

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  if (path.startsWith('/api/')) {
    if (path.endsWith('/config')) {
      hits.configAll++
      // 早跑脚本那条带 ?theme-icon=1（hub 不看查询串），好把两条设置请求分开数
      if (url.searchParams.has('theme-icon')) hits.configByProbe++
    }
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '图标验收' }
      : path === '/api/nodes' ? NODES
      : path.endsWith('/config') ? CONFIG : {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  hits.paths.set(path, (hits.paths.get(path) ?? 0) + 1)
  if (path === CUSTOM_ICON || path === CUSTOM_ICON_2) {
    // 两个自定图标：拿主题自带那张的字节换条路径伺服——URL 不同，网络断言才分得开。
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
    return res.end(readFileSync(join('dist', 'site-icon.png')))
  }
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // 未知路径 → 回落 index.html（与 hub 的行为一致）：`/no-such.png` 因此是「取不到图」。
    res.writeHead(200, { 'Content-Type': TYPES['.html'] })
    return res.end(readFileSync('dist/index.html'))
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${PORT}`
console.log(`dist/ 伺服在 ${BASE}/`)

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p)) || 'chrome'

// 机器上常有别的 Chrome 在跑（用户自己的 + 之前测试残留），端口与资源都紧张：
// 起不来就换个端口再来一次，别让一次偶发把整条验收判死。
let chrome, dbgPort, wsUrl = null
for (let attempt = 0; attempt < 2 && !wsUrl; attempt++) {
  dbgPort = 9910 + Math.floor(Math.random() * 80)
  chrome?.kill()
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, '--remote-allow-origins=*',
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/iconcheck-' + dbgPort + '-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch {}
    if (!wsUrl) await sleep(300)
  }
  if (!wsUrl) console.log(`第 ${attempt + 1} 次启动 Chrome（端口 ${dbgPort}）没起来，换端口重试`)
}
if (!wsUrl) throw new Error('Chrome 起不来：先看看是不是堆了太多测试实例（按 --user-data-dir 前缀清一遍）')

let id = 0
const pending = new Map()
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
const errors = []
// 这一次导航里浏览器真的发出去的图标类请求（favicon 与 <img> 都算；favicon 在 CDP 里是 Other 类型）
let iconReqs = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text)
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url
    if (/site-icon|custom-icon|no-such/.test(u)) iconReqs.push({ url: new URL(u).pathname, type: m.params.type })
  }
}
await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable')

// 文档一建好就装上记录器：MutationObserver 记下 <link rel=icon> 的每一个值（静态那次的
// /site-icon.png 也会被记下来）+ DOMContentLoaded 的时刻——「早跑脚本赶在浏览器发 favicon
// 请求之前就改掉了 link」这件事，用这几个时刻的先后关系判，不拿绝对毫秒当判据。
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(function () {
  var t0 = performance.now(), last = null
  window.__linkLog = []
  window.__dcl = null
  document.addEventListener('DOMContentLoaded', function () { window.__dcl = Math.round(performance.now()) })
  var sample = function () {
    var l = document.querySelector('link[rel~="icon"]')
    var v = l ? l.getAttribute('href') : null
    if (v !== last) { last = v; window.__linkLog.push({ ms: Math.round(performance.now() - t0), href: v }) }
  }
  // 观察 document 而不是 document.documentElement：这段脚本跑在文档刚建好时，
  // documentElement 可能还没解析出来（那时 observe(null) 会抛错，整段记录器就废了）。
  new MutationObserver(sample).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] })
  setInterval(sample, 5)
})()` })

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }
const readState = async () => JSON.parse(await js(`JSON.stringify({
  headerIcon: (() => { const i = document.querySelector('header img'); return i ? { src: i.getAttribute('src'), loaded: i.complete && i.naturalWidth > 0 } : null })(),
  favicon: document.querySelector('link[rel~="icon"]')?.getAttribute('href') ?? null,
  touch: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href') ?? null,
  probeSource: window.__iconProbeSource ?? '(未设)',
  probeAt: window.__iconProbeAt ?? null,
  probeHref: window.__iconProbeHref ?? null,
  settledAt: window.__iconSettledAt ?? null,
  cache: (() => { try { return localStorage.getItem('jikasei:site_icon') } catch { return null } })(),
  linkLog: window.__linkLog || [],
  dcl: window.__dcl,
})`))

const SETTLE = Number(process.env.ICON_WAIT_MS || 3500)
async function load({ config, cache }) {
  CONFIG = config
  resetHits(); iconReqs = []
  await js(cache === undefined
    ? `localStorage.removeItem('jikasei:site_icon')`
    : `localStorage.setItem('jikasei:site_icon', ${JSON.stringify(cache)})`)
  await send('Page.navigate', { url: `${BASE}/` })
  for (let i = 0; i < 40; i++) { await sleep(250); if (await js('document.querySelectorAll("[role=button]").length > 0')) break }
  await sleep(SETTLE)
  const s = await readState()
  s.configHits = hits.configAll
  s.configHitsByProbe = hits.configByProbe
  s.iconHits = (p) => hits.paths.get(p) ?? 0
  s.iconReqs = iconReqs.slice()
  s.errs = [...errors]
  console.log(`    link 时间线: ${s.linkLog.map((e) => `${e.ms}ms→${e.href}`).join('  ')}`)
  console.log(`    DOMContentLoaded=${s.dcl ?? '—'}ms  早跑脚本落定=${s.probeAt ?? '—'}ms(${s.probeSource} → ${s.probeHref ?? '—'})  顶栏出结果=${s.settledAt ?? '—'}ms`)
  console.log(`    图标请求: ${s.iconReqs.length ? s.iconReqs.map((r) => `${r.url}[${r.type}]`).join('  ') : '(无)'}`)
  console.log(`    favicon=${s.favicon}  touch=${s.touch}  缓存=${s.cache}  设置请求=${s.configHits}(其中早跑 ${s.configHitsByProbe})`)
  return s
}
const reqs = (s) => s.iconReqs.map((r) => r.url).join(' ') || '(无)'

// ① 默认配置（站长没改站点图标）
console.log('\n① 默认配置')
let s = await load({ config: {}, cache: undefined })
check('① 顶栏图标加载成功（页头那枚真的画出来了）', !!s.headerIcon?.loaded, JSON.stringify(s.headerIcon))
check('① 标签页图标 = 主题自带那张', s.favicon === DEFAULT_ICON, `favicon=${s.favicon}`)
check('① apple-touch-icon 与它同值（手机加到主屏也是这张）', s.touch === DEFAULT_ICON, `touch=${s.touch}`)
check('① 只请求过主题自带那张（favicon 一次 + 页头一次，没有别的图标地址）',
  s.iconHits(DEFAULT_ICON) >= 1 && s.iconReqs.every((r) => r.url === DEFAULT_ICON), `${s.iconHits(DEFAULT_ICON)} 次 / ${reqs(s)}`)
check('① 控制台无异常', s.errs.length === 0, s.errs.join(' | '))

// ② 自定地址、无缓存（首次访问）
console.log('\n② 自定地址 + 无缓存（首次访问）')
s = await load({ config: { siteIcon: CUSTOM_ICON }, cache: undefined })
check('② 顶栏图标加载成功', !!s.headerIcon?.loaded && s.headerIcon?.src === CUSTOM_ICON, JSON.stringify(s.headerIcon))
check('② 标签页图标 = 自定地址', s.favicon === CUSTOM_ICON, `favicon=${s.favicon}`)
check('② apple-touch-icon = 自定地址', s.touch === CUSTOM_ICON, `touch=${s.touch}`)
check('② 图标是早跑脚本贴上的（走「早问一次设置」这条路，不是等顶栏那张）', s.probeSource === 'fetch', `probeSource=${s.probeSource}`)
check('② 贴上自定图早于顶栏那张出结果（不必等入口包跑完 + <img> onLoad）',
  s.probeAt != null && s.settledAt != null && s.probeAt < s.settledAt, `落定 ${s.probeAt}ms vs 顶栏 ${s.settledAt}ms`)
check('② 早跑脚本那条设置请求真的发出去了（机制确实发生过）', s.configHitsByProbe >= 1, `${s.configHitsByProbe} 次`)
check('② 设置请求全场只发一次（App 复用了早跑那条，没有第二条）', s.configHits === 1, `${s.configHits} 次`)
check('② 顶栏成功的那张被记进缓存（下一趟不用再闪）', s.cache === CUSTOM_ICON, `cache=${s.cache}`)
check('② 控制台无异常', s.errs.length === 0, s.errs.join(' | '))

// ③ 自定地址、有缓存（返访）—— 站长报的就是这一条
console.log('\n③ 自定地址 + 有缓存（返访）')
s = await load({ config: { siteIcon: CUSTOM_ICON }, cache: CUSTOM_ICON })
const switched = s.linkLog.find((e) => e.href === CUSTOM_ICON)
check('③ 主题自带那张（娃娃头）这一次一次都没被请求', s.iconHits(DEFAULT_ICON) === 0, `请求了 ${s.iconHits(DEFAULT_ICON)} 次`)
check('③ 返访只请求自定地址那张', s.iconReqs.length > 0 && s.iconReqs.every((r) => r.url === CUSTOM_ICON), reqs(s))
check('③ 图标是缓存里那张贴上的', s.probeSource === 'cache', `probeSource=${s.probeSource}`)
check('③ 自定图在 DOMContentLoaded（浏览器那趟 favicon 请求）之前就贴上了',
  switched != null && s.dcl != null && switched.ms < s.dcl, `改写 ${switched?.ms}ms vs DCL ${s.dcl}ms`)
check('③ 标签页与 apple-touch-icon 仍 = 自定地址', s.favicon === CUSTOM_ICON && s.touch === CUSTOM_ICON, `favicon=${s.favicon} touch=${s.touch}`)
check('③ 控制台无异常', s.errs.length === 0, s.errs.join(' | '))

// ④ 自定地址取不到（缓存里是个坏地址）
console.log('\n④ 自定地址取不到')
s = await load({ config: { siteIcon: DEAD_ICON }, cache: DEAD_ICON })
check('④ 页面不崩、顶栏兜底到主题自带那张', !!s.headerIcon?.loaded && s.headerIcon?.src === DEFAULT_ICON, JSON.stringify(s.headerIcon))
check('④ 标签页最终回到主题自带那张', s.favicon === DEFAULT_ICON, `favicon=${s.favicon}`)
check('④ 坏地址被从缓存里换掉（下一趟不会再闪空白）', s.cache === DEFAULT_ICON, `cache=${s.cache}`)
check('④ apple-touch-icon 也回到主题自带那张', s.touch === DEFAULT_ICON, `touch=${s.touch}`)
check('④ 控制台无异常', s.errs.length === 0, s.errs.join(' | '))

// ⑤ 站长刚把地址换成另一张
console.log('\n⑤ 站长刚换过地址（缓存里还是旧的）')
s = await load({ config: { siteIcon: CUSTOM_ICON_2 }, cache: CUSTOM_ICON })
check('⑤ 旧地址与主题自带那张都没进浏览器那条 favicon 请求（直接就是新图）',
  s.iconHits(DEFAULT_ICON) === 0 && s.iconReqs.some((r) => r.type === 'Other' && r.url === CUSTOM_ICON_2),
  `旧 ${s.iconHits(CUSTOM_ICON)} 次 / 自带 ${s.iconHits(DEFAULT_ICON)} 次 / ${reqs(s)}`)
check('⑤ 早跑脚本随后换成新地址，且早于顶栏那张出结果',
  s.probeHref === CUSTOM_ICON_2 && s.probeAt != null && s.settledAt != null && s.probeAt < s.settledAt, `${s.probeHref} @${s.probeAt}ms vs 顶栏 ${s.settledAt}ms`)
check('⑤ 标签页最终是站长新填的那张', s.favicon === CUSTOM_ICON_2 && s.touch === CUSTOM_ICON_2, `favicon=${s.favicon}`)
check('⑤ 控制台无异常', s.errs.length === 0, s.errs.join(' | '))

console.log(`\n结果: PASS ${pass} / FAIL ${fail}`)
ws.close(); chrome.kill(); server.close()
process.exit(fail ? 1 : 0)

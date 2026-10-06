// 「养鸡场入口」的验收：本机伺服 dist/ + 桩 /api/* 与 /chicken/api/nodes，用 headless Chrome
// 跑七种情况，断言这枚图标该出现时出现、该消失时消失，地址与打开方式正确，
// 并与相邻两枚图标按钮逐项同款（它存在的理由就是「看起来像本来就长在那里」）。
//
// 用法：node tools/verify_farm_entry.mjs [截图目录=shots/farm-entry]
//   先 `npm run build` —— 验的是 dist/，不是源码。
//
// 两条最要紧的断言：
//   · 本站没养鸡场 + 站长没填地址 → **不许出现**。否则访客点到的是一枚没有落点的图标：
//     hub 对未知路径回落到主题 index.html，看着像「点了没反应 / 又回首页」。
//   · 「本站有没有养鸡场」不能拿状态码探：hub 的回落让 /chicken/ 在「装了」与「没装」
//     两种情况下都是 200，所以这里专门有一个「桩回 200 + HTML」的用例——那就是回落本身。
//
// 为什么走本机伺服而不是真 hub：这些断言里有「按设置变化」和「按本站有没有养鸡场变化」
// 两类分支，只有能随手改桩状态才验得全；真站上还隔着 CF 与反代缓存，会把缓存问题算到主题头上。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const OUT = process.argv[2] || 'shots/farm-entry'
const PORT = 5199
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }

// 每个场景换一次的桩状态：站长的设置、本站有没有养鸡场、探测被打了几次。
let CONFIG = {}
let FARM = false
let probes = 0

const sendHtml = (res) => {
  res.writeHead(200, { 'Content-Type': TYPES['.html'] })
  res.end(readFileSync('dist/index.html'))
}

const server = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  // 养鸡场那几块 location 里的 /chicken/api/* 反代到 hub：装了就是 JSON，
  // 没装时这条路径落到的就是 hub 的未知路径回落（200 + 主题的 index.html）。
  if (path === '/chicken/api/nodes') {
    probes++
    if (!FARM) return sendHtml(res)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify({ nodes: [] }))
  }
  if (path.startsWith('/api/')) {
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '入口验收' }
      : path === '/api/nodes' ? { nodes: [] }
      : path.endsWith('/config') ? CONFIG : {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) return sendHtml(res)
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
mkdirSync(OUT, { recursive: true })

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
].find((p) => existsSync(p)) || 'chrome'

// 机器上常有别的 Chrome（用户自己的 + 测试残留），端口紧张：起不来就换端口再来一次。
let chrome, dbgPort, wsUrl = null
for (let attempt = 0; attempt < 2 && !wsUrl; attempt++) {
  dbgPort = 9910 + Math.floor(Math.random() * 80)
  chrome?.kill()
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, '--remote-allow-origins=*',
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/farmcheck-' + dbgPort + '-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { /* 等它起来 */ }
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
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')
let errors = []
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text) })

// 页面上要断言的都在这一段里取回来。**别在模板字符串里写反引号或正则**（踩过）。
const READ = `(() => {
  const header = document.querySelector('header');
  if (!header) return JSON.stringify({ ready: false });
  const btns = [...header.querySelectorAll('[data-slot="button"]')];
  const pick = (t) => header.querySelector('[data-slot="button"][title="' + t + '"]');
  const farm = pick('养鸡场'), moon = pick('切换主题'), admin = header.querySelector('a[href="/admin/"]');
  // 顶栏在「扳手」与「鸡」之间还有一枚「节点地球」（列表页才出现，见 components/Globe.tsx）：
  // 它现在是鸡的左邻，间距/尺寸这两条要跟它比。
  const globe = pick('隐藏节点地球');
  const css = (el) => { const s = getComputedStyle(el); return { radius: s.borderRadius, padding: s.padding, color: s.color, bg: s.backgroundColor, w: s.width, h: s.height }; };
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }; };
  const svg = farm ? farm.querySelector('svg') : null;
  const sr = svg ? svg.getBoundingClientRect() : null;
  return JSON.stringify({
    ready: btns.length > 0,
    titles: btns.map((b) => b.getAttribute('title')),
    farmCount: header.querySelectorAll('[data-slot="button"][title="养鸡场"]').length,
    farmTag: farm ? farm.tagName : null,
    href: farm ? farm.getAttribute('href') : null,
    resolved: farm ? farm.href : null,
    target: farm ? farm.getAttribute('target') : null,
    rel: farm ? farm.getAttribute('rel') : null,
    aria: farm ? farm.getAttribute('aria-label') : null,
    cls: { farm: farm ? farm.className : null, moon: moon ? moon.className : null, admin: admin ? admin.className : null },
    css: { farm: farm ? css(farm) : null, moon: moon ? css(moon) : null, admin: admin ? css(admin) : null },
    box: { farm: farm ? box(farm) : null, moon: moon ? box(moon) : null, admin: admin ? box(admin) : null, globe: globe ? box(globe) : null },
    icon: svg ? { viewBox: svg.getAttribute('viewBox'), paths: svg.querySelectorAll('path').length, stroke: getComputedStyle(svg).stroke, width: svg.getAttribute('stroke-width'), w: Math.round(sr.width), h: Math.round(sr.height), fill: svg.getAttribute('fill') } : null,
  });
})()`

// 入口不出现时，顶栏剩下的那几枚（搜索框 / 扳手 / 卡片形态 / 地球 / 月亮）——多一枚少一枚都算这行被弄乱了。
// 搜索框那枚（标题里带「搜索（名称 / 地区 / 系统）」）是最前面的一枚，**只在列表页出现**：
// 这几个场景拍的就是列表页，所以它一直在。见 tools/verify_search.mjs。
const HIDDEN_TITLES = '搜索（名称 / 地区 / 系统）,登录,卡片形态,隐藏节点地球,切换主题'
const SCENARIOS = [
  // 只装主题、没装养鸡场、站长也没填地址 —— 最常见的形态：这一枚不许出现。
  { name: '本站没养鸡场（默认设置）', config: {}, farm: false, visible: false, probes: 1 },
  // 部署完养鸡场、什么都不用配：图标自己出现，指到本站 /chicken/。
  { name: '本站有养鸡场（默认设置 → 自动出现）', config: {}, farm: true, visible: true, href: '/chicken/', blank: false, probes: 1 },
  // 桩回 200 + HTML 就是 hub 的回落：拿状态码探会把它误判成「有养鸡场」。
  { name: '只有 hub 回落的 200 + HTML（不许当成有养鸡场）', config: {}, farm: false, visible: false, probes: 1 },
  // 站长自己填了地址：以他填的为准，这时不再探测。
  { name: '站长填了跨站地址', config: { farmUrl: 'https://farm.example.com/play' }, farm: false, visible: true, href: 'https://farm.example.com/play', blank: true, probes: 0 },
  { name: '站长填了同域路径', config: { farmUrl: '/chicken/' }, farm: false, visible: true, href: '/chicken/', blank: false, probes: 0 },
  // 「不显示」现在用 farmUrl 自己的 off 值表达（1.6.0 把旧的两个键并进这一格）。
  { name: 'off：即便本站有养鸡场也不显示', config: { farmUrl: 'off' }, farm: true, visible: false, probes: 0 },
  // ── 1.5.0 两个键的迁移（showFarmEntry 开关 + farmUrl 地址 → farmUrl 一格） ──
  // 老站点关了开关而地址键从没动过 → 落成 off，入口不许自己冒出来。
  { name: '老配置：1.5.0 关了入口、没填地址（→ off，不显示）', config: { showFarmEntry: false }, farm: true, visible: false, probes: 0 },
  // 但地址键一旦存在就按它来：后台那个输入框的初值就是 saved.farmUrl，
  // 若让孤儿开关压过它，这批站点在面板里填什么都不会生效（永久点了没反应）。
  { name: '老配置：关了开关但填过地址（地址键优先 → 按地址显示）', config: { showFarmEntry: false, farmUrl: '/chicken/' }, farm: false, visible: true, href: '/chicken/', blank: false, probes: 0 },
]

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

for (const [n, scenario] of SCENARIOS.entries()) {
  CONFIG = scenario.config
  FARM = scenario.farm
  probes = 0
  errors = []
  console.log(`\n[${n + 1}/${SCENARIOS.length}] ${scenario.name}   config=${JSON.stringify(CONFIG)} farm=${FARM}`)
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  let state = null
  for (let i = 0; i < 40; i++) {
    await sleep(300)
    const raw = await js(READ)
    if (!raw) continue
    state = JSON.parse(raw)
    if (!state.ready) continue
    // 该出现时等它出现（先渲染 → 再取设置 → 再探一次接口，是异步的）；
    // 该消失时多等一拍，别把「还没探完」当成「正确地没出现」。
    if (scenario.visible ? state.farmCount > 0 : i > 9) break
  }
  if (!state?.ready) throw new Error('页面没渲染出来（顶栏一个按钮都没有）')

  if (!scenario.visible) {
    check('入口不渲染', state.farmCount === 0, `farmCount=${state.farmCount}`)
    check('相邻两枚仍在（只是这一枚不在，不是整行倒了）', state.titles.join(',') === HIDDEN_TITLES, state.titles.join(','))
  } else {
    check('入口在（真画出来了，有尺寸）', state.farmCount === 1 && (state.box.farm?.w ?? 0) > 0, `count=${state.farmCount} box=${JSON.stringify(state.box.farm)}`)
    check('href = 设置里的地址 / 自动认出的 /chicken/', state.href === scenario.href, `href=${state.href}`)
    if (scenario.blank) {
      check('跨站：新标签页打开且不带走 referrer', state.target === '_blank' && state.rel === 'noreferrer', `target=${state.target} rel=${state.rel}`)
    } else {
      check('同域：当前标签页打开（属于站内导航）', state.target === null && state.rel === null, `target=${state.target} rel=${state.rel}`)
    }
    check('顺序与参考图一致：搜索框 → 扳手 → 卡片形态 → 地球 → 鸡 → 月亮', state.titles.join(',') === '搜索（名称 / 地区 / 系统）,登录,卡片形态,隐藏节点地球,养鸡场,切换主题', state.titles.join(','))
    check('三枚的 class 逐字符相同（画风靠它保证）', state.cls.farm === state.cls.moon && state.cls.farm === state.cls.admin)
    // box 里只比尺寸——位置天生不同（它是另一枚按钮），比位置等于恒红。
    const sizeOf = (b) => (b ? { w: b.w, h: b.h } : null)
    check('尺寸/圆角/内边距/前景色与相邻两枚一致',
      same(sizeOf(state.box.farm), sizeOf(state.box.moon)) && same(state.css.farm, state.css.moon),
      `box ${JSON.stringify(sizeOf(state.box.farm))} vs ${JSON.stringify(sizeOf(state.box.moon))} | css ${JSON.stringify(state.css.farm)} vs ${JSON.stringify(state.css.moon)}`)
    const gapA = state.box.farm.x - state.box.globe.right
    const gapB = state.box.moon.x - state.box.farm.right
    check('与两边的间距相等（左邻是那枚地球）', Math.abs(gapA - gapB) <= 1, `${gapA}px / ${gapB}px`)
    check('图标 = 24×24 视框的 Lucide 描边（含那道鸡冠，共 7 条路径）',
      state.icon?.viewBox === '0 0 24 24' && state.icon?.paths === 7 && state.icon?.width === '2' && state.icon?.fill === 'none',
      JSON.stringify(state.icon))
    check('图标渲染尺寸与相邻图标一致（16px）', state.icon?.w === 16 && state.icon?.h === 16, `${state.icon?.w}×${state.icon?.h}`)
    check('图标用的是 currentColor（与按钮的前景色同值）',
      String(state.icon?.stroke).replace(/\s/g, '') === String(state.css?.farm?.color).replace(/\s/g, ''),
      `stroke=${state.icon?.stroke} color=${state.css?.farm?.color}`)
  }
  // 探测机制本身也要断：该探的探了、不该探的一次都不许有（填了地址还去探同样是坏）。
  check(`探测 /chicken/api/nodes 的次数 = ${scenario.probes}`, probes === scenario.probes, `实际 ${probes} 次`)
  check('控制台无异常', errors.length === 0, errors.join(' | '))

  // 顶部那片区域的截图：改前改后就靠同机位对照图说话。
  const png = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1440, height: 64, scale: 2 } })
  const file = `${OUT}/s${n + 1}.png`
  writeFileSync(file, Buffer.from(png.result.data, 'base64'))
  console.log(`  截图 ${file}`)
}

console.log(`\n结果: PASS ${pass} / FAIL ${fail}`)
ws.close(); chrome.kill(); server.close()
process.exit(fail ? 1 : 0)

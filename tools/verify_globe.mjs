// 「节点地球」的验收：本机伺服 dist/ + 桩 /api/nodes，用 headless Chrome 跑一遍，把地球的
// **结构**（岸线/经纬网/针/引线/标签/地区）与**行为**（自转、拖拽、点针开机、地区筛选、开关）
// 逐条断言。几何在 src/lib/globe.ts 里与上游逐点比对过
// （见 src/lib/globe.test.ts 的第①组），这里管的是"装进页面之后还对不对"。
//
// 用法：node tools/verify_globe.mjs [截图目录=shots/globe]
//   先 `npm run build` —— 验的是 dist/，不是源码。
//
// 三条最要紧的断言：
//   · **标签不压地球**（每个标签的 x 都在圆盘之外）—— 它一旦落到圆盘上，整个"引线连到
//     旁边的字"的读法就散了，而截图不一定看得出来（屏幕上只像是字挪了位置）。
//   · **抽稀之后的岸线不许有一条越出圆盘**（背面的大陆翻到正面）—— 这是裁边那一步的
//     唯一直接证据。
//   · **点地区真的会只留下该地区的机器**，再点「全部」真的回来 —— 筛选错了不会报错，
//     页面只是显示别的机器。
//
// 性能只量"本机"：主线程占用率与重画次数（按档位的 idleMs）。**不要**把这里的数字
// 当成"手机上流畅"的证据 —— 手机上走的是 low 档，真机体感得真机看。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { linkDivisor } from '../src/lib/globe.ts'
import { setTimeout as sleep } from 'node:timers/promises'

const OUT = process.argv[2] || 'shots/globe'
const PORT = 5201
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }

// 七台演示机（**合成夹具，不含任何真实站点的数据**）：国家分布与常见的自建机队一样
// （US×3 / JP×3 / DE×1），名字里带城市线索（圣何塞 / 东京 / 法兰克福）正好走城市线索那条路，
// 另有一台 Ashburn —— 它是新补进线索表的城市（旧版这台落国家码「US」，现在有城名，
// 顺带证明线索表扩展真的生效）。初始视角下这七台一半在地球背面 ——
// 「背面不画」那条边界就是靠它压出来的（26 台那套全在正面，压不出这个）。
const LIVE = JSON.parse(readFileSync('tools/globe-nodes-fixture.json', 'utf8'))
// 合成那一套：26 台、八个国家、一台离线 —— 拿它压一压标签堆叠与左右分流
// （七台那套一半在地球背面，压不出两摞标签都排满的样子）。
// 名字一律走「示例 + 线索」这套中性写法（与既有护栏里的「节点一/节点二」同一口径），
// 城市线索（SH / 广州 / HK / 首尔 / SG / SJC / Tokyo）与各国台数都照着要覆盖的分支留的。
const synth = (name, country, online = true, id = 0) => ({
  id, name, sort: id, public: true, online, country, group: '', last_seen: Math.floor(Date.now() / 1000),
  metrics: null, os: 'Debian', kernel: '6.1.0', arch: 'x86_64', virt: '', cpu_name: '', cpu_cores: 1,
  mem_total: 0, swap_total: 0, disk_total: 0, agent_version: '1.2.0', price: 0, currency: 'CNY',
  billing_cycle: '', expires_at: null, traffic_limit: 0, traffic_mode: '', traffic_reset_day: 1,
  total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0, month_start: '', day_rx: 0, day_tx: 0,
})
const FLEET = [
  synth('示例 SH', 'CN', true, 1), synth('示例 广州', 'CN', true, 2), synth('示例三', 'HK', true, 3),
  synth('示例 HK 一', 'HK', true, 4), synth('示例 HK 二', 'HK', true, 5), synth('示例 HK 三', 'HK', true, 6),
  synth('示例 落地', 'HK', false, 7), synth('示例 TW 一', 'TW', true, 8), synth('示例 JP 一', 'JP', true, 9),
  synth('示例 JP 二', 'JP', true, 10), synth('示例 JP 三', 'JP', true, 11), synth('示例 JP 四', 'JP', true, 12),
  synth('示例 首尔 一', 'KR', true, 13), synth('示例 SG 一', 'SG', true, 14), synth('示例 SG 二', 'SG', true, 15),
  synth('示例 SG 三', 'SG', true, 16), synth('示例 SJC 一', 'US', true, 17), synth('示例 US 一', 'US', true, 18),
  synth('示例 US 二', 'US', true, 19), synth('示例 US 三', 'US', true, 20), synth('示例 US 四', 'US', true, 21),
  synth('示例 US 五', 'US', true, 22), synth('示例 NL 一', 'NL', true, 23), synth('示例 DE 一', 'DE', true, 24),
  synth('某台没查到的机器', '', true, 25), synth('某台奇怪的', 'XA', true, 26),
  // 故意长到顶：右摞的「JP · Example Tokyo Datacenter Gen 2」估出来约 226 个用户单位，
  // 远超两摞距画布边缘的 126 —— 窄屏上必须靠画布留白（viewBox 往两边撑开）才不被裁。
  synth('Example Tokyo Datacenter Gen 2', 'JP', true, 27),
]

let fleet = LIVE.nodes
// 这台机群里有落点的台数：国家码为空或不在表里、又认不出城市的，不上地球。
const LOCATED = FLEET.filter((n) => n.country && n.country !== 'XA').length

let config = {}

const sendHtml = (res) => {
  res.writeHead(200, { 'Content-Type': TYPES['.html'] })
  res.end(readFileSync('dist/index.html'))
}

const server = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  if (path.startsWith('/api/')) {
    // 详情页要吃资源历史：一律回 `{}` 的话它会抛在 `metrics.length` 上、整页空白，
    // 而"空白"在断言里只表现为 URL 变了 —— 于是"点得开"这条会假绿。
    if (path.includes('/metrics')) {
      const series = new URL(req.url, 'http://x').searchParams.get('series')
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      return res.end(JSON.stringify(series === 'ping'
        ? { ping: Array.from({ length: 12 }, (_, i) => ({ ts: Math.floor(Date.now() / 1000) - (11 - i) * 60, task_id: 1, latency: 40 + i })), probes: { 1: '电信' }, loss: {} }
        : { step: 60, metrics: Array.from({ length: 20 }, (_, i) => ({ ts: Math.floor(Date.now() / 1000) - (19 - i) * 60, cpu: 10 + (i % 5), mem_used: 4e8 + i * 1e6, disk_used: 5e9, net_rx: 1024, net_tx: 512 })) }))
    }
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '地球验收', history_days: 30 }
      : path === '/api/nodes' ? { nodes: fleet }
      : path.endsWith('/config') ? config
      : {}
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

let chrome, dbgPort, wsUrl = null
for (let attempt = 0; attempt < 2 && !wsUrl; attempt++) {
  dbgPort = 9920 + Math.floor(Math.random() * 60)
  chrome?.kill()
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, '--remote-allow-origins=*',
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/globecheck-' + dbgPort + '-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
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

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }
/** 只截地球那一块（`clip` 按页面坐标裁）：README 里那张图和肉眼对照都用它。 */
const shotPanel = async (name) => {
  const raw = await js(`(() => { const r = document.querySelector('.globe-panel').getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y + scrollY), width: Math.round(r.width), height: Math.round(r.height), scale: 2 }) })()`)
  const r = await send('Page.captureScreenshot', { format: 'png', clip: JSON.parse(raw) })
  if (r.result?.data) (await import('node:fs')).writeFileSync(join(OUT, name), Buffer.from(r.result.data, 'base64'))
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  if (r.result?.data) (await import('node:fs')).writeFileSync(join(OUT, name), Buffer.from(r.result.data, 'base64'))
}
/** 只截**地区侧栏**那一块：改前/改后对照图（HK 一行 / 两行）用它，与站长报的那张同一口径。 */
const shotSide = async (name) => {
  const raw = await js(`(() => { const r = document.querySelector('.globe-side').getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y + scrollY), width: Math.round(r.width), height: Math.round(r.height), scale: 2 }) })()`)
  const r = await send('Page.captureScreenshot', { format: 'png', clip: JSON.parse(raw) })
  if (r.result?.data) (await import('node:fs')).writeFileSync(join(OUT, name), Buffer.from(r.result.data, 'base64'))
}

// 页面上要断言的都在这一段里取回来。**别在模板字符串里写反引号或正则**（踩过）。
const READ = `(() => {
  const panel = document.querySelector('.globe-panel');
  const svg = panel ? panel.querySelector('svg') : null;
  const atlas = panel ? panel.querySelector('.globe-atlas') : null;
  const land = svg ? svg.querySelector('.globe-land') : null;
  const coast = svg ? svg.querySelector('.globe-coast') : null;
  const labels = panel ? [...panel.querySelectorAll('.globe-label')] : [];
  const pins = panel ? [...panel.querySelectorAll('.globe-pin')] : [];
  const hits = panel ? [...panel.querySelectorAll('.hit')] : [];
  const regs = panel ? [...panel.querySelectorAll('.globe-reg')] : [];
  const caption = panel ? panel.querySelector('.globe-caption') : null;
  const nums = (d) => (d || '').split(' ').filter((t) => t !== '' && !isNaN(Number(t))).map(Number);
  const coords = nums(coast ? coast.getAttribute('d') : '');
  const cx = 230, cy = 112, r = 92;
  let far = 0;
  for (let i = 0; i + 1 < coords.length; i += 2) if (Math.sqrt(Math.pow(coords[i] - cx, 2) + Math.pow(coords[i + 1] - cy, 2)) > r + 0.06) far++;
  const xs = labels.map((t) => Number(t.getAttribute('x')));
  const ys = labels.map((t) => Number(t.getAttribute('y')));
  const nums2 = (d) => (d || '').split(' ').filter((t) => t !== '' && !isNaN(Number(t))).map(Number);
  const area = nums2(land ? land.getAttribute('d') : '');
  return JSON.stringify({
    panel: !!panel, svg: !!svg,
    viewBox: svg ? svg.getAttribute('viewBox') : null,
    ocean: svg ? svg.querySelectorAll('.globe-ocean').length : 0,
    disk: svg ? svg.querySelectorAll('.globe-disk').length : 0,
    shade: svg ? svg.querySelectorAll('#globe-shade stop').length : 0,
    landPts: area.length / 2,
    coastPts: coords.length / 2,
    coastOutside: far,
    wires: svg ? svg.querySelectorAll('.globe-wire').length : 0,
    sweeps: svg ? svg.querySelectorAll('.globe-sweep').length : 0,
    links: svg ? svg.querySelectorAll('.globe-link').length : 0,
    stems: panel ? panel.querySelectorAll('.globe-stem').length : 0,
    base: panel ? panel.querySelectorAll('.globe-base').length : 0,
    selected: panel ? panel.querySelectorAll('.globe-selected').length : 0,
    labels: labels.length, pins: pins.length, hits: hits.length,
    hitData: hits.map((h) => ({ node: h.getAttribute('data-node'), index: Number(h.getAttribute('data-index')), region: h.getAttribute('data-region'), online: h.getAttribute('data-online') === '1' })),
    labelSide: xs.map((x) => (x < cx ? 'L' : 'R')),
    labelMinDist: xs.length ? Math.min.apply(null, xs.map((x) => Math.abs(x - cx))) : 999,
    labelY: ys.map((y) => y - 3),
    // 标签的**实际墨迹盒**（不是估的宽度）：比它跟 SVG 视口盒一比，就知道有没有被裁。
    labelBox: labels.map((t) => { const r = t.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)] }),
    labelText: labels.map((t) => t.textContent),
    svgBox: svg ? (() => { const r = svg.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)] })() : null,
    caption: caption ? caption.textContent : null,
    sideTitle: panel ? panel.querySelector('.globe-side-title').textContent : null,
    regs: regs.map((b) => ({ text: b.querySelector('span').textContent, count: Number(b.querySelector('b').textContent), on: b.getAttribute('aria-pressed') === 'true', title: b.getAttribute('title') || '', dot: b.querySelector('.globe-reg-dot') !== null })),
    flags: regs.length - 1 === (panel ? panel.querySelectorAll('.globe-reg-flag').length : 0),
    flagSrc: panel && panel.querySelector('.globe-reg-flag') ? panel.querySelector('.globe-reg-flag').getAttribute('src') : null,
    atlas: atlas ? { h: Math.round(atlas.getBoundingClientRect().height), w: Math.round(atlas.getBoundingClientRect().width), touch: getComputedStyle(atlas).touchAction, cursor: getComputedStyle(atlas).cursor } : null,
    cols: panel ? getComputedStyle(panel).gridTemplateColumns : null,
    landFill: land ? getComputedStyle(land).fill : null,
    pinStroke: pins.length ? getComputedStyle(pins[0]).stroke : null,
    labelFill: labels.length ? getComputedStyle(labels[0]).fill : null,
    warn: (() => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      el.style.stroke = 'var(--warn)';
      document.body.appendChild(el);
      const v = getComputedStyle(el).stroke;
      el.remove();
      return v;
    })(),
    labelPaint: labels.length ? getComputedStyle(labels[0]).paintOrder : null,
    captionFont: caption ? getComputedStyle(caption).fontSize : null,
    cards: document.querySelectorAll('[data-slot="card"][role="button"]').length,
    toggle: (() => { const b = document.querySelector('.globe-toggle'); return b ? { pressed: b.getAttribute('aria-pressed'), title: b.getAttribute('title'), w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height), cls: b.className } : null })(),
    icons: [...document.querySelectorAll('header button, header a')].map((b) => b.getAttribute('title')).filter((t) => t !== null),
    stored: (() => { try { return localStorage.getItem('jikasei:globe') } catch (e) { return 'ERR' } })(),
    url: location.pathname,
    heading: document.body.innerText.slice(0, 80),
  });
})()`

const open = async (opts = {}) => {
  errors = []
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  let state = null
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    const raw = await js(READ)
    if (!raw) continue
    state = JSON.parse(raw)
    if (opts.wantGlobe === false ? i > 6 : state.panel) break
  }
  return state
}

/** 与 @/lib/globe 的 links() 同一套抽样公式：跨地区、且 (a·7 + b·3) % divisor === 1。
 *  除数走 linkDivisor（小机群 8 抽一；针一多除数跟着涨、大机群收口）—— 别再写死 8。 */
const expectLinks = (hits) => {
  const online = hits.filter((h) => h.online)
  const divisor = linkDivisor(1, online.length)
  let n = 0
  for (let a = 0; a < online.length; a++) {
    for (let b = a + 1; b < online.length; b++) {
      if (online[a].region === online[b].region) continue
      if ((online[a].index * 7 + online[b].index * 3) % divisor !== 1) continue
      n++
    }
  }
  return n
}

/** ★ 标签有没有被 SVG 的视口裁掉：逐行比"文字的墨迹盒"与"SVG 视口盒"。 */
const clipped = (st) => st.labelBox.filter(([l, r]) => l < st.svgBox[0] - 1 || r > st.svgBox[1] + 1)

console.log('\n=== 一、七台演示机（合成夹具，桌面 1440×900） ===')
fleet = LIVE.nodes
let s = await open()
check('地球面板画出来了', s?.panel === true && s.svg === true)
check('画布是上游那套 460×240', s.viewBox === '0 0 460 240', s.viewBox)
check('海底/圆盘/明暗三件都在', s.ocean === 1 && s.disk === 1 && s.shade === 3, `${s.ocean}/${s.disk}/${s.shade}`)
check('岸线画出来了（几百个点，不是空路径）', s.landPts > 200, `${s.landPts} 个点`)
check('★ 没有一条岸线越出圆盘', s.coastOutside === 0, `${s.coastOutside} 个点在外面`)
check('经纬网在（medium 档 12 条经 + 5 条纬 + 赤道）', s.wires >= 17, `${s.wires} 条`)
check('扫掠经线 1 条（medium 档）', s.sweeps === 1, `${s.sweeps} 条`)
check('圆盘下沿那条基线 1 条', s.base === 1)
const visible = s.hits
check('每台看得见的机器一枚针、一条引线、一行字', s.pins === visible && s.stems === visible && s.labels === visible, `${s.pins}/${s.stems}/${s.labels} vs ${visible}`)
check('★ 标签全在圆盘之外（不压在地球上）', s.labelMinDist > 92, `最近的 ${Math.round(s.labelMinDist)} > 92`)
check('★ 没有一行标签被画布裁掉', clipped(s).length === 0, JSON.stringify(clipped(s)))
check('标签落在画布内（y 在 12~204）', s.labelY.every((y) => y >= 12 && y <= 204), JSON.stringify(s.labelY))
check('引线抽样与公式一致', s.links === expectLinks(s.hitData), `${s.links} 条 vs 算出的 ${expectLinks(s.hitData)}`)
check('左右两摞数量均衡（差 ≤ 2）', Math.abs(s.labelSide.filter((x) => x === 'L').length - s.labelSide.filter((x) => x === 'R').length) <= 2, JSON.stringify(s.labelSide))
check('底部文案：ORTHOGRAPHIC + 经纬度 + 档位', /^ORTHOGRAPHIC · \d+°[EW] \d+°[NS] · MEDIUM$/.test(s.caption || ''), s.caption)
check('地区列表第一行是「全部」并给出总台数', s.regs[0]?.text === '全部' && s.regs[0]?.count === 7, JSON.stringify(s.regs[0]))
check('地区按台数从多到少（东京 3、圣何塞 2、法兰克福 1、阿什本 1）',
  JSON.stringify(s.regs.slice(1).map((r) => [r.text, r.count])) === JSON.stringify([['Tokyo', 3], ['San Jose', 2], ['Frankfurt am Main', 1], ['Ashburn', 1]]),
  JSON.stringify(s.regs.slice(1).map((r) => [r.text, r.count])))
check('每一行地区都配了旗子（全部那行没有）', s.flags === true && s.flagSrc === '/flags/JP.svg', `${s.flagSrc}`)
check('没选地区时选中的只有「全部」那一行', s.regs[0].on === true && s.regs.slice(1).every((r) => !r.on), JSON.stringify(s.regs.map((r) => r.on)))
check('侧栏标题就是「地区」（还没定位）', s.sideTitle === '地区', s.sideTitle)
check('★ 针用主题里那个琥珀色（--warn）的空心环、标签垫了底色描边', s.pinStroke === s.warn && s.labelPaint === 'stroke', `${s.pinStroke} vs ${s.warn} / ${s.labelPaint}`)
check('圆盘高度 280（上游同值）', s.atlas?.h === 280, `${s.atlas?.h}`)
check('桌面是两列（地球 1.35 : 侧栏 0.65）', String(s.cols).split(' ').length === 2, s.cols)
check('顶栏那枚开关在、默认是按下的（默认开）', s.toggle?.pressed === 'true' && s.toggle?.w === 36 && s.toggle?.h === 36, JSON.stringify(s.toggle))
// 顺序钉住是为了让「谁被挪走了」一眼可见。搜索那格不在这张表里 —— 它是个 <input>（收起时是
// 一枚方形图标），不是按钮；它的位置与开合由 tools/verify_search.mjs 管。
check('顶栏顺序：登录 → 卡片形态 → 地球 → 切换主题（没有养鸡场那枚）',
  JSON.stringify(s.icons) === JSON.stringify(['登录', '卡片形态', '隐藏节点地球', '切换主题']), JSON.stringify(s.icons))
check('控制台无异常', errors.length === 0, errors.join(' | '))
await shot('01-live-desktop.png')
await shotPanel('00-panel.png')

console.log('\n=== 二、空闲自转与重画节奏 ===')
await js(`(() => {
  window.__ticks = 0;
  const land = document.querySelector('.globe-land');
  window.__mo = new MutationObserver(() => { window.__ticks++ });
  window.__mo.observe(land, { attributes: true, attributeFilter: ['d'] });
  return true;
})()`)
const captionBefore = (await js(READ) && JSON.parse(await js(READ)).caption)
await send('Performance.enable')
const m1 = (await send('Performance.getMetrics')).result.metrics
await sleep(3000)
const m2 = (await send('Performance.getMetrics')).result.metrics
const ticks = await js('(window.__mo.disconnect(), window.__ticks)')
const after = JSON.parse(await js(READ))
const metric = (m, n) => m.find((x) => x.name === n)?.value ?? 0
const busy = (metric(m2, 'TaskDuration') - metric(m1, 'TaskDuration')) / 3
const lonOf = (c) => Number((c || '').replace('ORTHOGRAPHIC · ', '').split('°')[0])
check('3 秒里地球真的在转（经度变了 5° 以上）', Math.abs(lonOf(after.caption) - lonOf(captionBefore)) >= 5, `${captionBefore} → ${after.caption}`)
check('重画节奏跟着档位（medium 64ms → 10~25 张/秒）', ticks >= 30 && ticks <= 75, `3 秒 ${ticks} 张 ≈ ${(ticks / 3).toFixed(1)}/秒`)
const narrowHint = s.atlas.w < 900 ? '（这一趟是桌面宽度）' : ''
console.log(`  INFO  本机主线程占用：自转 3 秒里忙了 ${(busy * 100).toFixed(1)}% ${narrowHint}`)
check('自转不会把主线程占满', busy < 0.5, `${(busy * 100).toFixed(1)}%`)

console.log('\n=== 三、点地区：飞过去 + 钉住 + 只留下该地区的机器 ===')
const clicked = await js(`(() => {
  const rows = [...document.querySelectorAll('.globe-reg')];
  const hit = rows.find((b) => b.textContent.indexOf('Tokyo') >= 0);
  if (!hit) return null;
  hit.click();
  return hit.textContent;
})()`)
await sleep(600)
const filtered = JSON.parse(await js(READ))
check('点的是东京那一行', String(clicked).indexOf('Tokyo') >= 0, String(clicked))
check('★ 下面的列表只剩该地区的机器（3 台）', filtered.cards === 3, `${filtered.cards} 张卡片`)
check('★ 那一行被标成选中（其余都没选中）', filtered.regs.filter((r) => r.on).length === 1 && filtered.regs.find((r) => r.text.indexOf('Tokyo') >= 0)?.on === true, JSON.stringify(filtered.regs.filter((r) => r.on)))
check('侧栏标题变成「地区 · 已定位」', filtered.sideTitle === '地区 · 已定位', filtered.sideTitle)
// ★ 桌面（1440）上地区行是**原来的紧凑高度**：2026-10-07 站长看过桌面之后要求「改回原来那样」——
//   撑到 32 只留给窄屏（≤899px，手指操作）。这里钉住桌面这一支，免得哪天又全局撑高。
const rowH = await js(`Math.round(document.querySelector('.globe-reg').getBoundingClientRect().height)`)
check('桌面地区行是紧凑高度（≤24px；撑高只留给窄屏）', rowH <= 24, `${rowH}px`)
check('地球上多了一枚定位标记', filtered.selected === 1, `${filtered.selected}`)
check('视角飞过去了（文案里的经度接近东京 139.7°E）', Math.abs(lonOf(filtered.caption) - 140) <= 1, filtered.caption)
check('钉住之后不再自转', (await (async () => {
  const a = JSON.parse(await js(READ)).caption
  await sleep(900)
  return a === JSON.parse(await js(READ)).caption
})()) === true, filtered.caption)
await shot('02-live-region.png')

check('再点一次同一行 = 取消筛选', await (async () => {
  await js(`(() => { const b = [...document.querySelectorAll('.globe-reg')].find((x) => x.textContent.indexOf('Tokyo') >= 0); b.click(); return true })()`)
  await sleep(500)
  const back = JSON.parse(await js(READ))
  return back.cards === 7 && back.selected === 0 && back.regs[0].on === true && back.sideTitle === '地区'
})())
check('取消之后又转起来了', await (async () => {
  const a = JSON.parse(await js(READ)).caption
  await sleep(1200)
  return JSON.parse(await js(READ)).caption !== a
})())

// ★关掉地球时，地区筛选要跟着清掉：地区那列长在地球里，地球一藏就**没地方点「取消」**，
//   列表会一直只剩那个地区的机器，看着像站点坏了（这一条就是防这个的回归）。
{
  await js(`(() => { const b = [...document.querySelectorAll('.globe-reg')].find((x) => x.textContent.indexOf('Tokyo') >= 0); b.click(); return true })()`)
  await sleep(500)
  const pinned = JSON.parse(await js(READ))
  check('（前置）先选中东京：列表只剩 3 台', pinned.cards === 3, `${pinned.cards} 张卡片`)
  await js(`(() => { document.querySelector('.globe-toggle').click(); return true })()`)
  await sleep(500)
  const hidden = JSON.parse(await js(READ))
  check('★ 关掉地球：地区筛选跟着清掉（列表回到全部 7 台，不是只剩东京那 3 台）',
    hidden.panel === false && hidden.cards === 7, `panel=${hidden.panel} / 卡片 ${hidden.cards}`)
  await js(`(() => { document.querySelector('.globe-toggle').click(); return true })()`)
  await sleep(700)
  const back = JSON.parse(await js(READ))
  check('再打开地球：回到「全部」，没把刚才那次筛选记回来',
    back.panel === true && back.cards === 7 && back.regs[0].on === true, `panel=${back.panel} / 卡片 ${back.cards} / 首行选中 ${back.regs[0].on}`)
}

console.log('\n=== 四、拖拽：转地球、不误开机器 ===')
const box = await js(`(() => { const r = document.querySelector('.globe-atlas').getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }) })()`)
const b = JSON.parse(box)
const midX = b.x + Math.round(b.w / 2)
const midY = b.y + Math.round(b.h / 2)
const beforeDrag = JSON.parse(await js(READ)).caption
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: midX, y: midY, button: 'left', buttons: 1, clickCount: 1 })
for (let i = 1; i <= 6; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: midX + i * 25, y: midY, button: 'left', buttons: 1 })
  await sleep(30)
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: midX + 150, y: midY, button: 'left', buttons: 0, clickCount: 1 })
await sleep(200)
const dragged = JSON.parse(await js(READ))
check('★ 拖 150px 就把视角转走了（0.48°/px ≈ 72°）', Math.abs(lonOf(dragged.caption) - lonOf(beforeDrag)) >= 40 && Math.abs(lonOf(dragged.caption) - lonOf(beforeDrag)) <= 100,
  `${beforeDrag} → ${dragged.caption}`)
check('★ 拖拽没有顺手打开某台机器（URL 还在列表）', dragged.url === '/', dragged.url)
check('拖拽态收尾了（光标回到 grab）', dragged.atlas?.cursor === 'grab', dragged.atlas?.cursor)
check('拖完继续自转（拖拽不钉住）', await (async () => {
  const a = JSON.parse(await js(READ)).caption
  await sleep(1200)
  return JSON.parse(await js(READ)).caption !== a
})())

console.log('\n=== 五、点针打开那台机器 ===')
const pin = await js(`(() => {
  const hit = document.querySelector('.hit');
  if (!hit) return null;
  const r = hit.getBoundingClientRect();
  return JSON.stringify({ id: hit.getAttribute('data-node'), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) });
})()`)
const p = JSON.parse(pin)
check('命中圆有手指点得中的尺寸（半径 9 → 屏幕上更大）', p.w >= 12 && p.h >= 12, `${p.w}×${p.h}`)
// 点之前先记下那个像素上最顶上是谁：`hit` 才对（地球本身、标签、引线都是 pointer-events: none，
// 只有命中圆吃指针）。点不动机器时，这条 INFO 是第一现场。
console.log(`  INFO  该像素上是 ${await js(`(() => { const el = document.elementFromPoint(${p.x}, ${p.y}); return el ? (el.getAttribute('class') || el.tagName) : 'none' })()`)}`)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 })
await sleep(700)
const opened = JSON.parse(await js(READ))
check('★ 点针进得去那台机器的详情页', opened.url === `/node/${p.id}`, `${opened.url} 期望 /node/${p.id}`)
// 光比 URL 不够：详情页整页崩掉时 URL 也照样变（pushState 在渲染之前）。比它真的画出来了。
const detailText = String(await js('document.body.innerText')).slice(0, 200)
check('  详情页真的画出来了（不是整页空白）', detailText.length > 40 && /CPU|内存/.test(detailText), JSON.stringify(detailText.slice(0, 60)))
await js(`(() => { history.pushState({}, '', '/'); location.reload(); return true })()`)
await sleep(800)
const backList = JSON.parse(await js(READ) ?? '{}')
check('回到列表页地球还在（不是一次性组件）', backList.panel === true, JSON.stringify(backList.panel))

console.log('\n=== 六、顶栏开关：关掉、刷新还记得、再打开 ===')
await js(`document.querySelector('.globe-toggle').click()`)
await sleep(400)
const off = JSON.parse(await js(READ))
check('★ 关掉后面板整个不挂载', off.panel === false, JSON.stringify(off.panel))
check('开关本身还在（不然就再也开不回来了）', off.toggle?.pressed === 'false' && off.toggle?.title === '显示节点地球', JSON.stringify(off.toggle))
check('选择记在他自己的浏览器里', off.stored === '0', String(off.stored))
check('关掉后下面那张列表照旧是 7 张卡片', off.cards === 7, `${off.cards}`)
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1200)
const reloaded = JSON.parse(await js(READ))
check('★ 刷新之后仍然是关着的', reloaded.panel === false && reloaded.stored === '0', `${reloaded.panel} / ${reloaded.stored}`)
await js(`document.querySelector('.globe-toggle').click()`)
await sleep(400)
const on = JSON.parse(await js(READ))
// ★ 2026-10-07 起站点设置里有了「节点地球」开关：访客点回**与站长那一档相同**的档位时，
// 记录会被删掉（= 重新跟着站长走，与卡片形态同一套口径）。这个桩里站长那档是「开」（默认），
// 所以点回来之后 localStorage 里**没有**这个键、面板照旧显示。
check('再点一下就回来了（与站长那档相同，记录被清掉＝重新跟着站长走）',
  on.panel === true && on.stored === null, `${on.panel} / ${on.stored}`)

console.log(`\n=== 七、${FLEET.length} 台的合成机群（两摞标签都排满、有离线机器、有一个超长名字） ===`)
fleet = FLEET
s = await open()
check('面板照常', s.panel === true)
const many = s.hits
check('每台看得见的机器都排上了（针 = 引线 = 标签 = 命中圆）', s.pins === many && s.stems === many && s.labels === many && s.hits === many, `针 ${s.pins} / 引线 ${s.stems} / 字 ${s.labels} / 命中圆 ${s.hits}`)
check('★ 标签还是不压地球', s.labelMinDist > 92, `${Math.round(s.labelMinDist)}`)
check('★ 两摞都排得整整齐齐（互不重叠、都在画布内）', (() => {
  for (const side of ['L', 'R']) {
    const ys = s.labelY.filter((_, i) => s.labelSide[i] === side)
    if (new Set(ys).size !== ys.length) return false
    if (!ys.every((y) => y >= 12 && y <= 204)) return false
  }
  return true
})(), JSON.stringify(s.labelY))
check('★ 岸线依旧一条都没翻到正面', s.coastOutside === 0, `${s.coastOutside}`)
check('地区列表把 26 台分完（引线抽样与公式一致）', s.links === expectLinks(s.hitData), `${s.links} vs ${expectLinks(s.hitData)}`)
check(`没国家的机器不上地球（${FLEET.length} 台里 ${LOCATED} 台有落点，但"全部"仍是 ${FLEET.length}）`,
  s.regs[0].count === FLEET.length, JSON.stringify(s.regs[0]))
check('★ 地区按台数从多到少（结构不变式，不写死某一套数据）',
  s.regs.slice(1).every((r, i, arr) => i === 0 || arr[i - 1].count >= r.count),
  JSON.stringify(s.regs.slice(1, 5).map((r) => [r.text, r.count])))
check('地区台数合计 = 有落点的台数（没落点的不进地区列表，但仍然算在「全部」里）',
  s.regs.slice(1).reduce((sum, r) => sum + r.count, 0) === LOCATED, `${s.regs.slice(1).reduce((sum, r) => sum + r.count, 0)} / ${LOCATED}`)
// ★ 回归：站长截图里「🇭🇰 HK 3 ｜ 🇭🇰 Hong Kong 3」并排出现 —— 同一个地方两行、两面一样的旗。
//   根因：移植时漏了上游 `fallbackCity` 的国家级兜底城名 —— 名字里带城市线索的 HK 落
//   `HK · Hong Kong`，没带的落裸 `HK`。这份夹具正是 2 台不带 + 3 台带 —— 修好后**只能有一行**。
check('★ 一个 HK 只有一行（带线索与不带线索不再裂成「HK」+「Hong Kong」两行）',
  s.regs.filter((r) => r.text === 'Hong Kong').length === 1 && s.regs.find((r) => r.text === 'Hong Kong')?.count === 5 && !s.regs.some((r) => r.text === 'HK'),
  JSON.stringify(s.regs.map((r) => [r.text, r.count])))
check('★ 兜底的国家不出裸码行（HK/TW/SG/JP/KR 都有城名；US/DE 这类照旧退国家码）',
  !s.regs.slice(1).some((r) => ['HK', 'TW', 'SG', 'JP', 'KR'].includes(r.text)) && s.regs.some((r) => r.text === 'US'),
  JSON.stringify(s.regs.map((r) => r.text)))
// ★ 2026-10-08：地区行上的离线可见性（这块面板以前对「离线」一个字都不说 —— 针的颜色
//   也不分在线离线）。有离线的行挂一枚小点 + 悬停写明台数；全在线的行不许有点。
{
  const hkRow = s.regs.find((r) => r.text === 'Hong Kong')
  check('★ 地区里有离线机器时行上看得到（HK 那行：小点 + 悬停「5 台 · 1 台离线」）',
    hkRow?.dot === true && (hkRow.title || '').indexOf('5 台') >= 0 && (hkRow.title || '').indexOf('1 台离线') >= 0,
    JSON.stringify(hkRow))
  const usRow = s.regs.find((r) => r.text === 'US')
  check('★ 全在线的地区不带离线点（US 那行）', usRow?.dot === false, JSON.stringify(usRow))
  check('「全部」那行悬停写明合计口径（27 台里有 2 台认不出国家、不上地区列表）',
    (s.regs[0].title || '').indexOf('27 台') >= 0 && (s.regs[0].title || '').indexOf('2 台') >= 0 && (s.regs[0].title || '').indexOf('认不出国家') >= 0,
    s.regs[0].title)
}
check('控制台无异常', errors.length === 0, errors.join(' | '))
await shot('03-synth-desktop.png')

console.log('\n=== 八、深色 / 亮色两套都要对 ===')
// ★ 必须**显式**跑两遍：headless Chrome 的默认是亮色，只切一次亮色等于拿亮色跟亮色比，
// 那两条断言会恒真（第一版就是这么写的，写的时候没看出来）。
const themed = async (theme) => {
  await js(`(() => { localStorage.setItem('theme', '${theme}'); return true })()`)
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  await sleep(1400)
  return JSON.parse(await js(READ))
}
const dark = await themed('dark')
check('深色下照常渲染', dark.panel === true && dark.landPts > 200, JSON.stringify(dark.landPts))
check('深色下 land/ocean 用的是深色那一套（与亮色不同）', dark.landFill !== '', `${dark.landFill}`)
check('深色下针是深色那档的琥珀', dark.pinStroke === dark.warn, `${dark.pinStroke} vs ${dark.warn}`)
check('深色下控制台无异常', errors.length === 0, errors.join(' | '))
await shot('04a-synth-dark.png')
await shotSide('04c-synth-dark-region.png')
const light = await themed('light')
check('亮色下照常渲染', light.panel === true && light.landPts > 200, JSON.stringify(light.landPts))
check('★ 亮色下陆地是另一套染色（不是深色那套）', light.landFill !== dark.landFill, `${dark.landFill} → ${light.landFill}`)
check('★ 标签文字的灰度跟着主题走', light.labelFill !== dark.labelFill, `${dark.labelFill} → ${light.labelFill}`)
check('亮色下控制台无异常', errors.length === 0, errors.join(' | '))
await shot('04b-synth-light.png')

console.log('\n=== 九、手机视口 390×844 ===')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
await js(`(() => { localStorage.removeItem('theme'); return true })()`)
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(1600)
const mobile = JSON.parse(await js(READ))
check('窄屏照常画地球（不是像上游那样整块不画）', mobile.panel === true && mobile.landPts > 50, `${mobile.landPts} 个点`)
// ★ 2026-10-07 站长看过手机上的 LOW 档后说「地球太简陋了」→ 窄屏不再降档，跟桌面同档：
//   detailed 岸线（不是 104 点的粗草图）、30° 经纬网、1 条扫掠、引线。
//   回退开关是 Globe.tsx 里的 NARROW_LOW_TIER（改回 true 即一行回退）；那条路径由这几条断言守着，
//   真要回退就得连着这里一起改 —— 免得"悄悄降档"没人发现。
check('★ 窄屏不再降档：与桌面同档（detailed 岸线 + 30° 网 + 1 扫掠 + 引线）',
  (mobile.caption || '').indexOf('· MEDIUM') > 0 && mobile.sweeps === 1 && mobile.links > 0 && mobile.landPts > 250,
  `${mobile.caption} / 岸线点 ${mobile.landPts}（LOW 档约 120）/ ${mobile.wires} 条网线 / ${mobile.sweeps} 扫掠 / ${mobile.links} 连线`)
check('★ 窄屏把竖向手势让给页面滚动（touch-action: pan-y）', mobile.atlas?.touch === 'pan-y', String(mobile.atlas?.touch))
check('窄屏面板是上下两段（单列）', String(mobile.cols).split(' ').length === 1, mobile.cols)
check('窄屏圆盘压到 210（省掉上下各 38px 的空档）', mobile.atlas?.h === 210, `${mobile.atlas?.h}`)
check('窄屏标签仍然不压地球', mobile.labelMinDist > 92, `${Math.round(mobile.labelMinDist)}`)
check('★ 窄屏上超长的那行标签也没被裁（靠画布留白撑开）', clipped(mobile).length === 0, JSON.stringify(clipped(mobile)))
check('★ 窄屏画布确实撑开了（桌面不需要、窄屏需要）', mobile.viewBox !== s.viewBox, `${s.viewBox} → ${mobile.viewBox}`)
check('★ 放不下的那行字被截成省略号（不是让视口裁掉）',
  mobile.labelText.some((t) => t.endsWith('…')), JSON.stringify(mobile.labelText.filter((t) => t.endsWith('…'))))
check('窄屏地球没有被挤小太多（撑开量封顶 36，圆盘至少还有 84% 大）', (() => {
  const pad = Number(String(mobile.viewBox).split(' ')[0])
  return pad <= -0.5 ? 460 / (460 - pad * 2) >= 0.84 : true
})(), mobile.viewBox)
check('窄屏没有横向溢出（页面不左右滚）', await js('document.documentElement.scrollWidth <= 390'), await js('String(document.documentElement.scrollWidth)'))
check('窄屏控制台无异常', errors.length === 0, errors.join(' | '))
await sleep(400)
await shot('05-synth-mobile.png')
await send('Emulation.clearDeviceMetricsOverride')

console.log(`\n${fail ? '✗' : '✓'} globe: ${pass} 条通过 / ${fail} 条失败（截图在 ${OUT}/）`)
chrome?.kill()
server.close()
process.exit(fail ? 1 : 0)

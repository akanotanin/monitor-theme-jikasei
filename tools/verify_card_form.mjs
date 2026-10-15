// 「宽卡」形态的护栏：照参考站重排之后钉住的那一套（六块版式，逐块断）。
//
// 卡片从上到下六块，本护栏逐块断：
//   ① 身份行：旗子 + 名字（2026-10-15 起与其余形态统一：不带状态点、不带「已离线」徽章，在线与否写在②那行文字里）；
//   ② 系统 · 运行时间（四种处境各自的写法见 WideCard 的 metaLine）；
//   ③ 四个读数格 CPU / 内存 / 存储 / 负载：标签小灰字、读数加粗两小数、条压在读数下缘；
//      负载的读数是一分钟均值、条按「满载的几成」（load / 核数）；
//   ④ 上传 / 下载两栏（左上传右下载、中间竖线）：累计总量 + 实时速率；
//   ⑤ 总流量：左「已用 / 额度」、右「流量重置：每月 N 日」（无额度写 N/A），下面一条全宽带；
//   ⑥ 底注：价格 / 到期在左、备注小卡片在右（**最多 3 枚**；整行恒定占位）；
//   全卡高度不随内容变（有备注 / 没备注 / 没价格 / 掉线一律等高，见 ⑦）。
//
// 「备注显示位置」那一层（只在详情 / 都不显示 等）在 tools/verify_public_remark.mjs 的宽卡段；
// 档位菜单/存储那一路在 tools/verify_card_style_menu.mjs；形状第一层在 tools/verify_card_styles.mjs。
//
// 夹具六台：① 在线全字段 ② 掉线（有历史、读数写 —）③ 从未接入（那行说明）④ 连上但没上报
//         ⑤ 备注四枚（断上限）⑥ 不限流量（断 N/A 与 ∞）。
// 用法：cd <repo> && node tools/verify_card_form.mjs（先 npm run build，dist/ 得是新的）
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpdir } from 'node:os'

const PORT = Number(process.env.CARDFORM_PORT || 5271)
const CDP_PORT = PORT + 4000
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2' }
const GB = 1024 ** 3

const metrics = (o) => ({
  uptime: 318521, cpu: 3.2, load: [0.08, 0.03, 0.01],
  mem_total: 2 * GB, mem_used: 431800320, swap_total: 0, swap_used: 0,
  disk_total: 40 * GB, disk_used: 9214510720,
  net_rx: 866000, net_tx: 464000, total_rx: 5707805336, total_tx: 5203609923,
  month_rx: 4650258264, month_tx: 4351673970, tcp: 16, udp: 3, procs: 75, ...o,
})
const base = (id, name, o) => ({
  id, name, sort: id, public: true, online: true, country: 'JP', group: '',
  last_seen: Math.floor(Date.now() / 1000) - 3, last_seen_ago: 3,
  metrics: metrics({}), os: 'Debian GNU/Linux 12 (bookworm)', kernel: '6.1.0-53-cloud-amd64', arch: 'x86_64', virt: 'kvm',
  cpu_name: 'AMD EPYC Processor', cpu_cores: 2, mem_total: 2 * GB, swap_total: 0, disk_total: 40 * GB, agent_version: '1.4.0',
  price: 349, currency: 'CNY', billing_cycle: 'yearly', expires_at: '2027-07-21', expires_in: 299,
  traffic_limit: 500 * GB, traffic_mode: 'sum', traffic_reset_day: 21, month_start: '2026-09-21',
  day_rx: 2140585887, day_tx: 2191393745, month_rx: 4650258264, month_tx: 4351673970,
  total_rx: 5707805336, total_tx: 5203609923,
  ...o,
})

const nodes = [
  // ① 在线、字段齐全（价格 / 到期 / 额度 / 重置日都有）—— 底注右侧还有一枚公开备注
  base(1, '东京一号', { public_remark: '优化线路' }),
  // ② 掉线：读数写「—」，但总量与底注还在，底注右侧还摊一枚备注
  base(2, '掉线二号', {
    online: false, metrics: null, last_seen_ago: 7200, country: 'HK',
    public_remark: '优化线路', price: 0, expires_at: null, expires_in: null,
  }),
  // ③ 从未接入：那行说明，没有读数区
  base(3, '从未接入三号', { online: false, metrics: null, last_seen: 0, last_seen_ago: null, cpu_cores: 0, mem_total: 0, os: '' }),
  // ④ 连上但还没上报（hub 口径：online 真、metrics 空）
  base(4, '刚连上四号', { online: true, metrics: null, last_seen: 0, last_seen_ago: null }),
  // ⑤ 备注四枚：卡片这一侧只该摊前三枚
  base(5, '备注五号', { public_remark: '甲, 乙, 丙, 丁' }),
  // ⑥ 不限流量：重置那一格写 N/A，已用那一截写「X / ∞」
  base(6, '不限量六号', { traffic_limit: 0, price: 0, expires_at: null, expires_in: null }),
]

const server = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  const json = (b) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(b)) }
  if (path.startsWith('/api/')) {
    if (path === '/api/me') return json({ authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '卡片形态校验', history_days: 30 })
    if (path === '/api/nodes') return json({ nodes })
    // ★ 站点配置由本伺服自己回答：默认档之外还要把这一档指到「宽卡」——默认档是「详细」，
    //   回 `{}` 的话整轮判据会全落在详细档上、一条也断不到宽卡（踩过）。
    if (path.endsWith('/config')) return json({ cardStyle: 'wide' })
    if (path.includes('/metrics')) return json({ metrics: [], ping: [], probes: {}, loss: {} })
    return json({})
  }
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' })
    return res.end(readFileSync('dist/index.html'))
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p)) || 'chrome'
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*', '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--no-proxy-server', `--user-data-dir=${join(tmpdir(), `cardform${CDP_PORT}`)}`, '--no-sandbox', 'about:blank'], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { /* 等 */ }
  if (!wsUrl) await sleep(250)
}
if (!wsUrl) throw new Error('Chrome 没起来')
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
let id = 0
const pending = new Map()
const errors = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.text || 'exception')
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') errors.push((m.params.args || []).map((a) => a.value).join(' '))
}
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1600, deviceScaleFactor: 1, mobile: false })

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
for (let i = 0; i < 60; i++) { await sleep(200); if (await js(`document.querySelectorAll('[data-node-card]').length === 6`)) break }
await sleep(700)

// 一次把六张卡片的形态量回来（选择器都写在探针里，断言在 Node 一侧判）。
const probe = `(() => {
  const paint = (el, under) => {
    const c = document.createElement('canvas'); c.width = c.height = 1; const x = c.getContext('2d')
    if (under) { x.fillStyle = under; x.fillRect(0, 0, 1, 1) }
    x.fillStyle = getComputedStyle(el).backgroundColor
    x.fillRect(0, 0, 1, 1)
    const d = x.getImageData(0, 0, 1, 1).data
    return { r: d[0], g: d[1], b: d[2], a: +(d[3] / 255).toFixed(2) }
  }
  const cards = [...document.querySelectorAll('[data-node-card]')]
  const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } }
  const style = (el) => { const s = getComputedStyle(el); return { size: s.fontSize, weight: s.fontWeight, color: s.color } }
  return JSON.stringify(cards.map((c) => {
    const m = c.querySelector('[data-metrics]')
    const dot = c.querySelector('[data-status]')
    const net = c.querySelector('[data-net]')
    const cells = m ? [...m.children].map((el) => {
      const divs = el.querySelectorAll('div')
      const bar = el.querySelectorAll('div')[2]
      return {
        label: divs[0].textContent,
        value: divs[1].textContent,
        valueStyle: style(divs[1]),
        labelStyle: style(divs[0]),
        title: el.getAttribute('title'),
        barPct: +(bar.firstElementChild.style.width.replace('%', '')),
        barH: Math.round(bar.getBoundingClientRect().height),
        // 填色：raw = 只填一层的原始样本（读它自己的 alpha），eff = 合成到卡底之后（判灰 / 判彩）
        barFill: paint(bar.firstElementChild),
        barFillEff: paint(bar.firstElementChild, getComputedStyle(c).backgroundColor),
      }
    }) : null
    const traffic = [...c.querySelectorAll('div')].find((d) => d.children.length === 2 && /流量重置/.test(d.textContent))
    const bars = [...c.querySelectorAll('div.overflow-hidden.rounded-full')]
    return {
      name: c.querySelector('h3').textContent,
      box: box(c),
      dot: dot ? { status: dot.dataset.status, size: box(dot), radius: getComputedStyle(dot).borderRadius, color: paint(dot, getComputedStyle(c).backgroundColor) } : null,
      badge: (() => { const b = [...c.querySelectorAll('[data-slot="badge"]')].find((x) => x.textContent.trim() === '已离线'); return b ? { text: b.textContent.trim(), color: paint(b, getComputedStyle(c).backgroundColor) } : null })(),
      meta: c.querySelector('p')?.textContent ?? null,
      cells,
      gridCols: m ? getComputedStyle(m).gridTemplateColumns.split(' ').length : 0,
      // 列表那一层：一行几张卡（宽卡口径，768 起两列）。
      listCols: getComputedStyle(c.parentElement).gridTemplateColumns.split(' ').length,
      divider: m ? getComputedStyle(m).borderTopWidth : null,
      net: net ? {
        uploadText: net.children[0].innerText.replace(/\\\\n/g, ' | '),
        downloadText: net.children[1].innerText.replace(/\\\\n/g, ' | '),
        uploadLeft: net.children[0].getBoundingClientRect().left < net.children[1].getBoundingClientRect().left,
        rule: getComputedStyle(net.children[1]).borderLeftWidth,
      } : null,
      traffic: traffic ? traffic.innerText.replace(/\\\\n/g, ' | ') : null,
      barW: bars.length ? bars[bars.length - 1].firstElementChild.style.width : null,
      note: (() => { const el = [...c.querySelectorAll('span')].find((s) => /^价格|^剩余|^今天到期|^已过期/.test(s.textContent.trim())); return el ? el.textContent.trim() : null })(),
      chips: [...c.querySelectorAll('[data-remark="card"] [data-slot="badge"]')].map((b) => b.innerText.trim()),
      hint: /还没有接入/.test(c.innerText),
    }
  }))
})()`
const cards = JSON.parse(await js(probe) ?? '[]')
// 列表按「有实时数据在前、其余沉底」排（见 App.tsx），所以**按名字取**每一台。
const byName = (n) => cards.find((c) => c.name === n)
const one = byName('东京一号'), down = byName('掉线二号'), never = byName('从未接入三号')
const idle = byName('刚连上四号'), many = byName('备注五号'), unlim = byName('不限量六号')

console.log(`闸门：六张卡片都渲染出来了 ${cards.length === 6 ? '✓' : '✗ ' + cards.length}`)
check('① 六张卡片（三种处境 + 两种边角）都在', cards.length === 6, cards.map((c) => c.name).join(' / '))

// ① 身份行（2026-10-15 起与其余形态统一：不带状态点、不带「已离线」徽章）
console.log('\n① 身份行：旗子 + 名字（在线与否写在②那行文字里）')
check('★ 六张卡都不带状态点（绿点 / 红点只属于源形态，不在本主题的配色语言里）',
  cards.every((c) => c.dot === null), JSON.stringify(cards.map((c) => c.dot)))
check('★ 六张卡都不挂「已离线」徽章（掉线那台由②那行以「已离线」收尾，见下）',
  cards.every((c) => c.badge === null), JSON.stringify(cards.map((c) => c.badge?.text ?? null)))
check('卡片宽度是 510（整页 1080 容器 × 两列），不再是 1280 容器下的 610',
  Math.abs((one?.box?.w ?? 0) - 510) <= 2, `卡宽 ${one?.box?.w} / 高 ${one?.box?.h}`)

// ② meta 行
console.log('\n② 系统 · 运行时间')
check('在线：`Debian 12 · 运行时间 3 天 16 小时`（发行版代号已去掉）',
  one?.meta === 'Debian 12 · 运行时间 3 天 16 小时', String(one?.meta))
check('掉线：以「已离线」收尾', /· 已离线$/.test(down?.meta ?? ''), String(down?.meta))
check('从未接入：以「未接入」收尾（且不写系统名）', never?.meta === '未接入', String(never?.meta))
check('连上未上报：以「在线」收尾', /· 在线$/.test(idle?.meta ?? ''), String(idle?.meta))

// ③ 四个读数格
console.log('\n③ 四个读数格 CPU / 内存 / 存储 / 负载')
check('四格、四列、上面一条分隔线',
  one?.gridCols === 4 && one.cells.length === 4 && Number.parseFloat(one.divider) >= 1,
  `cols=${one?.gridCols} divider=${one?.divider}`)
check('标签依次是 CPU / 内存 / 存储 / 负载（弱化灰、12px）',
  JSON.stringify(one?.cells.map((c) => c.label)) === JSON.stringify(['CPU', '内存', '存储', '负载']) &&
  one.cells.every((c) => c.labelStyle.size === '12px'),
  JSON.stringify(one?.cells.map((c) => c.label)))
check('读数是两小数百分比、加粗、比标签大一档（13px/600）',
  one?.cells[0].value === '3.20%' && one.cells[1].value === '20.11%' && one.cells[2].value === '21.45%' &&
  one.cells.every((c) => c.valueStyle.weight === '600' && Number.parseFloat(c.valueStyle.size) === 13),
  JSON.stringify(one?.cells.map((c) => c.value)))
check('负载读数是一分钟均值（0.08），悬停说明里带三条均值与单位',
  one?.cells[3].value === '0.08' && /0\.08 0\.03 0\.01/.test(one.cells[3].title ?? ''), String(one?.cells[3].title))
check('★ 负载的条 = load / 核数（0.08 / 2 核 = 4%），不是把均值当百分比',
  Math.abs((one?.cells[3].barPct ?? 0) - 4) < 0.1, String(one?.cells[3].barPct))
check('内存 / 存储的条按真实比例（20.11% / 21.45%）',
  Math.abs(one.cells[1].barPct - 20.107) < 0.05 && Math.abs(one.cells[2].barPct - 21.454) < 0.05,
  `${one.cells[1].barPct} / ${one.cells[2].barPct}`)
check('★ 条是 3px、填色为前景色 70%（与其余形态同一族——灰、半透明，不是那支绿）',
  one?.cells.every((c) => c.barH === 3 && c.barFill && c.barFill.a < 1 &&
    Math.abs(c.barFillEff.r - c.barFillEff.g) <= 12 && Math.abs(c.barFillEff.g - c.barFillEff.b) <= 12),
  JSON.stringify(one?.cells.map((c) => ({ h: c.barH, raw: c.barFill, eff: c.barFillEff }))))
check('CPU 的悬停说明写核数（2 核）', one?.cells[0].title === '2 核', String(one?.cells[0]?.title))
check('掉线那台：四格读数都写「—」、条不画（宽度 0）',
  down?.cells.every((c) => c.value === '—' && c.barPct === 0), JSON.stringify(down?.cells?.map((c) => c.value)))

// ④ 上传 / 下载
console.log('\n④ 上传 / 下载两栏')
check('左上传右下载，两栏之间有竖线', one?.net?.uploadLeft === true && Number.parseFloat(one?.net?.rule ?? '0') >= 1,
  `left=${one?.net?.uploadLeft} rule=${one?.net?.rule}`)
check('上传那栏：`↑ 上传` + 累计总量 + 实时速率（tx 侧：4.85 GB / 453 KB/s）',
  /↑ 上传/.test(one?.net?.uploadText ?? '') && /累计 4\.85 GB/.test(one.net.uploadText) && /453 KB\/s/.test(one.net.uploadText),
  String(one?.net?.uploadText))
check('下载那栏：`↓ 下载` + 累计总量 + 实时速率（rx 侧：5.32 GB / 846 KB/s）',
  /↓ 下载/.test(one?.net?.downloadText ?? '') && /累计 5\.32 GB/.test(one.net.downloadText) && /846 KB\/s/.test(one.net.downloadText),
  String(one?.net?.downloadText))
check('掉线那台：速率写「—」，累计总量照写（hub 一直保留总量）',
  /—/.test(down?.net?.uploadText ?? '') && /累计/.test(down.net.downloadText), String(down?.net?.uploadText))

// ⑤ 总流量
console.log('\n⑤ 总流量：数字行 + 全宽进度条')
check('左边「已用 / 额度」、右边「流量重置：每月 N 日」',
  /8\.38 \/ 500\.00 GB/.test(one?.traffic ?? '') && /流量重置：每月 21 日/.test(one.traffic), String(one?.traffic))
check('不限量的那台：重置写 N/A、已用写「X / ∞」',
  /流量重置：N\/A/.test(unlim?.traffic ?? '') && /∞/.test(unlim.traffic), String(unlim?.traffic))
check('全宽进度条按 已用 / 额度 上色（8.38 / 500 ≈ 1.68%）',
  Math.abs(Number.parseFloat(one?.barW ?? '0') - 1.676) < 0.05, String(one?.barW))

// ⑥ 底注
console.log('\n⑥ 底注：价格 / 到期 + 备注小卡片')
check('价格与到期写成 `价格 ¥349.00/年 · 剩余 299 天`',
  one?.note === '价格 ¥349.00/年 · 剩余 299 天', String(one?.note))
check('没填价格、也没有到期日的那台：底注不占位（连字都没有）', unlim?.note === null, String(unlim?.note))
check('★ 备注小卡片最多 3 枚（夹具写了 4 枚：甲 / 乙 / 丙 / 丁）',
  JSON.stringify(many?.chips) === JSON.stringify(['甲', '乙', '丙']) && many.chips.length === 3, JSON.stringify(many?.chips))
check('在线那台也摊备注（一枚「优化线路」，底注右侧与价格同行）',
  JSON.stringify(one?.chips) === JSON.stringify(['优化线路']), JSON.stringify(one?.chips))
check('掉线那台也摊备注（一枚「优化线路」）', JSON.stringify(down?.chips) === JSON.stringify(['优化线路']), JSON.stringify(down?.chips))
check('没写备注的那几台：卡片上没有任何小卡片', idle?.chips.length === 0 && unlim?.chips.length === 0)
check('备注小卡片与底注同一行（右侧、不与价格那截重叠）',
  (await js(`(() => {
    const c = document.querySelector('[data-node-card][data-selected], [data-node-card]')
    const chips = c.querySelector('[data-remark="card"]')
    const note = [...c.querySelectorAll('span')].find((s) => /^价格|^剩余/.test(s.textContent.trim()))
    if (!chips || !note) return false
    return chips.getBoundingClientRect().left >= note.getBoundingClientRect().right - 1
  })()`)) === true)

// ⑦ 从未接入 + 版面
console.log('\n⑦ 从未接入与版面')
check('从未接入那台：只有身份行 + 一行说明，没有读数区', never?.hint === true && never.cells === null, `hint=${never?.hint}`)
// ★底注**恒定占位**（2026-10-16 站长定的新口径，与 kanso 看齐）：有备注 / 没备注、有价格 / 没价格，
// 卡片一律等高 —— 从前那几像素差来自两处：备注小卡片自己 22px 比底注那行小字高一档（+6）、
// 没底注的那台整行不占位（-22）。现在小卡片收成 16px 紧凑档、底注行恒定占位（h-4），两处都钉平。
// 从未接入那台（没有读数区）本来就是另一种卡型，不参与这条判据。
{
  const hs = cards.filter((c) => c.cells).map((c) => c.box.h)
  check('★ 有备注 / 无备注 / 没价格 / 掉线几种卡片高度完全相同（底注恒定占位）',
    hs.length >= 5 && new Set(hs).size === 1,
    JSON.stringify(cards.map((c) => `${c.name}:${c.box.h}`)))
}
{
  // 找不到元素要**报红**（探针返回 -1），别写成 `b ? h : 0` 静默通过。
  const chipH = await js(`(() => {
    const b = document.querySelector('[data-remark="card"] [data-slot="badge"]')
    return b ? Math.round(b.getBoundingClientRect().height * 10) / 10 : -1
  })()`)
  check('★ 备注小卡片收成紧凑档（高 10–16px：塞得进底注那行，不把卡片撑高）',
    typeof chipH === 'number' && chipH >= 10 && chipH <= 16, `实测 ${chipH}px`)
}
check('★ 列表是一行两张宽卡（768 起两列，1440 上两列）', cards[0]?.listCols === 2, `listCols=${cards[0]?.listCols}`)
check('★ 卡片是宽扁的（宽 ≥ 2×高）',
  cards.filter((c) => c.cells).every((c) => c.box.w >= 2 * c.box.h),
  JSON.stringify(cards.map((c) => `${c.box.w}x${c.box.h}`)))
check('1440 视口上整页没有横向溢出',
  (await js('document.documentElement.scrollWidth <= document.documentElement.clientWidth')) === true,
  `${await js('document.documentElement.scrollWidth')} vs ${await js('document.documentElement.clientWidth')}`)

console.log('\n⑧ 窄屏（390）：四列读数格不换行、不横向溢出')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1200, deviceScaleFactor: 2, mobile: true })
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
for (let i = 0; i < 60; i++) { await sleep(200); if (await js(`document.querySelectorAll('[data-node-card]').length === 6`)) break }
await sleep(700)
const m390 = JSON.parse(await js(probe) ?? '[]')
check('手机上一列：四列读数格仍是四列', m390[0]?.gridCols === 4, String(m390[0]?.gridCols))
check('手机上一列：列表是单列（两列宽卡从 768 起）', m390[0]?.listCols === 1, `listCols=${m390[0]?.listCols}`)
check('手机上四个读数都没被截（scrollWidth ≤ clientWidth）',
  (await js(`(() => {
    const c = document.querySelector('[data-node-card]')
    return [...c.querySelector('[data-metrics]').children].every((el) => {
      const v = el.querySelectorAll('div')[1]
      return v.scrollWidth <= v.clientWidth + 1
    })
  })()`)) === true)
check('390 宽上页面没有横向溢出',
  (await js('document.documentElement.scrollWidth <= document.documentElement.clientWidth')) === true,
  `${await js('document.documentElement.scrollWidth')} vs ${await js('document.documentElement.clientWidth')}`)

check('没有控制台异常', errors.length === 0, errors.slice(0, 2).join(' | '))

console.log(`\n结果: PASS ${pass} / FAIL ${fail}`)
ws.close(); chrome.kill(); server.close()
process.exit(fail ? 1 : 0)

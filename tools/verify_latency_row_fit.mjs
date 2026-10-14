// 延迟行「名字 → 数值」列宽护栏（2026-10-14 论坛反馈 C 稿：名字/数值列按内容自适应）。
//
// 反馈与改动：固定列（名字 80px + 数值 56px 右对齐）下，短名字的行在「名字→数值」之间
// 留一大块死区（CT ≈ 91px、中国电信 ≈ 57px；2026-10-12 名字列 64→80 后又各多 16px）。
// C 稿把这些列改为按内容自适应：名字列 = 整块内最宽者（上限 80px）、数值列 = 整块内最宽者
// （右对齐、列宽共享），多行之间靠 subgrid 共享轨道保持逐列对齐。
//
// 用法：node tools/verify_latency_row_fit.mjs [端口]
//   dist 默认取 ./dist；用 DIST_DIR=... 指到别的构建（反向自测用）。
//   截图落到 SHOT_DIR（默认 shots/row-fit）。
//
// ★对照纪律：拿**改动前的 dist** 跑这一份（DIST_DIR=...）时，这些条必须 FAIL——
//   ① 单行短名字（CT）：名字文字右沿 → 数值文字左沿 ≤ 12px（旧实现 ≈ 91px）
//   ② 多行块里最宽名字那行：名字列尾空（列宽 − 文字宽）≤ 1.5px（旧实现 = 80 − 名字宽）
//   ③ 多行块里最宽数值那行：数值列前导（列宽 − 文字宽）≤ 1.5px（旧实现 = 56 − 数值宽）
//   ⑪ 经典档浮层一组（旧实现是固定 72/48 列，短名 ≈75px 死区）
//   全绿只在「分档后可自适应的两档」成立——判据分不了两头就等于没钉。
//   其余各条是「两种实现都必须过」的不变量（对齐/截断/节奏/无溢出），用来防改坏。
//   ★⑫ 详细档一组反过来：它对旧 dist 也应当全绿——钉的是「详细档保持固定列原样」这条口径，
//     谁哪天把详细档也改成自适应（或动了它的列宽），这一组就红。
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = Number(process.argv[2] || 5318)
const CDP_PORT = PORT + 4000
const ROOT = process.env.DIST_DIR || 'dist'
const SHOTS = process.env.SHOT_DIR || 'shots/row-fit'
mkdirSync(SHOTS, { recursive: true })
console.log(`护栏：延迟行自适应（dist = ${ROOT}，截图 ${SHOTS}）`)

let passed = 0
let failed = 0
function check(what, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ' — ' + detail : ''}`)
  if (ok) passed++
  else failed++
}
const r1 = (n) => Math.round(n * 10) / 10

/* ------------------------------------------------------------------ 桩数据 */

const GB = 1024 ** 3
const node = (id, name, country) => ({
  id, name, sort: id, public: true, online: true, country, group: '',
  last_seen: Math.floor(Date.now() / 1000) - 5,
  metrics: {
    uptime: 400000, cpu: 1.0, load: [0, 0, 0], mem_total: 1 * GB, mem_used: 0.4 * GB,
    swap_total: 0, swap_used: 0, disk_total: 5.1 * GB, disk_used: 2.05 * GB,
    net_rx: 700, net_tx: 1100, total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0,
    tcp: 12, udp: 2, procs: 80,
  },
  os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'EPYC', cpu_cores: 1,
  mem_total: 1 * GB, swap_total: 0, disk_total: 5.1 * GB, agent_version: '1.3.0',
  price: 0, currency: 'CNY', billing_cycle: 'monthly', expires_at: null, expires_in: null,
  traffic_limit: 0, traffic_mode: 'sum', traffic_reset_day: 1,
  total_rx: 102 * GB, total_tx: 104 * GB, month_rx: 0, month_tx: 0, month_start: '', day_rx: 0, day_tx: 0,
})
const NODES = { nodes: [node(1, '混排三行', 'US'), node(2, '单行短名', 'DE'), node(3, '超长名字', 'JP'), node(4, '含超时', 'SG')] }

const JIT = [0, 2, 5, 8, 1, 6, 3, 7, 4, 2]
const series = (taskId, base, loss = 0) => Array.from({ length: 40 }, (_, i) => {
  const v = base + JIT[i % JIT.length]
  return { task_id: taskId, ts: Math.floor(Date.now() / 1000) - (40 - i) * 90, latency: v, band: [v - 3, v + 3], loss }
})
const NULLS = (taskId) => Array.from({ length: 10 }, (_, i) => ({
  task_id: taskId, ts: Math.floor(Date.now() / 1000) - (10 - i) * 90, latency: null, band: null, loss: 0,
}))
const LONG = '北京电信·大兴骨干-国际中转节点一号'
const PING = {
  // ① 混排三行：短/全称/带「城市 · 服务商」的长名（对齐 + 最宽行贴身）
  1: { ping: [...series(11, 234, 1.6), ...series(12, 233), ...series(13, 95)], probes: { 11: 'CT', 12: '中国电信', 13: '东京 · Google' }, loss: { 11: 1.6, 12: 0, 13: 0 } },
  // ② 单行短名字：反馈截图的直接复现（CT 独行）
  2: { ping: series(21, 234, 1.6), probes: { 21: 'CT' }, loss: { 21: 1.6 } },
  // ③ 超长名字：截断在 80px + 悬停全名
  3: { ping: series(31, 110, 0.3), probes: { 31: LONG }, loss: { 31: 0.3 } },
  // ④ 「超时」：末段全空（数值位置改按内容后这条必须不被裁不掉）
  4: { ping: [...series(41, 233), ...NULLS(42)], probes: { 41: '中国电信', 42: '广州移动' }, loss: { 41: 0, 42: 0 } },
}

/* 分档开关：站长 2026-10-15 定——延迟档 / 经典档浮层走自适应，详细档保持固定列原样。
   每段测前改这里 + 重新导航即可（与 verify_peek_latency 同一手法）。 */
let CONFIG = { cardStyle: 'latency', pingLines: '' }

/* ------------------------------------------------------------------ 伺服 */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
}
const serveFile = (res, path) => {
  const file = join(ROOT, normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] })
    return res.end(readFileSync(join(ROOT, 'index.html')))
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
}
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  if (path.startsWith('/api/')) {
    let body = {}
    if (path === '/api/me') body = { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '行宽校验' }
    else if (path === '/api/nodes') body = NODES
    else if (path.endsWith('/config')) body = CONFIG
    else if (path === '/api/version') body = { version: '1.3.0' }
    else if (/^\/api\/nodes\/\d+\/metrics/.test(path)) {
      const id = Number(path.match(/^\/api\/nodes\/(\d+)\/metrics/)[1])
      const ping = PING[id] ?? { ping: [], probes: {}, loss: {} }
      body = url.searchParams.get('series') === 'ping'
        ? { metrics: [], ...ping }
        : { metrics: [], ping: [], probes: {}, loss: {} }
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  serveFile(res, path)
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

/* ------------------------------------------------------------------ 浏览器 */

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find((p) => existsSync(p)) || 'chrome'
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', '--no-proxy-server',
  `--user-data-dir=${join(tmpdir(), `rowfit${CDP_PORT}`)}`,
  '--no-sandbox',
  'about:blank',
], { stdio: 'ignore' })

let id = 0
const pending = new Map()
let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl
  } catch { /* 等 Chrome 起来 */ }
  if (!wsUrl) await sleep(250)
}
if (!wsUrl) throw new Error('Chrome 没起来')
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
const errors = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.exception?.description || '异常')
}
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable')
await send('Page.enable')

const BASE = `http://127.0.0.1:${PORT}`

/* 量：文字用 Range 的 bbox、列盒用 Rect；「尾空/前导」= 列宽 − 文字宽（右对齐列的左前导也这么量）。
   选择器参数化：卡面 `[data-latency]`（行是 div）、浮层 `[data-peek-latency]`（行是 span）都走这一份。 */
const measureOf = (sel) => `JSON.stringify([...document.querySelectorAll('${sel}')].map((panel) => {
  const rowEls = [...panel.querySelectorAll(':scope > *')]
  const rows = rowEls.map((row) => {
    const [name, ms, spark, loss] = row.children
    const t = (el) => { const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect(); return [Math.round(b.left * 10) / 10, Math.round(b.right * 10) / 10, Math.round(b.width * 10) / 10] }
    const x = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.left * 10) / 10, Math.round(b.right * 10) / 10, Math.round(b.width * 10) / 10] }
    return {
      name: name.textContent, nameTitle: name.getAttribute('title'),
      nameText: t(name), nameBox: x(name),
      nameCut: name.scrollWidth - name.clientWidth, nameScroll: name.scrollWidth,
      msText: t(ms), msBox: x(ms), msRaw: ms.textContent,
      msCut: ms.scrollWidth - ms.clientWidth,
      spark: x(spark), lossText: t(loss), lossCut: loss.scrollWidth - loss.clientWidth, lossBox: x(loss),
      rowBox: x(row), rowCut: row.scrollWidth - row.clientWidth,
      rowH: Math.round(row.getBoundingClientRect().height * 10) / 10,
    }
  })
  const pb = panel.getBoundingClientRect()
  return {
    panelH: Math.round(pb.height * 10) / 10,
    rows,
    rowTops: rowEls.map((r) => Math.round(r.getBoundingClientRect().top * 10) / 10),
  }
}))`

const setViewport = (width, height, mobile = false) =>
  send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })

const shotGrid = async (name, selector = '[data-card-style]') => {
  // ★先把目标滚进视口再拍：captureBeyondViewport 在无头下不可靠，clip 超视口会拍到空白
  //   （2026-10-14 实测：652 视口下地球把卡片区顶出 1300 高度，卡 3/4 的延迟块整段没渲染，
  //   截图底部 90px 全白 —— 单看截图会以为渲染坏了，其实是拍法问题）。
  await js(`(() => { const el = document.querySelector('${selector}'); el && el.scrollIntoView({ block: 'center' }); return !!el })()`)
  await sleep(350)
  const clip = await js(`(() => {
    const el = document.querySelector('${selector}')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.max(0, Math.round(r.x - 10)), y: Math.round(r.y + scrollY - 10), width: Math.round(r.width + 20), height: Math.round(r.height + 20), scale: 1 }
  })()`)
  if (!clip) return
  const r = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false })
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.result.data, 'base64'))
  console.log(`   已拍 ${join(SHOTS, `${name}.png`)}`)
}

/** 每行「结构间隙」= 原样间隙 − 名字列尾空 − 数值列前导；自适应与否它都该 ≈ 8（列距）。 */
const gapOf = (r) => {
  // 截断的名字：文字 bbox 会伸到可视盒外（Range 量的是整段文本），右沿要夹回列盒——
  // 视口里真实的「名字→数值」间隙以「看得见的那一段」为准。
  const nameRight = Math.min(r.nameText[1], r.nameBox[1])
  const raw = r.msText[0] - nameRight
  const nameTail = Math.max(0, r.nameBox[2] - Math.min(r.nameText[2], r.nameBox[2]))
  const msLead = Math.max(0, r.msBox[2] - r.msText[2])
  return { raw: r1(raw), nameTail: r1(nameTail), msLead: r1(msLead), structural: r1(raw - nameTail - msLead) }
}

async function measureAt(cfg, width, height, mobile, label) {
  CONFIG = cfg
  await setViewport(width, height, mobile)
  await send('Page.navigate', { url: `${BASE}/` })
  let ready = false
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(300)
    ready = await js(`document.querySelectorAll('[data-latency] [data-probe-name]').length === 7 && document.querySelectorAll('[data-latency] svg polyline').length >= 6`)
  }
  if (!ready) console.log(`   （${label}：页面没就绪——节点/探针数没到 7 行 6 线）`)
  const data = JSON.parse(await js(measureOf('[data-latency]')) ?? '[]')
  console.log(`\n== ${label}（${width}px）==`)
  for (const p of data) {
    for (const r of p.rows) {
      const g = gapOf(r)
      console.log(`   ${r.name} ｜ ${r.msRaw} ｜ 间隙 ${g.raw}（尾空 ${g.nameTail} + 前导 ${g.msLead} + 结构 ${g.structural}）｜ 名字列 ${r.nameBox[2]}px${r.nameCut > 1 ? `（截断 ${r.nameCut}px）` : ''} ｜ 走势线 ${r.spark[2]}px`)
    }
  }
  return data
}

/* ------------------------------------------------------------------ 652：反馈等效机位 */
{
  const data = await measureAt({ cardStyle: 'latency', pingLines: '' }, 652, 1300, false, '反馈等效机位 · 延迟档（自适应）')
  const panels = data
  const mixed = panels.find((p) => p.rows.length === 3)
  const single = panels.find((p) => p.rows.length === 1 && p.rows[0].name === 'CT')
  const long = panels.find((p) => p.rows.some((r) => r.name.startsWith('北京电信')))
  const timeout = panels.find((p) => p.rows.some((r) => r.msRaw === '超时'))
  check('① 单行短名字（CT）：名字→数值间隙 ≤ 12px', !!single && gapOf(single.rows[0]).raw <= 12, single ? `实测 ${gapOf(single.rows[0]).raw}px` : '没找到 CT 单行')
  check('①b 单行短名字（CT）：结构间隙 ≈ 8px（5~11）', !!single && gapOf(single.rows[0]).structural >= 5 && gapOf(single.rows[0]).structural <= 11, single ? `实测 ${gapOf(single.rows[0]).structural}px` : '')

  // ② 混排块：最宽名字行的「名字列尾空」——旧实现 80−名字宽（≈32px），改后应 ≈0
  if (mixed) {
    const widest = mixed.rows.reduce((a, b) => (b.nameText[2] > a.nameText[2] ? b : a))
    const tail = gapOf(widest).nameTail
    check('② 混排：最宽名字那行无列尾死区（≤1.5px）', tail <= 1.5, `${widest.name} 尾空 ${tail}px（名字 ${widest.nameText[2]}px）`)
    // ③ 最宽数值行的「数值列前导」——旧实现 56−数值宽，改后应 ≈0
    const widestMs = mixed.rows.reduce((a, b) => (b.msText[2] > a.msText[2] ? b : a))
    const lead = gapOf(widestMs).msLead
    check('③ 混排：最宽数值那行无列前导（≤1.5px）', lead <= 1.5, `${widestMs.msRaw} 前导 ${lead}px（数值 ${widestMs.msText[2]}px）`)
    // ④ 三行逐列对齐（共享轨道；新旧都必须过）
    const col = (f) => mixed.rows.map((r) => f(r))
    const spread = (arr) => r1(Math.max(...arr) - Math.min(...arr))
    check('④ 混排三行：数值右沿 / 走势线左沿 / 名字左沿逐列对齐（≤1.5px）',
      spread(col((r) => r.msText[1])) <= 1.5 && spread(col((r) => r.spark[0])) <= 1.5 && spread(col((r) => r.nameText[0])) <= 1.5,
      `数值右沿差 ${spread(col((r) => r.msText[1]))} / 走势线左沿差 ${spread(col((r) => r.spark[0]))} / 名字左沿差 ${spread(col((r) => r.nameText[0]))}`)
    // ⑤ 节奏：行高 16、行间 6（新旧都过，防改坏）
    const h = mixed.rows.map((r) => r.rowH)
    const vgaps = mixed.rowTops.slice(1).map((t, i) => r1(t - mixed.rowTops[i] - mixed.rows[i].rowH))
    check('⑤ 行高 16px、行间距 6px 不因改动而变', h.every((x) => Math.abs(x - 16) <= 1.5) && vgaps.every((x) => Math.abs(x - 6) <= 1),
      `行高 ${JSON.stringify(h)} 行距 ${JSON.stringify(vgaps)}`)
    // ⑥ 所有行的结构间隙都 ≈ 8（布局口径统一）
    check('⑥ 混排每行结构间隙都在 5~11px',
      mixed.rows.every((r) => gapOf(r).structural >= 5 && gapOf(r).structural <= 11),
      mixed.rows.map((r) => `${r.name}:${gapOf(r).structural}`).join(' '))
  } else check('② 混排块没渲染出来', false)

  // ⑦ 超长名字：截断在 80px + 悬停全名 + 走势线没被挤没
  if (long) {
    const r = long.rows[0]
    check('⑦ 超长名字：列宽 ≤ 80.5px 且真的截断', r.nameBox[2] <= 80.5 && r.nameCut >= 40, `列宽 ${r.nameBox[2]}px、截断 ${r.nameCut}px`)
    check('⑦b 超长名字：title 挂的是全名', r.nameTitle === LONG, `title=${r.nameTitle}`)
    check('⑦c 超长名字：走势线仍有 ≥60px', r.spark[2] >= 60, `走势线 ${r.spark[2]}px`)
    check('⑦d 超长名字行：名字→数值仍贴（≤12px）', gapOf(r).raw <= 12, `实测 ${gapOf(r).raw}px`)
  } else check('⑦ 超长名字块没渲染出来', false)

  // ⑧ 「超时」行：不裁、结构间隙 ≈ 8
  if (timeout) {
    const r = timeout.rows.find((x) => x.msRaw === '超时')
    check('⑧ 超时行：结构间隙 ≈ 8px（5~11）且整行不裁', r && gapOf(r).structural >= 5 && gapOf(r).structural <= 11 && r.rowBox[2] > 0,
      r ? `结构 ${gapOf(r).structural}px` : '没有超时行')
  } else check('⑧ 含超时块没渲染出来', false)

  await shotGrid('w652')
}

/* ------------------------------------------------------------------ 1440：桌面四列 */
{
  const data = await measureAt({ cardStyle: 'latency', pingLines: '' }, 1440, 900, false, '桌面 1440 · 延迟档（自适应）')
  const mixed = data.find((p) => p.rows.length === 3)
  check('⑨ 1440：混排块对齐与贴身判据同 652（逐列对齐 ≤1.5 / 最宽行尾空前导 ≤1.5）', !!mixed &&
    (() => {
      const s = (a) => Math.max(...a) - Math.min(...a)
      const widest = mixed.rows.reduce((a, b) => (b.nameText[2] > a.nameText[2] ? b : a))
      const widestMs = mixed.rows.reduce((a, b) => (b.msText[2] > a.msText[2] ? b : a))
      return s(mixed.rows.map((r) => r.msText[1])) <= 1.5 && gapOf(widest).nameTail <= 1.5 && gapOf(widestMs).msLead <= 1.5
    })(), mixed ? '见上表' : '没找到混排块')
}

/* ------------------------------------------------------------------ 390：手机 */
{
  const data = await measureAt({ cardStyle: 'latency', pingLines: '' }, 390, 2400, true, '手机 390 · 延迟档（自适应）')
  const overflow = await js(`document.documentElement.scrollWidth - window.innerWidth`)
  check('⑩ 手机 390：页面无横向溢出', typeof overflow === 'number' && overflow <= 1, `scrollWidth−innerWidth = ${overflow}px`)
  const all = data.flatMap((p) => p.rows)
  check('⑩b 手机 390：七行都不被裁、列不贴死（结构间隙 5~11；名字列按内容可为 13.7px）',
    all.length === 7 && all.every((r) => gapOf(r).structural >= 5 && gapOf(r).structural <= 11 && r.msCut <= 1 && r.lossCut <= 1 && r.rowCut <= 1 && r.nameBox[2] >= 12),
    all.map((r) => `${r.name}:${gapOf(r).structural}${r.msCut > 1 || r.lossCut > 1 || r.rowCut > 1 ? `(裁 ms${r.msCut} loss${r.lossCut} row${r.rowCut})` : ''}`).join(' '))
  await shotGrid('w390')
}

/* ---------------------------------------------------------------- ⑪ 经典档浮层：自适应（站长 2026-10-15 分档） */

{
  CONFIG = { cardStyle: 'classic', pingLines: '' }
  await setViewport(1440, 1100, false)
  await send('Page.navigate', { url: `${BASE}/` })
  let cards = false
  for (let i = 0; i < 60 && !cards; i++) {
    await sleep(250)
    cards = await js(`document.querySelectorAll('[data-note-popover]').length >= 4`)
  }
  if (!cards) console.log('   （⑪：经典档卡片没渲染出来）')

  const openPeek = async (idx) => {
    await js(`(() => { const b = [...document.querySelectorAll('[data-note-popover]')][${idx}]; b && b.click(); return !!b })()`)
    for (let i = 0; i < 40; i++) {
      await sleep(200)
      const ok = await js(`(() => { const b = document.querySelector('[data-peek-latency]'); return !!(b && b.querySelector('[data-probe-name]') && /ms|超时/.test(b.textContent)) })()`)
      if (ok) break
    }
  }

  // 第二张卡 = 「单行短名」（CT 独行）——旧固定列在这里最刺眼（≈75px 死区）
  await openPeek(1)
  const peek1 = JSON.parse(await js(measureOf('[data-peek-latency]')) ?? '[]')
  const p1rows = peek1[0]?.rows ?? []
  const ctRow = p1rows.find((r) => r.name === 'CT')
  check('⑪ 浮层（单行短名 CT）：名字→数值间隙 ≤ 12px（旧实现 ≈75px）', !!ctRow && gapOf(ctRow).raw <= 12, ctRow ? `实测 ${gapOf(ctRow).raw}px` : '没找到 CT 行')
  check('⑪b 浮层：数值列无固定前导（≤1.5px；旧实现 = 48 − 数值宽）', !!ctRow && gapOf(ctRow).msLead <= 1.5, ctRow ? `前导 ${gapOf(ctRow).msLead}px` : '')
  check('⑪c 浮层：名字列按内容收缩（≤ 名字文字宽 + 1.5；旧实现固定 72px）', !!ctRow && ctRow.nameBox[2] <= ctRow.nameText[2] + 1.5, ctRow ? `列宽 ${ctRow.nameBox[2]} vs 文字 ${ctRow.nameText[2]}` : '')
  const peekMaxW = await js(`getComputedStyle(document.querySelector('[data-peek-latency] [data-probe-name]')).maxWidth`)
  check('⑪d 浮层：名字列上限仍是 72px（computed max-width；旧实现没有上限声明）', peekMaxW === '72px', String(peekMaxW))
  check('⑪e 浮层：丢包列仍固定 36px（w-9 老口径）', !!ctRow && Math.abs(ctRow.lossBox[2] - 36) <= 0.5, ctRow ? `实测 ${ctRow.lossBox[2]}px` : '')
  await shotGrid('peek-single', '[data-note-panel]')

  // 第一张卡 = 「混排三行」——对齐不变量
  await send('Page.navigate', { url: `${BASE}/` })
  for (let i = 0; i < 60; i++) { await sleep(250); if (await js(`document.querySelectorAll('[data-note-popover]').length >= 4`)) break }
  await openPeek(0)
  const peek0 = JSON.parse(await js(measureOf('[data-peek-latency]')) ?? '[]')
  const p0rows = peek0[0]?.rows ?? []
  if (p0rows.length === 3) {
    const spread = (f) => r1(Math.max(...p0rows.map(f)) - Math.min(...p0rows.map(f)))
    check('⑪f 浮层（三行）：数值右沿 / 走势线左沿逐列对齐（≤1.5px）',
      spread((r) => r.msText[1]) <= 1.5 && spread((r) => r.spark[0]) <= 1.5,
      `数值右沿差 ${spread((r) => r.msText[1])} / 走势线左沿差 ${spread((r) => r.spark[0])}`)
    check('⑪g 浮层（三行）：每行结构间隙都在 5~11px', p0rows.every((r) => gapOf(r).structural >= 5 && gapOf(r).structural <= 11), p0rows.map((r) => `${r.name}:${gapOf(r).structural}`).join(' '))
  } else check('⑪f/g 浮层（三行）没渲染出来', false)
  await shotGrid('peek-mixed', '[data-note-panel]')
}

/* ---------------------------------------------------------------- ⑫ 详细档：保持固定列原样（站长 2026-10-15 分档） */

{
  const data = await measureAt({ cardStyle: 'detailed', pingLines: '' }, 1440, 900, false, '详细档（保持固定列原样）')
  const all = data.flatMap((p) => p.rows)
  check('⑫ 详细档：名字列恒 80px（含短名/超长名——自适应档会缩成 13.7 / 内容宽）',
    all.length === 7 && all.every((r) => Math.abs(r.nameBox[2] - 80) <= 0.5), all.map((r) => `${r.name}:${r.nameBox[2]}`).join(' '))
  check('⑫b 详细档：数值列恒 56px、丢包列恒 40px',
    all.every((r) => Math.abs(r.msBox[2] - 56) <= 0.5 && Math.abs(r.lossBox[2] - 40) <= 0.5),
    all.slice(0, 3).map((r) => `${r.msBox[2]}/${r.lossBox[2]}`).join(' '))
  const ct = all.find((r) => r.name === 'CT')
  check('⑫c 详细档：短名行仍是旧的固定间距（80~100px，不是自适应的 ~8px）', !!ct && gapOf(ct).raw >= 80 && gapOf(ct).raw <= 100, ct ? `实测 ${gapOf(ct).raw}px` : '没找到 CT 行')
  await shotGrid('detailed-1440')
}

check('全程没有控制台异常', errors.length === 0, errors.slice(0, 2).join(' | '))

console.log(`\n结果: PASS ${passed} / FAIL ${failed}`)
chrome.kill()
server.close()
process.exit(failed ? 1 : 0)

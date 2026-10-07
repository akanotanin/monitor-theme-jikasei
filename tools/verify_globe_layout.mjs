// 地球的**版面**验收（不比对世界数据，只看画出来的东西自不自洽）：
//   ① 陆地路径里没有「一步跨过半个圆盘」的直线 —— 那正是「陆地随自转残缺/多填」的元凶
//      （收口没沿地平线走时，实测抓过 168.9 单位一步的弦，几乎就是直径）
//   ② 定位点、连线、线路弧都落在圆盘里（≤ 半径）
//   ③ 地区标签互不重叠、也不越过地平线
// 三种视口各跑一遍（桌面 / 平板 / 手机）——手机上那档是站长最常看的那档。
//
// 用法：node tools/verify_globe_layout.mjs
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = Number(process.env.LAYOUT_PORT || 5201)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }
// 桩数据：几个挤在一起的城市（同一个地区行）+ 跨洲分布，逼出「标签挤在一起」和「点贴地平线」两种情况
const NODES = {
  nodes: [
    { id: 'a', name: '东京一号', online: true, country: 'JP', group: '亚太', region: 'JP · Tokyo', os: 'Debian 12', cpu_name: 'EPYC', cpu_cores: 2, mem_total: 2147483648, disk_total: 42949672960, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
    { id: 'b', name: '东京二号', online: true, country: 'JP', group: '亚太', region: 'JP · Tokyo', os: 'Debian 12', cpu_name: 'EPYC', cpu_cores: 2, mem_total: 2147483648, disk_total: 42949672960, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
    { id: 'c', name: '东京三号', online: false, country: 'JP', group: '亚太', region: 'JP · Tokyo', os: 'Debian 12', cpu_name: 'EPYC', cpu_cores: 1, mem_total: 1073741824, disk_total: 21474836480, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
    { id: 'd', name: '法兰克福一号', online: true, country: 'DE', group: '欧洲', region: 'DE · Frankfurt am Main', os: 'Ubuntu 24.04', cpu_name: 'Xeon', cpu_cores: 4, mem_total: 8589934592, disk_total: 107374182400, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
    { id: 'e', name: '圣何塞', online: true, country: 'US', group: '北美', region: 'US · San Jose', os: 'AlmaLinux 9', cpu_name: 'EPYC', cpu_cores: 2, mem_total: 4294967296, disk_total: 64424509440, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
    { id: 'f', name: '悉尼', online: true, country: 'AU', group: '亚太', region: 'AU · Sydney', os: 'Debian 12', cpu_name: 'EPYC', cpu_cores: 1, mem_total: 2147483648, disk_total: 32212254720, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
    { id: 'g', name: '新加坡', online: false, country: 'SG', group: '亚太', region: 'SG · Singapore', os: 'Debian 12', cpu_name: 'EPYC', cpu_cores: 1, mem_total: 1073741824, disk_total: 21474836480, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
    { id: 'h', name: '圣保罗', online: true, country: 'BR', group: '南美', region: 'BR · São Paulo', os: 'Debian 12', cpu_name: 'EPYC', cpu_cores: 2, mem_total: 4294967296, disk_total: 64424509440, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
    // ★ 赤道 + 西经 78 一带：那两处收口 bug（弦 + 走向判反）**只在这个视角露头**，
    //   默认视角（lon 80 / lat 30）与东京、法兰克福那些地区行都看不见 —— 反向自测就漏过。
    { id: 'i', name: '基多', online: true, country: 'EC', group: '南美', region: 'EC · Quito', os: 'Debian 12', cpu_name: 'EPYC', cpu_cores: 1, mem_total: 2147483648, disk_total: 32212254720, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
    { id: 'j', name: '利马', online: true, country: 'PE', group: '南美', region: 'PE · Lima', os: 'Debian 12', cpu_name: 'EPYC', cpu_cores: 1, mem_total: 2147483648, disk_total: 32212254720, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
    // 两个**超长名字**：把「窄屏截断」这条路走出来（截断必须真的放得下，不能靠 SVG 视口去裁）。
    { id: 'k', name: 'Demo Node Tokyo Datacenter Gen 2', online: true, country: 'JP', group: '亚太', region: 'JP · Tokyo Datacenter', os: 'Debian 12', cpu_name: 'EPYC', cpu_cores: 2, mem_total: 2147483648, disk_total: 42949672960, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
    { id: 'l', name: 'Demo Node Sao Paulo Datacenter Gen 3', online: true, country: 'BR', group: '南美', region: 'BR · Sao Paulo Datacenter', os: 'Debian 12', cpu_name: 'EPYC', cpu_cores: 2, mem_total: 4294967296, disk_total: 64424509440, virt: 'kvm', arch: 'x86_64', last_seen: 1, public: true, weight: 1 },
  ],
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname
  if (path.startsWith('/api/')) {
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '版面验收' }
      : path === '/api/nodes' ? NODES : path.endsWith('/config') ? { listTop: 'bothBudget', cardStyle: 'detailed', remarkPlacement: 'both' } : {}
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
const dbgPort = 9930 + Math.floor(Math.random() * 50)
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbgPort}`, '--remote-allow-origins=*', '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/globelayout-' + dbgPort, 'about:blank'], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 100 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { }
  if (!wsUrl) await sleep(300)
}
if (!wsUrl) throw new Error('Chrome 起不来')

let id = 0
const pending = new Map()
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
await send('Runtime.enable'); await send('Page.enable')

// 在页面里跑的那段：把地球里所有可见图元量一遍（VIEW = { w:460, h:240, cx:230, cy:112, r:92 }）
const PROBE = `(() => {
  const svg = document.querySelector('.globe-atlas svg') || document.querySelector('svg')
  if (!svg) return { error: '找不到地球 SVG（.globe-atlas svg）' }
  const host = document.querySelector('.globe-atlas') || svg.parentElement
  const CX = 230, CY = 112, R = 92
  const num = (s) => { const m = String(s).match(/-?\\d+(\\.\\d+)?/g) || []; return m.map(Number) }
  const radius = (x, y) => Math.hypot(x - CX, y - CY)
  // ① 陆地（与海岸线）：逐步长 —— 弦 bug 会在这里露出来（实测抓过 168.9 单位一步）
  // ★ 必须按子路径（每个 M 一段）分开量：两条子路径之间本来就不画线，
  //   跨段量出来的「一步」是假的（实测会报 183 单位的假跨步）。
  let maxStep = 0, maxStepAt = '', segCount = 0, ptCount = 0, landPaths = 0
  for (const p of svg.querySelectorAll('path.globe-land, path.globe-coast')) {
    landPaths++
    const d = p.getAttribute('d') || ''
    for (const chunk of d.split('M').slice(1)) {
      segCount++
      const nums = num(chunk)
      let prev = null
      for (let i = 0; i + 1 < nums.length; i += 2) {
        const x = nums[i], y = nums[i + 1]
        ptCount++
        if (prev) { const s = Math.hypot(x - prev[0], y - prev[1]); if (s > maxStep) { maxStep = s; maxStepAt = prev[0].toFixed(1) + ',' + prev[1].toFixed(1) + ' -> ' + x.toFixed(1) + ',' + y.toFixed(1) } }
        prev = [x, y]
      }
    }
  }
  // ①b 闭合弦：子路径最后一点 → 第一点（SVG 填充会隐含把这条直线连上）。
  //   ★ 这一刀曾经是**横跨圆盘的弦**：大环被地平线切成两段时，旧收口走到「下一个可见顶点」
  //     就停、再 Z 拉回段首 —— 实测弦长 99.9 单位（直径 184），弦与地平线之间那一牙陆地
  //     整个丢掉，就是站长圈出来的「本来是陆地却没有正确显示」。
  //     判据：**两头都贴在地平线上、弦又很长** = 出错（全可见环的收尾边、以及段首不在地平线
  //     的兜底情形不算 —— 那些是数据自己的边，本来就长）。
  let maxChord = 0, maxChordAt = ''
  for (const p of svg.querySelectorAll('path.globe-land')) {
    const d = p.getAttribute('d') || ''
    for (const chunk of d.split('M').slice(1)) {
      const nums = num(chunk)
      if (nums.length < 4) continue
      const x0 = nums[0], y0 = nums[1]
      const x1 = nums[nums.length - 2], y1 = nums[nums.length - 1]
      const chord = Math.hypot(x1 - x0, y1 - y0)
      if (radius(x0, y0) > R * 0.97 && radius(x1, y1) > R * 0.97 && chord > maxChord) {
        maxChord = chord
        maxChordAt = x0.toFixed(1) + ',' + y0.toFixed(1) + ' → ' + x1.toFixed(1) + ',' + y1.toFixed(1)
      }
    }
  }
  // ② 点（定位点 + 命中区）与线（连线/线路弧/引线）是否都在盘内
  const outside = []
  const pins = [...svg.querySelectorAll('circle.globe-pin, circle.hit')]
  for (const c of pins) {
    const rr = radius(+c.getAttribute('cx'), +c.getAttribute('cy'))
    if (rr > R + 0.6) outside.push('点(' + c.getAttribute('cx') + ',' + c.getAttribute('cy') + ') r=' + rr.toFixed(1) + ' .' + c.getAttribute('class'))
  }
  let lineWorst = 0, lineAt = '', lineCount = 0
  for (const p of svg.querySelectorAll('path.globe-wire, path.globe-sweep, path.globe-link, path.globe-stem')) {
    lineCount++
    const nums = num(p.getAttribute('d') || '')
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const rr = radius(nums[i], nums[i + 1])
      if (rr > lineWorst && rr < 1e4) { lineWorst = rr; lineAt = nums[i] + ',' + nums[i + 1] }
    }
  }
  if (lineWorst > R * 1.35) outside.push('线最远 ' + lineWorst.toFixed(1) + ' @' + lineAt)
  // ③ 标签：互不重叠 + 不越界
  const labels = [...svg.querySelectorAll('text.globe-label, text.globe-count')].map((t) => {
    const b = t.getBBox()
    const raw = t.textContent || ''
    // ★ 判「截没截」要看全文：显示用的那截（slice 16）会把结尾的省略号切掉，于是永远查不出来。
    return { text: raw.slice(0, 16), full: raw, x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width / 2, cy: b.y + b.height / 2 }
  }).filter((b) => b.w > 0)
  const overlaps = []
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    const a = labels[i], b = labels[j]
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
    if (ox > 0.5 && oy > 0.5) overlaps.push(a.text + ' × ' + b.text + ' (' + ox.toFixed(1) + '×' + oy.toFixed(1) + ')')
  }
  const spill = labels.filter((b) => radius(b.cx, b.cy) > R - 1).map((b) => b.text + ' r=' + radius(b.cx, b.cy).toFixed(1))
  // ★ 真裁切框是 SVG 元素本身（视口），不是 viewBox：宽屏时画布两侧的空白是给长名字溢出的。
  const vbAll = (svg.getAttribute('viewBox') || '0 0 460 240').split(/ +/).map(Number)
  const hostBox = host.getBoundingClientRect()
  const k = Math.min(hostBox.width / vbAll[2], hostBox.height / vbAll[3])
  const offX = (hostBox.width - vbAll[2] * k) / 2
  const toPx = (ux) => offX + (ux - vbAll[0]) * k
  const clipped = labels.filter((b) => toPx(b.x) < -0.5 || toPx(b.x + b.w) > hostBox.width + 0.5)
    .map((b) => b.text + ' px ' + toPx(b.x).toFixed(0) + '→' + toPx(b.x + b.w).toFixed(0) + '（盒宽 ' + hostBox.width.toFixed(0) + '）')
  const truncated = labels.filter((b) => b.full.includes('…')).map((b) => b.full)
  // 标签本来就摆在圆盘两侧那两摞里（viewBox 460 宽、盘只占中间 184），所以「越出地平线」是设计。
  // 真正要钉住的是：**没有被 viewBox 裁掉的字**。
  const vb = (svg.getAttribute('viewBox') || '0 0 460 240').split(/ +/).map(Number)
  const outOfBox = labels.filter((b) => b.x < vb[0] - 1 || b.y < vb[1] - 1 || b.x + b.w > vb[0] + vb[2] + 1 || b.y + b.h > vb[1] + vb[3] + 1)
    .map((b) => b.text + ' @' + b.x.toFixed(0) + ',' + b.y.toFixed(0) + ' ' + b.w.toFixed(0) + '×' + b.h.toFixed(0))
  return { landPaths, maxStep, maxStepAt, maxChord, maxChordAt, segCount, ptCount, pins: pins.length, lineCount, lineWorst, outside, labels: labels.map((b) => ({ text: b.text, w: +b.w.toFixed(1) })), labelCount: labels.length, overlaps, spill, outOfBox, clipped, truncated, hostW: +hostBox.width.toFixed(0), viewBox: vb.join(' ') }
})()`

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }

const SIZES = process.env.ONLY ? [[Number(process.env.ONLY), 780, 'only']] : [[1440, 900, '桌面 1440'], [1024, 768, '小桌面 1024'], [768, 1024, '平板 768'], [560, 900, '窄窗 560'], [430, 900, '大手机 430'], [390, 844, '手机 390'], [360, 780, '小手机 360']]
for (const [w, h, tag] of SIZES) {
  console.log(`\n=== ${tag} ${w}×${h} ===`)
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 500 })
  await send('Page.navigate', { url: `${BASE}/` })
  for (let i = 0; i < 60; i++) { await sleep(250); if (await js('!!document.querySelector(".globe-atlas svg")')) break }
  await sleep(1500)
  // 两趟：默认视角（lon 80 / lat 30），以及**点一下赤道 + 西经 78 那条地区行**之后。
  // 为什么要第二趟：收口那两处 bug 只在赤道视角露头，默认视角完全看不见。
  // ★ 那条「横跨圆盘的弦」现在这里也守得住：①b 会量子路径的**闭合弦**，两头都贴地平线
  //   又超 16 单位就报错（旧收口在 200°E/65°N 实测 99.9 单位）。逐像素对账（globe-diff-image.mjs）
  //   是另一道网，两处都要绿。
  //   这里另外守的是：任何视角下都不该出现「一步跨过半个圆盘」的直线、点线越界、标签重叠或被裁。
  const passes = [['默认视角', null], ['赤道视角（点 Quito 地区行）', 'Quito']]
  for (const [label, region] of passes) {
    if (region) {
      await js(`(() => { const b = [...document.querySelectorAll('.globe-reg')].find((x) => (x.textContent || '').includes('${region}')); if (b) b.click(); return !!b })()`)
      await sleep(1400)
    }
    const d = await js(PROBE)
    if (d?.error) { check(`${tag}·${label} 找到地球 SVG`, false, d.error); continue }
    console.log(`    ${label}：陆地 ${d.landPaths} 条 / ${d.segCount} 段 / ${d.ptCount} 点｜定位点 ${d.pins} 个｜线 ${d.lineCount} 条（最远 ${d.lineWorst.toFixed(1)}）｜标签 ${d.labelCount} 条`)
    console.log(`      最远一步 ${d.maxStep.toFixed(1)} 单位 @ ${d.maxStepAt}`)
    if (process.env.DEBUG) console.log('      标签宽：' + d.labels.map((l) => l.text + '=' + l.w.toFixed(0)).join(' | '))
    // ★ 先钉住「探针确实看到了东西」——否则下面几条会在空集上假 PASS
    check(`${tag}·${label} 探针确实量到了陆地/定位点/标签`, d.landPaths > 0 && d.pins > 0 && d.labelCount > 0, `land=${d.landPaths} pins=${d.pins} labels=${d.labelCount}`)
    check(`${tag}·${label} 陆地路径没有「一步跨过半个圆盘」的直线（≤40 单位）`, d.maxStep <= 40, `最大 ${d.maxStep.toFixed(1)} @ ${d.maxStepAt}`)
    // ★ 收口那刀：两头都贴地平线时，闭合弦必须短（旧版这里是 99.9 单位的横跨弦 → 丢一牙陆地）。
    check(`${tag}·${label} 贴地平线的收口没有横跨圆盘的长弦（≤16 单位）`, d.maxChord <= 16, `最长 ${d.maxChord.toFixed(1)} @ ${d.maxChordAt}`)
    check(`${tag}·${label} 定位点/连线都在圆盘内`, d.outside.length === 0, d.outside.slice(0, 4).join(' | '))
    check(`${tag}·${label} 地区标签互不重叠`, d.overlaps.length === 0, d.overlaps.slice(0, 3).join(' | '))
    check(`${tag}·${label} 地区标签都落在 SVG 盒里（没有半个字被视口裁掉）`, d.clipped.length === 0, `盒宽 ${d.hostW}｜${d.clipped.slice(0, 3).join(' | ')}`)
    if (d.truncated.length) console.log(`      截断 ${d.truncated.length} 条：${d.truncated.slice(0, 3).join(' | ')}`)
    // 宽屏两侧的空白本来就够长名字溢出（上游靠它）——有余量还截字，说明判据算窄了。
    if (tag.startsWith('桌面 1440')) check(`${tag}·${label} 宽屏有余量时不截字`, d.truncated.length === 0, d.truncated.slice(0, 3).join(' | '))
  }
}

console.log(`\n结果: PASS ${pass} / FAIL ${fail}`)
ws.close(); chrome.kill(); server.close()
process.exit(fail ? 1 : 0)

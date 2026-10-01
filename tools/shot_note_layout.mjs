// 延迟档「服务器备注」改前/改后对照 + 卡片几何（备注关 / 开两档同机位）。
//
// 用法：node tools/shot_note_layout.mjs <上游hub> <输出目录> [视口宽] [视口高] [DPR]
//   ssh -f -N -L 28083:127.0.0.1:28080 <hub机>          # 先建隧道（静态走本机、数据走真 hub）
//   node tools/shot_note_layout.mjs http://127.0.0.1:28083 shots/notes
//
// 为什么要它：
//   1. 备注那枚胶囊只有几十像素，整页图缩下来看不出来 —— 这里同时出「整页」与
//      「首张卡片放大 3×」两版，并固定拍**同一台机器**（DOM 顺序在几次导航之间不稳定）。
//   2. 「不影响美观」要用数字说：两档都量**卡片总高 / 标题行高 / 读数格上沿 / 名字有没有被挤到截断**，
//      「备注关」那一档就是基线（这才能分清「零新增行高」与「多了一行」）。
//   3. 备注清单必须与真实节点名逐字相同才有标签可看 —— 清单由脚本从上游 `/api/nodes`
//      现取节点名生成（**不写进任何入库文件**），只落在被 .gitignore 的 shots/ 下。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const UPSTREAM = (process.argv[2] || '').replace(/\/$/, '')
const OUT_DIR = process.argv[3] || 'shots/notes'
const W = Number(process.argv[4] || 1440)
const H = Number(process.argv[5] || 900)
const DPR = Number(process.argv[6] || 2)
if (!UPSTREAM) { console.error('用法：node tools/shot_note_layout.mjs <上游hub> <输出目录> [宽] [高] [DPR]'); process.exit(2) }

const SHORT = 'jikasei'
const PORT = 5400 + Math.floor(Math.random() * 200)
const CDP_PORT = 9600 + Math.floor(Math.random() * 200)
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p)) || 'chrome'

mkdirSync(OUT_DIR, { recursive: true })

/* ---------------------------------------------------- 备注清单：从真节点名现造 */
const live = await (await fetch(`${UPSTREAM}/api/nodes`)).json()
const nodes = Array.isArray(live) ? live : (live.nodes ?? [])
if (!nodes.length) { console.error('上游没有节点，没法造备注清单'); process.exit(2) }
// 三台机器各一种形态：多枚（测 `+N` 折叠）、单枚、三枚；其余不写备注（看默认状态）。
const TAGS = ['三网优化,备用', '流媒体解锁', '家宽备用,无 SLA,仅测试']
// 第四行：**名字最长的那台**，用来验 A 档「标签挤名字」的边界（名字该不该被截断）。
const lines = nodes.slice(0, 3).map((n, i) => `${n.name}=${TAGS[i] ?? '备用'}`)
// 名字长度有并列，所以要「按长度降序、取第一台不在上面清单里的」，直接取 [0] 会撞上已在清单里的那台而不加行。
const longest = [...nodes].sort((a, b) => b.name.length - a.name.length).find((n) => !lines.some((l) => l.startsWith(`${n.name}=`)))
if (longest) lines.push(`${longest.name}=三网优化,备用,流媒体解锁`)
const notes = lines.join('\n')
writeFileSync(`${OUT_DIR}/notes-raw.txt`, notes + '\n')
const TAGGED = lines.map((l) => l.slice(0, l.indexOf('=')))
console.log(`备注清单（${lines.length} 台，名字逐字取自上游 /api/nodes）：\n${notes}\n→ ${OUT_DIR}/notes-raw.txt`)

const liveConfig = await (await fetch(`${UPSTREAM}/api/themes/${SHORT}/config`)).json()
const configFor = (withNotes) => JSON.stringify({
  ...liveConfig,
  cardStyle: 'latency',
  serverNotes: withNotes ? notes : '',
})

/* ---------------------------------------------------------------- 静态伺服 */
const serve = spawn(process.execPath, ['tools/serve.mjs', String(PORT), '{}', '', UPSTREAM], { stdio: 'ignore' })
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break } catch { /* 还没起来 */ }
  await sleep(250)
}
console.log(`静态伺服 = 本机 dist/，/api/* → ${UPSTREAM}（http://127.0.0.1:${PORT}/）`)

/* ---------------------------------------------------------------- 浏览器 */
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*',
  '--user-data-dir=' + `${process.env.TEMP || '.'}/note-layout-${Date.now()}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', 'about:blank',
], { stdio: 'ignore' })

let target = null
for (let i = 0; i < 80 && !target; i++) {
  await sleep(300)
  try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page') } catch { /* 等 Chrome */ }
}
if (!target) throw new Error('Chrome 没起来')

const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const problems = []
let SERVED = configFor('a')
let hitCount = 0
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Fetch.requestPaused') {
    ws.send(JSON.stringify({
      id: ++id, method: 'Fetch.fulfillRequest',
      params: {
        requestId: m.params.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }],
        body: Buffer.from(SERVED, 'utf8').toString('base64'),
      },
    }))
    hitCount += 1
    return
  }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJS = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value

await new Promise((r) => ws.addEventListener('open', r))
await send('Page.enable')
await send('Runtime.enable')
await send('Fetch.enable', { patterns: [{ urlPattern: `*api/themes/${SHORT}/config*`, requestStage: 'Request' }] })
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })

const SETTLED = `(() => {
  const cards = document.querySelectorAll('[data-slot="card"]');
  if (cards.length < 2) return false;
  if (!document.fonts || document.fonts.status !== 'loaded') return false;
  const tnum = [...document.querySelectorAll('.tnum')].map((el) => el.textContent.trim());
  if (!tnum.length || tnum.some((t) => !t)) return false;
  if (tnum.some((t) => /[#&@!*^~]/.test(t))) return false;
  const bars = [...document.querySelectorAll('[data-slot="card"] .h-full.rounded-full')].filter((el) => el.getBoundingClientRect().width > 0);
  return bars.length > 0;
})()`
const waitFor = async (expr, timeout = 30000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if ((await evalJS(expr)) === true) return true; await sleep(200) }
  return false
}

// 一张卡片与它内部各块的几何。名字、标签框、行高都量出来——「不影响美观」靠这些数字说话。
// ★按**节点名**返回每张卡片的几何：DOM 顺序在几次导航之间不稳定（分组排序 + 延迟行到没到），
// 拿「第一张卡」比两次会得出 `+93px` 这种假差异，按名字对齐才比得准。
const MEASURE = `(() => {
  const cards = [...document.querySelectorAll('[data-slot="card"]')];
  const out = cards.map((c) => {
    const r = c.getBoundingClientRect();
    const h3 = c.querySelector('h3');
    const row = h3 ? h3.parentElement.getBoundingClientRect() : null;
    const badges = [...c.querySelectorAll('[data-slot="badge"]')].map((b) => {
      const br = b.getBoundingClientRect();
      return { text: b.innerText.trim(), w: Math.round(br.width), h: Math.round(br.height) };
    });
    return {
      name: h3 ? h3.innerText.trim() : '?',
      cardH: Math.round(r.height),
      rowH: row ? Math.round(row.height) : null,
      nameClipped: h3 ? h3.scrollWidth > h3.clientWidth + 1 : null,
      nameW: h3 ? Math.round(h3.getBoundingClientRect().width) : null,
      badges,
      pingRows: c.querySelectorAll('svg polyline').length,
      panel: (() => { const p = c.querySelector('[data-note-panel]'); return p ? p.innerText.replace(/\\n/g, ' | ') : null })(),
    };
  });
  return JSON.stringify({ count: cards.length, withPing: out.filter((c) => c.pingRows > 0).length, cards: out });
})()`

const NAMES = TAGGED

// 三态：无备注（基线）/ 浮层关闭（默认形态，与基线逐像素相同）/ 悬停打开浮层（桌面走真鼠标）。
const MODES = [
  { key: '0', name: '0-无备注（基线）', notes: false, open: false },
  { key: 'a', name: 'a-浮层关闭（默认）', notes: true, open: false },
  { key: 'ao', name: 'b-悬停/点击打开浮层', notes: true, open: true },
]

const rows = []
for (const mode of MODES) {
  SERVED = configFor(mode.notes)
  hitCount = 0
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: false })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?m=${mode.key}` })
  const ok = await waitFor(SETTLED)
  // 卡片最后一块是「三网延迟」（1~3 行走势线），它到没到会让卡片高度差 90+px —— 等它到齐再量。
  const pinged = await waitFor(`(() => {
    const cs = [...document.querySelectorAll('[data-slot="card"]')];
    return cs.length >= 2 && cs.every((c) => c.querySelector('svg polyline'));
  })()`, 30000)
  await sleep(800)
  // 先拍整页（此时还在页面顶部），再滚到目标卡片切图 —— 顺序反了整页图会停在被滚动后的位置。
  const full = await send('Page.captureScreenshot', { format: 'png' })
  const fullPath = `${OUT_DIR}/${mode.key}-${mode.name.replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g, '')}.png`
  writeFileSync(fullPath, Buffer.from(full.result.data, 'base64'))
  // 目标卡片可能落在视口之外（手机单列时它常在第 3 张往下）——先滚进视口，否则 clip 截到的
  // 是视口外的空白（实测那种图墨点只占 2%，看着像主题坏了）。
  const scrolled = await evalJS(`(() => {
    const c = [...document.querySelectorAll('[data-slot="card"]')].find((el) => (el.querySelector('h3') || {}).textContent.trim() === ${JSON.stringify(NAMES[0])})
    if (!c) return false
    c.scrollIntoView({ block: 'center' })
    return true
  })()`)
  await sleep(400)
  if (scrolled !== true) problems.push(`${mode.name}: 没找到目标卡片、没滚动（切片可能是视口外的空白）`)
  let opened = null
  if (mode.open) {
    const box = JSON.parse(await evalJS(`(() => {
      const c = [...document.querySelectorAll('[data-slot="card"]')].find((el) => (el.querySelector('h3') || {}).textContent.trim() === ${JSON.stringify(NAMES[0])})
      const b = c && c.querySelector('[data-note-popover]')
      if (!b) return JSON.stringify(null)
      const r = b.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
    })()`))
    opened = box !== null
    if (box) {
      // 先移上去（触发 onPointerEnter），再点一下钉住 —— 两条入口都走到，图里才看得到悬停态。
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', buttons: 0 })
      await sleep(400)
      await evalJS(`(() => {
        const c = [...document.querySelectorAll('[data-slot="card"]')].find((el) => (el.querySelector('h3') || {}).textContent.trim() === ${JSON.stringify(NAMES[0])})
        const b = c && c.querySelector('[data-note-popover]')
        if (b && b.getAttribute('aria-expanded') === 'false') b.click()
        return true
      })()`)
      await sleep(500)
    }
  }
  const geo = JSON.parse(await evalJS(MEASURE))
  const box = await evalJS(`(() => {
    const c = [...document.querySelectorAll('[data-slot="card"]')].find((el) => (el.querySelector('h3') || {}).textContent.trim() === ${JSON.stringify(NAMES[0])}) || document.querySelector('[data-slot="card"]');
    const r = c.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x) - 20, y: Math.round(r.y) - 20, width: Math.round(r.width) + 56, height: Math.round(r.height) + 40 });
  })()`)
  // 卡片已滚进视口再切：clip 走普通路径。★手机那一档（DPR 3 + clip scale 3）实测出来的
  // 图尺寸对、内容却被压到左上角一小块（墨点只占 ~2%），所以本工具**手机一律用下面那张
  // 视口截图**（`<key>-view.png`）当交付图；桌面（DPR 2）的元素切片是准的，继续用它。
  const clip = await send('Page.captureScreenshot', { format: 'png', clip: { ...JSON.parse(box), scale: 3 } })
  const view = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT_DIR}/${mode.key}-view.png`, Buffer.from(view.result.data, 'base64'))
  const clipPath = `${OUT_DIR}/${mode.key}-card.png`
  const clipBytes = Buffer.from(clip.result.data, 'base64')
  writeFileSync(clipPath, clipBytes)
  // 空白图守卫：目标卡片在视口外时会截到几乎全白的图，体积小得反常（实测 3591×3258 的空白图
  // 只有几 KB，正常的一两百 KB）——这种图拿去交付等于白拍一版。
  if (clipBytes.length < 40_000) problems.push(`${mode.name}: 卡片切片只有 ${Math.round(clipBytes.length / 1024)}KB，八成是空白图（目标卡片在视口外？）`)

  const byName = Object.fromEntries((geo.cards ?? []).map((c) => [c.name, c]))
  const show = (n) => {
    const c = byName[n]
    if (!c) return `${n}: 没量到`
    return `高 ${c.cardH}px / 标题行 ${c.rowH}px / 名字 ${c.nameW}px${c.nameClipped ? '（截断）' : ''} / 浮层标签 ${c.badges.map((b) => `${b.text}(${b.w}×${b.h})`).join(' ') || '无'}${c.panel ? ` / 浮层「${c.panel}」` : ''}`
  }
  console.log(`\n📷 ${mode.name}  渲染=${ok ? 'ok' : '⚠ 超时'}  延迟行到齐=${pinged ? 'ok' : '⚠ 超时'}  桩命中=${hitCount}  卡片 ${geo.count} 张（有延迟行 ${geo.withPing}）`)
  console.log(`   ${clipPath}  ${fullPath}`)
  for (const n of NAMES) console.log(`   ${show(n)}`)
  if (hitCount !== 1) problems.push(`${mode.name}: 配置桩命中 ${hitCount} 次（应为 1）`)
  if (!ok) problems.push(`${mode.name}: 等待渲染落定超时`)
  if (!pinged) problems.push(`${mode.name}: 三网延迟一直没画出来（卡片高度不可比）`)
  if (mode.open && opened !== true) problems.push(`打开态：没找到那枚浮层控件，拍到的是关闭态`)
  // 备注开的那一档：清单里的前几台必须真的挂上了标签（否则拍到的仍是「没有备注」的样子）。
  if (mode.open && !(byName[NAMES[0]]?.badges?.length > 0)) {
    problems.push(`打开态：${NAMES[0]} 的浮层里没量到备注胶囊（备注没被列进浮层？）`)
  }
  rows.push({ mode: mode.name, key: mode.key, hits: hitCount, pinged, count: geo.count, byName })
}

writeFileSync(`${OUT_DIR}/measure.json`, JSON.stringify(rows, null, 2))
const base = rows.find((r) => r.key === '0')
const cell = (r, n) => {
  const c = r.byName[n]
  if (!c) return '—'
  const d = base.byName[n] ? c.cardH - base.byName[n].cardH : 0
  return `${c.cardH}px (${d >= 0 ? '+' : ''}${d})`
}
console.log('\n=== 卡片总高对照（按节点名，括号内 = 相对「无备注」基线）===')
console.log(`  ${'节点'.padEnd(20)}${NAMES.map((n) => n.padEnd(22)).join('')}`)
for (const r of rows) console.log(`  ${r.mode.padEnd(20)}${NAMES.map((n) => cell(r, n).padEnd(22)).join('')}`)
console.log('\n=== 标题行高（同一行里挂标签 → 高度不变）===')
for (const r of rows) console.log(`  ${r.mode.padEnd(20)}${NAMES.map((n) => `${(r.byName[n]?.rowH ?? '—')}px`.padEnd(22)).join('')}`)
console.log('\n=== 名字被挤到截断？ ===')
for (const r of rows) console.log(`  ${r.mode.padEnd(20)}${NAMES.map((n) => `${r.byName[n]?.nameClipped ? '截断' : '完整'}(${r.byName[n]?.nameW ?? '—'}px)`.padEnd(22)).join('')}`)
console.log(`\n几何与命中文数 → ${OUT_DIR}/measure.json`)
console.log(`控制台报错 ${problems.length} 条`)
for (const p of problems.slice(0, 10)) console.log(`   ${p}`)
ws.close()
chrome.kill()
serve.kill()
process.exit(problems.length ? 1 : 0)

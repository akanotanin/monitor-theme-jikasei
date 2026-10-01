// 紧凑形态「展开区里备注的落点」四档同机位取景（临时对照用；定稿后这个开关会删掉）。
// 用法：node tools/shot_note_compact.mjs <上游hub> <输出目录> [视口宽] [视口高] [DPR]
//   ssh -f -N -L 28083:127.0.0.1:28080 <hub机>
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const UPSTREAM = (process.argv[2] || '').replace(/\/$/, '')
const OUT_DIR = process.argv[3] || 'shots/compact'
const W = Number(process.argv[4] || 1440)
const H = Number(process.argv[5] || 1000)
const DPR = Number(process.argv[6] || 2)
if (!UPSTREAM) { console.error('用法：node tools/shot_note_compact.mjs <上游hub> <输出目录> [宽] [高] [DPR]'); process.exit(2) }

const SHORT = 'jikasei'
const PORT = 5700 + Math.floor(Math.random() * 200)
const CDP_PORT = 9900 + Math.floor(Math.random() * 90)
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync) || 'chrome'
mkdirSync(OUT_DIR, { recursive: true })

const live = await (await fetch(`${UPSTREAM}/api/nodes`)).json()
const nodes = Array.isArray(live) ? live : (live.nodes ?? [])
const TARGET = nodes[0]?.name
if (!TARGET) { console.error('上游没有节点'); process.exit(2) }
const liveConfig = await (await fetch(`${UPSTREAM}/api/themes/${SHORT}/config`)).json()
// 备注清单优先照抄站点里现存那份；没有就自己造一份三枚标签（这台机器必须真有备注，展开行里才有东西可看）。
const notes = ((liveConfig.serverNotes || '').trim()) || `${TARGET}=三网优化,备用,流媒体解锁`
writeFileSync(`${OUT_DIR}/notes-raw.txt`, notes + '\n')
console.log(`目标机器（名字逐字取自上游）：${TARGET}\n备注：${notes}`)
const configFor = (withNotes) => JSON.stringify({ ...liveConfig, cardStyle: 'compact', serverNotes: withNotes ? notes : '' })

const serve = spawn(process.execPath, ['tools/serve.mjs', String(PORT), '{}', '', UPSTREAM], { stdio: 'ignore' })
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break } catch {} await sleep(250) }

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=C:/Users/desup/AppData/Local/Temp/comp-${Date.now()}`, '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' })
let target = null
for (let i = 0; i < 80 && !target; i++) {
  await sleep(300)
  try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page') } catch {}
}
if (!target) throw new Error('Chrome 没起来')

const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const problems = []
let SERVED = configFor(true)
let hits = 0
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Fetch.requestPaused') {
    ws.send(JSON.stringify({ id: ++id, method: 'Fetch.fulfillRequest', params: {
      requestId: m.params.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }],
      body: Buffer.from(SERVED, 'utf8').toString('base64'),
    } }))
    hits += 1
    return
  }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJS = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value
const waitFor = async (expr, timeout = 40000) => { const d = Date.now() + timeout; while (Date.now() < d) { if ((await evalJS(expr)) === true) return true; await sleep(250) } return false }

await new Promise((r) => ws.addEventListener('open', r))
await send('Page.enable'); await send('Runtime.enable')
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__noteSpotC = new URLSearchParams(location.search).get('nc') || 'range';`,
})
await send('Fetch.enable', { patterns: [{ urlPattern: `*api/themes/${SHORT}/config*`, requestStage: 'Request' }] })
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })

// 展开那一行：点行上的折角（行本身是 role=button，点它会就地摊开而不是跳页）
const OPEN_ROW = `(() => {
  const row = [...document.querySelectorAll('tbody tr[role=button]')].find((r) => (r.querySelector('td span') || {}).textContent?.trim() === ${JSON.stringify(TARGET)})
    || [...document.querySelectorAll('tbody tr[role=button]')].find((r) => r.innerText.includes(${JSON.stringify(TARGET)}))
  if (!row) return 'no-row'
  if (row.getAttribute('aria-expanded') !== 'true') row.click()
  return row.getAttribute('aria-expanded')
})()`

const MEASURE = `JSON.stringify((() => {
  const row = [...document.querySelectorAll('tbody tr[role=button]')].find((r) => r.innerText.includes(${JSON.stringify(TARGET)}))
  const panel = row ? row.nextElementSibling : null                       // 展开行本身
  const box = panel ? panel.querySelector('td > div') : null              // 展开区那块容器
  if (!box) return { missing: true }
  const inside = box.getBoundingClientRect()
  const ranges = [...box.querySelectorAll('div.flex.flex-wrap.items-center')][0] || null
  const chartCol = [...box.querySelectorAll('div')].find((d) => /h-72|min-h-72/.test(d.className) && d.querySelector('svg.recharts-surface'))
  const svg = box.querySelector('svg.recharts-surface')
  const badges = [...box.querySelectorAll('[data-slot="badge"]')]
  const panelC = box.querySelector('[data-note-panel]')
  const rect = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), r: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) } }
  return {
    boxH: Math.round(inside.height),
    boxTop: Math.round(inside.top),
    rangesH: ranges ? Math.round(ranges.getBoundingClientRect().height) : null,
    rangesLines: ranges ? ranges.getBoundingClientRect().height > 26 : null,
    chartH: chartCol ? Math.round(chartCol.getBoundingClientRect().height) : null,
    svgBox: svg ? rect(svg) : null,
    badges: badges.map((b) => ({ text: b.innerText.trim(), ...rect(b) })),
    badgeLineTop: badges.length ? Math.round(badges[0].getBoundingClientRect().top) : null,
    panelC: panelC ? rect(panelC) : null,
    detailLink: (() => { const el = [...box.querySelectorAll('button')].find((b) => /完整详情/.test(b.innerText)); return el ? rect(el) : null })(),
    topText: box.innerText.replace(/\\n/g, ' | ').slice(0, 260),
  }
})())`

const MODES = [
  { nc: 'peek', name: '基线：无备注', notes: false },
  { nc: 'peek', name: 'C 图标 + 浮层（摊开）', notes: true, open: true },
]

const rows = []
for (const mode of MODES) {
  SERVED = configFor(mode.notes)
  hits = 0
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: false })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?nc=${mode.nc}` })
  const tableOk = await waitFor(`(() => {
    const rs = document.querySelectorAll('tbody tr[role=button]')
    return rs.length >= 2 && document.fonts.status === 'loaded'
  })()`)
  await sleep(700)
  const opened = await evalJS(OPEN_ROW)
  // 展开区的延迟图是懒取的 chunk：等 recharts 的 svg 真画出来
  const chartOk = await waitFor(`(() => {
    const row = [...document.querySelectorAll('tbody tr[role=button]')].find((r) => r.innerText.includes(${JSON.stringify(TARGET)}))
    const box = row && row.nextElementSibling ? row.nextElementSibling.querySelector('td > div') : null
    return !!box && !!box.querySelector('svg.recharts-surface')
  })()`, 40000)
  await sleep(1200)
  if (mode.open) {
    await evalJS(`(() => { const b = document.querySelector('tbody tr[role=button]').nextElementSibling.querySelector('[data-note-popover]'); if (b) b.click(); return true })()`)
    await sleep(400)
  }
  const geo = JSON.parse(await evalJS(MEASURE))
  if (geo.missing) problems.push(`${mode.name}: 展开区没找到（表格=${tableOk} 展开=${opened} 图=${chartOk}）`)
  const key = mode.name.split(' ')[0]
  const full = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT_DIR}/${key}-full.png`, Buffer.from(full.result.data, 'base64'))
  const clipBox = await evalJS(`(() => {
    const row = [...document.querySelectorAll('tbody tr[role=button]')].find((r) => r.innerText.includes(${JSON.stringify(TARGET)}))
    const panel = row ? row.nextElementSibling : null
    if (!panel) return null
    const r = panel.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y) - 34, width: Math.round(r.width), height: Math.round(r.height) + 42 })
  })()`)
  if (clipBox) {
    const clip = await send('Page.captureScreenshot', { format: 'png', clip: { ...JSON.parse(clipBox), scale: Math.min(3, 3) } })
    const bytes = Buffer.from(clip.result.data, 'base64')
    writeFileSync(`${OUT_DIR}/${key}-row.png`, bytes)
    if (bytes.length < 40_000) problems.push(`${mode.name}: 切片只有 ${Math.round(bytes.length / 1024)}KB，八成是空白`)
  } else problems.push(`${mode.name}: 取不到展开行`)
  console.log(`\n📷 ${mode.name}  表格=${tableOk ? 'ok' : '⚠'} 展开=${opened} 图=${chartOk ? 'ok' : '⚠'}  桩命中=${hits}`)
  console.log(`   展开区高 ${geo.boxH}px / 量程行高 ${geo.rangesH}px（折行=${geo.rangesLines}）/ 图表列高 ${geo.chartH}px`)
  console.log(`   标签 ${JSON.stringify(geo.badges.map((b) => b.text))} 首枚左 ${geo.badges[0]?.x ?? '—'} 上沿 ${geo.badgeLineTop ?? '—'} / 浮层 ${geo.panelC ? JSON.stringify(geo.panelC) : '（无）'}`)
  console.log(`   「完整详情 ›」${geo.detailLink ? `x=${geo.detailLink.x} 右${geo.detailLink.r}` : '（无）'}`)
  if (hits !== 1) problems.push(`${mode.name}: 配置桩命中 ${hits} 次`)
  rows.push({ mode: mode.name, key, hits, ...geo })
}
writeFileSync(`${OUT_DIR}/measure.json`, JSON.stringify(rows, null, 2))
console.log('\n=== 展开区总高（对照基线） ===')
const baseRow = rows[0]
for (const r of rows) console.log(`  ${r.mode.padEnd(24)} 展开区 ${r.boxH}px（${r.boxH - baseRow.boxH >= 0 ? '+' : ''}${r.boxH - baseRow.boxH}）  量程行 ${r.rangesH}px`)
console.log(`\n控制台报错 ${problems.length} 条`)
for (const p of problems) console.log('   ' + p)
ws.close(); chrome.kill(); serve.kill()
process.exit(problems.length ? 1 : 0)

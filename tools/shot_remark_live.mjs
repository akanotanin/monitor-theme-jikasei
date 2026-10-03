// 真机取景：静态 = 本机 dist/（待发的这一份），/api/* 转给真 hub（经隧道）——用**真实的节点数据与
// 真实的公开备注**拍五种形态 + 整页详情，交付给站长看「hub 里那条备注在页面上长什么样」。
//
// 用法：ssh -f -N -J <跳板> -L 28086:127.0.0.1:28080 <hub 那台机器>
//       node tools/shot_remark_live.mjs http://127.0.0.1:28086 [输出目录=shots/remark-live]
//
// 为什么不用现网那台拍：那是站长的公开站，形态改动要他自己在面板里选；这里静态走本机、
// 形态由本脚本按 URL 桩住（**不碰 hub 里存的站点配置**），数据仍是真的。
//
// ★配置桩必须自己回答：静态走本机、配置去问上游时，上游那台根本没装这一版主题 → 回 `{}`，
//   桩里设的 cardStyle 一个字不生效（踩过：整轮都拍成默认的「简约」档）。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

// 两种用法：
//   node tools/shot_remark_live.mjs <上游hub地址> [输出目录]     静态=本机 dist/，数据与形态桩在上面（默认）
//   node tools/shot_remark_live.mjs --hub <hub地址> [输出目录]   直接拍 **hub 伺服的那一份**（部署后验收）
const HUB_MODE = process.argv[2] === '--hub'
const UPSTREAM = (HUB_MODE ? process.argv[3] : process.argv[2] || '').replace(/\/$/, '')
const OUT_DIR = (HUB_MODE ? process.argv[4] : process.argv[3]) || 'shots/remark-live'
if (!UPSTREAM) { console.error('用法：node tools/shot_remark_live.mjs [--hub] <hub地址> [输出目录]'); process.exit(2) }
mkdirSync(OUT_DIR, { recursive: true })

const SHORT = 'jikasei'
const PORT = 5500 + Math.floor(Math.random() * 300)
const CDP_PORT = 9700 + Math.floor(Math.random() * 200)
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => existsSync(p)) || 'chrome'

// 真实数据（含备注）先读一遍：既当取景目标，也把「这台机器写了什么」打印出来供核对。
const live = await (await fetch(`${UPSTREAM}/api/nodes`)).json()
const nodes = Array.isArray(live) ? live : (live.nodes ?? [])
const me = await (await fetch(`${UPSTREAM}/api/me`)).json()
const remarked = nodes.filter((n) => (n.public_remark || '').trim())
console.log(`上游 ${UPSTREAM}：节点 ${nodes.length} 台，其中 ${remarked.length} 台写了公开备注；history_days=${me.history_days}`)
for (const n of remarked) console.log(`   #${n.id} ${n.name}：${n.public_remark.slice(0, 40)}${n.public_remark.length > 40 ? '…' : ''}（${n.public_remark.length} 字）`)
if (!remarked.length) { console.error('上游没有任何公开备注可拍：先在 hub 后台给某台节点填一条'); process.exit(2) }
const TARGET = remarked[0].name

const serve = HUB_MODE ? null : spawn(process.execPath, ['tools/serve.mjs', String(PORT), '{}', '', UPSTREAM], { stdio: 'ignore' })
if (!HUB_MODE) for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break } catch { /* 等它起来 */ } await sleep(250) }
const BASE = HUB_MODE ? UPSTREAM : `http://127.0.0.1:${PORT}`

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=C:/Users/desup/AppData/Local/Temp/remarklive-${Date.now()}`,
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--no-proxy-server', 'about:blank',
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
let SERVED = '{}'
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
const evalJS = async (expr) => {
  const r = (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result
  if (r?.exceptionDetails) console.log('   ⚠ 页面侧异常：', r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r?.result?.value
}
const waitFor = async (expr, timeout = 45000) => { const d = Date.now() + timeout; while (Date.now() < d) { if ((await evalJS(expr)) === true) return true; await sleep(250) } return false }

await new Promise((r) => ws.addEventListener('open', r))
await send('Page.enable'); await send('Runtime.enable')
// hub 模式下不桩任何东西：拍的正是「hub 上存的那份站点配置 + hub 伺服的那份主题」。
if (!HUB_MODE) await send('Fetch.enable', { patterns: [{ urlPattern: `*api/themes/${SHORT}/config*`, requestStage: 'Request' }] })
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })

const shoot = async (name, clip) => {
  const png = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' })
  const bytes = Buffer.from(png.result.data, 'base64')
  const file = `${OUT_DIR}/${name}.png`
  writeFileSync(file, bytes)
  console.log(`   📷 ${file}${clip ? `（裁切 ${Math.round(clip.width)}×${Math.round(clip.height)} @${clip.scale}×）` : ''}${bytes.length < 12_000 ? ' ⚠ 尺寸可疑，八成是空白图' : ''}`)
  return bytes.length
}
/** 按名字取那张卡片的外框，用来做「同机位单卡放大」。 */
const cardBox = async (name) => {
  const raw = await evalJS(`(() => {
    const c = [...document.querySelectorAll('[role=button]')].find((el) => ((el.querySelector('h3') || {}).textContent || '').trim() === ${JSON.stringify(name)})
    if (!c) return null
    const b = c.getBoundingClientRect()
    return JSON.stringify({ x: Math.floor(b.left) - 16, y: Math.floor(b.top) - 16, width: Math.ceil(b.width) + 32, height: Math.ceil(b.height) + 32, scale: 2 })
  })()`)
  return raw ? JSON.parse(raw) : null
}
const ready = (path) => path.startsWith('/node')
  ? `(() => !!document.querySelector('dl') && (!document.fonts || document.fonts.status === 'loaded'))()`
  : `(() => {
      const cs = document.querySelectorAll('[data-slot="card"], table tbody tr[role=button]')
      if (cs.length < 2 || !document.fonts || document.fonts.status !== 'loaded') return false
      const t = [...document.querySelectorAll('.tnum')].map((e) => e.textContent.trim())
      return t.length > 0 && !t.some((x) => !x) && !t.some((x) => /[#&@!*^~]/.test(x))
    })()`

async function go(style, tag, { path = '/', w = 1440, h = 900, after = null } = {}) {
  SERVED = JSON.stringify({ cardStyle: style })
  hits = 0
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 })
  await send('Page.navigate', { url: `${BASE}${path}?s=${tag}` })
  const ok = await waitFor(ready(path))
  await sleep(900)
  if (after) await after()
  console.log(`\n▶ ${tag}（${style}${path === '/' ? '' : ` · ${path}`}）内涵 ${w}×${h}  渲染=${ok ? 'ok' : '⚠ 超时'}  配置桩命中=${hits}`)
  // hub 模式下本来就不桩（拍的正是 hub 上那份配置），别在这里报假警。
  if (!HUB_MODE && hits !== 1) console.log('   ⚠ 配置桩命中次数不是 1：形态可能没按预期桩上')
  return ok
}

/**
 * 拍完打印这一档的关键事实：备注在不在、文本、有没有被截断、整条能不能拿到。
 * 「图看着对」不算判据——这里给的才是（取景只负责让人一眼看到）。
 */
async function facts() {
  const raw = await evalJS(`JSON.stringify((() => {
    const name = ${JSON.stringify(TARGET)}
    const card = [...document.querySelectorAll('[role=button]')].find((el) => ((el.querySelector('h3') || {}).textContent || '').trim() === name)
    const note = (card || document).querySelector('[data-public-remark]')
    const page = document.querySelector('[data-public-remark="page"]')
    const pop = document.querySelector('[data-note-panel]')
    const strip = document.querySelector('[data-note-strip]')
    const btn = document.querySelector('[data-note-popover]')
    return {
      card: card ? Math.round(card.getBoundingClientRect().height) : null,
      noteTags: note ? [...note.querySelectorAll('[data-slot="badge"]')].map((b) => b.innerText.trim()) : null,
      noteTitles: note ? [...note.querySelectorAll('[data-slot="badge"]')].map((b) => b.getAttribute('title')) : null,
      pageTags: page ? [...page.querySelectorAll('[data-slot="badge"]')].map((b) => b.innerText.trim()) : null,
      pageBlock: page ? page.textContent.trim().slice(0, 30) : null,
      pageBlockVisible: page ? page.getBoundingClientRect().height > 0 : null,
      popoverBtn: !!btn,
      popoverOpen: !!pop,
      stripText: strip ? strip.textContent.trim().slice(0, 24) : null,
      tabRowNote: document.querySelectorAll('[data-note-popover]').length,
    }
  })())`)
  const f = JSON.parse(raw ?? '{}')
  const bits = []
  if (f.page) bits.push(`整页那块的文本「${f.pageBlock}…」`)
  if (f.noteTags !== null) bits.push(`卡片上 ${f.noteTags.length} 枚小卡片 ${JSON.stringify(f.noteTags)}（每枚的 title 都在=${(f.noteTitles || []).every(Boolean)}）`)
  if (f.pageTags) bits.push(`整页那块 ${f.pageTags.length} 枚 ${JSON.stringify(f.pageTags)}`)
  if (f.pageBlock !== null) bits.push(`整页备注块「${f.pageBlock}…」可见=${f.pageBlockVisible}`)
  if (f.popoverBtn) bits.push(`信息图标在=${f.popoverBtn} 浮层已开=${f.popoverOpen}`)
  if (f.stripText !== null) bits.push(`紧凑那格「${f.stripText}…」`)
  console.log(`   事实：卡片高 ${f.card}px，${bits.length ? bits.join('；') : '这一档不带备注位（按口径）'}`)
}

if (HUB_MODE) {
  // hub 模式：形态由 hub 上存的站点配置决定（不是本脚本桩的），所以只拍它当前的样子。
  const cfg = await (await fetch(`${UPSTREAM}/api/themes/${SHORT}/config`)).json()
  const style = cfg.cardStyle || '(默认：简约)'
  console.log(`
hub 上存的站点配置：${JSON.stringify(cfg)} → 形态 ${style}`)
  await go(style, `hub-list-${style}`, { h: 1000 })
  await shoot(`hub-01-list-1440`)
  await facts()
  // 延迟/紧凑档的备注收在浮层里：点开那一枚信息图标，把浮层内容也拍下来 + 打成事实
  // （这一档在现网就是站长自己选的形态，肉眼要看的就是这一下）。
  const opened = await evalJS(`(() => {
    const c = [...document.querySelectorAll('[role=button]')].find((el) => ((el.querySelector('h3') || {}).textContent || '').trim() === ${JSON.stringify(TARGET)})
    const b = c && c.querySelector('[data-note-popover]')
    if (!b) return false
    b.click()
    return true
  })()`)
  if (opened) {
    await sleep(400)
    const panel = await evalJS(`(() => { const p = document.querySelector('[data-note-panel]'); return p ? JSON.stringify([...p.querySelectorAll('[data-slot="badge"]')].map((b) => b.innerText.trim())) : null })()`)
    console.log(`   浮层里的备注小卡片：${panel}`)
    await shoot(`hub-01b-list-popover-1440`)
  } else {
    console.log('   这一档没有浮层控件（经典/详细档的备注直接挂在标题行右端）')
  }
  await go(style, 'hub-detail', { path: `/node/${remarked[0].id}`, h: 1100 })
  await shoot('hub-02-detail-1440')
  await facts()
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1100, deviceScaleFactor: 1, mobile: true })
  await send('Page.navigate', { url: `${BASE}/node/${remarked[0].id}?s=hub-detail-390` })
  await waitFor(ready(`/node/${remarked[0].id}`))
  await sleep(900)
  await shoot('hub-03-detail-390')
  ws.close(); chrome.kill()
  console.log(`
成品在 ${OUT_DIR}/`)
  process.exit(0)
}

/* ── ① 经典 ── */
{
  await go('classic', 'classic')
  await shoot('01-classic-1440')
  await facts()
  const box = await cardBox(TARGET)
  if (box) await shoot('01b-classic-card', box)
}
/* ── ② 详细 ── */
{
  await go('detailed', 'detailed')
  await shoot('02-detailed-1440')
  await facts()
  const box = await cardBox(TARGET)
  if (box) await shoot('02b-detailed-card', box)
}
/* ── ③ 延迟（浮层摊开） ── */
{
  await go('latency', 'latency', { after: async () => {
    const raw = await evalJS(`(() => {
      const c = [...document.querySelectorAll('[role=button]')].find((el) => ((el.querySelector('h3') || {}).textContent || '').trim() === ${JSON.stringify(TARGET)})
      const b = c && c.querySelector('[data-note-popover]')
      if (!b) return null
      const r = b.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
    })()`)
    if (!raw) { console.log('   ⚠ 没找到那枚信息图标'); return }
    const { x, y } = JSON.parse(raw)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
    await sleep(600)
  } })
  await shoot('03-latency-popover-1440')
  await facts()
  const box = await cardBox(TARGET)
  if (box) await shoot('03b-latency-card', box)
}
/* ── ④ 紧凑（展开第一行） ── */
{
  await go('compact', 'compact', { h: 1000, after: async () => {
    await evalJS(`(() => { const r = document.querySelector('tbody tr[role=button]'); if (r) r.click(); return true })()`)
    await sleep(3500)
  } })
  await shoot('04-compact-expanded-1440')
  await facts()
}
/* ── ⑤ 紧凑 · 手机 390（收成一枚图标 + 浮层） ── */
{
  await go('compact', 'compact-390', { w: 390, h: 900, after: async () => {
    await evalJS(`(() => { const r = document.querySelector('tbody tr[role=button]'); if (r) r.click(); return true })()`)
    await sleep(3500)
    await evalJS(`(() => { const b = document.querySelector('[data-note-popover]'); if (b) b.click(); return true })()`)
    await sleep(400)
  } })
  await shoot('05-compact-390')
}
/* ── ⑥ 整页详情（备注那块） ── */
{
  const id = remarked[0].id
  await go('plain', 'detail', { path: `/node/${id}`, h: 1100 })
  await shoot('06-detail-1440')
  await facts()
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1000, deviceScaleFactor: 1, mobile: true })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/node/${id}?s=detail-390` })
  await waitFor(ready(`/node/${id}`))
  await sleep(900)
  await shoot('06b-detail-390')
}
ws.close(); chrome.kill(); serve.kill()
console.log(`\n成品在 ${OUT_DIR}/`)
process.exit(0)

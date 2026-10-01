// 同一份数据、同一机位，按卡片形态各拍一张 —— 用来做「改前 / 改后」对照图。
//
// 用法：node tools/shot_style_compare.mjs <nodes.json> <输出目录> [视口宽] [视口高] [DPR]
//   node tools/shot_style_compare.mjs ../nodes.json shots/style 1440 900 2
//
// 为什么要有它：形态之间的差别全在视觉层（字重、进度条粗细、标签配色），看单张图说不清
// 「到底哪里不一样」。这里把同一批数据、同一个视口、同一台机器渲染出来的几档并排拍下来，
// 差异就只剩「用户真正会看到的那几处」。
//
// 站点配置怎么钉：不改进程里的桩，而是让桩读地址栏的 `?style=` —— 一次浏览器会话里连着
// 访问 `?style=classic` 与 `?style=plain` 就能拿到两张同机位图，中间不必重启服务器，
// 也不会动站长存在 Hub 里的那份配置（访客看不到任何跳变）。
//
// 拍完会打印每张图的卡片几何与「桩真的命中了」的计数：后者是判据——桩没命中时拍的
// 就是服务器那份配置的样子，两张图会一模一样，看着像「差异极小」。
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const NODES = process.argv[2] || ''
const OUT_DIR = process.argv[3] || 'shots/style'
const W = Number(process.argv[4] || 1440)
const H = Number(process.argv[5] || 900)
const DPR = Number(process.argv[6] || 2)

const PORT = 5399
const CDP_PORT = 9555
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const SHOTS = [
  { style: 'classic', dark: false, name: 'classic-light.png' },
  { style: 'plain', dark: false, name: 'plain-light.png' },
  { style: 'classic', dark: true, name: 'classic-dark.png' },
  { style: 'plain', dark: true, name: 'plain-dark.png' },
]

// 形态差异是静止的（没有数字动画），但数据是轮询来的：等卡片出来 + 字体就绪 + 进度条
// 已有宽度（500ms 的过渡走完）再截。
// ★ 判据里不要带 `%` —— 百分比是卡片的正常内容（「内存 21%」），带上它就永远等不到。
const SETTLED = `(() => {
  const cards = document.querySelectorAll('[data-slot="card"]');
  if (cards.length < 2) return false;
  if (!document.fonts || document.fonts.status !== 'loaded') return false;
  const bar = cards[0].querySelector('.grid.grid-cols-2 > div > div:nth-child(2)');
  if (!bar || bar.getBoundingClientRect().height < 1) return false;
  const fill = bar.firstElementChild;
  return !!/[0-9]/.test(fill ? fill.style.width : '');
})()`

mkdirSync(OUT_DIR, { recursive: true })

/* ---------------------------------------------------------------- 静态伺服 */
const serve = spawn(process.execPath, ['tools/serve.mjs', String(PORT), '{}', NODES], {
  cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  stdio: 'ignore',
})
for (let i = 0; i < 60; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/`)
    if (res.ok) break
  } catch {
    /* 还没起来 */
  }
  await sleep(250)
}
console.log(`静态伺服就绪 http://127.0.0.1:${PORT}/`)

/* ---------------------------------------------------------------- 浏览器 */
const profile = `${process.env.TEMP || '.'}/style-cmp-${Date.now()}`
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--disable-gpu',
  '--hide-scrollbars',
  '--disable-background-timer-throttling',
  'about:blank',
], { stdio: 'ignore' })

let target = null
for (let i = 0; i < 60 && !target; i++) {
  await sleep(500)
  try {
    target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page')
  } catch {
    /* 还没起来 */
  }
}
if (!target) throw new Error('chrome 没起来')

const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const problems = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') problems.push(m.params.entry.text)
  if (m.method === 'Runtime.exceptionThrown') problems.push(`[exception] ${m.params.exceptionDetails.text}`)
})
const send = (method, params = {}) => new Promise((resolve) => {
  const myId = ++id
  pending.set(myId, resolve)
  ws.send(JSON.stringify({ id: myId, method, params }))
})
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails) return `⚠ 求值异常: ${res.result.exceptionDetails.text}`
  return res.result?.result?.value
}
const waitFor = async (expr, timeout = 30000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if ((await evaluate(expr)) === true) return true
    await sleep(200)
  }
  return false
}

await new Promise((r) => ws.addEventListener('open', r))
await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')

// 桩：站点配置照 `?style=` 答（其余键仍是服务器那份默认值），其余 /api/* 放行走真伺服。
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const orig = window.fetch;
    window.__stubHits = 0;
    window.fetch = function (input, init) {
      const url = String((input && input.url) ? input.url : input);
      if (url.indexOf('/themes/jikasei/config') >= 0) {
        const style = new URL(location.href).searchParams.get('style') || 'classic';
        window.__stubHits += 1;
        return Promise.resolve(new Response(JSON.stringify({ cardStyle: style }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }));
      }
      return orig.apply(this, arguments);
    };
  })();`,
})

const rows = []
for (const shot of SHOTS) {
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: false })
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?style=${shot.style}` })
  const ok = await waitFor(SETTLED)
  await sleep(1200)
  if (shot.dark) {
    await evaluate(`document.documentElement.classList.add('dark')`)
    await sleep(400)
  }
  const hits = await evaluate('window.__stubHits')
  const geo = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('[data-slot="card"]')].slice(0, 8).map((c) => {
      const r = c.getBoundingClientRect();
      // 读数格的四个孩子是同一套结构：label 行 / 进度条 / 底注。按结构取，不认类名。
      const grid = c.querySelector('.grid.grid-cols-2');
      const box = grid ? grid.children[0] : null;
      const bar = box ? box.children[1] : null;
      const label = box ? box.children[0].children[0].children[0] : null;
      const foot = box ? box.children[2] : null;
      const strip = c.querySelector('.grid.grid-cols-2 + div');
      const name = c.querySelector('h3');
      const cs = (el) => el ? getComputedStyle(el) : null;
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        nameWeight: name ? cs(name).fontWeight : null,
        nameSize: name ? cs(name).fontSize : null,
        labelColor: label ? cs(label).color : null,
        pctColor: box ? cs(box.children[0].lastElementChild).color : null,
        barH: bar ? cs(bar).height : null,
        barMargin: bar ? cs(bar).marginTop + '/' + cs(bar).marginBottom : null,
        footSize: foot ? cs(foot).fontSize : null,
        footColor: foot ? cs(foot).color : null,
        netRowSize: strip ? cs(strip).fontSize : null,
        gridRowGap: grid ? cs(grid).rowGap : null,
      };
    });
    return JSON.stringify({ count: document.querySelectorAll('[data-slot="card"]').length, cards });
  })()`)
  const png = await send('Page.captureScreenshot', { format: 'png' })
  const path = `${OUT_DIR}/${shot.name}`
  writeFileSync(path, Buffer.from(png.result.data, 'base64'))
  // 再拍一张只框住第一张卡片的放大图：形态差异全在这几十像素里，整页图缩下来看不清。
  const box = await evaluate(`(() => {
    const r = document.querySelector('[data-slot="card"]').getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x) - 22, y: Math.round(r.y) - 22, width: Math.round(r.width) + 44, height: Math.round(r.height) + 44 });
  })()`)
  const clipShot = await send('Page.captureScreenshot', { format: 'png', clip: { ...JSON.parse(box), scale: 3 } })
  const clipPath = `${OUT_DIR}/${shot.name.replace('.png', '-card.png')}`
  writeFileSync(clipPath, Buffer.from(clipShot.result.data, 'base64'))
  console.log(`📷 ${clipPath}（首张卡片放大 3×）`)
  const parsed = JSON.parse(geo)
  console.log(`📷 ${path}  渲染=${ok ? 'ok' : '⚠ 超时'}  桩命中=${hits}  卡片=${parsed.count}`)
  console.log(`   首张卡片 ${JSON.stringify(parsed.cards[0])}`)
  if (hits !== 1) problems.push(`${shot.name}: 配置桩命中 ${hits} 次（应为 1）`)
  if (!ok) problems.push(`${shot.name}: 等待渲染落定超时`)
  rows.push({ ...shot, hits, first: parsed.cards[0] })
}

writeFileSync(`${OUT_DIR}/measure.json`, JSON.stringify(rows, null, 2))
console.log(`\n几何与命中文数 → ${OUT_DIR}/measure.json`)
console.log(`控制台报错 ${problems.length} 条`)
for (const p of problems.slice(0, 10)) console.log(`   ${p}`)

ws.close()
chrome.kill()
serve.kill()
process.exit(problems.length ? 1 : 0)

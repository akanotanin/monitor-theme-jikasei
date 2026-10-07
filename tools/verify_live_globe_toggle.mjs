// 现网复核：站长那档 `globeOn=false` 时，前台顶栏**不该有**那枚地球开关；把它桩成 `true` 时
// 那枚开关**必须回来**，而且顶栏其余图标的顺序一字不动。
//
// 为什么要有它：站点设置里关掉「节点地球」之后，页面上不该留一枚点了什么也不开的按钮
// （2026-10-08 站长圈出来的就是这个）。本地那条判据在 `tools/verify_appearance.mjs`（桩数据），
// 这里管的是「装到真站上之后还对不对」——同一份包、只换站长那一档，正反两面都在真站上过一遍。
//
// 用法: node tools/verify_live_globe_toggle.mjs <站点地址> [截图输出目录]
//   例: node tools/verify_live_globe_toggle.mjs https://<站点>
//
// 两个坑：① 桩必须在**首次导航之前**注册（Page.addScriptToEvaluateOnNewDocument），并断言
// 桩真的被命中过（`window.__cfg === 'stub'`）——否则拿到的是服务器那份配置、两张图会一模一样；
// ② 站点在 Cloudflare 后面时本机 headless Chrome 走系统代理（本机代理策略已把 Chrome 钉在
// 127.0.0.1:2080），不要另加 --no-proxy-server。
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const SITE = (process.argv[2] || '').replace(/\/$/, '')
const OUT = process.argv[3] || 'shots'
if (!SITE) {
  console.error('用法：node tools/verify_live_globe_toggle.mjs <站点地址> [截图输出目录]')
  process.exit(2)
}
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => existsSync(p)) || 'chrome'
const dbg = 9950 + Math.floor(Math.random() * 40)
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, '--remote-allow-origins=*', '--no-first-run',
  '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900',
  '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/liveglobe-' + dbg + '-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
let wsUrl = null
for (let i = 0; i < 120 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl } catch { }
  if (!wsUrl) await sleep(300)
}
if (!wsUrl) throw new Error('Chrome 起不来：先看看是不是堆了太多测试实例（按 --user-data-dir 前缀清一遍）')
let id = 0
const pending = new Map()
const ws = new WebSocket(wsUrl)
await new Promise((r) => { ws.onopen = r })
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const js = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable'); await send('Page.enable')

let pass = 0, fail = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }

const READ = `JSON.stringify({
  titles: [...document.querySelectorAll('header button, header a')].map((e) => e.getAttribute('title')).filter(Boolean),
  toggle: !!document.querySelector('.globe-toggle'),
  panel: !!document.querySelector('.globe-panel'),
  cfg: window.__cfg ?? null,
})`
const settle = async () => {
  for (let i = 0; i < 80; i++) { await sleep(250); if (await js('!!document.querySelector("header")')) break }
  await sleep(2500)
}
const shotHeader = async (file) => {
  const box = JSON.parse(await js(`(() => { const r = document.querySelector('header').getBoundingClientRect(); return JSON.stringify({ x: r.x + scrollX, y: r.y + scrollY, w: Math.round(r.width), h: Math.round(r.height) }) })()`))
  const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 2 }, captureBeyondViewport: true })
  writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  console.log('  顶栏截图 ->', file, JSON.stringify(box))
}

// ① 真站原样：站长那档是关时，顶栏不该有那枚开关
await send('Page.navigate', { url: `${SITE}/` })
await settle()
let s = JSON.parse(await js(READ))
const realTitles = s.titles
console.log('  真站顶栏：', JSON.stringify(s.titles))
check('真站：页头画出来了（不是空白/被反代挡下）', s.titles.length >= 3, JSON.stringify(s.titles))

const cfg = await (await fetch(`${SITE}/api/themes/jikasei/config`)).json()
console.log('  真站 /api/themes/jikasei/config =', JSON.stringify(cfg))
const off = cfg.globeOn === false
if (off) {
  check('★ 真站（站长那档 globeOn=false）：顶栏没有那枚地球开关', s.toggle === false, `toggle=${s.toggle}`)
  check('真站：地球面板也不渲染', s.panel === false, `panel=${s.panel}`)
  await shotHeader(`${OUT}/hdr-off.png`)
} else {
  console.log('  INFO  这台站的 globeOn 是开的 —— 跳过「关」那一组，只验「开」这一面')
  check('真站（站长那档开着）：那枚开关在、地球也渲染', s.toggle === true && s.panel === true, `toggle=${s.toggle} panel=${s.panel}`)
}

// ② 同一份包 + 桩成 globeOn=true：那枚开关必须回来
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => { const f = window.fetch; window.fetch = function (u) {
    const url = String(u && u.url ? u.url : u);
    if (url.indexOf('/api/themes/jikasei/config') >= 0) {
      window.__cfg = 'stub';
      return Promise.resolve(new Response(JSON.stringify({ ...(${JSON.stringify(cfg)}), globeOn: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return f.apply(this, arguments); }; })()`,
})
await send('Page.navigate', { url: `${SITE}/` })
await settle()
s = JSON.parse(await js(READ))
check('桩真的生效了（配置那一项是桩回答的，判据才可信）', s.cfg === 'stub', String(s.cfg))
check('★ 桩成 globeOn=true 后：那枚地球开关回来了', s.toggle === true, `toggle=${s.toggle}`)
check('桩成 globeOn=true 后：地球面板也渲染了', s.panel === true, `panel=${s.panel}`)
const other = s.titles.filter((t) => t !== '隐藏节点地球' && t !== '显示节点地球')
check('★ 除了那一枚，顶栏其余图标的顺序与真站完全一致（没连带影响别的图标）',
  JSON.stringify(other) === JSON.stringify(realTitles), `桩 ${JSON.stringify(other)} ｜ 真站 ${JSON.stringify(realTitles)}`)
await shotHeader(`${OUT}/hdr-on.png`)

console.log(`\n结果: PASS ${pass} / FAIL ${fail}`)
ws.close(); chrome.kill()
process.exit(fail ? 1 : 0)

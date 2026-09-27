// 不用登录密码，验证「后台 → 主题 → 主题设置」里到底画出了哪些设置项。
//
// 原理：hub 后台是 SPA，设置对话框完全按 `GET /api/themes` 返回的 manifest.config 现画；
// 所以这里用 CDP 拦 /api/* 发假数据（config 就喂目标主题真实的 theme.json），跑的是真 React 组件。
//
// 对照组用法：先拿**改动前**的 theme.json 跑一遍，断言必须 FAIL（证明这个护栏真看得见设置项的增删），
// 再拿改动后的跑，断言必须全 PASS。只验「正确时通过」等于没验。
//
// ★字段数 > 6 且分组数 > 1 时，对话框换成「左侧分组导航 + 只挂载当前那一组」的布局。
// 因此「对话框文本里有没有某个设置项」这句话，只有在**先把那一组点开之后**才成立：
// 拿一次文本去断所有组，会把没打开的组整批判成「没画出来」——实测 6 项 → 7 项正好跨过这道坎，
// 新加的开关连同它后面那一组一起「消失」，看着像 manifest 写坏了。所以下面按组点开、按组断言。
//
// 用法: node tools/verify_settings_dialog.mjs <theme.json> <截图前缀> [baseUrl=http://127.0.0.1:28081]
//   baseUrl 通常是 ssh -L 隧道到测试 hub 的本地端口。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const MANIFEST = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const PREFIX = process.argv[3] || 'shots/settings-dialog';
const BASE = (process.argv[4] || 'http://127.0.0.1:28081').replace(/\/$/, '');
// 本站要靠这几项给站长换图标、开关概览卡片行、开关分组标签行、指养鸡场入口——名字与 theme.json 的 label 逐字对应。
const WANTED = ['站点图标', '显示养鸡场入口', '养鸡场地址', '显示概览卡片行', '显示分组标签行'];
const PORT = 9780 + Math.floor(Math.random() * 20);
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
  .find((p) => existsSync(p)) || 'chrome';

const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900',
  '--user-data-dir=' + (process.env.TEMP || '.') + '/settingsdlg-' + PORT + '-' + Date.now(), 'about:blank'], { stdio: 'ignore' });

let id = 0; const pend = new Map();
async function connect() {
  for (let i = 0; i < 40; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p) return p.webSocketDebuggerUrl; } catch {}
    await sleep(300);
  }
  throw new Error('Chrome 没起来');
}
const ws = new WebSocket(await connect());
await new Promise((r) => { ws.onopen = r; });
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
// 站点配置喂 `{}` = 从没保存过：面板的初值是 `saved[key] ?? default`，
// 所以截图里应当看到主题自带的默认值（/site-icon.png、开关是开的）。
// 「保存过非默认值」那一态不用这里验——线上真机的 PUT/匿名读回才是判据。
const saved = {};
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Fetch.requestPaused') {
    const { requestId, request } = m.params; const u = request.url;
    const json = (o) => send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(o)).toString('base64') });
    if (/\/api\/ws/.test(u)) return send('Fetch.failRequest', { requestId, errorReason: 'Aborted' });
    if (/\/api\/themes\/[^/]+\/config/.test(u)) return json(saved);
    if (/\/api\/themes(\?|$)/.test(u)) return json({ themes: [
      { name: MANIFEST.name, short: MANIFEST.short, description: MANIFEST.description, version: MANIFEST.version, author: MANIFEST.author, url: MANIFEST.url, selected: true, builtin: false, config: MANIFEST.config },
      { name: '默认主题', short: 'default', description: '', version: '1.0.0', author: 'Monitor', url: '', selected: false, builtin: true, config: [] },
    ] });
    if (/\/api\/me(\?|$)/.test(u)) return json({ authed: true, admin: true, github: false, public_page: true, site: BASE, site_name: 'Komari Monitor' });
    if (/\/api\/nodes/.test(u)) return json({ nodes: [] });
    if (/\/api\/ping-tasks/.test(u)) return json({ tasks: [] });
    if (/\/api\/version/.test(u)) return json({ version: '1.3.0' });
    return send('Fetch.continueRequest', { requestId });
  }
};
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++; };

await send('Runtime.enable'); await send('Page.enable');
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/admin/themes` });

// 先把「主题页本身起来了」和「卡片上有设置按钮」分开断言：
// Hub 只给**声明了 config 的**主题画那枚「主题设置」按钮，所以没有 config 时
// 等它出现会一直等不到——那是被测对象的状态，不是页面没起来，别混成一句失败。
let pageOk = false;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  pageOk = await js(`document.body.innerText.includes('安装主题')`);
  if (pageOk) break;
}
check('后台主题页渲染出来了', pageOk);
if (!pageOk) console.log('⚠ 页面没起来（曾遇到一次性空白页假失败）——同样的桩重跑一次再判定，不要当代码问题');

let btn = false;
if (pageOk) {
  for (let i = 0; i < 20; i++) {
    btn = await js(`!!document.querySelector('button[title="主题设置"]')`);
    if (btn) break;
    await sleep(300);
  }
}
check('主题卡片上有「主题设置」按钮（Hub 只给声明了 config 的主题画）', btn);

let dlg = false;
if (btn) {
  await js(`document.querySelector('button[title="主题设置"]')?.click()`);
  for (let i = 0; i < 40; i++) { await sleep(400); dlg = await js(`!!document.querySelector('[role="dialog"]')`); if (dlg) break; }
  check('设置对话框已打开', dlg);
  await sleep(800);
}

const entries = MANIFEST.config || [];
// theme.json 里 type=title 的项就是面板上的小节标题，也是分组导航上的项名。
const groups = [];
for (const entry of entries) {
  if (entry.type === 'title') groups.push({ label: entry.label, fields: [] });
  else if (groups.length) groups[groups.length - 1].fields.push(entry);
  else groups.push({ label: '', fields: [entry] });
}

const dialogText = async () => (await js(`(document.querySelector('[role="dialog"]')?.innerText || '')`)) || '';
// 分组导航：对话框左侧那排按钮。实测面板给它们发的是 `aria-current`（true/false），不是
// `aria-selected`（后者要 `[role=tab]` 才成立）——写错的那版返回空数组，于是「没导航」这段
// 分支被当成常态，断言全落在第一组上。别拿 [role=dialog] nav 找，那是另一个对话框的结构。
const nav = (await js(`[...document.querySelectorAll('[role="dialog"] button[aria-current]')].map((b) => b.innerText.trim())`)) || [];
const hasNav = nav.length > 1;
console.log(`对话框布局：${hasNav ? `分组导航 ${nav.join(' / ')}` : '一页平铺（字段数 ≤ 6，无导航）'}\n`);

async function openGroup(label) {
  if (!hasNav) return true;
  const clicked = await js(`(() => {
    const b = [...document.querySelectorAll('[role="dialog"] button[aria-current]')].find((x) => x.innerText.trim() === ${JSON.stringify(label)})
    if (!b) return false
    b.click()
    return true
  })()`);
  if (clicked) await sleep(500);
  return clicked;
}

// 「面板画出来了没」：按组点开再读文本。有导航时只挂载当前那一组，
// 没导航（小表单）时整页就是全部字段——两种布局共用同一批断言。
const texts = {};
for (const group of groups) {
  const opened = await openGroup(group.label);
  const text = await dialogText();
  texts[group.label] = text;
  const where = hasNav ? `「${group.label}」组` : '对话框';
  console.log(`—— ${where}: ${text.replace(/\n+/g, ' | ').slice(0, 400)}\n`);
  check(`${where}读到了内容`, opened && text.includes('取消'));
  for (const field of group.fields) check(`${where}里画出了「${field.label}」`, text.includes(field.label));
  check(`${where}每一项的说明文案都画出来了`,
    group.fields.every((f) => !f.help || text.includes(f.help)), group.fields.map((f) => f.label).join('、'));
}
const everyText = Object.values(texts).join('\n');
// 分组名（= 小节标题）也要能看到：有导航时在导航栏上，没有时在正文里。
// ★别只拿 everyText 当判据——导航栏本身就属于对话框正文，组名永远在里面，那样断言恒真。
check('theme.json 里的每个分组都有对应的导航项 / 小节标题',
  groups.length > 0 && groups.every((g) => g.label === '' || nav.includes(g.label) || everyText.includes(g.label)),
  groups.map((g) => g.label).join('、') || '（一个都没有）');
const declaredKeys = entries.filter((e) => e.type !== 'title').map((e) => e.key);
console.log(`声明的设置项: ${declaredKeys.join('、') || '（无）'}  分组: ${groups.map((g) => g.label).join('、') || '（无）'}  version=${MANIFEST.version}`);

// 两个方向都断：manifest 声明了没（我们的表单写对了没），面板画出来了没（Hub 认不认这个声明）。
for (const label of WANTED) {
  const owner = groups.find((g) => g.fields.some((f) => f.label === label));
  check(`对话框里画出了「${label}」`, !!owner && (texts[owner.label] || '').includes(label));
  check(`theme.json 声明了「${label}」`, entries.some((e) => e.label === label));
}

// 设置项的**说明文案**与**开关初值**也要断：它们是站长唯一看得见的地方，
// 改了 theme.json 的 help / default 却在面板上没生效（或残留旧句子）就等于没改。
// 「养鸡场地址」的说明曾经带一个跨站示例（会指向一个具体站点），那是要脱敏掉的。
const helpText = (entries.find((e) => e.key === 'farmUrl') || {}).help || '';
check('「养鸡场地址」的说明不再带跨站示例', helpText !== '' && !/例如|跨站的会在新标签页打开/.test(helpText), `help=${helpText}`);
check('对话框里也没有残留的旧示例句子', !everyText.includes('例如想直接进公开的养鸡场') && !/komari\.im\/chicken/.test(everyText));

// 开关初值 = `saved[key] ?? default`（站点配置喂的是 `{}`，所以看到的就是主题自带的默认值）。
// 面板对 boolean 用的是 Radix Switch：`button[role=switch][aria-checked]`，所以按开关读状态，
// 别去猜它内部的 DOM 结构。找不到开关要报 FAIL，不能静默通过。
async function switchState(label) {
  return await js(`(() => {
    const dlg = document.querySelector('[role="dialog"]')
    if (!dlg) return 'no-dialog'
    const node = [...dlg.querySelectorAll('*')].find((el) => el.children.length === 0 && el.textContent.trim() === ${JSON.stringify(label)})
    if (!node) return 'no-label'
    let box = node
    for (let i = 0; i < 5 && box && box !== dlg; i++) {
      const sw = box.querySelector('[role="switch"], input[type=checkbox]')
      if (sw) return sw.getAttribute('aria-checked') ?? String(sw.checked)
      box = box.parentElement
    }
    return 'no-switch'
  })()`)
}
for (const entry of entries.filter((e) => e.type === 'boolean')) {
  // 有导航时开关在其它组里，得先点开那一组（面板只挂载当前组）。
  const owner = groups.find((g) => g.fields.includes(entry));
  await openGroup(owner?.label ?? '');
  const state = await switchState(entry.label);
  check(`开关「${entry.label}」的初值 = theme.json 的 default（${entry.default}）`, state === String(entry.default), `面板读到 ${state}`);
}

mkdirSync(PREFIX.split('/').slice(0, -1).join('/') || '.', { recursive: true });
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(`${PREFIX}.png`, Buffer.from(shot.result.data, 'base64'));
console.log(`\n结果: PASS ${pass} / FAIL ${fail}  截图 -> ${PREFIX}.png`);
ws.close(); proc.kill();
process.exit(fail ? 1 : 0);

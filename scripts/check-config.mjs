// theme.json 的 config 默认值，必须与 src/lib/site-settings.ts 的 DEFAULTS 逐项一致。
//
// 这两处是同一个开关的两半：面板按 theme.json 现画表单，页面按 DEFAULTS 兜底。
// 只改一处就是那种「后台显示开着、页面还是旧样子」的毛病，而且两边都不报错。
//
// 用法：node scripts/check-config.mjs（npm run check，打包脚本与 CI 都会调）
import { existsSync, readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync('theme.json', 'utf8'))
const fields = (manifest.config || []).filter((entry) => entry.type !== 'title' && entry.key)
if (!fields.length) throw new Error('theme.json 的 config 里没有任何设置项')

const source = readFileSync('src/lib/site-settings.ts', 'utf8')
const block = source.match(/export const DEFAULTS[^=]*=\s*\{([\s\S]*?)\n\}/)
if (!block) throw new Error('src/lib/site-settings.ts 里找不到 DEFAULTS')
const declared = {}
for (const line of block[1].split('\n')) {
  const m = line.match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*(.+?),?\s*$/)
  if (m) declared[m[1]] = m[2].replace(/,$/, '').trim()
}

const problems = []
for (const field of fields) {
  if (!(field.key in declared)) {
    problems.push(`${field.key}: theme.json 有、DEFAULTS 里没有`)
    continue
  }
  // 去掉引号后照字面比：布尔、数字、字符串三种默认值都够用，不做求值。
  const code = declared[field.key].replace(/^["'`]|["'`]$/g, '').trim()
  const json = String(field.default).trim()
  if (code !== json) problems.push(`${field.key}: theme.json 是 ${json}、DEFAULTS 是 ${code}`)
}
for (const key of Object.keys(declared)) {
  if (!fields.some((f) => f.key === key)) problems.push(`${key}: DEFAULTS 有、theme.json 里没有`)
}
if (problems.length) throw new Error(`设置项默认值两边不一致：\n  ${problems.join('\n  ')}`)
console.log(`设置项默认值一致：${fields.map((f) => `${f.key}=${f.default}`).join('、')}`)

// 站名那个缓存键散在三处（App 一处、早跑脚本一处、index.html 的内联脚本一处）——它们必须逐字
// 一致。不一致的症状很阴：缓存有人写、没人读（或反过来），页面照常、后台照常，只是刷新时先闪
// 一次占位值，谁也不报错。这里一次比清，顺带保住那条早跑脚本没被删。
//
// ★ 站点图标那条缓存（`jikasei:site_icon`）1.25.0 起没了：图标改由 hub 1.4.0 的面板管，
//   主题侧只留 `public/favicon.svg` + `public/favicon.ico` + `public/apple-touch-icon.png` 三份兜底文件。
const CACHES = [
  { what: '站名', key: 'jikasei:site_name', places: [
    ['src/App.tsx', /TITLE_CACHE_KEY\s*=\s*"([^"]+)"/g],
    ['public/title-probe.js', /var KEY\s*=\s*"([^"]+)"/g],
    // 只认 `jikasei:` 前缀那一条：index.html 里现在还有首帧明暗那段读的 `theme`（见下一条）。
    ['index.html', /localStorage\.getItem\("(jikasei:[^"]+)"\)/g],
  ] },
  // 明暗这一档同源两处：App 的 useTheme 读 / 写 / 删，index.html 的首帧脚本事先读一次。
  { what: '明暗', key: 'theme', places: [
    ['src/App.tsx', /localStorage\.getItem\("(theme)"\)/g],
    ['index.html', /localStorage\.getItem\("(theme)"\)/g],
  ] },
]
const bad = []
for (const cache of CACHES) {
  for (const [file, pattern] of cache.places) {
    const found = [...readFileSync(file, 'utf8').matchAll(pattern)].map((m) => m[1])
    if (!found.length) bad.push(`${cache.what}：${file} 里找不到缓存键（护栏的锚点没了，别当通过）`)
    for (const value of found) if (value !== cache.key) bad.push(`${cache.what}：${file} 里是 ${value}，应为 ${cache.key}`)
  }
}
const html = readFileSync('index.html', 'utf8')
// ★ 2026-10-09：探针改 async 后，写死的精确串 `<script src="/title-probe.js">` 就失配了——
//   这里匹配的是「整条标签、允许带属性」，并额外钉住 async 本身：普通脚本会阻塞解析、
//   defer 也会被文档序拖住（实测 300ms 的探针延迟 = 首绘 396 vs 132ms），它是承重的。
{
  const probeTag = html.match(/<script src="\/title-probe\.js"[^>]*>/)
  if (!probeTag) bad.push(`index.html 里没有引入 /title-probe.js（标签页的占位值就没法早点换掉）`)
  else if (!/\basync\b/.test(probeTag[0])) bad.push(`/title-probe.js 的引入没有 async：普通脚本/defer 会拖住入口与首绘（见 index.html 注释里的实测数）`)
}
// 站点图标的两条静态引用：hub 1.4.0 认的就是这两个路径，写成别的名字等于把兜底丢了。
for (const icon of ['/favicon.svg', '/apple-touch-icon.png']) {
  if (!html.includes(`href="${icon}"`)) bad.push(`index.html 里没有引用 ${icon}（站点图标的兜底就断了）`)
}
// ★ 首帧明暗（2026-11-06）：暗色访客在入口包执行之前页面上只有 CSS 默认的亮色底 —— 首绘会先
//   闪一屏亮色，弱网下这段最长。那一段必须内联在 <head>、并且赶在入口模块之前；它还得把
//   colorScheme 说清楚，否则暗色下原生滚动条 / 表单控件仍是亮色。CSS 里另有一份给「内联被
//   CSP 挡掉」时兜底（React 挂上 .dark 之后原生控件照样要跟着转暗）。
{
  const toggleAt = html.indexOf('document.documentElement.classList.toggle("dark"')
  const moduleAt = html.indexOf('<script type="module"')
  if (toggleAt < 0) bad.push('index.html 里没有首帧明暗的内联脚本（暗色访客会先闪一屏亮色）')
  else {
    if (moduleAt >= 0 && toggleAt > moduleAt) bad.push('首帧明暗那段内联脚本在入口模块之后：它必须赶在首帧之前跑（挪回 <head> 里）')
    if (!html.includes('document.documentElement.style.colorScheme')) bad.push('首帧明暗那段没有设 colorScheme（暗色下原生滚动条与表单控件仍是亮色）')
  }
  const css = readFileSync('src/index.css', 'utf8')
  if (!css.includes('color-scheme: dark')) bad.push('src/index.css 的 .dark 没有 color-scheme: dark（原生控件不会转暗）')
  if (!css.includes('color-scheme: light')) bad.push('src/index.css 的 :root 没有 color-scheme: light（原生控件不会转亮）')
}
// 主题包里必须真的带着这两份兜底文件（public/ 会被原样拷进 dist/）。
for (const file of ['public/favicon.svg', 'public/favicon.ico', 'public/apple-touch-icon.png']) {
  if (!existsSync(file)) bad.push(`缺少 ${file}`)
}
if (bad.length) throw new Error(`缓存键或早跑脚本对不上：\n  ${bad.join('\n  ')}`)
console.log(`缓存键一致：${CACHES.map((c) => `${c.what} ${c.key}（${c.places.length} 处）`).join('、')}；早跑脚本在 index.html 里；站点图标两条静态引用与三份兜底文件都在`)

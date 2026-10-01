// 生成主题预览图（preview.png = 面板卡片上那张）——「角色 + 主题名」封面版。
//
// 用法：node tools/preview-cover.mjs [输出路径] [形态]
//   node tools/preview-cover.mjs                     # 默认 → preview.png，纯封面（发版用这张）
//   node tools/preview-cover.mjs preview-cover-compact.png compact
//   形态：pure（默认，纯封面） | classic | compact | detailed（下方带一条现网实拍长条）
//
// 为什么这么做（而不是直接 Page.captureScreenshot 拍站点）：
//   1. 面板卡片上只有约 300px 宽，一张缩到那个尺寸还看得清「这是哪个主题」的图，
//      靠的是大字 + 角色，而不是站点截图里的数字。
//   2. 配色不靠感觉调，全部取自现网实拍的原值：底 #ffffff、主字 #121212、次要 #696969、
//      中间调 #8a8a8a（与 public/favicon.svg 里那枚「唯一中间调」同色）、分隔线 #dedede。
//   3. 角色图（preview-src/mascot.png）本身就是「右边与下边被切」的构图，所以贴到画布
//      右下角（right: -4 / bottom: -10），硬切边正好落在画布边界上，看不出被裁。
//
// 尺寸：1440x810 CSS @ DPR 2 = 2880x1620，与历史上那几张预览图同机位（换图不该改观感）。
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const OUT = process.argv[2] || 'preview.png'
const FORM = process.argv[3] || 'pure'
const W = 1440, H = 810, DPR = 2
const MASCOT = 'preview-src/mascot.png'

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p)) || 'chrome'

if (!existsSync(MASCOT)) {
  throw new Error(`缺少 ${MASCOT}（角色图）。用 tools/mascot-cutout.py 从白底原图抠出来，或者把已有的透明 PNG 放到这个路径。`)
}

// 角色与文案的尺寸：改这里就能重新出图，数字都是按「文字右沿 ↔ 角色左轮廓」实测空档定的
// （pure 版实测空档 101px；正文块宽 740 是给最长那行繁体级中文留的安全边）
const PURE = { ch: 700, h1: 200, kicker: 18, sub: 36, feats: 25, block: 740 }
// 带长条的三种形态：长条高度 = 截图的自然比例，角色底边压在长条上沿
const BANDS = {
  classic: { file: 'preview-classic.png', top: 0, height: 345, ch: 350 },
  compact: { file: 'preview-compact.png', top: 75, height: 405, ch: 350 },
  detailed: { file: 'preview-detailed.png', top: 75, height: 390, ch: 350 },
}

const uri = (f) => `data:image/png;base64,${readFileSync(f).toString('base64')}`
const head = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
:root{--ink:#121212;--mid:#696969;--soft:#8a8a8a;--line:#dedede}
*{box-sizing:border-box;margin:0}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:#fff;color:var(--ink);
  font-family:"Segoe UI",system-ui,-apple-system,"Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
body{position:relative}
.kicker{letter-spacing:.22em;color:var(--soft);text-transform:uppercase}
h1{font-weight:700;letter-spacing:-.022em;line-height:1}
.sub{color:var(--mid)}
.rule{height:1px;background:var(--line)}
.feats{color:var(--mid)}
.mascot{filter:drop-shadow(0 18px 32px rgba(18,18,18,.10))}
</style></head><body>`

const copy = (feats) => `<div class="copy">
  <div class="kicker">Monitor Theme</div>
  <h1>jikasei</h1>
  <div class="sub">自家制の极简探针（Monitor）主题</div>
  <div class="rule"></div>
  <div class="feats">${feats}</div>
</div>`
const FEATS2 = '五种卡片形态 · 三网延迟 · 分组筛选<br>明暗双色 · 备注标签 · 自定义站标'
const FEATS1 = '五种卡片形态 · 三网延迟 · 分组筛选 · 明暗双色'

let html
if (FORM === 'pure') {
  const { ch, h1, kicker, sub, feats, block } = PURE
  html = `${head}
<img class="mascot" src="${uri(MASCOT)}">
${copy(FEATS2)}
<style>
.copy{position:absolute;left:96px;top:50%;transform:translateY(-50%);width:${block}px}
.kicker{font-size:${kicker}px}
h1{font-size:${h1}px;margin-top:${Math.round(h1 * 0.2)}px}
.sub{font-size:${sub}px;margin-top:${sub}px}
.rule{width:${Math.round(h1 * 1.7)}px;margin:${sub}px 0}
.feats{font-size:${feats}px;line-height:1.95}
.mascot{position:absolute;right:-4px;bottom:-10px;height:${ch}px}
</style></body></html>`
} else {
  const band = BANDS[FORM]
  if (!band) throw new Error(`未知形态 ${FORM}（可选：pure / classic / compact / detailed）`)
  if (!existsSync(band.file)) throw new Error(`缺少 ${band.file}（${FORM} 形态的站点截图）`)
  // 长条用「溢出裁切 + 负偏移」取截图的一段落，不引入图像处理依赖
  html = `${head}
<div class="band"><img src="${uri(band.file)}"></div>
<img class="mascot" src="${uri(MASCOT)}">
${copy(FEATS1)}
<style>
.band{position:absolute;left:0;right:0;bottom:0;height:${band.height}px;overflow:hidden;border-top:1px solid var(--line)}
.band img{position:absolute;left:0;top:${-band.top}px;display:block;width:${W}px}
.copy{position:absolute;left:96px;top:52px;width:720px}
.kicker{font-size:13px}
h1{font-size:72px;margin-top:14px}
.sub{font-size:19px;margin-top:14px}
.rule{width:180px;margin:20px 0}
.feats{font-size:16px}
.mascot{position:absolute;right:128px;bottom:${band.height}px;height:${band.ch}px}
</style></body></html>`
}

const dir = mkdtempSync(join(tmpdir(), 'preview-cover-'))
const page = join(dir, 'cover.html')
writeFileSync(page, html)
execFileSync(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  `--force-device-scale-factor=${DPR}`, `--window-size=${W},${H}`,
  `--user-data-dir=${join(dir, 'prof')}`, `--screenshot=${resolve(OUT)}`, `file:///${page}`,
], { stdio: 'pipe' })

// 自检：尺寸必须对、不能是空白页（空白页体积会小得离谱）
const buf = readFileSync(OUT)
const size = `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`
if (size !== `${W * DPR}x${H * DPR}`) throw new Error(`输出尺寸 ${size}，应为 ${W * DPR}x${H * DPR}`)
if (buf.length < 20000) throw new Error(`输出只有 ${buf.length} 字节，像是空白页`)
console.log(`${OUT}  ${size}  ${(buf.length / 1024).toFixed(0)}KB  形态=${FORM}`)

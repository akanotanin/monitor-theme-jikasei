// 打主题包：theme.json + LICENSE + dist/（+ preview.png）
// 极简探针的主题包结构：hub 只做静态文件伺服，dist/ 就是整站。
//
// 用法：npm run package（先 build 再打包）
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { listArchive, packDirectory } from './lib/pack.mjs'

const meta = JSON.parse(readFileSync('theme.json', 'utf8'))
if (!/^[A-Za-z0-9_-]+$/.test(meta.short || '')) throw new Error(`theme.json 的 short 不合法: ${meta.short}`)
if (!existsSync('LICENSE')) throw new Error('缺少 LICENSE')
if (!existsSync('dist/index.html')) throw new Error('缺少 dist/index.html，先跑 npm run build')

// ★ dist/ 必须是刚构建的，别把上一轮的产物打进这一轮的包：
//   逐个比对源文件与 dist/index.html 的修改时间。用时间戳而不是哈希，是因为
//   Vite 的产物名带内容哈希，比不出「改了源码但没重新构建」这件事。
const sources = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) walk(path)
    else sources.push(path)
  }
}
walk('src')
walk('public')
for (const file of ['index.html', 'vite.config.ts', 'package.json', 'theme.json']) sources.push(file)
const built = statSync('dist/index.html').mtimeMs
const stale = sources.filter((file) => statSync(file).mtimeMs > built)
if (stale.length) {
  throw new Error(`dist/ 比这些源文件旧，先跑 npm run build：\n  ${stale.join('\n  ')}`)
}

// public/ 里的东西必须原样落到 dist/：国旗、站点图标、标题探针都是静态文件，缺了页面照样 200。
for (const file of ['dist/favicon.svg', 'dist/favicon.ico', 'dist/apple-touch-icon.png', 'dist/flags', 'dist/title-probe.js']) {
  if (!existsSync(file)) throw new Error(`dist/ 里缺 ${file}，public/ 没被拷进去？`)
}

rmSync('release', { recursive: true, force: true })
const staging = 'release/staging'
mkdirSync(staging, { recursive: true })
const files = ['theme.json', 'LICENSE', 'dist']
for (const file of files) cpSync(file, `${staging}/${file}`, { recursive: true })
if (existsSync('preview.png')) {
  copyFileSync('preview.png', `${staging}/preview.png`)
  files.push('preview.png')
} else {
  console.warn('提示：没有 preview.png，面板里这个主题不会有缩略图')
}

const archive = 'release/theme.tar.gz'
// ★确定性打包：**tar 与 gzip 两层都由 Node 自己写**（scripts/lib/pack.mjs），不调外部 tar。
//
//   历史（2026-11-21）：原先裸 `tar -czf`，包头里写的是**这台机器**的 mtime、uid/gid 与
//   属主名 —— 同一份源码连跑两次，sha256 就不同（实测 `9ce17f…` → `2ac09b…`）。当天改成
//   `--mtime/--owner/--group/--sort`，在 CI（Linux/GNU tar）上确实稳了，但 **Windows 上
//   依旧不可复现**（2026-11-22 三审实测）：
//     · 系统自带 bsdtar 3.8.9 的 gzip 头写的是本次打包的真实时刻，`--mtime` 钉不住压缩层；
//       两次打包 sha256 `890c233c…` ≠ `e3aa13ba…`，而裸 tar 流完全相同（`877dd241…`），
//       差异就是 gzip 头那 4 字节 MTIME；
//     · 它也没有 `--mode`（`Option --mode=644 is not supported`），产物权限位跟着文件系统
//       umask 走：Windows 上 0666/0777、CI 的 Linux 检出 0644/0755 —— 与发布资产永远对不上。
//   现在两层都自己写：ustar 头（0644/0755、属主全 0、mtime 固定、按字节序排序）+ 自拼
//   gzip 头（MTIME 0、OS=03）+ zlib level 9。**任何平台、任何 Node 版本同字节**
//   （zlib 1.3.1 与 1.3.2 的 deflate 输出实测一致）。
//   `preview.png` 的压缩前后内容若跨 zlib 版本有变化，sha256 仍会在同一 zlib 版本族内一致；
//   真要逐字节复刻历史发布资产没有意义 —— 目标是「同一份源码在任何机器上同 byte」。
//
//   ★另外别写「hub 的 web-theme.pin 按 sha256 认包」（旧注释的说法，2026-11-22 三审核实为误）：
//   pin 只用于 hub **构建期**取它内置的默认主题（monitor 仓的 scripts/theme.sh 按 pin 下载并
//   校验），第三方主题经「上传 / 从 GitHub 安装」进来时 hub 只认资产名 `theme.tar.gz`、大小
//   上限与 gzip 魔数，**不做 sha256 校验**（monitor v1.5.2 的 fetch_theme 实测）。可复现打包
//   的真实收益是：资产可审计、CI 幂等、同平台自构建能与发布值对上。
const packed = packDirectory(staging, archive, { files })
console.log(`主题包: ${archive} (${(packed.size / 1048576).toFixed(2)} MB)`)

// 开包验证一遍，别把空包或路径写错的包发出去。用自己的解析器读回（不借外部 tar，
// Windows 上就不必担心 bsdtar 的 CRLF 尾巴与 `--mode` 差异）。
const listing = listArchive(archive).map((entry) => entry.name)
for (const need of ['theme.json', 'dist/index.html', 'dist/favicon.svg', 'preview.png']) {
  if (!listing.includes(need)) throw new Error(`包内缺 ${need}（共 ${listing.length} 项）`)
}
console.log(`包内 ${listing.length} 项，自检通过`)

const versioned = `release/monitor-theme-${meta.short}-${meta.version}.tar.gz`
copyFileSync(archive, versioned)
console.log(`版本化副本: ${versioned}`)

// 校验和：发版页与回装复验都拿它比对。
// ★两个文件名都要能验（2026-11-07 二审）：Release 页上传的是 `theme.tar.gz`（hub 的
//   web-theme.pin 按这个名字取），而这里原先只写版本化副本的名字 —— 于是站长下载
//   `theme.tar.gz` + `.sha256` 之后 `sha256sum -c` 直接报「No such file or directory」
//   （第一道完整性校验就废了）。两份 sha 文件、各写各的文件名。
const record = (file) => {
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
  writeFileSync(`${file}.sha256`, `${digest}  ${file.split('/').pop()}\n`)
  return digest
}
const digest = record(versioned)
record(archive)
console.log(`sha256: ${digest}`)

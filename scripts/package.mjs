// 打主题包：theme.json + LICENSE + dist/（+ preview.png）
// 极简探针的主题包结构：hub 只做静态文件伺服，dist/ 就是整站。
//
// 用法：npm run package（先 build 再打包）
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

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
// ★确定性打包（2026-11-21 三审）：原先裸 `tar -czf`，包头里写的是**这台机器**的 mtime、
//   uid/gid 与属主名 —— 同一份源码连跑两次 `npm run package`，sha256 就不同（实测
//   `9ce17f…` → `2ac09b…`）。后果不是洁癖：hub 的 web-theme.pin 按 sha256 认包，站长
//   「下载源码 + 自己构建」永远对不上发布页那个值，.sha256 的第一道校验也就废了。
//   钉死：排序 + 全零属主 + 固定 mtime（SOURCE_DATE_EPOCH，没设就用 0 = 1970-01-01）。
//   `--mtime` 与 `--sort`/`--owner` 是 GNU tar 的开关；Windows 自带的 bsdtar 也认这三条
//   （仅 `--sort` 在老版本上没有，这里用 try 兜一层，退化成「只钉 mtime 与属主」）。
const mtime = process.env.SOURCE_DATE_EPOCH ? `@${process.env.SOURCE_DATE_EPOCH}` : "@0"
const deterministic = ['--owner=0', '--group=0', '--numeric-owner', `--mtime=${mtime}`, '--sort=name']
const tarArgs = (extra) => ['-czf', archive, '-C', staging, ...extra, ...files]
try {
  execFileSync('tar', tarArgs(deterministic), { stdio: 'inherit' })
} catch {
  // 老 bsdtar 不认 --sort：去掉它再试一次（其余三个仍能消掉 mtime 与属主的漂移）。
  execFileSync('tar', tarArgs(deterministic.filter((a) => !a.startsWith('--sort'))), { stdio: 'inherit' })
}

// 开包验证一遍，别把空包或路径写错的包发出去。
// 按 CRLF 也切：Windows 的 bsdtar 列出的每行末尾带 \r，只切 \n 的话每个条目都多一个尾随字符，
// 下面那些字面量比对就会全部落空（Linux / macOS 的 tar 不受影响）。
const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/)
for (const need of ['theme.json', 'dist/index.html', 'dist/favicon.svg', 'preview.png']) {
  if (!listing.includes(need)) throw new Error(`包内缺 ${need}（共 ${listing.length} 项）`)
}
const size = statSync(archive).size
console.log(`主题包: ${archive} (${(size / 1048576).toFixed(2)} MB, ${listing.length} 项)`)

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

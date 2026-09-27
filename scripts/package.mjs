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

// public/ 里的东西必须原样落到 dist/：国旗与站标都是静态文件，缺了页面照样 200。
for (const file of ['dist/site-icon.png', 'dist/flags', 'dist/title-probe.js']) {
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
execFileSync('tar', ['-czf', archive, '-C', staging, ...files], { stdio: 'inherit' })

// 开包验证一遍，别把空包或路径写错的包发出去。
const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n')
for (const need of ['theme.json', 'dist/index.html', 'dist/site-icon.png', 'preview.png']) {
  if (!listing.includes(need)) throw new Error(`包内缺 ${need}（共 ${listing.length} 项）`)
}
const size = statSync(archive).size
console.log(`主题包: ${archive} (${(size / 1048576).toFixed(2)} MB, ${listing.length} 项)`)

const versioned = `release/monitor-theme-${meta.short}-${meta.version}.tar.gz`
copyFileSync(archive, versioned)
console.log(`版本化副本: ${versioned}`)

// 校验和：发版页与回装复验都拿它比对
const digest = createHash('sha256').update(readFileSync(versioned)).digest('hex')
writeFileSync(`${versioned}.sha256`, `${digest}  ${versioned.split('/').pop()}\n`)
console.log(`sha256: ${digest}`)

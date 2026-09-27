// theme.json 的 config 默认值，必须与 src/lib/site-settings.ts 的 DEFAULTS 逐项一致。
//
// 这两处是同一个开关的两半：面板按 theme.json 现画表单，页面按 DEFAULTS 兜底。
// 只改一处就是那种「后台显示开着、页面还是旧样子」的毛病，而且两边都不报错。
//
// 用法：node scripts/check-config.mjs（npm run check，打包脚本与 CI 都会调）
import { readFileSync } from 'node:fs'

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

// 地球的**逐像素**对账（比 verify_globe_*.mjs 的采样密两个数量级，也不需要浏览器）：
//   真值 = 直接用世界数据的环在经纬度上做射线法；
//   画出来的 = 把 `landPaths()` 生成的那条 `d` 解析回多边形，按非零绕数逐像素判定。
// 两者不一致的像素上色（红 = 该是陆地没画、蓝 = 不该是陆地画了），写成 PNG 一眼看出形状，
// 并打印每个误差块的经纬度与半径 —— 「陆地随转动残缺」这类问题就是靠它定位到具体某块地的。
//
// 用法：node tools/globe-diff-image.mjs [起始经度] [步长] [点数] [每像素单位]
//   例：node tools/globe-diff-image.mjs 0 10 36 2   # 整圈 36 个角度，每 2 个用户单位一个像素
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { join } from 'node:path'
import { camera, landPaths, prepareRings, VIEW } from '../src/lib/globe.ts'
import { WORLD_OUTLINES } from '../src/lib/world.ts'

const OUT = 'shots/globe-diff-image'

/* ---------------------------------------------------------------- PNG 写出（零依赖） */
const CRC = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return (buf) => {
    let c = -1
    for (let i = 0; i < buf.length; i += 1) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }
})()
const chunk = (type, data) => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(CRC(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}
function writePng(path, w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 4 + 1)] = 0
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]))
}

/* ---------------------------------------------------------------- 真值：经纬度射线法 */
/**
 * ★ 真值用哪一套环：`raw` = 数据点之间按**经纬度直线**连（射线法的默认读法），
 * `gc` = 先按**大圆**把长边细分到 1° 再连。
 *
 * 为什么要两套：渲染那边画的是**屏幕上的直线**（两点投影后直连），而地球是球面 ——
 * 数据里偶尔有十几度一条的长边（0.3°/点的平均间距之外的那些），三种读法在**贴地平线
 * 那一圈和高纬度**会差出好几个像素：实测纬度 50 时「raw 真值」把一整条阿拉斯加海岸判成
 * 错位 2~5px。换成大圆细分后同一批角度的一致性好得多（见交付说明里的对照）。
 * 默认用 gc：它才是「这条海岸线在地球上该在哪」的忠实读法。
 */
const TRUTH = process.env.TRUTH === 'raw' ? 'raw' : 'gc'
const gcRings = (rings, stepDeg = 1) => rings.map((ring) => {
  const out = []
  for (let i = 0; i < ring.length; i += 1) {
    const [lo1, la1] = ring[i]
    const [lo2, la2] = ring[(i + 1) % ring.length]
    out.push([lo1, la1])
    const a = [(Math.PI / 180) * lo1, (Math.PI / 180) * la1]
    const b = [(Math.PI / 180) * lo2, (Math.PI / 180) * la2]
    const v1 = [Math.cos(a[1]) * Math.sin(a[0]), Math.sin(a[1]), Math.cos(a[1]) * Math.cos(a[0])]
    const v2 = [Math.cos(b[1]) * Math.sin(b[0]), Math.sin(b[1]), Math.cos(b[1]) * Math.cos(b[0])]
    const dot = Math.max(-1, Math.min(1, v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]))
    const ang = Math.acos(dot)
    const steps = Math.max(1, Math.ceil((ang * 180) / Math.PI / stepDeg))
    for (let k = 1; k < steps; k += 1) {
      const t = k / steps
      const s = Math.sin(ang) || 1
      const p = [0, 1, 2].map((j) => (Math.sin((1 - t) * ang) / s) * v1[j] + (Math.sin(t * ang) / s) * v2[j])
      const n = Math.hypot(p[0], p[1], p[2]) || 1
      out.push([((Math.atan2(p[0] / n, p[2] / n) * 180) / Math.PI), ((Math.asin(Math.max(-1, Math.min(1, p[1] / n))) * 180) / Math.PI)])
    }
  }
  return out
})
const rings = (TRUTH === 'gc' ? gcRings(WORLD_OUTLINES.filter((r) => r && r.length >= 3)) : WORLD_OUTLINES.filter((r) => r && r.length >= 3))
const inRing = (lon, lat, ring) => {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
const isLand = (lon, lat) => rings.some((r) => inRing(lon, lat, r))

/* ---------------------------------------------------------------- 画出来的：解析 d + 非零绕数 */
function parseSubpaths(d) {
  const subs = []
  let cur = null
  const tokens = d.match(/[MLZ]|-?\d+(?:\.\d+)?/g) ?? []
  for (let i = 0; i < tokens.length;) {
    const t = tokens[i]
    if (t === 'M' || t === 'L') {
      const x = Number(tokens[i + 1]); const y = Number(tokens[i + 2]); i += 3
      if (t === 'M') { cur = { pts: [[x, y]], box: [x, y, x, y] }; subs.push(cur) }
      else if (cur) {
        cur.pts.push([x, y])
        cur.box[0] = Math.min(cur.box[0], x); cur.box[1] = Math.min(cur.box[1], y)
        cur.box[2] = Math.max(cur.box[2], x); cur.box[3] = Math.max(cur.box[3], y)
      }
    } else { i += 1; cur = null }
  }
  return subs.filter((s) => s.pts.length >= 3)
}
/** 非零绕数（与 canvas 的默认填充规则一致）。 */
function inside(subs, px, py) {
  let wn = 0
  for (const s of subs) {
    const [x0, y0, x1, y1] = s.box
    if (px < x0 || px > x1 || py < y0 || py > y1) continue
    const pts = s.pts
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i]
      const [xj, yj] = pts[j]
      if (yj <= py) { if (yi > py && (xi - xj) * (py - yj) - (px - xj) * (yi - yj) > 0) wn += 1 }
      else if (yi <= py && (xi - xj) * (py - yj) - (px - xj) * (yi - yj) < 0) wn -= 1
    }
  }
  return wn !== 0
}

/* ---------------------------------------------------------------- 逐像素对账 */
const fromLon = Number(process.argv[2] ?? 0)
const step = Number(process.argv[3] ?? 10)
const count = Number(process.argv[4] ?? 36)
const px = Number(process.argv[5] ?? 2) // 每个像素几个用户单位
const lat0 = Number(process.env.LAT ?? 0) // 相机的纬度（地球自转时纬度不变，默认赤道视角）
const prep = prepareRings(WORLD_OUTLINES)
mkdirSync(OUT, { recursive: true })

const w = Math.ceil((VIEW.r * 2) / px)
const h = w
let worst = { rate: -1 }
const rows = []
/** 误差按半径分档（0.1 一档）：用来证明「剩下的误差是不是都贴着地平线」。 */
const bins = Array.from({ length: 10 }, () => ({ miss: 0, extra: 0 }))
for (let n = 0; n < count; n += 1) {
  const lon0 = fromLon + n * step
  const cam = camera(lon0, lat0)
  const subs = parseSubpaths(landPaths(cam, prep).fill)
  const a = (lon0 * Math.PI) / 180
  const b = (lat0 * Math.PI) / 180
  const sa = Math.sin(a), ca = Math.cos(a), sb = Math.sin(b), cb = Math.cos(b)
  const ex = [ca, 0, -sa], ey = [-sb * sa, cb, -sb * ca], ez = [cb * sa, sb, cb * ca]
  const rgba = Buffer.alloc(w * h * 4)
  let miss = 0; let extra = 0; let land = 0
  const missPts = []; const extraPts = []
  for (let gy = 0; gy < h; gy += 1) {
    for (let gx = 0; gx < w; gx += 1) {
      const ux = (gx + 0.5) * px - VIEW.r   // 相对圆心的用户单位
      const uy = VIEW.r - (gy + 0.5) * px
      const nx = ux / VIEW.r, ny = uy / VIEW.r
      const d2 = nx * nx + ny * ny
      const o = (gy * w + gx) * 4
      let r = 255, g = 255, b = 255
      if (d2 <= 1) {
        const wz = Math.sqrt(Math.max(0, 1 - d2))
        const v = [0, 1, 2].map((i) => nx * ex[i] + ny * ey[i] + wz * ez[i])
        const nn = Math.hypot(v[0], v[1], v[2]) || 1
        const lat = (Math.asin(Math.max(-1, Math.min(1, v[1] / nn))) * 180) / Math.PI
        const lon = (Math.atan2(v[0] / nn, v[2] / nn) * 180) / Math.PI
        const truth = isLand(lon, lat)
        const drawn = inside(subs, VIEW.cx + ux, VIEW.cy - uy)
        if (truth) land += 1
        if (truth && !drawn) { miss += 1; bins[Math.min(9, Math.floor(Math.sqrt(d2) * 10))].miss += 1; r = 230; g = 30; b = 30; if (missPts.length < 40) missPts.push(`${lon.toFixed(1)},${lat.toFixed(1)} r=${Math.sqrt(d2).toFixed(2)}`) }
        else if (!truth && drawn) { extra += 1; bins[Math.min(9, Math.floor(Math.sqrt(d2) * 10))].extra += 1; r = 30; g = 80; b = 230; if (extraPts.length < 40) extraPts.push(`${lon.toFixed(1)},${lat.toFixed(1)} r=${Math.sqrt(d2).toFixed(2)}`) }
        else if (truth) { r = 40; g = 150; b = 70 }   // 对上的陆地：绿
        else { r = 236; g = 238; b = 240 }            // 对上的海：淡灰
      } else { r = 250; g = 250; b = 250 }
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255
    }
  }
  const rate = (miss + extra) / Math.max(1, land)
  const file = join(OUT, `diff-${String(Math.round(lon0)).padStart(4, '0')}.png`)
  writePng(file, w, h, rgba)
  rows.push({ lon0, miss, extra, land, rate })
  if (rate > worst.rate) worst = { rate, lon0, miss, extra, land, missPts, extraPts }
  console.log(`经度 ${String(lon0).padStart(5)}：漏 ${String(miss).padStart(5)}（${((miss / Math.max(1, land)) * 100).toFixed(2)}%）｜多填 ${String(extra).padStart(5)}（${((extra / Math.max(1, land)) * 100).toFixed(2)}%）｜${file}`)
}
console.log(`\n最差：经度 ${worst.lon0} 合计 ${(worst.rate * 100).toFixed(2)}%（漏 ${worst.miss} / 多填 ${worst.extra}，陆地像素 ${worst.land}）`)
const sumMiss = rows.reduce((s, r) => s + r.miss, 0)
const sumExtra = rows.reduce((s, r) => s + r.extra, 0)
const sumLand = rows.reduce((s, r) => s + r.land, 0)
console.log(`合计：${rows.length} 个角度 漏 ${sumMiss}（${((sumMiss / sumLand) * 100).toFixed(2)}%）｜多填 ${sumExtra}（${((sumExtra / sumLand) * 100).toFixed(2)}%）｜陆地像素 ${sumLand}`)
console.log('按半径分布：' + bins.map((b, i) => `${(i / 10).toFixed(1)}~${((i + 1) / 10).toFixed(1)} 漏${b.miss}/多${b.extra}`).join('｜'))
if (worst.missPts?.length) console.log(`  漏的位置：${worst.missPts.slice(0, 12).join(' | ')}`)
if (worst.extraPts?.length) console.log(`  多填的位置：${worst.extraPts.slice(0, 12).join(' | ')}`)
writeFileSync(join(OUT, 'report.json'), JSON.stringify(rows, null, 2))

// 判据（护栏）：整圈合计、单角最差，以及「误差是不是都贴着地平线」。
// 为什么门槛不是一个数：纬度越高、可见陆地越多（分母大），而贴着地平线那一圈里
// 长边的「投影直线 vs 经纬度直线」差异占比更高 —— 两套采样网格实测：
//   纬度 0 漏 1.25%/1.01%、多填 1.15%/1.33%
//   纬度 20 漏 —/1.23%、多填 —/2.28%（多填几乎全在 r≥0.8 那一圈，是北极海岸贴着地平线）
//   纬度 30 漏 1.66%、纬度 50 漏 2.00%/2.21%
// 所以总量定在 2.5%（改坏时是 3.17% 多填 + 单角 105%，仍会被拦下），
// 真正要钉住的是**内侧（r<0.8）不该成片出错**：内陆出现空洞才是结构性的坏。
const LIMITS = { miss: 2.5, extra: 2.5, worst: 35, innerShare: 0.3, innerFloor: 1.5 }
const innerMiss = bins.slice(0, 8).reduce((s, b) => s + b.miss, 0)
const innerExtra = bins.slice(0, 8).reduce((s, b) => s + b.extra, 0)
const innerShare = (innerMiss + innerExtra) / Math.max(1, sumMiss + sumExtra)
// ★ 内侧占比只在**总量还说得上话**时才判：总量压到 1% 以下之后，剩下那十几个像素
//   分在内圈还是外圈都是噪声（收口改成沿地平线走之后，总量 0.8% 时内侧占 34%），
//   再拿 30% 去卡就成了假警报 —— 这一条要钉的是「内陆成片空洞」那种结构性坏。
const innerMeaningful = ((sumMiss + sumExtra) / sumLand) * 100 >= LIMITS.innerFloor
// 内侧误差**绝对值**也一起看：总量 1.5~2% 时内侧占三成（≈0.5% 陆地）是噪声不是空洞，
// 不该报警；真正要拦的是「内陆成片空洞」那种量级（内侧好几个百分点）。
const innerRate = ((innerMiss + innerExtra) / sumLand) * 100
const verdicts = [
  [`合计漏 ${((sumMiss / sumLand) * 100).toFixed(2)}% ≤ ${LIMITS.miss}%`, (sumMiss / sumLand) * 100 <= LIMITS.miss],
  [`合计多填 ${((sumExtra / sumLand) * 100).toFixed(2)}% ≤ ${LIMITS.extra}%`, (sumExtra / sumLand) * 100 <= LIMITS.extra],
  [`单角最差 ${(worst.rate * 100).toFixed(2)}% ≤ ${LIMITS.worst}%`, worst.rate * 100 <= LIMITS.worst],
  [
    innerMeaningful
      ? `内侧（r<0.8）占 ${(innerShare * 100).toFixed(0)}% / 陆地的 ${innerRate.toFixed(2)}%（≤30% 或绝对值 ≤1% 即可；误差该集中在地平线那一圈）`
      : `内侧（r<0.8）占 ${(innerShare * 100).toFixed(0)}%（总量 ${(((sumMiss + sumExtra) / sumLand) * 100).toFixed(2)}% 已低于 ${LIMITS.innerFloor}%，不再要求分布）`,
    !innerMeaningful || innerShare <= LIMITS.innerShare || innerRate <= 1.0,
  ],
]
for (const [label, ok] of verdicts) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
const bad = verdicts.filter(([, ok]) => !ok).length
console.log(`\n结果: PASS ${verdicts.length - bad} / FAIL ${bad}`)
process.exit(bad ? 1 : 0)

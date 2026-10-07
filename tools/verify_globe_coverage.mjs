// 地球「整盘被填成陆地」的广域哨兵（比逐像素对账快三个数量级，所以能扫几千个视角）。
//
// 为什么需要它：tools/globe-diff-image.mjs 只按给定的纬度扫一圈经度，**换一组纬度就是新视角**，
// 实测 204°E/50°N、240°E/30°N、48°E/−30°N 这几处收口会绕圆盘一整圈（子路径面积 27529，
// 圆盘才 26590）—— 站长截图里「整个地球都是陆地」就是它，而它**不在这套对账扫过的那几条纬线上**。
//
// 两条判据（都是视角无关的硬指标）：
//   ① 任何一条子路径的 |有符号面积| 不得超过圆盘面积的一半 —— 正常陆地的可见部分实测最大
//      9211（35%，欧亚大陆），出错时是 27529（104%）。这条能直接抓住「绕一圈」的收口。
//   ② 抽查 60 个盘内点：真值（经纬度射线法）与填充路径的判定一致率 ≥ 80% —— 抓「某一块整片
//      填错/漏画」这类粗错（细到贴地平线那一圈的误差交给逐像素对账）。
//
// 用法：node tools/verify_globe_coverage.mjs [经度步长=5] [纬度步长=5]
import { camera, landPaths, prepareRings, VIEW } from '../src/lib/globe.ts'
import { WORLD_OUTLINES } from '../src/lib/world.ts'

const prep = prepareRings(WORLD_OUTLINES)
const rings = WORLD_OUTLINES.filter((r) => r && r.length >= 3)
const DISK = Math.PI * VIEW.r * VIEW.r
const num = (s) => (String(s).match(/-?\d+(\.\d+)?/g) || []).map(Number)

const inRing = (lon, lat, ring) => {
  let c = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}
const isLand = (lon, lat) => rings.some((r) => inRing(lon, lat, r))

/** 非零绕数（与浏览器默认填充规则一致）。 */
const winding = (pts, x, y) => {
  let w = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]
    const [xj, yj] = pts[j]
    if (yi <= y) { if (yj > y && (xj - xi) * (y - yi) - (x - xi) * (yj - yi) > 0) w += 1 }
    else if (yj <= y && (xj - xi) * (y - yi) - (x - xi) * (yj - yi) < 0) w -= 1
  }
  return w
}

const lonStep = Number(process.argv[2] ?? 5)
const latStep = Number(process.argv[3] ?? 5)
let views = 0, pass = 0, fail = 0
const bad = []
let worstArea = 0, worstAt = ''
let worstAgree = 1, worstAgreeAt = ''

// 抽查点：盘内按六边形网格撒 60 个（半径分三档，覆盖内外圈）
const probes = []
for (let ring = 1; ring <= 3; ring++) {
  const rr = (ring / 3.5) * VIEW.r
  const n = 20
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + ring * 0.7
    probes.push([VIEW.cx + rr * Math.cos(a), VIEW.cy + rr * Math.sin(a)])
  }
}

for (let lat = -80; lat <= 80; lat += latStep) {
  for (let lon = 0; lon < 360; lon += lonStep) {
    views++
    const cam = camera(lon, lat)
    const { fill } = landPaths(cam, prep)
    const subs = fill.split('M').slice(1).map((c) => {
      const n = num(c)
      const p = []
      for (let i = 0; i + 1 < n.length; i += 2) p.push([n[i], n[i + 1]])
      return p
    })
    // ① 子路径面积
    let maxArea = 0
    for (const p of subs) {
      let a = 0
      for (let i = 0; i < p.length; i += 1) {
        const [x1, y1] = p[i]
        const [x2, y2] = p[(i + 1) % p.length]
        a += x1 * y2 - x2 * y1
      }
      maxArea = Math.max(maxArea, Math.abs(a / 2))
    }
    if (maxArea > worstArea) { worstArea = maxArea; worstAt = `${lon}°E ${lat}°N` }
    const okArea = maxArea <= DISK * 0.5
    // ② 抽查点一致率
    let agree = 0
    for (const [x, y] of probes) {
      const ll = cam.lonLat({ x, y, k: 0 })
      const t = isLand(ll[0], ll[1])
      const drawn = subs.some((p) => winding(p, x, y) !== 0)
      if (t === drawn) agree++
    }
    const rate = agree / probes.length
    if (rate < worstAgree) { worstAgree = rate; worstAgreeAt = `${lon}°E ${lat}°N` }
    const okProbe = rate >= 0.8
    if (okArea && okProbe) pass++
    else {
      fail++
      if (bad.length < 8) bad.push(`${lon}°E ${lat}°N：面积 ${Math.round(maxArea)}（上限 ${Math.round(DISK * 0.5)}）｜抽查一致 ${(rate * 100).toFixed(0)}%`)
    }
  }
}

console.log(`扫描 ${views} 个视角（经度步长 ${lonStep}°、纬度步长 ${latStep}°）`)
console.log(`  最大子路径面积 ${Math.round(worstArea)} / 圆盘 ${Math.round(DISK)}（${((worstArea / DISK) * 100).toFixed(0)}%）@ ${worstAt}`)
console.log(`  抽查一致率最低 ${(worstAgree * 100).toFixed(0)}% @ ${worstAgreeAt}`)
for (const b of bad) console.log(`  ✗ ${b}`)
console.log(`${fail === 0 ? 'PASS' : 'FAIL'}  子路径不绕盘（≤50% 圆盘）且抽查一致率 ≥80%：${pass} 个视角通过 / ${fail} 个失败`)
process.exit(fail === 0 ? 0 : 1)

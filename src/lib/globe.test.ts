// 地球那一套几何的护栏。`npm test` 会跑它（Node 自己剥类型，不需要任何测试框架）。
//
// 这里最要紧的一条是 **①「向量化的投影 == 上游那个公式」**：为了省掉每点每帧的三角函数，
// 我把点先落成单位向量、再乘一组基向量 —— 这是纯数学改写，如果哪天改错了（基向量抄反、
// 经度符号、`y` 的上下），地球会整个镜像或者翻转，而看截图不一定看得出来。
// 所以测试里把上游那两行公式**原样**再写一遍，逐点比对。
import {
  camera, cityHint, clampLat, curvePath, globeCaption, globeNodes, globeProfile, graticule, inkWidth, landPaths, mergeRegion,
  layoutLabels, links, prepareRings, regionOf, regionRows, regionView, sweepLonAt, sweepOpacity, trimLabel, VIEW, wrapLon,
} from "./globe.ts"
import { COARSE_WORLD_OUTLINES, COUNTRY_LL, WORLD_OUTLINES } from "./world.ts"
import type { Node } from "./api.ts"

let failed = 0
function eq(got: unknown, want: unknown, what: string) {
  const [a, b] = [JSON.stringify(got), JSON.stringify(want)]
  if (a !== b) {
    failed++
    console.error(`✗ ${what}\n    得到 ${a}\n    期望 ${b}`)
  }
}
function ok(cond: boolean, what: string) {
  if (!cond) {
    failed++
    console.error(`✗ ${what}`)
  }
}

const node = (id: number, name: string, country: string, extra: Partial<Node> = {}): Node =>
  ({ id, name, country, group: "", online: true, ...extra }) as Node

/* ---------------------------------------------------------------- 经度与档位 */

eq(wrapLon(0), 0, "wrapLon(0)")
eq(wrapLon(179.9), 179.9, "wrapLon 不折西经（且不引入浮点尾数）")
eq(wrapLon(180), -180, "wrapLon(180) 折到 -180（半圈是开的）")
eq(wrapLon(-180), -180, "wrapLon(-180)")
eq(wrapLon(190), -170, "wrapLon(190) 往回绕")
eq(wrapLon(-190), 170, "wrapLon(-190)")
eq(wrapLon(80 + 360 * 3), 80, "转三圈回到原地")
ok(Math.abs(wrapLon(wrapLon(-725.4)) + 5.4) < 1e-9, "自转千万圈也不会漂（误差不累积）")

eq(clampLat(-90), -78, "纬度下限")
eq(clampLat(90), 78, "纬度上限")
eq(clampLat(30.5), 30.5, "纬度区间内原样")

eq(globeProfile("LOW").key, "low", "档位大小写不敏感")
eq(globeProfile("").key, "medium", "空值回落 medium")
eq(globeProfile("超高").key, "medium", "认不出的档位回落 medium（不是 high）")
eq(globeProfile("high").sweepCount, 4, "high 有四条扫掠经线")
eq(globeProfile("low").land, "coarse", "low 用粗岸线")
eq(globeProfile("low").linkMode, 0, "low 不画节点连线")
ok(globeProfile("low").idleMs > globeProfile("high").idleMs, "档位越低重画越慢（省电）")

/* ---------------------------------------------------------------- 投影 */

const C = camera(0, 0)
const center = C.at(0, 0)
ok(center !== null && Math.abs((center?.x ?? 0) - VIEW.cx) < 1e-9 && Math.abs((center?.y ?? 0) - VIEW.cy) < 1e-9, "视角中心投影到画布中心")
eq(C.at(180, 0), null, "反面（对跖点）不画")
eq(C.at(90, 0), null, "正好 90° 的点在边缘上，不画（阈值 0.02）")
ok(C.at(80, 0) !== null, "80° 仍在正面")
ok(C.at(0, 89) === null, "极点外（89°）在边缘之外")

// 北在上：中心的北面那点 y 更小；东在右：东经那点 x 更大。
const north = camera(0, 0).at(0, 60)
const east = camera(0, 0).at(60, 0)
ok((north?.y ?? 1e9) < VIEW.cy, "北在上（y 小于圆心）")
ok((east?.x ?? -1e9) > VIEW.cx, "东在右（x 大于圆心）")

// 视角移到东经 120°，那里的点应当落在圆心。
const hem = camera(120, 30).at(120, 30)
ok(hem !== null && Math.abs((hem?.x ?? 0) - VIEW.cx) < 1e-6 && Math.abs((hem?.y ?? 0) - VIEW.cy) < 1e-6, "换视角后该视角的中心仍落在圆心")
eq(camera(120, 30).at(-60, -30), null, "换视角后旧中心转到反面")

/**
 * ① 向量化投影 vs 上游公式：拿真实岸线上的每一个点，逐个比对。
 * 上游（它的 `js/app.js` 的 `ortho`）：
 *   cosc = sin(lat0)sin(lat) + cos(lat0)cos(lat)cos(lon-lon0)
 *   x = cx + R·cos(lat)·sin(lon-lon0)
 *   y = cy − R·(cos(lat0)·sin(lat) − sin(lat0)·cos(lat)·cos(lon-lon0))
 */
function upstreamOrtho(lon0: number, lat0: number, lon: number, lat: number) {
  const l = (lon * Math.PI) / 180
  const p = (lat * Math.PI) / 180
  const l0 = (lon0 * Math.PI) / 180
  const p0 = (lat0 * Math.PI) / 180
  const cosc = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(l - l0)
  if (cosc <= 0.02) return null
  return {
    x: VIEW.cx + VIEW.r * Math.cos(p) * Math.sin(l - l0),
    y: VIEW.cy - VIEW.r * (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(l - l0)),
  }
}
let compared = 0
for (const view of [[80, 30], [-140, -45], [0, 0], [179, 78], [-33.3, 12.7]] as const) {
  const cam = camera(view[0], view[1])
  for (const ring of WORLD_OUTLINES) {
    for (const [lon, lat] of ring) {
      const mine = cam.at(lon, lat)
      const theirs = upstreamOrtho(view[0], view[1], lon, lat)
      compared++
      if ((mine === null) !== (theirs === null)) {
        failed++
        console.error(`✗ 可见性不一致 @${view} ${lon},${lat}：我 ${mine} / 上游 ${theirs}`)
        break
      }
      if (mine && theirs) {
        if (Math.abs(mine.x - theirs.x) > 1e-9 || Math.abs(mine.y - theirs.y) > 1e-9) {
          failed++
          console.error(`✗ 投影不一致 @${view} ${lon},${lat}：${mine.x},${mine.y} vs ${theirs.x},${theirs.y}`)
          break
        }
      }
    }
  }
}
ok(compared > 7000, `真的比对了 5 个视角 × 全部岸线点（实际 ${compared} 次）`)

/* ---------------------------------------------------------------- 岸线路径 */

const cam = camera(80, 30)
const prep = prepareRings(WORLD_OUTLINES)
const land = landPaths(cam, prep)
ok(land.fill.length > 2000, "岸线填充路径非空")
ok(land.stroke.length > 2000, "岸线描边路径非空")
ok(land.fill.includes("Z"), "填充那份每一段都闭合（Z）")
ok(!land.stroke.includes("Z"), "描边那份不闭合")
ok((land.fill.match(/Z/g) ?? []).length >= 1 && (land.fill.match(/Z/g) ?? []).length <= (land.fill.match(/M /g) ?? []).length, "填充那份有闭合（Z 不比分段多）")
eq((land.fill.match(/M /g) ?? []).length, (land.stroke.match(/M /g) ?? []).length, "填充与描边是同一批子路径")

// 抽出的每个坐标都必须落在圆盘里 —— 落在背面的点没被丢掉的话，这里立刻抓到。
const coords = [...land.stroke.matchAll(/(-?\d+\.\d) (-?\d+\.\d)/g)].map((m) => [Number(m[1]), Number(m[2])])
ok(coords.length > 400, `描边路径里有坐标（${coords.length} 个）`)
const outside = coords.filter(([x, y]) => Math.hypot(x - VIEW.cx, y - VIEW.cy) > VIEW.r + 0.05)
eq(outside.length, 0, "岸线不越出圆盘（背面的大陆没翻到正面）")

// 岸线**不做抽稀**：这套数据本身已经稀疏（79 环 1483 点），做减法会抹掉半岛与海湾
// （实测过：medium 档 5.5% 的陆地该画没画、5.0% 的海被填成陆地 —— 用户报的「陆地残缺」）。
// 逐点比对「该是陆地 / 画出来是不是陆地」的判据在 tools/verify_globe_land.mjs 里。
const rawPoints = WORLD_OUTLINES.reduce((n, r) => n + (r?.length ?? 0), 0)
eq(prep.vec.length, rawPoints * 3, "每个环都原样进来（不抽稀）")
eq(prep.offsets.length, WORLD_OUTLINES.length + 1, "环数一个不少")
// 短环（十几点的小岛）当然也在。
eq(prepareRings(COARSE_WORLD_OUTLINES).offsets.length, COARSE_WORLD_OUTLINES.length + 1, "粗岸线的每个环都还在")

/* ---------------------------------------------------------------- 经纬网 */

const medium = globeProfile("medium")
const wires = graticule(cam, medium, sweepLonAt(1_700_000_000_000))
ok(wires.length > 10, `经纬网画出了线（${wires.length} 条）`)
eq(graticule(cam, medium, null).filter((w) => w.sweep >= 0).length, 0, "sweepLon 为 null 时不画扫掠")
eq(graticule(cam, medium, 0).filter((w) => w.sweep >= 0).length, medium.sweepCount, "扫掠经线的条数 == 档位设定")
eq(graticule(cam, globeProfile("low"), 0).filter((w) => w.sweep >= 0).length, 0, "low 档没有扫掠")
eq(graticule(cam, medium, 0).filter((w) => w.width === 1.15).length, 1, "赤道只加粗一条")
ok(graticule(cam, medium, 0).every((w) => w.d.length > 0), "没有空的路径")
eq(curvePath(cam, { lon: 80, lat: null }, -80, 80, 7).split("M").length - 1, 1, "正对镜头的经线是一段")
ok((curvePath(cam, { lon: -100, lat: null }, -80, 80, 7).match(/M/g) ?? []).length >= 0, "背面经线不会抛错")

eq(sweepLonAt(0), -180, "扫掠从 -180 起步")
ok(sweepLonAt(28 * 90) > -180 && sweepLonAt(28 * 90) < 180, "扫掠在范围内")
eq(sweepLonAt(28 * 360), sweepLonAt(0), "扫掠 10 秒一圈")
ok(sweepOpacity(true, 0) < sweepOpacity(false, 0), "亮色底上扫掠更实一点")
ok(sweepOpacity(true, 2) < sweepOpacity(true, 0), "越靠后的扫掠越淡")

/* ---------------------------------------------------------------- 节点落点与地区 */

eq(cityHint(node(1, "阿里 广州", "CN"))?.name, "Guangzhou", "中文城名认得出")
eq(cityHint(node(2, "Lightlayer SJC", "US"))?.name, "San Jose", "机场码认得出")
eq(cityHint(node(3, "华纳云 JP", "JP")), null, "认不出城市就返回 null（交给国家落点）")
eq(cityHint(node(4, "魏武王", "CN", { group: "香港" }))?.name, "Hong Kong", "分组名也参与匹配（站点常用的地方）")

eq(regionOf(node(1, "阿里 广州", "CN")), { key: "CN · Guangzhou", code: "CN", city: "Guangzhou", label: "Guangzhou", base: [113.2644, 23.1291] }, "国家码 + 城名 = 地区键（城名线索优先于国家落点）")
eq(regionOf(node(2, "Nobrand Traffic Bug", "jp"))?.key, "JP · Japan", "认不出城市 → 国家级兜底城名（日本 → Japan），国家码大小写归一")
eq(regionOf(node(2, "Nobrand Traffic Bug", "de"))?.key, "DE", "没有兜底城名的国家，认不出城市就是国家码（也验大小写归一）")
eq(regionOf(node(3, "无名", "")), null, "没有国家码的节点不上地球")
eq(regionOf(node(4, "某地", "XA")), null, "国家码不在表里、又认不出城市 → 不上地球")
ok(regionOf(node(5, "纳泰-DE9929", "DE")) !== null, "表里有 DE")

// ★ 有意与上游不同：HK/TW 照实写，不并进 CN。
eq(regionOf(node(6, "野草云", "HK"))?.code, "HK", "HK 保持 HK（上游会写成 CN）")
eq(regionOf(node(6, "白猫", "TW"))?.code, "TW", "TW 保持 TW（上游会写成 CN）")
eq(COUNTRY_LL.HK[0], 114.2, "国家落点表原样（HK）")

// ★ 上游 `fallbackCity` 的国家级兜底城名（移植时漏过的那层，站长截图里 HK 裂成两行的根因）：
//   名字里认不出城市时，这几个国家照样有城名；其余国家退到国家码。
eq(regionOf(node(20, "野草云", "HK"))?.key, "HK · Hong Kong", "HK 认不出城市也落 Hong Kong（上游无条件兜底）")
eq(regionOf(node(21, "华纳云 HK", "HK"))?.key, "HK · Hong Kong", "HK 名字里写着 HK → 同一个地区键（不再分成两行）")
eq(regionOf(node(22, "幽灵机", "SG"))?.key, "SG · Singapore", "SG 认不出城市也落 Singapore")
eq(regionOf(node(23, "幽灵机二", "TW"))?.key, "TW · Taiwan", "TW 认不出城市落 Taiwan（名字里认得出 Taipei/Taichung 时仍按城名）")
eq(regionOf(node(24, "幽灵机三", "JP"))?.key, "JP · Japan", "JP 认不出城市落 Japan")
eq(regionOf(node(25, "幽灵机四", "KR"))?.key, "KR · Korea", "KR 认不出城市落 Korea")
eq(regionOf(node(26, "阿里 西雅图", "US"))?.key, "US · Seattle", "兜底不影响城市线索（US 照旧认西雅图）")
eq(regionOf(node(27, "幽灵机五", "US"))?.key, "US", "没有兜底的国家照旧退国家码（US）")

// ★ 2026-10 数据扩展：国家表 12 → 80+、城市线索 24 → ~100（第三方的大机群以前大半
//   认不出城市、全堆在国家码下；表外国家的机器干脆整个地区功能里看不见）。
eq(cityHint(node(28, "示例 Ashburn", "US"))?.name, "Ashburn", "新补的美国城市线索（阿什本）认得出")
eq(regionOf(node(28, "示例 Ashburn", "US"))?.key, "US · Ashburn", "新线索进地区键（不再落裸的 US）")
eq(regionOf(node(29, "某台机器", "RU"))?.key, "RU", "表外国家扩进来了（RU 现在上地球、进地区列表）")
eq(regionOf(node(30, "某台机器二", "ZA"))?.key, "ZA", "同上（ZA）")
ok(Object.keys(COUNTRY_LL).length >= 80, `国家表已覆盖常见 IDC 国家（${Object.keys(COUNTRY_LL).length} 国）`)
ok(regionOf(node(31, "莫斯科一号", "RU"))?.key === "RU · Moscow", "莫斯科这类新城市线索也按城市落")

const fleet = [
  node(1, "腾讯 SH", "CN"),
  node(2, "阿里 广州", "CN"),
  node(3, "野草云", "HK"),
  node(4, "华纳云 HK", "HK"),
  node(5, "Nobrand Traffic Bug", "JP"),
  node(6, "华纳云 JP", "JP"),
  node(7, "LegendVPS JP", "JP"),
  node(8, "腾讯 JP", "JP"),
  node(9, "阿里 首尔", "KR"),
  node(10, "无国界的机器", ""),
]

const placed = globeNodes(fleet)
// ★合并门槛：**整队 ≥30 台，或同一个地区 ≥5 台**（「或」）。这份夹具是 10 台、JP 4 台 ——
//   两条都不满足，所以**不合并**：一台一枚针，同地区的按角度岔开。
eq(mergeRegion(10, 4), false, "10 台、同地区 4 台 → 不合并")
eq(mergeRegion(10, 5), true, "同地区到 5 台 → 合并")
eq(mergeRegion(30, 2), true, "整队到 30 台 → 合并（哪怕这个地区只有 2 台）")
eq(placed.length, 9, "不合并：9 台有落点的机器各一枚针")
eq(placed.map((p) => p.key), ["1", "2", "3", "4", "5", "6", "7", "8", "9"], "顺序与节点列表一致（连线抽样要靠 index）")
eq(placed.every((p) => p.count === 1), true, "不合并时针上没有台数")
// JP 那 4 台必须岔开：坐标两两不同，且都在落点附近（不是随便乱扔）。
const jp = placed.filter((p) => p.region.key === "JP · Japan")
eq(new Set(jp.map((p) => p.ll.join(","))).size, 4, "同地区 4 台岔开（一枚不盖住另一枚）")
ok(jp.every((p) => Math.abs(p.ll[0] - p.region.base[0]) < 6 && Math.abs(p.ll[1] - p.region.base[1]) < 6), "岔开的点都在落点附近")
eq(globeNodes(fleet).map((p) => p.ll), placed.map((p) => p.ll), "同一份节点算两次，落点完全一样（不会每帧抖）")

// 同地区到 5 台 → 聚成一枚针：台数 5、标签「Japan ×5」、落在地区中心。
const five = globeNodes([...fleet, node(11, "第五台 JP", "JP")])
const jpMerged = five.filter((p) => p.region.key === "JP · Japan")
eq(jpMerged.length, 1, "同地区到 5 台 → 只出一枚针")
eq(jpMerged.map((p) => p.count), [5], "那枚针上写着 5 台")
eq(jpMerged.map((p) => p.name), ["Japan ×5"], "多台的针标签是「地区 × 台数」")
eq(jpMerged[0].ll, regionRows(fleet).find((r) => r.region.key === "JP · Japan")?.aim, "合并的针落在地区中心")
eq(five.filter((p) => p.region.key === "CN").map((p) => p.count), [1], "没到门槛的地区照旧一台一枚")
// 有一台离线，那枚针就按离线画（不能被「多数在线」盖过去）。
const jpOffline = globeNodes([...fleet, node(11, "第五台 JP", "JP")].map((n) => (n.id === 7 ? { ...n, online: false } : n)))
eq(jpOffline.find((p) => p.region.key === "JP · Japan")?.online, false, "合并的那枚针：地区里有一台离线就按离线画")
eq(jpOffline.find((p) => p.region.key === "CN")?.online, true, "别的地区不受影响")

const rows = regionRows(fleet)
// ★ 一个 HK 只有一行：名字里写着 HK 的（`华纳云 HK`）与没写的（`野草云`）都落 `HK · Hong Kong`
//   —— 上游 `fallbackCity` 的兜底城名。漏掉它就会并排出现「HK」与「HK · Hong Kong」两行
//   （同一面旗、同一个地方两行，站长截图里就是它）。四个 JP 名字里都没有城市线索，
//   也一起落 `JP · Japan`（旧版这里会显示裸的「JP」）。
eq(rows.map((r) => [r.region.key, r.count]), [["JP · Japan", 4], ["HK · Hong Kong", 2], ["CN", 1], ["CN · Guangzhou", 1], ["KR · Seoul", 1]], "地区分桶与台数（按台数从多到少）")
eq(rows.reduce((sum, r) => sum + r.count, 0), 9, "各地区台数合计 = 有落点的机器数")
// ★ 地区行也把离线台数带出来：列表里才看得见哪个地区有机器离线（行上那枚小点用它）。
eq(rows.find((r) => r.region.key === "JP · Japan")?.offline, 0, "全在线的地区离线台数为 0")
const offlineRows = regionRows(fleet.map((n) => (n.id === 7 ? { ...n, online: false } : n)))
eq(offlineRows.find((r) => r.region.key === "JP · Japan")?.offline, 1, "有离线的地区统计得出来（JP 那行 1 台）")
eq(offlineRows.find((r) => r.region.key === "HK · Hong Kong")?.offline, 0, "别的地区不受影响")

const rv = regionView(fleet, "JP · Japan")
eq(rv.shown.map((n) => n.id), [5, 6, 7, 8], "按地区筛选只留下该地区的机器")
eq(rv.current, "JP · Japan", "选中的地区是有效的")
eq(regionView(fleet, "不存在的地区").current, null, "悬空的选中态回落「全部」")
eq(regionView(fleet, "不存在的地区").shown.length, 10, "回落时列表仍然是全部（含没落点的机器）")
eq(regionView(fleet, null).shown.length, 10, "没选地区 = 全部")
eq(regionView([], "JP").current, null, "没有节点时不存在悬空选中")

/* ---------------------------------------------------------------- 标签排布 */

const sides = new Map<string, "L" | "R">()
const laid = layoutLabels(cam, placed, sides)
eq(laid.length, 9, "9 枚针都排上了标签")
ok(laid.every((p) => Math.abs(p.lx - VIEW.cx) > VIEW.r), "两摞标签都在圆盘之外（不压在地球上）")
ok(laid.every((p) => p.ly >= 12 && p.ly <= 204), "标签不出画布上下边")
ok(laid.every((p) => p.end === (p.lx < VIEW.cx)), "左侧标签右对齐、右侧标签左对齐")
for (const side of ["L", "R"] as const) {
  const ys = laid.filter((p) => (side === "L") === p.end).map((p) => p.ly)
  eq(new Set(ys).size, ys.length, `${side} 侧没有两行标签压在同一条线上`)
}
const counts = [laid.filter((p) => p.end).length, laid.filter((p) => !p.end).length]
ok(Math.abs(counts[0] - counts[1]) <= 2, `左右两摞数量均衡（${counts[0]} / ${counts[1]}）`)
eq(sides.size, 9, "每枚针的左右侧都被记下来了（下一帧不会左右跳）")
// 左侧写「名字 · 国家」，右侧写「国家 · 名字」—— 上游如此，两侧都从外侧往内读。
const left = laid.find((p) => p.end)
const right = laid.find((p) => !p.end)
eq(left?.label, `${left?.name} · ${left?.code}`, "左侧标签是「名字 · 国家」")
eq(right?.label, `${right?.code} · ${right?.name}`, "右侧标签是「国家 · 名字」")
const laidRef = laid

// 投影不到的机器（在背面）不出现，也不留下标签。
const backside = layoutLabels(camera(-100, -40), placed, new Map())
ok(backside.length < laid.length, "背面视角下标签变少（落到背面的机器不画）")
ok(backside.every((p) => camera(-100, -40).at(p.ll[0], p.ll[1]) !== null), "留下的每一枚针都真的在正面")

// 截断：宽屏上"放得下"是很大的数（两侧的空白都算），一个字都不动；窄屏上按实际余量截，
// 截出来的那一行连省略号一起都还在余量之内（否则截完还是被视口裁掉，等于白截）。
eq(trimLabel("Demo Node Frankfurt · DE", Number.POSITIVE_INFINITY), "Demo Node Frankfurt · DE", "余量无限时一个字都不动")
eq(trimLabel("短", 200), "短", "放得下就不截")
const tight = trimLabel("JP · Example Tokyo Datacenter Gen 2", 120)
ok(tight.endsWith("…") && tight.length < "JP · Example Tokyo Datacenter Gen 2".length, `超长的要截：${tight}`)
ok(inkWidth(tight) <= 120, `截完必须真的放得下（${inkWidth(tight).toFixed(1)} ≤ 120）`)
eq(inkWidth("abcd"), labelWidthOf4(), "inkWidth = 那份估法 × 1.18（保守一档）")
function labelWidthOf4() { return (5.05 * 4 + 2) * 1.18 }

// 同一份节点、给定很小的余量：每一行都截到余量之内，位置排布不受影响。
const tightlaid = layoutLabels(cam, placed, new Map(), 100)
ok(tightlaid.every((p) => inkWidth(p.label) <= 100), "窄余量下每一行都在余量之内")
eq(tightlaid.map((p) => [p.lx, p.ly]), laidRef.map((p) => [p.lx, p.ly]), "截字不影响落点与堆叠位置")

// 单侧空掉也不能崩：只有一台机器时它独自成摞。
const solo = layoutLabels(cam, placed.slice(0, 1), new Map())
eq(solo.length, 1, "只有一台机器时也排得出来")
ok(solo[0].ly >= 12 && solo[0].ly <= 204, "那一摞也在画布内（不会被顶到外面）")

/* ---------------------------------------------------------------- 连线与文案 */

eq(links(laid, 0).length, 0, "linkMode 0 不画连线")
const linked = links(laid, 1)
ok(linked.every((l) => /^M [\d.-]+ [\d.-]+ Q [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+$/.test(l.d)), "连线的路径语法正确")
ok(links(laid, 2).length >= linked.length, "high 档的连线不比 medium 少")
const offline = layoutLabels(cam, globeNodes(fleet.map((n) => ({ ...n, online: false }))), new Map())
eq(links(offline, 1).length, 0, "全都离线时没有连线")
// 同一个地区的两台之间不连（上游按国家排除，这里按地区，更严）。
const sameRegion = layoutLabels(cam, globeNodes([node(1, "华纳云 HK", "HK"), node(2, "野猫 HK", "HK")]), new Map())
eq(links(sameRegion, 1).length, 0, "同一地区的两台之间不连线")

eq(globeCaption(40, 30, "medium"), "ORTHOGRAPHIC · 40°E 30°N · MEDIUM", "底部文案（与截图一致）")
eq(globeCaption(-148.4, -12.6, "low"), "ORTHOGRAPHIC · 148°W 13°S · LOW", "西经南纬的写法")
eq(globeCaption(0, 0, "high"), "ORTHOGRAPHIC · 0°E 0°N · HIGH", "0 度归到 E/N")

// 数据文件本身：79 个环、1483 个点，都是合法坐标（防止哪天被格式化工具改坏）。
eq(WORLD_OUTLINES.length, 79, "岸线 79 个环")
eq(WORLD_OUTLINES.reduce((sum, r) => sum + r.length, 0), 1483, "岸线共 1483 个点")
ok(WORLD_OUTLINES.every((r) => r.every(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat) && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90)), "岸线坐标都在合法区间")
eq(COARSE_WORLD_OUTLINES.length, 8, "粗岸线 8 个环")
// ★ 2026-10：国家表从原站那 12 国有意扩到常见 IDC 国家全集（表外国家在地区功能里
//   完全看不见）。原表那 12 条要**逐字不变**，扩的是新增条目。
eq(Object.keys(COUNTRY_LL).length, 87, "国家落点表覆盖到常见 IDC 国家（原站 12 国 + 75 国扩展）")
eq(["HK", "JP", "DE", "NL", "US", "TW", "AU", "SG", "KR", "GB", "FR", "CN"].map((cc) => [cc, COUNTRY_LL[cc]]), [
  ["HK", [114.2, 22.3]], ["JP", [139.7, 35.7]], ["DE", [8.7, 50.1]], ["NL", [4.9, 52.4]],
  ["US", [-98.6, 39.8]], ["TW", [121.0, 23.7]], ["AU", [134.5, -25.7]], ["SG", [103.82, 1.35]],
  ["KR", [127.8, 36.3]], ["GB", [-2.5, 54.5]], ["FR", [2.2, 46.2]], ["CN", [104.2, 35.8]],
], "原站那 12 国的坐标一字未动（扩表只加不改）")

if (failed) {
  console.error(`\n✗ globe: ${failed} 条断言没过`)
  process.exit(1)
}
console.log("✓ globe: 全部断言通过")

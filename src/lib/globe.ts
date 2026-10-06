/**
 * 节点地球的全部几何：正射投影、海岸线取点、经纬网、节点落点与标签排布。
 *
 * 这是从上游（它的 `js/app.js` 里 atlas/globe 那一段）移植过来的，**输出与它逐点一致**：
 * 同一个视角、同样的 viewBox 460×240、同样的圆盘圆心 (230,112) 半径 92、同样的抽样步长与
 * 曲线步长、标签堆叠与左右分流的规则也照搬。
 * 差别只有两处，都是实现手段而不是结果：
 *
 *   ① 上游每个点每帧都要现算 `sin/cos`（`cosc = sinφ₀sinφ + cosφ₀cosφ·cos(λ−λ₀)`
 *      那一套，一个点四五次三角函数）；这里把每个点**先落成单位球面上的向量**
 *      （只算一次），每帧再算一组基向量（右/上/朝向观察者），之后一个点就只剩
 *      三次点积。同一屏的输出，三角函数调用从「每点每帧 4~5 次」降到「每帧 6 次」。
 *      地球一转就要整块重画，这一步是它能不能在手机上呆着的前提。
 *   ② 交于圆盘边缘（limb）那步，上游在经纬度上线性插值再投影，这里换成在单位向量上
 *      球面插值（slerp）。海岸线上相邻两点都很近，两者差在小数点后好几位。
 *
 * 不变量（改这里之前先读）：**极角超过 120° 的点不画**（`LIMB_K`，上游那行 `cosc <= 0.02`），
 * 落在背面的点直接丢、跨过边缘的线段裁到边缘上，否则地球背面的大陆会翻到正面来。
 */
import { CITY_HINTS, COUNTRY_LL, type Ring } from "./world.ts"
import type { Node } from "@/lib/api"

/** 画布与圆盘。上游 SVG 的 `viewBox="0 0 460 240"` 就是这几个数，改它们等于换一套构图。 */
export const VIEW = { w: 460, h: 240, cx: 230, cy: 112, r: 92 } as const

/** 极角余弦的可见阈值：`cos c > 0.02` 才画（≈ 中心 88.9° 以内，多留一点余量好裁边）。 */
const LIMB_K = 0.02

export type Quality = "low" | "medium" | "high"

/**
 * 一个精度档的取法。三档都实现了，`high` 目前没人用（上游把它开在站点设置里，
 * jikasei 的设置项已经满 6 项，加不进第 7 项）；窄屏自动走 `low`，其余走 `medium`。
 *
 *  `gridLon/gridLat` 经纬网间距（度）
 *  `curveStep` 经纬线每隔几度取一个点（越小越圆滑、越费）
 *  `sweepCount` 扫掠经线数量（`low` 不画）
 *  `linkMode` 0 = 不画节点之间的连线；1/2 = 抽样密度，2 更密
 *  `idleMs`  空闲自转的重画间隔（毫秒）
 */
export type Profile = {
  key: Quality
  land: "coarse" | "detailed"
  gridLon: number
  gridLat: number
  curveStep: number
  sweepCount: number
  linkMode: 0 | 1 | 2
  idleMs: number
}

export function globeProfile(value: unknown): Profile {
  const q = String(value ?? "medium").trim().toLowerCase()
  if (q === "low") return { key: "low", land: "coarse", gridLon: 60, gridLat: 30, curveStep: 8, sweepCount: 0, linkMode: 0, idleMs: 90 }
  if (q === "high") return { key: "high", land: "detailed", gridLon: 30, gridLat: 30, curveStep: 4, sweepCount: 4, linkMode: 2, idleMs: 48 }
  return { key: "medium", land: "detailed", gridLon: 30, gridLat: 30, curveStep: 7, sweepCount: 1, linkMode: 1, idleMs: 64 }
}

/**
 * 把经度折回 [-180, 180)：拖拽转圈转多少圈都行。
 *
 * 写成 `lon - 360·floor((lon+180)/360)` 而不是上游那种两层取模：两者在所有整数边界上
 * 结果相同（180 → −180、−180 → −180），但「先加 180 再取模再减 180」会把 179.9 变成
 * 179.89999999999998 —— 地球自转时每一帧都从上一帧的经度往下算，误差会一路累积。
 */
export function wrapLon(lon: number): number {
  return lon - 360 * Math.floor((lon + 180) / 360)
}

export function clampLat(lat: number): number {
  // ±78°：再往上北极点会贴着圆心转、大陆糊成一团（上游同此）。
  return Math.max(-78, Math.min(78, lat))
}

export type Pt = { x: number; y: number; k: number }

/**
 * 一帧的相机：以 (lon0, lat0) 为球面中心做正射投影。
 *
 * 基向量（推导：球面点 u = (cosφ·sinλ, sinφ, cosφ·cosλ)，λ₀/φ₀ 为中心经/纬度）
 *   右  e_x = ( cosλ₀, 0, −sinλ₀)                 → u·e_x = cosφ·sin(λ−λ₀)
 *   上  e_y = (−sinφ₀·sinλ₀, cosφ₀, −sinφ₀·cosλ₀) → u·e_y = cosφ₀·sinφ − sinφ₀·cosφ·cos(λ−λ₀)
 *   朝观察者 e_z = ( cosφ₀·sinλ₀, sinφ₀, cosφ₀·cosλ₀) → u·e_z = cos c（可见性判据）
 * 屏幕 y 向下，所以 y = cy − r·(u·e_y)。
 */
export type Camera = {
  /** 这一帧的圆盘（圆心与半径）：收口时要贴着它走。 */
  view: typeof VIEW
  /** 单个经纬度。网格线与标签用它。 */
  at(lon: number, lat: number): Pt | null
  /** 预计算好的单位向量（岸线用它，省掉每点每帧的三角函数）。 */
  vec(x: number, y: number, z: number): Pt | null
  /** 从可见点朝背面的点走，落在圆盘边缘上的那一点；给岸线裁边用。 */
  limb(from: number[], to: number[]): Pt | null
  /**
   * **正交投影，不看可见性**：背面点的投影方向照样指出「它该落在地平线的哪个方位角上」，
   * 收口时就是靠这个把背面的那一串顶点贴到边缘上。
   */
  flat(x: number, y: number, z: number): Pt
  /** 把投影点沿半径拉到地平线上（方位角不变）。 */
  edge(p: Pt): Pt
  /**
   * 地平线上从 a 到 b 的中间点（按方位角插值，`stepDeg` 是最大步长）。
   * 跨度超过 60° 时绕行方向按 `winding` 来 —— 免得为了走近路而穿过圆盘。
   */
  arc(a: Pt, b: Pt, winding: number, stepDeg?: number): Pt[]
}

export function camera(lon0: number, lat0: number, view = VIEW): Camera {
  const a = (lon0 * Math.PI) / 180
  const b = (lat0 * Math.PI) / 180
  const sa = Math.sin(a)
  const ca = Math.cos(a)
  const sb = Math.sin(b)
  const cb = Math.cos(b)
  const ex = [ca, 0, -sa]
  const ey = [-sb * sa, cb, -sb * ca]
  const ez = [cb * sa, sb, cb * ca]

  const vec = (x: number, y: number, z: number): Pt | null => {
    const k = x * ez[0] + y * ez[1] + z * ez[2]
    if (k <= LIMB_K) return null
    return { x: view.cx + view.r * (x * ex[0] + y * ex[1] + z * ex[2]), y: view.cy - view.r * (x * ey[0] + y * ey[1] + z * ey[2]), k }
  }

  /** 正交投影：不做 k 的可见性判断（背面点也要它的方位角）。 */
  const flat = (x: number, y: number, z: number): Pt => ({
    x: view.cx + view.r * (x * ex[0] + y * ex[1] + z * ex[2]),
    y: view.cy - view.r * (x * ey[0] + y * ey[1] + z * ey[2]),
    k: x * ez[0] + y * ez[1] + z * ez[2],
  })

  /** 方位角（「y 向上」的坐标系，屏幕 y 要翻回来）。 */
  const azimuth = (p: Pt) => Math.atan2(view.cy - p.y, p.x - view.cx)

  const onEdge = (t: number): Pt => ({ x: view.cx + view.r * Math.cos(t), y: view.cy - view.r * Math.sin(t), k: 0 })

  const arc = (a: Pt, b: Pt, winding: number, stepDeg = 10): Pt[] => {
    const A = azimuth(a)
    const B = azimuth(b)
    let d = B - A
    while (d > Math.PI) d -= Math.PI * 2
    while (d < -Math.PI) d += Math.PI * 2
    // 大跨度（>60°）时方向跟着这一环的绕向走：走近路可能横穿圆盘，那就错了。
    if (Math.abs(d) > Math.PI / 3 && winding !== 0) d = Math.abs(d) * (winding > 0 ? 1 : -1)
    const steps = Math.max(1, Math.ceil(Math.abs(d) / ((stepDeg * Math.PI) / 180)))
    const out: Pt[] = []
    for (let i = 1; i < steps; i += 1) out.push(onEdge(A + (d * i) / steps))
    return out
  }

  return {
    view,
    vec,
    flat,
    edge: (p: Pt) => onEdge(azimuth(p)),
    arc,
    at(lon, lat) {
      const l = (lon * Math.PI) / 180
      const p = (lat * Math.PI) / 180
      const cp = Math.cos(p)
      return vec(cp * Math.sin(l), Math.sin(p), cp * Math.cos(l))
    },
    limb(from, to) {
      // 在单位向量上二分：可见端 lo、背面端 hi，七次之后落点已在边缘上（上游同为七次）。
      let lo = 0
      let hi = 1
      let best: Pt | null = null
      for (let i = 0; i < 7; i += 1) {
        const t = (lo + hi) / 2
        const x = from[0] + (to[0] - from[0]) * t
        const y = from[1] + (to[1] - from[1]) * t
        const z = from[2] + (to[2] - from[2]) * t
        const n = Math.hypot(x, y, z) || 1
        const p = vec(x / n, y / n, z / n)
        if (p) {
          lo = t
          best = p
        } else hi = t
      }
      return best
    },
  }
}

/**
 * 岸线的预计算形式：所有点先落成单位向量，摊在一个 Float64Array 里
 * （`vec[3i], vec[3i+1], vec[3i+2]`），环与环之间用 `offsets` 分隔。
 * 抽稀在这里做掉，于是每帧只读不算。
 */
export type Prepared = { vec: Float64Array; offsets: Int32Array }

/**
 * ★**这里不做抽稀**（曾经做过，是错的）。
 *
 * 原来按「每 N 个点取 1」抽稀（medium 档 N=3）。这套岸线本身已经很稀疏（79 个环、共 1483 点，
 * 平均 0.3°/点），在它上面再砍 2/3 抹掉的是**真实形状**：把地球停在固定角度、819 个采样点
 * 逐个对账，medium 档有 **5.5% 的陆地该画没画、5.0% 的海被填成陆地**，缺的地方各半径都有
 * ——转动起来就是用户报的「陆地残缺」。去掉抽稀后同一份对账降到 1.5% / 0.7%（且全在贴地平线
 * 那一圈，是七次二分找边缘的正常误差）。
 *
 * 换成保形抽稀（道格拉斯–普克）也试过：在这个分辨率下 eps 只要小于点间距就等于不抽，
 * eps 大到真能减点（1° ≈ 1.6px）时形状误差又上来了。既然数据本身已经稀疏，就不抽了 ——
 * 真要给更大的机群省这一帧的成本，该做的是换一套更粗的岸线数据，而不是在这套上做减法。
 * 判据落在 `tools/verify_globe_land.mjs`：采样整个圆盘，逐点比对「该是陆地/画出来是不是陆地」。
 */
export function prepareRings(rings: Ring[]): Prepared {
  const kept: Ring[] = []
  let total = 0
  for (const raw of rings) {
    if (!raw || raw.length < 3) continue
    kept.push(raw)
    total += raw.length
  }
  const vec = new Float64Array(total * 3)
  const offsets = new Int32Array(kept.length + 1)
  let w = 0
  kept.forEach((ring, r) => {
    offsets[r] = w
    for (const [lon, lat] of ring) {
      const l = (lon * Math.PI) / 180
      const p = (lat * Math.PI) / 180
      const cp = Math.cos(p)
      vec[w * 3] = cp * Math.sin(l)
      vec[w * 3 + 1] = Math.sin(p)
      vec[w * 3 + 2] = cp * Math.cos(l)
      w += 1
    }
  })
  offsets[kept.length] = w
  return { vec, offsets }
}

/** SVG 路径要的小数位：一位小数，和上游一样（半像素以内，够圆滑也够短）。 */
const f1 = (n: number) => n.toFixed(1)

/**
 * 一次投影出全部海岸线，返回给 `<path d>` 的两份串：`fill` 每段闭合（填充要）、
 * `stroke` 不闭合（描边要）。
 *
 * 状态机照搬上游：连着可见的点连成一段；可见→背面的那一步补一个边缘点并收段；
 * 背面→可见的那一步从边缘点另起一段（`M`）。于是同一环在圆盘边缘会被切成好几段，
 * 每段各自成一条子路径 —— 这正是「背面大陆不会翻到正面」的原因。
 *
 * ★**收段不能用直线 `Z` 一拉了事**（这里曾经就是，也是「陆地随着转动残缺」的根因）：
 * 段的两头都落在地平线上，直线收口等于把**弦**画进了圆盘 —— 弦与圆弧之间那一牙陆地丢了
 * （实测各角度漏 5%~22%），而绕到对面再露头的大环（南极洲那种）那条弦会**横穿整个圆盘**
 * （实测多填到 9.6%）。正确做法是**沿地平线圆弧收口**：背面那些顶点虽然看不见，但它们的
 * 投影方向仍然告诉了我们它们该在地平线的哪个方位角上 —— 把投影半径拉到边缘，从段尾顺着
 * 这些方位角走回段首，收出来的就是贴着边缘的那条弧。
 */
export function landPaths(cam: Camera, prep: Prepared): { fill: string; stroke: string } {
  const { vec, offsets } = prep
  const view = cam.view
  const fill: string[] = []
  const stroke: string[] = []
  const vis: (Pt | null)[] = []
  const flat: Pt[] = []
  for (let r = 0; r + 1 < offsets.length; r += 1) {
    const from = offsets[r]
    const n = offsets[r + 1] - from
    if (n < 3) continue
    for (let i = 0; i < n; i += 1) {
      const o = (from + i) * 3
      vis[i] = cam.vec(vec[o], vec[o + 1], vec[o + 2])
      flat[i] = cam.flat(vec[o], vec[o + 1], vec[o + 2])
    }
    /**
     * ★**从背面第一个顶点开始遍历这一环**。
     *
     * 不这么做的话：环的可见部分如果跨过 index 0（接缝），就会被状态机切成两段，
     * 其中「绕回开头」的那一段只能在收尾时用直线 `Z` 拉一刀 —— 那一刀切在贴地平线的
     * 陆地上就是一块缺口。实测（104°E,1°N）：外圈 r>0.8 的漏点里 960 个全在西伯利亚那条
     * 大环上，例子是阿拉伯半岛 15°N,43°E 一带 —— 正是那一刀。
     * 从背面顶点起步，可见部分就永远是**一整段连续折线**，收口必走地平线圆弧。
     */
    let firstBack = -1
    for (let i = 0; i < n; i += 1) {
      if (!vis[i]) {
        firstBack = i
        break
      }
    }
    const order: number[] = []
    for (let k = 0; k < n; k += 1) order.push(firstBack > 0 ? (firstBack + k) % n : k)
    // 这一环在屏幕上的绕向（用「y 向上」的坐标系算，与 arc 的方位角同向）。
    let area2 = 0
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n
      area2 += flat[i].x * (view.cy - flat[j].y) - flat[j].x * (view.cy - flat[i].y)
    }
    const winding = Math.sign(area2)
    const coast: string[] = []
    const shaped: string[] = []
    let cur: string[] = []
    let tail = -1 // 当前段最后一个可见顶点下标
    let drawing = false
    const start = (p: Pt) => {
      cur.push(`M ${f1(p.x)} ${f1(p.y)}`)
      drawing = true
    }
    /** 收段。`open` = 两头都在地平线上 —— 这时要沿边缘收，不能拉直线。 */
    const flush = (open: boolean) => {
      if (!cur.length) return
      const d = cur.join(" ")
      coast.push(d)
      if (!open) {
        shaped.push(`${d} Z`)
        cur = []
        return
      }
      // ★走到**下一个可见顶点**就停 —— 不能走到「段首」：段首可能是这条环的 index 0
      //   （可见的），那样会把段尾之后所有可见顶点也贴到地平线上绕圆盘一整圈，
      //   整块圆盘就被填成陆地了（实测 Frankfurt/London 多填 99%~100%）。
      const back: string[] = []
      let k = (tail + 1) % n
      let guard = 0
      let prev: Pt | null = null
      while (guard < n && !vis[k]) {
        guard += 1
        const raw = flat[k]
        // 投影半径太小的点（正对观察者反极点那一带）方位角没有意义，跳过。
        if (Math.hypot(raw.x - view.cx, raw.y - view.cy) > view.r * 0.06) {
          const p = cam.edge(raw)
          if (prev) for (const mid of cam.arc(prev, p, winding)) back.push(`L ${f1(mid.x)} ${f1(mid.y)}`)
          back.push(`L ${f1(p.x)} ${f1(p.y)}`)
          prev = p
        }
        k = (k + 1) % n
      }
      shaped.push(`${d}${back.length ? " " + back.join(" ") : ""} Z`)
      cur = []
    }
    for (let step = 0; step < n; step += 1) {
      const i = order[step]
      const j = order[(step + 1) % n]
      const a = vis[i]
      const b = vis[j]
      const av = [vec[(from + i) * 3], vec[(from + i) * 3 + 1], vec[(from + i) * 3 + 2]]
      const bv = [vec[(from + j) * 3], vec[(from + j) * 3 + 1], vec[(from + j) * 3 + 2]]
      if (a && b) {
        if (!drawing) start(a)
        cur.push(`L ${f1(b.x)} ${f1(b.y)}`)
        tail = j
      } else if (a && !b) {
        const c = cam.limb(av, bv)
        if (!drawing) start(a)
        if (c) cur.push(`L ${f1(c.x)} ${f1(c.y)}`)
        tail = i
        flush(true)
        drawing = false
      } else if (!a && b) {
        const c = cam.limb(bv, av)
        if (!drawing) start(c ?? b)
        cur.push(`L ${f1(b.x)} ${f1(b.y)}`)
        tail = j
      }
    }
    if (drawing) flush(false)
    if (coast.length) {
      stroke.push(coast.join(" "))
      fill.push(shaped.join(" "))
    }
  }
  return { fill: fill.join(" "), stroke: stroke.join(" ") }
}

/**
 * 一条经纬线。经线给 `lon`、纬线给 `lat`（另一维为 `null`），落不到圆盘上的点直接断段。
 * 返回空串表示这条线整条都在背面，不必画。
 */
export function curvePath(cam: Camera, axis: { lon: number | null; lat: number | null }, from: number, to: number, step: number): string {
  const out: string[] = []
  let drawing = false
  for (let a = from; a <= to; a += step) {
    const p = axis.lon !== null ? cam.at(axis.lon, a) : cam.at(a, axis.lat as number)
    if (!p) {
      drawing = false
      continue
    }
    out.push(`${drawing ? "L" : "M"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    drawing = true
  }
  return out.join(" ")
}

export type Wire = { d: string; width: number; sweep: number }

/**
 * 经纬网：每 `gridLon` 一条经线、每 `gridLat` 一条纬线，赤道加粗一点。
 * `sweepLon` 是那条动起来的扫掠经线（`null` = 这个档不画扫掠）。
 */
export function graticule(cam: Camera, profile: Profile, sweepLon: number | null): Wire[] {
  const out: Wire[] = []
  for (let lon = -180; lon < 180; lon += profile.gridLon) {
    const d = curvePath(cam, { lon, lat: null }, -80, 80, profile.curveStep)
    if (d) out.push({ d, width: 0.9, sweep: -1 })
  }
  for (let lat = -60; lat <= 60; lat += profile.gridLat) {
    const d = curvePath(cam, { lon: null, lat }, -180, 180, profile.curveStep)
    if (d) out.push({ d, width: 0.9, sweep: -1 })
  }
  const equator = curvePath(cam, { lon: null, lat: 0 }, -180, 180, Math.max(3, profile.curveStep - 1))
  if (equator) out.push({ d: equator, width: 1.15, sweep: -1 })
  if (sweepLon !== null) {
    // 上游那条会动的经线：主道粗一点、后面每 8° 跟着更淡更细的几条。
    for (let k = 0; k < profile.sweepCount; k += 1) {
      const d = curvePath(cam, { lon: wrapLon(sweepLon - k * 8), lat: null }, -80, 80, Math.max(3, profile.curveStep - 1))
      if (d) out.push({ d, width: k === 0 ? 1.6 : 1.1, sweep: k })
    }
  }
  return out
}

/** 扫掠经线的透明度：亮色底上要更实一点，越靠后越淡（上游同一套数）。 */
export function sweepOpacity(dark: boolean, k: number): number {
  return (dark ? 0.42 : 0.52) - k * 0.06
}

/** 扫掠当前的经度。28ms 一度：一圈约 10 秒，慢到不抢眼。 */
export function sweepLonAt(now: number): number {
  return wrapLon(((now / 28) % 360) - 180)
}

export function globeCaption(lon: number, lat: number, quality: Quality): string {
  const l = Math.round(lon)
  const b = Math.round(lat)
  return `ORTHOGRAPHIC · ${Math.abs(l)}°${l >= 0 ? "E" : "W"} ${Math.abs(b)}°${b >= 0 ? "N" : "S"} · ${quality.toUpperCase()}`
}

/* ------------------------------------------------------------------ 节点落点 */

/**
 * 标签宽度：等宽字体下一个半角 5.05、一个全角 8.6（上游同一份估法）。
 * 这是给「左右两摞标签要留多宽」用的，不需要像素级准确，只需要中西文有区别。
 */
export function labelWidth(text: string): number {
  let w = 0
  for (let i = 0; i < text.length; i += 1) w += text.charCodeAt(i) > 255 ? 8.6 : 5.05
  return w + 2
}

/** 保守字宽（上面那份 × 1.18）：用来判"这行字放不放得下"，宁可估宽一点。 */
export function inkWidth(text: string): number {
  return labelWidth(text) * 1.18
}

/**
 * 把一段文字截到放得下为止，多出来的用 `…`。
 *
 * 只在**窄屏**上会用到（宽屏那两摞标签两侧有大片空白可以溢出，上游就是靠它吸收长名字的；
 * 窄屏是按宽度贴合的，溢出的部分会被 SVG 的视口直接裁掉、页面上什么都不报）。
 * 宁可少几个字，也不留半句话。
 */
export function trimLabel(text: string, max: number): string {
  if (!Number.isFinite(max) || inkWidth(text) <= max) return text
  const chars = [...text]
  let out = ""
  for (const ch of chars) {
    const next = out + ch
    // 留出省略号本身的位置（估 8），否则截完反而多出一点、又被裁。
    if (inkWidth(`${next}…`) > max) break
    out = next
  }
  return `${out.trimEnd()}…`
}

/** 节点名/分组里认出的城市线索。 */
export function cityHint(node: Pick<Node, "name" | "group">): { ll: [number, number]; name: string } | null {
  const text = [node.name, node.group].filter(Boolean).join(" ")
  for (const hint of CITY_HINTS) if (hint.match.test(text)) return { ll: hint.ll, name: hint.name }
  return null
}

export type Region = {
  /** 地区键（`CC` 或 `CC · 城市名`）：筛选与选中态用它。 */
  key: string
  /** ISO 3166-1 alpha-2；空串 = 认不出国家。 */
  code: string
  /** 城市英文名（线索没命中就是空串）。 */
  city: string
  /** 地区列表里显示的文字：有城名用城名，否则用国家码。 */
  label: string
  /** 这一地区的落点（经度, 纬度）：点它时地球飞过去看这里。 */
  base: [number, number]
}

/**
 * 一台机器算一个地区。
 *
 * ★ 与上游有意的两处不同（都是为了跟本站已有口径一致）：
 *   ① 上游把 HK/TW 一并写成 CN（`displayRegionCountry`），这里**照实写 HK/TW** ——
 *      hub 给的就是 ISO 码，卡片上那面旗子也是按它取的，地球不该是另一套说法。
 *   ② 上游给认不出国家的节点一个 [80,30] 的兜底落点（它在图上是一枚假针），
 *      这里直接 `null` —— 认不出就不上地球，也不占地区列表的一行；下面的列表照旧有它。
 */
export function regionOf(node: Node): Region | null {
  const code = (node.country || "").trim().toUpperCase()
  if (!code) return null
  const hint = cityHint(node)
  const base = hint?.ll ?? COUNTRY_LL[code]
  if (!base) return null
  const city = hint?.name ?? ""
  return { key: city ? `${code} · ${city}` : code, code, city, label: city || code, base: [base[0], base[1]] }
}

export type GlobeNode = {
  /** 稳定键（地区键）：标签左右侧的记忆与 React 的 key 都靠它。 */
  key: string
  /** 这个地区里的第一台机器（点针开的就是它）。 */
  id: number
  name: string
  code: string
  /** 这个地区里**每一台**都在线才是 true（有一台离线，针就按离线画）。 */
  online: boolean
  /** 在整张图里的序号：连线的抽样要用它（`(a*7+b*3) % divisor`，同上游）。 */
  index: number
  region: Region
  /** 这个地区有几台（1 台时是普通针，多台时针边挂这个数字）。 */
  count: number
  /** 针落点（地区中心）。 */
  ll: [number, number]
}

/**
 * 节点 → 地球上的针。认不出地区的节点被扔掉（见 `regionOf`）。
 * 只在节点列表变了的时候算一次（组件里 useMemo），不是每帧。
 */
export function globeNodes(nodes: Node[]): GlobeNode[] {
  // ★**同一个地区只出一枚针**，针上带台数。
  //
  // 过去是一台一枚针、同城的多台用 `scatter` 在一个小圈上岔开（上游同此）。机器一多就糊成
  // 一团：100 台、20 个城市时，看得见的那半边有 65 枚针挤在一起，谁也点不准。
  // 现在一个地区一枚，标签上写「Tokyo ×5」，针边上再挂一个小小的台数。
  //
  // 点针仍然开**这个地区里的第一台**（`data-node`），与从前一致 —— 要按地区筛，走右边那列
  // 地区按钮（那里本来就有一枚一枚的台数）。
  const byRegion = new Map<string, { node: Node; index: number; region: Region; count: number; online: boolean }>()
  nodes.forEach((node, index) => {
    const region = regionOf(node)
    if (!region) return
    const hit = byRegion.get(region.key)
    if (hit) {
      hit.count += 1
      // 有一台离线，这枚针就按离线画：地区里出事的那一台不该被「多数在线」盖过去。
      hit.online = hit.online && node.online
      return
    }
    byRegion.set(region.key, { node, index, region, count: 1, online: node.online })
  })
  const placed: GlobeNode[] = [...byRegion.values()].map(({ node, index, region, count, online }) => ({
    key: region.key,
    id: node.id,
    // 一台时照旧用机器名（站长起的名字信息更多）；多台时用地区名 + 台数。
    name: count > 1 ? `${region.label} ×${count}` : node.name,
    code: region.code,
    online,
    index,
    region,
    count,
    ll: region.base,
  }))
  // 顺序回到节点原本的顺序：连线的抽样按 index 来，跟上游一致。
  return placed.sort((a, b) => a.index - b.index)
}

/**
 * 地区列表：按地区把节点分桶，key 就是筛选用的那个值。
 *
 * 排序按**台数从多到少**，同数按地区键（上游是纯字母序 —— 三台东京与一台首尔并排时，
 * 字母序把「哪儿机器多」这条最有用的信息藏起来了）。
 */
export type RegionRow = { region: Region; count: number; aim: [number, number] }
export function regionRows(nodes: Node[]): RegionRow[] {
  const map = new Map<string, RegionRow>()
  for (const node of nodes) {
    const region = regionOf(node)
    if (!region) continue
    const row = map.get(region.key)
    if (row) row.count += 1
    else map.set(region.key, { region, count: 1, aim: region.base })
  }
  return [...map.values()].sort((a, b) => b.count - a.count || (a.region.key < b.region.key ? -1 : a.region.key > b.region.key ? 1 : 0))
}

/**
 * 选中地区的筛选：选中的地区已经不在了（节点下线/改名/换了分组）就回落「全部」，
 * 而不是停在一个什么都看不见的筛选上 —— 与 `groupView` 同一套归一化思路。
 */
export function regionView(nodes: Node[], current: string | null) {
  const rows = regionRows(nodes)
  const valid = current !== null && rows.some((row) => row.region.key === current) ? current : null
  return { rows, current: valid, shown: valid === null ? nodes : nodes.filter((node) => regionOf(node)?.key === valid), total: nodes.length }
}

/* ------------------------------------------------------------------ 标签排布 */

export type Placed = GlobeNode & {
  px: number
  py: number
  lx: number
  ly: number
  end: boolean
  /** 最终显示的那一行（按落到的左右侧从下面两个里取）。 */
  label: string
  /** 两个方向各自的那一行（左侧写「名字 · 国家」、右侧写「国家 · 名字」）。 */
  left: string
  right: string
  width: number
}

/**
 * 标签排布：把每一枚针连到左右两摞里的一行字上。
 *
 * 步骤（除③外都是上游的原样）：
 *   ① 投影，投影不到的（在背面）直接不要；
 *   ② 左右分流：以圆心为界，中心附近 ±18 的按上一帧的选择留在原侧（否则在这个角度上会左右闪烁）；
 *   ③ 两侧数量差超过 2 就把**离中心最近**的那几个挪到对面（地理位置仍然主导）；
 *   ④ 每摞按 y 排序、等距铺开（间距 13，超过 14 行时压到 11），整摞居中于它们的平均高度，
 *      再夹在 12~204 之间 —— 于是标签永远不会压到地球身上，也不会跑出画布。
 *
 * `sides` 是跨帧记忆（节点键 → 左/右），由调用方持有（React 里放 ref）。
 *
 * `maxWidth` 是"一行标签最宽能有多宽"（用户单位，见组件的画布留白那段）：宽屏上它很大
 * （两侧的空白也算进去），窄屏上就只剩两摞标签到画布边缘的那点地方 —— 超出的字用 `…` 截掉，
 * 绝不留给 SVG 视口去裁。
 */
export function layoutLabels(cam: Camera, points: GlobeNode[], sides: Map<string, "L" | "R">, maxWidth = Infinity, cx = VIEW.cx): Placed[] {
  const items: Placed[] = []
  for (const point of points) {
    const p = cam.at(point.ll[0], point.ll[1])
    if (!p) continue
    const left = trimLabel(`${point.name} · ${point.code}`, maxWidth)
    const right = trimLabel(`${point.code} · ${point.name}`, maxWidth)
    items.push({
      ...point, px: p.x, py: p.y, lx: 0, ly: 0, end: false, label: right,
      // 两个方向都排得下才算这一行长；宽度也按截断之后的算，左右两摞才配得平。
      width: Math.max(labelWidth(left), labelWidth(right)),
      left, right,
    } as Placed)
  }
  const left: Placed[] = []
  const right: Placed[] = []
  for (const item of items) {
    let side = item.px >= cx ? "R" : "L"
    const remembered = sides.get(item.key)
    if (remembered && Math.abs(item.px - cx) < 18) side = remembered
    ;(side === "L" ? left : right).push(item)
  }
  const rebalance = (from: Placed[], to: Placed[]) => {
    if (from.length - to.length <= 2) return
    const move = from.slice().sort((a, b) => Math.abs(a.px - cx) - Math.abs(b.px - cx) || a.width - b.width || a.index - b.index)
    while (from.length - to.length > 2 && move.length) {
      const item = move.shift() as Placed
      const at = from.indexOf(item)
      if (at < 0) continue
      from.splice(at, 1)
      to.push(item)
    }
  }
  rebalance(right, left)
  rebalance(left, right)
  const stack = (list: Placed[], x: number, end: boolean) => {
    if (!list.length) return
    list.sort((a, b) => a.py - b.py || a.index - b.index)
    const gap = list.length > 14 ? 11 : 13
    const mean = list.reduce((sum, item) => sum + item.py, 0) / list.length
    let y0 = mean - ((list.length - 1) * gap) / 2
    if (y0 < 12) y0 = 12
    const last = y0 + (list.length - 1) * gap
    if (last > 204) y0 -= last - 204
    if (y0 < 12) y0 = 12
    list.forEach((item, i) => {
      item.lx = x
      item.ly = y0 + i * gap
      item.end = end
      item.label = end ? item.left : item.right
      sides.set(item.key, end ? "L" : "R")
    })
  }
  // 两摞都要完全落在圆盘外面：460 宽的画布里留给它们的正是 126 / 334 这两条线。
  stack(left, 126, true)
  stack(right, 334, false)
  return items
}

/**
 * 在线节点之间的连线：跨地区才算一对，再按 `(a·7 + b·3) % divisor === 1` 抽稀 ——
 * 26 台两两相连是 325 条，画出来是一团毛线。`linkMode` 越大越密（上游 1 → 8 抽一、2 → 4 抽一）。
 */
export function links(placed: Placed[], mode: 0 | 1 | 2, center = VIEW): { d: string }[] {
  if (!mode) return []
  const online = placed.filter((item) => item.online)
  const out: { d: string }[] = []
  const divisor = mode > 1 ? 4 : 8
  for (let i = 0; i < online.length; i += 1) {
    for (let j = i + 1; j < online.length; j += 1) {
      const a = online[i]
      const b = online[j]
      if (a.region.key === b.region.key) continue
      if ((a.index * 7 + b.index * 3) % divisor !== 1) continue
      // 控制点拉向圆心：直线会横穿地球，弧线才像"从球面上绕过去"。
      const mx = (a.px + b.px) / 2
      const my = (a.py + b.py) / 2
      const qx = center.cx + (mx - center.cx) * 0.42
      const qy = center.cy + (my - center.cy) * 0.42
      out.push({ d: `M ${f1(a.px)} ${f1(a.py)} Q ${f1(qx)} ${f1(qy)} ${f1(b.px)} ${f1(b.py)}` })
    }
  }
  return out
}

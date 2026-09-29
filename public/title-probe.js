// 标签页标题的头一步。
//
// 站长把站名改了之后，静态 HTML 里那句 <title>Monitor</title> 只是占位值，真站名原本要等
// 入口包跑完（App 取到 /api/me）才有——刷新时标签页会先亮出「Monitor」再跳成站名。
//
// 所以这里补两步（缓存那一步的**主力在 index.html 的内联脚本里**，本文件是它的兜底与替补）：
// 1) 先把上一次的站名（localStorage，本站自己的来源）贴上——这一条的「即时版」是内联那段，
//    因为它省掉一次往返：本文件是独立文件，线上实测访客要多等 164ms 才轮到它执行，那段时间
//    占位值已经被画上标签页了。内联那段被 CSP 挡掉时，这里就是唯一能顶上的人；
// 2) 没有缓存（首次访问）时自己问一次 /api/me —— 它通常比入口包先回来，标题就能早点贴对，
//    而不是等入口包执行完才从那句兜底值跳过去。
//
// 一旦 App 接手（window.__titleOwned，见 src/App.tsx），这里就再也不碰标题：详情页那条
// 「节点名 · 站名」是 App 写的，迟到的响应不许把它盖回纯站名。
//
// 做成独立文件而不是内联脚本：站点前面若有 CSP，内联脚本会被挡掉；这里的地址也便于各站自己换。
// 缓存键必须与 src/App.tsx 里的 TITLE_CACHE_KEY 一致。
;(function () {
  var KEY = "jikasei:site_name"
  // 谁贴上的：inline（index.html 那段）/ cache（本文件用缓存）/ fetch（本文件早问回来的）。
  var mark = function (source) { if (!window.__titleProbeSource) window.__titleProbeSource = source }
  var cached = null
  try {
    cached = localStorage.getItem(KEY)
  } catch {
    // 隐私模式 / 存储被禁用：跳过缓存这一步，下面照常早问一次。
  }
  if (cached) {
    document.title = cached
    mark("cache")
    return
  }
  if (!window.fetch) return
  // 带个只用于区分的查询参数：hub 不看查询串，这条请求只是好在日志与验收里
  // 与 App 那条 /api/me 分开（推迟其中一条，就能把「迟到的响应」这个竞态造出来）。
  fetch("/api/me?theme-title=1", { credentials: "same-origin" })
    .then(function (r) { return r.json() })
    .then(function (d) {
      if (!d || !d.site_name || window.__titleOwned) return
      document.title = d.site_name
      mark("fetch")
      try {
        localStorage.setItem(KEY, d.site_name)
      } catch {}
    })
    .catch(function () {})
})()

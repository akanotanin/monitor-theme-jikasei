// 标签页图标的头一步。
//
// 站长把「站点图标」改成别的地址后，静态 HTML 里那行 <link rel="icon" href="/site-icon.png">
// 只是主题自带那枚（JS 起来之前的占位值），真值原本要等三件事依次完成：入口包下载执行 →
// /api/themes/jikasei/config 返回 → 顶栏那张 <img> onLoad。于是标签页会先显示主题自带那张
// 娃娃头一两秒，站长会把它当 BUG 报上来（实测：1.1s 才发出 favicon 请求、2.2~2.4s 才换成自定图）。
//
// 所以这里：
// 1) 先把上一次真的加载成功过的那张图标（localStorage，本站自己的来源）贴上——赶在浏览器
//    发出那条 favicon 请求之前改掉 <link>，返访时标签页从头到尾都是自定图，一次都不闪；
// 2) 同时并行早问一次设置（它几乎总比入口包先回来）：缓存里那张与站长最新设置不一致时
//    立刻换成新地址（刚换过图标不用再等 1.6s），首次访问没有缓存时也靠它把图标早点贴上。
//    这条响应转交给 App（window.__iconProbeConfigPromise），/api/themes/<short>/config
//    每次加载因此仍然只发一条。
//
// 做成独立文件而不是内联脚本：站点前面若有 CSP，内联脚本会被挡掉。
// 缓存键必须与 src/lib/theme-config.ts 里的 ICON_CACHE_KEY 一致。
;(function () {
  var KEY = "jikasei:site_icon"
  var DEFAULT_ICON = "/site-icon.png"
  // 带个只用于区分的查询参数：hub 不看查询串，这条只是好在日志与验收里与 App 那条分开。
  var CONFIG_URL = "/api/themes/jikasei/config?theme-icon=1"

  function current() {
    var link = document.querySelector('link[rel~="icon"]')
    return link ? link.getAttribute("href") : null
  }

  function apply(href) {
    // 已经是它了就不折腾：白改一次会让浏览器多发一条 favicon 请求。
    if (!href || current() === href) return
    var links = document.querySelectorAll('link[rel~="icon"]')
    for (var i = 0; i < links.length; i++) links[i].href = href
    if (!links.length) {
      var made = document.createElement("link")
      made.rel = "icon"
      made.href = href
      document.head.appendChild(made)
    }
    // iOS 加到主屏读的是 apple-touch-icon，跟标签页同一张。
    var touch = document.querySelector('link[rel="apple-touch-icon"]')
    if (!touch) {
      touch = document.createElement("link")
      touch.rel = "apple-touch-icon"
      document.head.appendChild(touch)
    }
    touch.href = href
    // 验收用（tools/verify_icons.mjs）：何时贴上、贴的是哪张。
    window.__iconProbeAt = Math.round(performance.now())
    window.__iconProbeHref = href
  }

  function mark(source) {
    if (!window.__iconProbeSource) window.__iconProbeSource = source
  }

  var cached = null
  try {
    cached = localStorage.getItem(KEY)
  } catch {
    // 隐私模式 / 存储被禁用：跳过缓存这一步，下面照常早问一次。
  }
  if (cached) {
    apply(cached)
    mark("cache")
  }

  if (!window.fetch) return
  var pending = fetch(CONFIG_URL, { credentials: "same-origin" })
    .then(function (res) { return res.json() })
    .then(function (saved) { return saved && typeof saved === "object" ? saved : null })
    .catch(function () { return null })
  // 转交给 App（src/lib/theme-config.ts 的 useThemeConfig），免得同一次加载发两条一样的设置请求。
  window.__iconProbeConfigPromise = pending
  pending.then(function (saved) {
    var fresh = saved && typeof saved.siteIcon === "string" && saved.siteIcon.trim() ? saved.siteIcon.trim() : DEFAULT_ICON
    if (fresh === current()) return
    apply(fresh)
    // 有缓存时进的是「缓存先顶、新值随后」这条路，来源仍记 cache。
    mark(cached ? "cache" : "fetch")
  })
})()

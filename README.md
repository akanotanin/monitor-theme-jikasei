# monitor-theme-custom（Komari定制主题）

[monitor](https://github.com/monitor-probe/monitor) 的第三方主题，跑在 komari.im 的公开状态页上。

源码基线是上游默认主题 **`monitor-theme-default` v1.1.0**（React + Vite + shadcn/ui），本仓库把此前
逐次打在压缩产物上的改动全部重建进源码，从此这套主题可以自己改、自己构建。

## 相对上游 v1.1.0 的改动

### 页面

- **顶栏**：站点名左边加一枚圆形站标（默认 `/site-icon.png`，可在后台换成任意地址）；「进入后台」由「扳手 + 文字」收成一枚
  图标按钮，文字挪进 `title` / `aria-label`，这一行因此只有图标、宽度稳定。页面宽度上限
  1400 → 1280px。
- **列表页**：去掉顶部那条汇总统计（`Summary.tsx` 已删除）。卡片只留一行身份（国旗 + 名称）、
  四个环形用量和底部的上下行速率与总量——上游那一行「系统 · 虚拟化 · 架构」与右侧的状态、到期
  徽章都不再渲染，详情页里写得更全。
- **国旗**：改成本主题自带的静态文件 `/flags/<CC>.svg`（258 面，按 ISO 3166-1 alpha-2 命名），
  按国家码现取一张，访客只下载页面上真正出现的那几面；取不到的退回文字徽标。上游是把
  `country-flag-icons` 当模块导入、整套旗表随入口包下发。
- **节点详情页**：标题行只留国旗 + 名称；信息项最后一格由「续费」换成**「在线时间」**（与原先挂在
  标题行的那枚状态徽章同一个时长）；去掉 agent 版本徽章。
- **图表配色**：九色延迟调色板（`--chart-1..9`，亮色压亮度、深色抬亮度，色相不变），加一条
  `--warn` 之外的 `--ok` 语义绿；资源图用固定语义色——CPU 蓝、内存紫、下行绿、上行橙、硬盘青。
  上游的灰阶靠明度与虚线区分，四条线路以上就分不清了。
- **自绘 tooltip**：延迟图不再用 recharts 默认那枚（每个点只说「名字 + 值」）。自绘面板按**最慢在
  前**排序，超时的线路保留并标「无响应」，有丢包的缀一段丢包率，窄屏只列前 5 条、其余折成
  「另有 N 条」；四张资源图共用同一枚面板（时间戳 + 同色圆点 + 名称 + 右对齐的值）。
- **站内入口脚本**：`public/farm-entry.js` 在顶栏「进入后台」旁边注入一个「养鸡场」入口（克隆相邻
  图标节点，继承其 class、尺寸与 hover 样式），`index.html` 里以普通 `<script>` 加载。不跑养鸡场
  的站删掉这一行与这个文件即可。

### 工程

- 删掉 `simple-icons`（只服务于被删的系统图标行）与 `country-flag-icons`（被 `/flags/` 取代）两个
  依赖；`vite.config.ts` 里那条 `assetsInlineLimit` 例外也随之删除。
- 打包与发版：`npm run package` 生成 `release/theme.tar.gz` + sha256，`.github/workflows/release.yml`
  在打 tag 时校验 `theme.json`/`package.json` 版本一致后自动发 Release。
- 取景验收：`node tools/shots.mjs <baseUrl> [outDir]` 一条命令拍亮/暗、列表/详情/延迟、手机共 7 个
  机位，并回报国旗、养鸡场入口、站标是否存在以及控制台异常。

## 版本记录

| 版本 | 说明 |
|---|---|
| 1.1.0 | 新增两项后台设置：站点图标、分组标签行开关（`theme.json` 的 `config`）|
| 1.0.2 | 本仓库首版：基线换成上游 v1.1.0 源码，此前所有改动重建进源码 |
| 1.0.0 / 1.0.1 | 历史版本，只有构建产物，没有源码 |

以 v1.1.0 作基线，等于顺带带上 v1.0.0 → v1.1.0 之间的上游改动（分组标签行、延迟图 band 的裁剪
改进、暗色跟随系统偏好等）。除这些上游侧差异外，页面结构、文案与配色与线上逐项核对一致。

## 主题设置

后台「主题」页的「主题设置」里有两项，改完对访客立即生效（存在 hub 的站点配置里，访客端不落副本）：

| 设置项 | 默认 | 说明 |
|---|---|---|
| 站点图标 | `/site-icon.png` | 顶栏那枚 32px 圆形站标的地址。填完整网址或站内路径；取不到就回落到主题自带那张，两张都取不到则不占位。 |
| 显示分组标签行 | 开 | 列表页顶部那行分组标签（全部 / 各组 / 未分组）的开关。关掉后节点按分组顺序平铺成一整列；关掉的那一刻访客手里选着的分组同时作废（回到全部）。节点本来就没有分组时，这行无论如何都不显示。 |

两项都只走站点级配置（`GET` / `PUT /api/themes/custom/config`）；访客自己的深浅色偏好仍旧走
localStorage，不混在一起。

`theme.json` 的 `config` 声明表单，`src/lib/theme-config.ts` 的 `DEFAULTS` 是页面的兜底，
**两处必须逐项一致**，`npm run check` 在打包前核对（`npm run package` 与 CI 都会调）。只改一边的
症状是「后台显示开着、页面还是旧样子」，而且两边都不报错。

面板上列出来的设置项本身也有护栏：

```bash
# 不经登录，用 CDP 拦 /api/* 喂一份真实 theme.json 进后台真组件，断言两项都画出来了
node tools/verify_settings_dialog.mjs theme.json shots/settings-dialog
```

拿改动前的 `theme.json` 跑必须 FAIL，否则等于没验。

## 开发

主题只读公开数据，开发服务器直接拿一个现成的 hub 当数据源，要求它开着公开状态页：

```bash
npm ci
# Vite 将 /api 与 WebSocket 代理至这个 hub
MONITOR_HUB=https://hub.example.com npm run dev
```

不设 `MONITOR_HUB` 时代理至 `http://127.0.0.1:9911`。在本机起 hub、自己造节点的写法见文档站的
[主题开发](https://monitor-document.pages.dev/dev/theme)页。

构建产物位于 `dist/`。提交前运行 `npm run build && npm run lint && npm test`。

`npm test` 校验数字格式化和实时指标的输入边界。没有测试框架，Node 自己剥掉
类型，失败时退出码非零。

`npm run package` 会先构建再打包，产出 `release/theme.tar.gz`（`theme.json` + `LICENSE` +
`dist/` + `preview.png`）与同名 `.sha256`。**主题版本号一动就要发一个新 tag**：hub 面板上的
「更新」是按版本号判断的，`theme.json` 改了而不发版，站长那边就看不到更新。

## 主题包

一个可安装主题是一个目录，名字必须与 `theme.json` 的 `short` 相同：

```text
<themes-dir>/<short>/
├── theme.json
├── preview.png        # 可选，面板上的预览图
└── dist/
    └── index.html
```

`theme.json` 除 `config` 外的六个字段都要写，均为字符串，`description`、`version`、`author`、`url` 可以留空，少写一个 hub 就不认这个主题：

| 字段 | 含义 |
|---|---|
| `name` | 显示名称 |
| `short` | 唯一短名，限字母、数字、`-`、`_`，取 `default` 则顶替 hub 内置的那份 |
| `description` | 简介 |
| `version` | 主题版本 |
| `author` | 作者 |
| `url` | 源码地址 |
| `config` | 可选，数组，站长在后台可调的设置，后台按它画表单 |

每个 tag 的 release 里的 `theme.tar.gz` 解开就是这个目录——hub 构建时嵌入的是同一个包。

将目录复制到 hub 的 `--themes` 位置，在后台「主题」页切换，无需重启。本主题的 `short` 是
`custom`，`url` 留空（面板上的「更新」按钮因此不可用，改由 `npm run package` 出的包手动安装）。

## 主题契约

主题是纯静态 SPA，只能依赖下列同源接口：

| 接口 | 用途 |
|---|---|
| `GET /api/me` | 站点名、登录状态、公开页开关 |
| `GET /api/nodes` | 节点列表、实时指标和累计流量 |
| `GET /api/nodes/{id}/metrics` | 历史指标和延迟记录 |
| `GET /api/ws` | 每 2 秒推送一次节点快照的 WebSocket |
| `GET /api/themes/{short}/config` | 站长改过的主题设置，只含与默认值不同的项 |

主题自带设置界面时，站长登录后可以 `PUT` 同一地址保存。`config` 的声明格式、两个接口的规则与约定见文档站的[主题开发](https://monitor-document.pages.dev/dev/theme#主题设置)。

`metrics` 的三个查询参数都可省：

- `hours=N` 窗口宽度。**匿名上限 168，登录后 2160**，超出静默 clamp——降采样限的是响应行数，这个
  上限限的是 hub 扫描多少行
- `points=W` 调用方画得下的点数，只会让 hub 抽得更稀，不会更密
- `series=metrics|ping` 只取要画的那一半，省掉的那半原本占响应的三分之一到三分之二

探测曲线的名字在响应的 `probes` 里随样本一起下发，匿名可读，所以画延迟图不需要第二个请求，也不
需要管理员身份。

整个窗口的丢包率在响应的 `loss` 里，按探测 id 给出百分比，没丢包的探测不出现。**不要拿样本行里
的 `loss` 自己平均**：那一个是所在桶的百分比，除数已经丢了，而各桶样本数天然不等——窗口首尾两桶
本来就是残缺的，探测启停、节点掉线、agent 跳过一轮都会再造几个。十三次里丢一次，平均桶百分比会
算出 50%。

匿名访问 `GET /api/nodes` 仅返回 `public=1` 的节点，响应中不含 `ip`、`hostname`、`remark`。字段定义以 hub 的 `src/api.rs` 为准。

未知路径回落到主题的 `dist/index.html`，客户端路由可用。`/admin/*` 由 hub 内置后台接管，不属于主题契约。

本主题用 `/node/{id}` 作为详情页。hub 的回落对它够用，但**hub 前面若有按路径做正向白名单的反代
或 WAF，得把这个前缀放行**：从列表点进去只是 pushState，边缘看不见，刷新详情页才会真的请求
`/node/{id}`，症状是「点进去正常，一刷新就被拦」。

## 许可

MIT（上游 `monitor-theme-default` 的版权与许可照留，见 `LICENSE`）

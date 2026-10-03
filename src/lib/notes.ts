import { splitTags, tagsFor } from "./site-settings.ts"

/**
 * 节点备注：hub 后台按节点填的两个字段（随 `/api/nodes` 下发）+ 主题设置里那份兜底清单。
 *
 *   · **公开备注**（`public_remark`）——站长写给访客的一行说明（hub 1.3.2 起）：单行、≤100 字、
 *     留空就是没写；hub 存的时候就 trim 过，换行与控制字符直接拒收，所以这边拿到的一定是一行
 *     文本。它随**公开视图**下发，匿名也拿得到；老 hub 没有这个字段，按「这台没写备注」处理。
 *   · **私有备注**（`remark`）——站长写给自己的那个（面板里的 placeholder 就是「仅管理员可见」），
 *     **只在登录态下发**，匿名视图里根本没有这个键。hub 对它不做长度与控制字符校验（面板虽是
 *     单行输入框，历史数据与接口写入都可能带换行），所以它按**整段展示**处理（保留换行）。
 *   · 主题设置里的「服务器备注」清单（`serverNotes`，每行 `服务器名=备注`）——**兜底**：只对
 *     **没写公开备注**的机器生效（取舍见 `remarkTags`）。
 *
 * **公开备注**的写法：逗号（半角 `,` 与全角 `，`）分隔＝多枚小卡片，一枚一枚各自成卡片；
 * 与 1.15.x 那份「服务器备注」清单逐字相同（两边写法一致，从旧版迁过来不用改写）。
 * **私有备注不拆**，见 `privateRemark`。
 *
 * 放在这里（而不是组件里）是因为它们是纯函数：能脱开 React 单测，改起来不怕漏。
 */
export function publicRemark(node: { public_remark?: string | null }): string {
  // 再削一次空白：旧数据、手工改库都可能带空白，而「只有空白」应当与「没写」等价，
  // 否则会渲染出一个空的备注位（零占位的结论就假了）。
  return (node.public_remark ?? "").trim()
}

/** hub 那条公开备注 → 一枚枚小卡片。 */
export function hubTags(node: { public_remark?: string | null }): string[] {
  return splitTags(publicRemark(node))
}

/**
 * 这台机器最终显示的备注（一枚枚小卡片），两个来源按站长定的规矩取舍：
 *
 *   ① **hub 后台按节点填的「公开备注」**（hub ≥ 1.3.2）写了这台 → 用它；
 *   ② 这台**没写公开备注**（空串 / 只有空白 / 老 hub 没这个字段）→ 用主题设置里的「服务器备注」清单。
 *
 * 两边都没有 → 空数组，页面上一个像素都不占。
 */
export function remarkTags(node: { public_remark?: string | null; name: string }, notes = ""): string[] {
  const hub = hubTags(node)
  return hub.length > 0 ? hub : tagsFor(notes, node.name)
}

/**
 * 私有备注 → 一段原文（**整段展示**，按探针原本的设定）：只削首尾空白、把 CRLF 归一成 LF，
 * 中间的空行与换行原样保留（版式层用 `whitespace-pre-wrap` 渲染）。
 *
 * ★**不做逗号拆分**：逗号＝多枚小卡片是**公开备注**的写法（见 `hubTags`）；私有备注是站长
 * 写给自己看的备忘，常常是成段的说明（「备用机，别删（欠费到 12 月）」），拆成几枚反而读不懂。
 * 这是用户 2026-10-03 定的口径：私有备注保持探针作者的原有设定。
 *
 * 返回空串＝没写（空串、只有空白、字段不在都算），页面上一个像素都不占。
 */
export function privateRemark(node: { remark?: string | null }): string {
  return (node.remark ?? "").replace(/\r\n?/g, "\n").trim()
}

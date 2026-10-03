import { splitTags, tagsFor } from "./site-settings.ts"

/**
 * 节点备注：站长在 hub 后台「公开备注」里写给访客的一行说明，随 `/api/nodes` 的公开视图
 * 一起下发（hub 1.3.2 起；单行、≤100 字，留空就是没写）。hub 存的时候就 trim 过、
 * 换行与控制字符直接拒收，所以这边拿到的一定是一行文本。老 hub 没有这个字段，
 * 按「这台没写备注」处理。
 *
 * **两个来源，取舍见 `remarkTags`**：主题设置里的「服务器备注」写了哪台就优先用那里的
 * （1.15.x 及更早那份清单的写法，1.16.0 短暂删过、1.17.0 请了回来并定为优先），
 * 没写的才用 hub 这条——全站备注平时只在后台维护一处，想临时给某台加一句则不必进后台。
 *
 * 写法两边**一致**：逗号分隔就是多枚，一枚一枚各自成卡片。从旧版迁过来不用改写法。
 *
 * 放在这里（而不是组件里）是因为它是纯函数：能脱开 React 单测，改起来不怕漏。
 */
export function publicRemark(node: { public_remark?: string | null }): string {
  // 再削一次空白：旧数据、手工改库都可能带空白，而「只有空白」应当与「没写」等价，
  // 否则会渲染出一个空的备注位（零占位的结论就假了）。
  return (node.public_remark ?? "").trim()
}

/** hub 那条公开备注 → 一枚枚小卡片（写法与主题设置里那份清单逐字相同）。 */
export function hubTags(node: { public_remark?: string | null }): string[] {
  return splitTags(publicRemark(node))
}

/**
 * 这台机器最终显示的备注（一枚枚小卡片），两个来源按站长定的规矩取舍：
 *
 *   ① **主题设置的「服务器备注」里写了这台** → 用那里的（`服务器名=备注1,备注2`）；
 *   ② 那里没写（或写了空值） → 用 **hub 后台按节点填的「公开备注」**（hub ≥ 1.3.2）。
 *
 * 于是站长想临时给某台加一句不必进后台改节点；而全站的备注仍然只在 hub 里维护一处。
 * 两种来源都没有 → 空数组，页面上一个像素都不占。
 */
export function remarkTags(node: { public_remark?: string | null; name: string }, notes = ""): string[] {
  const own = tagsFor(notes, node.name)
  return own.length > 0 ? own : hubTags(node)
}

/**
 * 节点备注：两个字段都在 hub 后台按节点填，随 `/api/nodes` 一起下发。
 *
 *   · **公开备注**（`public_remark`）——站长写给访客的一行说明（hub 1.3.2 起）：单行、≤100 字、
 *     留空就是没写；hub 存的时候就 trim 过，换行与控制字符直接拒收，所以这边拿到的一定是一行
 *     文本。它随**公开视图**下发，匿名也拿得到；老 hub 没有这个字段，按「这台没写备注」处理。
 *   · **私有备注**（`remark`）——站长写给自己的那个（面板里的 placeholder 就是「仅管理员可见」），
 *     **只在登录态下发**，匿名视图里根本没有这个键。hub 对它不做长度与控制字符校验（面板虽是
 *     单行输入框，历史数据与接口写入都可能带换行），所以它按「先分段、段内再拆」处理。
 *
 * 两个字段的**写法一致**：逗号（半角 `,` 与全角 `，`）分隔＝多枚小卡片，一枚一枚各自成卡片；
 * 与 1.15.x 那份「服务器备注」清单逐字相同（那份清单 1.18.0 已删——备注只留 hub 一处维护，
 * 主题设置里不再有这一项）。
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
 * 私有备注 → 一段段小卡片（每段一行）：**先按换行分段，段内再按逗号拆**。
 *
 * 分段而不是整条拆平，是因为 hub 对它没有单行约束：整条拆平会把站长自己分好的几行压成一串。
 * 返回空数组＝没写（空串、只有空白、字段不在都算），页面上一个像素都不占。
 */
export function privateTagLines(node: { remark?: string | null }): string[][] {
  return (node.remark ?? "")
    .split(/\r?\n/)
    .map((line) => splitTags(line))
    .filter((tags) => tags.length > 0)
}

/** 备注值 → 小卡片列表：逗号（半角 / 全角）分隔，削首尾空白、丢掉空片段。 */
export function splitTags(value: string): string[] {
  return value
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

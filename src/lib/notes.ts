/**
 * 节点备注：站长在 hub 后台「公开备注」里写给访客的一行说明，随 `/api/nodes` 的公开视图
 * 一起下发（hub 1.3.2 起；单行、≤100 字，留空就是没写）。hub 存的时候就 trim 过、
 * 换行与控制字符直接拒收，所以这边拿到的一定是一行文本。
 *
 * 这是主题**唯一**的备注来源：主题自己那份「服务器备注」清单（1.15.x 及更早的站点配置）
 * 已在 1.16.0 删掉——同一件事由 hub 直接管，站长不必在两处各写一份。老 hub 没有这个字段，
 * 按「这台没写备注」处理，页面与从前逐像素相同。
 *
 * 写法与旧版**一致**：逗号分隔就是多枚，一枚一枚各自成卡片（见 `remarkTags`）。站长从旧版
 * 迁过来不用改写法——后台那一行照抄即可。
 *
 * 放在这里（而不是组件里）是因为它是纯函数：能脱开 React 单测，改起来不怕漏。
 */
export function publicRemark(node: { public_remark?: string | null }): string {
  // 再削一次空白：旧数据、手工改库都可能带空白，而「只有空白」应当与「没写」等价，
  // 否则会渲染出一个空的备注位（零占位的结论就假了）。
  return (node.public_remark ?? "").trim()
}

/**
 * 备注 → 一枚枚小卡片：逗号（半角 `,` 与全角 `，`）分隔，两侧空白削掉、空片段丢掉。
 * 站长在后台写 `CN2 GIA,三网优化,流媒体` 就是三枚卡片——与 1.15.x 那份「服务器备注」
 * 的写法逐字相同，迁过来不用改。
 */
export function remarkTags(node: { public_remark?: string | null }): string[] {
  return publicRemark(node)
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

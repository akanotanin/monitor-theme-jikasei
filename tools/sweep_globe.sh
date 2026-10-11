#!/bin/bash
# 「节点地球」的整套复核：改动地球的任何一块（几何、标签、交互、配色、聚合）都跑它。
# 逐条各起一份 headless Chrome —— **串行 + 每条之间 sleep 2**，
# 别改成内联 for 循环或 && 链（那些会间歇性只吐一行 "stdin is not a tty"，等于没跑）。
#
# 用法：bash tools/sweep_globe.sh [日志路径=shots/sweep-globe-<时:分:秒>.log]
#   摘要：日志里各条的 "N PASS / M FAIL" 行；含 FAIL 的条数 = 退出码。
#   几十条工具会跑十几分钟，建议 background 跑（前台 >600s 会被降级）。
cd "$(dirname "$0")/.." || exit 1
LOG=${1:-shots/sweep-globe-$(date +%H%M%S).log}
mkdir -p shots
bad=0
for t in verify_globe verify_globe_layout verify_globe_colors verify_globe_coverage verify_globe_spin verify_globe_scale verify_touch_targets; do
  echo "=== $t ===" >>"$LOG"
  node "tools/$t.mjs" >>"$LOG" 2>&1
  code=$?
  echo "--- $t exit=$code" >>"$LOG"
  [ $code -ne 0 ] && bad=$((bad + 1))
  sleep 2
done
echo "含 FAIL 的工具数：$bad / 7（日志：$LOG）"
exit $bad

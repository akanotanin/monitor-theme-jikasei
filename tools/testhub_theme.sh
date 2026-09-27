#!/bin/bash
# 在隔离测试 hub 上切主题 / 改主题设置（密码只从文件读，不打印）
# 用法：bash -s <short> [<farmUrl> | auto | reset | -]
#   /chicken/   写死这个地址       auto  写空串（=自动探测）      reset 清空整份设置      -  不动设置
set -u
HUB=http://127.0.0.1:28080
CJ=/root/.testhub-cookie.txt
SHORT=${1:-jikasei}
FARM=${2:--}
# 参数走“值”而不是整段 JSON：从 ssh 传带引号的 JSON 会被两三层 shell 剥掉引号，
# 结果服务端收到 {"farmUrl":/chicken/} 直接 400（踩过）。
case "$FARM" in
  -)    CFG="" ;;
  auto) CFG='{"farmUrl":""}' ;;
  reset) CFG='{}' ;;
  *)    CFG="{\"farmUrl\":\"$FARM\"}" ;;
esac

PW=$(cat /root/testhub-credentials.txt)
code=$(curl -s -c "$CJ" -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d "{\"password\":\"$PW\"}" "$HUB/api/auth/login")
echo "login http=$code"

code=$(curl -s -b "$CJ" -o /dev/null -w '%{http_code}' -X PUT -H 'Content-Type: application/json' \
  -d "{\"theme\":\"$SHORT\"}" "$HUB/api/settings")
echo "切换主题 -> $SHORT  http=$code"

if [ -n "$CFG" ]; then
  code=$(curl -s -b "$CJ" -o /dev/null -w '%{http_code}' -X PUT -H 'Content-Type: application/json' \
    -d "$CFG" "$HUB/api/themes/$SHORT/config")
  echo "写主题设置  http=$code  body=$CFG"
fi

echo "--- 落库复核"
python3 - <<'PY'
import sqlite3, json
c = sqlite3.connect('file:/opt/monitor/data/monitor.db?mode=ro', uri=True)
rows = dict(c.execute('select key, value from setting'))
print('setting.theme =', rows.get('theme'))
print('theme_config:jikasei =', rows.get('theme_config:jikasei'))
PY
echo "--- /api/themes 复核（selected/version）"
curl -s -b "$CJ" "$HUB/api/themes" | python3 -c "import sys,json; d=json.load(sys.stdin); print([(t['short'], t.get('version'), t.get('selected')) for t in d['themes']])"
echo "--- 首页引用的是哪一版资源"
curl -s "$HUB/" | grep -oE '/assets/[^"]+' | head -3

#!/usr/bin/env bash
# 把 linux-reference 里维护的清理脚本同步到本插件(唯一事实来源在那边).
set -euo pipefail
SRC=${1:-$HOME/github/linux-reference/script/delete_redundant_branch.sh}
DST="$(cd "$(dirname "$0")/.." && pwd)/assets/delete_redundant_branch.sh"
[ -f "$SRC" ] || { echo "找不到源脚本: $SRC" >&2; exit 1; }
cp "$SRC" "$DST"
chmod +x "$DST"
echo "已同步: $SRC -> $DST"

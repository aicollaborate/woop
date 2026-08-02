#!/usr/bin/env bash
# scripts/subset-fonts.sh
#
# 把 assets/fonts/NunitoSans*.ttf (variable TTF) 子集化为 Latin woff2,
# 让打包产物只发 ~270 KB 而非 ~1.1 MB 的原 TTF。Nunito Sans 不含 CJK
# 字形, 中文一律走 styles/fonts.css 里 font-stack 的系统回退 (PingFang /
# Microsoft YaHei / -apple-system), 故 Latin 子集足够。
#
# 字重 (wght) / 字宽 (wdth) / opsz 轴全部保留, font-weight: 300 800 仍可
# 无级取值。原 TTF 不删除, 留作本脚本重新生成的输入 (不被 fonts.css 引用,
# 不会进 Vite 产物)。
#
# 依赖: fonttools + brotli (woff2 编码)。用一次性 venv 隔离, 不污染系统:
#
#   python3 -m venv /tmp/flowix-font-venv
#   source /tmp/flowix-font-venv/bin/activate
#   pip install -q fonttools brotli
#
# 然后运行: bash scripts/subset-fonts.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FONT_DIR="$REPO_ROOT/app/flowix-web/assets/fonts"

# Latin + Latin Extended + 常用标点 / 货币 / 箭头 / 数学 / 连字 / ZWNBSP。
# 覆盖移动端 / 桌面端 UI 全部拉丁字符; 字体里没有的码位 pyftsubset 会自动忽略。
LATIN_UNICODES='U+0000-00FF,U+0100-024F,U+0300-036F,U+1E00-1EFF,U+2000-206F,U+2070-209F,U+20A0-20CF,U+2100-214F,U+2190-21FF,U+2200-22FF,U+FB00-FB4F,U+FEFF,U+FFFD'

if ! command -v pyftsubset >/dev/null 2>&1; then
  echo "❌ pyftsubset 未找到。先建 venv: python3 -m venv /tmp/flowix-font-venv && source /tmp/flowix-font-venv/bin/activate && pip install fonttools brotli" >&2
  exit 1
fi

cd "$FONT_DIR"

subset () {
  local src="$1" out="$2"
  echo "→ $src -> $out"
  pyftsubset "$src" \
    --output-file="$out" \
    --flavor=woff2 \
    --unicodes="$LATIN_UNICODES" \
    --layout-features='*' \
    --no-subset-tables+=fvar,STAT \
    --drop-tables+=DSIG
}

subset NunitoSans.ttf        NunitoSans.woff2
subset NunitoSans-Italic.ttf NunitoSans-Italic.woff2

echo "✓ 子集化完成:"
ls -lh NunitoSans.woff2 NunitoSans-Italic.woff2

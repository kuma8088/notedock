#!/bin/sh
# Mod の zip を作る。同じ中身なら同じ指紋になる（並び順・日時・権限・タイムゾーンをそろえる）。
# 使い方: sh scripts/pack-mod.sh [バージョン]
#   バージョンを省くと、<mod>/.claude-plugin/plugin.json の "version" を使う。
#   NOTEDOCK_MOD_DIR: Mod の場所（省くと ../../mod、無ければ ../../mod/notedock）、NOTEDOCK_OUT_DIR: 書き出し先（省くと dist）。
# 入れるもの: .claude-plugin/plugin.json、hooks/（*.test.ts を除く）、types/。
set -eu
export TZ=UTC LC_ALL=C

here=$(cd "$(dirname "$0")" && pwd)
# 公開用の並びは mod/.claude-plugin/plugin.json、作業用の並びは mod/notedock/.claude-plugin/plugin.json
if [ -n "${NOTEDOCK_MOD_DIR:-}" ]; then
  mod=$NOTEDOCK_MOD_DIR
elif [ -f "$here/../../mod/.claude-plugin/plugin.json" ]; then
  mod="$here/../../mod"
else
  mod="$here/../../mod/notedock"
fi
out=${NOTEDOCK_OUT_DIR:-"$here/../dist"}
plugin="$mod/.claude-plugin/plugin.json"

[ -f "$plugin" ] || { echo "pack-mod: $plugin がありません" >&2; exit 1; }
version=${1:-$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$plugin" | head -n 1)}
[ -n "$version" ] || { echo "pack-mod: バージョンが決まりません" >&2; exit 1; }
[ -d "$mod/hooks" ] && [ -d "$mod/types" ] || { echo "pack-mod: hooks/ か types/ がありません" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM
mkdir -p "$work/.claude-plugin" "$work/hooks" "$work/types" "$out"
cp "$plugin" "$work/.claude-plugin/plugin.json"
(cd "$mod" && find hooks types -type f ! -name '*.test.ts' | sort) | while IFS= read -r f; do
  mkdir -p "$work/$(dirname "$f")"
  cp "$mod/$f" "$work/$f"
done

# 日時と権限をそろえる（1980-01-01 は zip で表せる最も古い日付）
find "$work" -type d -exec chmod 755 {} +
find "$work" -type f -exec chmod 644 {} +
find "$work" -exec touch -t 198001010000 {} +

zipfile=$(cd "$out" && pwd)/notedock-mod-$version.zip
rm -f "$zipfile"
(cd "$work" && find .claude-plugin hooks types -type f | sort | zip -X -q -@ "$zipfile")
echo "pack-mod: $zipfile"

#!/bin/sh
# Denoで、サーバーと確認用プログラム（スモークテスト）の実行ファイルを作る。出力は dist/。
#   使い方：npm run compile（または sh scripts/compile.sh）。--print-plan だけを付けると、何も作らず計画だけを出す。
#   DENO                    使うDeno（なければ PATH の deno）
#   TARGETS                 作る種類を空白区切りで絞る（既定は4つ全部）
#   DENO_DIR                Denoのキャッシュの場所（なければ deno info の denoDir）
#   NOTEDOCK_ALLOW_DOWNLOAD 1 のときだけ、土台（denort）のダウンロードを許す（Actions用）。
#                           それ以外は、キャッシュにない土台があれば作らずに止まる。
#   NOTEDOCK_DEV_BUILD      1 のとき、サーバーのバージョンを Modの release.ts の VERSION にそろえてから作る。
#                           書き換えるのは作っているあいだだけで、終わったら（失敗・中断でも）version.mjs を元の中身に戻す。
#                           1 でなく、SERVER_VERSION が 0.0.0-dev のままなら、作らずに止まる。
set -eu

cd "$(dirname "$0")/.."

PLAN=0
case "${1:-}" in
  --print-plan) PLAN=1 ;;
  "") ;;
  *)
    echo "知らない引数です: $1（使えるのは --print-plan だけです）" >&2
    exit 2
    ;;
esac

DENO="${DENO:-$(command -v deno || true)}"
TARGETS="${TARGETS:-aarch64-apple-darwin x86_64-apple-darwin aarch64-pc-windows-msvc x86_64-pc-windows-msvc}"
# 公開用の並びは ../mod/hooks/release.ts、作業用の並びは ../mod/notedock/hooks/release.ts（pack-mod.sh と同じ見分け方）
if [ -f ../mod/.claude-plugin/plugin.json ]; then
  RELEASE_TS="../mod/hooks/release.ts"
else
  RELEASE_TS="../mod/notedock/hooks/release.ts"
fi

for target in $TARGETS; do
  case "$target" in
    aarch64-apple-darwin | x86_64-apple-darwin | aarch64-pc-windows-msvc | x86_64-pc-windows-msvc) ;;
    *)
      echo "知らない種類です: $target" >&2
      exit 1
      ;;
  esac
done

# 出力の名前。Windowsの種類だけ .exe が付く（write-release.mjs が読む名前と同じ）
ext_of() {
  case "$1" in
    *windows*) printf '.exe' ;;
  esac
}

# 作るサーバーのバージョンを決める
SERVER_VERSION="$(sed -n "s/^export const SERVER_VERSION = '\(.*\)'\$/\1/p" server/version.mjs)"
if [ "${NOTEDOCK_DEV_BUILD:-}" = "1" ]; then
  USE_VERSION="$(sed -n 's/^export const VERSION = "\(.*\)"$/\1/p' "$RELEASE_TS" 2>/dev/null || true)"
  if [ -z "$USE_VERSION" ]; then
    echo "Modの VERSION が読めません: $RELEASE_TS" >&2
    exit 1
  fi
else
  USE_VERSION="$SERVER_VERSION"
fi

if [ "$PLAN" -eq 1 ]; then
  echo "deno: ${DENO:-（見つかりません）}"
  echo "version: $USE_VERSION"
  for target in $TARGETS; do
    echo "target: $target"
    echo "output: dist/notedock-server-$target$(ext_of "$target")"
    echo "output: dist/notedock-smoke-$target$(ext_of "$target")"
  done
  exit 0
fi

if [ "$USE_VERSION" = "0.0.0-dev" ] || [ -z "$USE_VERSION" ]; then
  echo "サーバーのバージョンが 0.0.0-dev のままです。作りません。" >&2
  echo "リリースなら node scripts/set-version.mjs <バージョン> を先に実行し、手元の試しなら NOTEDOCK_DEV_BUILD=1 を付けてください。" >&2
  exit 1
fi

if [ -z "$DENO" ] || [ ! -x "$DENO" ]; then
  echo "Denoが見つかりません。環境変数 DENO か PATH で指定してください: ${DENO:-}" >&2
  exit 1
fi

if [ "${NOTEDOCK_ALLOW_DOWNLOAD:-}" = "1" ]; then
  : # 土台は、必要ならDenoが取りに行く
else
  DENO_VERSION="$("$DENO" --version | head -n 1 | awk '{print $2}')"
  if [ -n "${DENO_DIR:-}" ]; then
    DIR="$DENO_DIR"
  else
    DIR="$("$DENO" info --json | sed -n 's/.*"denoDir": *"\([^"]*\)".*/\1/p' | head -n 1)"
  fi
  if [ -z "$DIR" ]; then
    echo "Denoのキャッシュの場所が分かりません。環境変数 DENO_DIR で指定してください。" >&2
    exit 1
  fi
  CACHE="$DIR/dl/release/v$DENO_VERSION"
  missing=0
  for target in $TARGETS; do
    if [ ! -f "$CACHE/denort-$target.zip" ]; then
      echo "土台のファイルがキャッシュにありません: $CACHE/denort-$target.zip" >&2
      missing=1
    fi
  done
  if [ "$missing" -ne 0 ]; then
    echo "ダウンロードはしません。土台のファイルを用意するか、NOTEDOCK_ALLOW_DOWNLOAD=1 を付けて、もう一度実行してください。" >&2
    exit 1
  fi
  # 念のため、Denoが外へつながれないようにする（キャッシュにないものを取りに行かせない）。
  HTTP_PROXY=http://127.0.0.1:9
  HTTPS_PROXY=http://127.0.0.1:9
  ALL_PROXY=http://127.0.0.1:9
  http_proxy=$HTTP_PROXY
  https_proxy=$HTTPS_PROXY
  all_proxy=$ALL_PROXY
  NO_PROXY=
  no_proxy=
  export HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NO_PROXY no_proxy
fi

# 開発ビルドは、作るあいだだけ version.mjs を書き換え、終わったら（失敗・中断でも）元の中身に戻す。
# 実行ファイルには作る時点のバージョンが入るので、戻しても影響しない。
if [ "${NOTEDOCK_DEV_BUILD:-}" = "1" ]; then
  VERSION_BACKUP="$(mktemp)"
  cp server/version.mjs "$VERSION_BACKUP"
  trap 'cp "$VERSION_BACKUP" server/version.mjs; rm -f "$VERSION_BACKUP"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  node scripts/set-version.mjs "$USE_VERSION"
fi

mkdir -p dist
# node_modules は丸ごとは入れない（200MB を超える）。サーバーが読み込む部品（リンクの数え方に使う Markdown の読み取り、
# src/markdown-syntax.mjs）だけを入れる。サーバーが読み込む部品を増やしたら、ここにも足す（足りないと、起動したときに止まる）。
SERVER_MODULES="--include node_modules/@lezer/markdown --include node_modules/@lezer/common --include node_modules/@lezer/highlight"
for target in $TARGETS; do
  e="$(ext_of "$target")"
  # shellcheck disable=SC2086
  "$DENO" compile --allow-all --no-check --include public --exclude node_modules $SERVER_MODULES \
    --target "$target" --output "dist/notedock-server-$target$e" server/main.mjs
  "$DENO" compile --allow-all --no-check --exclude node_modules \
    --target "$target" --output "dist/notedock-smoke-$target$e" test/smoke/binary.mjs
done

ls -l dist

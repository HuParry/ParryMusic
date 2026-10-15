#!/usr/bin/env bash
# 私人上传工具：只上传网站运行所需文件，不上传本脚本。
# 将配置填在下方；使用 ossutil 2.x，无需环境变量或运行歌单生成脚本。
set +x
set -euo pipefail

# ---------- 在这里填写配置 ----------
OSSUTIL_BIN='ossutil'                 # 也可填二进制绝对路径，例如 /usr/local/bin/ossutil
BUCKET='YOUR_BUCKET'
PREFIX=''                            # Bucket 根目录留空；子目录示例：parrymusic
REGION='cn-hangzhou'                  # Bucket 所在地域
ENDPOINT=''                          # 留空使用该地域的公网 Endpoint；也可填写完整 https:// 地址
ACCESS_KEY_ID='YOUR_ACCESS_KEY_ID'
ACCESS_KEY_SECRET='YOUR_ACCESS_KEY_SECRET'
STS_TOKEN=''                         # 使用临时凭据时填写，否则留空
# ------------------------------------

usage() {
  printf '%s\n' \
    '用法：./upload-oss.sh [--dry-run] [--full]' \
    '先编辑脚本顶部的 Bucket、地域和 AccessKey 配置。' \
    '默认增量上传；--full 覆盖上传全部网站文件；--dry-run 只显示计划。' \
    '不会删除 OSS 已有对象，也不会生成或修改 music/playlist.js。'
}

dry_run=false
incremental=true
for argument in "$@"; do
  case "$argument" in
    --dry-run) dry_run=true ;;
    --full) incremental=false ;;
    -h|--help) usage; exit 0 ;;
    *) printf '未知参数：%s\n' "$argument" >&2; usage >&2; exit 2 ;;
  esac
done

project_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
cd "$project_dir"

for file in index.html config.js manifest.json music/playlist.js; do
  if [[ ! -f "$file" ]]; then printf '缺少网站文件：%s\n' "$file" >&2; exit 1; fi
done
for directory in css js img music; do
  if [[ ! -d "$directory" ]]; then printf '缺少网站目录：%s\n' "$directory" >&2; exit 1; fi
done

if ! "$dry_run"; then
  if [[ "$BUCKET" == 'YOUR_BUCKET' || -z "$BUCKET" || "$BUCKET" == *'/'* ]]; then
    printf '%s\n' '请填写正确的 BUCKET 名称（不含 oss:// 或目录）。' >&2; exit 2
  fi
  if [[ -z "$ACCESS_KEY_ID" || "$ACCESS_KEY_ID" == 'YOUR_ACCESS_KEY_ID' || -z "$ACCESS_KEY_SECRET" || "$ACCESS_KEY_SECRET" == 'YOUR_ACCESS_KEY_SECRET' ]]; then
    printf '%s\n' '请填写脚本顶部的 ACCESS_KEY_ID 和 ACCESS_KEY_SECRET。' >&2; exit 2
  fi
  if [[ -z "$REGION" ]]; then printf '%s\n' '请填写 Bucket 所在的 REGION。' >&2; exit 2; fi
  if ! command -v "$OSSUTIL_BIN" >/dev/null 2>&1; then
    printf '%s\n' '找不到 ossutil 二进制，请安装 ossutil 2.x 或修改 OSSUTIL_BIN。' >&2; exit 127
  fi
fi

PREFIX=${PREFIX#/}
PREFIX=${PREFIX%/}
destination="oss://$BUCKET/"
if [[ -n "$PREFIX" ]]; then destination="$destination$PREFIX/"; fi
if [[ -z "$ENDPOINT" ]]; then ENDPOINT="https://oss-$REGION.aliyuncs.com"; fi
auth=(--region "$REGION" -e "$ENDPOINT" -i "$ACCESS_KEY_ID" -k "$ACCESS_KEY_SECRET")
if [[ -n "$STS_TOKEN" ]]; then auth+=(-t "$STS_TOKEN"); fi
sync_options=(--force)
if "$incremental"; then sync_options+=(--update); fi

run_ossutil() {
  # 上传计划只显示操作参数，不输出 AccessKey 或 Token。
  printf '执行：'
  printf '%q ' "$OSSUTIL_BIN" "$@"
  printf '\n'
  if ! "$dry_run"; then "$OSSUTIL_BIN" "$@" "${auth[@]}"; fi
}

printf '网站目录：%s\n上传目标：%s\n' "$project_dir" "$destination"

# 只扫描四个资源目录，Git、IDE、测试、scripts 和本脚本不在扫描范围。
# 歌单最后发布，避免新歌单指向尚未传完的资源。
for directory in music css js img; do
  run_ossutil sync "$directory/" "$destination$directory/" "${sync_options[@]}" \
    --exclude '.*' --exclude '*/.*' --exclude '*.sh' \
    --exclude 'README*' --exclude 'playlist.js'
done

# 小型入口文件每次覆盖，避免时间戳比较漏掉配置与歌单更新。
for file in config.js manifest.json index.html music/playlist.js; do
  run_ossutil cp "$file" "$destination$file" --force
done

if "$dry_run"; then
  printf '%s\n' '预览完成，未连接 OSS、未上传文件。'
else
  printf '%s\n' '上传完成。'
fi

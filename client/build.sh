#!/usr/bin/env bash
# SnapVault Client 打包与交叉编译脚本 (Bash, 适用于 macOS / Linux)
# 作用: 编译纯 Go 零依赖客户端为全平台独立执行程序 (Windows / Linux / macOS × amd64 / arm64)

set -euo pipefail

# 用法: ./build.sh [版本号] [输出目录]
VERSION="${1:-v1.0.0}"
OUTPUT_DIR="${2:-./dist}"

echo "=================================================="
echo "  SnapVault 客户端编译发布打包脚本 ($VERSION)     "
echo "=================================================="

mkdir -p "$OUTPUT_DIR"

LDFLAGS="-s -w -X main.version=$VERSION"
FILE_VERSION="${VERSION#v}"    # 文件名中的版本号去掉 v 前缀 (v1.1.0 -> 1.1.0)

# 目标矩阵: GOOS GOARCH 扩展名
TARGETS=(
    "windows amd64 .exe"
    "windows arm64 .exe"
    "linux   amd64 "
    "linux   arm64 "
    "darwin  amd64 "
    "darwin  arm64 "
)

for target in "${TARGETS[@]}"; do
    read -r goos goarch ext <<< "$target"
    name="snap-vault-${FILE_VERSION}-${goos}-${goarch}${ext}"
    echo "-> 正在编译 ${goos} (${goarch})..."
    GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 \
        go build -ldflags "$LDFLAGS" -o "$OUTPUT_DIR/$name" ./cmd/snap-vault
done

echo "--------------------------------------------------"
echo "✓ 编译全部成功！产物位于: $OUTPUT_DIR"
ls -lh "$OUTPUT_DIR" | awk 'NR==1 || /snap-vault/ {print $5, $9}'

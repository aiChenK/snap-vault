# SnapVault Client 打包与交叉编译脚本 (PowerShell)
# 作用: 编译纯 Go 零依赖客户端为全平台独立执行程序 (Windows / Linux / macOS × amd64 / arm64)

param (
    [string]$Version = "v1.0.0",
    [string]$OutputDir = "./dist"
)

$ErrorActionPreference = "Stop"

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  SnapVault 客户端编译发布打包脚本 ($Version)     " -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

$ldflags = "-s -w -X main.version=$Version"
$fileVersion = $Version -replace '^v', ''  # 文件名中的版本号去掉 v 前缀 (v1.1.0 -> 1.1.0)

# 目标矩阵: GOOS / GOARCH / 可执行文件扩展名
$targets = @(
    @{ GOOS = "windows"; GOARCH = "amd64"; Ext = ".exe" },
    @{ GOOS = "windows"; GOARCH = "arm64"; Ext = ".exe" },
    @{ GOOS = "linux";   GOARCH = "amd64"; Ext = "" },
    @{ GOOS = "linux";   GOARCH = "arm64"; Ext = "" },
    @{ GOOS = "darwin";  GOARCH = "amd64"; Ext = "" },
    @{ GOOS = "darwin";  GOARCH = "arm64"; Ext = "" }
)

foreach ($t in $targets) {
    $name = "snap-vault-$fileVersion-$($t.GOOS)-$($t.GOARCH)$($t.Ext)"
    Write-Host "-> 正在编译 $($t.GOOS) ($($t.GOARCH))..." -ForegroundColor Yellow
    $env:GOOS = $t.GOOS
    $env:GOARCH = $t.GOARCH
    $env:CGO_ENABLED = "0"
    go build -ldflags $ldflags -o "$OutputDir/$name" ./cmd/snap-vault
}

# 清理环境变量，避免污染后续 go build 行为
Remove-Item Env:\GOOS -ErrorAction SilentlyContinue
Remove-Item Env:\GOARCH -ErrorAction SilentlyContinue
Remove-Item Env:\CGO_ENABLED -ErrorAction SilentlyContinue

Write-Host "--------------------------------------------------" -ForegroundColor Green
Write-Host "✓ 编译全部成功！产物位于: $OutputDir" -ForegroundColor Green
Get-ChildItem $OutputDir | Where-Object { $_.Name -like "snap-vault-*" } | Select-Object Name, Length | Format-Table -AutoSize

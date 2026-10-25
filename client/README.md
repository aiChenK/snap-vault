# SnapVault 客户端 (Go Client)

SnapVault 客户端是一个轻量、零外部运行时依赖的单文件可执行程序，专为游戏玩家与多设备截图用户设计。

## 核心设计与特性

1. **三分支状态机与 Fast-Path 协议**：
   - **分支 A (No-op)**：当本地截图数量与最新修改时间和服务端完全一致时，在 10 毫秒内跳过并退出，零网络开销。
   - **分支 B (Fast-Append)**：日常持续游戏截图时，精准识别按时间戳单调递增的新增截图，**无需拉取服务端大 JSON 清单**，直接并发转码并上传。
   - **分支 C (Full-Reconcile)**：当本地删除截图或目录发生异常变动时，降级拉取远端清单对齐，实现删除双向传播：本地删除 → 服务端同步软删除（移入回收站）；服务端删除 → 本地文件自动移入系统回收站（macOS 废纸篓 / Windows 回收站 / `gio trash`，环境不支持时回退至截图目录下 `.snapvault-trash/`），杜绝幽灵文件复活重传。本地确认删除后自动上报墓碑确认，服务端永久清除清单条目与回收站文件（Tombstone GC），清单与回收站不再无限膨胀。
2. **算力下沉与隐私剥离**：
   - 原生支持 JPG, PNG, GIF (取首帧), WebP 解码。
   - 重新编码为 JPEG 质量 85，彻底剥离 EXIF 隐私元数据（如经纬度、设备硬件信息等）。
   - 本地自动生成高质量等比缩略图（Catmull-Rom 双三次滤波，下采样边缘锐利无模糊），默认 `high` 档位最长边提升至 512px（质量 85），彻底消除 2K/4K/Retina 高分屏下拉伸模糊，极大减轻自托管服务端与 VPS 的 CPU/内存压力。
3. **缩略图画质等级可配置**：
   - 支持通过 `config.json` 的 `"thumb_level"` 或 CLI 参数 `-thumb-level` 自定义等级：
     - `low`: 最长边 256px / 质量 75（轻量省流）
     - `medium`: 最长边 384px / 质量 80（平衡档）
     - `high`: 最长边 512px / 质量 85（**默认**，推荐高清）
     - `ultra`: 最长边 768px / 质量 90（超清原画级）
   - 兼容配置 `thumb_quality`，支持中文别名（如 `"高清"` / `"超清"`）及数字别名（`1`~`4`）。
4. **开箱即用首次运行向导 (Onboarding Wizard)**：
   - 双击或首次无配置文件启动时，自动进入交互式引导。
   - 自动获取本机 Hostname 并生成唯一防碰撞设备名（如 `desktop-e4b2`）。
   - 直接按回车即可使用当前目录作为截图源。
   - 自动保存至 `config.json` 并无缝开启首次同步。
5. **防闪退设计**：
   - Windows 环境下双击运行结束时始终提示“按回车键退出”，避免窗口闪退。
6. **误删安全熔断门槛 (Deletion Circuit Breaker)**：
   - 分支 C 的双向删除均受熔断保护：待删除数量超过总数 20% 且大于 30 张时，强制要求用户输入 `-force-delete` 参数，防止选错目录或服务端清单异常导致误删云端 / 本地文件。

## 编译与打包

客户端为纯 Go 零依赖实现 (CGO 关闭)，任意平台宿主机均可一键交叉编译出全部目标产物。

### 全平台交叉编译 (Windows / Linux / macOS × amd64 / arm64)

```bash
# macOS / Linux 终端执行
./build.sh [版本号] [输出目录]     # 例如: ./build.sh v1.1.0 ./dist
```

```powershell
# Windows PowerShell 执行
.\build.ps1 -Version v1.1.0 -OutputDir ./dist
```

两条脚本产物完全一致，均输出至 `dist/`。文件名自带版本号（取自版本参数并去掉 `v` 前缀），下表以传入 `v1.1.0` 为例：

| 产物文件 | 目标平台 |
| :--- | :--- |
| `snap-vault-1.1.0-windows-amd64.exe` | Windows x64 (主流游戏玩家) |
| `snap-vault-1.1.0-windows-arm64.exe` | Windows ARM64 (掌机 / 骁龙 X Elite) |
| `snap-vault-1.1.0-linux-amd64` | Linux x64 |
| `snap-vault-1.1.0-linux-arm64` | Linux ARM64 (开发板 / ARM 服务器) |
| `snap-vault-1.1.0-darwin-amd64` | macOS Intel |
| `snap-vault-1.1.0-darwin-arm64` | macOS Apple Silicon |

### 本地构建 (仅当前宿主平台)

```bash
go build -ldflags "-s -w -X main.version=v1.0.0" -o bin/snap-vault ./cmd/snap-vault
```

### 平台行为差异说明

- **Windows**：程序结束时会提示"按回车键退出"，防止双击 exe 运行时窗口闪退 (CI 环境自动跳过)。
- **macOS / Linux**：程序结束直接退出，不阻塞终端，可安全用于 shell 脚本、cron 定时任务与 CI 流水线。

## 命令行参数一览

| 参数 | 默认值 | 作用说明 |
| :--- | :--- | :--- |
| `-server` | 无 | 服务端 API 地址 (如 `http://192.168.1.100:3000`) |
| `-key` | 无 | 服务端 API 密钥 (`X-API-Key`) |
| `-machine` | 自动生成 | 机器标识符 (用于多设备隔离存储) |
| `-dir` | 当前目录 | 本地截图文件夹路径 |
| `-workers` | `2` | 并发上传线程数 (1 ~ 8) |
| `-thumb-level` | `high` | 缩略图画质等级 (`low`, `medium`, `high`, `ultra`) |
| `-dry-run` | `false` | 演练模式 (仅对比，不执行上传与删除) |
| `-force-delete` | `false` | 强制删除 (绕过待删除 > 20% 且 > 30 张的熔断门槛) |
| `-config` | `config.json` | 配置文件路径 |

# Changelog

本文件记录 SnapVault 的所有重要变更。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## 1.0.0（2026-10-25）

首个正式版本：多机游戏截图同步 + 自托管 Web 画廊。

- **Features（新特性）**：
  - Go 桌面客户端：三分支同步状态机（分支 A 完全一致秒退 / 分支 B 时间戳递增免清单快速上传 / 分支 C 全量清单双向对齐）
  - 删除双向同步：本地删除 → 服务端软删除；服务端删除 → 本地移入系统回收站（不支持时回退 `.snapvault-trash/`），杜绝幽灵文件复活；客户端确认后服务端自动清理墓碑与回收站（Tombstone GC）
  - 删除安全熔断：任一方向待删除超过总数 20% 且大于 30 张时自动中止，需 `force-delete` 显式放行
  - 算力下沉：客户端本地完成多格式解码、剥离 EXIF 隐私并预生成高质量缩略图（Catmull-Rom 插值，默认 512px，支持 low/medium/high/ultra 等级调节）
  - Node.js/Express 自托管服务端：多机器隔离存储、原图/缩略图分发、清单原子写入与聚合状态查询、软删除回收站
  - 原生深色 Web 画廊（零构建 Vanilla JS/CSS）：页码分页、多设备切换、大图灯箱（键盘/滚轮缩放/双击）、原图下载与在线删除
  - 服务端数据维护 CLI（`npm run clean`，支持列表/试运行/静默清理）与 REST 清理接口 `DELETE /api/machine`
  - 客户端首次运行交互式配置向导，配置自动保存至 `config.json`
- **Security（安全）**：
  - 基于 `X-API-Key`（或查询参数）的接口鉴权，静态画廊免鉴权；生产环境未配置 `API_KEY` 拒绝启动
  - 客户端上传前剥离 EXIF（经纬度、硬件型号等隐私信息）
  - 服务端 Key 规范化校验（强制 `.jpg` 后缀）并拒绝路径穿越
- **CI/CD（工程化）**：
  - GitHub Actions CI：服务端四套测试 + 客户端单元测试
  - 推送 `v*` tag 自动完成客户端测试、全平台交叉编译并创建 GitHub Release（附二进制与 `checksums.txt` 校验和）

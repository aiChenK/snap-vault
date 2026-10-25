# SnapVault (`snap-vault`)

> 专为玩家打造的轻量级多机游戏截图同步、归档与自托管 Web 画廊系统。

[![Go Version](https://img.shields.io/badge/Go-1.26+-00ADD8?style=flat&logo=go)](https://golang.org)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=flat&logo=node.js)](https://nodejs.org)
[![PM2](https://img.shields.io/badge/PM2-Ready-2B037A?style=flat&logo=pm2)](https://pm2.keymetrics.io/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## 💡 为什么需要 SnapVault？

很多游戏玩家在台式机、笔记本或便携掌机上游玩游戏，习惯按下截屏键记录精彩瞬间。然而常规网盘同步存在难以忍受的痛点：
1. **“幽灵文件复活”**：你在主机 A 整理或删除了某张截图，由于网盘的双向比对缺陷，主机 B 开机后又将旧图重新上传复活。
2. **算力浪费与隐私泄露**：原图动辄数兆甚至几十兆，包含经纬度与硬件型号等 EXIF 隐私，服务端生成缩略图更是严重拖慢廉价自建 VPS。
3. **低效全量比对**：截图累计成千上万张后，每次同步都要下载数十兆的服务端清单 JSON，耗时严重。

**SnapVault 采用颠覆性的 Fast-Path 协议与算力下沉架构**：
- **分支 B 快速追加 (Fast-Path)**：日常截图严格按时间戳递增，客户端秒级探测服务端聚合状态后，**彻底跳过拉取服务端清单**，直接转码并发秒级上传！
- **分支 C 双向删除同步与安全熔断**：删除动作双向传播——本地删除自动对齐清除服务端云端文件（移入服务端回收站）；服务端删除同步将本地文件移入系统回收站（不支持时回退 `.snapvault-trash/`），杜绝幽灵文件复活重传；客户端确认后服务端自动清除墓碑与回收站文件（Tombstone GC），零膨胀；待删除超 20% 且大于 30 张时双向自动熔断拦截，防手滑误清空。
- **纯 Go 零依赖算力下沉**：客户端在本地完成多格式解码、自动剥离 EXIF 隐私信息并预生成高质量缩略图（Catmull-Rom 双三次插值滤波，默认 512px，彻底解决高分屏模糊，并支持配置文件与命令行自由调节等级）。
- **原生深色 Web 画廊**：零外部构建单页（Vanilla JS/CSS），支持页码分页、多设备切换、大图灯箱（键盘/滚轮缩放/双击）、原图下载与在线删除。

---

## 🏛️ 系统架构

```
+-------------------------------------------------------------+
|                     Windows Client (Go)                     |
|                                                             |
|  [Scanner] ──> [Fast-Path Detector] ──> [Image Processor]   |
|  (扫描过滤)     (分支A/B/C 状态机)       (解码/去EXIF/缩略图) |
|                         │                       │           |
|                         ▼                       ▼           |
|                 [API Client (HTTP/Multipart)]               |
+─────────────────────────┼───────────────────────────────────+
                          │  REST API (X-API-Key)
                          ▼
+-------------------------------------------------------------+
|                   Server (Node.js/Express)                  |
|                                                             |
|  [Auth/Check] ──> [/api/check & /api/manifest]              |
|        │                                                    |
|  [File Engine] ──> [/api/upload & /api/file]                |
|        │          └── 原子写入 /data/uploads/{m}/{Y}/{M}/{D}|
|  [Manifest Engine]──> 维护 /data/manifests/{machine}.json   |
|        │                                                    |
|  [Web Gallery] ──> 静态图库 (/img, /thumb, /api/list)       |
+-------------------------------------------------------------+
```

---

## 🚀 快速开始

### 1. 部署服务端 (Server)

#### 生产部署：基于 PM2 进程守护

SnapVault 服务端基于 Node.js/Express，生产环境推荐使用 **PM2** 进行进程管理与开机自启守护。

##### 步骤 1：准备运行环境
确保服务器已安装 Node.js 20+，并全局安装 PM2：
```bash
# 全局安装 PM2
npm install -g pm2
```

##### 步骤 2：配置环境变量与安装依赖
```bash
# 进入服务端目录
cd server

# 复制环境变量模板
cp .env.example .env

# 编辑 .env 文件，修改端口与强随机 API 密钥
# PORT=3000
# API_KEY=your-secure-custom-api-key
# DATA_DIR=./data
nano .env

# 安装生产环境依赖
npm install --only=production
```

##### 步骤 3：使用 PM2 启动服务
服务端内置了开箱即用的 `ecosystem.config.js` 配置文件：
```bash
# 方式 A：通过 PM2 配置文件启动（推荐，单实例 fork 模式保证 Manifest 串行原子写）
pm2 start ecosystem.config.js
# 或使用 npm script
npm run pm2:start

# 方式 B：直接通过命令行启动
pm2 start src/index.js --name snap-vault
```

##### 步骤 4：配置开机自启
```bash
# 保存当前 PM2 进程列表
pm2 save

# 生成并配置系统开机自启服务（按终端提示执行生成的命令）
pm2 startup
```

##### 常用 PM2 运维命令一览
```bash
pm2 status                  # 查看服务运行状态与内存占用
pm2 logs snap-vault         # 查看实时应用日志 (或 npm run pm2:logs)
pm2 reload snap-vault       # 平滑重载服务 (或 npm run pm2:reload)
pm2 restart snap-vault      # 重启服务 (或 npm run pm2:restart)
pm2 stop snap-vault         # 停止服务 (或 npm run pm2:stop)
```

打开浏览器访问 `http://<服务器IP>:3000` 即可进入 Web 画廊。在页面右上角填入上述 `API_KEY` 即可完成绑定。

#### 服务端数据维护：清理指定计算机数据

当某台设备不再使用或需要重置时，可在服务端直接运行清理命令，彻底删除该计算机下的所有原图、缩略图、回收站文件以及清单文件（Manifest）：

```bash
# 进入服务端目录
cd server

# 1. 查看当前已有的计算机及其存储占用统计
npm run clean -- --list

# 2. 试运行模式预览指定计算机将要释放的文件与空间 (不实际删除)
npm run clean -- -m <计算机名称> --dry-run

# 3. 交互式清理 (会列出待删文件数并提示二次确认 y/N)
npm run clean -- -m <计算机名称>

# 4. 自动化/非交互式静默清理 (-y 跳过确认)
npm run clean -- -m <计算机名称> -y
```

> **提示**：除了 CLI 命令外，服务端亦提供带有 API Key 鉴权的 REST 接口：`DELETE /api/machine?machine=<计算机名称>`。

---

### 2. 使用客户端 (Client)

#### 开箱即用首次运行引导 (Onboarding Wizard)
1. 从 [Releases](../../releases) 下载对应平台的二进制（文件名含版本号，如 Windows x64 为 `snap-vault-1.0.0-windows-amd64.exe`；也可参照 [client/README.md](client/README.md) 自行编译），直接放到截图目录中（或任意路径）。
2. **双击运行**，客户端会自动弹出交互引导：
   ```text
   ==================================================
         欢迎使用 SnapVault 游戏截图同步客户端       
   检测到本地尚未配置 config.json，现在开始首次引导设置
   ==================================================
   1. 请输入服务端 API 地址 (例如 http://192.168.1.100:3000): http://your-ip:3000
   2. 请输入 API 密钥 (API Key): your-custom-secret-key-123
   3. 请输入截图本地目录路径 [直接回车使用当前目录: D:\Games\Screenshots]: (直接按回车)
   4. 请输入计算机名称 (用于多设备隔离存储) [直接回车使用: desktop-e4b2]: (直接按回车)
   --------------------------------------------------
   ✓ 配置已成功保存至 config.json！
   ✓ 即刻自动开启首次无缝同步流程...
   ==================================================
   ```
3. 配置自动保存为同目录的 `config.json`，以后双击即可静默同步！

#### 命令行调用模式
```bash
snap-vault -server "http://your-ip:3000" -key "your-key" -machine "pc-desktop" -dir "D:/Screenshots"
```

---

## 📋 详细开发规格与设计文档

- 👉 客户端构建与参数说明：[client/README.md](client/README.md)
- 👉 发布流程：推送 `v*` tag（如 `v1.0.0`）即可由 [.github/workflows/release.yml](.github/workflows/release.yml) 自动完成客户端测试、全平台编译并创建 GitHub Release（附 `checksums.txt` 校验和）

---

## 📄 开源许可 (License)

本项目基于 [MIT](LICENSE) 许可证开源发布。

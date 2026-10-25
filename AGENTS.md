# AGENTS.md

SnapVault：多机游戏截图同步 + 自托管 Web 画廊。Monorepo，两部分：
- `client/` — Go 桌面客户端（Windows 为主），入口 `client/cmd/snap-vault/main.go`，模块名 `snap-vault`。
- `server/` — Node.js/Express 服务端（CommonJS），入口 `server/src/index.js`。
- `.agent_plan/DEVELOPMENT_PLAN.md` 是权威设计文档；根 `README.md` 有架构图。
- `update.sh`、`.agent_plan/`、`.agent_docs/` 为本机私有文件，不随公开仓库分发（.gitignore 已排除）。

## 命令（注意 workdir）

服务端（`server/`）：
- `npm install` → `npm start`（= `node src/index.js`）
- `npm test` 串行跑全部四套：`api_test.js` + `clean_test.js` + `web_test.js` + `gallery_features_test.js`
- 清理某机器数据：`npm run clean -- --list` / `npm run clean -- -m <name> [--dry-run] [-y]`
- 测试使用固定端口 3397~3402，`DATA_DIR` 指向 `test/test_*`，运行时会删除这些目录

客户端（`client/`）：
- 全平台交叉编译：`./build.sh [version] [outdir]`（或 `build.ps1`），产物在 `dist/`（git 已忽略的本地产物，内含真实 `config.json`，勿外发/勿提交）
- 本地构建：`go build -ldflags "-s -w -X main.version=vX.Y.Z" -o bin/snap-vault ./cmd/snap-vault`
- 单元测试：`go test ./...`
- 端到端：`go test ./test/` — 会自行启动 node 服务端（:3397）并 `go build` 客户端，需本机有 node
- 版本号**只能**通过 `-ldflags "-X main.version=..."` 注入，默认 `dev`

## 架构与约定（易踩坑）

- **三分支同步状态机** (`client/internal/detector`)：A=完全一致秒退；B=纯时间戳递增新增，**不拉取清单**直接上传；C=拉全量清单双向对齐（本地删除→服务端软删除；服务端删除→本地移入回收站；墓碑确认 GC）。改同步逻辑时三分支都要考虑。
- **虚拟 Key 规范化**：所有扩展名（.png/.jpeg/.webp/.gif）统一成 `{base}.jpg`。服务端 `sanitizeKey` 强制 key 以 `.jpg` 结尾并拒绝路径穿越。改动 Key 规则必须两端同步。
- **删除熔断**：分支 C 中任一方向待删除 > 总数 20% 且 > 30 张时，必须 `-force-delete` 才继续，否则中止。两方向都受保护。
- **机器名**：两端都校验 `^[a-zA-Z0-9_-]{1,64}$`，非法会 400/报错。
- **鉴权**：`X-API-Key` 头，或 `?key=`/`?apiKey=` 查询参数。静态画廊 `/` 免鉴权；`/img` `/thumb` `/download` `/api/*` 需 key。
- **数据布局**：`data/{uploads,thumbs,manifests,trash}/{machine}/...`；原图落在 `uploads/{machine}/{Y}/{M}/{D}/{key}`。
- **清单**：每机器进程内串行锁 + 原子写（临时文件 + rename）；聚合 `count/latestMtime/oldestMtime` 与墓碑 `remoteDeletedLatestMtime` 由 `manifest.js` 维护。
- **算力下沉**：客户端负责解码/剥离 EXIF/生成高质量缩略图（默认 high 等级 512px，支持 low/medium/high/ultra 等级），服务端只存储分发，**不生成缩略图**。
- 前端 `server/public/` 为原生 JS/CSS **零构建**，勿引入打包步骤。

## 环境与部署

- 客户端配置优先级：CLI flags > `config.json` > 交互向导；字段 `server,key,machine,dir,workers,dry_run,force_delete,thumb_level`。
- 服务端 `.env` 自动从 cwd / `server/` / 上级目录加载；变量 `PORT,API_KEY,DATA_DIR,MAX_FILE_SIZE`（默认 50MB）。`API_KEY` 未配置或保留占位值时，`NODE_ENV=production` 下拒绝启动（开发环境警告并跳过鉴权）。
- `update.sh` **仅**同步 `server/` 到远端服务器（目标主机与路径为脚本内本机私有配置），永远排除 `node_modules/`、`data/`、`.env`；改后端加 `-r` 重启 PM2，改依赖加 `-i`。client 不部署。
- Windows 客户端退出前等待回车防闪退（`CI=true` 时跳过）。
- `client/go.mod` 声明 `go 1.26.0`，旧工具链可能无法构建。CI（`.github/workflows/ci.yml`）会跑 `npm test` 与 `go test ./...`。
- 发版：推送 `v*` tag 触发 `.github/workflows/release.yml`，自动跑客户端测试 + `build.sh` 全平台编译（版本号 = tag 名）并创建 GitHub Release（含二进制与 `checksums.txt`）。发布失败重发需删除远端 tag 后重推。

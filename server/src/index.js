const express = require('express');
const path = require('path');
const { rateLimit } = require('express-rate-limit');
const config = require('./config');
const { ensureDir } = require('./files');
const authMiddleware = require('./auth');
const apiRoutes = require('./routes/api');
const webRoutes = require('./routes/web');

async function startServer() {
  // 确保所有基础数据目录存在
  await Promise.all([
    ensureDir(config.uploadsDir),
    ensureDir(config.thumbsDir),
    ensureDir(config.manifestsDir),
    ensureDir(config.trashDir),
  ]);

  const app = express();

  // 跨域支持 (CORS)
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-API-Key, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // 解析基础 Body
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // 健康检查接口 (免鉴权)
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // 静态 Web 画廊资源 (无需鉴权即可加载静态页面，API 请求由页面端携带 Key)
  const publicDir = path.join(__dirname, '../public');
  app.use(express.static(publicDir));

  // 图片分发与下载路由 (支持 Header 或 Query key 鉴权)
  app.use('/', authMiddleware, webRoutes);

  // REST API 限流: 抑制公网暴力猜测 API Key (画廊一次翻页仅 2~3 个 /api 请求, 阈值足够宽松)
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 600,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests, please try again later' },
  });

  // REST API 路由 (严格鉴权)
  app.use('/api', apiLimiter, authMiddleware, apiRoutes);

  // 统一错误处理: 校验类错误应抛出携带 status 的 ApiError; 5xx 不向客户端泄露内部错误详情
  app.use((err, req, res, next) => {
    // multer 上传超限属于客户端错误, 显式映射 413
    const statusCode = err.status
      || (err.name === 'MulterError' && err.code === 'LIMIT_FILE_SIZE' ? 413 : 0)
      || 500;
    if (statusCode >= 500) {
      console.error(`[Error] ${req.method} ${req.url}:`, err.message);
    } else {
      console.warn(`[Client Error] ${req.method} ${req.url}: ${err.message}`);
    }
    res.status(statusCode).json({
      success: false,
      error: statusCode >= 500 ? 'Internal Server Error' : (err.message || 'Internal Server Error'),
    });
  });

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`[SnapVault Server] Listening on http://0.0.0.0:${config.port}`);
    console.log(`[SnapVault Server] Data directory: ${config.dataDir}`);
  });

  // 优雅停机: PM2 stop/reload 发送 SIGINT/SIGTERM, 先排空在途请求再退出
  const shutdown = (signal) => {
    console.log(`[SnapVault] 收到 ${signal}, 正在优雅停机...`);
    server.close(() => process.exit(0));
    setTimeout(() => {
      console.warn('[SnapVault] 连接排空超时, 强制退出');
      process.exit(1);
    }, 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { app, server };
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error('Failed to start SnapVault server:', err);
    process.exit(1);
  });
}

module.exports = { startServer };

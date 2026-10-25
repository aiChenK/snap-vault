const crypto = require('crypto');
const config = require('./config');

/**
 * 常量时间比较, 防止逐字符时序侧信道猜测 API Key
 */
function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // 长度不等时也执行一次同长度比较, 保持耗时特征一致
    crypto.timingSafeEqual(bb, bb);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * API Key 鉴权中间件
 * 支持通过 Header (X-API-Key / Authorization) 或 URL 查询参数 (key / apiKey) 传入
 */
function authMiddleware(req, res, next) {
  // 如果配置了空的 apiKey，则跳过鉴权
  if (!config.apiKey) {
    return next();
  }

  let clientKey = req.headers['x-api-key'];

  if (!clientKey && req.headers['authorization']) {
    const authHeader = req.headers['authorization'];
    if (authHeader.startsWith('Bearer ')) {
      clientKey = authHeader.substring(7).trim();
    } else {
      clientKey = authHeader.trim();
    }
  }

  if (!clientKey && req.query) {
    clientKey = req.query.key || req.query.apiKey;
  }

  if (!clientKey || !timingSafeEqual(clientKey, config.apiKey)) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Invalid or missing API Key',
    });
  }

  next();
}

module.exports = authMiddleware;

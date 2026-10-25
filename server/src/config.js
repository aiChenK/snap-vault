const path = require('path');
const fs = require('fs');

// 自动加载 .env 环境变量文件
function loadEnv() {
  const envCandidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '../.env'),
    path.resolve(__dirname, '../../.env'),
  ];
  for (const envPath of envCandidates) {
    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, 'utf8');
        content.split(/\r?\n/).forEach((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) return;
          const match = trimmed.match(/^([^=]+)=(.*)$/);
          if (match) {
            const key = match[1].trim();
            let val = match[2].trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            if (process.env[key] === undefined) {
              process.env[key] = val;
            }
          }
        });
        break;
      } catch (e) {
        console.warn('[Config] 读取 .env 失败:', e.message);
      }
    }
  }
}

loadEnv();

// 已知不安全的 API_KEY 值: 历史默认回退值与 .env.example 占位值
const INSECURE_API_KEY_HINTS = ['snapvault-secret-key-change-me', 'CHANGE-ME'];

const apiKey = process.env.API_KEY || '';
const insecureHint = INSECURE_API_KEY_HINTS.find((hint) => apiKey.includes(hint));
if (!apiKey || insecureHint) {
  const reason = !apiKey ? '未配置 API_KEY 环境变量' : `API_KEY 含不安全占位值 (${insecureHint})`;
  if (process.env.NODE_ENV === 'production') {
    console.error(`[Config] 拒绝启动: ${reason}。请在 .env 中设置强随机密钥后重试!`);
    process.exit(1);
  }
  console.warn(`[Config] ⚠️ ${reason}, 开发环境将继续启动且跳过鉴权, 请勿公网暴露!`);
}

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  apiKey,
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE || `${50 * 1024 * 1024}`, 10), // 50MB
};

// 预定义各数据子目录路径
config.uploadsDir = path.join(config.dataDir, 'uploads');
config.thumbsDir = path.join(config.dataDir, 'thumbs');
config.manifestsDir = path.join(config.dataDir, 'manifests');
config.trashDir = path.join(config.dataDir, 'trash');

module.exports = config;


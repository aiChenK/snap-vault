const fs = require('fs');
const path = require('path');
const { ApiError } = require('./errors');

/**
 * 校验并清洗机器标识符
 * 仅允许包含字母、数字、下划线和连字符，长度 1~64 字符
 */
function sanitizeMachine(machine) {
  if (!machine || typeof machine !== 'string') {
    throw new ApiError(400, 'Invalid machine name: must be a non-empty string');
  }
  const clean = machine.trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(clean)) {
    throw new ApiError(400, 'Invalid machine name: only alphanumeric, underscore and hyphen allowed, length 1-64');
  }
  return clean;
}

/**
 * 校验并清洗虚拟 Key
 * 必须是安全文件名，禁止任何形式的路径分隔符与相对定位，且必须以 .jpg 结尾
 */
function sanitizeKey(key) {
  if (!key || typeof key !== 'string') {
    throw new ApiError(400, 'Invalid key: must be a non-empty string');
  }
  const clean = path.basename(key.trim());
  if (clean !== key.trim() || clean.startsWith('.')) {
    throw new ApiError(400, 'Invalid key: path traversal characters detected');
  }
  if (!/\.jpg$/i.test(clean)) {
    throw new ApiError(400, 'Invalid key: must be a valid filename ending with .jpg');
  }
  if (/[\/\\:*?"<>|\x00-\x1f\x7f]/.test(clean) || clean.length > 255) {
    throw new ApiError(400, 'Invalid key: must be a valid filename ending with .jpg');
  }
  return clean;
}

/**
 * 根据 Unix 秒级时间戳返回 YYYY/MM/DD 路径层级
 */
function getDatePath(timestampSeconds) {
  const date = timestampSeconds ? new Date(timestampSeconds * 1000) : new Date();
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return { year, month, day, relPath: path.join(year, month, day) };
}

/**
 * 确保目录存在
 */
async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

/**
 * 原子写入文件：先写临时文件，再通过 fs.promises.rename 覆盖目标文件
 */
async function atomicWriteFile(targetPath, data) {
  const dir = path.dirname(targetPath);
  await ensureDir(dir);
  const tempPath = `${targetPath}.${Date.now()}.${Math.random().toString(36).substring(2, 8)}.tmp`;
  try {
    await fs.promises.writeFile(tempPath, data);
    await fs.promises.rename(tempPath, targetPath);
  } catch (err) {
    try {
      await fs.promises.unlink(tempPath);
    } catch (_) {}
    throw err;
  }
}

/**
 * 安全检查：确保 targetPath 在 rootDir 之内，严格防止目录穿越
 */
function safeResolve(rootDir, relPath) {
  const resolved = path.resolve(rootDir, relPath);
  const resolvedRoot = path.resolve(rootDir);
  if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
    throw new ApiError(400, 'Security Error: Path traversal attempt blocked');
  }
  return resolved;
}

module.exports = {
  sanitizeMachine,
  sanitizeKey,
  getDatePath,
  ensureDir,
  atomicWriteFile,
  safeResolve,
};

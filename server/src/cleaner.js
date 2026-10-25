const fs = require('fs');
const path = require('path');
const config = require('./config');
const { sanitizeMachine, safeResolve } = require('./files');
const manifestManager = require('./manifest');

/**
 * 格式化字节大小为人性化字符串
 */
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

/**
 * 递归统计目录下的文件数量与总字节大小
 */
async function getDirStats(dirPath) {
  let count = 0;
  let totalBytes = 0;

  if (!fs.existsSync(dirPath)) {
    return { exists: false, count, totalBytes };
  }

  async function walk(currentPath) {
    let entries = [];
    try {
      entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
    } catch (_) {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.promises.stat(fullPath);
          count++;
          totalBytes += stat.size;
        } catch (_) {}
      }
    }
  }

  await walk(dirPath);
  return { exists: true, count, totalBytes };
}

/**
 * 统计单个文件（清单文件）状态与包含条目数
 */
async function getFileStats(filePath) {
  if (!fs.existsSync(filePath)) {
    return { exists: false, count: 0, totalBytes: 0, itemsCount: 0 };
  }
  try {
    const stat = await fs.promises.stat(filePath);
    let itemsCount = 0;
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      const json = JSON.parse(content);
      itemsCount = Object.keys(json.items || {}).length;
    } catch (_) {}
    return { exists: true, count: 1, totalBytes: stat.size, itemsCount };
  } catch (_) {
    return { exists: false, count: 0, totalBytes: 0, itemsCount: 0 };
  }
}

/**
 * 获取指定计算机的所有关联路径
 */
function getMachinePaths(machine) {
  const clean = sanitizeMachine(machine);
  return {
    machine: clean,
    uploadsDir: safeResolve(config.uploadsDir, clean),
    thumbsDir: safeResolve(config.thumbsDir, clean),
    trashDir: safeResolve(config.trashDir, clean),
    manifestFile: safeResolve(config.manifestsDir, `${clean}.json`),
  };
}

/**
 * 检查并统计指定计算机的数据占用情况（只读探测）
 */
async function inspectMachine(machine) {
  const paths = getMachinePaths(machine);

  const [uploadsStats, thumbsStats, trashStats, manifestStats] = await Promise.all([
    getDirStats(paths.uploadsDir),
    getDirStats(paths.thumbsDir),
    getDirStats(paths.trashDir),
    getFileStats(paths.manifestFile),
  ]);

  const totalFiles = uploadsStats.count + thumbsStats.count + trashStats.count + (manifestStats.exists ? 1 : 0);
  const totalBytes = uploadsStats.totalBytes + thumbsStats.totalBytes + trashStats.totalBytes + manifestStats.totalBytes;
  const existsAny = uploadsStats.exists || thumbsStats.exists || trashStats.exists || manifestStats.exists;

  return {
    machine: paths.machine,
    exists: existsAny,
    uploads: { ...uploadsStats, path: paths.uploadsDir },
    thumbs: { ...thumbsStats, path: paths.thumbsDir },
    trash: { ...trashStats, path: paths.trashDir },
    manifest: { ...manifestStats, path: paths.manifestFile },
    totalFiles,
    totalBytes,
  };
}

/**
 * 清理指定计算机的所有图片及清单数据
 * @param {string} machine 计算机标识符
 * @param {object} options 选项，包含 dryRun
 */
async function cleanMachineData(machine, options = {}) {
  const { dryRun = false } = options;
  const paths = getMachinePaths(machine);
  const clean = paths.machine;

  // 使用清单锁，确保清理过程与并发写入/更新排队互斥
  return manifestManager.withMachineLock(clean, async () => {
    // 1. 探测统计现有文件与大小
    const stats = await inspectMachine(clean);

    if (dryRun) {
      return {
        ...stats,
        dryRun: true,
        cleaned: false,
      };
    }

    // 2. 依次永久移除各数据目录与清单文件
    const deleteOperations = [];

    if (stats.uploads.exists) {
      deleteOperations.push(
        fs.promises.rm(paths.uploadsDir, { recursive: true, force: true }).catch((err) => {
          console.warn(`[Clean] 删除原图目录失败 (${paths.uploadsDir}):`, err.message);
        })
      );
    }

    if (stats.thumbs.exists) {
      deleteOperations.push(
        fs.promises.rm(paths.thumbsDir, { recursive: true, force: true }).catch((err) => {
          console.warn(`[Clean] 删除缩略图目录失败 (${paths.thumbsDir}):`, err.message);
        })
      );
    }

    if (stats.trash.exists) {
      deleteOperations.push(
        fs.promises.rm(paths.trashDir, { recursive: true, force: true }).catch((err) => {
          console.warn(`[Clean] 删除回收站目录失败 (${paths.trashDir}):`, err.message);
        })
      );
    }

    if (stats.manifest.exists) {
      deleteOperations.push(
        fs.promises.unlink(paths.manifestFile).catch((err) => {
          console.warn(`[Clean] 删除清单文件失败 (${paths.manifestFile}):`, err.message);
        })
      );
    }

    await Promise.all(deleteOperations);

    return {
      ...stats,
      dryRun: false,
      cleaned: true,
    };
  });
}

/**
 * 列出当前服务端所有计算机及其存储统计
 */
async function listAllMachinesWithStats() {
  const machineNames = await manifestManager.listMachines();
  const results = [];

  for (const name of machineNames) {
    try {
      const stats = await inspectMachine(name);
      results.push(stats);
    } catch (_) {}
  }

  return results;
}

module.exports = {
  formatBytes,
  inspectMachine,
  cleanMachineData,
  listAllMachinesWithStats,
};

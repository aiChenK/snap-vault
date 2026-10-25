const fs = require('fs');
const path = require('path');
const config = require('./config');
const { atomicWriteFile, sanitizeMachine, ensureDir } = require('./files');

// 单机排队锁：防止同一台机器并发写入 manifest 产生竞态条件
const machineLocks = new Map();

function withMachineLock(machine, fn) {
  const currentPromise = machineLocks.get(machine) || Promise.resolve();
  const nextPromise = currentPromise
    .then(() => fn())
    .catch((err) => {
      // 保证后续任务依然能继续排队执行
      throw err;
    })
    .finally(() => {
      if (machineLocks.get(machine) === nextPromise) {
        machineLocks.delete(machine);
      }
    });
  machineLocks.set(machine, nextPromise);
  return nextPromise;
}

function getManifestPath(machine) {
  const clean = sanitizeMachine(machine);
  return path.join(config.manifestsDir, `${clean}.json`);
}

/**
 * 计算聚合元数据
 */
function recalculateMeta(manifest) {
  let count = 0;
  let latestMtime = 0;
  let oldestMtime = 0;

  const items = manifest.items || {};
  for (const key of Object.keys(items)) {
    const item = items[key];
    if (item && !item.deletedAt) {
      count++;
      const mt = item.mtime || item.origMtime || 0;
      if (mt > latestMtime) {
        latestMtime = mt;
      }
      if (oldestMtime === 0 || mt < oldestMtime) {
        oldestMtime = mt;
      }
    }
  }

  manifest.count = count;
  manifest.latestMtime = latestMtime;
  manifest.oldestMtime = oldestMtime;
  manifest.updatedAt = Math.floor(Date.now() / 1000);
  return manifest;
}

/**
 * 内部读取清单文件（无锁，需配合 withMachineLock 或只读使用）
 */
async function readManifestRaw(machine) {
  const filePath = getManifestPath(machine);
  try {
    const content = await fs.promises.readFile(filePath, 'utf8');
    const data = JSON.parse(content);
    if (!data.items) data.items = {};
    return data;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        machine,
        updatedAt: Math.floor(Date.now() / 1000),
        count: 0,
        latestMtime: 0,
        oldestMtime: 0,
        items: {},
      };
    }
    throw err;
  }
}

/**
 * 获取机器的聚合元数据（轻量探测）
 */
async function getMeta(machine) {
  const clean = sanitizeMachine(machine);
  const manifest = await readManifestRaw(clean);

  // 计算墓碑元数据：软删除条目中的最新 mtime
  // 客户端据此在 Fast-Path 快速追加前感知"服务端已删除更新的文件"，避免误判重传复活
  let deletedLatestMtime = 0;
  for (const key of Object.keys(manifest.items || {})) {
    const item = manifest.items[key];
    if (item && item.deletedAt) {
      const mt = item.mtime || item.origMtime || 0;
      if (mt > deletedLatestMtime) {
        deletedLatestMtime = mt;
      }
    }
  }

  return {
    machine: clean,
    remoteCount: manifest.count || 0,
    remoteLatestMtime: manifest.latestMtime || 0,
    remoteOldestMtime: manifest.oldestMtime || 0,
    remoteDeletedLatestMtime: deletedLatestMtime,
  };
}

/**
 * 获取完整 Manifest
 */
async function getManifest(machine) {
  const clean = sanitizeMachine(machine);
  return await readManifestRaw(clean);
}

/**
 * 添加或更新单个 Item
 */
async function addOrUpdateItem(machine, item) {
  const clean = sanitizeMachine(machine);
  return withMachineLock(clean, async () => {
    const manifest = await readManifestRaw(clean);
    manifest.items[item.key] = item;
    recalculateMeta(manifest);

    const filePath = getManifestPath(clean);
    await atomicWriteFile(filePath, JSON.stringify(manifest, null, 2));
    return manifest;
  });
}

/**
 * 标记软删除某个 Item
 */
async function markDeleted(machine, key) {
  const clean = sanitizeMachine(machine);
  return withMachineLock(clean, async () => {
    const manifest = await readManifestRaw(clean);
    if (!manifest.items[key]) {
      return { found: false, manifest };
    }
    manifest.items[key].deletedAt = Math.floor(Date.now() / 1000);
    recalculateMeta(manifest);

    const filePath = getManifestPath(clean);
    await atomicWriteFile(filePath, JSON.stringify(manifest, null, 2));
    return { found: true, manifest, item: manifest.items[key] };
  });
}

/**
 * 墓碑确认清理：客户端确认本地已同步删除后，永久移除清单中的墓碑条目
 * 返回被清除的条目列表 (供路由层清理回收站文件)
 */
async function purgeTombstones(machine, keys) {
  const clean = sanitizeMachine(machine);
  return withMachineLock(clean, async () => {
    const manifest = await readManifestRaw(clean);
    const purged = [];

    for (const key of keys) {
      const item = manifest.items[key];
      // 仅清除已软删除的墓碑条目，有效条目与不存在条目一律忽略
      if (item && item.deletedAt) {
        purged.push(item);
        delete manifest.items[key];
      }
    }

    if (purged.length > 0) {
      recalculateMeta(manifest);
      const filePath = getManifestPath(clean);
      await atomicWriteFile(filePath, JSON.stringify(manifest, null, 2));
    }
    return { purged, manifest };
  });
}

/**
 * 批量标记软删除某个机器下的多个 Item
 */
async function markDeletedBatch(machine, keys) {
  const clean = sanitizeMachine(machine);
  return withMachineLock(clean, async () => {
    const manifest = await readManifestRaw(clean);
    const deletedItems = [];
    const now = Math.floor(Date.now() / 1000);

    for (const key of keys) {
      const item = manifest.items[key];
      if (item && !item.deletedAt) {
        item.deletedAt = now;
        deletedItems.push(item);
      }
    }

    if (deletedItems.length > 0) {
      recalculateMeta(manifest);
      const filePath = getManifestPath(clean);
      await atomicWriteFile(filePath, JSON.stringify(manifest, null, 2));
    }

    return { deletedItems, manifest };
  });
}

/**
 * 列出所有已注册的机器列表
 */
async function listMachines() {
  await ensureDir(config.manifestsDir);
  const files = await fs.promises.readdir(config.manifestsDir);
  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.basename(f, '.json'));
}

/**
 * 查询截图列表，支持多机器聚合、日期范围筛选、多维度排序、页码分页与游标分页
 */
async function queryItems({ machine, date, startDate, endDate, cursor, page, limit = 50, sort = 'mtime_desc' }) {
  const machines = machine ? [sanitizeMachine(machine)] : await listMachines();
  let allItems = [];

  // 格式化日期参数为 YYYYMMDD 数字字符串方便比对
  const toDigits = (d) => (d ? String(d).replace(/-/g, '') : null);
  let startDigits = toDigits(startDate);
  let endDigits = toDigits(endDate);
  if (date && !startDigits && !endDigits) {
    startDigits = toDigits(date);
    endDigits = toDigits(date);
  }

  for (const m of machines) {
    try {
      const manifest = await readManifestRaw(m);
      for (const key of Object.keys(manifest.items || {})) {
        const item = manifest.items[key];
        if (item && !item.deletedAt) {
          // 日期范围过滤
          if (startDigits || endDigits) {
            const itemDateDigits = new Date((item.mtime || item.origMtime) * 1000)
              .toISOString()
              .slice(0, 10)
              .replace(/-/g, '');
            if (startDigits && itemDateDigits < startDigits) {
              continue;
            }
            if (endDigits && itemDateDigits > endDigits) {
              continue;
            }
          }
          allItems.push({
            ...item,
            machine: m,
          });
        }
      }
    } catch (_) {
      // 忽略损坏的清单
    }
  }

  // 多维度排序支持
  switch (sort) {
    case 'mtime_asc':
      allItems.sort((a, b) => (a.mtime || a.origMtime || 0) - (b.mtime || b.origMtime || 0));
      break;
    case 'size_desc':
      allItems.sort((a, b) => (b.size || b.origSize || 0) - (a.size || a.origSize || 0));
      break;
    case 'size_asc':
      allItems.sort((a, b) => (a.size || a.origSize || 0) - (b.size || b.origSize || 0));
      break;
    case 'name_asc':
      allItems.sort((a, b) => (a.origName || a.key || '').localeCompare(b.origName || b.key || ''));
      break;
    case 'name_desc':
      allItems.sort((a, b) => (b.origName || b.key || '').localeCompare(a.origName || a.key || ''));
      break;
    case 'mtime_desc':
    default:
      allItems.sort((a, b) => (b.mtime || b.origMtime || 0) - (a.mtime || a.origMtime || 0));
      break;
  }

  // 页码分页模式 (若指定 page 参数)
  if (page !== undefined && page !== null && page !== '') {
    const parsedPage = Math.max(1, parseInt(page, 10) || 1);
    const total = allItems.length;
    const totalPages = Math.ceil(total / limit) || 1;
    const currentPage = Math.min(parsedPage, totalPages);
    const startIndex = (currentPage - 1) * limit;
    const pageItems = allItems.slice(startIndex, startIndex + limit);

    return {
      items: pageItems,
      total,
      page: currentPage,
      totalPages,
      limit,
      hasMore: currentPage < totalPages,
    };
  }

  // 游标分页模式 (兼容旧版及探测)
  let startIndex = 0;
  if (cursor) {
    const cursorMtime = parseInt(cursor, 10);
    if (!isNaN(cursorMtime)) {
      startIndex = allItems.findIndex((it) => (it.mtime || it.origMtime || 0) < cursorMtime);
      if (startIndex === -1) {
        startIndex = allItems.length;
      }
    }
  }

  const pageItems = allItems.slice(startIndex, startIndex + limit);
  const nextItem = allItems[startIndex + limit];
  const nextCursor = nextItem ? String(nextItem.mtime || nextItem.origMtime || '') : null;

  return {
    items: pageItems,
    total: allItems.length,
    nextCursor,
    hasMore: Boolean(nextCursor),
  };
}

module.exports = {
  withMachineLock,
  getMeta,
  getManifest,
  addOrUpdateItem,
  markDeleted,
  markDeletedBatch,
  purgeTombstones,
  listMachines,
  queryItems,
};


const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { sanitizeMachine, sanitizeKey, getDatePath, ensureDir, atomicWriteFile } = require('../files');
const manifestManager = require('../manifest');
const cleaner = require('../cleaner');

const router = express.Router();

// 内存暂存上传文件，直接转存至目标原子位置
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxFileSize,
  },
});

/**
 * POST /api/check - 轻量探测接口 (Fast-Path 核心基础)
 */
router.post('/check', async (req, res, next) => {
  try {
    const machine = sanitizeMachine(req.body.machine || req.query.machine);
    const meta = await manifestManager.getMeta(machine);
    res.json({
      success: true,
      ...meta,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/manifest - 获取完整清单 (分支 C 降级对齐使用)
 */
router.get('/manifest', async (req, res, next) => {
  try {
    const machine = sanitizeMachine(req.query.machine);
    const data = await manifestManager.getManifest(machine);
    res.json({
      success: true,
      ...data,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/machines - 列出所有机器列表
 */
router.get('/machines', async (req, res, next) => {
  try {
    const machines = await manifestManager.listMachines();
    res.json({
      success: true,
      machines,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/upload - 上传原图与缩略图
 * 字段: machine, key, origName, origSize, origMtime
 * 文件: file (原图), thumb (缩略图)
 */
router.post(
  '/upload',
  upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'thumb', maxCount: 1 },
  ]),
  async (req, res, next) => {
    try {
      const machine = sanitizeMachine(req.body.machine);
      const key = sanitizeKey(req.body.key);
      const origName = req.body.origName || key;
      const origSize = parseInt(req.body.origSize || '0', 10);
      const origMtime = parseInt(req.body.origMtime || `${Math.floor(Date.now() / 1000)}`, 10);

      const fileObj = req.files && req.files.file ? req.files.file[0] : null;
      const thumbObj = req.files && req.files.thumb ? req.files.thumb[0] : null;

      if (!fileObj) {
        return res.status(400).json({ success: false, error: 'Missing main image file (field: file)' });
      }

      // 计算保存路径
      const datePath = getDatePath(origMtime);
      const fileRelPath = path.join('uploads', machine, datePath.relPath, key);
      const fileAbsPath = path.join(config.dataDir, fileRelPath);

      await atomicWriteFile(fileAbsPath, fileObj.buffer);

      let thumbRelPath = null;
      let thumbSize = 0;
      if (thumbObj) {
        thumbRelPath = path.join('thumbs', machine, datePath.relPath, key);
        const thumbAbsPath = path.join(config.dataDir, thumbRelPath);
        await atomicWriteFile(thumbAbsPath, thumbObj.buffer);
        thumbSize = thumbObj.size;
      }

      const item = {
        key,
        origName,
        origSize,
        origMtime,
        mtime: origMtime,
        size: fileObj.size,
        thumbSize,
        path: fileRelPath.split(path.sep).join('/'),
        thumbPath: thumbRelPath ? thumbRelPath.split(path.sep).join('/') : null,
        uploadedAt: Math.floor(Date.now() / 1000),
        deletedAt: null,
      };

      await manifestManager.addOrUpdateItem(machine, item);

      res.json({
        success: true,
        machine,
        key,
        item,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * 移动软删除文件至回收站目录 /data/trash/{machine}/{YYYYMMDD}/{key}
 */
async function moveItemToTrash(machine, key, item) {
  try {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const trashDir = path.join(config.trashDir, machine, today);
    await ensureDir(trashDir);

    if (item.path) {
      const srcPath = path.join(config.dataDir, item.path);
      const dstPath = path.join(trashDir, key);
      if (fs.existsSync(srcPath)) {
        await fs.promises.rename(srcPath, dstPath);
      }
    }
    if (item.thumbPath) {
      const srcThumb = path.join(config.dataDir, item.thumbPath);
      const dstThumb = path.join(trashDir, `thumb_${key}`);
      if (fs.existsSync(srcThumb)) {
        await fs.promises.rename(srcThumb, dstThumb);
      }
    }
  } catch (moveErr) {
    console.warn(`[Trash] Soft delete move failed for ${machine}/${key}:`, moveErr.message);
  }
}

/**
 * DELETE /api/file - 删除单张截图 (软删除移入回收站)
 */
router.delete('/file', async (req, res, next) => {
  try {
    const machine = sanitizeMachine(req.body.machine || req.query.machine);
    const key = sanitizeKey(req.body.key || req.query.key);

    const result = await manifestManager.markDeleted(machine, key);
    if (!result.found) {
      return res.status(404).json({ success: false, error: 'File key not found in manifest' });
    }

    await moveItemToTrash(machine, key, result.item);

    res.json({
      success: true,
      machine,
      key,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * 批量删除截图处理逻辑
 */
async function handleBatchDelete(req, res, next) {
  try {
    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
    const grouped = new Map();

    // 支持 items: [{ machine, key }] 格式
    for (const item of rawItems) {
      if (!item || !item.machine || !item.key) continue;
      try {
        const m = sanitizeMachine(item.machine);
        const k = sanitizeKey(item.key);
        if (!grouped.has(m)) grouped.set(m, new Set());
        grouped.get(m).add(k);
      } catch (_) {}
    }

    // 也支持同一机器批量 keys: { machine, keys: [...] } 格式
    if (req.body.machine && Array.isArray(req.body.keys)) {
      try {
        const m = sanitizeMachine(req.body.machine);
        if (!grouped.has(m)) grouped.set(m, new Set());
        for (const k of req.body.keys) {
          try {
            grouped.get(m).add(sanitizeKey(k));
          } catch (_) {}
        }
      } catch (_) {}
    }

    if (grouped.size === 0) {
      return res.status(400).json({ success: false, error: 'No valid items provided for deletion' });
    }

    let totalDeleted = 0;
    const deletedList = [];

    for (const [machine, keysSet] of grouped.entries()) {
      const keys = Array.from(keysSet);
      const { deletedItems } = await manifestManager.markDeletedBatch(machine, keys);
      for (const item of deletedItems) {
        await moveItemToTrash(machine, item.key, item);
        deletedList.push({ machine, key: item.key });
      }
      totalDeleted += deletedItems.length;
    }

    res.json({
      success: true,
      count: totalDeleted,
      deleted: deletedList,
    });
  } catch (err) {
    next(err);
  }
}

router.post('/files/batch-delete', handleBatchDelete);
router.delete('/files', handleBatchDelete);

/**
 * DELETE /api/machine - 清理指定计算机下所有图片与清单
 */
router.delete('/machine', async (req, res, next) => {
  try {
    const rawMachine = req.body.machine || req.query.machine;
    const dryRun = req.body.dryRun === true || req.body.dryRun === 'true' || req.query.dryRun === 'true';

    if (!rawMachine) {
      return res.status(400).json({ success: false, error: 'Missing machine parameter' });
    }

    const machine = sanitizeMachine(rawMachine);
    const result = await cleaner.cleanMachineData(machine, { dryRun });

    res.json({
      success: true,
      ...result,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/tombstones/ack - 客户端确认墓碑已在本地同步删除
 * 服务端永久清除对应清单条目并清理回收站文件，防止清单与回收站无限膨胀
 * 注: 仅清除已软删除的墓碑；有效条目与无效 key 一律忽略 (幂等)
 */
router.post('/tombstones/ack', async (req, res, next) => {
  try {
    const machine = sanitizeMachine(req.body.machine);
    const rawKeys = Array.isArray(req.body.keys) ? req.body.keys : [];

    const keys = [
      ...new Set(
        rawKeys
          .filter((k) => typeof k === 'string' && k)
          .map((k) => {
            try {
              return sanitizeKey(k);
            } catch (_) {
              return null;
            }
          })
          .filter(Boolean)
      ),
    ];

    const { purged } = await manifestManager.purgeTombstones(machine, keys);

    // 清理回收站中的对应文件: trash/{machine}/{删除日期}/{key} 与 thumb_{key}
    let trashCleaned = 0;
    for (const item of purged) {
      const day = new Date(item.deletedAt * 1000).toISOString().slice(0, 10).replace(/-/g, '');
      const trashDir = path.join(config.trashDir, machine, day);
      const targets = [path.join(trashDir, item.key), path.join(trashDir, `thumb_${item.key}`)];
      for (const target of targets) {
        try {
          await fs.promises.unlink(target);
          trashCleaned++;
        } catch (_) {
          // 回收站文件不存在时忽略
        }
      }
    }

    res.json({
      success: true,
      machine,
      purged: purged.length,
      trashCleaned,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/list - 分页查询接口 (供画廊展示)
 */
router.get('/list', async (req, res, next) => {
  try {
    const { machine, date, startDate, endDate, sort, page, cursor, limit } = req.query;
    const cleanMachine = machine ? sanitizeMachine(machine) : null;
    const parsedLimit = Math.min(Math.max(parseInt(limit || '50', 10), 1), 200);

    const result = await manifestManager.queryItems({
      machine: cleanMachine,
      date,
      startDate,
      endDate,
      sort,
      page,
      cursor,
      limit: parsedLimit,
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

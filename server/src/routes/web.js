const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { sanitizeMachine, safeResolve } = require('../files');

const router = express.Router();

/**
 * 分发原图 /img/:machine/*
 */
router.get('/img/:machine/*', (req, res, next) => {
  try {
    const machine = sanitizeMachine(req.params.machine);
    const subPath = req.params[0];
    if (!subPath) return res.status(404).send('Not Found');

    const filePath = safeResolve(config.uploadsDir, path.join(machine, subPath));
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('Image Not Found');
    }

    // 设置一年的强缓存（因为 key / path 包含唯一时间戳且内容不可变）
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Type', 'image/jpeg');
    res.sendFile(filePath);
  } catch (err) {
    next(err);
  }
});

/**
 * 分发缩略图 /thumb/:machine/*
 * 若缩略图不存在，自动平滑回退到原图
 */
router.get('/thumb/:machine/*', (req, res, next) => {
  try {
    const machine = sanitizeMachine(req.params.machine);
    const subPath = req.params[0];
    if (!subPath) return res.status(404).send('Not Found');

    const thumbPath = safeResolve(config.thumbsDir, path.join(machine, subPath));
    if (fs.existsSync(thumbPath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Content-Type', 'image/jpeg');
      return res.sendFile(thumbPath);
    }

    // 回退到原图
    const origPath = safeResolve(config.uploadsDir, path.join(machine, subPath));
    if (fs.existsSync(origPath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Content-Type', 'image/jpeg');
      return res.sendFile(origPath);
    }

    res.status(404).send('Thumbnail Not Found');
  } catch (err) {
    next(err);
  }
});

/**
 * 下载原图 /download/:machine/*
 */
router.get('/download/:machine/*', (req, res, next) => {
  try {
    const machine = sanitizeMachine(req.params.machine);
    const subPath = req.params[0];
    if (!subPath) return res.status(404).send('Not Found');

    const filePath = safeResolve(config.uploadsDir, path.join(machine, subPath));
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('File Not Found');
    }

    const filename = path.basename(filePath);
    res.download(filePath, filename);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

const express = require('express');
const { sanitizeMachine, sanitizeKey } = require('../files');
const { updateTag } = require('../manifest');
const { tagText, readReport, galleryTags } = require('../tags');
const { ApiError } = require('../errors');

const router = express.Router();

router.get('/plugins', (req, res) => res.json({ plugins: req.app.locals.plugins }));

router.put('/tags', async (req, res, next) => {
  try {
    const { machine, key, value, mode } = req.body;
    const category = tagText(req.body.category, 64, 'category');
    if (!['manual', 'auto', 'delete'].includes(mode)) throw new ApiError(400, 'Invalid tag mode');
    const manual = mode === 'manual' ? tagText(value, 128, 'value') : null;
    const tags = await updateTag(sanitizeMachine(machine), sanitizeKey(key), category, tag => {
      if (mode === 'delete') {
        delete tag.manual;
        delete tag.auto;
      } else if (mode === 'auto') {
        if (tag.auto?.status !== 'ok') throw new ApiError(409, '该标签没有可恢复的自动识别结果');
        delete tag.manual;
      } else {
        tag.manual = manual;
      }
    });
    res.json({ tags: galleryTags(tags) });
  } catch (err) {
    next(err);
  }
});

router.post('/tags/report', async (req, res, next) => {
  try {
    const { machine, key } = req.body;
    const { category, auto } = readReport(req.body, req.app.locals.plugins);
    const tags = await updateTag(sanitizeMachine(machine), sanitizeKey(key), category, tag => {
      if (auto.status === 'err') {
        const previous = tag.auto;
        const sameRun = previous?.plugin === auto.plugin && previous.version === auto.version;
        auto.attempts = (sameRun ? previous.attempts || 0 : 0) + 1;
      }
      tag.auto = auto;
    });
    res.json({ tags: galleryTags(tags) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

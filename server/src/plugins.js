const fs = require('fs');
const path = require('path');
const express = require('express');
const { tagText } = require('./tags');

async function mountPlugins(app) {
  const root = path.join(__dirname, '../plugins');
  const plugins = [];
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return plugins;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    try {
      const spec = JSON.parse(await fs.promises.readFile(path.join(dir, 'plugin.json'), 'utf8'));
      const category = tagText(spec.category, 64, 'category');
      const action = tagText(spec.action, 64, 'action');
      if (!Number.isSafeInteger(spec.version) || spec.version < 1) throw new Error('version 必须为正整数');
      if (plugins.some(p => p.category === category)) throw new Error(`类别已被其他插件使用: ${category}`);
      await fs.promises.access(path.join(dir, 'public/index.mjs'));
      const base = `/plugins/${entry.name}`;
      plugins.push({ id: entry.name, category, action, version: spec.version, entry: base + '/index.mjs' });
      app.use(base, express.static(path.join(dir, 'public')));
    } catch (err) {
      console.warn(`[Plugins] 跳过 ${entry.name}: ${err.message}`);
    }
  }
  return plugins;
}

module.exports = { mountPlugins };

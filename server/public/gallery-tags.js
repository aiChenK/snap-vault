'use strict';

function createGalleryTags({ apiFetch, selected, reload, filterChanged }) {
  const byId = id => document.getElementById(id);
  const filters = new Map();
  let facets = [];
  let plugins = [];

  function summary(item) {
    return (item.tags || []).filter(t => t.value).map(t => `${t.category} · ${t.value}`).join('　');
  }

  function button(text, handler) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary btn-sm';
    btn.textContent = text;
    btn.onclick = handler;
    return btn;
  }

  async function loadPlugins() {
    const data = await apiFetch('/api/plugins');
    plugins = data.plugins;
    byId('pluginActions').replaceChildren(...plugins.map(plugin =>
      button(plugin.action, () => openBatch(plugin))));
    updateActions();
  }

  function updateActions() {
    for (const btn of byId('pluginActions').children) btn.disabled = !selected.size;
  }

  function appendFilters(params) {
    if (filters.size) {
      params.set('tags', JSON.stringify(Array.from(filters, ([category, value]) => ({ category, value }))));
    }
  }

  function renderFilters(available) {
    facets = available;
    const host = byId('tagFilters');
    host.replaceChildren();
    const categories = new Map(facets.map(f => [f.category, f.values]));
    for (const category of filters.keys()) {
      if (!categories.has(category)) categories.set(category, []);
    }
    for (const [category, values] of categories) {
      const label = document.createElement('label');
      label.className = 'filter-group';
      label.textContent = category;
      const select = document.createElement('select');
      const current = filters.get(category) || '';
      select.add(new Option('全部', ''));
      for (const value of new Set([...values, current])) {
        if (value) select.add(new Option(value, value));
      }
      select.value = current;
      select.onchange = () => {
        if (select.value) filters.set(category, select.value);
        else filters.delete(category);
        filterChanged();
      };
      label.append(select);
      host.append(label);
    }
  }

  function edit(item, onChanged) {
    const dialog = byId('tagEditor');
    const category = byId('tagCategory');
    const value = byId('tagValue');
    let changed = false;
    byId('tagForm').reset();

    async function save(name, mode, text) {
      try {
        const result = await apiFetch('/api/tags', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ machine: item.machine, key: item.key, category: name, mode, value: text }),
        });
        item.tags = result.tags;
        changed = true;
        byId('tagForm').reset();
        renderEntries();
      } catch (err) {
        alert(err.message);
      }
    }

    function renderEntries() {
      const entries = item.tags || [];
      const categories = new Set([
        ...facets.map(f => f.category), ...plugins.map(p => p.category), ...entries.map(t => t.category),
      ]);
      byId('tagCategories').replaceChildren(...Array.from(categories, c => new Option(c)));
      byId('tagEntries').replaceChildren(...entries.map(tag => {
        const row = document.createElement('div');
        row.className = 'tag-entry';
        const title = document.createElement('strong');
        const current = tag.value;
        const manual = Object.hasOwn(tag, 'manual');
        title.textContent = `${tag.category} · ${current || (manual ? '已手动清空' : '暂无标签')}`;
        row.append(title, button('编辑', () => {
          category.value = tag.category;
          value.value = current || '';
          value.focus();
        }));
        if (current || (!manual && tag.auto?.status === 'low_conf')) {
          row.append(button('清空', () => save(tag.category, 'manual', null)));
        }
        if (manual) row.append(button('恢复自动识别', () => save(tag.category, 'auto', null)));
        if (tag.auto?.status === 'low_conf' && !manual) {
          row.append(button(`确认候选「${tag.auto.value}」`, () => save(tag.category, 'manual', tag.auto.value)));
        }
        if (tag.auto?.status === 'err') row.append(document.createTextNode(tag.auto.error || '识别失败'));
        return row;
      }));
    }

    byId('tagForm').onsubmit = event => {
      event.preventDefault();
      save(category.value.trim(), 'manual', value.value.trim());
    };
    dialog.onclose = () => { if (changed) onChanged(); };
    renderEntries();
    dialog.showModal();
  }

  function needsRecognition(item, plugin) {
    const last = item.tags?.find(t => t.category === plugin.category)?.auto;
    return !last || last.plugin !== plugin.id || last.version !== plugin.version
      || (last.status === 'err' && last.attempts < 3);
  }

  async function recognize(analyze, item) {
    const path = item.path.split('/').slice(2).map(encodeURIComponent).join('/');
    const key = localStorage.getItem('snapvault_api_key') || '';
    const res = await fetch(`/img/${item.machine}/${path}`, { headers: { 'X-API-Key': key } });
    if (!res.ok) throw new Error(`读取截图失败 HTTP ${res.status}`);
    return analyze(await res.blob());
  }

  function openBatch(plugin) {
    const dialog = byId('pluginDialog');
    const progress = byId('pluginProgress');
    const force = byId('pluginForce');
    const start = byId('pluginStart');
    const close = byId('pluginClose');
    const all = [...selected.values()];
    const pending = all.filter(item => needsRecognition(item, plugin));
    let running = false;
    let stop = false;

    function showPlan() {
      const count = force.checked ? all.length : pending.length;
      start.disabled = count === 0;
      progress.textContent = `已选 ${all.length} 张，本次处理 ${count} 张。`;
    }

    byId('pluginTitle').textContent = plugin.action;
    force.checked = false;
    force.disabled = false;
    force.onchange = showPlan;
    start.hidden = false;
    close.textContent = '关闭';
    close.onclick = () => {
      if (running) {
        stop = true;
        close.textContent = '正在停止…';
      } else dialog.close();
    };
    dialog.oncancel = event => {
      if (running) {
        event.preventDefault();
        close.click();
      }
    };

    start.onclick = async () => {
      const targets = force.checked ? all : pending;
      running = true;
      force.disabled = true;
      start.hidden = true;
      close.textContent = '停止';
      const counts = { ok: 0, low_conf: 0, no_match: 0, err: 0 };
      let completed = 0;
      try {
        const { analyze } = await import(plugin.entry + '?v=' + plugin.version);
        if (typeof analyze !== 'function') throw new Error('插件缺少 analyze 导出');
        for (const item of targets) {
          if (stop) break;
          progress.textContent = `${completed + 1} / ${targets.length} · ${item.origName || item.key}`;
          let result;
          try {
            result = await recognize(analyze, item);
          } catch (err) {
            result = { status: 'err', error: String(err.message || err).slice(0, 500) };
          }
          const saved = await apiFetch('/api/tags/report', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...result, machine: item.machine, key: item.key, plugin: plugin.id, version: plugin.version }),
          });
          item.tags = saved.tags;
          counts[result.status]++;
          completed++;
        }
        progress.textContent = `已处理 ${completed} 张。已识别 ${counts.ok}，待确认 ${counts.low_conf}，未匹配 ${counts.no_match}，失败 ${counts.err}。`;
      } catch (err) {
        progress.textContent = `已保存 ${completed} 张。识别中断：${err.message}`;
      } finally {
        running = false;
        close.textContent = '关闭';
        if (completed) await reload();
      }
    };
    showPlan();
    dialog.showModal();
  }

  return { loadPlugins, updateActions, appendFilters, renderFilters, summary, edit };
}

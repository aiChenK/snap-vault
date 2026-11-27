'use strict';

function createGalleryTags({ apiFetch, selected, reload, filterChanged, toast }) {
  const byId = id => document.getElementById(id);
  const clearFiltersButton = byId('clearTagFiltersBtn');
  const storageKey = 'snapvault_tag_filter_categories';
  const filters = new Map();
  let filterCategories = readFilterCategories();
  let facets = new Map();
  let plugins = [];

  function readFilterCategories() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      return new Set(Array.isArray(saved) ? saved.filter(category => typeof category === 'string') : []);
    } catch {
      return new Set();
    }
  }

  function summary(item) {
    return (item.tags || []).filter(t => t.value).map(t => `${t.category} · ${t.value}`).join('　');
  }

  function button(text, handler, variant = 'ghost') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn btn-${variant} btn-sm`;
    btn.textContent = text;
    btn.onclick = handler;
    return btn;
  }

  async function loadPlugins() {
    const data = await apiFetch('/api/plugins');
    plugins = data.plugins;
    byId('pluginActions').replaceChildren(...plugins.map(plugin =>
      button(plugin.action, () => openBatch(plugin), 'accent')));
    updateActions();
  }

  function updateActions() {
    for (const btn of byId('pluginActions').children) btn.disabled = !selected.size;
  }

  function appendFilters(params) {
    if (filters.size) {
      params.set('tags', JSON.stringify(Array.from(filters, ([category, filter]) => ({ category, ...filter }))));
    }
  }

  function setLoading(loading) {
    byId('tagFilterControls').disabled = loading;
    byId('tagFilterSave').disabled = loading;
    clearFiltersButton.disabled = filters.size === 0;
  }

  function clearFilters() {
    filters.clear();
    renderFilters();
  }

  function setFacets(available) {
    facets = new Map(available.map(({ category, values }) => [category, values]));
    renderFilters();
  }

  function renderFilters() {
    byId('tagFilters').replaceChildren(...Array.from(filterCategories, createFilterField));
  }

  function createFilterField(category, index) {
    const field = byId('tagFilterField').content.firstElementChild.cloneNode(true);
    const label = field.querySelector('label');
    const input = field.querySelector('input');
    const clear = field.querySelector('.tag-picker__clear');
    const menu = field.querySelector('.tag-picker__menu');
    const list = menu.querySelector('[role="listbox"]');
    const empty = menu.querySelector('[role="status"]');
    const current = filters.get(category);
    const values = new Set(['', ...(facets.get(category) || [])]);
    if (current && current.match !== 'contains') values.add(current.value);
    let active;

    input.id = 'tag-filter-' + index;
    label.htmlFor = input.id;
    label.textContent = category;
    list.id = input.id + '-list';
    list.setAttribute('aria-label', category);
    input.setAttribute('aria-controls', list.id);
    input.disabled = values.size === 1 && !current;
    clear.title = `清空「${category}」筛选`;
    clear.setAttribute('aria-label', clear.title);

    const options = Array.from(values, (value, i) => createOption(value, i));

    close();
    input.onfocus = input.onclick = open;
    input.oninput = showMatches;
    field.addEventListener('focusout', event => {
      if (!field.contains(event.relatedTarget)) close();
    });
    clear.onclick = () => {
      if (filters.delete(category)) {
        close();
        filterChanged();
      } else {
        input.focus();
        input.value = '';
        showMatches();
      }
    };
    // 点选时让焦点留在输入框，避免 blur 在 click 之前关闭列表。
    clear.onmousedown = menu.onmousedown = event => event.preventDefault();
    input.onkeydown = event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (menu.hidden) {
          open();
        } else if (active) {
          const next = event.key === 'ArrowDown' ? active.nextElementSibling : active.previousElementSibling;
          if (next) highlight(next);
        }
      } else if (!menu.hidden && event.key === 'Enter') {
        event.preventDefault();
        active?.click();
      } else if (!menu.hidden && event.key === 'Escape') {
        close();
        input.select();
      }
    };
    return field;

    function createOption(value, id, match) {
      const option = document.createElement('div');
      option.id = list.id + '-' + id;
      option.setAttribute('role', 'option');
      option.dataset.value = value;
      option.textContent = match === 'contains' ? `搜索包含「${value}」的截图` : value || '全部';
      option.onclick = () => {
        const previous = filters.get(category);
        const changed = value !== (previous?.value || '') || match !== previous?.match;
        if (value) filters.set(category, { value, match });
        else filters.delete(category);
        close();
        if (changed) filterChanged();
        else input.select();
      };
      return option;
    }

    function open() {
      if (!menu.hidden) return;
      input.value = '';
      showMatches();
    }

    function showMatches() {
      const keyword = input.value.trim();
      const query = keyword.toLowerCase();
      const matches = options.filter(option => option.dataset.value.toLowerCase().includes(query));
      if (query && matches.length) matches.unshift(createOption(keyword, 'contains', 'contains'));
      list.replaceChildren(...matches);
      empty.hidden = matches.length > 0;
      menu.hidden = false;
      clear.hidden = !input.value && !filters.has(category);
      input.placeholder = '搜索标签';
      input.setAttribute('aria-expanded', 'true');
      const applied = filters.get(category);
      const currentOption = !query && applied?.match !== 'contains' &&
        matches.find(option => option.dataset.value === applied?.value);
      highlight(currentOption || matches[0]);
    }

    function highlight(option) {
      active?.setAttribute('aria-selected', 'false');
      active = option;
      if (active) {
        active.setAttribute('aria-selected', 'true');
        input.setAttribute('aria-activedescendant', active.id);
        active.scrollIntoView({ block: 'nearest' });
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    }

    function close() {
      menu.hidden = true;
      const applied = filters.get(category);
      input.value = applied?.match === 'contains' ? `包含「${applied.value}」` : applied?.value || '';
      clear.hidden = !input.value;
      input.placeholder = input.disabled ? '无可用值' : '全部';
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
  }

  async function openFilterSettings(event) {
    const trigger = event.currentTarget;
    trigger.disabled = true;
    trigger.textContent = '读取标签…';
    try {
      // 管理列表使用整个图库的类别，选项值仍跟随当前设备和日期范围。
      const { tagFacets } = await apiFetch('/api/list?limit=1');
      const categories = new Set([...tagFacets.map(f => f.category), ...filterCategories]);
      const options = [...categories].map(category => {
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.name = 'category';
        checkbox.value = category;
        checkbox.checked = filterCategories.has(category);
        label.append(checkbox, category);
        return label;
      });
      byId('tagFilterOptions').replaceChildren(...options);
      byId('tagFilterEmpty').hidden = options.length > 0;
    } catch (err) {
      toast(err.message, 'error');
      return;
    } finally {
      trigger.textContent = '标签管理';
      trigger.disabled = false;
    }
    trigger.focus();
    byId('tagFilterDialog').showModal();
  }

  function saveFilterSettings(event) {
    if (event.submitter.value !== 'save') return;
    event.preventDefault();
    const categories = new FormData(event.currentTarget).getAll('category');
    localStorage.setItem(storageKey, JSON.stringify(categories));
    filterCategories = new Set(categories);
    let removed = false;
    for (const category of filters.keys()) {
      if (!filterCategories.has(category)) {
        filters.delete(category);
        removed = true;
      }
    }
    renderFilters();
    byId('tagFilterDialog').close();
    if (removed) filterChanged();
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
        ...facets.keys(), ...plugins.map(p => p.category), ...entries.map(t => t.category),
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
        if (manual && tag.auto?.status === 'ok') {
          row.append(button('恢复自动识别', () => save(tag.category, 'auto')));
        }
        if (tag.auto?.status === 'low_conf' && !manual) {
          row.append(button(`确认候选「${tag.auto.value}」`, () => save(tag.category, 'manual', tag.auto.value)));
        }
        row.append(button('删除', () => save(tag.category, 'delete'), 'danger'));
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
    const progressBar = byId('pluginProgressBar');
    const currentFile = byId('pluginCurrentFile');
    const options = byId('pluginOptions');
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
    force.onchange = showPlan;
    options.hidden = false;
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
      options.hidden = true;
      start.hidden = true;
      close.textContent = '停止';
      close.focus();
      progress.textContent = '正在加载识别插件…';
      progressBar.removeAttribute('value');
      progressBar.hidden = false;
      const counts = { ok: 0, low_conf: 0, no_match: 0, err: 0 };
      let completed = 0;
      try {
        const { analyze, prepare } = await import(plugin.entry + '?v=' + plugin.version);
        if (typeof analyze !== 'function') throw new Error('插件缺少 analyze 导出');
        if (!stop && typeof prepare === 'function') {
          await prepare(message => { progress.textContent = message; });
        }
        progressBar.max = targets.length;
        progressBar.value = 0;
        for (const item of targets) {
          if (stop) break;
          progress.textContent = `正在识别第 ${completed + 1} 张，共 ${targets.length} 张`;
          currentFile.textContent = item.origName || item.key;
          currentFile.hidden = false;
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
          progressBar.value = completed;
        }
        const summary = `已处理 ${completed} 张。已识别 ${counts.ok}，待确认 ${counts.low_conf}，未匹配 ${counts.no_match}，失败 ${counts.err}。`;
        if (completed === targets.length) {
          dialog.close();
          toast(summary, counts.err ? 'error' : 'ok');
        } else {
          progress.textContent = `已停止。${summary}`;
        }
      } catch (err) {
        progress.textContent = `已保存 ${completed} 张。识别中断：${err.message}`;
      } finally {
        running = false;
        progressBar.hidden = true;
        currentFile.hidden = true;
        close.textContent = '关闭';
        if (completed) await reload();
      }
    };
    showPlan();
    dialog.showModal();
  }

  clearFiltersButton.onclick = () => {
    clearFilters();
    filterChanged();
  };
  byId('tagFilterSettingsBtn').onclick = openFilterSettings;
  byId('tagFilterForm').onsubmit = saveFilterSettings;

  return { loadPlugins, updateActions, appendFilters, clearFilters, setFacets, setLoading, summary, edit };
}

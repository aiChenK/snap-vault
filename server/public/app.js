// SnapVault Web Gallery —— 截图档案前端交互
(function () {
  'use strict';

  // ===== 状态管理 =====
  const state = {
    apiKey: localStorage.getItem('snapvault_api_key') || '',
    machine: '',
    sort: 'mtime_desc',
    startDate: '',
    endDate: '',
    page: 1,
    limit: 48,
    total: 0,
    totalPages: 1,
    items: [],
    machines: [],
    selectedKeys: new Set(), // machine:key 唯一标识
    selectedMap: new Map(),  // 跨页保留选中截图及其标签
    isLoading: false,
    activeLightboxIndex: -1,
    zoomLevel: 1,
  };

  const tags = createGalleryTags({
    apiFetch, selected: state.selectedMap, reload: () => loadGallery(state.page),
    filterChanged: applyGalleryFilters, toast,
  });

  // ===== DOM 引用 =====
  const el = {
    consoleEl: document.querySelector('.console'),

    machineSelect: document.getElementById('machineSelect'),
    sortSelect: document.getElementById('sortSelect'),
    quickDates: document.getElementById('quickDates'),
    startDateFilter: document.getElementById('startDateFilter'),
    endDateFilter: document.getElementById('endDateFilter'),
    pageSizeSelect: document.getElementById('pageSizeSelect'),
    refreshBtn: document.getElementById('refreshBtn'),
    keyConfigBtn: document.getElementById('keyConfigBtn'),
    keyStatusDot: document.getElementById('keyStatusDot'),

    filterToggleBtn: document.getElementById('filterToggleBtn'),
    filterRail: document.getElementById('filterRail'),
    filterDot: document.getElementById('filterDot'),

    // 读数条
    roFrames: document.getElementById('roFrames'),
    roMachines: document.getElementById('roMachines'),
    roVolume: document.getElementById('roVolume'),
    roStatus: document.getElementById('roStatus'),

    // 统计与批量
    itemCount: document.getElementById('itemCount'),
    pageInfo: document.getElementById('pageInfo'),
    selectionSummary: document.getElementById('selectionSummary'),
    selectedCount: document.getElementById('selectedCount'),
    selectAllBtn: document.getElementById('selectAllBtn'),
    clearSelectionBtn: document.getElementById('clearSelectionBtn'),
    batchDeleteBtn: document.getElementById('batchDeleteBtn'),
    batchDeleteCount: document.getElementById('batchDeleteCount'),

    // 网格与状态
    galleryGrid: document.getElementById('galleryGrid'),
    loadingIndicator: document.getElementById('loadingIndicator'),
    emptyState: document.getElementById('emptyState'),
    emptyResetBtn: document.getElementById('emptyResetBtn'),
    paginationBar: document.getElementById('paginationBar'),

    // 灯箱
    lightbox: document.getElementById('lightbox'),
    lbImage: document.getElementById('lbImage'),
    lbImageSpinner: document.getElementById('lbImageSpinner'),
    lbTitle: document.getElementById('lbTitle'),
    lbMachine: document.getElementById('lbMachine'),
    lbCounter: document.getElementById('lbCounter'),
    lbTime: document.getElementById('lbTime'),
    lbSize: document.getElementById('lbSize'),
    lbTags: document.getElementById('lbTags'),
    lbDownloadBtn: document.getElementById('lbDownloadBtn'),
    lbDeleteBtn: document.getElementById('lbDeleteBtn'),
    lbCloseBtn: document.getElementById('lbCloseBtn'),
    lbPrevBtn: document.getElementById('lbPrevBtn'),
    lbNextBtn: document.getElementById('lbNextBtn'),
    lightboxStage: document.getElementById('lightboxStage'),
    filmstrip: document.getElementById('filmstrip'),

    // Key 模态框
    keyModal: document.getElementById('keyModal'),
    keyInput: document.getElementById('keyInput'),
    keySaveBtn: document.getElementById('keySaveBtn'),
    keyCancelBtn: document.getElementById('keyCancelBtn'),

    // 通用确认框 / Toast
    confirmModal: document.getElementById('confirmModal'),
    cfEyebrow: document.getElementById('cfEyebrow'),
    cfTitle: document.getElementById('cfTitle'),
    cfDesc: document.getElementById('cfDesc'),
    cfOkBtn: document.getElementById('cfOkBtn'),
    cfCancelBtn: document.getElementById('cfCancelBtn'),
    toastHost: document.getElementById('toastHost'),
  };

  // ===== 工具函数 =====
  function formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
  }

  function formatTime(timestamp) {
    if (!timestamp) return '';
    const d = new Date(timestamp * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // 卡片信息条空间紧张，省掉年份只留 月-日 时:分
  function formatTimeShort(timestamp) {
    if (!timestamp) return '';
    const d = new Date(timestamp * 1000);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // 计数补零：0000 / 0128 —— 读数条要求等宽四位的仪器感
  function pad4(n) {
    return String(n).padStart(4, '0');
  }
  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  // HTML 转义: origName 等字段由客户端上传时自定义, 渲染前必须转义防止存储型 XSS
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function toLocalDateString(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // 统一的缩略图 / 原图 / 下载 URL 构造
  function mediaUrl(item, kind) {
    let subPath;
    if (kind === 'thumb') {
      subPath = item.thumbPath
        ? item.thumbPath.replace(new RegExp(`^thumbs\/${item.machine}\/`), '')
        : item.path.replace(new RegExp(`^uploads\/${item.machine}\/`), '');
    } else {
      subPath = item.path.replace(new RegExp(`^uploads\/${item.machine}\/`), '');
    }
    const prefix = kind === 'thumb' ? '/thumb' : (kind === 'download' ? '/download' : '/img');
    const encoded = subPath.split('/').map(encodeURIComponent).join('/');
    return `${prefix}/${item.machine}/${encoded}?key=${encodeURIComponent(state.apiKey)}`;
  }

  // ===== Toast 与自定义确认框 =====
  function toast(message, kind) {
    const node = document.createElement('div');
    node.className = 'toast' + (kind ? ` toast--${kind}` : '');
    node.textContent = message;
    el.toastHost.appendChild(node);
    setTimeout(() => {
      node.classList.add('is-out');
      setTimeout(() => node.remove(), 260);
    }, kind === 'error' ? 5200 : 3200);
  }

  function askConfirm(options) {
    return new Promise((resolve) => {
      el.cfEyebrow.textContent = options.eyebrow || '危险操作';
      el.cfTitle.textContent = options.title || '确认执行？';
      el.cfDesc.textContent = options.desc || '';
      el.cfOkBtn.textContent = options.okText || '确认';
      el.cfOkBtn.className = options.danger === false ? 'btn btn-primary' : 'btn btn-danger-solid';

      const backdrop = el.confirmModal.querySelector('.modal-backdrop');
      el.confirmModal.classList.remove('hidden');
      el.cfCancelBtn.focus();

      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        el.confirmModal.classList.add('hidden');
        el.cfOkBtn.removeEventListener('click', onOk);
        el.cfCancelBtn.removeEventListener('click', onCancel);
        backdrop.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey, true);
        resolve(value);
      };
      const onOk = () => finish(true);
      const onCancel = () => finish(false);
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
      };

      el.cfOkBtn.addEventListener('click', onOk);
      el.cfCancelBtn.addEventListener('click', onCancel);
      backdrop.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey, true);
    });
  }

  // ===== 读数条 =====
  function updateKeyIndicator() {
    const linked = !!state.apiKey;
    el.keyStatusDot.classList.toggle('active', linked);
    if (state.isLoading) {
      el.roStatus.textContent = '读取中';
      el.roStatus.className = 'readout__v readout__v--warn';
    } else {
      el.roStatus.textContent = linked ? '已连接' : '未接入';
      el.roStatus.className = 'readout__v ' + (linked ? 'readout__v--ok' : 'readout__v--warn');
    }
  }

  function updateReadout() {
    el.roFrames.textContent = pad4(state.total);
    el.roMachines.textContent = String(state.machines.length);
    const bytes = state.items.reduce((sum, it) => sum + (it.size || it.origSize || 0), 0);
    el.roVolume.textContent = formatSize(bytes);
    el.roVolume.title = '本页 ' + state.items.length + ' 张合计';
    updateKeyIndicator();
  }

  // ===== 网络请求 =====
  async function apiFetch(endpoint, options = {}) {
    options.headers = options.headers || {};
    if (state.apiKey) {
      options.headers['X-API-Key'] = state.apiKey;
    }
    const res = await fetch(endpoint, options);
    if (res.status === 401) {
      showKeyModal();
      throw new Error('鉴权未通过，请填写正确的 API 密钥');
    }
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `请求失败 HTTP ${res.status}`);
    }
    return res.json();
  }

  // ===== 初始化 =====
  function init() {
    updateKeyIndicator();

    if (!state.apiKey) {
      showKeyModal();
    } else {
      loadMachines();
      loadGallery(1);
    }

    el.keyConfigBtn.addEventListener('click', showKeyModal);
    el.keySaveBtn.addEventListener('click', saveKeyModal);
    el.keyCancelBtn.addEventListener('click', hideKeyModal);
    el.keyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveKeyModal();
    });

    el.machineSelect.addEventListener('change', (e) => {
      state.machine = e.target.value;
      applyGalleryFilters();
    });

    el.sortSelect.addEventListener('change', (e) => {
      state.sort = e.target.value;
      loadGallery(1);
    });

    el.pageSizeSelect.addEventListener('change', (e) => {
      state.limit = parseInt(e.target.value, 10) || 48;
      loadGallery(1);
    });

    el.refreshBtn.addEventListener('click', () => {
      loadMachines();
      loadGallery(state.page);
    });

    el.quickDates.addEventListener('click', (e) => {
      const chip = e.target.closest('.date-chip');
      if (!chip) return;
      applyQuickDateRange(chip.dataset.range);
    });

    el.startDateFilter.addEventListener('change', () => {
      state.startDate = el.startDateFilter.value;
      clearActiveChips();
      applyGalleryFilters();
    });

    el.endDateFilter.addEventListener('change', () => {
      state.endDate = el.endDateFilter.value;
      clearActiveChips();
      applyGalleryFilters();
    });

    el.emptyResetBtn.addEventListener('click', resetFilters);

    el.filterToggleBtn.addEventListener('click', () => {
      const collapsed = el.filterRail.classList.toggle('hidden');
      el.filterToggleBtn.setAttribute('aria-expanded', String(!collapsed));
    });

    el.selectAllBtn.addEventListener('click', toggleSelectAllCurrentPage);
    el.clearSelectionBtn.addEventListener('click', clearAllSelections);
    el.batchDeleteBtn.addEventListener('click', handleBatchDelete);
    initLightboxEvents();
    initGlobalKeys();
  }

  // 全局快捷键：抽出统一入口，避免多处监听器互相打断
  function initGlobalKeys() {
    window.addEventListener('keydown', (e) => {
      if (document.querySelector('dialog[open]') || !el.confirmModal.classList.contains('hidden')) return;
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');

      if (!el.lightbox.classList.contains('hidden')) {
        if (e.key === 'Escape') closeLightbox();
        if (e.key === 'ArrowLeft') prevImage();
        if (e.key === 'ArrowRight') nextImage();
        return;
      }

      if (!typing && (e.key === 'r' || e.key === 'R')) {
        loadMachines();
        loadGallery(state.page);
      }
      if (!el.keyModal.classList.contains('hidden') && e.key === 'Escape') hideKeyModal();
    });
  }

  function clearActiveChips() {
    el.quickDates.querySelectorAll('.date-chip').forEach((c) => c.classList.remove('is-active'));
  }

  function applyQuickDateRange(range) {
    clearActiveChips();
    const activeChip = el.quickDates.querySelector(`[data-range="${range}"]`);
    if (activeChip) activeChip.classList.add('is-active');

    const today = new Date();
    if (range === 'all') {
      state.startDate = '';
      state.endDate = '';
      el.startDateFilter.value = '';
      el.endDateFilter.value = '';
    } else {
      const days = range === '1d' ? 0 : range === '3d' ? 2 : range === '7d' ? 6 : 29;
      const start = new Date(today);
      start.setDate(today.getDate() - days);
      state.startDate = toLocalDateString(start);
      state.endDate = toLocalDateString(today);
      el.startDateFilter.value = state.startDate;
      el.endDateFilter.value = state.endDate;
    }

    applyGalleryFilters();
  }

  function applyGalleryFilters() {
    clearAllSelections();
    loadGallery(1);
  }

  function resetFilters() {
    state.machine = '';
    state.sort = 'mtime_desc';
    state.startDate = '';
    state.endDate = '';
    state.limit = 48;
    tags.clearFilters();
    el.machineSelect.value = '';
    el.sortSelect.value = 'mtime_desc';
    el.pageSizeSelect.value = '48';
    el.startDateFilter.value = '';
    el.endDateFilter.value = '';
    clearActiveChips();
    const allChip = el.quickDates.querySelector('[data-range="all"]');
    if (allChip) allChip.classList.add('is-active');
    applyGalleryFilters();
  }

  // ===== Key 模态框 =====
  function showKeyModal() {
    el.keyInput.value = state.apiKey;
    el.keyModal.classList.remove('hidden');
    el.keyInput.focus();
  }

  function hideKeyModal() {
    el.keyModal.classList.add('hidden');
  }

  function saveKeyModal() {
    const val = el.keyInput.value.trim();
    if (!val) {
      toast('API 密钥不能为空', 'error');
      el.keyInput.focus();
      return;
    }
    state.apiKey = val;
    localStorage.setItem('snapvault_api_key', val);
    updateKeyIndicator();
    hideKeyModal();
    loadMachines();
    loadGallery(1);
  }

  // ===== 机器列表 =====
  async function loadMachines() {
    tags.loadPlugins().catch(err => toast(err.message, 'error'));
    try {
      const data = await apiFetch('/api/machines');
      if (data.machines) {
        state.machines = data.machines;
        const current = el.machineSelect.value;
        el.machineSelect.innerHTML = '<option value="">全部设备</option>';
        data.machines.forEach((m) => {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          el.machineSelect.appendChild(opt);
        });
        el.machineSelect.value = current;
        updateReadout();
      }
    } catch (err) {
      console.warn('获取机器列表失败:', err.message);
    }
  }

  // ===== 画廊加载 =====
  function renderSkeleton(count) {
    const frag = document.createDocumentFragment();
    const n = Math.min(count, 24);
    for (let i = 0; i < n; i++) {
      const box = document.createElement('div');
      box.className = 'skeleton-card';
      box.innerHTML =
        '<div class="skeleton-card__media"></div>' +
        '<div class="skeleton-card__bar"></div>' +
        '<div class="skeleton-card__bar skeleton-card__bar--short"></div>';
      frag.appendChild(box);
    }
    el.galleryGrid.replaceChildren(frag);
  }

  async function loadGallery(page = 1) {
    if (state.isLoading) return;
    state.isLoading = true;
    tags.setLoading(true);
    el.filterRail.inert = true;
    el.galleryGrid.inert = true;
    el.selectAllBtn.disabled = true;
    el.consoleEl.classList.add('is-busy');
    el.galleryGrid.setAttribute('aria-busy', 'true');
    el.loadingIndicator.classList.remove('hidden');
    updateKeyIndicator();

    // 首屏（或空网格）时用骨架占位，避免大片留白
    if (el.galleryGrid.children.length === 0) {
      renderSkeleton(state.limit);
    }

    try {
      const params = new URLSearchParams();
      if (state.machine) params.append('machine', state.machine);
      if (state.sort) params.append('sort', state.sort);
      if (state.startDate) params.append('startDate', state.startDate);
      if (state.endDate) params.append('endDate', state.endDate);
      tags.appendFilters(params);
      const filtered = Boolean(state.machine || state.startDate || state.endDate);
      el.filterDot.classList.toggle('is-on', filtered);
      el.filterToggleBtn.classList.toggle('is-active', filtered);
      params.append('page', String(page));
      params.append('limit', String(state.limit));

      const data = await apiFetch(`/api/list?${params.toString()}`);
      state.items = data.items || [];
      state.total = data.total || 0;
      state.page = data.page || page;
      state.totalPages = data.totalPages || 1;

      tags.setFacets(data.tagFacets);
      renderGallery();
    } catch (err) {
      console.error('加载截图失败:', err.message);
      toast(err.message || '清单读取失败', 'error');
    } finally {
      state.isLoading = false;
      tags.setLoading(false);
      el.filterRail.inert = false;
      el.galleryGrid.inert = false;
      el.selectAllBtn.disabled = false;
      el.consoleEl.classList.remove('is-busy');
      el.galleryGrid.setAttribute('aria-busy', 'false');
      el.loadingIndicator.classList.add('hidden');
      updateKeyIndicator();
    }
  }

  function renderGallery() {
    for (const item of state.items) {
      const id = `${item.machine}:${item.key}`;
      if (state.selectedKeys.has(id)) state.selectedMap.set(id, item);
    }
    renderCards(state.items);
    renderPagination();
    updateStatsAndBatchBar();
    updateReadout();

    const empty = state.items.length === 0;
    el.emptyState.classList.toggle('hidden', !empty);
    el.paginationBar.classList.toggle('hidden', empty || state.totalPages <= 1);
  }

  // ===== 渲染卡片 =====
  function renderCards(items) {
    el.galleryGrid.replaceChildren();

    // 按实际列数错峰：让入场像从左向右扫过一行
    const cols = (() => {
      try {
        const tpl = getComputedStyle(el.galleryGrid).gridTemplateColumns;
        return Math.max(1, tpl.split(' ').filter(Boolean).length);
      } catch (_) {
        return 4;
      }
    })();

    const frag = document.createDocumentFragment();

    items.forEach((item, index) => {
      const itemKeyId = `${item.machine}:${item.key}`;
      const isSelected = state.selectedKeys.has(itemKeyId);

      const card = document.createElement('article');
      card.className = 'card card--enter' + (isSelected ? ' is-selected' : '');
      card.style.setProperty('--d', `${Math.min(index % cols, 8) * 45 + Math.min(Math.floor(index / cols), 6) * 70}ms`);
      card.dataset.index = index;
      card.dataset.id = itemKeyId;

      const thumbUrl = escapeHtml(mediaUrl(item, 'thumb'));
      const tagLabel = escapeHtml(tags.summary(item));
      const title = escapeHtml(item.origName || item.key);

      card.innerHTML = `
        <div class="card-media">
          <label class="card-checkbox-label" title="勾选以批量操作">
            <input type="checkbox" class="card-checkbox" aria-label="选择这张" ${isSelected ? 'checked' : ''}>
            <span class="custom-checkbox"></span>
          </label>
          <button type="button" class="card-quick-delete-btn" title="直接删除这张（移入回收站）" aria-label="删除这张">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </button>
          <span class="card-frame" aria-hidden="true"></span>
          <span class="card-index">第 ${pad4((state.page - 1) * state.limit + index + 1)} 张</span>
          ${tagLabel ? `<span class="card-tags" title="${tagLabel}">${tagLabel}</span>` : ''}
          <span class="card-broken">预览失败</span>
          <img class="card-img" src="${thumbUrl}" alt="${title}" loading="lazy" decoding="async">
        </div>
        <div class="card-info">
          <div class="card-title" title="${title}">${title}</div>
          <div class="card-meta">
            <span class="tag-machine">${escapeHtml(item.machine)}</span>
            <span class="card-meta__time">${formatTimeShort(item.mtime || item.origMtime)}</span>
            <span class="card-meta__size">${formatSize(item.size || item.origSize)}</span>
          </div>
        </div>
      `;

      const img = card.querySelector('.card-img');
      if (img.complete && img.naturalWidth > 0) card.classList.add('is-loaded');
      img.addEventListener('load', () => card.classList.add('is-loaded'), { once: true });
      img.addEventListener('error', () => card.classList.add('is-broken'), { once: true });

      const chk = card.querySelector('.card-checkbox');
      chk.addEventListener('change', (e) => {
        e.stopPropagation();
        if (chk.checked) {
          state.selectedKeys.add(itemKeyId);
          state.selectedMap.set(itemKeyId, item);
          card.classList.add('is-selected');
        } else {
          state.selectedKeys.delete(itemKeyId);
          state.selectedMap.delete(itemKeyId);
          card.classList.remove('is-selected');
        }
        updateStatsAndBatchBar();
      });

      card.querySelector('.card-checkbox-label')
        .addEventListener('click', (e) => e.stopPropagation());

      card.querySelector('.card-quick-delete-btn')
        .addEventListener('click', (e) => {
          e.stopPropagation();
          quickDeleteSingleItem(item);
        });

      card.addEventListener('click', () => openLightbox(index));

      frag.appendChild(card);
    });

    el.galleryGrid.appendChild(frag);
  }

  // ===== 统计与批量栏 =====
  function updateStatsAndBatchBar() {
    el.itemCount.textContent = `共 ${state.total} 张`;
    el.pageInfo.textContent = `第 ${pad2(state.page)} / ${pad2(state.totalPages)} 页`;

    const selectedCount = state.selectedKeys.size;
    el.selectedCount.textContent = String(selectedCount);
    el.batchDeleteCount.textContent = String(selectedCount);

    el.selectionSummary.classList.toggle('hidden', selectedCount === 0);
    el.clearSelectionBtn.classList.toggle('hidden', selectedCount === 0);
    if (selectedCount > 0) {
      el.batchDeleteBtn.removeAttribute('disabled');
    } else {
      el.batchDeleteBtn.setAttribute('disabled', 'true');
    }

    tags.updateActions();

    const allCurrentPageSelected =
      state.items.length > 0 &&
      state.items.every((it) => state.selectedKeys.has(`${it.machine}:${it.key}`));

    el.selectAllBtn.textContent = allCurrentPageSelected ? '取消本页' : '全选本页';
  }

  function toggleSelectAllCurrentPage() {
    const allCurrentPageSelected =
      state.items.length > 0 &&
      state.items.every((it) => state.selectedKeys.has(`${it.machine}:${it.key}`));

    state.items.forEach((it) => {
      const id = `${it.machine}:${it.key}`;
      if (allCurrentPageSelected) {
        state.selectedKeys.delete(id);
        state.selectedMap.delete(id);
      } else {
        state.selectedKeys.add(id);
        state.selectedMap.set(id, it);
      }
    });

    renderCards(state.items);
    updateStatsAndBatchBar();
  }

  function clearAllSelections() {
    state.selectedKeys.clear();
    state.selectedMap.clear();
    el.galleryGrid.querySelectorAll('.card.is-selected').forEach(card => {
      card.classList.remove('is-selected');
      card.querySelector('.card-checkbox').checked = false;
    });
    updateStatsAndBatchBar();
  }

  // ===== 删除操作 =====
  // 单张删除走 DELETE /api/file；批量走一次性批处理接口，避免 N 次往返
  async function deleteOne(item) {
    await apiFetch('/api/file', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machine: item.machine, key: item.key }),
    });
    removeSelection(item);
  }

  async function deleteMany(list) {
    await apiFetch('/api/files/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: list }),
    });
    list.forEach(removeSelection);
  }

  function removeSelection(item) {
    const id = `${item.machine}:${item.key}`;
    state.selectedKeys.delete(id);
    state.selectedMap.delete(id);
  }

  async function quickDeleteSingleItem(item) {
    const name = item.origName || item.key;
    const ok = await askConfirm({
      eyebrow: '移入回收站',
      title: '把这张送进回收站？',
      desc: `「${name}」将从服务端清单移除（文件移入回收站，客户端下一次对齐时也会下架）。`,
      okText: '移入回收站',
    });
    if (!ok) return;

    try {
      await deleteOne(item);
      toast('已移入回收站，可在服务端找回', 'ok');
      const nextPage = state.items.length === 1 && state.page > 1 ? state.page - 1 : state.page;
      await loadGallery(nextPage);
    } catch (err) {
      toast('删除失败：' + err.message, 'error');
    }
  }

  async function handleBatchDelete() {
    const count = state.selectedKeys.size;
    if (count === 0) return;

    const ok = await askConfirm({
      eyebrow: '批量删除',
      title: `把 ${count} 张移入回收站？`,
      desc: `已选中的 ${count} 张将被移入服务端回收站，客户端下一次对齐时会同步下架。`,
      okText: `移入回收站`,
    });
    if (!ok) return;

    try {
      await deleteMany(Array.from(state.selectedMap.values(), ({ machine, key }) => ({ machine, key })));
      toast(`已移入回收站 ${count} 张`, 'ok');
      clearAllSelections();
      const nextPage = state.items.length === count && state.page > 1 ? state.page - 1 : state.page;
      await loadGallery(nextPage);
    } catch (err) {
      toast('批量删除失败：' + err.message, 'error');
    }
  }

  // ===== 分页 =====
  function renderPagination() {
    if (state.totalPages <= 1) {
      el.paginationBar.innerHTML = '';
      el.paginationBar.classList.add('hidden');
      return;
    }

    el.paginationBar.classList.remove('hidden');
    el.paginationBar.innerHTML = '';

    const addBtn = (text, target, disabled, cls) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'page-btn' + (cls ? ` ${cls}` : '');
      b.textContent = text;
      b.disabled = disabled;
      b.addEventListener('click', () => goToPage(target));
      el.paginationBar.appendChild(b);
      return b;
    };

    addBtn('« 首页', 1, state.page <= 1);
    addBtn('‹ 上页', state.page - 1, state.page <= 1);

    getPaginationPageList(state.page, state.totalPages).forEach((p) => {
      if (p === '...') {
        const ellipsis = document.createElement('span');
        ellipsis.className = 'page-ellipsis';
        ellipsis.textContent = '···';
        el.paginationBar.appendChild(ellipsis);
      } else {
        addBtn(String(p), p, false, p === state.page ? 'is-active' : '');
      }
    });

    addBtn('下页 ›', state.page + 1, state.page >= state.totalPages);
    addBtn('末页 »', state.totalPages, state.page >= state.totalPages);

    const jumper = document.createElement('div');
    jumper.className = 'page-jumper';
    jumper.innerHTML = `
      <label class="sr-only" for="jumpInput">跳转到页码</label>
      <span>跳至</span>
      <input type="number" id="jumpInput" min="1" max="${state.totalPages}" value="${state.page}" class="jump-input">
      <span>页</span>
      <button type="button" class="btn btn-ghost btn-sm jump-btn">前往</button>
    `;

    const jumpInput = jumper.querySelector('.jump-input');
    const jumpBtn = jumper.querySelector('.jump-btn');
    const doJump = () => {
      const target = parseInt(jumpInput.value, 10);
      if (!isNaN(target) && target >= 1 && target <= state.totalPages && target !== state.page) {
        goToPage(target);
      }
    };

    jumpBtn.addEventListener('click', doJump);
    jumpInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doJump();
    });

    el.paginationBar.appendChild(jumper);
  }

  function getPaginationPageList(current, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    if (current <= 4) return [1, 2, 3, 4, 5, '...', total];
    if (current >= total - 3) return [1, '...', total - 4, total - 3, total - 2, total - 1, total];
    return [1, '...', current - 1, current, current + 1, '...', total];
  }

  function goToPage(targetPage) {
    if (targetPage < 1 || targetPage > state.totalPages || targetPage === state.page) return;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    loadGallery(targetPage);
  }

  // ===== 灯箱 =====
  function initLightboxEvents() {
    el.lbCloseBtn.addEventListener('click', closeLightbox);
    el.lbPrevBtn.addEventListener('click', prevImage);
    el.lbNextBtn.addEventListener('click', nextImage);
    el.lightbox.querySelector('.lightbox-overlay').addEventListener('click', closeLightbox);

    el.lightboxStage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.15 : 0.15;
      state.zoomLevel = Math.min(Math.max(state.zoomLevel + delta, 0.5), 4);
      updateImageTransform();
    }, { passive: false });

    el.lbImage.addEventListener('dblclick', () => {
      state.zoomLevel = state.zoomLevel === 1 ? 2 : 1;
      updateImageTransform();
    });

    document.getElementById('editTags').onclick = () => {
      const item = state.items[state.activeLightboxIndex];
      tags.edit(item, async () => {
        await loadGallery(state.page);
        const index = state.items.findIndex(it => it.machine === item.machine && it.key === item.key);
        if (index < 0) closeLightbox();
        else openLightbox(index);
      });
    };

    el.lbDownloadBtn.addEventListener('click', () => {
      const item = state.items[state.activeLightboxIndex];
      if (!item) return;
      window.open(mediaUrl(item, 'download'), '_blank', 'noopener');
    });

    el.lbDeleteBtn.addEventListener('click', async () => {
      const index = state.activeLightboxIndex;
      const item = state.items[index];
      if (!item) return;
      const name = item.origName || item.key;
      const ok = await askConfirm({
        eyebrow: '移入回收站',
        title: '把这张送进回收站？',
        desc: `「${name}」将从服务端清单移除（文件移入回收站，客户端下一次对齐时也会下架）。`,
        okText: '移入回收站',
      });
      if (!ok) return;

      el.lbDeleteBtn.disabled = true;
      try {
        await deleteOne(item);
        toast('已移入回收站', 'ok');
        const page = state.page;
        await loadGallery(page);

        // 清单刷新失败时，从已加载的列表里移除已确认删除的截图。
        const deletedIndex = state.items.findIndex(entry => entry.machine === item.machine && entry.key === item.key);
        if (deletedIndex !== -1) {
          state.items.splice(deletedIndex, 1);
          state.total--;
          state.totalPages = Math.ceil(state.total / state.limit) || 1;
          renderGallery();
        }

        if (el.lightbox.classList.contains('hidden')) return;
        if (state.items.length === 0) {
          closeLightbox();
          return;
        }

        const lastIndex = state.items.length - 1;
        openLightbox(state.page < page ? lastIndex : Math.min(index, lastIndex));
      } catch (err) {
        toast('删除失败：' + err.message, 'error');
      } finally {
        el.lbDeleteBtn.disabled = false;
      }
    });
  }

  function openLightbox(index) {
    state.activeLightboxIndex = index;
    state.zoomLevel = 1;
    el.lightbox.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    renderFilmstrip();
    renderLightboxContent();
    el.lbCloseBtn.focus();
  }

  function closeLightbox() {
    el.lightbox.classList.add('hidden');
    document.body.style.overflow = '';
    if (document.activeElement && el.lightbox.contains(document.activeElement)) {
      document.activeElement.blur();
    }
  }

  function prevImage() {
    if (state.activeLightboxIndex > 0) {
      state.activeLightboxIndex--;
      state.zoomLevel = 1;
      renderLightboxContent();
    }
  }

  function nextImage() {
    if (state.activeLightboxIndex < state.items.length - 1) {
      state.activeLightboxIndex++;
      state.zoomLevel = 1;
      renderLightboxContent();
    }
  }

  function updateImageTransform() {
    el.lbImage.style.transform = `scale(${state.zoomLevel})`;
  }

  // 胶片条：本页每一帧一张缩略图，当前帧居中高亮
  function renderFilmstrip() {
    if (!el.filmstrip) return;
    el.filmstrip.replaceChildren();
    state.items.forEach((item, i) => {
      const frame = document.createElement('button');
      frame.type = 'button';
      frame.className = 'film-frame';
      frame.setAttribute('role', 'tab');
      frame.title = item.origName || item.key;

      const img = document.createElement('img');
      img.src = mediaUrl(item, 'thumb');
      img.alt = '';
      img.loading = 'lazy';
      frame.appendChild(img);

      frame.addEventListener('click', () => {
        state.activeLightboxIndex = i;
        state.zoomLevel = 1;
        renderLightboxContent();
      });

      el.filmstrip.appendChild(frame);
    });
    syncFilmstrip();
  }

  function syncFilmstrip() {
    const frames = el.filmstrip.querySelectorAll('.film-frame');
    frames.forEach((frame, i) => {
      const current = i === state.activeLightboxIndex;
      frame.classList.toggle('is-current', current);
      frame.setAttribute('aria-selected', current ? 'true' : 'false');
      if (current) {
        // 手动计算滚动位置，避免 scrollIntoView 触发整页跳动
        const target = frame.offsetLeft - el.filmstrip.clientWidth / 2 + frame.offsetWidth / 2;
        el.filmstrip.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
      }
    });
  }

  function renderLightboxContent() {
    const item = state.items[state.activeLightboxIndex];
    if (!item) return;

    el.lbTitle.textContent = item.origName || item.key;
    el.lbCounter.textContent = `${pad4(state.activeLightboxIndex + 1)} / ${pad4(state.items.length)}`;
    el.lbMachine.textContent = item.machine;
    el.lbTime.textContent = formatTime(item.mtime || item.origMtime);
    el.lbSize.textContent = formatSize(item.size || item.origSize);

    const label = tags.summary(item);
    el.lbTags.textContent = label;
    el.lbTags.classList.toggle('hidden', !label);

    el.lbPrevBtn.style.display = state.activeLightboxIndex > 0 ? 'flex' : 'none';
    el.lbNextBtn.style.display = state.activeLightboxIndex < state.items.length - 1 ? 'flex' : 'none';

    el.lbImageSpinner.classList.remove('hidden');
    el.lbImage.style.opacity = '0.25';
    el.lbImage.onload = () => {
      el.lbImageSpinner.classList.add('hidden');
      el.lbImage.style.opacity = '1';
    };
    el.lbImage.src = mediaUrl(item, 'img');
    updateImageTransform();
    syncFilmstrip();
  }

  window.addEventListener('DOMContentLoaded', init);
})();

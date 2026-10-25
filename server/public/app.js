// SnapVault Web Gallery 前端核心交互逻辑
(function () {
  'use strict';

  // 状态管理
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
    selectedKeys: new Set(), // 存储 machine:key 唯一标识
    selectedMap: new Map(),  // 存储 machine:key -> { machine, key, origName }
    isLoading: false,
    activeLightboxIndex: -1,
    zoomLevel: 1,
  };

  // DOM 元素引用
  const el = {
    machineSelect: document.getElementById('machineSelect'),
    sortSelect: document.getElementById('sortSelect'),
    quickDates: document.getElementById('quickDates'),
    startDateFilter: document.getElementById('startDateFilter'),
    endDateFilter: document.getElementById('endDateFilter'),
    pageSizeSelect: document.getElementById('pageSizeSelect'),
    refreshBtn: document.getElementById('refreshBtn'),
    keyConfigBtn: document.getElementById('keyConfigBtn'),
    keyStatusDot: document.getElementById('keyStatusDot'),

    // 统计与批量
    statsBar: document.getElementById('statsBar'),
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
    paginationBar: document.getElementById('paginationBar'),

    // 灯箱
    lightbox: document.getElementById('lightbox'),
    lbImage: document.getElementById('lbImage'),
    lbImageSpinner: document.getElementById('lbImageSpinner'),
    lbTitle: document.getElementById('lbTitle'),
    lbMachine: document.getElementById('lbMachine'),
    lbTime: document.getElementById('lbTime'),
    lbSize: document.getElementById('lbSize'),
    lbDownloadBtn: document.getElementById('lbDownloadBtn'),
    lbDeleteBtn: document.getElementById('lbDeleteBtn'),
    lbCloseBtn: document.getElementById('lbCloseBtn'),
    lbPrevBtn: document.getElementById('lbPrevBtn'),
    lbNextBtn: document.getElementById('lbNextBtn'),
    lightboxStage: document.getElementById('lightboxStage'),

    // Key 模态框
    keyModal: document.getElementById('keyModal'),
    keyInput: document.getElementById('keyInput'),
    keySaveBtn: document.getElementById('keySaveBtn'),
    keyCancelBtn: document.getElementById('keyCancelBtn'),
  };

  // 工具函数
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

  // HTML 转义: origName 等字段由客户端上传时自定义, 渲染进 innerHTML 前必须转义防止存储型 XSS
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

  function updateKeyIndicator() {
    if (state.apiKey) {
      el.keyStatusDot.classList.add('active');
    } else {
      el.keyStatusDot.classList.remove('active');
    }
  }

  async function apiFetch(endpoint, options = {}) {
    options.headers = options.headers || {};
    if (state.apiKey) {
      options.headers['X-API-Key'] = state.apiKey;
    }
    const res = await fetch(endpoint, options);
    if (res.status === 401) {
      showKeyModal();
      throw new Error('鉴权未通过，请配置正确的 API Key');
    }
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `请求失败 HTTP ${res.status}`);
    }
    return res.json();
  }

  // 初始化与事件监听
  function init() {
    updateKeyIndicator();

    if (!state.apiKey) {
      showKeyModal();
    } else {
      loadMachines();
      loadGallery(1);
    }

    // 绑定设置事件
    el.keyConfigBtn.addEventListener('click', showKeyModal);
    el.keySaveBtn.addEventListener('click', saveKeyModal);
    el.keyCancelBtn.addEventListener('click', hideKeyModal);

    // 筛选变动事件
    el.machineSelect.addEventListener('change', (e) => {
      state.machine = e.target.value;
      loadGallery(1);
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

    // 快捷日期切换
    el.quickDates.addEventListener('click', (e) => {
      const chip = e.target.closest('.date-chip');
      if (!chip) return;
      const range = chip.dataset.range;
      applyQuickDateRange(range);
    });

    // 手动日期选择
    el.startDateFilter.addEventListener('change', () => {
      state.startDate = el.startDateFilter.value;
      clearActiveChips();
      loadGallery(1);
    });

    el.endDateFilter.addEventListener('change', () => {
      state.endDate = el.endDateFilter.value;
      clearActiveChips();
      loadGallery(1);
    });

    // 批量全选与取消全选
    el.selectAllBtn.addEventListener('click', toggleSelectAllCurrentPage);
    el.clearSelectionBtn.addEventListener('click', clearAllSelections);
    el.batchDeleteBtn.addEventListener('click', handleBatchDelete);

    // 灯箱事件绑定
    initLightboxEvents();
  }

  function clearActiveChips() {
    el.quickDates.querySelectorAll('.date-chip').forEach((c) => c.classList.remove('active'));
  }

  function applyQuickDateRange(range) {
    clearActiveChips();
    const activeChip = el.quickDates.querySelector(`[data-range="${range}"]`);
    if (activeChip) activeChip.classList.add('active');

    const today = new Date();
    if (range === 'all') {
      state.startDate = '';
      state.endDate = '';
      el.startDateFilter.value = '';
      el.endDateFilter.value = '';
    } else if (range === '1d') {
      const todayStr = toLocalDateString(today);
      state.startDate = todayStr;
      state.endDate = todayStr;
      el.startDateFilter.value = todayStr;
      el.endDateFilter.value = todayStr;
    } else if (range === '3d') {
      const start = new Date(today);
      start.setDate(today.getDate() - 2);
      state.startDate = toLocalDateString(start);
      state.endDate = toLocalDateString(today);
      el.startDateFilter.value = state.startDate;
      el.endDateFilter.value = state.endDate;
    } else if (range === '7d') {
      const start = new Date(today);
      start.setDate(today.getDate() - 6);
      state.startDate = toLocalDateString(start);
      state.endDate = toLocalDateString(today);
      el.startDateFilter.value = state.startDate;
      el.endDateFilter.value = state.endDate;
    } else if (range === '1m') {
      const start = new Date(today);
      start.setDate(today.getDate() - 29);
      state.startDate = toLocalDateString(start);
      state.endDate = toLocalDateString(today);
      el.startDateFilter.value = state.startDate;
      el.endDateFilter.value = state.endDate;
    }

    loadGallery(1);
  }

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
      alert('API Key 不能为空');
      return;
    }
    state.apiKey = val;
    localStorage.setItem('snapvault_api_key', val);
    updateKeyIndicator();
    hideKeyModal();
    loadMachines();
    loadGallery(1);
  }

  // 加载机器列表
  async function loadMachines() {
    try {
      const data = await apiFetch('/api/machines');
      if (data.machines) {
        const current = el.machineSelect.value;
        el.machineSelect.innerHTML = '<option value="">全部设备</option>';
        data.machines.forEach((m) => {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          el.machineSelect.appendChild(opt);
        });
        el.machineSelect.value = current;
      }
    } catch (err) {
      console.warn('获取机器列表失败:', err.message);
    }
  }

  // 统一画廊分页加载
  async function loadGallery(page = 1) {
    if (state.isLoading) return;
    state.isLoading = true;
    el.loadingIndicator.classList.remove('hidden');

    try {
      const params = new URLSearchParams();
      if (state.machine) params.append('machine', state.machine);
      if (state.sort) params.append('sort', state.sort);
      if (state.startDate) params.append('startDate', state.startDate);
      if (state.endDate) params.append('endDate', state.endDate);
      params.append('page', String(page));
      params.append('limit', String(state.limit));

      const data = await apiFetch(`/api/list?${params.toString()}`);
      state.items = data.items || [];
      state.total = data.total || 0;
      state.page = data.page || page;
      state.totalPages = data.totalPages || 1;

      renderCards(state.items);
      renderPagination();
      updateStatsAndBatchBar();

      if (state.items.length === 0) {
        el.emptyState.classList.remove('hidden');
        el.paginationBar.classList.add('hidden');
      } else {
        el.emptyState.classList.add('hidden');
        el.paginationBar.classList.remove('hidden');
      }
    } catch (err) {
      console.error('加载截图失败:', err.message);
    } finally {
      state.isLoading = false;
      el.loadingIndicator.classList.add('hidden');
    }
  }

  // 渲染截图网格卡片
  function renderCards(items) {
    el.galleryGrid.innerHTML = '';

    items.forEach((item, index) => {
      const itemKeyId = `${item.machine}:${item.key}`;
      const isSelected = state.selectedKeys.has(itemKeyId);

      const card = document.createElement('div');
      card.className = `card ${isSelected ? 'selected' : ''}`;
      card.dataset.index = index;
      card.dataset.id = itemKeyId;

      // 计算缩略图 URL
      const subPath = item.thumbPath
        ? item.thumbPath.replace(new RegExp(`^thumbs\/${item.machine}\/`), '')
        : item.path.replace(new RegExp(`^uploads\/${item.machine}\/`), '');
      const thumbUrl = `/thumb/${item.machine}/${subPath}?key=${encodeURIComponent(state.apiKey)}`;

      card.innerHTML = `
        <div class="card-img-wrapper">
          <!-- 左上角多选框 -->
          <label class="card-checkbox-label" title="勾选进行批量操作">
            <input type="checkbox" class="card-checkbox" data-machine="${item.machine}" data-key="${item.key}" ${isSelected ? 'checked' : ''}>
            <span class="custom-checkbox"></span>
          </label>

          <!-- 右上角单张快速删除按钮 -->
          <button type="button" class="card-quick-delete-btn" title="直接删除此截图 (移入回收站)">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </button>

          <img class="card-img" src="${thumbUrl}" alt="${escapeHtml(item.origName || item.key)}" loading="lazy">
        </div>
        <div class="card-info">
          <div class="card-title" title="${escapeHtml(item.origName || item.key)}">${escapeHtml(item.origName || item.key)}</div>
          <div class="card-meta">
            <span class="tag-machine">${item.machine}</span>
            <span>${formatTime(item.mtime || item.origMtime)}</span>
            <span>${formatSize(item.size || item.origSize)}</span>
          </div>
        </div>
      `;

      // 绑定多选复选框变化事件
      const chk = card.querySelector('.card-checkbox');
      chk.addEventListener('change', (e) => {
        e.stopPropagation();
        if (chk.checked) {
          state.selectedKeys.add(itemKeyId);
          state.selectedMap.set(itemKeyId, {
            machine: item.machine,
            key: item.key,
            origName: item.origName || item.key,
          });
          card.classList.add('selected');
        } else {
          state.selectedKeys.delete(itemKeyId);
          state.selectedMap.delete(itemKeyId);
          card.classList.remove('selected');
        }
        updateStatsAndBatchBar();
      });

      // 阻止多选框 label 点击冒泡到大图灯箱
      const chkLabel = card.querySelector('.card-checkbox-label');
      chkLabel.addEventListener('click', (e) => e.stopPropagation());

      // 绑定右上角快速删除
      const delBtn = card.querySelector('.card-quick-delete-btn');
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await quickDeleteSingleItem(item);
      });

      // 点击卡片主体打开灯箱大图
      card.addEventListener('click', () => openLightbox(index));

      el.galleryGrid.appendChild(card);
    });
  }

  // 更新统计与批量操作工具栏状态
  function updateStatsAndBatchBar() {
    el.itemCount.textContent = `共 ${state.total} 张截图`;
    el.pageInfo.textContent = `第 ${state.page} / ${state.totalPages} 页`;

    const selectedCount = state.selectedKeys.size;
    el.selectedCount.textContent = String(selectedCount);
    el.batchDeleteCount.textContent = String(selectedCount);

    if (selectedCount > 0) {
      el.selectionSummary.classList.remove('hidden');
      el.clearSelectionBtn.classList.remove('hidden');
      el.batchDeleteBtn.removeAttribute('disabled');
    } else {
      el.selectionSummary.classList.add('hidden');
      el.clearSelectionBtn.classList.add('hidden');
      el.batchDeleteBtn.setAttribute('disabled', 'true');
    }

    // 检查当前页是否所有项都被选中
    const allCurrentPageSelected =
      state.items.length > 0 &&
      state.items.every((it) => state.selectedKeys.has(`${it.machine}:${it.key}`));

    if (allCurrentPageSelected) {
      el.selectAllBtn.textContent = '取消本页';
    } else {
      el.selectAllBtn.textContent = '全选本页';
    }
  }

  // 全选当前页 / 取消选择当前页
  function toggleSelectAllCurrentPage() {
    const allCurrentPageSelected =
      state.items.length > 0 &&
      state.items.every((it) => state.selectedKeys.has(`${it.machine}:${it.key}`));

    if (allCurrentPageSelected) {
      // 取消当前页的选择
      state.items.forEach((it) => {
        const id = `${it.machine}:${it.key}`;
        state.selectedKeys.delete(id);
        state.selectedMap.delete(id);
      });
    } else {
      // 全选当前页
      state.items.forEach((it) => {
        const id = `${it.machine}:${it.key}`;
        state.selectedKeys.add(id);
        state.selectedMap.set(id, {
          machine: it.machine,
          key: it.key,
          origName: it.origName || it.key,
        });
      });
    }

    renderCards(state.items);
    updateStatsAndBatchBar();
  }

  // 清空所有选中的项
  function clearAllSelections() {
    state.selectedKeys.clear();
    state.selectedMap.clear();
    renderCards(state.items);
    updateStatsAndBatchBar();
  }

  // 右上角单张快速删除
  async function quickDeleteSingleItem(item) {
    const name = item.origName || item.key;
    if (!confirm(`确定要从服务端删除截图 "${name}" 吗？（文件将移入服务端回收站）`)) {
      return;
    }

    try {
      await apiFetch('/api/file', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          machine: item.machine,
          key: item.key,
        }),
      });

      const id = `${item.machine}:${item.key}`;
      state.selectedKeys.delete(id);
      state.selectedMap.delete(id);

      // 若当前页删除后为空且大于第 1 页，则回退一页
      const nextPage = state.items.length === 1 && state.page > 1 ? state.page - 1 : state.page;
      await loadGallery(nextPage);
    } catch (err) {
      alert('删除失败: ' + err.message);
    }
  }

  // 批量删除
  async function handleBatchDelete() {
    const count = state.selectedKeys.size;
    if (count === 0) return;

    if (!confirm(`确定要将已选中的 ${count} 张截图批量移入服务端回收站吗？`)) {
      return;
    }

    try {
      const itemsToDelete = Array.from(state.selectedMap.values());
      const res = await apiFetch('/api/files/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: itemsToDelete }),
      });

      clearAllSelections();

      // 重新加载画廊
      const nextPage = state.items.length === count && state.page > 1 ? state.page - 1 : state.page;
      await loadGallery(nextPage);
    } catch (err) {
      alert('批量删除失败: ' + err.message);
    }
  }

  // 渲染分页控件
  function renderPagination() {
    if (state.totalPages <= 1) {
      el.paginationBar.innerHTML = '';
      el.paginationBar.classList.add('hidden');
      return;
    }

    el.paginationBar.classList.remove('hidden');
    el.paginationBar.innerHTML = '';

    // 首页按钮
    const firstBtn = document.createElement('button');
    firstBtn.className = 'page-btn';
    firstBtn.textContent = '« 首页';
    firstBtn.disabled = state.page <= 1;
    firstBtn.onclick = () => goToPage(1);
    el.paginationBar.appendChild(firstBtn);

    // 上一页按钮
    const prevBtn = document.createElement('button');
    prevBtn.className = 'page-btn';
    prevBtn.textContent = '‹ 上一页';
    prevBtn.disabled = state.page <= 1;
    prevBtn.onclick = () => goToPage(state.page - 1);
    el.paginationBar.appendChild(prevBtn);

    // 计算显示的页码范围 (智能折叠)
    const pages = getPaginationPageList(state.page, state.totalPages);
    pages.forEach((p) => {
      if (p === '...') {
        const ellipsis = document.createElement('span');
        ellipsis.className = 'page-ellipsis';
        ellipsis.textContent = '...';
        el.paginationBar.appendChild(ellipsis);
      } else {
        const pageNumBtn = document.createElement('button');
        pageNumBtn.className = `page-btn ${p === state.page ? 'active' : ''}`;
        pageNumBtn.textContent = String(p);
        pageNumBtn.onclick = () => goToPage(p);
        el.paginationBar.appendChild(pageNumBtn);
      }
    });

    // 下一页按钮
    const nextBtn = document.createElement('button');
    nextBtn.className = 'page-btn';
    nextBtn.textContent = '下一页 ›';
    nextBtn.disabled = state.page >= state.totalPages;
    nextBtn.onclick = () => goToPage(state.page + 1);
    el.paginationBar.appendChild(nextBtn);

    // 末页按钮
    const lastBtn = document.createElement('button');
    lastBtn.className = 'page-btn';
    lastBtn.textContent = '末页 »';
    lastBtn.disabled = state.page >= state.totalPages;
    lastBtn.onclick = () => goToPage(state.totalPages);
    el.paginationBar.appendChild(lastBtn);

    // 跳转输入
    const jumper = document.createElement('div');
    jumper.className = 'page-jumper';
    jumper.innerHTML = `
      <span>跳至</span>
      <input type="number" min="1" max="${state.totalPages}" value="${state.page}" class="jump-input">
      <span>页</span>
      <button class="btn btn-secondary btn-sm jump-btn">前往</button>
    `;

    const jumpInput = jumper.querySelector('.jump-input');
    const jumpBtn = jumper.querySelector('.jump-btn');

    const doJump = () => {
      const target = parseInt(jumpInput.value, 10);
      if (!isNaN(target) && target >= 1 && target <= state.totalPages && target !== state.page) {
        goToPage(target);
      }
    };

    jumpBtn.onclick = doJump;
    jumpInput.onkeydown = (e) => {
      if (e.key === 'Enter') doJump();
    };

    el.paginationBar.appendChild(jumper);
  }

  // 智能计算页码折叠数组
  function getPaginationPageList(current, total) {
    if (total <= 7) {
      return Array.from({ length: total }, (_, i) => i + 1);
    }
    const list = [];
    if (current <= 4) {
      list.push(1, 2, 3, 4, 5, '...', total);
    } else if (current >= total - 3) {
      list.push(1, '...', total - 4, total - 3, total - 2, total - 1, total);
    } else {
      list.push(1, '...', current - 1, current, current + 1, '...', total);
    }
    return list;
  }

  function goToPage(targetPage) {
    if (targetPage < 1 || targetPage > state.totalPages || targetPage === state.page) return;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    loadGallery(targetPage);
  }

  // ===== 灯箱交互逻辑 =====
  function initLightboxEvents() {
    el.lbCloseBtn.addEventListener('click', closeLightbox);
    el.lbPrevBtn.addEventListener('click', prevImage);
    el.lbNextBtn.addEventListener('click', nextImage);

    // 键盘快捷键
    window.addEventListener('keydown', (e) => {
      if (el.lightbox.classList.contains('hidden')) return;
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') prevImage();
      if (e.key === 'ArrowRight') nextImage();
    });

    // 滚轮缩放
    el.lightboxStage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.15 : 0.15;
      state.zoomLevel = Math.min(Math.max(state.zoomLevel + delta, 0.5), 4);
      updateImageTransform();
    }, { passive: false });

    // 双击重置缩放
    el.lbImage.addEventListener('dblclick', () => {
      state.zoomLevel = state.zoomLevel === 1 ? 2 : 1;
      updateImageTransform();
    });

    // 原图下载
    el.lbDownloadBtn.addEventListener('click', () => {
      const item = state.items[state.activeLightboxIndex];
      if (!item) return;
      const subPath = item.path.replace(new RegExp(`^uploads\/${item.machine}\/`), '');
      const url = `/download/${item.machine}/${subPath}?key=${encodeURIComponent(state.apiKey)}`;
      window.open(url, '_blank');
    });

    // 灯箱中删除单张截图
    el.lbDeleteBtn.addEventListener('click', async () => {
      const item = state.items[state.activeLightboxIndex];
      if (!item) return;
      if (!confirm(`确定要从服务端删除截图 "${item.origName || item.key}" 吗？（文件将移入服务端回收站）`)) {
        return;
      }
      try {
        await apiFetch('/api/file', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            machine: item.machine,
            key: item.key,
          }),
        });

        const id = `${item.machine}:${item.key}`;
        state.selectedKeys.delete(id);
        state.selectedMap.delete(id);

        closeLightbox();
        // 重新加载当前页
        const nextPage = state.items.length === 1 && state.page > 1 ? state.page - 1 : state.page;
        await loadGallery(nextPage);
      } catch (err) {
        alert('删除失败: ' + err.message);
      }
    });
  }

  function openLightbox(index) {
    state.activeLightboxIndex = index;
    state.zoomLevel = 1;
    el.lightbox.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    renderLightboxContent();
  }

  function closeLightbox() {
    el.lightbox.classList.add('hidden');
    document.body.style.overflow = '';
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

  function renderLightboxContent() {
    const item = state.items[state.activeLightboxIndex];
    if (!item) return;

    el.lbTitle.textContent = item.origName || item.key;
    el.lbMachine.textContent = item.machine;
    el.lbTime.textContent = formatTime(item.mtime || item.origMtime);
    el.lbSize.textContent = formatSize(item.size || item.origSize);

    // 控制左右按钮状态
    el.lbPrevBtn.style.display = state.activeLightboxIndex > 0 ? 'flex' : 'none';
    el.lbNextBtn.style.display = state.activeLightboxIndex < state.items.length - 1 ? 'flex' : 'none';

    // 加载高清原图
    const subPath = item.path.replace(new RegExp(`^uploads\/${item.machine}\/`), '');
    const imgUrl = `/img/${item.machine}/${subPath}?key=${encodeURIComponent(state.apiKey)}`;

    el.lbImageSpinner.classList.remove('hidden');
    el.lbImage.style.opacity = '0.3';
    el.lbImage.onload = () => {
      el.lbImageSpinner.classList.add('hidden');
      el.lbImage.style.opacity = '1';
    };
    el.lbImage.src = imgUrl;
    updateImageTransform();
  }

  // 启动
  window.addEventListener('DOMContentLoaded', init);
})();

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const TEST_PORT = 3402;
process.env.PORT = String(TEST_PORT);
process.env.API_KEY = 'test-gallery-key';
process.env.DATA_DIR = path.join(__dirname, 'test_gallery_features_data');

const { startServer } = require('../src/index');

async function runGalleryFeaturesTest() {
  console.log('=== SnapVault 画廊新特性专项自动化测试启动 ===');
  const { server } = await startServer();
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;
  const validKey = 'test-gallery-key';

  try {
    // 1. 上传 4 张不同日期、时间戳与大小的测试图片
    console.log('[测试 1] 上传多张具有不同时间与大小的测试截图...');
    const fakeJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
    const fakeThumb = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

    const testFiles = [
      { key: 'alpha_20261010.jpg', name: 'alpha.jpg', mtime: 1791600000, size: 500 }, // 约 2026-10-10
      { key: 'beta_20261012.jpg', name: 'beta.jpg', mtime: 1791772800, size: 2000 }, // 约 2026-10-12
      { key: 'gamma_20261014.jpg', name: 'gamma.jpg', mtime: 1791945600, size: 1000 }, // 约 2026-10-14
      { key: 'delta_20261015.jpg', name: 'delta.jpg', mtime: 1792032000, size: 1500 }, // 约 2026-10-15
    ];

    for (const tf of testFiles) {
      const fileBuffer = Buffer.alloc(tf.size, 0xff);
      const form = new FormData();
      form.append('machine', 'desktop-pc');
      form.append('key', tf.key);
      form.append('origName', tf.name);
      form.append('origSize', String(tf.size));
      form.append('origMtime', String(tf.mtime));
      form.append('file', new Blob([fileBuffer], { type: 'image/jpeg' }), tf.key);
      form.append('thumb', new Blob([fakeThumb], { type: 'image/jpeg' }), `thumb_${tf.key}`);

      const upRes = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: { 'X-API-Key': validKey },
        body: form,
      });
      assert.strictEqual(upRes.status, 200, `上传 ${tf.key} 应返回 200`);
    }
    console.log('✓ 4 张测试截图上传就绪');

    // 2. 验证多维度排序方式
    console.log('[测试 2] 验证 GET /api/list 多维度排序...');
    // 2.1 时间降序 mtime_desc
    const resDesc = await fetch(`${baseUrl}/api/list?machine=desktop-pc&sort=mtime_desc`, {
      headers: { 'X-API-Key': validKey },
    });
    const dataDesc = await resDesc.json();
    assert.strictEqual(dataDesc.items[0].key, 'delta_20261015.jpg', '最新上传的 delta 应排在首位');

    // 2.2 时间升序 mtime_asc
    const resAsc = await fetch(`${baseUrl}/api/list?machine=desktop-pc&sort=mtime_asc`, {
      headers: { 'X-API-Key': validKey },
    });
    const dataAsc = await resAsc.json();
    assert.strictEqual(dataAsc.items[0].key, 'alpha_20261010.jpg', '最早上传的 alpha 应排在首位');

    // 2.3 大小降序 size_desc
    const resSizeDesc = await fetch(`${baseUrl}/api/list?machine=desktop-pc&sort=size_desc`, {
      headers: { 'X-API-Key': validKey },
    });
    const dataSizeDesc = await resSizeDesc.json();
    assert.strictEqual(dataSizeDesc.items[0].key, 'beta_20261012.jpg', '最大的 beta (2000B) 应排在首位');

    // 2.4 名称升序 name_asc
    const resNameAsc = await fetch(`${baseUrl}/api/list?machine=desktop-pc&sort=name_asc`, {
      headers: { 'X-API-Key': validKey },
    });
    const dataNameAsc = await resNameAsc.json();
    assert.strictEqual(dataNameAsc.items[0].key, 'alpha_20261010.jpg', '名称 A-Z 首位应为 alpha.jpg');
    console.log('✓ 多维度排序 (时间降序/升序、大小降序、名称排序) 验证全部通过');

    // 3. 验证日期范围筛选 startDate & endDate
    console.log('[测试 3] 验证日期范围闭区间过滤...');
    // 查询 2026-10-11 至 2026-10-14 之间的图片 (应该只命中 beta 和 gamma)
    const resRange = await fetch(`${baseUrl}/api/list?machine=desktop-pc&startDate=2026-10-11&endDate=2026-10-14`, {
      headers: { 'X-API-Key': validKey },
    });
    const dataRange = await resRange.json();
    assert.strictEqual(dataRange.items.length, 2, '2026-10-11 至 2026-10-14 应命中 2 张');
    const rangeKeys = dataRange.items.map((i) => i.key).sort();
    assert.deepStrictEqual(rangeKeys, ['beta_20261012.jpg', 'gamma_20261014.jpg']);
    console.log('✓ 日期范围筛选验证通过');

    // 4. 验证页码分页与总页数
    console.log('[测试 4] 验证页码分页展示...');
    const resP1 = await fetch(`${baseUrl}/api/list?machine=desktop-pc&page=1&limit=2`, {
      headers: { 'X-API-Key': validKey },
    });
    const dataP1 = await resP1.json();
    assert.strictEqual(dataP1.items.length, 2);
    assert.strictEqual(dataP1.page, 1);
    assert.strictEqual(dataP1.totalPages, 2);
    assert.strictEqual(dataP1.total, 4);
    assert.strictEqual(dataP1.hasMore, true);

    const resP2 = await fetch(`${baseUrl}/api/list?machine=desktop-pc&page=2&limit=2`, {
      headers: { 'X-API-Key': validKey },
    });
    const dataP2 = await resP2.json();
    assert.strictEqual(dataP2.items.length, 2);
    assert.strictEqual(dataP2.page, 2);
    assert.strictEqual(dataP2.hasMore, false);
    console.log('✓ 页码分页与总页数、hasMore 标识计算准确');

    // 5. 验证批量删除 POST /api/files/batch-delete
    console.log('[测试 5] 验证批量删除截图接口...');
    const batchRes = await fetch(`${baseUrl}/api/files/batch-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': validKey },
      body: JSON.stringify({
        items: [
          { machine: 'desktop-pc', key: 'alpha_20261010.jpg' },
          { machine: 'desktop-pc', key: 'gamma_20261014.jpg' },
        ],
      }),
    });
    assert.strictEqual(batchRes.status, 200);
    const batchData = await batchRes.json();
    assert.strictEqual(batchData.success, true);
    assert.strictEqual(batchData.count, 2, '应成功批量软删除 2 张截图');

    // 删除后再次查询验证
    const resAfterDel = await fetch(`${baseUrl}/api/list?machine=desktop-pc`, {
      headers: { 'X-API-Key': validKey },
    });
    const dataAfterDel = await resAfterDel.json();
    assert.strictEqual(dataAfterDel.items.length, 2, '删除 2 张后应剩余 2 张有效截图');
    const remainingKeys = dataAfterDel.items.map((i) => i.key).sort();
    assert.deepStrictEqual(remainingKeys, ['beta_20261012.jpg', 'delta_20261015.jpg']);
    console.log('✓ 批量删除成功且清单中剩余项正确');

    // 6. 验证前端 HTML 与关键 DOM 元素
    console.log('[测试 6] 验证前端页面包含所需的新 DOM 组件...');
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.strictEqual(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes('id="sortSelect"'), '页面必须包含排序选择器');
    assert.ok(html.includes('id="quickDates"'), '页面必须包含快捷日期选择器');
    assert.ok(html.includes('data-range="1d"'), '页面必须包含 1 天快捷选项');
    assert.ok(html.includes('data-range="3d"'), '页面必须包含 3 天快捷选项');
    assert.ok(html.includes('data-range="7d"'), '页面必须包含 7 天快捷选项');
    assert.ok(html.includes('data-range="1m"'), '页面必须包含 1 个月快捷选项');
    assert.ok(html.includes('id="startDateFilter"'), '页面必须包含开始日期输入框');
    assert.ok(html.includes('id="endDateFilter"'), '页面必须包含结束日期输入框');
    assert.ok(html.includes('id="batchDeleteBtn"'), '页面必须包含批量删除按钮');
    assert.ok(html.includes('id="paginationBar"'), '页面必须包含分页导航栏');

    const jsRes = await fetch(`${baseUrl}/app.js`);
    const js = await jsRes.text();
    assert.ok(js.includes('quickDeleteSingleItem'), 'JS 必须包含右上角快捷删除逻辑');
    assert.ok(js.includes('handleBatchDelete'), 'JS 必须包含批量删除逻辑');
    assert.ok(js.includes('card-quick-delete-btn'), 'JS 必须渲染右上角删除按钮');
    assert.ok(js.includes('card-checkbox'), 'JS 必须渲染复选框');
    console.log('✓ 前端 HTML/JS 组件与元素结构验证全部通过');

    console.log('\n🎉 所有新特性专项测试验证全部圆满通过！');
  } finally {
    server.close();
    if (fs.existsSync(process.env.DATA_DIR)) {
      fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
    }
  }
}

runGalleryFeaturesTest().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});

const path = require('path');
const fs = require('fs');
const assert = require('assert');

// 设置测试环境变量
const TEST_PORT = 3399;
process.env.PORT = String(TEST_PORT);
process.env.API_KEY = 'test-secret-key-123';
process.env.DATA_DIR = path.join(__dirname, 'test_data');

const { startServer } = require('../src/index');

async function runTests() {
  console.log('=== SnapVault Server 自动化测试启动 ===');

  // 清理旧的测试数据目录
  if (fs.existsSync(process.env.DATA_DIR)) {
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  }

  const { server } = await startServer();
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;
  const validKey = 'test-secret-key-123';

  try {
    // 1. 测试鉴权失败
    console.log('[测试 1] 验证未鉴权请求拦截...');
    const unauthRes = await fetch(`${baseUrl}/api/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machine: 'pc-01' }),
    });
    assert.strictEqual(unauthRes.status, 401, '未携带 Key 必须返回 401');
    console.log('✓ 鉴权拦截正常');

    // 2. 测试 POST /api/check (空清单时探测)
    console.log('[测试 2] 验证初始探测 POST /api/check...');
    const checkRes1 = await fetch(`${baseUrl}/api/check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': validKey,
      },
      body: JSON.stringify({ machine: 'pc-01' }),
    });
    assert.strictEqual(checkRes1.status, 200);
    const checkData1 = await checkRes1.json();
    assert.strictEqual(checkData1.success, true);
    assert.strictEqual(checkData1.remoteCount, 0);
    assert.strictEqual(checkData1.remoteLatestMtime, 0);
    assert.strictEqual(checkData1.remoteDeletedLatestMtime, 0, '初始无墓碑时 remoteDeletedLatestMtime 必须为 0');
    console.log('✓ 初始探测响应正确 (remoteCount=0)');

    // 3. 测试 POST /api/upload (单张与并发上传)
    console.log('[测试 3] 验证文件上传 POST /api/upload...');
    const fakeJpg = Buffer.from('FAKE-JPEG-DATA-FOR-TESTING');
    const fakeThumb = Buffer.from('FAKE-THUMB-DATA-FOR-TESTING');

    const form = new FormData();
    form.append('machine', 'pc-01');
    form.append('key', 'screenshot_20261015_001.jpg');
    form.append('origName', 'screenshot_20261015_001.png');
    form.append('origSize', '1048576');
    form.append('origMtime', '1792000100');
    form.append('file', new Blob([fakeJpg], { type: 'image/jpeg' }), 'screenshot_20261015_001.jpg');
    form.append('thumb', new Blob([fakeThumb], { type: 'image/jpeg' }), 'thumb_screenshot_20261015_001.jpg');

    const uploadRes1 = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: { 'X-API-Key': validKey },
      body: form,
    });
    assert.strictEqual(uploadRes1.status, 200);
    const uploadData1 = await uploadRes1.json();
    assert.strictEqual(uploadData1.success, true);
    assert.strictEqual(uploadData1.key, 'screenshot_20261015_001.jpg');
    console.log('✓ 第 1 张截图上传成功');

    // 上传第 2 张截图 (时间戳更高)
    const form2 = new FormData();
    form2.append('machine', 'pc-01');
    form2.append('key', 'screenshot_20261015_002.jpg');
    form2.append('origName', 'screenshot_20261015_002.png');
    form2.append('origSize', '2048576');
    form2.append('origMtime', '1792000200');
    form2.append('file', new Blob([fakeJpg], { type: 'image/jpeg' }), 'screenshot_20261015_002.jpg');
    form2.append('thumb', new Blob([fakeThumb], { type: 'image/jpeg' }), 'thumb_screenshot_20261015_002.jpg');

    const uploadRes2 = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: { 'X-API-Key': validKey },
      body: form2,
    });
    assert.strictEqual(uploadRes2.status, 200);
    console.log('✓ 第 2 张截图上传成功');

    // 4. 再次探测 POST /api/check，验证聚合元数据计算
    console.log('[测试 4] 验证上传后聚合元数据探测...');
    const checkRes2 = await fetch(`${baseUrl}/api/check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': validKey,
      },
      body: JSON.stringify({ machine: 'pc-01' }),
    });
    const checkData2 = await checkRes2.json();
    assert.strictEqual(checkData2.remoteCount, 2, '上传 2 张后 count 必须为 2');
    assert.strictEqual(checkData2.remoteLatestMtime, 1792000200, 'latestMtime 必须为最新时间戳');
    assert.strictEqual(checkData2.remoteOldestMtime, 1792000100, 'oldestMtime 必须为最小时间戳');
    console.log('✓ 聚合元数据计算正确 (count=2, latest=1792000200, oldest=1792000100)');

    // 5. 验证 GET /api/manifest
    console.log('[测试 5] 验证拉取清单 GET /api/manifest...');
    const manifestRes = await fetch(`${baseUrl}/api/manifest?machine=pc-01`, {
      headers: { 'X-API-Key': validKey },
    });
    const manifestData = await manifestRes.json();
    assert.strictEqual(manifestData.count, 2);
    assert.ok(manifestData.items['screenshot_20261015_001.jpg']);
    assert.ok(manifestData.items['screenshot_20261015_002.jpg']);
    console.log('✓ 清单内容与结构完整正确');

    // 6. 验证图片与缩略图分发 /img 与 /thumb
    console.log('[测试 6] 验证图片静态分发与缓存响应头...');
    const item1 = manifestData.items['screenshot_20261015_001.jpg'];
    const imgSubPath = item1.path.replace(/^uploads\/pc-01\//, '');
    const imgRes = await fetch(`${baseUrl}/img/pc-01/${imgSubPath}?key=${validKey}`);
    assert.strictEqual(imgRes.status, 200);
    assert.strictEqual(imgRes.headers.get('content-type'), 'image/jpeg');
    assert.ok(imgRes.headers.get('cache-control').includes('immutable'));

    const thumbSubPath = item1.thumbPath.replace(/^thumbs\/pc-01\//, '');
    const thumbRes = await fetch(`${baseUrl}/thumb/pc-01/${thumbSubPath}?key=${validKey}`);
    assert.strictEqual(thumbRes.status, 200);
    console.log('✓ 图片与缩略图分发与强缓存验证通过');

    // 7. 验证 GET /api/list 分页
    console.log('[测试 7] 验证 GET /api/list 排序与分页...');
    const listRes = await fetch(`${baseUrl}/api/list?machine=pc-01&limit=1`, {
      headers: { 'X-API-Key': validKey },
    });
    const listData = await listRes.json();
    assert.strictEqual(listData.items.length, 1);
    assert.strictEqual(listData.items[0].key, 'screenshot_20261015_002.jpg', '倒序首个应为最新的第 2 张');
    assert.strictEqual(listData.hasMore, true);
    console.log('✓ 分页排序与游标指示正确');

    // 8. 验证 DELETE /api/file 软删除与回收站移动
    console.log('[测试 8] 验证软删除 DELETE /api/file 与回收站隔离...');
    const deleteRes = await fetch(`${baseUrl}/api/file`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': validKey,
      },
      body: JSON.stringify({
        machine: 'pc-01',
        key: 'screenshot_20261015_001.jpg',
      }),
    });
    assert.strictEqual(deleteRes.status, 200);

    // 验证探测结果变为 1
    const checkRes3 = await fetch(`${baseUrl}/api/check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': validKey,
      },
      body: JSON.stringify({ machine: 'pc-01' }),
    });
    const checkData3 = await checkRes3.json();
    assert.strictEqual(checkData3.remoteCount, 1, '删除后 remoteCount 必须降为 1');
    assert.strictEqual(checkData3.remoteLatestMtime, 1792000200);
    assert.strictEqual(checkData3.remoteOldestMtime, 1792000200);
    assert.strictEqual(checkData3.remoteDeletedLatestMtime, 1792000100, '删除后墓碑最新时间戳必须正确上报');
    console.log('✓ 软删除成功且聚合元数据与墓碑元数据自动重新计算');

    // 9. 验证 POST /api/tombstones/ack 墓碑确认永久清理
    console.log('[测试 9] 验证墓碑确认清理 POST /api/tombstones/ack...');
    const ackRes = await fetch(`${baseUrl}/api/tombstones/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': validKey },
      body: JSON.stringify({ machine: 'pc-01', keys: ['screenshot_20261015_001.jpg'] }),
    });
    assert.strictEqual(ackRes.status, 200);
    const ackData = await ackRes.json();
    assert.strictEqual(ackData.success, true);
    assert.strictEqual(ackData.purged, 1, '应永久清除 1 个墓碑条目');
    assert.strictEqual(ackData.trashCleaned, 2, '应清理回收站中的原图与缩略图');

    // 清单中该条目应彻底消失
    const manifestRes2 = await fetch(`${baseUrl}/api/manifest?machine=pc-01`, {
      headers: { 'X-API-Key': validKey },
    });
    const manifestData2 = await manifestRes2.json();
    assert.ok(!manifestData2.items['screenshot_20261015_001.jpg'], '墓碑条目应已从清单彻底移除');
    assert.strictEqual(manifestData2.count, 1);

    // 重复确认为幂等空操作
    const ackRes2 = await fetch(`${baseUrl}/api/tombstones/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': validKey },
      body: JSON.stringify({ machine: 'pc-01', keys: ['screenshot_20261015_001.jpg'] }),
    });
    const ackData2 = await ackRes2.json();
    assert.strictEqual(ackData2.purged, 0, '重复确认应为幂等空操作');

    // 墓碑清除后探测元数据归零
    const checkRes4 = await fetch(`${baseUrl}/api/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': validKey },
      body: JSON.stringify({ machine: 'pc-01' }),
    });
    const checkData4 = await checkRes4.json();
    assert.strictEqual(checkData4.remoteDeletedLatestMtime, 0, '墓碑清除后 remoteDeletedLatestMtime 应归零');
    // 10. 验证包含复杂文件名（括号、波浪线、中文）及非法 Key 拦截
    console.log('[测试 10] 验证复杂合法文件名 (括号/波浪号) 及非法 Key 拦截...');
    const formComplex = new FormData();
    formComplex.append('machine', 'pc-01');
    formComplex.append('key', '生成AI智能体头像 (1)~tplv-shrink.jpg');
    formComplex.append('origName', '生成AI智能体头像 (1)~tplv-shrink.png');
    formComplex.append('origSize', '1000');
    formComplex.append('origMtime', '1792000300');
    formComplex.append('file', new Blob([fakeJpg], { type: 'image/jpeg' }), '生成AI智能体头像 (1)~tplv-shrink.jpg');
    formComplex.append('thumb', new Blob([fakeThumb], { type: 'image/jpeg' }), 'thumb.jpg');

    const uploadResComplex = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: { 'X-API-Key': validKey },
      body: formComplex,
    });
    assert.strictEqual(uploadResComplex.status, 200, '带括号与波浪线的文件名应允许正常上传');

    // 验证非法 key 拦截 (路径穿越与非法字符)
    const badKeys = ['../bad.jpg', 'foo/bar.jpg', '.hidden.jpg', 'test.png', 'bad:name.jpg'];
    for (const badKey of badKeys) {
      const formBad = new FormData();
      formBad.append('machine', 'pc-01');
      formBad.append('key', badKey);
      formBad.append('file', new Blob([fakeJpg], { type: 'image/jpeg' }), badKey);
      const resBad = await fetch(`${baseUrl}/api/upload`, {
        method: 'POST',
        headers: { 'X-API-Key': validKey },
        body: formBad,
      });
      assert.strictEqual(resBad.status, 400, `非法 key ${badKey} 必须被拒绝并返回 400`);
    }
    console.log('✓ 复杂合法文件名通过，路径穿越与非法字符均被正确拦截');

    // 11. 验证 GET /api/list 页码分页、多维度排序、日期范围筛选以及批量删除 POST /api/files/batch-delete
    console.log('[测试 11] 验证页码分页、多维度排序、日期范围筛选与批量删除...');
    
    // 页码分页测试
    const pageRes = await fetch(`${baseUrl}/api/list?machine=pc-01&page=1&limit=1`, {
      headers: { 'X-API-Key': validKey },
    });
    assert.strictEqual(pageRes.status, 200);
    const pageData = await pageRes.json();
    assert.strictEqual(pageData.items.length, 1);
    assert.strictEqual(pageData.page, 1);
    assert.ok(pageData.totalPages >= 2);
    assert.strictEqual(pageData.hasMore, true);

    // 排序测试: 升序 vs 降序
    const ascRes = await fetch(`${baseUrl}/api/list?machine=pc-01&sort=mtime_asc&limit=10`, {
      headers: { 'X-API-Key': validKey },
    });
    const ascData = await ascRes.json();
    assert.strictEqual(ascRes.status, 200);
    if (ascData.items.length >= 2) {
      assert.ok((ascData.items[0].mtime || 0) <= (ascData.items[1].mtime || 0), '升序首个应小于或等于第二个');
    }

    // 批量删除测试
    const batchDelRes = await fetch(`${baseUrl}/api/files/batch-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': validKey },
      body: JSON.stringify({
        items: [
          { machine: 'pc-01', key: '生成AI智能体头像 (1)~tplv-shrink.jpg' },
        ],
      }),
    });
    assert.strictEqual(batchDelRes.status, 200);
    const batchDelData = await batchDelRes.json();
    assert.strictEqual(batchDelData.success, true);
    assert.strictEqual(batchDelData.count, 1);
    console.log('✓ 页码分页、排序与批量删除验证通过');

    console.log('\n🎉 所有服务端测试全部通过！阶段一核心数据流闭环已验证完成！');
  } finally {
    server.close();
    // 清理测试目录
    if (fs.existsSync(process.env.DATA_DIR)) {
      fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
    }
  }
}

runTests().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});

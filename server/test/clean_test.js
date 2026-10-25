const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { execSync } = require('child_process');

// 设置独立测试环境变量
const TEST_PORT = 3401;
const TEST_DATA_DIR = path.join(__dirname, 'test_clean_data');

process.env.PORT = String(TEST_PORT);
process.env.API_KEY = 'clean-test-secret-key-123';
process.env.DATA_DIR = TEST_DATA_DIR;

// 在加载配置前清理并创建临时目录
if (fs.existsSync(TEST_DATA_DIR)) {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
}

const config = require('../src/config');
const { ensureDir } = require('../src/files');
const cleaner = require('../src/cleaner');
const manifestManager = require('../src/manifest');
const { startServer } = require('../src/index');

async function setupMockMachine(machineName) {
  const uploadsDir = path.join(config.uploadsDir, machineName, '2026', '10', '15');
  const thumbsDir = path.join(config.thumbsDir, machineName, '2026', '10', '15');
  const trashDir = path.join(config.trashDir, machineName, '20261015');
  const manifestsDir = config.manifestsDir;

  await ensureDir(uploadsDir);
  await ensureDir(thumbsDir);
  await ensureDir(trashDir);
  await ensureDir(manifestsDir);

  // 写入原图
  fs.writeFileSync(path.join(uploadsDir, 'shot1.jpg'), Buffer.alloc(1024 * 10, 'A')); // 10KB
  fs.writeFileSync(path.join(uploadsDir, 'shot2.jpg'), Buffer.alloc(1024 * 20, 'B')); // 20KB

  // 写入缩略图
  fs.writeFileSync(path.join(thumbsDir, 'shot1.jpg'), Buffer.alloc(1024 * 2, 'T'));  // 2KB
  fs.writeFileSync(path.join(thumbsDir, 'shot2.jpg'), Buffer.alloc(1024 * 2, 'T'));  // 2KB

  // 写入回收站
  fs.writeFileSync(path.join(trashDir, 'deleted.jpg'), Buffer.alloc(1024 * 5, 'D')); // 5KB

  // 写入清单文件
  const manifestData = {
    machine: machineName,
    count: 2,
    latestMtime: 1729000000,
    items: {
      'shot1.jpg': { key: 'shot1.jpg', size: 10240, mtime: 1729000000 },
      'shot2.jpg': { key: 'shot2.jpg', size: 20480, mtime: 1729000001 },
      'deleted.jpg': { key: 'deleted.jpg', size: 5120, deletedAt: 1729000010 },
    },
  };
  fs.writeFileSync(path.join(manifestsDir, `${machineName}.json`), JSON.stringify(manifestData, null, 2));
}

async function runCleanTests() {
  console.log('=== SnapVault 清理功能 (Clean Machine) 自动化测试启动 ===');

  let serverInstance = null;

  try {
    const { server } = await startServer();
    serverInstance = server;
    const baseUrl = `http://127.0.0.1:${TEST_PORT}`;
    const validKey = 'clean-test-secret-key-123';

    // -------------------------------------------------------------
    // 测试 1: 创建模拟数据并验证 inspectMachine 探测统计
    // -------------------------------------------------------------
    console.log('[测试 1] 验证 inspectMachine 统计精度...');
    await setupMockMachine('test-pc-01');

    const stats1 = await cleaner.inspectMachine('test-pc-01');
    assert.strictEqual(stats1.exists, true);
    assert.strictEqual(stats1.uploads.count, 2, '原图应有 2 张');
    assert.strictEqual(stats1.uploads.totalBytes, 30720, '原图大小应为 30KB');
    assert.strictEqual(stats1.thumbs.count, 2, '缩略图应有 2 张');
    assert.strictEqual(stats1.trash.count, 1, '回收站应有 1 张');
    assert.strictEqual(stats1.manifest.exists, true, '清单文件应存在');
    assert.strictEqual(stats1.manifest.itemsCount, 3, '清单条目应为 3 条');
    assert.strictEqual(stats1.totalFiles, 6, '总文件数应为 2+2+1+1 = 6');
    console.log('✓ inspectMachine 统计探测验证通过');

    // -------------------------------------------------------------
    // 测试 2: 验证 dryRun 试运行模式 (不应删除任何文件)
    // -------------------------------------------------------------
    console.log('[测试 2] 验证 dryRun 模式 (保持数据完整)...');
    const dryRunResult = await cleaner.cleanMachineData('test-pc-01', { dryRun: true });
    assert.strictEqual(dryRunResult.dryRun, true);
    assert.strictEqual(dryRunResult.cleaned, false);
    // 检查原图和清单依然存在
    assert.ok(fs.existsSync(path.join(config.uploadsDir, 'test-pc-01')), 'dryRun 模式下原图目录不应被删除');
    assert.ok(fs.existsSync(path.join(config.manifestsDir, 'test-pc-01.json')), 'dryRun 模式下清单文件不应被删除');
    console.log('✓ dryRun 试运行安全模式验证通过');

    // -------------------------------------------------------------
    // 测试 3: 验证真实清理 cleanMachineData
    // -------------------------------------------------------------
    console.log('[测试 3] 验证 cleanMachineData 彻底清理...');
    const cleanResult = await cleaner.cleanMachineData('test-pc-01', { dryRun: false });
    assert.strictEqual(cleanResult.cleaned, true);

    // 验证目录及文件是否已彻底移除
    assert.ok(!fs.existsSync(path.join(config.uploadsDir, 'test-pc-01')), '原图目录应被彻底删除');
    assert.ok(!fs.existsSync(path.join(config.thumbsDir, 'test-pc-01')), '缩略图目录应被彻底删除');
    assert.ok(!fs.existsSync(path.join(config.trashDir, 'test-pc-01')), '回收站目录应被彻底删除');
    assert.ok(!fs.existsSync(path.join(config.manifestsDir, 'test-pc-01.json')), '清单文件应被彻底删除');

    // 验证 listMachines 列表不再包含该机器
    const machinesAfterClean = await manifestManager.listMachines();
    assert.ok(!machinesAfterClean.includes('test-pc-01'), '机器列表中不应再包含 test-pc-01');
    console.log('✓ cleanMachineData 彻底清除验证通过');

    // -------------------------------------------------------------
    // 测试 4: 幂等性与未注册机器清理
    // -------------------------------------------------------------
    console.log('[测试 4] 验证对已清理或不存在机器重复清理的幂等性...');
    const statsNonExist = await cleaner.inspectMachine('non-existent-pc');
    assert.strictEqual(statsNonExist.exists, false);
    const cleanNonExist = await cleaner.cleanMachineData('non-existent-pc', { dryRun: false });
    assert.strictEqual(cleanNonExist.cleaned, true);
    assert.strictEqual(cleanNonExist.totalFiles, 0);
    console.log('✓ 幂等性验证通过');

    // -------------------------------------------------------------
    // 测试 5: 验证 DELETE /api/machine 接口
    // -------------------------------------------------------------
    console.log('[测试 5] 验证 DELETE /api/machine 路由与鉴权...');
    await setupMockMachine('test-pc-api');

    // 5.1 未携带 API Key 应返回 401
    const unauthRes = await fetch(`${baseUrl}/api/machine?machine=test-pc-api`, {
      method: 'DELETE',
    });
    assert.strictEqual(unauthRes.status, 401);

    // 5.2 缺少 machine 参数应返回 400
    const noParamRes = await fetch(`${baseUrl}/api/machine`, {
      method: 'DELETE',
      headers: { 'X-API-Key': validKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(noParamRes.status, 400);

    // 5.3 携带非法字符应返回 400 (防路径穿越)
    const badParamRes = await fetch(`${baseUrl}/api/machine`, {
      method: 'DELETE',
      headers: { 'X-API-Key': validKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ machine: '../../etc' }),
    });
    assert.strictEqual(badParamRes.status, 400);

    // 5.4 正常调用删除
    const deleteRes = await fetch(`${baseUrl}/api/machine`, {
      method: 'DELETE',
      headers: { 'X-API-Key': validKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ machine: 'test-pc-api' }),
    });
    assert.strictEqual(deleteRes.status, 200);
    const deleteData = await deleteRes.json();
    assert.strictEqual(deleteData.success, true);
    assert.strictEqual(deleteData.cleaned, true);
    assert.ok(!fs.existsSync(path.join(config.manifestsDir, 'test-pc-api.json')));
    console.log('✓ DELETE /api/machine API 验证通过');

    // -------------------------------------------------------------
    // 测试 6: 验证 CLI 命令行工具 (src/clean.js)
    // -------------------------------------------------------------
    console.log('[测试 6] 验证 CLI 命令行 (node src/clean.js)...');
    await setupMockMachine('test-pc-cli');

    const cleanScriptPath = path.resolve(__dirname, '../src/clean.js');

    // 6.1 测试 --list
    const listOutput = execSync(`node "${cleanScriptPath}" --list`, {
      env: { ...process.env, DATA_DIR: TEST_DATA_DIR },
      encoding: 'utf8',
    });
    assert.ok(listOutput.includes('test-pc-cli'), 'CLI --list 输出应包含 test-pc-cli');

    // 6.2 测试 --dry-run
    const dryRunOutput = execSync(`node "${cleanScriptPath}" -m test-pc-cli --dry-run`, {
      env: { ...process.env, DATA_DIR: TEST_DATA_DIR },
      encoding: 'utf8',
    });
    assert.ok(dryRunOutput.includes('试运行预览'), 'CLI 试运行输出正常');
    assert.ok(fs.existsSync(path.join(config.manifestsDir, 'test-pc-cli.json')), 'dry-run 不应删除清单');

    // 6.3 测试 -y 真实执行清理
    const execOutput = execSync(`node "${cleanScriptPath}" -m test-pc-cli -y`, {
      env: { ...process.env, DATA_DIR: TEST_DATA_DIR },
      encoding: 'utf8',
    });
    assert.ok(execOutput.includes('已彻底清理完毕'), 'CLI 清理报告输出正常');
    assert.ok(!fs.existsSync(path.join(config.manifestsDir, 'test-pc-cli.json')), 'CLI 执行后清单应已删除');
    assert.ok(!fs.existsSync(path.join(config.uploadsDir, 'test-pc-cli')), 'CLI 执行后原图目录应已删除');

    console.log('✓ CLI 命令行工具全流程验证通过');

    console.log('\n🎉 所有清理功能自动化测试全部通过！');
  } finally {
    if (serverInstance) {
      serverInstance.close();
    }
    // 清理临时测试数据
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    }
  }
}

runCleanTests().catch((err) => {
  console.error('\n测试失败:', err);
  process.exit(1);
});

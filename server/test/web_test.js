const path = require('path');
const fs = require('fs');
const assert = require('assert');

const TEST_PORT = 3398;
process.env.PORT = String(TEST_PORT);
process.env.API_KEY = 'test-web-key';
process.env.DATA_DIR = path.join(__dirname, 'test_web_data');

const { startServer } = require('../src/index');

async function testWeb() {
  console.log('=== Web 静态资源与画廊托管测试 ===');
  const { server } = await startServer();
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    // 1. 请求根路径获取 index.html (免鉴权托管)
    const resHtml = await fetch(`${baseUrl}/`);
    assert.strictEqual(resHtml.status, 200);
    const htmlText = await resHtml.text();
    assert.ok(htmlText.includes('SnapVault'), 'HTML 中应包含 SnapVault 标题');
    console.log('✓ index.html 正常分发');

    // 2. 请求 style.css
    const resCss = await fetch(`${baseUrl}/style.css`);
    assert.strictEqual(resCss.status, 200);
    const cssText = await resCss.text();
    assert.ok(cssText.includes('--bg-primary'), 'CSS 应包含变量定义');
    console.log('✓ style.css 正常分发');

    // 3. 请求 app.js
    const resJs = await fetch(`${baseUrl}/app.js`);
    assert.strictEqual(resJs.status, 200);
    const jsText = await resJs.text();
    assert.ok(jsText.includes('openLightbox'), 'JS 应包含灯箱控制');
    console.log('✓ app.js 正常分发');

    console.log('\n🎉 阶段二 Web 画廊静态托管验证全部通过！');
  } finally {
    server.close();
    if (fs.existsSync(process.env.DATA_DIR)) {
      fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
    }
  }
}

testWeb().catch((err) => {
  console.error(err);
  process.exit(1);
});

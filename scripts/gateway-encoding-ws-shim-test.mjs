#!/usr/bin/env node
/**
 * Issue #10 本地单元级回归测试：
 *   1. WebSocket wss:// 安全升级 shim（node:vm 验证各协议、常量、原型、幂等与 HTTP/HTTPS 隔离）
 *   2. Content-Encoding 解压与 HTML/JS 注入替换（node:zlib 验证 gzip/deflate/br、未知编码与损坏降级）
 *   3. 模拟网关 proxyRes 响应生命周期（流式无压缩、缓冲解压、删除 Content-Encoding、失败回退）
 *
 * 用法: node scripts/gateway-encoding-ws-shim-test.mjs
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import zlib from 'node:zlib';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const {
  RANDOM_UUID_POLYFILL,
  WS_UPGRADE_SHIM,
  injectPolyfill,
  getEncodingType,
  decompressBuffer
} = require(path.join(ROOT, 'gateway/token-crawler.js'));

let pass = 0, fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (err) {
    fail++;
    console.log('  ✗ ' + name + '\n      ' + (err && err.stack ? err.stack : err));
  }
}

// 伪造标准 WebSocket 构造函数
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, protocols) {
    this.url = String(url && url.href ? url.href : url);
    this.protocols = protocols;
    this.readyState = MockWebSocket.CONNECTING;
  }
  send() {}
  close() {}
}

console.log('\n[模块 1] WebSocket wss:// 安全升级 shim（node:vm 隔离测试）');

check('HTTPS 页面下 ws:// 自动改写为 wss://，保留端口、路径、查询与 Hash', () => {
  const ctx = vm.createContext({
    window: { location: { protocol: 'https:', href: 'https://example.com/viewer' } },
    location: { protocol: 'https:', href: 'https://example.com/viewer' },
    WebSocket: MockWebSocket,
    URL
  });
  ctx.globalThis = ctx;
  vm.runInContext(WS_UPGRADE_SHIM, ctx);

  const ws = new ctx.WebSocket('ws://example.com:18443/events/mux?token=abc#live');
  assert.equal(ws.url, 'wss://example.com:18443/events/mux?token=abc#live');
  assert.equal(ws instanceof ctx.WebSocket, true);
  assert.equal(ws instanceof MockWebSocket, true);
});

check('HTTPS 页面下 URL 对象实例参数也能正确改写为 wss', () => {
  const ctx = vm.createContext({
    window: { location: { protocol: 'https:', href: 'https://example.com/' } },
    location: { protocol: 'https:', href: 'https://example.com/' },
    WebSocket: MockWebSocket,
    URL
  });
  ctx.globalThis = ctx;
  vm.runInContext(WS_UPGRADE_SHIM, ctx);

  const target = new URL('ws://example.com/channel');
  const ws = new ctx.WebSocket(target);
  assert.equal(ws.url, 'wss://example.com/channel');
});

check('HTTPS 页面下 原生 wss://、http:// 等非 ws 协议保持原样，不被误改写', () => {
  const ctx = vm.createContext({
    window: { location: { protocol: 'https:', href: 'https://example.com/' } },
    location: { protocol: 'https:', href: 'https://example.com/' },
    WebSocket: MockWebSocket,
    URL
  });
  ctx.globalThis = ctx;
  vm.runInContext(WS_UPGRADE_SHIM, ctx);

  const ws1 = new ctx.WebSocket('wss://example.com/already-secure');
  assert.equal(ws1.url, 'wss://example.com/already-secure');

  const ws2 = new ctx.WebSocket('http://example.com/test');
  assert.equal(ws2.url, 'http://example.com/test');
});

check('子协议 protocols 参数透明传递给底层构造函数', () => {
  const ctx = vm.createContext({
    window: { location: { protocol: 'https:', href: 'https://example.com/' } },
    location: { protocol: 'https:', href: 'https://example.com/' },
    WebSocket: MockWebSocket,
    URL
  });
  ctx.globalThis = ctx;
  vm.runInContext(WS_UPGRADE_SHIM, ctx);

  const ws = new ctx.WebSocket('ws://example.com/ws', ['graphql-ws', 'v1']);
  assert.equal(ws.url, 'wss://example.com/ws');
  assert.deepEqual(ws.protocols, ['graphql-ws', 'v1']);
});

check('WebSocket 原型链与静态常量（CONNECTING/OPEN/CLOSING/CLOSED）完整保留', () => {
  const ctx = vm.createContext({
    window: { location: { protocol: 'https:', href: 'https://example.com/' } },
    location: { protocol: 'https:', href: 'https://example.com/' },
    WebSocket: MockWebSocket,
    URL
  });
  ctx.globalThis = ctx;
  vm.runInContext(WS_UPGRADE_SHIM, ctx);

  assert.equal(ctx.WebSocket.CONNECTING, 0);
  assert.equal(ctx.WebSocket.OPEN, 1);
  assert.equal(ctx.WebSocket.CLOSING, 2);
  assert.equal(ctx.WebSocket.CLOSED, 3);
  assert.equal(ctx.WebSocket.prototype, MockWebSocket.prototype);
});

check('shim 具备幂等性（多次执行不重复包装、不破坏属性）', () => {
  const ctx = vm.createContext({
    window: { location: { protocol: 'https:', href: 'https://example.com/' } },
    location: { protocol: 'https:', href: 'https://example.com/' },
    WebSocket: MockWebSocket,
    URL
  });
  ctx.globalThis = ctx;
  vm.runInContext(WS_UPGRADE_SHIM, ctx);
  const firstPatched = ctx.WebSocket;

  vm.runInContext(WS_UPGRADE_SHIM, ctx);
  assert.equal(ctx.WebSocket, firstPatched);

  const ws = new ctx.WebSocket('ws://example.com/idem');
  assert.equal(ws.url, 'wss://example.com/idem');
});

check('HTTP 页面环境（location.protocol === "http:"）shim 不生效，WebSocket 保持原生', () => {
  const ctx = vm.createContext({
    window: { location: { protocol: 'http:', href: 'http://example.com/' } },
    location: { protocol: 'http:', href: 'http://example.com/' },
    WebSocket: MockWebSocket,
    URL
  });
  ctx.globalThis = ctx;
  vm.runInContext(WS_UPGRADE_SHIM, ctx);

  assert.equal(ctx.WebSocket, MockWebSocket);
  const ws = new ctx.WebSocket('ws://example.com/plain');
  assert.equal(ws.url, 'ws://example.com/plain');
});

check('畸形 URL 或环境缺少 window 不抛出异常并平稳兜底', () => {
  const ctx1 = vm.createContext({
    window: { location: { protocol: 'https:', href: 'https://example.com/' } },
    location: { protocol: 'https:', href: 'https://example.com/' },
    WebSocket: MockWebSocket,
    URL
  });
  ctx1.globalThis = ctx1;
  vm.runInContext(WS_UPGRADE_SHIM, ctx1);

  // 传非法非 URL 字符串不炸
  const ws = new ctx1.WebSocket('not-a-valid-url:::');
  assert.equal(ws.url, 'not-a-valid-url:::');

  // 无 window / 无 WebSocket 不炸
  const ctx2 = vm.createContext({});
  ctx2.globalThis = ctx2;
  vm.runInContext(WS_UPGRADE_SHIM, ctx2);
});

check('RANDOM_UUID_POLYFILL 完整包含并成功注入 WS_UPGRADE_SHIM', () => {
  assert.ok(RANDOM_UUID_POLYFILL.includes('__dsh_wss_shimmed'));
  const injected = injectPolyfill('<!DOCTYPE html><html><head><title>T</title></head><body></body></html>');
  assert.ok(injected.includes('__DSH_TRANSPORT__'));
  assert.ok(injected.includes('__dsh_wss_shimmed'));
});

// ─────────────────────────────────────────────────────────────
console.log('\n[模块 2] Content-Encoding 识别与 zlib 解压逻辑');

check('getEncodingType 准确识别常用编码与未知编码', () => {
  assert.equal(getEncodingType('gzip'), 'gzip');
  assert.equal(getEncodingType('GZIP'), 'gzip');
  assert.equal(getEncodingType('x-gzip'), 'gzip');
  assert.equal(getEncodingType('deflate'), 'deflate');
  assert.equal(getEncodingType('br'), 'br');
  assert.equal(getEncodingType(''), null);
  assert.equal(getEncodingType('identity'), null);
  assert.equal(getEncodingType(undefined), null);
  assert.equal(getEncodingType('zstd'), 'unknown');
  assert.equal(getEncodingType('gzip, deflate'), 'gzip');
});

check('decompressBuffer 针对 gzip/deflate/br 正确解压，未知格式抛出错误', () => {
  const rawText = '<div>Hello DSH Univer Viewer!</div>';
  const rawBuf = Buffer.from(rawText, 'utf8');

  const gz = zlib.gzipSync(rawBuf);
  assert.equal(decompressBuffer(gz, 'gzip').toString('utf8'), rawText);

  const df = zlib.deflateSync(rawBuf);
  assert.equal(decompressBuffer(df, 'deflate').toString('utf8'), rawText);

  const rawDf = zlib.deflateRawSync(rawBuf);
  assert.equal(decompressBuffer(rawDf, 'deflate').toString('utf8'), rawText);

  const br = zlib.brotliCompressSync(rawBuf);
  assert.equal(decompressBuffer(br, 'br').toString('utf8'), rawText);

  assert.throws(() => decompressBuffer(rawBuf, 'unknown'), /Unsupported/);
});

// ─────────────────────────────────────────────────────────────
console.log('\n[模块 3] 上游压缩 HTML/JS 注入与降级行为');

const TEST_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Viewer</title></head>
<body><div id="app">UNIVER-VIEWER-ORIG-MARKER</div></body>
</html>`;

check('对 gzip 压缩的 HTML，解压后注入 polyfill，标记完整且无 U+FFFD 乱码', () => {
  const gzBuf = zlib.gzipSync(Buffer.from(TEST_HTML, 'utf8'));
  const encType = getEncodingType('gzip');
  assert.equal(encType, 'gzip');

  const decompressed = decompressBuffer(gzBuf, encType);
  const injectedHtml = injectPolyfill(decompressed.toString('utf8'));

  assert.ok(injectedHtml.includes('UNIVER-VIEWER-ORIG-MARKER'), '应保留原始标记');
  assert.ok(injectedHtml.includes('__DSH_TRANSPORT__'), '应包含注入 polyfill');
  assert.ok(!injectedHtml.includes('\uFFFD'), '不得含有乱码替换字符 U+FFFD');
});

check('对 deflate 压缩的 HTML，解压后注入 polyfill，标记完整', () => {
  const dfBuf = zlib.deflateSync(Buffer.from(TEST_HTML, 'utf8'));
  const encType = getEncodingType('deflate');
  const decompressed = decompressBuffer(dfBuf, encType);
  const injectedHtml = injectPolyfill(decompressed.toString('utf8'));

  assert.ok(injectedHtml.includes('UNIVER-VIEWER-ORIG-MARKER'));
  assert.ok(injectedHtml.includes('__DSH_TRANSPORT__'));
});

check('对 br 压缩的 HTML，解压后注入 polyfill，标记完整', () => {
  const brBuf = zlib.brotliCompressSync(Buffer.from(TEST_HTML, 'utf8'));
  const encType = getEncodingType('br');
  const decompressed = decompressBuffer(brBuf, encType);
  const injectedHtml = injectPolyfill(decompressed.toString('utf8'));

  assert.ok(injectedHtml.includes('UNIVER-VIEWER-ORIG-MARKER'));
  assert.ok(injectedHtml.includes('__DSH_TRANSPORT__'));
});

check('对非压缩 HTML，直接注入 polyfill，行为与修改前保持一致（零回归）', () => {
  const raw = TEST_HTML;
  const injectedHtml = injectPolyfill(raw);

  assert.ok(injectedHtml.includes('UNIVER-VIEWER-ORIG-MARKER'));
  assert.ok(injectedHtml.includes('__DSH_TRANSPORT__'));
});

check('损坏的 gzip 数据解压抛错可被捕获，不致程序崩溃', () => {
  const corruptBuf = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x99, 0x88, 0x77]);
  assert.throws(() => {
    decompressBuffer(corruptBuf, 'gzip');
  });
});

// ─────────────────────────────────────────────────────────────
console.log('\n[模块 4] 模拟网关 proxyRes 完整生命周期流式与头信息处理');

function createMockRes() {
  const headers = {};
  const chunks = [];
  let ended = false;
  let finalBody = null;
  let headersSent = false;

  return {
    headers,
    chunks,
    get headersSent() { return headersSent; },
    // 忠实模拟 Node ServerResponse：writeHead() 之后 headersSent=true，此后 setHeader 抛 ERR_HTTP_HEADERS_SENT
    writeHead(status, hdrs) {
      headersSent = true;
      if (hdrs) for (const [k, v] of Object.entries(hdrs)) headers[k.toLowerCase()] = v;
      return this;
    },
    setHeader(k, v) {
      if (headersSent) {
        const e = new Error('Cannot set headers after they are sent to the client');
        e.code = 'ERR_HTTP_HEADERS_SENT';
        throw e;
      }
      headers[k.toLowerCase()] = v;
    },
    removeHeader(k) { delete headers[k.toLowerCase()]; },
    getHeader(k) { return headers[k.toLowerCase()]; },
    write(c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); return true; },
    end(c) {
      if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      ended = true;
      finalBody = Buffer.concat(chunks);
    },
    destroy() {},
    isEnded() { return ended; },
    getFinalBody() { return finalBody; }
  };
}

// 提取网关相同的 proxyRes HTML 处理核心逻辑进行纯单元验证
// ⚠️ 必须与 gateway/index.js 的实现保持一致；失败分支不得调用 setHeader（writeHead 之后会抛错）。
function simulateProxyResHtml(proxyRes, req, res) {
  const encType = getEncodingType(proxyRes.headers['content-encoding']);

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (!encType) {
    delete proxyRes.headers['content-length'];
    res.removeHeader('content-length');

    let injected = false;
    const origWrite = res.write.bind(res);
    res.write = function (chunk, ...rest) {
      if (!injected && chunk) {
        injected = true;
        let htmlStr = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        htmlStr = injectPolyfill(htmlStr);
        chunk = Buffer.from(htmlStr);
      }
      return origWrite(chunk, ...rest);
    };
    return;
  }

  if (encType === 'unknown') {
    return;
  }

  delete proxyRes.headers['content-length'];
  res.removeHeader('content-length');
  delete proxyRes.headers['content-encoding'];
  res.removeHeader('content-encoding');

  const chunks = [];
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);

  res.write = function (chunk, ...rest) {
    if (chunk !== undefined && chunk !== null) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return true;
  };

  res.end = function (chunk, ...rest) {
    if (chunk !== undefined && chunk !== null) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    res.write = origWrite;
    res.end = origEnd;

    const rawBuffer = Buffer.concat(chunks);
    let decompressed = null;
    try {
      decompressed = decompressBuffer(rawBuffer, encType);
    } catch (err) {
      try {
        return origEnd(rawBuffer, ...rest);
      } catch (e2) {
        try { res.destroy(); } catch {}
        return;
      }
    }

    let htmlStr = decompressed.toString('utf8');
    htmlStr = injectPolyfill(htmlStr);
    origEnd(Buffer.from(htmlStr), ...rest);
  };
}

check('流式无压缩 HTML: 首块即时注入，保留流式输出，Content-Encoding 头不出现', () => {
  const proxyRes = { headers: { 'content-type': 'text/html; charset=utf-8' } };
  const res = createMockRes();
  simulateProxyResHtml(proxyRes, {}, res);
  res.writeHead(200, { ...proxyRes.headers }); // 模拟 http-proxy 在 pipe 之前 writeHead

  res.write(Buffer.from('<html><head></head><body>chunk1-'));
  res.write(Buffer.from('chunk2</body></html>'));
  res.end();

  const out = res.getFinalBody().toString('utf8');
  assert.ok(out.includes('__DSH_TRANSPORT__'), '首块成功注入');
  assert.ok(out.includes('chunk1-chunk2'), '内容完整');
  assert.equal(res.getHeader('content-encoding'), undefined);
});

check('gzip 压缩 HTML: 缓冲全部块后解压注入，删除 Content-Encoding，输出有效明文 HTML', () => {
  const proxyRes = {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-encoding': 'gzip',
      'content-length': '123'
    }
  };
  const res = createMockRes();
  res.setHeader('content-encoding', 'gzip');
  res.setHeader('content-length', '123');

  simulateProxyResHtml(proxyRes, {}, res);
  res.writeHead(200, { ...proxyRes.headers }); // http-proxy 在 pipe 前 writeHead（此后 headersSent=true）

  const gz = zlib.gzipSync(Buffer.from(TEST_HTML, 'utf8'));
  // 分两块模拟传输
  res.write(gz.subarray(0, 50));
  res.write(gz.subarray(50));
  res.end();

  assert.equal(res.getHeader('content-encoding'), undefined, 'Content-Encoding 响应头应被彻底删除');
  assert.equal(res.getHeader('content-length'), undefined, 'Content-Length 响应头应被删除');
  const out = res.getFinalBody().toString('utf8');
  assert.ok(out.includes('UNIVER-VIEWER-ORIG-MARKER'), '应包含原始内容');
  assert.ok(out.includes('__DSH_TRANSPORT__'), '应包含注入 polyfill');
  assert.ok(!out.includes('\uFFFD'), '无乱码字符');
});

check('gzip 压缩 HTML 解压失败：res.end 不抛错（headersSent 后禁止 setHeader），原样透传', () => {
  const corruptGz = Buffer.from('not-a-valid-gzip-stream-at-all');
  const proxyRes = {
    headers: {
      'content-type': 'text/html',
      'content-encoding': 'gzip'
    }
  };
  const res = createMockRes();
  simulateProxyResHtml(proxyRes, {}, res);
  res.writeHead(200, { ...proxyRes.headers }); // 关键：headersSent=true，复刻真实 http-proxy 时序

  res.write(corruptGz);
  assert.doesNotThrow(() => res.end(), '解压失败时 res.end 钩子绝不能抛异常（否则会触发 uncaughtException 拖垮网关）');
  assert.deepEqual(res.getFinalBody(), corruptGz, '失败时应原样透传未修改的二进制');
});

check('未知编码（如 zstd）响应：保守原样透传，不拦截 write/end，不破坏流', () => {
  const proxyRes = {
    headers: {
      'content-type': 'text/html',
      'content-encoding': 'zstd'
    }
  };
  const res = createMockRes();
  simulateProxyResHtml(proxyRes, {}, res);
  res.writeHead(200, { ...proxyRes.headers });

  const raw = Buffer.from('zstd-compressed-binary-payload');
  res.write(raw);
  res.end();

  assert.deepEqual(res.getFinalBody(), raw);
});

// ─────────────────────────────────────────────────────────────
console.log('\n========================================');
console.log(`总计: ${pass} 通过, ${fail} 失败`);
console.log('========================================\n');
process.exit(fail === 0 ? 0 : 1);

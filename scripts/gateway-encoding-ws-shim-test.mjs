#!/usr/bin/env node
/**
 * Локальный регрессионный тест уровня модулей (Issue #10):
 *   1. Shim безопасного апгрейда WebSocket wss:// (проверка в node:vm протоколов, констант, прототипа, идемпотентности и изоляции HTTP/HTTPS)
 *   2. Распаковка Content-Encoding и инъекция замены в HTML/JS (проверка в node:zlib gzip/deflate/br, неизвестного кодирования и деградации при повреждении)
 *   3. Моделирование жизненного цикла ответа proxyRes шлюза (потоковая передача без сжатия, буферная распаковка, удаление Content-Encoding, откат при сбое)
 *
 * Запуск: node scripts/gateway-encoding-ws-shim-test.mjs
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

// Подмена стандартного конструктора WebSocket
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

console.log('\n[Модуль 1] Shim безопасного апгрейда WebSocket wss:// (тест изоляции в node:vm)');

check('На HTTPS-странице ws:// автоматически переписывается в wss:// с сохранением порта, пути, запроса и хеша', () => {
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

check('На HTTPS-странице аргумент в виде объекта URL тоже корректно переписывается в wss', () => {
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

check('на HTTPS-странице нативные wss://, http:// и прочие не-ws протоколы остаются без изменений, не переписываются ошибочно', () => {
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

check('аргумент подпротоколов protocols прозрачно передаётся в нижележащий конструктор', () => {
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

check('цепочка прототипов WebSocket и статические константы (CONNECTING/OPEN/CLOSING/CLOSED) полностью сохраняются', () => {
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

check('shim идемпотентен (повторный запуск не оборачивает повторно и не ломает свойства)', () => {
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

check('в HTTP-окружении (location.protocol === "http:") shim не срабатывает, WebSocket остаётся нативным', () => {
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

check('некорректный URL или отсутствие window не бросает исключение и спокойно отрабатывает запасной путь', () => {
  const ctx1 = vm.createContext({
    window: { location: { protocol: 'https:', href: 'https://example.com/' } },
    location: { protocol: 'https:', href: 'https://example.com/' },
    WebSocket: MockWebSocket,
    URL
  });
  ctx1.globalThis = ctx1;
  vm.runInContext(WS_UPGRADE_SHIM, ctx1);

  // Некорректный не-URL-строковый аргумент не взрывается
  const ws = new ctx1.WebSocket('not-a-valid-url:::');
  assert.equal(ws.url, 'not-a-valid-url:::');

  // Без window / без WebSocket не взрывается
  const ctx2 = vm.createContext({});
  ctx2.globalThis = ctx2;
  vm.runInContext(WS_UPGRADE_SHIM, ctx2);
});

check('RANDOM_UUID_POLYFILL полностью содержит и успешно внедряет WS_UPGRADE_SHIM', () => {
  assert.ok(RANDOM_UUID_POLYFILL.includes('__dsh_wss_shimmed'));
  const injected = injectPolyfill('<!DOCTYPE html><html><head><title>T</title></head><body></body></html>');
  assert.ok(injected.includes('__DSH_TRANSPORT__'));
  assert.ok(injected.includes('__dsh_wss_shimmed'));
});

// ─────────────────────────────────────────────────────────────
console.log('\n[Модуль 2] Распознавание Content-Encoding и логика распаковки zlib');

check('getEncodingType точно распознаёт распространённые и неизвестные кодировки', () => {
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

check('decompressBuffer корректно распаковывает gzip/deflate/br, неизвестный формат бросает ошибку', () => {
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
console.log('\n[Модуль 3] Инъекция в сжатый апстримом HTML/JS и сторожинная деградация');

const TEST_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Viewer</title></head>
<body><div id="app">UNIVER-VIEWER-ORIG-MARKER</div></body>
</html>`;

check('для gzip-сжатого HTML после распаковки внедряется polyfill, маркер полон и нет мусора U+FFFD', () => {
  const gzBuf = zlib.gzipSync(Buffer.from(TEST_HTML, 'utf8'));
  const encType = getEncodingType('gzip');
  assert.equal(encType, 'gzip');

  const decompressed = decompressBuffer(gzBuf, encType);
  const injectedHtml = injectPolyfill(decompressed.toString('utf8'));

  assert.ok(injectedHtml.includes('UNIVER-VIEWER-ORIG-MARKER'), 'должен сохраниться исходный маркер');
  assert.ok(injectedHtml.includes('__DSH_TRANSPORT__'), 'должен быть внедрён polyfill');
  assert.ok(!injectedHtml.includes('\uFFFD'), 'не должно быть мусорных заменяющих символов U+FFFD');
});

check('для deflate-сжатого HTML после распаковки внедряется polyfill, маркер полон', () => {
  const dfBuf = zlib.deflateSync(Buffer.from(TEST_HTML, 'utf8'));
  const encType = getEncodingType('deflate');
  const decompressed = decompressBuffer(dfBuf, encType);
  const injectedHtml = injectPolyfill(decompressed.toString('utf8'));

  assert.ok(injectedHtml.includes('UNIVER-VIEWER-ORIG-MARKER'));
  assert.ok(injectedHtml.includes('__DSH_TRANSPORT__'));
});

check('для br-сжатого HTML после распаковки внедряется polyfill, маркер полон', () => {
  const brBuf = zlib.brotliCompressSync(Buffer.from(TEST_HTML, 'utf8'));
  const encType = getEncodingType('br');
  const decompressed = decompressBuffer(brBuf, encType);
  const injectedHtml = injectPolyfill(decompressed.toString('utf8'));

  assert.ok(injectedHtml.includes('UNIVER-VIEWER-ORIG-MARKER'));
  assert.ok(injectedHtml.includes('__DSH_TRANSPORT__'));
});

check('для несжатого HTML polyfill внедряется напрямую, поведение совпадает с прежним (ноль регрессий)', () => {
  const raw = TEST_HTML;
  const injectedHtml = injectPolyfill(raw);

  assert.ok(injectedHtml.includes('UNIVER-VIEWER-ORIG-MARKER'));
  assert.ok(injectedHtml.includes('__DSH_TRANSPORT__'));
});

check('ошибка распаковки повреждённых gzip-данных ловится, процесс не падает', () => {
  const corruptBuf = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x99, 0x88, 0x77]);
  assert.throws(() => {
    decompressBuffer(corruptBuf, 'gzip');
  });
});

// ─────────────────────────────────────────────────────────────
console.log('\n[Модуль 4] Моделирование полного жизненного цикла proxyRes шлюза: потоковость и обработка заголовков');

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
    // Честная имитация Node ServerResponse: после writeHead() headersSent=true, и далее setHeader
    // бросает ERR_HTTP_HEADERS_SENT
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

// Выделяем ту же самую ядру обработки HTML для proxyRes шлюза и проверяем её чистым юнит-способом
// ⚠️ Должна совпадать с реализацией в gateway/index.js; на ветке сбоя setHeader вызывать нельзя
// (после writeHead будет брошено).
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

check('потоковый несжатый HTML: immediate-инъекция в первый чанк, потоковый вывод сохраняется, заголовка Content-Encoding нет', () => {
  const proxyRes = { headers: { 'content-type': 'text/html; charset=utf-8' } };
  const res = createMockRes();
  simulateProxyResHtml(proxyRes, {}, res);
  res.writeHead(200, { ...proxyRes.headers }); // имитируем http-proxy: writeHead перед pipe

  res.write(Buffer.from('<html><head></head><body>chunk1-'));
  res.write(Buffer.from('chunk2</body></html>'));
  res.end();

  const out = res.getFinalBody().toString('utf8');
  assert.ok(out.includes('__DSH_TRANSPORT__'), 'внедрение в первый чанк успешно');
  assert.ok(out.includes('chunk1-chunk2'), 'контент полный');
  assert.equal(res.getHeader('content-encoding'), undefined);
});

check('gzip-сжатый HTML: собираем все чанки, распаковываем и внедряем, Content-Encoding убираем, на выходе валидный RAW HTML', () => {
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
  res.writeHead(200, { ...proxyRes.headers }); // http-proxy делает writeHead перед pipe (после него headersSent=true)

  const gz = zlib.gzipSync(Buffer.from(TEST_HTML, 'utf8'));
  // делим на два чанка для имитации передачи
  res.write(gz.subarray(0, 50));
  res.write(gz.subarray(50));
  res.end();

  assert.equal(res.getHeader('content-encoding'), undefined, 'заголовок ответа Content-Encoding должен быть полностью удалён');
  assert.equal(res.getHeader('content-length'), undefined, 'заголовок ответа Content-Length должен быть удалён');
  const out = res.getFinalBody().toString('utf8');
  assert.ok(out.includes('UNIVER-VIEWER-ORIG-MARKER'), 'должен быть исходный контент');
  assert.ok(out.includes('__DSH_TRANSPORT__'), 'должен быть внедрён polyfill');
  assert.ok(!out.includes('\uFFFD'), 'без мусорных символов');
});

check('gzip-сжатый HTML при ошибке распаковки: res.end не бросает (после headersSent setHeader запрещён), прозрачная передача как есть', () => {
  const corruptGz = Buffer.from('not-a-valid-gzip-stream-at-all');
  const proxyRes = {
    headers: {
      'content-type': 'text/html',
      'content-encoding': 'gzip'
    }
  };
  const res = createMockRes();
  simulateProxyResHtml(proxyRes, {}, res);
  res.writeHead(200, { ...proxyRes.headers }); // ключевой момент: headersSent=true, воспроизводим реальную тайминговую схему http-proxy

  res.write(corruptGz);
  assert.doesNotThrow(() => res.end(), 'при сбое распаковки хук res.end ни в коем случае не должен бросать (иначе uncaughtException свалит шлюз)');
  assert.deepEqual(res.getFinalBody(), corruptGz, 'при сбое бинарные данные передаются как есть, без изменений');
});

check('ответ с неизвестной кодировкой (например zstd): консервативная прозрачная передача, write/end не перехватываются, поток не ломается', () => {
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
console.log(`Итог: ${pass} пройдено, ${fail} провалено`);
console.log('========================================\n');
process.exit(fail === 0 ? 0 : 1);

'use strict';

/**
 * paymock HTTP 服务（2026-11-14）
 *
 * 一个进程同时扮演两个角色：
 *   1. 假的微信支付 v3 服务端（/v3/...）
 *   2. 本地控制台（/__panel、/__api/...）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { Store } = require('./store');
const { WeChatMock } = require('./wechat');

const MAX_BODY = 2 * 1024 * 1024; // 2MB

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

function createLogger(quiet) {
  return function log(msg, level) {
    if (quiet) return;
    const t = new Date().toTimeString().slice(0, 8);
    const c =
      level === 'error' ? COLORS.red :
      level === 'warn' ? COLORS.yellow :
      level === 'pay' ? COLORS.green + COLORS.bold :
      level === 'notify' ? COLORS.cyan :
      COLORS.dim;
    process.stdout.write(`${COLORS.dim}${t}${COLORS.reset} ${c}${msg}${COLORS.reset}\n`);
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体超过 2MB'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJSON(res, status, obj) {
  const body = obj === null ? '' : JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * 启动服务
 * @param {object} opts
 * @param {number} [opts.port]
 * @param {string} [opts.apiV3Key]
 * @param {string} [opts.mchid]
 * @param {string} [opts.appid]
 * @param {boolean} [opts.quiet]
 */
async function start(opts = {}) {
  const port = opts.port || 4010;
  const quiet = !!opts.quiet;
  const log = createLogger(quiet);

  const store = new Store();
  const wechat = new WeChatMock({
    store,
    port,
    apiV3Key: opts.apiV3Key,
    mchid: opts.mchid,
    appid: opts.appid,
    log,
  });

  const panelPath = path.join(__dirname, 'panel.html');
  let panelHtml = '';
  try {
    panelHtml = fs.readFileSync(panelPath, 'utf8');
  } catch (e) {
    panelHtml = '<!doctype html><meta charset="utf-8"><h1>面板文件缺失</h1><p>' + panelPath + '</p>';
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method.toUpperCase();

    res.on('finish', () => {
      if (pathname.startsWith('/__')) return; // 面板自身请求不刷屏
      store.addLog({
        method,
        path: pathname,
        status: res.statusCode,
        latency: Date.now() - started,
      });
    });

    try {
      /* ---------- 面板 ---------- */
      if (method === 'GET' && (pathname === '/__panel' || pathname === '/__panel/')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(panelHtml);
        return;
      }
      if (method === 'GET' && pathname === '/') {
        res.writeHead(302, { Location: '/__panel' });
        res.end();
        return;
      }

      /* ---------- 管理 API ---------- */
      if (pathname.startsWith('/__api/')) {
        return await handleApi(req, res, pathname, method, store, wechat, url);
      }

      /* ---------- 微信支付 ---------- */
      const raw = method === 'GET' || method === 'HEAD' ? '' : await readBody(req);
      let body = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch (_) {
          return sendJSON(res, 400, { code: 'PARAM_ERROR', message: '请求体不是合法 JSON' });
        }
      }

      const result = await wechat.handle(method, pathname, url.searchParams, body, req.headers);
      if (result === null) {
        return sendJSON(res, 404, {
          code: 'NOT_FOUND',
          message: `paymock 未实现该接口: ${method} ${pathname}`,
        });
      }
      if (result.status === 204) {
        res.writeHead(204);
        res.end();
        return;
      }
      return sendJSON(res, result.status, result.body);
    } catch (e) {
      log(`处理异常 ${method} ${pathname}: ${e.message}`, 'error');
      if (!res.headersSent) {
        sendJSON(res, 500, { code: 'SYSTEM_ERROR', message: e.message });
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        reject(new Error(`端口 ${port} 已被占用，换一个：paymock wechat --port 4011`));
      } else {
        reject(e);
      }
    });
    server.listen(port, '127.0.0.1', resolve);
  });

  return { server, store, wechat, port };
}

/* ================= 管理 API ================= */

async function handleApi(req, res, pathname, method, store, wechat, url) {
  if (method === 'GET' && pathname === '/__api/info') {
    return sendJSON(res, 200, wechat.info());
  }

  if (method === 'GET' && pathname === '/__api/state') {
    return sendJSON(res, 200, {
      info: {
        mchid: wechat.mchid,
        appid: wechat.appid,
        apiV3Key: wechat.apiV3Key,
        platformSerial: wechat.platformSerial,
        startedAt: store.startedAt,
      },
      transactions: store.listTransactions(),
      refunds: store.listRefunds(),
      logs: store.listLogs(60),
      notifies: store.listNotifyLogs(40),
    });
  }

  if (method === 'GET' && pathname === '/__api/platform-pubkey') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(wechat.platformPublicKey);
    return;
  }

  if (method === 'POST' && pathname === '/__api/trigger') {
    const raw = await readBody(req);
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch (_) {
      return sendJSON(res, 400, { ok: false, message: '请求体不是合法 JSON' });
    }
    const no = (body.out_trade_no || '').trim();
    if (!no) return sendJSON(res, 400, { ok: false, message: '缺少 out_trade_no' });
    const r = await wechat.triggerPay(no, body.mode || 'success');
    return sendJSON(res, r.ok ? 200 : 400, r);
  }

  if (method === 'POST' && pathname === '/__api/reset') {
    store.reset();
    return sendJSON(res, 200, { ok: true, message: '已清空所有测试数据' });
  }

  return sendJSON(res, 404, { ok: false, message: '未知管理接口: ' + pathname });
}

module.exports = { start, createLogger, COLORS };

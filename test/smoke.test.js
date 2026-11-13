'use strict';

/**
 * paymock 冒烟测试（2026-11-14）
 *
 * 模拟一个真实的商户：起一个接收回调的 HTTP 服务，
 * 收到回调后按微信规则验签 + 解密，确认整条链路真的能用。
 *
 * 跑法：node test/smoke.test.js
 */

const http = require('http');
const assert = require('assert');
const path = require('path');

const { start } = require(path.join(__dirname, '..', 'src', 'server.js'));
const { verifySignature, aesGcmDecrypt } = require(path.join(__dirname, '..', 'src', 'crypto.js'));

const MOCK_PORT = 14010;
const MERCHANT_PORT = 14011;

let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  \x1b[32m✔\x1b[0m ' + name);
  } else {
    fail++;
    console.log('  \x1b[31m✘\x1b[0m ' + name + (extra ? '  → ' + extra : ''));
  }
}

function section(t) {
  console.log('\n\x1b[1m' + t + '\x1b[0m');
}

async function main() {
  /* ---------- 商户端：接收回调并验签解密 ---------- */
  const received = [];
  let platformPubKey = '';

  const merchant = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const ts = req.headers['wechatpay-timestamp'];
      const nonce = req.headers['wechatpay-nonce'];
      const sig = req.headers['wechatpay-signature'];
      const serial = req.headers['wechatpay-serial'];

      const message = `${ts}\n${nonce}\n${raw}\n`;
      const valid = verifySignature(message, sig, platformPubKey);

      let decoded = null;
      let decryptError = '';
      try {
        const body = JSON.parse(raw);
        decoded = JSON.parse(
          aesGcmDecrypt(
            body.resource.ciphertext,
            apiV3Key,
            body.resource.nonce,
            body.resource.associated_data
          )
        );
      } catch (e) {
        decryptError = e.message;
      }

      received.push({ valid, serial, decoded, decryptError, eventType: (JSON.parse(raw).event_type) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'SUCCESS', message: '成功' }));
    });
  });

  await new Promise((r) => merchant.listen(MERCHANT_PORT, '127.0.0.1', r));

  /* ---------- 起 paymock ---------- */
  const mock = await start({ port: MOCK_PORT, quiet: true, apiV3Key: undefined });
  const apiV3Key = mock.wechat.apiV3Key;
  platformPubKey = mock.wechat.platformPublicKey;
  const base = `http://127.0.0.1:${MOCK_PORT}`;

  const api = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {}
    return { status: res.status, json, text };
  };

  /* ---------- 1. 服务基础 ---------- */
  section('1. 服务与接入信息');
  const info = await api('GET', '/__api/info');
  ok('GET /__api/info 返回 200', info.status === 200);
  ok('返回 mchid', !!info.json.mchid, JSON.stringify(info.json).slice(0, 80));
  ok('APIv3 密钥是 32 位', String(info.json.apiV3Key).length === 32);
  ok('平台序列号存在', !!info.json.platformSerial);

  /* ---------- 2. 平台证书 ---------- */
  section('2. 平台证书下发');
  const certs = await api('GET', '/v3/certificates');
  ok('GET /v3/certificates 200', certs.status === 200);
  const certData = certs.json && certs.json.data && certs.json.data[0];
  ok('返回一条证书', !!certData);
  let certPubKey = '';
  try {
    certPubKey = aesGcmDecrypt(
      certData.encrypt_certificate.ciphertext,
      apiV3Key,
      certData.encrypt_certificate.nonce,
      certData.encrypt_certificate.associated_data
    );
  } catch (e) {
    certPubKey = '';
  }
  ok('证书内容能用 APIv3 密钥解密', certPubKey.includes('BEGIN PUBLIC KEY'));
  ok('解密出的公钥与实例公钥一致', certPubKey.trim() === platformPubKey.trim());

  /* ---------- 3. 下单 ---------- */
  section('3. Native 下单');
  const order = {
    out_trade_no: 'T20261114001',
    description: '测试商品',
    amount: { total: 199, currency: 'CNY' },
    notify_url: `http://127.0.0.1:${MERCHANT_PORT}/pay/notify`,
  };
  const created = await api('POST', '/v3/pay/transactions/native', order);
  ok('下单返回 200', created.status === 200, created.text.slice(0, 120));
  ok('返回 code_url', !!created.json.code_url && created.json.code_url.startsWith('weixin://'));

  const dup = await api('POST', '/v3/pay/transactions/native', order);
  ok('重复单号被拒绝', dup.status === 400 && dup.json.code === 'ORDER_CLOSED', dup.text.slice(0, 80));

  const badAmount = await api('POST', '/v3/pay/transactions/native', { out_trade_no: 'T_BAD' });
  ok('缺 amount 被拒绝', badAmount.status === 400);

  /* ---------- 4. 查单 ---------- */
  section('4. 查单');
  const q1 = await api('GET', '/v3/pay/transactions/out-trade-no/T20261114001?mchid=' + info.json.mchid);
  ok('查单返回 200', q1.status === 200);
  ok('状态是 NOTPAY', q1.json.trade_state === 'NOTPAY', q1.json.trade_state);
  ok('金额正确（199 分）', q1.json.amount.total === 199);
  ok('transaction_id 是 32 位', String(q1.json.transaction_id).length === 32);

  const q404 = await api('GET', '/v3/pay/transactions/out-trade-no/NOT_EXIST');
  ok('查不存在的单返回 404', q404.status === 404 && q404.json.code === 'ORDER_NOT_EXIST');

  /* ---------- 5. 触发支付 + 回调 ---------- */
  section('5. 支付成功与回调');
  const trig = await api('POST', '/__api/trigger', { out_trade_no: 'T20261114001', mode: 'success' });
  ok('触发成功', trig.status === 200 && trig.json.ok, trig.text.slice(0, 100));

  await sleep(400);

  ok('商户端收到 1 条回调', received.length === 1, '实际 ' + received.length);
  if (received[0]) {
    ok('回调验签通过', received[0].valid === true);
    ok('回调事件是 TRANSACTION.SUCCESS', received[0].eventType === 'TRANSACTION.SUCCESS');
    ok('回调解密成功', !received[0].decryptError, received[0].decryptError);
    ok('解密后单号正确', received[0].decoded && received[0].decoded.out_trade_no === 'T20261114001');
    ok('解密后状态是 SUCCESS', received[0].decoded && received[0].decoded.trade_state === 'SUCCESS');
    ok('解密后金额 199', received[0].decoded && received[0].decoded.amount.total === 199);
  }

  const q2 = await api('GET', '/v3/pay/transactions/out-trade-no/T20261114001');
  ok('支付后查单状态 SUCCESS', q2.json.trade_state === 'SUCCESS');
  ok('支付后有 success_time', !!q2.json.success_time);

  /* ---------- 6. 重复通知 ---------- */
  section('6. 重复通知（测幂等）');
  const rep = await api('POST', '/__api/trigger', { out_trade_no: 'T20261114001', mode: 'repeat' });
  ok('重复触发成功', rep.status === 200 && rep.json.ok);
  await sleep(400);
  ok('商户端收到第 2 条回调', received.length === 2, '实际 ' + received.length);
  ok('第 2 条回调也验签通过', received[1] && received[1].valid === true);

  const q3 = await api('GET', '/v3/pay/transactions/out-trade-no/T20261114001');
  ok('重复通知后状态仍是 SUCCESS', q3.json.trade_state === 'SUCCESS');

  /* ---------- 7. 退款 ---------- */
  section('7. 退款');
  const refund = await api('POST', '/v3/refund/domestic/refunds', {
    out_trade_no: 'T20261114001',
    out_refund_no: 'R20261114001',
    reason: '测试退款',
    amount: { refund: 199, total: 199, currency: 'CNY' },
  });
  ok('退款返回 200', refund.status === 200, refund.text.slice(0, 120));
  ok('退款状态 SUCCESS', refund.json.status === 'SUCCESS');
  ok('退款金额正确', refund.json.amount.refund === 199);

  await sleep(400);
  ok('退款也推了回调', received.length === 3, '实际 ' + received.length);
  ok('退款回调事件是 REFUND.SUCCESS', received[2] && received[2].eventType === 'REFUND.SUCCESS');

  const refundQuery = await api('GET', '/v3/refund/domestic/refunds/R20261114001');
  ok('查退款返回 200', refundQuery.status === 200);
  ok('查退款状态 SUCCESS', refundQuery.json.status === 'SUCCESS');

  const q4 = await api('GET', '/v3/pay/transactions/out-trade-no/T20261114001');
  ok('退款后订单状态 REFUND', q4.json.trade_state === 'REFUND');

  /* ---------- 8. 超额退款 ---------- */
  section('8. 边界');
  const over = await api('POST', '/v3/refund/domestic/refunds', {
    out_trade_no: 'T20261114001',
    out_refund_no: 'R_OVER',
    amount: { refund: 999, total: 199, currency: 'CNY' },
  });
  ok('超额退款被拒绝', over.status === 400 && over.json.code === 'REFUND_AMOUNT_EXCEED', over.text.slice(0, 80));

  const unpaid = await api('POST', '/v3/refund/domestic/refunds', {
    out_trade_no: 'T_NOT_EXIST',
    out_refund_no: 'R_X',
    amount: { refund: 1, total: 1, currency: 'CNY' },
  });
  ok('不存在的订单退款被拒绝', unpaid.status === 400);

  /* ---------- 9. 关单 ---------- */
  section('9. 关单');
  await api('POST', '/v3/pay/transactions/native', {
    out_trade_no: 'T_CLOSE_ME',
    description: '待关闭',
    amount: { total: 50 },
  });
  const closed = await api('POST', '/v3/pay/transactions/out-trade-no/T_CLOSE_ME/close', {
    mchid: info.json.mchid,
  });
  ok('关单返回 204', closed.status === 204, String(closed.status));
  const q5 = await api('GET', '/v3/pay/transactions/out-trade-no/T_CLOSE_ME');
  ok('关单后状态 CLOSED', q5.json.trade_state === 'CLOSED');

  const closePaid = await api('POST', '/v3/pay/transactions/out-trade-no/T20261114001/close', {
    mchid: info.json.mchid,
  });
  ok('已支付订单不能关单', closePaid.status === 400 && closePaid.json.code === 'ORDER_PAID');

  /* ---------- 10. 未实现接口 ---------- */
  section('10. 未实现接口');
  const jsapi = await api('POST', '/v3/pay/transactions/jsapi', {});
  ok('未实现接口返回 404 并说明', jsapi.status === 404 && jsapi.json.code === 'NOT_FOUND', jsapi.text.slice(0, 100));

  /* ---------- 11. 面板与日志 ---------- */
  section('11. 面板与日志');
  const panel = await fetch(base + '/__panel');
  const panelHtml = await panel.text();
  ok('面板返回 200', panel.status === 200);
  ok('面板是 HTML', panelHtml.includes('<!doctype html>'));
  ok('面板含控制台标题', panelHtml.includes('paymock 控制台'));

  const state = await api('GET', '/__api/state');
  ok('state 返回订单列表', Array.isArray(state.json.transactions));
  ok('state 订单数 ≥ 2', state.json.transactions.length >= 2, String(state.json.transactions.length));
  ok('state 有请求日志', Array.isArray(state.json.logs) && state.json.logs.length > 0);
  ok('state 有回调记录', Array.isArray(state.json.notifies) && state.json.notifies.length >= 3);

  /* ---------- 12. 重置 ---------- */
  section('12. 重置');
  const reset = await api('POST', '/__api/reset');
  ok('重置返回 200', reset.status === 200);
  const state2 = await api('GET', '/__api/state');
  ok('重置后订单为空', state2.json.transactions.length === 0);

  /* ---------- 收尾 ---------- */
  merchant.close();
  mock.server.close();

  console.log('\n' + '─'.repeat(50));
  console.log(`  通过 ${pass}  失败 ${fail}`);
  console.log('─'.repeat(50) + '\n');

  if (fail > 0) process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error('\x1b[31m测试崩溃:\x1b[0m', e);
  process.exit(1);
});

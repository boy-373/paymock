'use strict';

/**
 * 微信支付 v3 本地模拟（2026-11-14）
 *
 * 覆盖：Native 下单、查单、关单、退款、退款查询、平台证书、回调推送
 * 签名与加密全部按微信真实规则实现，商户侧 SDK 可以原样验签解密。
 */

const crypto = require('crypto');
const {
  randomStr,
  newApiV3Key,
  newKeyPair,
  signMessage,
  aesGcmEncrypt,
  newSerialNo,
} = require('./crypto');

class WeChatMock {
  /**
   * @param {object} opts
   * @param {import('./store').Store} opts.store
   * @param {string} [opts.apiV3Key] 固定 APIv3 密钥，不传则每次启动随机生成
   * @param {string} [opts.mchid]
   * @param {string} [opts.appid]
   * @param {number} [opts.port] 监听端口，用于拼 baseURL
   * @param {(msg: string, level?: string) => void} [opts.log]
   */
  constructor(opts) {
    this.store = opts.store;
    this.log = opts.log || (() => {});
    this.mchid = opts.mchid || '1900000001';
    this.appid = opts.appid || 'wxdemo0000000001';
    this.port = opts.port || 4010;

    // 平台侧密钥对：回调签名用私钥，商户用公钥验签
    const kp = newKeyPair();
    this.platformPrivateKey = kp.privateKey;
    this.platformPublicKey = kp.publicKey;
    this.platformSerial = newSerialNo();

    this.apiV3Key = opts.apiV3Key || newApiV3Key();
  }

  /* ================= 对外信息 ================= */

  info() {
    return {
      mchid: this.mchid,
      appid: this.appid,
      apiV3Key: this.apiV3Key,
      platformSerial: this.platformSerial,
      platformPublicKey: this.platformPublicKey,
      baseURL: `http://localhost:${this.port}`,
    };
  }

  /* ================= 路由分发 ================= */

  /**
   * @returns {{status:number, body:object}|null} 返回 null 表示不是本模块的路由
   */
  async handle(method, pathname, query, body, headers) {
    // Native 下单
    if (method === 'POST' && pathname === '/v3/pay/transactions/native') {
      return this.nativePay(body);
    }

    // 按商户订单号查单
    let m = pathname.match(/^\/v3\/pay\/transactions\/out-trade-no\/([^/]+)$/);
    if (m && method === 'GET') {
      return this.queryByOutTradeNo(decodeURIComponent(m[1]), query.get('mchid'));
    }

    // 关单
    m = pathname.match(/^\/v3\/pay\/transactions\/out-trade-no\/([^/]+)\/close$/);
    if (m && method === 'POST') {
      return this.closeOrder(decodeURIComponent(m[1]), body);
    }

    // 申请退款
    if (method === 'POST' && pathname === '/v3/refund/domestic/refunds') {
      return this.createRefund(body);
    }

    // 查询退款
    m = pathname.match(/^\/v3\/refund\/domestic\/refunds\/([^/]+)$/);
    if (m && method === 'GET') {
      return this.queryRefund(decodeURIComponent(m[1]));
    }

    // 平台证书
    if (method === 'GET' && pathname === '/v3/certificates') {
      return this.certificates();
    }

    return null;
  }

  /* ================= 业务实现 ================= */

  nativePay(body) {
    if (!body || !body.out_trade_no) {
      return err(400, 'PARAM_ERROR', '缺少 out_trade_no');
    }
    if (!body.amount || typeof body.amount.total !== 'number') {
      return err(400, 'PARAM_ERROR', 'amount.total 必须是整数（单位：分）');
    }
    const { txn, error, message } = this.store.createTransaction({
      ...body,
      mchid: body.mchid || this.mchid,
      appid: body.appid || this.appid,
    });
    if (error) return err(400, error, message);

    this.log(`下单 ${txn.out_trade_no}  ${fmtAmount(txn.amount.total)}`, 'trade');

    // 真实微信返回的是 code_url，这里给一个能识别的假链接
    const codeUrl = `weixin://wxpay/bizpayurl?pr=${randomStr(16)}`;
    txn.code_url = codeUrl;

    return {
      status: 200,
      body: { code_url: codeUrl },
    };
  }

  queryByOutTradeNo(outTradeNo, mchid) {
    const txn = this.store.getTransaction(outTradeNo);
    if (!txn) {
      return err(404, 'ORDER_NOT_EXIST', '订单不存在');
    }
    if (mchid && mchid !== txn.mchid) {
      return err(400, 'PARAM_ERROR', 'mchid 与订单不匹配');
    }
    return { status: 200, body: this.txnToWechat(txn) };
  }

  closeOrder(outTradeNo, body) {
    const txn = this.store.getTransaction(outTradeNo);
    if (!txn) return err(404, 'ORDER_NOT_EXIST', '订单不存在');
    if (body && body.mchid && body.mchid !== txn.mchid) {
      return err(400, 'PARAM_ERROR', 'mchid 与订单不匹配');
    }
    const r = this.store.closeTransaction(outTradeNo);
    if (r.error) return err(400, r.error, r.message);
    this.log(`关单 ${outTradeNo}`, 'trade');
    return { status: 204, body: null };
  }

  createRefund(body) {
    if (!body || !body.out_trade_no) {
      return err(400, 'PARAM_ERROR', '缺少 out_trade_no');
    }
    const { refund, error, message } = this.store.createRefund({
      ...body,
      notify_url: body.notify_url,
    });
    if (error) return err(400, error, message);
    this.log(`退款 ${refund.out_refund_no}  ${fmtAmount(refund.amount.refund)}`, 'refund');

    // 退款成功也推一条回调
    this.sendNotify('REFUND.SUCCESS', refund).catch((e) => {
      this.log(`退款回调发送失败: ${e.message}`, 'error');
    });

    return {
      status: 200,
      body: {
        refund_id: refund.refund_id,
        out_refund_no: refund.out_refund_no,
        transaction_id: refund.transaction_id,
        out_trade_no: refund.out_trade_no,
        channel: 'ORIGINAL',
        user_received_account: '支付用户零钱',
        success_time: new Date().toISOString(),
        create_time: new Date(refund.created_at).toISOString(),
        status: 'SUCCESS',
        amount: refund.amount,
      },
    };
  }

  queryRefund(outRefundNo) {
    const refund = this.store.getRefund(outRefundNo);
    if (!refund) return err(404, 'RESOURCE_NOT_EXISTS', '退款单不存在');
    return {
      status: 200,
      body: {
        refund_id: refund.refund_id,
        out_refund_no: refund.out_refund_no,
        transaction_id: refund.transaction_id,
        out_trade_no: refund.out_trade_no,
        channel: 'ORIGINAL',
        user_received_account: '支付用户零钱',
        success_time: new Date(refund.created_at).toISOString(),
        create_time: new Date(refund.created_at).toISOString(),
        status: refund.status,
        amount: refund.amount,
      },
    };
  }

  certificates() {
    // 平台公钥用 APIv3 密钥加密后下发，和真实微信的结构一致
    const enc = aesGcmEncrypt(this.platformPublicKey, this.apiV3Key, 'certificate');
    const now = new Date();
    const expire = new Date(now.getTime() + 365 * 24 * 3600 * 1000);
    return {
      status: 200,
      body: {
        data: [
          {
            serial_no: this.platformSerial,
            effective_time: now.toISOString(),
            expire_time: expire.toISOString(),
            encrypt_certificate: {
              algorithm: 'AEAD_AES_256_GCM',
              ciphertext: enc.ciphertext,
              associated_data: enc.associated_data,
              nonce: enc.nonce,
            },
          },
        ],
      },
    };
  }

  /* ================= 回调 ================= */

  /**
   * 手动触发一次支付成功。
   * @param {string} outTradeNo
   * @param {'success'|'fail'|'repeat'} mode
   */
  async triggerPay(outTradeNo, mode = 'success') {
    const txn = this.store.getTransaction(outTradeNo);
    if (!txn) return { ok: false, message: '订单不存在: ' + outTradeNo };

    if (mode === 'fail') {
      // 模拟支付失败：不改状态，只推一条失败通知
      await this.sendNotify('TRANSACTION.FAIL', txn);
      return { ok: true, message: '已推送支付失败通知（订单状态不变）' };
    }

    if (mode === 'repeat') {
      // 重复通知：订单已支付，再推一次（测幂等）
      if (txn.trade_state !== 'SUCCESS') {
        return { ok: false, message: '订单未支付，无法模拟重复通知' };
      }
      await this.sendNotify('TRANSACTION.SUCCESS', txn);
      return { ok: true, message: '已重复推送支付成功通知（第 ' + (txn.notify_count + 1) + ' 次）' };
    }

    const r = this.store.markPaid(outTradeNo);
    if (r.error) return { ok: false, message: r.message };
    this.log(`支付成功 ${outTradeNo}`, 'pay');
    await this.sendNotify('TRANSACTION.SUCCESS', r.txn);
    return { ok: true, message: '已标记支付成功并推送回调' };
  }

  /** 构造并发送一条带签名、加密的微信回调 */
  async sendNotify(eventType, payload) {
    const isRefund = eventType.startsWith('REFUND');
    const resourceType = isRefund ? 'refund' : 'transaction';
    const notifyUrl = payload.notify_url;
    if (!notifyUrl) {
      this.log(`跳过回调：${payload.out_trade_no} 没有设置 notify_url`, 'warn');
      return;
    }

    const plain = JSON.stringify(this.buildResource(resourceType, payload));
    const enc = aesGcmEncrypt(plain, this.apiV3Key, resourceType);

    const bodyObj = {
      id: crypto.randomUUID(),
      create_time: new Date().toISOString(),
      resource_type: 'encrypt-resource',
      event_type: eventType,
      summary: isRefund ? '退款成功' : '支付成功',
      resource: {
        algorithm: 'AEAD_AES_256_GCM',
        ciphertext: enc.ciphertext,
        associated_data: enc.associated_data,
        nonce: enc.nonce,
        original_type: resourceType,
      },
    };
    const bodyStr = JSON.stringify(bodyObj);

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomStr(32);
    // 微信回调的待签名串：时间戳\n随机串\n报文主体\n
    const message = `${timestamp}\n${nonce}\n${bodyStr}\n`;
    const signature = signMessage(message, this.platformPrivateKey);

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'paymock/0.1 (local wechat pay simulator)',
      'Wechatpay-Timestamp': timestamp,
      'Wechatpay-Nonce': nonce,
      'Wechatpay-Signature': signature,
      'Wechatpay-Serial': this.platformSerial,
    };

    const started = Date.now();
    let result = { ok: false, status: 0, error: '' };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(notifyUrl, {
        method: 'POST',
        headers,
        body: bodyStr,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      result = { ok: res.ok, status: res.status, error: res.ok ? '' : text.slice(0, 200) };
    } catch (e) {
      result = {
        ok: false,
        status: 0,
        error: e.name === 'AbortError' ? '超时（10s）' : e.message,
      };
    }

    const txn = this.store.getTransaction(payload.out_trade_no);
    if (txn) txn.notify_count = (txn.notify_count || 0) + 1;

    this.store.addNotifyLog({
      event_type: eventType,
      out_trade_no: payload.out_trade_no || '',
      url: notifyUrl,
      status: result.status,
      ok: result.ok,
      error: result.error,
      latency: Date.now() - started,
    });

    if (result.ok) {
      this.log(`回调 ${eventType} → ${notifyUrl}  ${result.status}`, 'notify');
    } else {
      this.log(`回调失败 ${eventType} → ${notifyUrl}  ${result.error}`, 'error');
    }
    return result;
  }

  /** 把内部订单转成微信回调里的 resource 结构 */
  buildResource(type, p) {
    if (type === 'refund') {
      return {
        mchid: this.mchid,
        out_trade_no: p.out_trade_no,
        transaction_id: p.transaction_id,
        out_refund_no: p.out_refund_no,
        refund_id: p.refund_id,
        refund_status: 'SUCCESS',
        success_time: new Date(p.created_at).toISOString(),
        amount: p.amount,
      };
    }
    return this.txnToWechat(p);
  }

  /** 内部订单 → 微信标准 transaction 对象 */
  txnToWechat(txn) {
    const base = {
      appid: txn.appid,
      mchid: txn.mchid,
      out_trade_no: txn.out_trade_no,
      transaction_id: txn.transaction_id,
      trade_type: 'NATIVE',
      trade_state: txn.trade_state,
      trade_state_desc: txn.trade_state_desc,
      bank_type: 'OTHERS',
      attach: txn.attach,
      success_time: txn.success_time,
      payer: txn.payer,
      amount: {
        total: txn.amount.total,
        payer_total: txn.amount.total,
        currency: 'CNY',
        payer_currency: 'CNY',
      },
    };
    if (txn.trade_state === 'SUCCESS' || txn.trade_state === 'REFUND') {
      base.promotion_detail = [];
    }
    return base;
  }
}

function err(status, code, message) {
  return { status, body: { code, message } };
}

function fmtAmount(fen) {
  return '¥' + (fen / 100).toFixed(2);
}

module.exports = { WeChatMock };

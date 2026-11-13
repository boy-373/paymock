'use strict';

/**
 * 内存存储（2026-11-14）
 *
 * 所有数据只存在进程内存里，重启就清空。
 * 这是刻意的：本地调试工具不该在磁盘上留一堆测试数据。
 */

const crypto = require('crypto');

class Store {
  constructor() {
    this.transactions = new Map();   // out_trade_no -> txn
    this.refunds = new Map();        // out_refund_no -> refund
    this.logs = [];                  // 请求日志，最多 500 条
    this.notifyLogs = [];            // 回调发送记录，最多 200 条
    this.startedAt = Date.now();
  }

  /* ---------- 交易 ---------- */

  createTransaction(input) {
    const outTradeNo = input.out_trade_no || 'MOCK' + Date.now();
    if (this.transactions.has(outTradeNo)) {
      return { error: 'ORDER_CLOSED', message: '商户订单号重复' };
    }
    const txn = {
      out_trade_no: outTradeNo,
      transaction_id: '4200' + crypto.randomBytes(14).toString('hex').toUpperCase().slice(0, 28),
      mchid: input.mchid || '1900000001',
      appid: input.appid || 'wxdemo0000000001',
      description: input.description || '本地测试订单',
      out_trade_no_created_at: new Date().toISOString(),
      amount: {
        total: (input.amount && input.amount.total) || 1,
        currency: (input.amount && input.amount.currency) || 'CNY',
      },
      payer: { openid: 'oUpF8uMuAJO_M2pxb1Q9zNjWeS6o' },
      trade_state: 'NOTPAY',
      trade_state_desc: '订单未支付',
      notify_url: input.notify_url || '',
      attach: input.attach || '',
      success_time: null,
      created_at: Date.now(),
      notify_count: 0,
    };
    this.transactions.set(outTradeNo, txn);
    return { txn };
  }

  getTransaction(outTradeNo) {
    return this.transactions.get(outTradeNo) || null;
  }

  listTransactions() {
    return Array.from(this.transactions.values()).sort((a, b) => b.created_at - a.created_at);
  }

  /** 把订单标记为已支付 */
  markPaid(outTradeNo) {
    const txn = this.transactions.get(outTradeNo);
    if (!txn) return { error: 'ORDER_NOT_EXIST', message: '订单不存在' };
    if (txn.trade_state === 'SUCCESS') {
      return { error: 'ALREADY_PAID', message: '订单已支付，本次不重复变更状态' };
    }
    txn.trade_state = 'SUCCESS';
    txn.trade_state_desc = '支付成功';
    txn.success_time = new Date().toISOString();
    return { txn };
  }

  /** 关单 */
  closeTransaction(outTradeNo) {
    const txn = this.transactions.get(outTradeNo);
    if (!txn) return { error: 'ORDER_NOT_EXIST', message: '订单不存在' };
    if (txn.trade_state === 'SUCCESS' || txn.trade_state === 'REFUND') {
      return { error: 'ORDER_PAID', message: '订单已支付，不能关闭' };
    }
    txn.trade_state = 'CLOSED';
    txn.trade_state_desc = '订单已关闭';
    return { txn };
  }

  /* ---------- 退款 ---------- */

  createRefund(input) {
    const txn = this.transactions.get(input.out_trade_no);
    if (!txn) return { error: 'ORDER_NOT_EXIST', message: '订单不存在' };
    if (txn.trade_state === 'NOTPAY') {
      return { error: 'ORDER_NOT_PAID', message: '订单未支付，不能退款' };
    }
    if (txn.trade_state === 'CLOSED') {
      return { error: 'ORDER_CLOSED', message: '订单已关闭，不能退款' };
    }
    const outRefundNo = input.out_refund_no || 'R' + Date.now();
    if (this.refunds.has(outRefundNo)) {
      return { error: 'REFUND_DUPLICATE', message: '退款单号重复' };
    }
    const refundAmount = (input.amount && input.amount.refund) || txn.amount.total;

    // 累加已退金额，支持部分退款多次退
    let alreadyRefunded = 0;
    for (const r of this.refunds.values()) {
      if (r.out_trade_no === input.out_trade_no) alreadyRefunded += r.amount.refund;
    }
    if (alreadyRefunded + refundAmount > txn.amount.total) {
      return {
        error: 'REFUND_AMOUNT_EXCEED',
        message: `退款金额超过可退余额（订单 ${txn.amount.total} 分，已退 ${alreadyRefunded} 分，本次申请 ${refundAmount} 分）`,
      };
    }
    const refund = {
      out_refund_no: outRefundNo,
      refund_id: '5030' + crypto.randomBytes(14).toString('hex').toUpperCase().slice(0, 28),
      out_trade_no: input.out_trade_no,
      transaction_id: txn.transaction_id,
      status: 'SUCCESS',
      amount: {
        total: txn.amount.total,
        refund: refundAmount,
        payer_total: txn.amount.total,
        payer_refund: refundAmount,
        currency: 'CNY',
      },
      reason: input.reason || '本地测试退款',
      created_at: Date.now(),
      notify_url: input.notify_url || txn.notify_url,
    };
    this.refunds.set(outRefundNo, refund);
    // 全额退完才把订单状态改成 REFUND，部分退款保持 SUCCESS
    if (alreadyRefunded + refundAmount >= txn.amount.total) {
      txn.trade_state = 'REFUND';
      txn.trade_state_desc = '转入退款';
    }
    return { refund };
  }

  getRefund(outRefundNo) {
    return this.refunds.get(outRefundNo) || null;
  }

  listRefunds() {
    return Array.from(this.refunds.values()).sort((a, b) => b.created_at - a.created_at);
  }

  /* ---------- 日志 ---------- */

  addLog(entry) {
    this.logs.unshift({ ...entry, ts: Date.now() });
    if (this.logs.length > 500) this.logs.length = 500;
  }

  listLogs(limit = 100) {
    return this.logs.slice(0, limit);
  }

  addNotifyLog(entry) {
    this.notifyLogs.unshift({ ...entry, ts: Date.now() });
    if (this.notifyLogs.length > 200) this.notifyLogs.length = 200;
  }

  listNotifyLogs(limit = 50) {
    return this.notifyLogs.slice(0, limit);
  }

  reset() {
    this.transactions.clear();
    this.refunds.clear();
    this.logs.length = 0;
    this.notifyLogs.length = 0;
    this.startedAt = Date.now();
  }
}

module.exports = { Store };

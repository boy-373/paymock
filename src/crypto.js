'use strict';

/**
 * 微信支付 v3 密码学工具（2026-11-14）
 *
 * 模拟"平台侧"（微信）的行为：
 *   - 生成平台密钥对和平台证书
 *   - 给回调签名（商户用平台证书验签）
 *   - 用 APIv3 密钥做 AES-256-GCM 加密（商户用它解密 resource）
 *
 * 全部使用 Node 原生 crypto，零外部依赖。
 */

const crypto = require('crypto');

/** 随机串：微信的 nonce_str 是 32 位大小写字母数字 */
function randomStr(len = 32) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const buf = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[buf[i] % chars.length];
  return out;
}

/** 生成 32 位 APIv3 密钥（商户后台那串） */
function newApiV3Key() {
  return randomStr(32);
}

/**
 * 生成一对 RSA 密钥。微信平台证书是 RSA 2048。
 * 返回 { privateKey, publicKey } 都是 PEM 文本。
 */
function newKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKey, publicKey };
}

/**
 * 微信支付 v3 签名：RSA-SHA256，待签名串是「方法\nURL\n时间戳\n随机串\n报文主体\n」
 */
function signMessage(message, privateKeyPem) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(message);
  signer.end();
  return signer.sign(privateKeyPem, 'base64');
}

/** 验签（给需要校验商户请求的场合用） */
function verifySignature(message, signatureB64, publicKeyPem) {
  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(message);
    verifier.end();
    return verifier.verify(publicKeyPem, signatureB64, 'base64');
  } catch (_) {
    return false;
  }
}

/**
 * AES-256-GCM 加密。微信回调和平台证书下载都用这套。
 * 密文格式是 base64( ciphertext + authTag )，authTag 固定 16 字节追加在尾部。
 */
function aesGcmEncrypt(plaintext, keyStr, associatedData = '') {
  const key = Buffer.from(keyStr, 'utf8');
  if (key.length !== 32) {
    throw new Error('APIv3 密钥必须是 32 字节');
  }
  const nonce = crypto.randomBytes(12).toString('base64');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'));
  if (associatedData) {
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  }
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([enc, tag]).toString('base64'),
    nonce,
    associated_data: associatedData,
  };
}

/** 解密（商户侧逻辑，这里实现出来方便自测） */
function aesGcmDecrypt(ciphertextB64, keyStr, nonceB64, associatedData = '') {
  const key = Buffer.from(keyStr, 'utf8');
  const raw = Buffer.from(ciphertextB64, 'base64');
  const body = raw.subarray(0, raw.length - 16);
  const tag = raw.subarray(raw.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(nonceB64, 'base64'));
  if (associatedData) {
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
  }
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/**
 * 自签一张平台证书（X.509）。Node 没有原生证书签发能力，
 * 这里不生成真正的 X.509，而是返回 PEM 格式的公钥。
 *
 * 说明：真实微信给的是 X.509 证书，商户 SDK 会从证书里取公钥。
 * 本地模拟场景下，我们额外提供一个 GET /__api/platform-pubkey 接口返回 PEM 公钥，
 * 并在 README 里说明「如果你的 SDK 强制要求 X.509，请用 --cert-mode=pubkey」。
 */
function publicKeyAsPem(publicKeyPem) {
  return publicKeyPem;
}

/** 微信侧的 serial_no：证书序列号，32 位大写十六进制 */
function newSerialNo() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

module.exports = {
  randomStr,
  newApiV3Key,
  newKeyPair,
  signMessage,
  verifySignature,
  aesGcmEncrypt,
  aesGcmDecrypt,
  publicKeyAsPem,
  newSerialNo,
};

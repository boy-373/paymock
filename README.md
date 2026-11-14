# paymock

本地假微信支付。一条命令起服务，不用内网穿透、不用真商户号、不用等支付宝沙箱。

```bash
npx paymock wechat
```

```
──────────────────────────────────────────────────────────
  paymock v0.1.2  本地假微信支付已启动
──────────────────────────────────────────────────────────
  接口地址   http://localhost:4010
  控制台     http://localhost:4010/__panel
  商户号     1900000001
  appid      wxdemo0000000001
  APIv3密钥  7f3a9c2e1b8d4f6a0c5e2d9b7a1f3e8c
  平台序列号 5A1B2C3D4E5F60718293A4B5C6D7E8F901234567
──────────────────────────────────────────────────────────
把代码里的 baseURL 换成上面的接口地址，就能下单了。
Ctrl+C 停止。数据只存在内存里，重启即清空。
```

把微信支付 API 地址从 `https://api.mch.weixin.qq.com` 换成 `http://localhost:4010`，下单后打开面板点「支付成功」，你的 `notify_url` 就会收到一条带真实签名的回调。

## 解决什么问题

接微信支付时，本地开发有三个绕不过去的坑：

1. **回调打不到 localhost** —— 微信要求公网 HTTPS 地址，你得搞内网穿透、备案域名、配证书
2. **没有商户号跑不通** —— 申请要营业执照 + 3~7 天审核 + 300 元认证费
3. **异常场景测不了** —— 支付超时、重复通知、签名错误、金额不符，线上永远遇不到，上线就炸

paymock 把这三件事一次性解决：本地起一个和微信支付 v3 行为一致的假网关，签名是真的、加密是真的、错误码是真的，但不用联网、不用真钱。

## 快速开始

### 1. 起服务

```bash
npx paymock wechat
```

默认端口 4010，密钥随机生成。想固定就传参数：

```bash
npx paymock wechat --port 4010 --mchid 1900000001 --key your32bytekey0000000000000000000
```

### 2. 改一行配置

```js
// 微信官方 SDK（wechatpay-node-v3 / wechatpay-axios-plugin 都支持）
const pay = new Pay({
  appid: 'wxdemo0000000001',
  mchid: '1900000001',
  privateKey: fs.readFileSync('./apiclient_key.pem'),
  serial: 'your-serial-no',
  // 只改这一行
  baseUrl: 'http://localhost:4010',
});
```

用 axios / fetch 手写的，把 `https://api.mch.weixin.qq.com` 换掉就行。

### 3. 下单

```js
const res = await pay.transactions_native({
  description: '测试商品',
  out_trade_no: 'T' + Date.now(),
  notify_url: 'http://localhost:3000/api/pay/notify',
  amount: { total: 1, currency: 'CNY' },
});
// res.code_url = "weixin://wxpay/bizpayurl?pr=..."
```

### 4. 点一下，回调就到了

打开 http://localhost:4010/__panel，找到那笔订单，点「支付成功」。

你的 `notify_url` 会收到一条**真实格式**的回调：RSA-SHA256 签名用平台私钥签的、resource 用 APIv3 密钥 AES-256-GCM 加密的。用官方 SDK 的解密验签方法，能原样通过。

```
POST http://localhost:3000/api/pay/notify
Wechatpay-Signature: hQ0k...
Wechatpay-Timestamp: 1763089234
Wechatpay-Nonce: 8f3a9c2e1b8d4f6a0c5e2d9b7a1f3e8c
Wechatpay-Serial: 5A1B2C3D4E5F60718293A4B5C6D7E8F901234567

{"id":"evt_...","event_type":"TRANSACTION.SUCCESS","resource":{...}}
```

## 面板能干什么

| 操作 | 场景 |
|---|---|
| 支付成功 | 正常流程 |
| 支付失败 | 测失败分支 |
| 重复通知 | 微信会重发 8 次，你的接口必须幂等 |
| 延迟通知 | 测超时重试 |
| 部分退款 / 全额退款 | 退款流程 |
| 请求日志 | 看你发的请求到底长什么样 |
| 一键重置 | 清空重来 |

## 支持的接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v3/pay/transactions/native` | Native 下单 |
| GET | `/v3/pay/transactions/out-trade-no/{no}` | 按商户单号查单 |
| POST | `/v3/pay/transactions/out-trade-no/{no}/close` | 关单 |
| POST | `/v3/refund/domestic/refunds` | 申请退款 |
| GET | `/v3/refund/domestic/refunds/{no}` | 查退款 |
| GET | `/v3/certificates` | 平台证书（商户验签用） |

没实现的接口返回 404 并说明，不会假装成功。

## 命令行

```bash
paymock wechat [--port 4010] [--mchid 1900000001] [--appid wxdemo...] [--key 32位密钥]
paymock trigger <out_trade_no> [--mode success|fail|repeat|delay] [--port 4010]
paymock info [--port 4010]
paymock --help
```

`trigger` 是给脚本用的：CI 里跑完下单，直接 `paymock trigger T001 --mode success` 就能把回调打过去。

## 已知限制

- **只做了微信支付 v3**。支付宝、Stripe 在路线图里，还没做
- **数据在内存里**，重启就清空。这是故意的——测试环境不该有历史包袱
- **不校验你发过来的签名**。你在调试，不是在生产，验签失败只会让你多绕两圈
- **金额单位是分**，和微信一致

## 为什么做这个

海外这类工具已经很成熟了：mockanything 一条命令起 Stripe 的本地孪生、idnpay-sandbox 做印尼的 QRIS、mockpay 做尼日利亚、mock-pos 做土耳其。

唯独中国没有。搜「微信支付 本地调试」，出来的每一篇都是教你怎么内网穿透。

微信支付 v3 的签名和加密是公开文档，但没人把它做成一个开箱即用的本地服务。这就是缺口。

## 路线图

- [x] 微信支付 v3 Native 下单 / 查单 / 关单 / 退款
- [x] 回调签名 + AES-GCM 加密
- [x] 可视化面板
- [ ] JSAPI / H5 / APP 下单
- [ ] 支付宝当面付 + 手机网站支付
- [ ] Stripe Checkout
- [ ] 场景录制回放
- [ ] `--record` 把真实请求录下来，回放成 mock

## License

MIT

---

微信支付是腾讯的商标。本项目与腾讯无关，仅用于本地开发调试，不可用于生产环境。

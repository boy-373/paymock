#!/usr/bin/env node
'use strict';

/**
 * paymock CLI（2026-11-14）
 *
 *   paymock wechat                  起一个本地假微信支付
 *   paymock trigger <单号> [--mode]  手动触发支付/失败/重复通知
 *   paymock info                    查看当前运行实例的接入信息
 */

const path = require('path');
const { start, COLORS } = require(path.join(__dirname, '..', 'src', 'server.js'));
const pkg = require(path.join(__dirname, '..', 'package.json'));

const HELP = `
${COLORS.bold}paymock${COLORS.reset} v${pkg.version} — 本地假微信支付

${COLORS.bold}用法${COLORS.reset}
  paymock wechat [选项]              起一个本地微信支付服务
  paymock trigger <商户订单号> [选项]  手动触发支付结果
  paymock info [--port 4010]          查看运行中实例的接入信息
  paymock --help                      显示帮助
  paymock --version                   显示版本

${COLORS.bold}wechat 选项${COLORS.reset}
  --port <n>      监听端口，默认 4010
  --key <32位>    固定 APIv3 密钥，不传则每次启动随机生成
  --mchid <s>     商户号，默认 1900000001
  --appid <s>     appid，默认 wxdemo0000000001
  --quiet         不打印请求日志

${COLORS.bold}trigger 选项${COLORS.reset}
  --mode success  标记支付成功并推送回调（默认）
  --mode fail     只推送支付失败通知，不改订单状态
  --mode repeat   订单已支付时再推一次，用来测幂等
  --port <n>      目标实例端口，默认 4010

${COLORS.bold}示例${COLORS.reset}
  ${COLORS.dim}$${COLORS.reset} paymock wechat
  ${COLORS.dim}$${COLORS.reset} paymock wechat --port 4011 --key 01234567890123456789012345678901
  ${COLORS.dim}$${COLORS.reset} paymock trigger T001
  ${COLORS.dim}$${COLORS.reset} paymock trigger T001 --mode repeat

${COLORS.bold}面板${COLORS.reset}
  启动后打开 ${COLORS.cyan}http://localhost:4010/__panel${COLORS.reset}
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version' || a === '-v') out.version = true;
    else if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = val;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function banner(info, port) {
  const c = COLORS;
  const line = '─'.repeat(58);
  console.log('');
  console.log(`${c.dim}${line}${c.reset}`);
  console.log(`  ${c.bold}${c.green}paymock${c.reset} ${c.dim}v${pkg.version}${c.reset}  本地假微信支付已启动`);
  console.log(`${c.dim}${line}${c.reset}`);
  console.log(`  接口地址   ${c.cyan}http://localhost:${port}${c.reset}`);
  console.log(`  控制台     ${c.cyan}http://localhost:${port}/__panel${c.reset}`);
  console.log(`  商户号     ${info.mchid}`);
  console.log(`  appid      ${info.appid}`);
  console.log(`  APIv3密钥  ${c.yellow}${info.apiV3Key}${c.reset}`);
  console.log(`  平台序列号 ${info.platformSerial}`);
  console.log(`${c.dim}${line}${c.reset}`);
  console.log(`${c.dim}把代码里的 baseURL 换成上面的接口地址，就能下单了。${c.reset}`);
  console.log(`${c.dim}Ctrl+C 停止。数据只存在内存里，重启即清空。${c.reset}`);
  console.log('');
}

async function cmdWechat(args) {
  const port = parseInt(args.port, 10) || 4010;
  const apiV3Key = args.key;
  if (apiV3Key && String(apiV3Key).length !== 32) {
    console.error(`${COLORS.red}--key 必须是 32 位字符串，当前 ${String(apiV3Key).length} 位${COLORS.reset}`);
    process.exit(4);
  }

  const { server, wechat } = await start({
    port,
    apiV3Key,
    mchid: typeof args.mchid === 'string' ? args.mchid : undefined,
    appid: typeof args.appid === 'string' ? args.appid : undefined,
    quiet: !!args.quiet,
  });

  banner(wechat.info(), port);

  const shutdown = () => {
    console.log(`\n${COLORS.dim}正在关闭...${COLORS.reset}`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdTrigger(args) {
  const no = args._[1];
  if (!no) {
    console.error(`${COLORS.red}缺少商户订单号${COLORS.reset}\n用法: paymock trigger <商户订单号> [--mode success|fail|repeat]`);
    process.exit(4);
  }
  const port = parseInt(args.port, 10) || 4010;
  const mode = typeof args.mode === 'string' ? args.mode : 'success';
  if (!['success', 'fail', 'repeat'].includes(mode)) {
    console.error(`${COLORS.red}--mode 只能是 success / fail / repeat${COLORS.reset}`);
    process.exit(4);
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/__api/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ out_trade_no: no, mode }),
    });
    const data = await res.json();
    if (res.ok) {
      console.log(`${COLORS.green}✔${COLORS.reset} ${data.message}`);
      process.exit(0);
    } else {
      console.error(`${COLORS.red}✘${COLORS.reset} ${data.message || '触发失败'}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`${COLORS.red}连不上 localhost:${port}${COLORS.reset}`);
    console.error(`${COLORS.dim}先在另一个终端跑 paymock wechat${COLORS.reset}`);
    process.exit(1);
  }
}

async function cmdInfo(args) {
  const port = parseInt(args.port, 10) || 4010;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__api/info`);
    const d = await res.json();
    console.log(JSON.stringify(d, null, 2));
  } catch (e) {
    console.error(`${COLORS.red}连不上 localhost:${port}${COLORS.reset}`);
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    console.log(pkg.version);
    return;
  }
  if (args.help || args._.length === 0) {
    console.log(HELP);
    return;
  }

  const cmd = args._[0];
  try {
    if (cmd === 'wechat' || cmd === 'wx') await cmdWechat(args);
    else if (cmd === 'trigger') await cmdTrigger(args);
    else if (cmd === 'info') await cmdInfo(args);
    else {
      console.error(`${COLORS.red}未知命令: ${cmd}${COLORS.reset}`);
      console.log(HELP);
      process.exit(4);
    }
  } catch (e) {
    console.error(`${COLORS.red}启动失败:${COLORS.reset} ${e.message}`);
    process.exit(1);
  }
}

main();

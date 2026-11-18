#!/usr/bin/env node
/**
 * reset-lab.mjs — 把 dsh-security-lab 的数据卷重置回初始状态。
 *
 * 为什么需要它：有些漏洞类别**必须提交数据才能验证**——
 *   - 存储型 XSS：不提交 payload 就无从判断回显是否转义
 *   - 客户端金额信任：不真的下单就看不到服务端采用了哪个金额
 *   - 数量/券边界：不加购物车就看不到服务端状态
 * 这些探测会留下工单、订单、购物车项与折扣，而它们**无法通过 API 撤销**（靶机没有删除端点）。
 * 所以「跑完探测后恢复干净状态」只能靠重置数据卷。
 *
 * 用法：
 *   node tools/reset-lab.mjs --yes            # 重置 + 重启，等健康检查通过
 *   node tools/reset-lab.mjs --yes --keep-up  # 只重置不等待（默认会等）
 *
 * 不带 `--yes` 只打印将要执行的命令，不做任何改动。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

const LAB_DIR = process.env.DSH_SECURITY_LAB_DIR
  || '/home/dev/下载/dsh-agent-team-ui-testing-security-testing/targets/dsh-security-lab';
const LAB = process.env.DSH_SECURITY_LAB || 'http://127.0.0.1:8088';

const confirmed = process.argv.includes('--yes');

if (!existsSync(LAB_DIR)) {
  console.error(`✖ 找不到靶机目录：${LAB_DIR}`);
  console.error('  用 DSH_SECURITY_LAB_DIR 指定，或先 clone 靶机。');
  process.exit(2);
}

const plan = [
  ['docker', ['compose', 'down', '-v']],
  ['docker', ['compose', 'up', '--build', '-d']],
];

if (!confirmed) {
  console.log('将执行（在 ' + LAB_DIR + '）：');
  for (const [bin, args] of plan) console.log(`  ${bin} ${args.join(' ')}`);
  console.log('\n这会删除靶机的数据卷（工单/订单/购物车/折扣全部回到初始状态）。');
  console.log('确认后重跑：node tools/reset-lab.mjs --yes');
  process.exit(0);
}

async function waitHealthy(timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(LAB + '/api/health', { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return false;
}

async function main() {
  console.log('[1/3] docker compose down -v');
  await run('docker', ['compose', 'down', '-v'], { cwd: LAB_DIR });
  console.log('[2/3] docker compose up --build -d');
  await run('docker', ['compose', 'up', '--build', '-d'], { cwd: LAB_DIR, timeout: 240_000 });
  console.log('[3/3] 等待健康检查');
  const healthy = await waitHealthy();
  if (!healthy) {
    console.error(`✖ 靶机未在超时内就绪：${LAB}`);
    process.exit(1);
  }
  // Prove the state really is pristine instead of assuming the volume wipe worked.
  const login = await fetch(LAB + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: process.env.DSH_LAB_ALICE || '' }),
  }).catch(() => null);
  if (login === null || !login.ok) {
    console.log('✔ 靶机已重置并就绪（未验证登录：缺少 DSH_LAB_ALICE）');
    process.exit(0);
  }
  const cookie = login.headers.get('set-cookie') ?? '';
  const headers = cookie === '' ? {} : { cookie: cookie.split(';')[0] };
  const tickets = await fetch(LAB + '/api/tickets', { headers }).then((r) => r.json()).catch(() => null);
  const orders = await fetch(LAB + '/api/orders', { headers }).then((r) => r.json()).catch(() => null);
  const cart = await fetch(LAB + '/api/cart', { headers }).then((r) => r.json()).catch(() => null);
  const ticketCount = Array.isArray(tickets?.tickets) ? tickets.tickets.length : null;
  const orderCount = Array.isArray(orders?.orders) ? orders.orders.length : null;
  const cartEmpty = Array.isArray(cart?.items) ? cart.items.length === 0 : null;
  console.log(`✔ 靶机已重置：tickets=${ticketCount} orders=${orderCount} cart_empty=${cartEmpty}`);
  if (ticketCount !== 0 || cartEmpty !== true) {
    console.error('✖ 状态不像是干净的初始数据，请人工确认');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('reset-lab 失败:', error?.message ?? error);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * run-security-acceptance.mjs — 一键跑全部安全验收套件并汇总。
 *
 * 复核者不需要猜要跑哪些命令：
 *   node tools/run-security-acceptance.mjs              # 跑全部，结束时报告
 *   node tools/run-security-acceptance.mjs --reset      # 开跑前与结束后都重置靶机数据
 *   node tools/run-security-acceptance.mjs --only cookie-store,identity
 *   node tools/run-security-acceptance.mjs --list       # 只列出套件与其覆盖项
 *
 * 退出码：0 全部通过；1 有套件失败；2 环境问题（靶机不可用）。
 *
 * 注意：`business-logic` / `discovery-metrics` / `vuln-coverage` / `blind-run` 会**写入靶机数据**
 * （见 docs/verification.md「靶机数据会被写脏」）。用 `--reset` 让它们在干净夹具上跑并在结束后复位。
 */
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const LAB = process.env.DSH_SECURITY_LAB || 'http://127.0.0.1:8088';

/**
 * Every security acceptance suite, in the order a reviewer should read them:
 * foundations first (scope/cookies), then discovery and analysis, then findings/reporting,
 * and finally the cross-cutting suites (isolation, regression, metrics, blind run).
 */
const SUITES = [
  { id: 'tool-smoke', covers: '工具面健康（44 个工具逐个调用）', mutates: false },
  { id: 'security-scope', covers: 'INF-01/02/04/05/06/07/08、GATE-01/07', mutates: false },
  { id: 'cookie-store', covers: 'CRED-01..10、GATE-02/03', mutates: false },
  { id: 'identity', covers: 'AUTH-01..06、GATE-06', mutates: false },
  { id: 'attack-surface', covers: 'DISC-01/04/05/06/07（结构与分级）', mutates: false },
  { id: 'discovery-metrics', covers: 'DISC-01/02/03/05 量化指标', mutates: true },
  { id: 'script-analysis', covers: 'JS-01..08', mutates: false },
  { id: 'js-metrics', covers: 'JS-01/02/03/05 量化指标', mutates: false },
  { id: 'runtime-debug', covers: 'RT-01..07', mutates: false },
  { id: 'findings', covers: 'EVD-01..07、VULN-08/09/10 公式', mutates: false },
  { id: 'business-logic', covers: 'BIZ-01..05', mutates: true },
  { id: 'vuln-coverage', covers: 'VULN-01..07/11、EVD-02', mutates: true },
  { id: 'isolation', covers: 'INF-03 隔离矩阵', mutates: false },
  { id: 'regression', covers: 'REG-04/05/07', mutates: false },
  { id: 'blind-run', covers: 'REG-06 三轮一致率、GATE-05/07', mutates: true },
];

function parseArgs(argv) {
  const out = { reset: false, only: null, list: false };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--reset') { out.reset = true; continue; }
    if (token === '--list') { out.list = true; continue; }
    if (token === '--only') { out.only = String(argv[index + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean); index += 1; continue; }
  }
  return out;
}

const args = parseArgs(process.argv);

if (args.list) {
  console.log(`${SUITES.length} 个安全验收套件：`);
  for (const suite of SUITES) {
    console.log(`  ${suite.id.padEnd(20)} ${suite.covers}${suite.mutates ? '  [写入靶机数据]' : ''}`);
  }
  process.exit(0);
}

const LAB_DIR = process.env.DSH_SECURITY_LAB_DIR
  || '/home/dev/下载/dsh-agent-team-ui-testing-security-testing/targets/dsh-security-lab';

async function resetLab(label) {
  console.log(`\n[reset] ${label} …`);
  try {
    const { stdout } = await run('node', [join(HERE, 'reset-lab.mjs'), '--yes'], {
      env: process.env, timeout: 300_000,
    });
    const line = stdout.split('\n').filter((entry) => entry.includes('靶机已重置')).pop();
    if (line !== undefined) console.log('[reset] ' + line.replace('✔ ', ''));
  } catch (error) {
    console.error('[reset] 失败：' + String(error?.stderr ?? error?.message ?? error).slice(0, 200));
    throw error;
  }
}

async function checkLab() {
  try {
    const response = await fetch(LAB + '/api/health', { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch { return false; }
}

async function main() {
  const selected = args.only === null
    ? SUITES
    : SUITES.filter((suite) => args.only.includes(suite.id));
  const unknown = args.only === null ? [] : args.only.filter((id) => !SUITES.some((suite) => suite.id === id));
  if (unknown.length > 0) {
    console.error(`✖ 未知套件：${unknown.join(', ')}（用 --list 查看可用套件）`);
    process.exit(2);
  }

  if (!(await checkLab())) {
    console.error(`✖ 靶机不可用（${LAB}）`);
    console.error('  启动：cd ' + LAB_DIR + ' && docker compose up --build -d');
    process.exit(2);
  }

  if (args.reset) await resetLab('开跑前');

  const results = [];
  let totalChecks = 0;
  let totalPassed = 0;
  const startedAt = Date.now();

  for (const suite of selected) {
    const script = join(REPO_ROOT, 'tests', 'acceptance', suite.id + '.mjs');
    process.stdout.write(`▶ ${suite.id.padEnd(20)} `);
    let stdout = '';
    let code = 0;
    try {
      const result = await run('node', [script], { env: process.env, timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
      stdout = result.stdout;
    } catch (error) {
      stdout = String(error?.stdout ?? '');
      code = error?.code ?? 1;
    }
    // Suites print a single "N/M checks passed" summary line; parse the last one.
    const matches = [...stdout.matchAll(/(\d+)\/(\d+) checks passed/g)];
    const last = matches.length > 0 ? matches[matches.length - 1] : null;
    const passed = last === null ? null : Number(last[1]);
    const total = last === null ? null : Number(last[2]);
    const ok = code === 0 && passed !== null && passed === total;
    if (passed !== null) { totalPassed += passed; totalChecks += total; }
    results.push({ ...suite, ok, passed, total, exitCode: code });

    if (last === null) {
      console.log(`✖ 未产生结果（exit ${code}）`);
    } else {
      console.log(`${ok ? '✔' : '✖'} ${passed}/${total}`);
    }
  }

  const mutated = results.filter((result) => result.mutates === true && result.ok);
  if (args.reset && mutated.length > 0) await resetLab('跑完后（写数据的套件已运行）');

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const failed = results.filter((result) => result.ok !== true);
  console.log('\n' + '─'.repeat(64));
  for (const result of results) {
    const mark = result.ok ? '✔' : '✖';
    const counts = result.passed === null ? 'n/a' : `${result.passed}/${result.total}`;
    console.log(`  ${mark} ${result.id.padEnd(20)} ${counts.padStart(9)}   ${result.covers}`);
  }
  console.log('─'.repeat(64));
  console.log(`合计：${totalPassed}/${totalChecks} 项通过 · ${results.length - failed.length}/${results.length} 套件 · ${elapsed}s`);
  if (mutated.length > 0 && !args.reset) {
    console.log(`\n⚠ ${mutated.map((result) => result.id).join('、')} 写入了靶机数据。`);
    console.log('  恢复干净状态：node tools/reset-lab.mjs --yes');
  }
  if (failed.length > 0) {
    console.log(`\n✖ 失败套件：${failed.map((result) => result.id).join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('run-security-acceptance 失败:', error?.message ?? error);
  process.exit(1);
});

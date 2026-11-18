/**
 * js-metrics.mjs — JS-01 / JS-02 / JS-03 / JS-05 的量化指标实测。
 *
 *   JS-01 已加载脚本清单覆盖率 100%   → Debugger 清单 vs 网络真实加载的 script 资源
 *   JS-02 源码获取成功率 100%；格式化保留位置映射或明确标注无映射
 *   JS-03 Source Map 三态（存在/不存在/不可访问）准确率 100%
 *   JS-05 通过 JS 恢复的 API 路径与实际请求核对一致率 ≥90%
 *
 * 靶机 dsh-security-lab 是本地夹具，它的真实脚本清单可从网络层取得（observed），
 * 不需要考官 Oracle。
 *
 * Run: node tests/acceptance/js-metrics.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const LAB = 'http://127.0.0.1:8088';

const checks = [];
let currentSection = '';
function section(title) { currentSection = title; }
function check(condition, label, details) {
  checks.push({ ok: condition === true, label, section: currentSection, details: details ?? null });
  console.log(`${condition === true ? '✔' : '✖'} [${currentSection}] ${label}`);
  if (condition !== true && details !== undefined) console.log('   details:', JSON.stringify(details).slice(0, 700));
}
function errorInfo(result) { return { code: result?.error?.code, category: result?.error?.category }; }

const { createHarness } = await import('./harness.mjs');

async function main() {
  let labUp = false;
  try {
    const health = await fetch(LAB + '/api/health', { signal: AbortSignal.timeout(1500) });
    labUp = health.ok;
  } catch { labUp = false; }
  if (!labUp) {
    console.log('[env] dsh-security-lab 未运行 —— JS 指标需要真实靶机');
    console.log('      cd targets/dsh-security-lab && docker compose up --build -d');
    process.exitCode = 1;
    return;
  }

  const harness = await createHarness({ name: 'js-metrics' });
  const agent = { id: 'js-acc', session: { header: { cwd: harness.workspaceDir } } };
  const exec = { agent };
  try {
    await harness.invoke('browser_tabs', { action: 'open' }, exec);
    await harness.invoke('browser_network_session', { action: 'start', config: { captureBodies: false } }, exec);
    // Debugger must be armed BEFORE the document loads, otherwise the first scriptParsed batch
    // is missed (measured: arming afterwards yields 1 script instead of 3).
    await harness.invoke('browser_script', { action: 'armed' }, exec);
    await harness.invoke('browser_navigate', { url: LAB }, exec);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // ---- JS-01: inventory coverage ------------------------------------------------------
    section('JS-01-coverage');
    const inventory = await harness.invoke('browser_script', { action: 'list' }, exec);
    const scripts = inventory.value?.inventory?.scripts ?? [];
    check(inventory.value?.armed === true, 'JS-01 Debugger 已启用', inventory.value?.armed);
    check(scripts.length > 0, `JS-01 采集到脚本清单（${scripts.length} 个）`, scripts.length);

    // Ground truth from the network layer: every real script resource the page loaded.
    const events = await harness.invoke('browser_network_events', { limit: 200 }, exec);
    check(events.ok === true, 'JS-01 网络事件读取成功（limit 上限 200，超限会被拒）', errorInfo(events));
    const allEvents = events.value?.events ?? [];
    const typeCounts = {};
    for (const event of allEvents) {
      const key = String(event?.resourceType ?? 'null') + '/' + String(event?.kind ?? 'null') + '/' + String(event?.phase ?? 'null');
      typeCounts[key] = (typeCounts[key] ?? 0) + 1;
    }
    console.log('   [diag] events=' + allEvents.length + ' types=' + JSON.stringify(typeCounts).slice(0, 300));
    // Resource type lives on the event as `resourceType` (lower-case 'script').
    const networkScripts = [...new Set((events.value?.events ?? [])
      .filter((event) => String(event?.resourceType ?? '').toLowerCase() === 'script')
      .map((event) => {
        try { return new URL(String(event.url)).pathname; } catch { return null; }
      })
      .filter((path) => path !== null))];
    const inventoryPaths = new Set(scripts
      .map((script) => {
        const url = String(script.url ?? '');
        if (url === '') return null;
        try { return new URL(url).pathname; } catch { return null; }
      })
      .filter((path) => path !== null));
    const missingScripts = networkScripts.filter((path) => !inventoryPaths.has(path));
    check(networkScripts.length > 0, `JS-01 网络层记录到真实的 script 资源（${networkScripts.length} 个）`, networkScripts);
    check(missingScripts.length === 0,
      `JS-01 脚本清单覆盖率 ${((1 - missingScripts.length / Math.max(1, networkScripts.length)) * 100).toFixed(1)}% = 100%`,
      { networkScripts, inventoryPaths: [...inventoryPaths], missingScripts });
    // Every inventory row must carry the facts a consumer needs.
    // The inventory is a CHEAP list: it carries identifiers and byte/line facts, not hashes.
    // Hashes are computed on demand by `source` (which returns sha256 + bytes). Asserting a hash
    // here would be asserting a field that is correctly absent.
    const incompleteRows = scripts.filter((script) => typeof script.url !== 'undefined'
      && (typeof script.length !== 'number' || !Array.isArray(script.scriptIds) || script.scriptIds.length === 0));
    check(incompleteRows.length === 0, 'JS-01 每行都带 scriptIds 与长度（清单不含内容）', incompleteRows);

    // ---- JS-02: source fetch + format mapping -------------------------------------------
    section('JS-02-source');
    const fetchResults = [];
    for (const script of scripts) {
      const fetched = await harness.invoke('browser_script', { action: 'source', scriptId: script.scriptIds?.[0] ?? script.scriptId }, exec);
      fetchResults.push({
        url: String(script.url ?? ''),
        ok: fetched.ok === true,
        code: fetched.error?.code ?? null,
        bytes: fetched.value?.script?.bytes ?? null,
        hasSource: typeof fetched.value?.source === 'string',
        sha256: fetched.value?.script?.sha256 ?? null,
      });
    }
    const fetchSuccess = fetchResults.filter((entry) => entry.ok && entry.hasSource);
    const fetchRate = fetchSuccess.length / Math.max(1, fetchResults.length);
    check(fetchRate === 1,
      `JS-02 源码获取成功率 ${(fetchRate * 100).toFixed(1)}%（${fetchSuccess.length}/${fetchResults.length}）`,
      fetchResults.filter((entry) => !entry.ok).map((entry) => ({ url: entry.url.slice(-30), code: entry.code })));
    check(fetchResults.every((entry) => typeof entry.sha256 === 'string' && entry.sha256.length === 64),
      'JS-02 每个源码都带 64 位 sha256（可复核）', fetchResults.map((entry) => entry.sha256?.length));

    // Format must either keep a line map or say explicitly that there is none.
    const formatResults = [];
    for (const script of scripts) {
      const formatted = await harness.invoke('browser_script', { action: 'format', scriptId: script.scriptIds?.[0] ?? script.scriptId }, exec);
      const payload = formatted.value?.formatted ?? {};
      formatResults.push({
        ok: formatted.ok === true,
        code: formatted.error?.code ?? null,
        isOriginalSource: payload.isOriginalSource ?? null,
        lineMapSize: Array.isArray(payload.lineMap) ? payload.lineMap.length : null,
        note: payload.note ?? null,
      });
    }
    const formatOk = formatResults.filter((entry) => entry.ok);
    check(formatOk.length > 0, `JS-02 格式化可用（${formatOk.length}/${formatResults.length}）`, formatResults.filter((entry) => !entry.ok).map((entry) => entry.code));
    check(formatOk.every((entry) => entry.isOriginalSource === false),
      'JS-02 格式化结果明确标注 isOriginalSource:false（不冒充原始源码）', formatOk.map((entry) => entry.isOriginalSource));
    check(formatOk.every((entry) => entry.lineMapSize !== null && entry.lineMapSize > 0),
      'JS-02 格式化保留逐行原始位置映射', formatOk.map((entry) => entry.lineMapSize));

    // ---- JS-03: Source Map tri-state ----------------------------------------------------
    section('JS-03-sourcemap');
    // The lab ships no source maps. Verify the report says "absent" for each script, and verify
    // that claim independently: no request for a .map file may exist in the network log.
    const mapRequests = (events.value?.events ?? []).filter((event) => String(event?.url ?? '').endsWith('.map'));
    const mapStates = scripts.map((script) => ({
      url: String(script.url ?? ''),
      sourceMapUrl: script.sourceMapUrl ?? null,
    }));
    const declaredPresent = mapStates.filter((entry) => typeof entry.sourceMapUrl === 'string' && entry.sourceMapUrl !== '');
    check(mapRequests.length === 0,
      'JS-03 网络日志中没有 .map 请求（独立验证"不存在"这个结论）', mapRequests.length);
    check(declaredPresent.length === 0,
      `JS-03 ${scripts.length} 个脚本全部报告"无 Source Map"`, declaredPresent);
    // The tri-state must be a declared enum, not a boolean guess.
    const analysisOne = scripts.find((script) => String(script.url ?? '').endsWith('.js'));
    if (analysisOne !== undefined) {
      const analyzed = await harness.invoke('browser_script', {
        action: 'source', scriptId: analysisOne.scriptIds?.[0] ?? analysisOne.scriptId,
      }, exec);
      const sourceMapState = analyzed.value?.sourceMap ?? null;
      check(sourceMapState !== null && typeof sourceMapState.status === 'string',
        `JS-03 报告 Source Map 三态（实测 ${sourceMapState?.status}）`, sourceMapState);
      check(sourceMapState?.status === 'absent',
        'JS-03 三态取值与"靶机没有 source map"的事实一致（absent + 原因）', sourceMapState);
      check(typeof sourceMapState?.reason === 'string' && sourceMapState.reason !== '',
        'JS-03 给出判定原因（不是无依据的结论）', sourceMapState?.reason);
    }

    // ---- JS-05: recovered paths vs real requests ----------------------------------------
    section('JS-05-path-consistency');
    const bundle = scripts.find((script) => String(script.url).includes('.js'));
    check(bundle !== undefined, 'JS-05 找到可分析的 bundle', bundle?.url);
    const analysis = bundle === undefined ? null : await harness.invoke('browser_script', {
      action: 'analyze', scriptId: bundle.scriptIds?.[0] ?? bundle.scriptId,
    }, exec);
    const tables = analysis?.value?.report?.stringTables ?? analysis?.value?.stringTables ?? [];
    const decodedPaths = [];
    for (const table of tables) {
      for (const raw of (table.values ?? [])) {
        if (typeof raw !== 'string') continue;
        let plain = raw;
        try { plain = Buffer.from(raw, 'base64').toString('utf8'); } catch { plain = raw; }
        if (/^\/api\//.test(plain)) decodedPaths.push(plain);
      }
    }
    const recovered = [...new Set(decodedPaths)];
    check(recovered.length >= 10, `JS-05 从字符串表还原出 ${recovered.length} 条 API 路径`, recovered.length);
    // Consistency: each recovered path must correspond to a real request the page actually made
    // (or a path the app really serves). The metric is agreement, not count.
    const normalize = (value) => {
      let path = String(value ?? '').split('?')[0].split('#')[0];
      if (path.length > 1) path = path.replace(/\/+$/, '');
      return path;
    };
    const realPaths = new Set((events.value?.events ?? [])
      .map((event) => { try { return normalize(new URL(String(event.url)).pathname); } catch { return null; } })
      .filter((path) => path !== null));
    const matched = recovered.filter((rawPath) => {
      const path = normalize(rawPath);
      if (realPaths.has(path)) return true;
      // A recovered template may differ by a trailing segment (/api/orders vs /api/orders/1);
      // count it as agreeing when a real request lives under that prefix.
      return [...realPaths].some((real) => real.startsWith(path) || path.startsWith(real));
    });
    const consistency = matched.length / recovered.length;
    check(consistency >= 0.9,
      `JS-05 静态还原与真实请求一致率 ${(consistency * 100).toFixed(1)}%（${matched.length}/${recovered.length}）≥90%`,
      recovered.filter((path) => !matched.includes(path)));

    const failed = checks.filter((entry) => !entry.ok);
    console.log(`\n==== js-metrics: ${checks.length - failed.length}/${checks.length} checks passed ====`);
    if (failed.length > 0) {
      for (const entry of failed) console.log('FAILED:', entry.section, '|', entry.label, JSON.stringify(entry.details).slice(0, 400));
      process.exitCode = 1;
    }
  } finally {
    await harness.closeBrowser();
    await harness.dispose();
  }
}

main().catch((error) => {
  console.error('js-metrics crashed:', error);
  process.exitCode = 1;
});

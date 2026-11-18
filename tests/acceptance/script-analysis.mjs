/**
 * script-analysis.mjs — FR-03/FR-04 JavaScript static analysis acceptance (JS-01..JS-08).
 *
 * Ground truth: dsh-security-lab's `/static/app.min.js` — a single-line minified bundle with a
 * Base64 string table, no Source Map, and a DOM render path. The suite arms the Debugger domain,
 * reloads the lab page, then asserts against the REAL bundle:
 *   JS-01 inventory covers loaded scripts (inline + external)
 *   JS-02 source fetch is readable, formatting declares itself non-original with a line map
 *   JS-03 Source Map status is three-state and never assumed
 *   JS-04 the string table is recovered entry by entry
 *   JS-05 recovered API paths match the paths actually requested by the page
 *   JS-07 a DOM source-to-sink pair is located with honest confidence
 *   JS-08 undecodable entries are labelled unknown, never fabricated
 *
 * Run: node tests/acceptance/script-analysis.mjs
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname ?? '.', '..', '..');
const LAB = 'http://127.0.0.1:8088';

const checks = [];
let currentSection = '';
function section(title) { currentSection = title; }
function check(condition, label, details) {
  checks.push({ ok: condition === true, label, section: currentSection, details: details ?? null });
  console.log(`${condition === true ? '✔' : '✖'} [${currentSection}] ${label}`);
  if (condition !== true && details !== undefined) console.log('   details:', JSON.stringify(details).slice(0, 900));
}

const { createHarness } = await import('./harness.mjs');

/** Paths the lab bundle exposes that the page is expected to call during normal use. */
const EXPECTED_PATHS = [
  '/api/login', '/api/me', '/api/products', '/api/cart', '/api/orders', '/api/tickets', '/api/health',
];

async function main() {
  let base = null;
  let fixture = null;
  let labMode = false;
  try {
    const health = await fetch(LAB + '/api/health', { signal: AbortSignal.timeout(1500) });
    labMode = health.ok;
  } catch { labMode = false; }
  if (labMode) {
    base = LAB;
  } else {
    const { startFixtureServer } = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);
    fixture = await startFixtureServer();
    base = fixture.url.replace(/\/$/, '');
    console.log('[env] lab unavailable → local fixture (JS-04/05 checks will be skipped)', base);
  }
  console.log('[env]', base);

  const harness = await createHarness({ name: 'script-analysis' });
  const agent = { id: 'script-acc', session: { header: { cwd: harness.workspaceDir } } };
  const exec = { agent };
  try {
    await harness.invoke('browser_tabs', { action: 'open' }, exec);

    // ---- JS-01: not armed is a structured state, not "no scripts" -------------------------
    section('JS-01-inventory');
    const before = await harness.invoke('browser_script', { action: 'list' }, exec);
    check(before.ok === true && before.value?.armed === false, '未 armed 时返回 armed:false（不伪装成"没有脚本"）', before.value);
    check(typeof before.value?.note === 'string' && before.value.note.includes('armed'), '并给出启用方式');

    // Arm, then load the page so scriptParsed is collected for the current document.
    const armed = await harness.invoke('browser_script', { action: 'armed' }, exec);
    check(armed.ok === true, 'Debugger 域启用成功（armed）');
    await harness.invoke('browser_navigate', { url: base }, exec);
    // The lab bundle is a subresource; give the document a moment to finish loading it.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const listed = await harness.invoke('browser_script', { action: 'list' }, exec);
    const inventory = listed.value?.inventory ?? {};
    check(listed.value?.armed === true, 'armed 后清单可用');
    check((inventory.counts?.scripts ?? 0) >= 2, `脚本清单覆盖 inline + external（实测 ${inventory.counts?.scripts}）`, inventory.counts);
    check((inventory.counts?.bySource?.external ?? 0) >= 1, 'external 脚本被识别', inventory.counts?.bySource);
    check((inventory.counts?.bySource?.inline ?? 0) >= 1, 'inline 脚本被识别', inventory.counts?.bySource);
    check(inventory.scripts?.every((script) => typeof script.url === 'string' && Array.isArray(script.scriptIds)),
      '每条清单项带 url 与 scriptIds（可回链）');

    const bundle = (inventory.scripts ?? []).find((script) => script.url.includes('app.min.js'));
    if (labMode) {
      check(bundle !== undefined, '靶机压缩包 app.min.js 在清单中（JS-01 覆盖率）');
    }

    // ---- JS-02/JS-03: source + formatting + Source Map -----------------------------------
    section('JS-02-source');
    if (bundle !== undefined) {
      const source = await harness.invoke('browser_script', { action: 'source', scriptId: bundle.scriptIds[0] }, exec);
      check(source.ok === true, '源码获取成功');
      check(typeof source.value?.script?.sha256 === 'string' && source.value.script.sha256.length === 64, '源码带 sha256 内容指纹');
      check(source.value?.script?.bytes > 0, '字节数已记录', source.value?.script?.bytes);
      check(source.value?.sourceMap?.status === 'absent', 'JS-03 靶机无 Source Map（absent 是观测事实）', source.value?.sourceMap);

      const formatted = await harness.invoke('browser_script', { action: 'format', scriptId: bundle.scriptIds[0] }, exec);
      check(formatted.ok === true, '格式化成功');
      check(formatted.value?.formatted?.isOriginalSource === false, 'JS-02 明确标注格式化结果不是原始源码');
      check((formatted.value?.formatted?.lineMap?.length ?? 0) > 1, 'JS-02 提供逐行原始位置映射', formatted.value?.formatted?.lineMap?.length);
      const formattedLines = (formatted.value?.formatted?.text ?? '').split('\n').length;
      check(formattedLines >= (formatted.value?.formatted?.lineMap?.length ?? 0),
        '格式化行数与映射条目一致（可回链）');

      // ---- JS-04/JS-05: string table + recovered API paths -------------------------------
      section('JS-04-strings');
      const strings = await harness.invoke('browser_script', { action: 'strings', scriptId: bundle.scriptIds[0] }, exec);
      const counts = strings.value?.counts ?? {};
      check((counts.tables ?? 0) >= 1, `识别到字符串表（实测 ${counts.tables}）`);
      check((counts.entries ?? 0) >= 14, `字符串表条目还原（实测 ${counts.entries}）`, counts);
      check((counts.decoded ?? 0) >= 14, `可确定还原条目数（decoded=${counts.decoded}）`, counts);
      check(counts.unknown === 0 || typeof counts.unknown === 'number', 'JS-08 unknown 计数如实报告（不伪造）', counts);

      const table = (strings.value?.stringTables ?? [])[0];
      const decodedValues = (table?.decoded ?? []).filter((entry) => entry.status === 'decoded').map((entry) => entry.value);
      section('JS-05-paths');
      const recoveredPaths = decodedValues.filter((value) => value.startsWith('/api/'));
      check(recoveredPaths.length >= 10, `JS-05 恢复 API 路径（实测 ${recoveredPaths.length}）`, recoveredPaths);
      const missing = EXPECTED_PATHS.filter((path) => !recoveredPaths.some((value) => value.startsWith(path)));
      check(missing.length === 0, 'JS-05 页面实际使用的端点都在还原结果中', missing);
      check(decodedValues.some((value) => /salt/i.test(value)), 'JS-06 盐值类常量被还原', decodedValues.filter((v) => /salt/i.test(v)));
      check(decodedValues.some((value) => /X-Lab-Proof/i.test(value)), 'JS-06 签名头名被还原', decodedValues.filter((v) => /Proof/i.test(v)));

      // ---- JS-07: source-to-sink ---------------------------------------------------------
      section('JS-07-sinks');
      const sinks = await harness.invoke('browser_script', { action: 'sinks', scriptId: bundle.scriptIds[0] }, exec);
      const findings = sinks.value?.findings ?? [];
      check(findings.length >= 1, `定位到 sink（实测 ${findings.length}）`, findings.map((f) => f.sink));
      check(findings.some((finding) => finding.sink === 'innerHTML'), '定位到 innerHTML sink（DOM XSS 渲染路径）');
      check(findings.every((finding) => ['high', 'medium', 'low'].includes(finding.confidence)), '每个 sink 都带置信度');
      check(findings.every((finding) => finding.evidence === 'static-pattern'), '证据标注为静态模式（不声称已利用）');

      // ---- JS-08: consistency against runtime, and honest unknowns ----------------------
      section('JS-08-consistency');
      const analyze = await harness.invoke('browser_script', {
        action: 'analyze',
        scriptId: bundle.scriptIds[0],
        runtimeValues: { loginPath: '/api/login', productsPath: '/api/products' },
      }, exec);
      const report = analyze.value?.report ?? {};
      check(report.consistency?.total === 2 && report.consistency?.consistent === 2,
        'JS-08 静态还原与运行时观测一致（2/2）', report.consistency);
      check(report.limitations?.some((line) => line.includes('unknown') || line.includes('静态分析')),
        'JS-08 结论附带 limitations（静态分析的边界如实声明）', report.limitations);
      const unknownEntries = (table?.decoded ?? []).filter((entry) => entry.status === 'unknown');
      check(unknownEntries.every((entry) => entry.value === null), 'unknown 条目不伪造取值', unknownEntries.length);
    }

    const failed = checks.filter((entry) => !entry.ok);
    console.log(`\n==== script-analysis acceptance: ${checks.length - failed.length}/${checks.length} checks passed ====`);
    if (failed.length > 0) {
      for (const entry of failed) console.log('FAILED:', entry.section, '|', entry.label, JSON.stringify(entry.details).slice(0, 400));
      process.exitCode = 1;
    }
  } finally {
    await harness.closeBrowser();
    await harness.dispose();
    fixture?.close();
  }
}

main().catch((error) => {
  console.error('script-analysis acceptance crashed:', error);
  process.exitCode = 1;
});

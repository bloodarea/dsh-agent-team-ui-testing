#!/usr/bin/env node
/**
 * Structural self-check for the bundled ui-testing skill.
 *
 * Checks (all against the real repository files, no network):
 *   - skills/ui-testing/SKILL.md has a parseable YAML frontmatter, name is `ui-testing`,
 *     description is non-empty and names at least one real browser_* tool;
 *   - every `references/*.md` mentioned/backticked in SKILL.md exists on disk;
 *   - every browser_* tool name mentioned in SKILL.md is one of the tools index.js actually
 *     registers (no invented capabilities, no Playwright/Puppeteer tool names);
 *   - the composed surface is consistent: index.js registers 36 tools (10 T1 + 1 P0-E + 7 T2 + 6 T3
 *     + 7 network + 5 T4) and the manifest declares every tier as supported. Capability status
 *     ledgers live in docs/internal/ (local engineering notes) and are no longer part of the
 *     shipped skill, so they are not checked here.
 *   - the verdict-gate references (P0/P1/P2 gate + reporting docs, see task-1) exist on disk and are
 *     linked one-by-one from SKILL.md; the gate vocabulary is actually present
 *     (expected_contract / counterexamples / page identity / coverage /
 *     INSUFFICIENT_TEMPORAL_RESOLUTION);
 *   - no V2 target-specific answer leaks into the shipped skill (precise denylist: coupon code,
 *     target animation/component names, defect ids, panel readout values, answer-style claims);
 *   - the entry skill stays small (SKILL.md <= 520 lines).
 *
 * SKIP (exit 0) when skills/ does not exist yet (task-1 not started / not merged).
 * Exit codes: 0 pass or skip, 1 structural failure.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const SKILLS_ROOT = join(REPO_ROOT, 'skills');
const SKILL_DIR = join(SKILLS_ROOT, 'ui-testing');
const SKILL_FILE = join(SKILL_DIR, 'SKILL.md');
const MANIFEST_FILE = join(SKILL_DIR, 'manifests', 'declared-capabilities.json');
const INDEX_FILE = join(REPO_ROOT, 'index.js');

const ALLOWED_STATUSES = new Set(['implemented', 'implemented-not-verified', 'verified', 'partial', 'unsupported']);

/** task-1 verdict-gate / reporting references that must ship with the entry skill. */
const GATE_REFS = [
  'verdict-gate.md', 'page-identity.md', 'tool-routing-and-limits.md', 'network-and-state.md',
  'dynamic-visual.md', 'reporting.md', 'verdict-examples.md', 'report-template.md',
];

/**
 * Gate vocabulary that must actually be present (entry skill + gate refs).
 * `any` lists an English field name plus its Chinese equivalent where both are acceptable.
 */
const GATE_KEYWORDS = [
  { label: 'expected_contract', any: ['expected_contract'] },
  { label: 'counterexamples（反例处置）', any: ['counterexamples', '反例'] },
  { label: 'page identity（页面身份门禁）', any: ['page-identity', '页面身份'] },
  { label: 'coverage（full|partial|blocked）', any: ['coverage', '覆盖'] },
  { label: 'INSUFFICIENT_TEMPORAL_RESOLUTION', any: ['INSUFFICIENT_TEMPORAL_RESOLUTION'] },
];

/**
 * V2 target-specific answer strings that must not leak into the shipped skill.
 * Kept deliberately precise: no generic words, so ordinary guidance (e.g. "lumen",
 * "target=_blank", "signal") never trips it.
 */
const DENY_PATTERNS = [
  { pattern: /SAVE10/u, label: 'V2 优惠码答案（SAVE10）' },
  { pattern: /signalSlide/u, label: 'V2 靶机动画名（signalSlide）' },
  { pattern: /ComplexWebTestbench/u, label: 'V2 靶机名（ComplexWebTestbench）' },
  { pattern: /\bD0[1-9]\b/u, label: 'V2 预置缺陷编号（D01–D09）' },
  { pattern: /\bt=233ms\b|93\.32|253,\s*14,\s*13/u, label: 'V2 面板状态行读数' },
  { pattern: /白色闪屏(?:一定|必然|就是|必定)是?缺陷/u, label: '白闪结论式答案（应由采样与契约决定）' },
  { pattern: /角标(?:必须|一定要)实时同步/u, label: '多视图同步结论式答案（应由契约决定）' },
];

/** Max lines for the entry skill (low-token loading guard). */
const ENTRY_MAX_LINES = 520;

async function* walkMarkdown(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkMarkdown(full);
    else if (entry.isFile() && entry.name.endsWith('.md')) yield full;
  }
}

const results = [];
function record(label, pass, detail, { skip = false, optional = false } = {}) {
  results.push({ label, pass: skip ? true : pass, skip, optional, detail });
  const mark = skip ? 'SKIP' : pass ? 'PASS' : optional ? 'INFO' : 'FAIL';
  console.log(`[${mark}] ${label}`);
  if (!pass && !skip && detail !== undefined) console.log(`       ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

function failSummary() {
  const failed = results.filter((item) => !item.pass && !item.skip && !item.optional);
  if (failed.length) {
    console.log(`\nFAILED ${failed.length}/${results.length} checks`);
    for (const item of failed) console.log(`  - ${item.label}: ${typeof item.detail === 'string' ? item.detail : JSON.stringify(item.detail)}`);
    return 1;
  }
  const skipped = results.filter((item) => item.skip).length;
  const info = results.filter((item) => item.optional && !item.pass).length;
  console.log(`\nPASSED ${results.length - skipped - info}/${results.length} checks${skipped ? ` (${skipped} skipped)` : ''}${info ? ` (${info} info)` : ''}`);
  return 0;
}

function parseFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!match) return undefined;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (entry) fields[entry[1]] = entry[2].trim();
  }
  return { fields, body: raw.slice(match[0].length), rawFrontmatter: match[1] };
}

async function main() {
  if (!existsSync(SKILLS_ROOT)) {
    record('skills/ 目录存在', false, 'skills/ 尚未创建，等 task-1 完成后再跑本检查', { skip: true });
    console.log('\nSKIP: skills/ 不存在（task-1 未完成）；这不是失败。');
    return 0;
  }

  if (!existsSync(SKILL_FILE)) {
    record('skills/ui-testing/SKILL.md 存在', false, `缺少 ${relative(REPO_ROOT, SKILL_FILE)}`);
    return failSummary();
  }

  // 1. index.js actually registered tool names (source of truth for "no invented tools").
  const indexSource = await readFile(INDEX_FILE, 'utf8');
  const actualTools = new Set();
  for (const match of indexSource.matchAll(/name:\s*'((?:browser_)[a-z0-9_]+)'/g)) actualTools.add(match[1]);
  // 36 = 10 T1 + 1 P0-E (`browser_tabs`) (docs/architecture.md + docs/viewport-control.md §7 `browser_viewport`)
  //      + 7 T2 (docs/t2-structured-gui.md §2.2) + 6 T3 (docs/t3-vision.md §2.1)
  //      + 7 network (docs/network-p0.md §2).
  const expectedTools = [
    'browser_navigate', 'browser_eval', 'browser_screenshot', 'browser_input', 'browser_network',
    'browser_computed_style', 'browser_http_request', 'browser_viewport', 'browser_state', 'browser_capabilities', 'browser_tabs',
    'browser_snapshot', 'browser_click', 'browser_type', 'browser_scroll', 'browser_fill_form',
    'browser_node_state', 'browser_wait_for',
    'browser_vision_image', 'browser_vision_find', 'browser_vision_compare',
    'browser_vision_act', 'browser_vision_baseline', 'browser_vision_check',
    'browser_network_session', 'browser_network_events', 'browser_network_detail',
    'browser_network_trace', 'browser_network_control', 'browser_network_evidence',
    'browser_network_subscribe',
    'browser_dynamic_session', 'browser_motion_observe', 'browser_motion_analyze',
    'browser_motion_control', 'browser_dynamic_correlate',
  ];
  record(`index.js 中可解析出 ${expectedTools.length} 个实际注册的 browser_* 工具（10 T1 + 1 P0-E + 7 T2 + 6 T3 + 7 network + 5 T4）`,
    actualTools.size === expectedTools.length && expectedTools.every((name) => actualTools.has(name))
      && [...actualTools].every((name) => expectedTools.includes(name)), [...actualTools]);

  // 2. Frontmatter.
  const raw = await readFile(SKILL_FILE, 'utf8');
  const frontmatter = parseFrontmatter(raw);
  record('SKILL.md frontmatter 可解析', Boolean(frontmatter), frontmatter ? '已解析' : '缺少 --- 包裹的 YAML frontmatter');
  if (!frontmatter) return failSummary();
  record('frontmatter.name === ui-testing', frontmatter.fields.name === 'ui-testing', frontmatter.fields.name);
  record('frontmatter.description 非空', Boolean(frontmatter.fields.description && frontmatter.fields.description.length > 20), frontmatter.fields.description);
  const describedTools = [...(frontmatter.fields.description || '').matchAll(/browser_[a-z0-9_]+/g)].map((match) => match[0]);
  record('description 至少提到 1 个真实工具名（可路由）', describedTools.length > 0 && describedTools.every((name) => actualTools.has(name)), describedTools);
  record('frontmatter.name 是合法 kebab-case', /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(frontmatter.fields.name || ''), frontmatter.fields.name);

  // 3. Referenced reference files exist.
  const body = frontmatter.body;
  const referenced = new Set();
  for (const match of body.matchAll(/`(references\/[^`\s]+?\.md)`/g)) referenced.add(match[1]);
  for (const match of body.matchAll(/(?:^|[\s(])(references\/[A-Za-z0-9_./-]+\.md)/g)) referenced.add(match[1]);
  const missingReferences = [...referenced].filter((rel) => !existsSync(join(SKILL_DIR, rel)));
  record('SKILL.md 引用的 references/*.md 全部存在', missingReferences.length === 0, { referenced: [...referenced], missing: missingReferences });

  // 4. Tool names in SKILL.md are all real (no invented/Playwright names).
  const mentionedTools = new Set([...body.matchAll(/browser_[a-z0-9_]+/g)].map((match) => match[0]));
  const inventedTools = [...mentionedTools].filter((name) => !actualTools.has(name));
  record(`SKILL.md 中出现的每个 browser_* 工具名都是 index.js 实际注册的 ${expectedTools.length} 个之一`, inventedTools.length === 0, { mentioned: [...mentionedTools], invented: inventedTools });

  // 5. Contract keywords that must stay documented in SKILL.md.
  record('Skill 明确记录错误码、lease、截图回退契约', ['BrowserError', 'BUSY', 'browser_capabilities', 'base64-fallback'].every((term) => raw.includes(term)), '缺少 M0–M2 契约关键词');

  // 6. Manifest.
  record('manifests/declared-capabilities.json 存在', existsSync(MANIFEST_FILE), relative(REPO_ROOT, MANIFEST_FILE));
  if (existsSync(MANIFEST_FILE)) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(MANIFEST_FILE, 'utf8'));
    } catch (error) {
      record('declared-capabilities.json 是合法 JSON', false, String(error.message || error));
      return failSummary();
    }
    record('declared-capabilities.json 是合法 JSON', true);
    record('manifest.platform === web', String(manifest.platform).toLowerCase() === 'web', manifest.platform);
    const tier = String(manifest.tier || '').toUpperCase();
    record('manifest.tier 已声明 T4（T1+T2+T3+T4；T2/T3/T4 均已实现）',
      tier === 'T1+T2+T3+T4', manifest.tier);
    record('manifest.notice 非空（说明工具注册表才是权威）', typeof manifest.notice === 'string' && manifest.notice.length > 10, manifest.notice);
    record('manifest 所有 operation 使用已知状态且无 planned', Array.isArray(manifest.operations) && manifest.operations.every((op) => ALLOWED_STATUSES.has(op.status)), manifest.operations);
    const discovery = manifest.operations?.find((op) => op.id === 'web.t1.capability-discovery');
    record('manifest 能力发现声明 browser_capabilities', discovery?.tool === 'browser_capabilities' && discovery.status !== 'unsupported', discovery);
    record('manifest 的 unsupported_tiers 为空（T3/T4 均已实现并声明，未实现项另在 evidence 逐条记 NOT_RUN）',
      Array.isArray(manifest.unsupported_tiers) && manifest.unsupported_tiers.length === 0 && tier.includes('T3') && tier.includes('T4'),
      { tier: manifest.tier, unsupported_tiers: manifest.unsupported_tiers });
    // T2 half of the manifest: only enforced once the skill owner flips tier to T1+T2 (contract
    // §8/§9.38). Never faked here: until then it is reported as INFO, not PASS.
    // The seven tool projections (web.t2.snapshot … web.t2.wait_for) plus the aggregate
    // web.t2.structured-dom declaration; only the tool projections must number exactly 7.
    const t2Ops = (manifest.operations || []).filter((op) => String(op.id || '').startsWith('web.t2.'));
    const t2ToolOps = t2Ops.filter((op) => typeof op.tool === 'string' && op.tool.length > 0);
    const manifestDeclaresT2 = tier.includes('T2');
    record('manifest 声明 T2（tier 含 T2，含 7 项 web.t2 工具操作）',
      manifestDeclaresT2 && t2ToolOps.length === 7
        && t2Ops.every((op) => op.status !== 'unsupported'),
      { tier: manifest.tier, unsupported_tiers: manifest.unsupported_tiers, t2ToolOperations: t2ToolOps.map((op) => `${op.id}:${op.tool}:${op.status}`) },
      { optional: true });
    // T3 half: six tool projections plus the web.t3.static-vision aggregate, declared implemented
    // (evidence pending acceptance — Lead flips them to verified after the real suite).
    const t3Ops = (manifest.operations || []).filter((op) => String(op.id || '').startsWith('web.t3.'));
    const t3ToolOps = t3Ops.filter((op) => typeof op.tool === 'string' && op.tool.length > 0);
    const t3Aggregate = t3Ops.find((op) => op.id === 'web.t3.static-vision');
    record('manifest 声明 T3（6 项 web.t3 工具操作 + web.t3.static-vision 聚合，状态非 unsupported）',
      tier.includes('T3') && t3ToolOps.length === 6 && Boolean(t3Aggregate)
        && t3Ops.every((op) => op.status !== 'unsupported'),
      { tier: manifest.tier, t3ToolOperations: t3ToolOps.map((op) => `${op.id}:${op.tool}:${op.status}`), aggregate: t3Aggregate?.status });
    // network P0 half: seven web.network.* tool projections + the web.network.p0 aggregate. Reported
    // as INFO until the skill owner flips tier to T1+T2+T3 and declares the operations (task-5);
    // never faked here.
    const netOps = (manifest.operations || []).filter((op) => String(op.id || '').startsWith('web.network.'));
    const netToolOps = netOps.filter((op) => typeof op.tool === 'string' && op.tool.length > 0);
    const netAggregate = netOps.find((op) => op.id === 'web.network.p0');
    record('manifest 声明 network P0（7 项 web.network 工具操作 + web.network.p0 聚合，状态非 unsupported，不得写 verified 以外的越权断言）',
      netToolOps.length === 7 && Boolean(netAggregate) && netOps.every((op) => op.status !== 'unsupported')
        && netOps.every((op) => ALLOWED_STATUSES.has(op.status)),
      { tier: manifest.tier, networkToolOperations: netToolOps.map((op) => `${op.id}:${op.tool}:${op.status}`), aggregate: netAggregate?.status },
      { optional: true });
    // Shared viewport half: the 10th T1 tool projection `web.t1.viewport` -> browser_viewport, plus
    // the viewport limits block. Required (not optional): the tool surface cannot silently drop it.
    const viewportOp = (manifest.operations || []).find((op) => op.id === 'web.t1.viewport');
    const legacyViewportOp = (manifest.operations || []).find((op) => op.id === 'web.t1.viewport-control');
    record('manifest 声明 web.t1.viewport -> browser_viewport（非 unsupported，且旧的 viewport-control 占位已移除）',
      Boolean(viewportOp) && viewportOp.tool === 'browser_viewport' && viewportOp.status !== 'unsupported'
        && ALLOWED_STATUSES.has(viewportOp.status) && !legacyViewportOp,
      { viewport: viewportOp && `${viewportOp.id}:${viewportOp.tool}:${viewportOp.status}`, legacy: legacyViewportOp?.id });
    record('manifest 报告 limits.viewport（宽高 200–4096、滚动上限、比例 0.1–2、dsf=1）与 capture 默认比例来源 view.scale',
      Array.isArray(manifest.limits?.viewport?.width) && manifest.limits.viewport.width[1] === 4096
        && Array.isArray(manifest.limits?.viewport?.scale) && manifest.limits.viewport.scale[0] === 0.1 && manifest.limits.viewport.scale[1] === 2
        && manifest.limits?.viewport?.deviceScaleFactor === 1
        && manifest.limits?.capture?.defaultScaleSource === 'view.scale'
        && Array.isArray(manifest.limits?.capture?.scaleRange) && manifest.limits.capture.scaleRange[0] === 0.1
        && manifest.limits.capture.scaleRange[1] === 4,
      { viewport: manifest.limits?.viewport, capture: manifest.limits?.capture });
  }

  // 7. Verdict-gate references exist on disk (task-1 P0/P1/P2 deliverables).
  const missingGateRefs = GATE_REFS.filter((name) => !existsSync(join(SKILL_DIR, 'references', 'core', name)));
  record('判定门禁 references/core 下 8 个文件全部存在', missingGateRefs.length === 0,
    missingGateRefs.map((name) => `references/core/${name}`));

  // 8. ... and each one is linked one-by-one from the entry skill (on-demand loading, no copy-paste body).
  const unlinkedGateRefs = GATE_REFS.filter((name) => !body.includes(`references/core/${name}`));
  record('SKILL.md 逐一链接全部 8 个判定门禁 references（按需参考，不复制正文）', unlinkedGateRefs.length === 0,
    unlinkedGateRefs.map((name) => `references/core/${name}`));

  // 9. The gate vocabulary is actually carried by the entry skill + gate refs.
  const gateCorpus = [raw, ...GATE_REFS.map((name) => {
    const file = join(SKILL_DIR, 'references', 'core', name);
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  })].join('\n');
  const missingKeywords = GATE_KEYWORDS.filter((entry) => !entry.any.some((term) => gateCorpus.includes(term)));
  record('判定门禁关键词齐全（expected_contract / counterexamples / 页面身份 / coverage / INSUFFICIENT_TEMPORAL_RESOLUTION）',
    missingKeywords.length === 0, missingKeywords.map((entry) => entry.label));

  // 10. No V2 target-specific answer leaks into the shipped skill (precise denylist, see DENY_PATTERNS).
  const denyHits = [];
  for await (const file of walkMarkdown(SKILL_DIR)) {
    const text = await readFile(file, 'utf8');
    text.split(/\r?\n/u).forEach((line, index) => {
      for (const { pattern, label } of DENY_PATTERNS) {
        if (!pattern.test(line)) continue;
        denyHits.push({ file: relative(REPO_ROOT, file), line: index + 1, label, excerpt: line.trim().slice(0, 120) });
      }
    });
  }
  record('Skill 目录无 V2 靶机专属答案泄漏（denylist：优惠码/动画名/靶机名/缺陷编号/面板读数/结论式答案）',
    denyHits.length === 0, denyHits.slice(0, 10));

  // 11. Entry line guard: the on-demand split only works while SKILL.md stays small.
  const entryLines = raw.replace(/\r?\n$/u, '').split(/\r?\n/u).length;
  record(`SKILL.md 入口行数 ≤ ${ENTRY_MAX_LINES}（低 Token 加载；当前 ${entryLines} 行）`,
    entryLines <= ENTRY_MAX_LINES, { lines: entryLines, max: ENTRY_MAX_LINES });

  return failSummary();
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error('[FAIL] check-skill 执行异常:', error);
  code = 1;
}
process.exitCode = code;
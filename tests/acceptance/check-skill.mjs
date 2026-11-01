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
 *   - knowledge/web/t1-capability-ledger.md exists, uses only known status values, and does not
 *     claim the unsupported http-request capability as available;
 *   - the T2 (docs/t2-structured-gui.md) surface is consistent: index.js registers 16 tools
 *     (9 T1 + 7 T2), a T2 ledger exists, and the manifest declares T2 as supported while T3/T4
 *     stay unsupported. The manifest/ladger half is *optional* until the skill owner lands the
 *     T1+T2 manifest and t2-capability-ledger.md; until then it is reported as INFO, never faked.
 *
 * SKIP (exit 0) when skills/ does not exist yet (task-1 not started / not merged).
 * Exit codes: 0 pass or skip, 1 structural failure.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const SKILLS_ROOT = join(REPO_ROOT, 'skills');
const SKILL_DIR = join(SKILLS_ROOT, 'ui-testing');
const SKILL_FILE = join(SKILL_DIR, 'SKILL.md');
const LEDGER_FILE = join(SKILL_DIR, 'knowledge', 'web', 't1-capability-ledger.md');
const MANIFEST_FILE = join(SKILL_DIR, 'manifests', 'declared-capabilities.json');
const INDEX_FILE = join(REPO_ROOT, 'index.js');

const ALLOWED_STATUSES = new Set(['implemented-not-verified', 'verified', 'partial', 'unsupported']);

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
  // 16 = 9 T1 (docs/runtime-t1.md) + 7 T2 (docs/t2-structured-gui.md §2.2).
  const expectedTools = [
    'browser_navigate', 'browser_eval', 'browser_screenshot', 'browser_input', 'browser_network',
    'browser_computed_style', 'browser_http_request', 'browser_state', 'browser_capabilities',
    'browser_snapshot', 'browser_click', 'browser_type', 'browser_scroll', 'browser_fill_form',
    'browser_node_state', 'browser_wait_for',
  ];
  record('index.js 中可解析出 16 个实际注册的 browser_* 工具（9 T1 + 7 T2）',
    actualTools.size === 16 && expectedTools.every((name) => actualTools.has(name)), [...actualTools]);

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
  record('SKILL.md 中出现的每个 browser_* 工具名都是 index.js 实际注册的 16 个之一', inventedTools.length === 0, { mentioned: [...mentionedTools], invented: inventedTools });

  // 5. Ledger.
  record('knowledge/web/t1-capability-ledger.md 存在', existsSync(LEDGER_FILE), relative(REPO_ROOT, LEDGER_FILE));
  if (existsSync(LEDGER_FILE)) {
    const ledger = await readFile(LEDGER_FILE, 'utf8');
    record('台账非空（>= 200 字符）', ledger.length >= 200, { length: ledger.length });
    const statuses = [...ledger.matchAll(/(?:status|状态)\s*[:：]\s*`?([a-z][a-z-]*)`?/gi)].map((match) => match[1].toLowerCase());
    const unknownStatuses = statuses.filter((status) => !ALLOWED_STATUSES.has(status));
    record('台账状态值只使用 implemented-not-verified / verified / partial / unsupported', unknownStatuses.length === 0, { statuses: [...new Set(statuses)], unknown: [...new Set(unknownStatuses)] });
    record('台账不把模板的 planned 状态当作真实状态', !/\bplanned\b/i.test(ledger), '包含 planned');
    const httpLine = ledger.split(/\r?\n/).find((line) => /http-request/i.test(line));
    record('台账把 http-request 标为 implemented-not-verified/verified（不再是 unsupported）',
      Boolean(httpLine) && /implemented-not-verified|verified|partial/i.test(httpLine) && !/unsupported|not implemented|不支持/i.test(httpLine),
      httpLine || '未提及 http-request');
    const discoveryLine = ledger.split(/\r?\n/).find((line) => /web\.t1\.capability-discovery/.test(line));
    record('台账能力发现对应 browser_capabilities 且标明实现状态', Boolean(discoveryLine) && /browser_capabilities/.test(discoveryLine) && /implemented-not-verified|verified|partial/.test(discoveryLine), discoveryLine);
    record('Skill 明确记录错误码、lease、截图回退契约', ['BrowserError', 'BUSY', 'browser_capabilities', 'base64-fallback'].every((term) => raw.includes(term)), '缺少 M0–M2 契约关键词');
  }

  const T2_LEDGER_FILE = join(SKILL_DIR, 'knowledge', 'web', 't2-capability-ledger.md');
  record('knowledge/web/t2-capability-ledger.md 存在（T2 台账）', existsSync(T2_LEDGER_FILE), relative(REPO_ROOT, T2_LEDGER_FILE), { optional: true });

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
    record('manifest.tier 是 T1 或 T1+T2（T2 已实现）', tier === 'T1' || tier === 'T1+T2', manifest.tier);
    record('manifest.notice 非空（说明工具注册表才是权威）', typeof manifest.notice === 'string' && manifest.notice.length > 10, manifest.notice);
    record('manifest 所有 operation 使用已知状态且无 planned', Array.isArray(manifest.operations) && manifest.operations.every((op) => ALLOWED_STATUSES.has(op.status)), manifest.operations);
    const discovery = manifest.operations?.find((op) => op.id === 'web.t1.capability-discovery');
    record('manifest 能力发现声明 browser_capabilities', discovery?.tool === 'browser_capabilities' && discovery.status !== 'unsupported', discovery);
    record('manifest 不把 T3/T4 声明为可用', ['T3', 'T4'].every((item) => manifest.unsupported_tiers?.includes(item)), manifest.unsupported_tiers);
    // T2 half of the manifest: only enforced once the skill owner flips tier to T1+T2 (contract
    // §8/§9.38). Never faked here: until then it is reported as INFO, not PASS.
    // The seven tool projections (web.t2.snapshot … web.t2.wait_for) plus the aggregate
    // web.t2.structured-dom declaration; only the tool projections must number exactly 7.
    const t2Ops = (manifest.operations || []).filter((op) => String(op.id || '').startsWith('web.t2.'));
    const t2ToolOps = t2Ops.filter((op) => typeof op.tool === 'string' && op.tool.length > 0);
    const manifestDeclaresT2 = tier.includes('T2');
    record('manifest 声明 T2（tier=T1+T2，unsupported_tiers 恰为 T3/T4，含 7 项 web.t2 工具操作）',
      manifestDeclaresT2 && t2ToolOps.length === 7
        && JSON.stringify([...(manifest.unsupported_tiers || [])].sort()) === JSON.stringify(['T3', 'T4'])
        && t2Ops.every((op) => op.status !== 'unsupported'),
      { tier: manifest.tier, unsupported_tiers: manifest.unsupported_tiers, t2ToolOperations: t2ToolOps.map((op) => `${op.id}:${op.tool}:${op.status}`) },
      { optional: true });
  }

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
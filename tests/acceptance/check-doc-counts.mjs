/**
 * check-doc-counts.mjs — 文档计数一致性守卫。
 *
 * 唯一事实来源是 `index.js` 里真实注册的工具。任何文档/Skill/README/package.json 宣称的计数
 * 必须与它一致——否则"加了工具但只改一处文档"的漂移会悄悄进入发布物。
 *
 * 检查两类说法：
 *   - `N 个执行工具` / `N execution tools` / `N 个 Web 工具` / `N 个 Agent 工具` → 执行工具数
 *   - `N \`browser_*\`` / `N browser_*` → 注册总数（含 browser_tools 发现入口）
 *
 * Exit: 0 全部一致；1 有漂移。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));

/** Documents that make public count claims. */
const SOURCES = [
  'docs/tools.md',
  'docs/tool-disclosure.md',
  'docs/adapters.md',
  'docs/architecture.md',
  'docs/index.md',
  'docs/verification.md',
  'README.md',
  'README_zh.md',
  'package.json',
  'skills/ui-testing-web/SKILL.md',
  'skills/ui-testing-common/SKILL.md',
];

const EXECUTION_CLAIM = /(\d+)\s*(?:个执行工具|个 Web 工具|个 Agent 工具|个注册工具|execution tools?|agent tools?:)/g;
const TOTAL_CLAIM = /(\d+)\s*(?:个\s*)?`browser_\*`/g;

/**
 * Registered tool names, parsed from the *registration calls* rather than a fixed block shape.
 * Some tools register with `name:` as the first property, others put `description` first or use a
 * constant (the discovery entry), so the scan walks each `register({ ... })` block and takes the
 * first literal browser_* name inside it. Counting lines would silently undercount.
 */
function registeredNames() {
  const source = readFileSync(join(REPO_ROOT, 'index.js'), 'utf8');
  const names = [];
  const starts = [...source.matchAll(/^  register\(\{/gm)].map((match) => match.index);
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index];
    const to = index + 1 < starts.length ? starts[index + 1] : source.length;
    const block = source.slice(from, to);
    const literal = block.match(/name: '(browser_[a-z_0-9]+)'/);
    if (literal !== null) { names.push(literal[1]); continue; }
    // A non-literal name (the discovery entry uses a constant): resolve the known constant.
    if (/name: DISCOVERY_TOOL/.test(block)) names.push('browser_tools');
  }
  return [...new Set(names)];
}

const names = registeredNames();
const total = names.length;
const execution = names.filter((name) => name !== 'browser_tools').length;

if (total === 0) {
  console.error('✖ 无法从 index.js 解析出注册工具（正则或结构变了）');
  process.exit(1);
}

const problems = [];
for (const source of SOURCES) {
  const path = join(REPO_ROOT, source);
  if (!existsSync(path)) continue;
  const text = readFileSync(path, 'utf8');
  for (const match of text.matchAll(EXECUTION_CLAIM)) {
    const claimed = Number(match[1]);
    if (claimed === execution || claimed === total) continue;
    problems.push({ source, claimed, expected: execution, phase: 'execution', context: match[0].trim() });
  }
  for (const match of text.matchAll(TOTAL_CLAIM)) {
    const claimed = Number(match[1]);
    if (claimed === total) continue;
    problems.push({ source, claimed, expected: total, phase: 'total', context: match[0].trim() });
  }
}

if (problems.length === 0) {
  console.log(`PASSED 文档计数一致：${execution} 个执行工具 + 1 个发现入口 = ${total}（${SOURCES.length} 个文件）`);
  process.exit(0);
}
console.error(`✖ ${problems.length} 处计数漂移（真实：${execution} 执行 / ${total} 总数）`);
for (const problem of problems) {
  console.error(`  ${problem.source}: 宣称 ${problem.claimed}，应为 ${problem.expected} —— "${problem.context}"`);
}
process.exit(1);

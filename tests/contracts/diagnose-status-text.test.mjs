/**
 * 诊断状态码的中英对照：客户端词表 ↔ 公开文档 ↔ Host 侧真正会吐出的码。
 *
 * 三件事必须同时成立，缺一就是「界面上出现了一个没人看懂的状态码」：
 *  1. `client.js` 的 `DIAG_REASON_ZH` 与 `docs/diagnose-reason-codes.md` 的表格逐条相同；
 *  2. Host 侧（诊断五阶段、就绪六轴、`core/contracts.js` 的 provider 原因）能产出的码全部有中文；
 *  3. 没有译文时**原样显示英文码**，绝不猜一个中文。
 *
 * 这是纯文本/纯函数测试：不启动浏览器、不启动 Host，直接读源码与词表。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEB_PROVIDER_REASONS } from '../../core/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

/** Host 侧可能产出诊断原因码的文件（诊断五阶段 + 就绪六轴 + provider 常量）。 */
const HOST_REASON_FILES = [
  'integration/diagnose.js',
  'integration/cross-environment.js',
  'core/readiness.js',
  'core/registry.js',
];

/**
 * reason 位置扫描会顺带扫到的**非状态码**字面量：比较运算符的取值、check id、事件类型、
 * 以及两个动态族前缀（它们由 `diagReasonZh` 按前缀兜底，不占表项）。
 */
const NOT_CODES = new Set([
  'definitions', 'expression', 'fail', 'false', 'finished', 'match', 'mismatch',
  'page', 'pass', 'pending', 'stage-', 'tool-call-', 'true',
]);

/** 从 client.js 里按大括号配对取出一个具名函数/声明的源码。 */
function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'client.js is missing function ' + name);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('unbalanced function ' + name);
}

const clientSource = read('client.js');
const tableSource = /const DIAG_REASON_ZH = \{[\s\S]*?\n    \};/.exec(clientSource);
assert.ok(tableSource, 'client.js must declare DIAG_REASON_ZH');

/** 客户端词表：Map(code → 中文)，保留源码顺序。 */
function clientTable() {
  const rows = new Map();
  for (const match of tableSource[0].matchAll(/^\s*'([a-z0-9-]+)':\s*'(.+)',$/gmu)) {
    rows.set(match[1], match[2]);
  }
  return rows;
}

/**
 * 文档里的码表：只解析 ①②③ 三节（术语表、五态表各有自己的解析器，避免互相污染）。
 */
function docTable() {
  const rows = new Map();
  const sections = read('docs/diagnose-reason-codes.md').split(/^## /mu).filter((part) => /^[①②③]/u.test(part));
  for (const section of sections) {
    for (const line of section.split('\n')) {
      const match = /^\|\s*`([a-z0-9-]+)`\s*\|\s*([^|]+?)\s*\|/u.exec(line.trim());
      if (match) rows.set(match[1], match[2]);
    }
  }
  return rows;
}

/** 文档里的术语表：`| \`run\` | 本轮 | 说明 |`。 */
function docTermTable() {
  const section = read('docs/diagnose-reason-codes.md').split(/^## /mu).find((part) => part.startsWith('术语对照'));
  assert.ok(section, '缺少「术语对照」一节');
  const rows = new Map();
  for (const line of section.split('\n')) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|/u.exec(line.trim());
    if (match) rows.set(match[1], match[2]);
  }
  return rows;
}

/** Host 侧的原因码候选：reason / blockedReason / notProbed / callReason 这些位置上的字面量。 */
function hostCandidates() {
  const found = new Map();
  for (const file of HOST_REASON_FILES) {
    for (const line of read(file).split('\n')) {
      if (!/reason|blockedReason|notProbed|callReason|\.skip\(|\.finish\(/u.test(line)) continue;
      for (const match of line.matchAll(/'([a-z][a-z0-9-]+)'/g)) {
        if (!found.has(match[1])) found.set(match[1], new Set());
        found.get(match[1]).add(file);
      }
    }
  }
  return found;
}

const stateTableSource = /const DIAG_STATE_TEXT = \{[^}]*\};/.exec(clientSource);
assert.ok(stateTableSource, 'client.js must declare DIAG_STATE_TEXT');
const termTableSource = /const DIAG_TERM_ZH = \{[\s\S]*?\n    \};/.exec(clientSource);
assert.ok(termTableSource, 'client.js must declare DIAG_TERM_ZH');

const {
  diagReasonZh, diagReasonLabel, diagStateLabel, diagTermLabel, DIAG_STATE_TEXT, DIAG_TERM_ZH,
} = new Function(
  tableSource[0] + '\n' + stateTableSource[0] + '\n' + termTableSource[0] + '\n'
  + extractFunction(clientSource, 'diagReasonZh') + '\n'
  + extractFunction(clientSource, 'diagReasonLabel') + '\n'
  + extractFunction(clientSource, 'diagStateLabel') + '\n'
  + extractFunction(clientSource, 'diagTermLabel')
  + '\nreturn { diagReasonZh, diagReasonLabel, diagStateLabel, diagTermLabel, DIAG_STATE_TEXT, DIAG_TERM_ZH };',
)();

/** 文档里的五态表：`| \`WARN\` | 警告 | … |`（大写机器码）。 */
function docStateTable() {
  const rows = new Map();
  for (const line of read('docs/diagnose-reason-codes.md').split('\n')) {
    const match = /^\|\s*`([A-Z]+)`\s*\|\s*([^|]+?)\s*\|/u.exec(line.trim());
    if (match) rows.set(match[1], match[2]);
  }
  return rows;
}

const zhOf = (table, code) => table.get(code);
const clientRows = clientTable();
const docRows = docTable();

test('客户端词表与公开文档逐条一致（码集合与中文都相同）', () => {
  const missingInDoc = [...clientRows.keys()].filter((code) => !docRows.has(code));
  const missingInClient = [...docRows.keys()].filter((code) => !clientRows.has(code));
  assert.deepEqual(missingInDoc, [], 'docs/diagnose-reason-codes.md 少了这些码');
  assert.deepEqual(missingInClient, [], 'client.js 的 DIAG_REASON_ZH 少了这些码');

  const textMismatch = [...clientRows.entries()]
    .filter(([code, zh]) => docRows.get(code) !== zh)
    .map(([code, zh]) => code + '：文档「' + docRows.get(code) + '」≠ 客户端「' + zh + '」');
  assert.deepEqual(textMismatch, [], '同一个码在文档与客户端必须用同一句中文');
});

test('词表本身是干净的：码形如机器码、没有重复、中文非空', () => {
  const bad = [...clientRows.keys()].filter((code) => !/^[a-z][a-z0-9-]*$/u.test(code));
  assert.deepEqual(bad, [], '码必须是 lowercase-kebab 机器码（英文，供 agent 解析）');
  const blank = [...clientRows.entries()].filter(([, zh]) => !zh.trim());
  assert.deepEqual(blank, [], '每个码都要有中文');
  // 中文列必须是中文（允许出现 provider、CDP 这类专有名词），不能原样是英文码本身。
  const selfTranslated = [...clientRows.entries()].filter(([code, zh]) => zh === code);
  assert.deepEqual(selfTranslated, [], '中文列不能等于码本身');
  assert.equal(docRows.size, clientRows.size, '文档表格不能有重复行');
});

test('Host 侧能产出的诊断原因码全部有中文（新码不写译文就会失败）', () => {
  const uncovered = [...hostCandidates().entries()]
    .filter(([code]) => !NOT_CODES.has(code) && !clientRows.has(code))
    .map(([code, files]) => code + ' ← ' + [...files].join(','));
  assert.deepEqual(uncovered, [], '这些码出现在 Host 的诊断路径上，但词表里没有中文');
});

test('core/contracts.js 的 WEB_PROVIDER_REASONS 每个值都有中文', () => {
  const uncovered = Object.values(WEB_PROVIDER_REASONS)
    .filter((code) => !clientRows.has(code));
  assert.deepEqual(uncovered, [], 'provider 原因常量必须同时进中英对照表');
});

test('可见文案只有中文：英文码不进括号、只留在属性里', () => {
  assert.equal(diagReasonLabel('provider-mismatch'), '实际在跑的浏览器与所选运行环境不一致');
  assert.equal(diagReasonLabel('executable-missing'), '没找到该浏览器的可执行文件');
  assert.equal(diagReasonLabel('blocked-by-provider-mismatch'), '上游运行环境不一致，这一段没执行');
  assert.equal(diagReasonZh('no-run'), '还没有诊断结果');
  for (const code of clientRows.keys()) {
    const label = diagReasonLabel(code);
    assert.equal(label, zhOf(clientRows, code), 'label must be the Chinese gloss only: ' + label);
    assert.ok(!label.includes('（' + code + '）'), 'label must not carry the english code in parentheses: ' + label);
  }
  // 英文码必须仍然可从 DOM 属性读到（agent 的通道没有被移除）
  for (const attr of ['data-uts-stage-reason', 'data-uts-overall-reason', 'data-uts-axis-reason-code', 'data-uts-event-reason']) {
    assert.ok(clientSource.includes(attr), 'agent-facing attribute removed: ' + attr);
  }
});

test('没有译文的码原样显示，绝不编造中文', () => {
  assert.equal(diagReasonZh('brand-new-code-from-the-future'), '');
  assert.equal(diagReasonLabel('brand-new-code-from-the-future'), 'brand-new-code-from-the-future');
  assert.equal(diagReasonLabel(''), '');
  // Host 已经给出中文的说明（overall PASS 的原因、六轴的 run 来源）原样透传，不加括号。
  assert.equal(diagReasonLabel('本次诊断检查通过'), '本次诊断检查通过');
  assert.equal(diagReasonLabel('来自本次诊断 run'), '来自本次诊断 run');
});

test('两个动态族按前缀兜底：tool-call-<ERROR_CODE> 与 stage-<n>', () => {
  assert.equal(diagReasonLabel('tool-call-invalid_argument'), '工具调用失败');
  assert.equal(diagReasonLabel('tool-call-tool_not_found'), '工具调用失败');
  assert.equal(diagReasonLabel('stage-4'), '该段没有给出原因');
  // 前缀族不能吞掉正常码：`tool-call-failed` 用表里那条，不是前缀兜底。
  assert.equal(diagReasonZh('tool-call-failed'), '工具调用失败');
  assert.equal(diagReasonZh('stage-timeout'), '这一段超时，没拿到结果');
});

test('五态也走同一套对照：界面只写中文，英文状态码只在属性里', () => {
  const docStates = docStateTable();
  assert.deepEqual([...docStates.keys()].sort(), Object.keys(DIAG_STATE_TEXT).sort(),
    '文档五态表与 DIAG_STATE_TEXT 必须完全一致');
  for (const [code, zh] of Object.entries(DIAG_STATE_TEXT)) {
    assert.equal(docStates.get(code), zh, code + ' 的中文与文档不一致');
    assert.equal(diagStateLabel(code), zh, '可见文案只写中文');
  }
  // 非五态值原样返回，不编造
  assert.equal(diagStateLabel('INFO'), 'INFO');
  assert.equal(diagStateLabel(''), '');
  assert.equal(diagStateLabel('warn'), '警告', '小写状态也映射到同一行');
});

test('节点悬停提示把被截断的信息都补上（名称/职责/状态/原因码/阻塞/耗时）', () => {
  const diagNodeTitle = new Function('return (' + extractFunction(clientSource, 'diagNodeTitle') + ')')();
  const node = { role: '调试后端', name: 'Chromium DevTools', sub: '检查执行后端及依赖可用性' };
  const title = diagNodeTitle(node, '警告 · 未找到可执行文件', { reason: 'executable-missing', blockedBy: null, durationMs: 12.5 }, 'finished');
  assert.equal(title, [
    '调试后端 · Chromium DevTools',
    '检查执行后端及依赖可用性',
    '状态：警告 · 未找到可执行文件',
    '原因码：executable-missing',
    '耗时 12.5ms',
  ].join('\n'), 'tooltip must carry every truncated field');
  // 跳过段：带 blockedBy，且不伪造耗时
  assert.equal(diagNodeTitle(node, '跳过 · 因阶段 3 未通过而跳过', { reason: 'blocked-by-stage-3', blockedBy: 3, durationMs: null }, 'finished'),
    ['调试后端 · Chromium DevTools', '检查执行后端及依赖可用性', '状态：跳过 · 因阶段 3 未通过而跳过', '原因码：blocked-by-stage-3', '阻塞于阶段 3'].join('\n'));
  // 运行中的段落额外说明
  assert.ok(diagNodeTitle(node, '检查中…', null, 'running').includes('本段正在检查'));
  // 没有 stage 时不能出现空行
  assert.ok(!diagNodeTitle(node, '待诊断', null, 'idle').includes('\n\n'));
});

test('节点状态区预留两行，超出才截断', () => {
  assert.ok(/\.uts-diag-node-status > span \{[^}]*-webkit-line-clamp: 2;/u.test(clientSource),
    '状态文案必须两行才截断');
  assert.ok(/\.uts-diag-node-status > span \{[^}]*min-height: 30px;/u.test(clientSource),
    '两行要占位（30px = 2 × 15px 行高），否则卡片高度会跳');
});

test('面板不再有英文装饰（右上角那几条）', () => {
  for (const decoration of ['HOST RUN · STAGED CHECKS', 'READINESS SNAPSHOT', 'HOST STAGES', 'LOGICAL LAYERS', 'THIS RUN ·']) {
    assert.ok(!clientSource.includes(decoration), '装饰未删除: ' + decoration);
  }
  assert.ok(!clientSource.includes('uts-diag-panel-note'), '未使用的装饰样式类应当删掉');
});

test('术语表：界面中文与英文底层一一对应，且与文档一致', () => {
  const required = ['run', 'Host', 'Failed to fetch', 'skip', 'PASS', 'stage-start', 'stage-end',
    'readonly-eval', 'target-list', 'snapshot', 'screenshot'];
  for (const term of required) {
    assert.ok(term in DIAG_TERM_ZH, '术语表缺少: ' + term);
  }
  const docTerms = docTermTable();
  assert.deepEqual([...docTerms.keys()].sort(), Object.keys(DIAG_TERM_ZH).sort(),
    '文档术语表与 DIAG_TERM_ZH 必须完全一致');
  for (const [term, zh] of Object.entries(DIAG_TERM_ZH)) {
    assert.equal(docTerms.get(term), zh, term + ' 的中文与文档不一致');
    assert.equal(diagTermLabel(term), zh);
    assert.ok(!/[a-z]{3,}/iu.test(zh), '中文列里不该再夹英文单词: ' + zh);
  }
  // Host 真的会吐出来的探针 id（diagnose.js 里那张清单）必须都有中文
  const probeList = /for \(const id of \[([^\]]+)\]\)/u.exec(read('integration/diagnose.js'));
  assert.ok(probeList, 'diagnose.js 里找不到探针 id 清单');
  const probeIds = [...probeList[1].matchAll(/'([a-z-]+)'/gu)].map((m) => m[1]);
  assert.ok(probeIds.length >= 6, '探针清单解析异常');
  for (const id of probeIds) {
    assert.ok(id in DIAG_TERM_ZH, '探针 id 缺中文: ' + id);
    assert.ok(!/[a-z]/u.test(DIAG_TERM_ZH[id]), '探针中文里还夹着英文: ' + DIAG_TERM_ZH[id]);
  }
  // 未知术语不猜：回落到原因码词典，再回落到原文
  assert.equal(diagTermLabel('some-new-term'), 'some-new-term');
  assert.equal(diagTermLabel('browser-not-running'), '浏览器未运行');
});

test('界面文案里不再出现这些英文词（只在属性/注释里）', () => {
  for (const term of ['stage-start', 'stage-end', 'readonly-eval', 'target-list', 'Failed to fetch']) {
    const visible = [...clientSource.matchAll(/'([^'\n]*)'/gu)]
      .map((m) => m[1])
      .filter((text) => text.includes(term))
      .filter((text) => /[\u4e00-\u9fff]/u.test(text));
    assert.deepEqual(visible, [], '可见中文文案里还夹着 ' + term + ': ' + visible.join(' | '));
  }
  // 检查项按中文渲染（只读求值：跳过），英文对留在属性里
  assert.ok(clientSource.includes("diagTermLabel(row.name) + '：' + diagTermLabel(row.status)"));
  assert.ok(clientSource.includes("'data-uts-axis-checks-en'"));
  // 诊断日志行末的英文状态徽标已去掉
  assert.ok(!clientSource.includes('uts-diag-event-axis'));
});

test('能力就绪最多三行、省略号收尾、六张卡片都按三行占位', () => {
  const checks = /\.uts-diag-axis-checks \{[^}]*\}/u.exec(clientSource);
  assert.ok(checks, '缺少 .uts-diag-axis-checks 样式');
  assert.ok(/min-height: 48px/u.test(checks[0]), '检查项区没有按三行（48px）占位');
  assert.ok(clientSource.includes('const DIAG_CHECK_LINES = 3;'), '每张卡片应固定三行');
  assert.ok(clientSource.includes("className: 'uts-diag-axis-checks-more'"), '被省略的条数没有单独的样式');
  assert.ok(clientSource.includes("}, '+' + hidden)"), '+n 文案不对');
  // 计数标签必须与描述文字不同：更小字号 + 更淡颜色
  const more = /\.uts-diag-axis-checks-more \{[^}]*\}/u.exec(clientSource);
  assert.ok(more, '缺少 .uts-diag-axis-checks-more 样式');
  assert.ok(/font-size: 9px/u.test(more[0]), '+n 字号没有小于描述文字');
  assert.ok(/color-mix\(in srgb, var\(--dsw-alias-label-tertiary\) 55%, transparent\)/u.test(more[0]), '+n 颜色没有更淡');
  // 没有检查项的卡片也要渲染这块（否则高度不齐）
  assert.ok(!clientSource.includes('axis.checks && typeof axis.checks === \'object\' && Object.keys(axis.checks).length'),
    '检查项区仍是条件渲染，五张空卡片会矮一截');
});

test('调试流程的步骤描述固定占两行（卡片高度不跳动）', () => {
  const sub = /\.uts-diag-node-sub \{[^}]*\}/u.exec(clientSource);
  assert.ok(sub, '缺少 .uts-diag-node-sub 样式');
  assert.ok(/min-height: 30px/u.test(sub[0]), '职责描述没有按两行（30px）占位');
  assert.ok(/-webkit-line-clamp: 2/u.test(sub[0]), '职责描述没有限制两行');
});

test('能力就绪的检查项一行一项（不串成「·」分隔的一句）', () => {
  const container = /\.uts-diag-axis-checks \{[^}]*\}/u.exec(clientSource);
  assert.ok(container, '缺少 .uts-diag-axis-checks 样式');
  assert.ok(!/overflow-wrap:\s*anywhere/u.test(container[0]), '检查项容器仍在任意位置断行');
  // 每项独占一行
  assert.ok(/\.uts-diag-axis-checks-item \{[^}]*display: block;/u.test(clientSource), '检查项未独占一行');
  assert.ok(/\.uts-diag-axis-checks-item \{[^}]*white-space: nowrap;/u.test(clientSource), '检查项缺少 nowrap');
  // 渲染不再拼接「 · 」分隔符
  assert.ok(clientSource.includes("className: 'uts-diag-axis-checks-item'"), '未逐项渲染');
  assert.ok(!clientSource.includes("textValue + ' · '"), '仍在用「·」拼接检查项');
  assert.ok(!clientSource.includes("shown.join(' · ') + (more > 0"), '仍在拼长串');
  // 英文原对仍留在属性里，供 agent 解析
  assert.ok(clientSource.includes("'data-uts-axis-checks-en'"));
});

test('诊断日志左侧写中文，英文 id 留在属性里', () => {
  const diagOperationLabel = new Function('return (' + extractFunction(clientSource, 'diagOperationLabel') + ')')();
  assert.equal(diagOperationLabel('run-start'), '本轮开始');
  assert.equal(diagOperationLabel('run-end'), '本轮结束');
  assert.equal(diagOperationLabel('stage-1'), '第 1 段');
  assert.equal(diagOperationLabel('stage-5'), '第 5 段');
  assert.equal(diagOperationLabel('something-else'), 'something-else', '未知操作原样显示，不编造');
  // 属性里的英文 id 不能被改掉：agent 与排障按它解析
  assert.ok(clientSource.includes("'data-uts-event-operation': row.operation"));
});

test('四个板块标题就是这四个（旧名称不得复活）', () => {
  const titles = [...clientSource.matchAll(/className: 'uts-diag-panel-title' \}, '([^']+)'\)/gu)].map((m) => m[1]);
  assert.deepEqual(titles, ['调试流程', '各模块诊断状态', '诊断日志', '步骤职责']);
  for (const stale of ['六轴诊断状态', '诊断事件流', '链路职责', '实时调试拓扑', '调试节点职责']) {
    assert.ok(!titles.includes(stale), '旧板块标题未改名: ' + stale);
  }
  // 步骤编号也是中文「步骤 1」而不是「调试节点 01」
  assert.ok(!clientSource.includes("'调试节点 0'"), '节点角标仍是旧文案');
});

test('弱断言兜底：至少覆盖用户点出的四个码', () => {
  for (const code of ['provider-mismatch', 'executable-missing', 'blocked-by-provider-mismatch', 'no-run']) {
    assert.ok(clientRows.has(code), 'missing: ' + code);
    assert.ok(docRows.has(code), 'missing in docs: ' + code);
  }
});

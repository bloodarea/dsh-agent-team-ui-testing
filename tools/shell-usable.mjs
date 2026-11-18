/**
 * 一次性重构：让「公共区」在没有页面的目标环境下也能用。
 *
 * 1) ENV_VIEWS 上移，使 annotReady / 标注映射能判断“当前环境有没有视图”；
 * 2) 抽出 shellAnnotLayer()（标注图层 SVG），web 与空白画布共用同一份；
 * 3) 无视图环境：标注可用（annotReady=true）+ 合成映射（annotBlankMap）+ 空白画布；
 * 4) 禁用态外壳换成真实公共控件（标注 / 尺寸 / 更多）。
 *
 * 纯文本锚点替换，逐步断言；失败即中止不写文件。
 */
import fs from 'node:fs';

const FILE = 'client.js';
const src = fs.readFileSync(FILE, 'utf8');
const lines = src.split('\n');
const idx = (re, label, from = 0) => {
  const hits = [];
  for (let i = from; i < lines.length; i += 1) if (re.test(lines[i])) hits.push(i);
  if (hits.length !== 1) throw new Error(`[${label}] 期望 1 处，实际 ${hits.length} 处`);
  return hits[0];
};

/* ---------- 1. ENV_VIEWS 上移 ---------- */
const envViewsLine = idx(/^\s+const ENV_VIEWS = \{ web: webViewBody \};$/, 'ENV_VIEWS');
const annotReadyLine = idx(/^\s+const annotReady = viewSync && canvasOn;$/, 'annotReady');
if (envViewsLine < annotReadyLine) throw new Error('[顺序] ENV_VIEWS 已在 annotReady 之前，无需上移');

/* ---------- 2. 标注 SVG 块 ---------- */
const svgStart = (() => {
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s+h\('svg', \{$/.test(lines[i]) && (lines[i + 1] || '').includes("className: 'utb-annot-layer'")) hits.push(i);
  }
  if (hits.length !== 1) throw new Error(`[annot-svg] 期望 1 处，实际 ${hits.length}`);
  return hits[0];
})();
const svgEnd = idx(/h\('g', \{ key: 'annot-draft', 'data-utb-annot-state': 'draft', ref: annotDraftRef \}\)\),$/, 'annot-svg-end');
if (svgEnd < svgStart) throw new Error('[annot-svg] 结束行在开始行之前');

const svgBlock = lines.slice(svgStart, svgEnd + 1);
const svgBody = ['        return ' + svgBlock[0].trim(), ...svgBlock.slice(1)];
svgBody[svgBody.length - 1] = svgBody[svgBody.length - 1]; // 原样保留

/* ---------- 3. 三个外壳函数替换 ---------- */
const barStart = idx(/^\s+\/\*\* 公共区：无视图环境下的工具栏外壳（禁用态，只表达结构，不派发任何操作）。 \*\/$/, 'bar-comment');
const rowsEnd = (() => {
  const start = idx(/^\s+function shellNoViewRows\(\) \{$/, 'norows-fn');
  for (let i = start; i < lines.length; i += 1) if (/^\s+\}$/.test(lines[i])) return i;
  throw new Error('[norows-fn] 未找到结束行');
})();

const shellReplacement = [
  '      /** 公共区：无视图环境的工具栏。只保留跨环境可用的动作（标注 / 尺寸 / 更多）。 */',
  '      function shellBarPublic() {',
  "        return h('div', { className: 'utb-bar', 'data-utb-shell': 'public' },",
  "          button('标注', h(IconAnnot, null), toggleAnnotMode, !annotReady || sizing || pickOn, {",
  "            'aria-pressed': annotOn,",
  "            'aria-controls': annotPanelId,",
  "            'data-utb-annot-entry': annotOn ? 'on' : annotReady ? 'ready' : 'unsupported',",
  '          }),',
  "          button('尺寸调整', h(IconSize, null), toggleSizing, annotOn || pickOn, { 'aria-pressed': sizing }),",
  "          h('span', { className: 'utb-gap' }),",
  '          h(\'div\', { className: \'utb-more\' },',
  "            button('更多', h(IconMore, null), () => setMenu((v) => !v), false, { 'aria-expanded': menu, 'aria-haspopup': 'menu' }),",
  "            menu && h('div', { className: 'utb-pop', role: 'menu' },",
  "              h('button', { type: 'button', className: 'utb-menu-item', role: 'menuitem', onClick: () => setMenu(false) },",
  "                '该环境适配器未接入，暂无更多操作'))));",
  '      }',
  '',
  '      /** 公共区：无视图环境的预览区——空白画布，标注直接画在上面。 */',
  '      function shellBlankStage() {',
  '        const bw = Math.max(1, Number(width) || 1024);',
  '        const bh = Math.max(1, Number(height) || 768);',
  "        return h('div', { className: 'utb-stage', 'data-utb-shell': 'blank' },",
  "          h('div', {",
  "            className: 'utb-box',",
  "            'data-utb-shell': 'blank-box',",
  "            'data-utb-annot': annotOn ? 'on' : 'off',",
  '            style: { width: bw * scale, height: bh * scale, position: \'relative\' },',
  '          },',
  '            annotOn',
  '              ? shellAnnotLayer()',
  "              : h('div', { className: 'utb-blank-hint' },",
  "                '该环境暂无画面。点上方「标注」即可在这块空白画布上画，形状按画布坐标为所有环境共用。')));",
  '      }',
  '',
  '      /** 公共区：无视图环境的行集合（工具栏 / 标注栏 / 空白画布）；状态栏由根返回统一渲染。 */',
  '      function shellNoViewRows() {',
  '        return [',
  '          shellBarPublic(),',
  '          shellAnnotBar(),',
  '          shellBlankStage(),',
  '        ];',
  '      }',
];

/* ---------- 4. 组装 ---------- */
const cssSwap = [
  '/* 公共区：无视图环境的空白画布（可画标注）。 */',
  '.utb-box[data-utb-shell="blank-box"] { display: grid; place-items: center; background: var(--dsw-alias-bg-layer-2); }',
  '.utb-blank-hint { max-width: 340px; padding: 16px; text-align: center; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }',
];

const envCommentStart = (() => {
  let i = envViewsLine - 1;
  while (i >= 0 && !lines[i].includes('/**')) i -= 1;
  if (i < 0) throw new Error('[ENV_VIEWS 注释] 未找到');
  return i;
})();

const out = [];
for (let i = 0; i < lines.length; i += 1) {
  if (i >= envCommentStart && i <= envViewsLine) continue; // 整块上移到 annotReady 之前

  if (i === annotReadyLine - 1) {
    out.push(...lines.slice(envCommentStart, envViewsLine + 1).map((l) => l));
    out.push('      const envHasView = typeof ENV_VIEWS[env] === \'function\';');
    out.push('      const envHasView = typeof ENV_VIEWS[env] === \'function\';');
  }
  if (i === annotReadyLine) { out.push('      const annotReady = envHasView ? (viewSync && canvasOn) : true;'); continue; }
  if (i === annotMapLine()) {
    out.push('      const annotMapNow = canvasOn && shot ? annotMap() : (envHasView ? null : annotBlankMap());');
    continue;
  }
  if (i === svgStart) {
    out.push('                shellAnnotLayer(),');
    i = svgEnd;
    continue;
  }
  if (i === barStart) {
    out.push(...shellReplacement);
    i = rowsEnd;
    continue;
  }
  if (lines[i].includes('.utb-bar[data-utb-shell="disabled"]') || lines[i].includes('.utb-annot-bar[data-utb-shell="disabled"]')) continue;
  if (lines[i].includes('.utb-stage[data-utb-shell="placeholder"]')) { out.push(...cssSwap); continue; }
  out.push(lines[i]);
}

function annotMapLine() {
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) if (/^\s+const annotMapNow = canvasOn && shot \? annotMap\(\) : null;$/.test(lines[i])) hits.push(i);
  if (hits.length !== 1) throw new Error(`[annotMapNow] 期望 1 处，实际 ${hits.length}`);
  return hits[0];
}

/* 函数声明：shellAnnotLayer + annotBlankMap 插到 shellStatusBar 之前 */
const statusFnLine = (() => {
  const hits = [];
  out.forEach((l, i) => { if (/^\s+function shellStatusBar\(\) \{$/.test(l)) hits.push(i); });
  if (hits.length !== 1) throw new Error('[shellStatusBar] 未找到');
  return hits[0];
})();
const fnBlock = [
  '      /** 公共区：标注图层（跨环境共用）。无页面环境下由合成映射覆盖空白画布。 */',
  '      function shellAnnotLayer() {',
  ...svgBody,
  '      }',
  '',
  '      /** 公共区：无页面环境的合成标注映射——画布即视图尺寸，painted 覆盖整块。 */',
  '      function annotBlankMap() {',
  '        const bw = Math.max(1, Number(width) || 1024);',
  '        const bh = Math.max(1, Number(height) || 768);',
  '        const rect = { left: 0, top: 0, width: bw, height: bh };',
  '        return { cx: 0, cy: 0, w: bw, h: bh, painted: rect, boxRect: rect };',
  '      }',
  '',
];
out.splice(statusFnLine, 0, ...fnBlock);

const next = out.join('\n');
const checks = [
  ['标注图层已抽出', (next.match(/function shellAnnotLayer\(\)/g) || []).length === 1],
  ['图层只被调用一次', (next.match(/^ {16}shellAnnotLayer\(\),$/gm) || []).length === 1],
  ['ENV_VIEWS 已上移', next.indexOf("const ENV_VIEWS = { web: webViewBody };") < next.indexOf('const annotReady =')],
  ['annotReady 已解耦', next.includes("const annotReady = envHasView ? (viewSync && canvasOn) : true;")],
  ['合成映射已接入', next.includes('envHasView ? null : annotBlankMap()')],
  ['禁用态外壳已移除', !next.includes('shellBarDisabled()') && !next.includes('shellAnnotBarDisabled()')],
  ['空白画布已渲染', next.includes('shellBlankStage()')],
  ['花括号配平', (next.match(/\{/g) || []).length === (next.match(/\}/g) || []).length],
];
for (const [name, ok] of checks) {
  if (!ok) throw new Error(`[断言失败] ${name}`);
  console.log(`  ok  ${name}`);
}
fs.writeFileSync(FILE, next);
console.log(`\n写入完成：${lines.length} → ${next.split('\n').length} 行`);

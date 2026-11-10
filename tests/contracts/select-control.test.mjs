/**
 * 原生 `<select>` 的面板侧浮层：Host 半边（纯函数 + 页面函数本体）。
 *
 * 这些用例锁住四件事（缺任何一条，浮层就会退回"点不开/写不进/写坏"）：
 *   ① 选项投影有上界并且**如实**报 `truncated`，非 select 一律 `null`（`/element` 形状不变的前提）；
 *   ② 只支持单选、非 multiple、非 size>1、有选项的形态，其余给稳定 reason 交给键盘兜底；
 *   ③ 写回请求的校验与页面函数：native setter（React 受控 select 才会看到变化）+ `input`/`change`
 *      顺序固定，且每个拒绝分支都有稳定 reason；
 *   ④ 拒绝一律是 `INVALID_ARGUMENT`（面板可见的输入答案），不会被当成 INTERNAL/页面错误。
 *
 * 页面函数在这里用假的 `document`/`HTMLSelectElement`/`Event` 真跑一遍：这不是 mock 掉被测逻辑，
 * 而是把"浏览器里会发生什么"落到可断言的观察面（setter 来自原型、事件顺序、value 结果）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SELECT_OPTION_LIMIT,
  SELECT_UNSUPPORTED_HINT,
  SELECT_UNSUPPORTED_REASON,
  classifySelectWrite,
  normalizeSelectProjection,
  normalizeSelectWriteRequest,
  selectProbeDeclaration,
  selectShapeSupport,
  selectWriteExpression,
} from '../../select-control.js';

/* ------------------------------------------------------------------------------------------------
 * ① 选项投影
 * ---------------------------------------------------------------------------------------------- */

const rawProjection = (over) => Object.assign({
  multiple: false,
  size: 0,
  value: 'b',
  options: [
    { value: 'a', label: 'Alpha', disabled: false, selected: false },
    { value: 'b', label: 'Beta', disabled: false, selected: true },
  ],
  truncated: false,
}, over);

test('投影：单选 select 的字段被逐个归一化', () => {
  const projection = normalizeSelectProjection(rawProjection({}));
  assert.deepEqual(projection, {
    multiple: false,
    size: 0,
    value: 'b',
    options: [
      { value: 'a', label: 'Alpha', disabled: false, selected: false },
      { value: 'b', label: 'Beta', disabled: false, selected: true },
    ],
    truncated: false,
  });
});

test('投影：非对象 / 缺 options 一律 null（/element 返回形状不许长出 select 字段）', () => {
  for (const value of [null, undefined, 42, 'select', [], {}, { options: null }, { options: 'x' }]) {
    assert.equal(normalizeSelectProjection(value), null, `应为 null: ${JSON.stringify(value)}`);
  }
});

test('投影：最多 200 项，超出必须 self-report truncated', () => {
  const many = Array.from({ length: SELECT_OPTION_LIMIT + 25 }, (ignored, index) => ({
    value: `v${index}`, label: `L${index}`, disabled: false, selected: index === 0,
  }));
  const projection = normalizeSelectProjection(rawProjection({ options: many }));
  assert.equal(projection.options.length, SELECT_OPTION_LIMIT, `options 必须被截到 ${SELECT_OPTION_LIMIT}`);
  assert.equal(projection.truncated, true, '截断必须自报，不能静默丢');

  const exact = normalizeSelectProjection(rawProjection({ options: many.slice(0, SELECT_OPTION_LIMIT) }));
  assert.equal(exact.options.length, SELECT_OPTION_LIMIT);
  assert.equal(exact.truncated, false, '正好 200 项不算截断');
});

test('投影：页面给的脏字段（非字符串 / 空洞 / 负数 size）不炸且在界内', () => {
  const projection = normalizeSelectProjection({
    multiple: 'yes',
    size: -3,
    value: 7,
    options: [null, { value: 1, label: undefined }, { value: 'x', label: 'X', disabled: 'true', selected: 1 }],
  });
  assert.equal(projection.multiple, false, '只有严格的 true 才算 multiple');
  assert.equal(projection.size, 0, '负 size 归一成 0（未设置）');
  assert.equal(projection.value, '7');
  assert.deepEqual(projection.options[0], { value: '', label: '', disabled: false, selected: false });
  assert.deepEqual(projection.options[1], { value: '1', label: '', disabled: false, selected: false });
  assert.equal(projection.options[2].disabled, false, '非 true 的 disabled 不算禁用');
  assert.equal(projection.options[2].selected, false);
});

/* ------------------------------------------------------------------------------------------------
 * ② 形态支持
 * ---------------------------------------------------------------------------------------------- */

test('形态：单选普通 select 支持；multiple / size>1 / 空选项 各自给稳定 reason', () => {
  assert.deepEqual(selectShapeSupport(normalizeSelectProjection(rawProjection({}))), { supported: true, reason: null });
  assert.equal(selectShapeSupport(normalizeSelectProjection(rawProjection({ size: 1 }))).supported, true, 'size=1 仍是单行');

  const multiple = selectShapeSupport(normalizeSelectProjection(rawProjection({ multiple: true })));
  assert.deepEqual(multiple, { supported: false, reason: SELECT_UNSUPPORTED_REASON.MULTIPLE });

  const sized = selectShapeSupport(normalizeSelectProjection(rawProjection({ size: 5 })));
  assert.deepEqual(sized, { supported: false, reason: SELECT_UNSUPPORTED_REASON.SIZE });

  const empty = selectShapeSupport(normalizeSelectProjection(rawProjection({ options: [] })));
  assert.deepEqual(empty, { supported: false, reason: SELECT_UNSUPPORTED_REASON.EMPTY });

  assert.deepEqual(selectShapeSupport(null), { supported: false, reason: SELECT_UNSUPPORTED_REASON.DETACHED });
});

test('形态：不支持时的提示文案是面板里那一行（键盘兜底）', () => {
  assert.equal(SELECT_UNSUPPORTED_HINT, '该下拉不支持浮层，请用键盘 ↑↓ + Enter');
});

/* ------------------------------------------------------------------------------------------------
 * ③④ 写回请求校验
 * ---------------------------------------------------------------------------------------------- */

test('写回请求：value 必填且必须是字符串', () => {
  for (const body of [null, undefined, 'x', [], {}, { value: 1 }, { value: null }]) {
    const result = normalizeSelectWriteRequest(body);
    assert.equal(result.ok, false, `应拒绝: ${JSON.stringify(body)}`);
    assert.equal(result.code, 'INVALID_ARGUMENT');
  }
  assert.equal(normalizeSelectWriteRequest({ value: 1 }).details.field, 'value');
  assert.deepEqual(normalizeSelectWriteRequest({ value: '' }), { ok: true, value: '', selector: null, optionIndex: null, target: null }, '空串是合法的 option value');
});

test('写回请求：selector 可选，出现时必须是非空字符串且不超长', () => {
  assert.deepEqual(normalizeSelectWriteRequest({ value: 'x', selector: '  #editSpace  ' }), { ok: true, value: 'x', selector: '#editSpace', optionIndex: null, target: null });
  assert.equal(normalizeSelectWriteRequest({ value: 'x', selector: '   ' }).ok, false);
  assert.equal(normalizeSelectWriteRequest({ value: 'x', selector: 7 }).ok, false);
  assert.equal(normalizeSelectWriteRequest({ value: 'x', selector: 'a'.repeat(4097) }).ok, false);
});

test('写回表达式：值与选择器按 JSON 字面量嵌入，没有 selector 时用 null', () => {
  const hostile = '"><script>alert(1)</script>';
  const expression = selectWriteExpression({ value: hostile, selector: '#a"b\'c' });
  assert.ok(expression.includes(JSON.stringify(hostile)), '值必须以 JSON.stringify 的形式嵌入');
  assert.ok(expression.includes(JSON.stringify('#a"b\'c')), '选择器同理');
  const withoutSelector = selectWriteExpression({ value: 'world' });
  assert.ok(withoutSelector.includes('const selector = null;'), '没有 selector 时必须是 null（用当前聚焦元素）');
});

test('写回表达式：恶意值只作为一个字符串进入页面，不会变成代码（真跑一遍）', () => {
  const hostile = 'x"); globalThis.__pwned = true; ("';
  const box = sandbox({ options: [{ value: hostile, label: 'Hostile' }], value: '' });
  delete globalThis.__pwned;
  const result = runWrite(selectWriteExpression({ value: hostile }), box);
  assert.equal(result.ok, true, '恶意字符串必须被当成合法 option value 处理');
  assert.equal(box.state.value, hostile, '值必须逐字写进去');
  assert.equal(globalThis.__pwned, undefined, '表达式不许被值打断成可执行代码');
});

/* ------------------------------------------------------------------------------------------------
 * ③ 页面函数本体：假 DOM 真跑
 * ---------------------------------------------------------------------------------------------- */

/**
 * 造一个最小的 select 环境：原型上有 value/selectedIndex setter，按索引同步 selected 状态。
 * `selectorResult` 决定 document.querySelectorAll 的返回（数组 = 命中，undefined = 未用选择器）。
 */
function sandbox({
  options = [], value = '', multiple = false, size = 0, disabled = false,
  active = true, selectorResult, selectorThrows = false,
} = {}) {
  const events = [];
  const assignedDirectly = [];
  class Event {
    constructor(type, init) { this.type = type; this.bubbles = Boolean(init && init.bubbles); }
  }
  function HTMLSelectElement() {}
  const state = { value, selectedIndex: options.findIndex((option) => option.value === value) };
  const selectIndex = (index) => {
    state.selectedIndex = index >= 0 && index < options.length ? index : -1;
    state.value = state.selectedIndex === -1 ? '' : String(options[state.selectedIndex].value);
    options.forEach((option, optionIndex) => { option.selected = optionIndex === state.selectedIndex; });
  };
  Object.defineProperty(HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() { return state.value; },
    set(next) { selectIndex(options.findIndex((option) => String(option.value) === String(next))); this.__viaPrototypeSetter = true; },
  });
  Object.defineProperty(HTMLSelectElement.prototype, 'selectedIndex', {
    configurable: true,
    get() { return state.selectedIndex; },
    set(next) { selectIndex(next); this.__viaPrototypeSetter = true; },
  });
  const element = Object.create(HTMLSelectElement.prototype);
  const body = { tagName: 'BODY' };
  Object.assign(element, {
    tagName: 'SELECT',
    multiple,
    size,
    disabled,
    options,
    dispatchEvent(event) { events.push(event.type); return true; },
  });
  // 实例自己的 value 访问器：谁走实例 setter 就会被记下来（React 受控字段就是这样拦截的）。
  Object.defineProperty(element, 'value', {
    configurable: true,
    get() { return state.value; },
    set(next) { assignedDirectly.push(next); state.value = String(next); },
  });
  options.forEach((option, index) => {
    Object.defineProperty(option, 'selected', { value: index === state.selectedIndex, writable: true, configurable: true });
  });
  Object.defineProperty(element, 'selectedIndex', {
    configurable: true,
    get() { return state.selectedIndex; },
    set(next) { assignedDirectly.push(next); selectIndex(next); },
  });
  const document = {
    activeElement: active ? element : (body),
    body,
    documentElement: { tagName: 'HTML' },
    querySelectorAll(selector) {
      if (selectorThrows) throw new Error('bad selector');
      return Array.isArray(selectorResult) ? selectorResult : [];
    },
  };
  return { document, HTMLSelectElement, Event, element, state, events, assignedDirectly };
}

function runWrite(expression, sandboxed, boundTarget = sandboxed.element) {
  // eslint-disable-next-line no-new-func
  const fn = new Function('document', 'HTMLSelectElement', 'Event', `return ${expression};`);
  return fn.call(boundTarget, sandboxed.document, sandboxed.HTMLSelectElement, sandboxed.Event);
}

test('页面函数：native setter + input → change，且不走实例 setter（React 受控 select 才会看到变化）', () => {
  const box = sandbox({
    options: [{ value: 'world', label: 'World' }, { value: 'galaxy', label: 'Galaxy' }],
    value: 'galaxy',
  });
  const result = runWrite(selectWriteExpression({ value: 'world' }), box);
  assert.equal(result.ok, true);
  assert.equal(result.value, 'world');
  assert.equal(box.state.value, 'world');
  assert.equal(box.element.__viaPrototypeSetter, true, '必须用 HTMLSelectElement.prototype 的 setter');
  assert.deepEqual(box.assignedDirectly, [], '不许走实例 setter（否则 React 的 tracker 会认为"没变"）');
  assert.deepEqual(box.events, ['input', 'change'], '先 input 再 change，且各一次');
});

test('页面函数：值不在 options → value-not-in-options，且不写不派发', () => {
  const box = sandbox({ options: [{ value: 'a' }], value: 'a' });
  const result = runWrite(selectWriteExpression({ value: 'nope' }), box);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'value-not-in-options');
  assert.equal(result.optionCount, 1);
  assert.deepEqual(result.values, ['a']);
  assert.equal(box.state.value, 'a', '拒绝分支不许改动 value');
  assert.deepEqual(box.events, [], '拒绝分支不许派发事件');
});

test('页面函数：非 select / 无聚焦元素 / 禁用 / 多选 / 空选项 各自稳定拒绝', () => {
  const notSelect = sandbox({});
  notSelect.element.tagName = 'INPUT';
  assert.equal(runWrite(selectWriteExpression({ value: 'x' }), notSelect).reason, 'not-a-select');

  const noFocus = sandbox({ active: false });
  assert.equal(runWrite(selectWriteExpression({ value: 'x' }), noFocus).reason, 'no-focused-element');

  const disabled = sandbox({ options: [{ value: 'a' }], value: 'a', disabled: true });
  assert.equal(runWrite(selectWriteExpression({ value: 'a' }), disabled).reason, 'select-disabled');

  const multiple = sandbox({ options: [{ value: 'a' }], value: 'a', multiple: true });
  const multipleResult = runWrite(selectWriteExpression({ value: 'a' }), multiple);
  assert.equal(multipleResult.reason, 'unsupported-shape');
  assert.equal(multipleResult.multiple, true);

  const sized = sandbox({ options: [{ value: 'a' }], value: 'a', size: 5 });
  assert.deepEqual([runWrite(selectWriteExpression({ value: 'a' }), sized).reason, runWrite(selectWriteExpression({ value: 'a' }), sized).size], ['unsupported-shape', 5]);

  const empty = sandbox({ options: [], value: '' });
  assert.equal(runWrite(selectWriteExpression({ value: 'a' }), empty).reason, 'no-options');
});

test('页面函数：selector 命中 0 / 多个 / 非法 都拒绝（绝不猜）', () => {
  const none = sandbox({ options: [{ value: 'a' }], value: '', selectorResult: [] });
  const notFound = runWrite(selectWriteExpression({ value: 'a', selector: '#x' }), none);
  assert.equal(notFound.reason, 'selector-not-found');
  assert.equal(notFound.selector, '#x');

  const many = sandbox({ options: [{ value: 'a' }], value: '', selectorResult: [{}, {}] });
  const notUnique = runWrite(selectWriteExpression({ value: 'a', selector: '.x' }), many);
  assert.equal(notUnique.reason, 'selector-not-unique');
  assert.equal(notUnique.count, 2);

  const broken = sandbox({ options: [{ value: 'a' }], value: '', selectorThrows: true });
  assert.equal(runWrite(selectWriteExpression({ value: 'a', selector: ':::' }), broken).reason, 'selector-invalid');
});

test('页面函数：显式 selector 时忽略聚焦元素，写到指定的 select', () => {
  const box = sandbox({ options: [{ value: 'world', label: 'World' }], value: 'world', active: false, selectorResult: [] });
  box.document.querySelectorAll = () => [box.element]; // 只命中那个 select（与聚焦元素无关）
  const result = runWrite(selectWriteExpression({ value: 'world', selector: '#editSpace' }), box);
  assert.equal(result.ok, true);
  assert.equal(result.value, 'world');
  assert.deepEqual(box.events, ['input', 'change']);
});

test('页面函数：没有聚焦元素时报 no-focused-element，绝不"猜一个 select"', () => {
  const box = sandbox({ options: [{ value: 'a' }], value: 'a', active: false });
  assert.equal(runWrite(selectWriteExpression({ value: 'a' }), box).reason, 'no-focused-element');
});

/* ------------------------------------------------------------------------------------------------
 * 探针函数本体：假 select 真跑（读侧）
 * ---------------------------------------------------------------------------------------------- */

test('探针函数：读单个 select 的 multiple/size/value/options，不写任何东西', () => {
  // eslint-disable-next-line no-new-func
  const probe = new Function(`return (${selectProbeDeclaration()});`)();
  const fake = {
    tagName: 'SELECT', multiple: false, size: 0, value: 'b',
    options: [
      { value: 'a', label: 'Alpha', disabled: false, selected: false },
      { value: 'b', label: 'Beta', disabled: true, selected: true },
    ],
  };
  const projection = probe.call(fake);
  assert.deepEqual(projection, {
    multiple: false, size: 0, value: 'b',
    options: [
      { value: 'a', label: 'Alpha', disabled: false, selected: false },
      { value: 'b', label: 'Beta', disabled: true, selected: true },
    ],
    truncated: false,
  });
});

test('探针函数：非 select 返回 null（这是"非 select 命中形状不变"的源头）', () => {
  // eslint-disable-next-line no-new-func
  const probe = new Function(`return (${selectProbeDeclaration()});`)();
  assert.equal(probe.call({ tagName: 'INPUT', options: [] }), null);
  assert.equal(probe.call(null), null);
});

test('探针函数：200 项上限在页面侧就生效（Host 不靠事后截断兜底）', () => {
  // eslint-disable-next-line no-new-func
  const probe = new Function(`return (${selectProbeDeclaration()});`)();
  const options = Array.from({ length: SELECT_OPTION_LIMIT + 3 }, (ignored, index) => ({ value: `v${index}`, label: `L${index}`, disabled: false, selected: false }));
  const projection = probe.call({ tagName: 'SELECT', multiple: false, size: 0, value: 'v0', options });
  assert.equal(projection.options.length, SELECT_OPTION_LIMIT);
  assert.equal(projection.truncated, true);
});

/* ------------------------------------------------------------------------------------------------
 * 分类：页面答案 → 路由契约
 * ---------------------------------------------------------------------------------------------- */

test('分类：成功保留 value/selectedIndex', () => {
  assert.deepEqual(classifySelectWrite({ ok: true, value: 'world', selectedIndex: 2 }), { ok: true, value: 'world', selectedIndex: 2 });
  assert.deepEqual(classifySelectWrite({ ok: true, value: 'x' }), { ok: true, value: 'x', selectedIndex: null });
});

test('分类：每个拒绝 reason 都映射成 INVALID_ARGUMENT + 可读消息 + 原样 details', () => {
  const reasons = [
    'selector-invalid', 'selector-not-found', 'selector-not-unique', 'no-focused-element',
    'not-a-select', 'select-disabled', 'unsupported-shape', 'no-options', 'value-not-in-options',
  ];
  for (const reason of reasons) {
    const classified = classifySelectWrite({ ok: false, reason, tag: 'input', count: 2, size: 5, multiple: true, value: 'zz', optionCount: 3, values: ['a'] });
    assert.equal(classified.ok, false, reason);
    assert.equal(classified.code, 'INVALID_ARGUMENT', `${reason} 必须是面板可见的输入拒绝，而不是 INTERNAL`);
    assert.equal(classified.details.reason, reason);
    assert.ok(classified.message && classified.message.length > 0, `${reason} 必须有可读消息`);
  }
});

test('分类：details 只透传白名单字段，页面塞的其它键不外泄', () => {
  const classified = classifySelectWrite({ ok: false, reason: 'value-not-in-options', value: 'zz', optionCount: 2, values: ['a', 'b'], secret: 'page-private' });
  assert.equal(classified.details.secret, undefined, '任意页面字段不许透传');
  assert.deepEqual(Object.keys(classified.details).sort(), ['optionCount', 'reason', 'value', 'values']);
});

test('分类：读不到结果 ≠ 输入错误（INTERNAL），未知 reason 仍按输入拒绝处理', () => {
  assert.equal(classifySelectWrite(null).code, 'INTERNAL');
  assert.equal(classifySelectWrite('nope').code, 'INTERNAL');
  const unknown = classifySelectWrite({ ok: false, reason: 'something-new' });
  assert.equal(unknown.code, 'INVALID_ARGUMENT');
  assert.equal(unknown.details.reason, 'something-new');
});


test('写回请求：optionIndex 可省略或为 null；指定时保留 0 且拒绝非安全整数', () => {
  assert.equal(normalizeSelectWriteRequest({ value: 'a', optionIndex: null }).optionIndex, null);
  assert.equal(normalizeSelectWriteRequest({ value: 'a', optionIndex: 0 }).optionIndex, 0);
  assert.equal(normalizeSelectWriteRequest({ value: 'a', optionIndex: 199 }).optionIndex, 199);
  for (const optionIndex of [-1, 0.5, '0', false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
    const result = normalizeSelectWriteRequest({ value: 'a', optionIndex });
    assert.equal(result.code, 'INVALID_ARGUMENT');
    assert.equal(result.details.field, 'optionIndex');
  }
});

test('页面函数：objectBound 只写 this，不查询 selector 或使用后来聚焦的元素', () => {
  const box = sandbox({ options: [{ value: 'a' }, { value: 'b' }], value: 'a' });
  box.document.activeElement = { tagName: 'INPUT' };
  box.document.querySelectorAll = () => { throw new Error('must not query'); };
  const result = runWrite(selectWriteExpression({ value: 'b', selector: '#wrong' }, { objectBound: true }), box);
  assert.equal(result.ok, true);
  assert.equal(box.state.value, 'b');
  assert.equal(box.state.selectedIndex, 1);
  assert.deepEqual(box.events, ['input', 'change']);
});

test('页面函数：绑定节点脱离文档时拒绝，绝不回退聚焦目标', () => {
  const box = sandbox({ options: [{ value: 'a' }, { value: 'b' }], value: 'a' });
  box.element.isConnected = false;
  const result = runWrite(selectWriteExpression({ value: 'b' }, { objectBound: true }), box);
  assert.equal(result.reason, 'target-detached');
  assert.equal(box.state.value, 'a');
  assert.equal(box.state.selectedIndex, 0);
  assert.deepEqual(box.events, []);
});

test('页面函数：重复 value 按 optionIndex 选第二项，wasSelected 是写前状态', () => {
  const box = sandbox({ options: [{ value: 'same' }, { value: 'same' }], value: 'same' });
  const expression = selectWriteExpression({ value: 'same', optionIndex: 1 });
  const result = runWrite(expression, box);
  assert.deepEqual(result, { ok: true, value: 'same', selectedIndex: 1, optionIndex: 1, wasSelected: false });
  assert.deepEqual(box.element.options.map((option) => option.selected), [false, true]);
  assert.equal(box.element.__viaPrototypeSetter, true);
  assert.deepEqual(box.assignedDirectly, []);
  assert.deepEqual(box.events, ['input', 'change']);
  assert.equal(runWrite(expression, box).wasSelected, true);
});

test('页面函数：索引 0 不被当成省略；省略时按 value 选择首项', () => {
  const box = sandbox({ options: [{ value: 'same' }, { value: 'same' }], value: 'same' });
  runWrite(selectWriteExpression({ value: 'same', optionIndex: 1 }), box);
  assert.equal(runWrite(selectWriteExpression({ value: 'same', optionIndex: 0 }), box).selectedIndex, 0);
  runWrite(selectWriteExpression({ value: 'same', optionIndex: 1 }), box);
  assert.equal(runWrite(selectWriteExpression({ value: 'same' }), box).selectedIndex, 0);
});

test('页面函数：索引越界、非法与 value 不符均零写入、零事件', () => {
  for (const [optionIndex, value, reason] of [
    [-1, 'a', 'option-index-out-of-range'], [2, 'a', 'option-index-out-of-range'],
    [0.5, 'a', 'option-index-out-of-range'], ['1', 'b', 'option-index-out-of-range'],
    [1, 'a', 'option-value-mismatch'],
  ]) {
    const box = sandbox({ options: [{ value: 'a' }, { value: 'b' }], value: 'a' });
    const result = runWrite(selectWriteExpression({ value, optionIndex }), box);
    assert.equal(result.reason, reason);
    assert.equal(box.state.value, 'a');
    assert.equal(box.state.selectedIndex, 0);
    assert.deepEqual(box.element.options.map((option) => option.selected), [true, false]);
    assert.equal(box.element.__viaPrototypeSetter, undefined);
    assert.deepEqual(box.assignedDirectly, []);
    assert.deepEqual(box.events, []);
  }
});

test('页面函数：select 继承 fieldset disabled、option disabled、optgroup disabled 均拒绝', () => {
  for (const mode of ['select', 'fieldset', 'option', 'optgroup']) {
    const box = sandbox({ options: [{ value: 'a' }, { value: 'b' }], value: 'a' });
    if (mode === 'select') box.element.disabled = true;
    if (mode === 'fieldset') box.element.matches = (selector) => { assert.equal(selector, ':disabled'); return true; };
    if (mode === 'option') box.element.options[1].disabled = true;
    if (mode === 'optgroup') box.element.options[1].parentElement = { tagName: 'OPTGROUP', disabled: true };
    const result = runWrite(selectWriteExpression({ value: 'b', optionIndex: 1 }), box);
    assert.equal(result.reason, ['select', 'fieldset'].includes(mode) ? 'select-disabled' : 'option-disabled');
    assert.equal(box.state.value, 'a');
    assert.equal(box.state.selectedIndex, 0);
    assert.equal(box.element.__viaPrototypeSetter, undefined);
    assert.deepEqual(box.events, []);
  }
});

test('探针函数：有效 disabled 覆盖 select、fieldset、option 与 optgroup，输出严格布尔值', () => {
  const probe = new Function(`return (${selectProbeDeclaration()});`)();
  for (const mode of ['enabled', 'select', 'fieldset', 'option', 'optgroup']) {
    const box = sandbox({ options: [{ value: 'a' }, { value: 'b' }], value: 'a' });
    if (mode === 'select') box.element.disabled = true;
    if (mode === 'fieldset') box.element.matches = () => true;
    if (mode === 'option') box.element.options[1].disabled = true;
    if (mode === 'optgroup') box.element.options[1].parentElement = { tagName: 'OPTGROUP', disabled: true };
    const projection = probe.call(box.element);
    assert.deepEqual(projection.options.map((option) => option.disabled),
      mode === 'enabled' ? [false, false] : ['select', 'fieldset'].includes(mode) ? [true, true] : [false, true]);
    assert.equal(box.element.__viaPrototypeSetter, undefined);
    assert.deepEqual(box.events, []);
  }
});

test('分类：新增拒绝 reason 保留索引事实并给出精确中文消息', () => {
  for (const [reason, message] of [
    ['target-detached', '绑定的 <select> 已脱离文档'],
    ['option-index-out-of-range', 'optionIndex 不在 <select> 的 options 范围内'],
    ['option-value-mismatch', 'optionIndex 对应选项的 value 已变化'],
    ['option-disabled', '目标 option 或所属 optgroup 处于 disabled 状态'],
  ]) {
    assert.deepEqual(classifySelectWrite({ ok: false, reason, optionIndex: 0 }), {
      ok: false, code: 'INVALID_ARGUMENT', message, details: { reason, optionIndex: 0 },
    });
  }
});


test('写回请求：target 省略/null 兼容旧请求，票据只保留节点与文档身份', () => {
  const legacy = { ok: true, value: 'a', selector: null, optionIndex: null, target: null };
  assert.deepEqual(normalizeSelectWriteRequest({ value: 'a' }), legacy);
  assert.deepEqual(normalizeSelectWriteRequest({ value: 'a', target: null }), legacy);
  const target = { backendNodeId: 12, loaderId: 'loader-1', secret: 'must drop' };
  assert.deepEqual(normalizeSelectWriteRequest({ value: 'a', optionIndex: 0, target }), {
    ...legacy, optionIndex: 0, target: { backendNodeId: 12, loaderId: 'loader-1' },
  });
});

test('写回请求：target 类型、正安全整数节点 ID 与非空有界 loaderId 精确校验', () => {
  for (const target of [false, 'ticket', 12, [], () => {}]) {
    assert.deepEqual(normalizeSelectWriteRequest({ value: 'a', target }).details, { field: 'target' });
  }
  for (const backendNodeId of [undefined, null, 0, -1, 1.5, '12', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const result = normalizeSelectWriteRequest({ value: 'a', target: { backendNodeId, loaderId: 'loader' } });
    assert.equal(result.code, 'INVALID_ARGUMENT');
    assert.equal(result.details.field, 'target.backendNodeId');
  }
  for (const loaderId of [undefined, null, '', '  ', 12, {}, 'x'.repeat(4097)]) {
    const result = normalizeSelectWriteRequest({ value: 'a', target: { backendNodeId: 1, loaderId } });
    assert.equal(result.code, 'INVALID_ARGUMENT');
    assert.equal(result.details.field, 'target.loaderId');
  }
  assert.equal(normalizeSelectWriteRequest({ value: 'a', target: { backendNodeId: 1, loaderId: 'x'.repeat(4096) } }).ok, true);
});

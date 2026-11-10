/**
 * Panel-side surface for a *native* `<select>` (host half).
 *
 * The problem this module serves: a native `<select>` popup is painted by the browser UI layer, not
 * by the page, so it never appears in the screencast/screenshot the panel renders
 * (`select.matches(':open')` is true, the element is `document.activeElement`, and the frame still
 * shows nothing). Keyboard `↑↓ + Enter` works because it goes through the page; the mouse path
 * needs two things the panel can drive by itself:
 *
 *   1. **Read** the options of the hit `<select>` (read-only projection, no side effects) — done by
 *      `POST /element`, which uses `normalizeSelectProjection` + `selectShapeSupport` from here.
 *   2. **Write** one value back through the page (native setter + `input`/`change`) — done by
 *      `POST /select`, which uses `selectWriteExpression` + `classifySelectWrite` from here.
 *
 * Everything in this file is pure and dependency-free so the contract suite can pin it without a
 * browser, a Runtime or a Cordis context. It never touches `index.js` state, never allocates a
 * runtime and never throws: refusals are *values* (`{ok:false, code, message, details}`) so the
 * HTTP route decides the status code and the page's `lastError` projection stays untouched.
 */

/** Options are capped so one pathological `<select>` cannot bloat a panel response. */
export const SELECT_OPTION_LIMIT = 200;

/** Reasons a `<select>` cannot be driven by the panel popover (keyboard still works). */
export const SELECT_UNSUPPORTED_REASON = Object.freeze({
  MULTIPLE: 'multiple',
  SIZE: 'size',
  EMPTY: 'empty',
  DETACHED: 'detached',
});

/** Human-facing hint the panel renders for an unsupported shape (one line, keyboard escape hatch). */
export const SELECT_UNSUPPORTED_HINT = '该下拉不支持浮层，请用键盘 ↑↓ + Enter';

/**
 * Coerce the page-side probe into the public projection.
 *
 * The page function returns `{multiple, size, value, options[{value,label,disabled,selected}],
 * truncated}`; every field is re-coerced here because the page is untrusted input from the Host's
 * point of view (a page may hand back holes, huge arrays or non-strings).
 *
 * @returns {null|{multiple:boolean,size:number,value:string,
 *   options:Array<{value:string,label:string,disabled:boolean,selected:boolean}>,truncated:boolean}}
 *   `null` means "this is not a select projection" — the caller then leaves the /element reply
 *   shape untouched.
 */
export function normalizeSelectProjection(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rawOptions = Array.isArray(raw.options) ? raw.options : null;
  if (!rawOptions) return null;
  const capped = rawOptions.slice(0, SELECT_OPTION_LIMIT);
  const size = Number(raw.size);
  return {
    multiple: raw.multiple === true,
    // `size` is the raw IDL value: 0 means "not set" (a closed single-line select), so both 0 and 1
    // are the supported single-line shape.
    size: Number.isFinite(size) && size >= 0 ? size : 0,
    value: typeof raw.value === 'string' ? raw.value : String(raw.value === null || raw.value === undefined ? '' : raw.value),
    options: capped.map((option) => {
      const item = option && typeof option === 'object' ? option : {};
      return {
        value: typeof item.value === 'string' ? item.value : String(item.value === null || item.value === undefined ? '' : item.value),
        label: typeof item.label === 'string' ? item.label : String(item.label === null || item.label === undefined ? '' : item.label),
        disabled: item.disabled === true,
        selected: item.selected === true,
      };
    }),
    truncated: raw.truncated === true || rawOptions.length > SELECT_OPTION_LIMIT,
  };
}

/**
 * The page-side probe passed to `Runtime.callFunctionOn` (a function declaration, `this` = the
 * node). Pure read: it never assigns, never dispatches, never awaits.
 *
 * `SELECT_OPTION_LIMIT` is inlined so the page never ships an unbounded list to the Host; the cap is
 * reported through `truncated` instead of being silent.
 */
export function selectProbeDeclaration() {
  return `function () {
  if (!this || typeof this.tagName !== 'string' || this.tagName.toLowerCase() !== 'select') return null;
  const all = Array.from(this.options || []);
  const limit = ${SELECT_OPTION_LIMIT};
  const capped = all.slice(0, limit);
  return {
    multiple: this.multiple === true,
    size: Number(this.size) || 0,
    value: String(this.value === null || this.value === undefined ? '' : this.value),
    options: capped.map((option) => ({
      value: String(option.value === null || option.value === undefined ? '' : option.value),
      label: String(option.label === null || option.label === undefined ? (option.textContent || '') : option.label),
      disabled: this.disabled === true || (typeof this.matches === 'function' && this.matches(':disabled')) ||
        option.disabled === true || Boolean(option.parentElement && String(option.parentElement.tagName).toLowerCase() === 'optgroup' && option.parentElement.disabled === true),
      selected: option.selected === true,
    })),
    truncated: all.length > limit,
  };
}`;
}

/**
 * Can the panel popover drive this select?
 *
 * Only a single-line, non-multiple `<select>` with at least one option qualifies. Anything else
 * keeps the keyboard path (`↑↓ + Enter`), which the panel already forwards to the page.
 *
 * @returns {{supported:boolean, reason:string|null}}
 */
export function selectShapeSupport(projection) {
  if (!projection || typeof projection !== 'object') return { supported: false, reason: SELECT_UNSUPPORTED_REASON.DETACHED };
  if (projection.multiple === true) return { supported: false, reason: SELECT_UNSUPPORTED_REASON.MULTIPLE };
  const size = Number(projection.size);
  if (Number.isFinite(size) && size > 1) return { supported: false, reason: SELECT_UNSUPPORTED_REASON.SIZE };
  const options = Array.isArray(projection.options) ? projection.options : [];
  if (options.length === 0) return { supported: false, reason: SELECT_UNSUPPORTED_REASON.EMPTY };
  return { supported: true, reason: null };
}

/**
 * Validate the `POST /select` body.
 *
 * `value` is mandatory and must be a string (a `<select>` value is always a string). `selector` is
 * optional; when present it must be a non-empty string and address exactly one element. Optional
 * `optionIndex` identifies an exact option even when several options share the same value. Optional
 * `target` carries the Host's node/document identity; the Host verifies it before binding the write.
 *
 * @returns {{ok:true,value:string,selector:string|null,optionIndex:number|null,target:object|null}} | {{ok:false,code:string,message:string,details:object}}
 */
export function normalizeSelectWriteRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: '/select 需要 body: {value, selector?, optionIndex?, target?}', details: { field: 'body' } };
  }
  if (typeof body.value !== 'string') {
    return { ok: false, code: 'INVALID_ARGUMENT', message: '/select 的 value 必须是字符串', details: { field: 'value', type: typeof body.value } };
  }
  let selector = null;
  if (body.selector !== undefined && body.selector !== null) {
    if (typeof body.selector !== 'string' || body.selector.trim() === '') {
      return { ok: false, code: 'INVALID_ARGUMENT', message: 'selector 必须是非空字符串', details: { field: 'selector' } };
    }
    selector = body.selector.trim();
    if (selector.length > 4096) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: 'selector 过长', details: { field: 'selector', maxLength: 4096 } };
    }
  }
  let optionIndex = null;
  if (body.optionIndex !== undefined && body.optionIndex !== null) {
    if (!Number.isSafeInteger(body.optionIndex) || body.optionIndex < 0) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: 'optionIndex 必须是非负安全整数', details: { field: 'optionIndex' } };
    }
    optionIndex = body.optionIndex;
  }
  let target = null;
  if (body.target !== undefined && body.target !== null) {
    const raw = body.target;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: 'target 必须是包含 backendNodeId 和 loaderId 的对象', details: { field: 'target' } };
    }
    if (!Number.isSafeInteger(raw.backendNodeId) || raw.backendNodeId <= 0) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: 'target.backendNodeId 必须是正安全整数', details: { field: 'target.backendNodeId' } };
    }
    if (typeof raw.loaderId !== 'string' || raw.loaderId.trim() === '' || raw.loaderId.length > 4096) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: 'target.loaderId 必须是非空字符串且不超过 4096 字符', details: { field: 'target.loaderId' } };
    }
    target = { backendNodeId: raw.backendNodeId, loaderId: raw.loaderId };
  }
  return { ok: true, value: body.value, selector, optionIndex, target };
}

/**
 * The page-side write: one self-contained IIFE.
 *
 * Use the native `selectedIndex` setter to identify an exact option even when values repeat. Calling
 * the prototype setter also bypasses instance accessors installed by frameworks. The prior selected
 * state is captured before writing, then `input` and `change` are dispatched in that order.
 *
 * With `objectBound:true`, the IIFE inherits `this` from the Host's `Runtime.callFunctionOn` wrapper.
 * That exact node takes precedence over both selector and focus; a detached node is never replaced
 * by another target.
 *
 * The function is pure with respect to the Host: it reads, writes one element and dispatches two
 * events, and it answers a JSON-serialisable object in every branch.
 */
export function selectWriteExpression({ value, selector = null, optionIndex = null } = {}, { objectBound = false } = {}) {
  const wanted = JSON.stringify(typeof value === 'string' ? value : String(value ?? ''));
  const sel = selector === null || selector === undefined ? 'null' : JSON.stringify(String(selector));
  const index = optionIndex === null || optionIndex === undefined ? 'null' : JSON.stringify(optionIndex);
  return `(() => {
  const wantedValue = ${wanted};
  const selector = ${sel};
  const requestedIndex = ${index};
  const objectBound = ${objectBound === true};
  let target = null;
  if (objectBound) {
    target = this;
    if (!target || target.isConnected === false) return { ok: false, reason: 'target-detached' };
  } else if (selector !== null) {
    let matches;
    try { matches = document.querySelectorAll(selector); } catch (error) {
      return { ok: false, reason: 'selector-invalid', message: String(error && error.message || error) };
    }
    if (!matches || matches.length === 0) return { ok: false, reason: 'selector-not-found', selector };
    if (matches.length > 1) return { ok: false, reason: 'selector-not-unique', selector, count: matches.length };
    target = matches[0];
  } else {
    target = document.activeElement;
    if (!target || target === document.body || target === document.documentElement) {
      return { ok: false, reason: 'no-focused-element' };
    }
  }
  const tag = String(target.tagName || '').toLowerCase();
  if (tag !== 'select') return { ok: false, reason: 'not-a-select', tag, focused: !objectBound && selector === null };
  if (target.disabled || (typeof target.matches === 'function' && target.matches(':disabled'))) {
    return { ok: false, reason: 'select-disabled' };
  }
  const multiple = target.multiple === true;
  const size = Number(target.size) || 0;
  if (multiple || size > 1) return { ok: false, reason: 'unsupported-shape', multiple, size };
  const options = Array.from(target.options || []);
  if (options.length === 0) return { ok: false, reason: 'no-options' };
  if (requestedIndex !== null && (!Number.isInteger(requestedIndex) || requestedIndex < 0 || requestedIndex >= options.length)) {
    return { ok: false, reason: 'option-index-out-of-range', optionIndex: requestedIndex, optionCount: options.length };
  }
  const index = requestedIndex === null ? options.findIndex((item) => String(item.value) === wantedValue) : requestedIndex;
  const option = options[index];
  if (!option) {
    return { ok: false, reason: 'value-not-in-options', value: wantedValue, optionCount: options.length,
      values: options.slice(0, 50).map((item) => String(item.value)) };
  }
  if (String(option.value) !== wantedValue) {
    return { ok: false, reason: 'option-value-mismatch', value: wantedValue, optionIndex: index };
  }
  if (option.disabled === true || (option.parentElement && String(option.parentElement.tagName).toLowerCase() === 'optgroup' && option.parentElement.disabled === true)) {
    return { ok: false, reason: 'option-disabled', optionIndex: index, value: wantedValue };
  }
  const wasSelected = option.selected === true;
  let setter = null;
  try {
    setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  } catch (error) { setter = null; }
  if (setter && typeof setter.set === 'function') setter.set.call(target, index);
  else target.selectedIndex = index;
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
  return {
    ok: true,
    value: String(target.value),
    selectedIndex: Number(target.selectedIndex),
    optionIndex: index,
    wasSelected,
  };
})()`;
}

/**
 * Classify the page answer into the route's contract.
 *
 * Every refusal keeps a stable `reason` in `details` (the panel and the tests branch on that, not on
 * message text) and uses `INVALID_ARGUMENT` — the request named something this page cannot honour,
 * which is an input answer rather than a Host failure. `INTERNAL` is reserved for an answer the
 * function itself could not produce.
 */
export function classifySelectWrite(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, code: 'INTERNAL', message: '/select 的页面结果不可读', details: { reason: 'unreadable-result' } };
  }
  if (raw.ok === true) {
    return { ok: true, value: String(raw.value ?? ''), selectedIndex: Number.isFinite(Number(raw.selectedIndex)) ? Number(raw.selectedIndex) : null };
  }
  const reason = typeof raw.reason === 'string' && raw.reason ? raw.reason : 'unknown';
  const details = { reason };
  if (typeof raw.selector === 'string') details.selector = raw.selector;
  if (Number.isFinite(Number(raw.count))) details.count = Number(raw.count);
  if (Number.isFinite(Number(raw.size))) details.size = Number(raw.size);
  if (typeof raw.multiple === 'boolean') details.multiple = raw.multiple;
  if (typeof raw.tag === 'string') details.tag = raw.tag;
  if (typeof raw.focused === 'boolean') details.focused = raw.focused;
  if (typeof raw.value === 'string') details.value = raw.value;
  if (Number.isSafeInteger(raw.optionIndex) && raw.optionIndex >= 0) details.optionIndex = raw.optionIndex;
  if (Number.isFinite(Number(raw.optionCount))) details.optionCount = Number(raw.optionCount);
  if (Array.isArray(raw.values)) details.values = raw.values.slice(0, 50).map((item) => String(item));
  const message = {
    'selector-invalid': 'selector 不是合法的 CSS 选择器',
    'selector-not-found': 'selector 没有命中任何元素',
    'selector-not-unique': 'selector 命中了多个元素（必须唯一）',
    'no-focused-element': '页面没有聚焦的元素：先点一下 <select>，或显式给 selector',
    'not-a-select': '目标元素不是 <select>',
    'select-disabled': '<select> 处于 disabled 状态',
    'target-detached': '绑定的 <select> 已脱离文档',
    'option-index-out-of-range': 'optionIndex 不在 <select> 的 options 范围内',
    'option-value-mismatch': 'optionIndex 对应选项的 value 已变化',
    'option-disabled': '目标 option 或所属 optgroup 处于 disabled 状态',
    'unsupported-shape': '只支持单选 <select>（multiple/size>1 请用键盘 ↑↓ + Enter）',
    'no-options': '<select> 没有可选项',
    'value-not-in-options': '目标值不在 <select> 的 options 里',
  }[reason] || '下拉写入失败';
  return { ok: false, code: 'INVALID_ARGUMENT', message, details };
}

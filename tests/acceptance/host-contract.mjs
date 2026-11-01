/**
 * P21 — host output contract (task-3).
 *
 * The real DSH host snapshots every successful tool value with
 * `@deepseek-ai/dsh-util-values` `snapshotJsonValue()` before reacting to it; a single
 * `undefined` own property (or a non-finite number, a sparse array, or a class instance) makes
 * the whole call fail with `INVALID_TOOL_OUTPUT: value is not lossless JSON`, even though the
 * page action already happened. The fake Cordis harness used by run.mjs does not perform that
 * step, so this probe applies the *real* validator to the real tool outputs.
 *
 * Validator resolution: the plugin's own realpath cannot resolve `@deepseek-ai/dsh-util-values`
 * (it lives in the DSH install tree), so it is resolved through the DSH_ROOT convention used by
 * check-skill-registry.mjs and its package.json `exports["."]`. When that install is absent the
 * probe falls back to an inlined equivalent of the host rules and records the difference as an
 * advisory finding instead of silently claiming the real validator ran.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DSH_ROOT = process.env.DSH_ROOT || '<local-path>/.local/share/node/lib/node_modules/@deepseek-ai/dsh';
const DSH_MODULES = join(DSH_ROOT, 'node_modules', '@deepseek-ai');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Inlined equivalent of `walkJsonValue` in @deepseek-ai/dsh-util-values (validation only):
 * null/boolean/string/finite-non-negative-zero numbers are valid; undefined, symbols, functions,
 * bigints, non-finite numbers and -0 are not; arrays must be dense; objects must be plain
 * (Object.prototype or null prototype) with enumerable string keys only. Recursion is a plain DFS
 * here because probe inputs are small; the host uses an iterative walk with cycle detection.
 */
function inlineIsJsonValue(value) {
  const seen = new Set();
  const walk = (current) => {
    if (current === null) return true;
    const type = typeof current;
    if (type === 'boolean' || type === 'string') return true;
    if (type === 'number') return Number.isFinite(current) && !Object.is(current, -0);
    if (type !== 'object') return false;
    if (seen.has(current)) return false;
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        if (Reflect.ownKeys(current).length !== current.length + 1) return false;
        for (let index = 0; index < current.length; index += 1) if (!Object.hasOwn(current, index) || !walk(current[index])) return false;
        return true;
      }
      const prototype = Object.getPrototypeOf(current);
      // Plain record: Object.prototype / null prototype from any realm, not a class instance.
      if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return false;
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(current, key)) return false;
        if (!walk(current[key])) return false;
      }
      return true;
    } finally {
      seen.delete(current);
    }
  };
  return walk(value);
}
function inlineSnapshotJsonValue(value) {
  if (!inlineIsJsonValue(value)) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Resolve the real `@deepseek-ai/dsh-tools` package. The host calls
 * `assertSupportedJsonSchema()` on every registered tool's `output.schema`; parameter schemas are
 * only snapshotted (lossless JSON), not forced into the subset. Absence is reported, never skipped.
 */
export async function loadDshTools() {
  const packageDir = join(DSH_MODULES, 'dsh-tools');
  let manifest;
  try { manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')); }
  catch (error) { return { real: false, packageDir, reason: `无法读取 ${join(packageDir, 'package.json')}：${String(error?.message || error)}` }; }
  const rootExport = manifest.exports?.['.'];
  const entry = typeof rootExport === 'string' ? rootExport
    : rootExport && typeof rootExport === 'object' ? (rootExport.default || rootExport.import || rootExport.require) : manifest.main;
  const entryPath = join(packageDir, String(entry || 'lib/index.js').replace(/^\.\//, ''));
  try {
    const module = await import(pathToFileURL(entryPath).href);
    if (typeof module.assertSupportedJsonSchema !== 'function') {
      return { real: false, packageDir, entryPath, version: manifest.version, reason: '模块未导出 assertSupportedJsonSchema' };
    }
    return { real: true, packageDir, entryPath, version: manifest.version, assertSupportedJsonSchema: module.assertSupportedJsonSchema };
  } catch (error) {
    return { real: false, packageDir, entryPath, version: manifest.version, reason: `import 失败：${String(error?.message || error)}` };
  }
}

export async function loadValidator() {
  const packageDir = join(DSH_MODULES, 'dsh-util-values');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  } catch (error) {
    return {
      real: false, packageDir, reason: `无法读取 ${join(packageDir, 'package.json')}：${String(error?.message || error)}`,
      snapshotJsonValue: inlineSnapshotJsonValue, isJsonValue: inlineIsJsonValue, version: 'inline-equivalent',
    };
  }
  const rootExport = manifest.exports?.['.'];
  const entry = typeof rootExport === 'string' ? rootExport
    : rootExport && typeof rootExport === 'object' ? (rootExport.default || rootExport.import || rootExport.require)
      : manifest.main;
  const entryPath = join(packageDir, String(entry || 'lib/index.js').replace(/^\.\//, ''));
  try {
    const module = await import(pathToFileURL(entryPath).href);
    if (typeof module.snapshotJsonValue !== 'function' || typeof module.isJsonValue !== 'function') {
      return {
        real: false, packageDir, entryPath, version: manifest.version,
        reason: `模块 ${entryPath} 未导出 snapshotJsonValue/isJsonValue`,
        snapshotJsonValue: inlineSnapshotJsonValue, isJsonValue: inlineIsJsonValue,
      };
    }
    return { real: true, packageDir, entryPath, version: manifest.version,
      snapshotJsonValue: module.snapshotJsonValue, isJsonValue: module.isJsonValue };
  } catch (error) {
    return {
      real: false, packageDir, entryPath, version: manifest.version,
      reason: `import ${entryPath} 失败：${String(error?.message || error)}`,
      snapshotJsonValue: inlineSnapshotJsonValue, isJsonValue: inlineIsJsonValue,
    };
  }
}

/** Every path whose own value is `undefined` (what the host snapshot rejects first). */
export function undefinedPaths(value, path = 'value', out = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => undefinedPaths(item, `${path}[${index}]`, out));
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) out.push(`${path}.${key}`);
    else undefinedPaths(value[key], `${path}.${key}`, out);
  }
  return out;
}

/** Paths holding a non-finite number or -0 (also rejected by the host snapshot). */
export function nonFinitePaths(value, path = 'value', out = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => nonFinitePaths(item, `${path}[${index}]`, out));
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0))) out.push(`${path}.${key}`);
    else nonFinitePaths(item, `${path}.${key}`, out);
  }
  return out;
}

async function evalValue(harness, expression) {
  const result = await harness.invoke('browser_eval', { expression });
  if (!result.ok) throw new Error('browser_eval 抛错：' + String(result.error?.message || ''));
  if (!result.value?.ok) throw new Error('browser_eval 返回错误：' + JSON.stringify(result.value?.error));
  return result.value.value;
}

async function waitForEval(harness, expression, predicate, { timeoutMs = 5000, label = expression } = {}) {
  const startedAt = Date.now();
  let last;
  while (Date.now() - startedAt < timeoutMs) {
    last = await evalValue(harness, expression);
    if (predicate(last)) return last;
    await sleep(100);
  }
  throw new Error(`等待页面状态超时（${label}）：${JSON.stringify(last)}`);
}

class FakeAttachment {
  // Deliberately a class instance: the host snapshot rejects non-plain objects, so the tool
  // value must project it instead of returning the service object verbatim.
  constructor(fields) { Object.assign(this, fields); }
  get filename() { return this.name; }
}

export async function hostOutputContractProbe({ harness, check, finding, fixture }) {
  const validator = await loadValidator();
  if (!validator.real) {
    finding({
      id: 'P21-validator-fallback',
      severity: 'medium',
      summary: `未解析到真实 @deepseek-ai/dsh-util-values，改用 tests 内联等价校验器：${validator.reason}`,
      evidence: { packageDir: validator.packageDir, entryPath: validator.entryPath, dshRoot: DSH_ROOT },
    });
  }
  check(`校验器来源：${validator.real ? '真实 @deepseek-ai/dsh-util-values' : '内联等价实现'}（版本 ${validator.version}）`, validator.real, {
    expected: { real: true, packageDir: join(DSH_MODULES, 'dsh-util-values') },
    actual: { real: validator.real, version: validator.version, entryPath: validator.entryPath, reason: validator.reason, dshRoot: DSH_ROOT },
  }, { advisory: !validator.real });

  const snapshotOf = (value) => {
    const snapshot = validator.snapshotJsonValue(value);
    return { snapshot, ok: snapshot !== undefined && validator.isJsonValue(value) === true };
  };

  const navigation = await harness.invoke('browser_navigate', { url: fixture.url });
  await waitForEval(harness, 'document.readyState', (value) => value === 'complete', { label: 'readyState' });

  // A failed request so the network buffer contains a loadingFailed entry as well.
  await evalValue(harness, "fetch('http://127.0.0.1:1/host-contract-unreachable').then(() => true).catch(() => false)");
  await sleep(600);

  const calls = [
    ['browser_navigate', { url: fixture.url }],
    ['browser_state', {}],
    ['browser_capabilities', {}],
    ['browser_network', { limit: 3 }],
    ['browser_eval', { expression: '({answer: 42})' }],
    ['browser_computed_style', { selector: 'body', properties: ['display'] }],
    ['browser_input', { events: [] }],
    ['browser_screenshot', {}],
    ['browser_http_request', { url: fixture.url + 'health' }],
  ];

  const values = [];
  const renderProblems = [];
  /** Run one tool call and apply the real host rules to its value and its render content. */
  const checkCall = async (name, args) => {
    const result = await harness.invoke(name, args);
    const value = result.value;
    values.push({ name, args, result });
    if (!result.ok) {
      check(`${name} 成功返回（前置条件）`, false, { expected: 'success', actual: result.error });
      return result;
    }
    const { snapshot, ok } = snapshotOf(value);
    const undefinedFound = undefinedPaths(value);
    const nonFiniteFound = nonFinitePaths(value);
    check(`${name} 返回值通过宿主快照（isJsonValue=true 且无 undefined 属性）`, ok && undefinedFound.length === 0 && nonFiniteFound.length === 0, {
      expected: { isJsonValue: true, undefinedPaths: [], nonFinitePaths: [] },
      actual: { isJsonValue: validator.isJsonValue(value), snapshotUndefined: snapshot === undefined, undefinedFound, nonFiniteFound },
    });
    // The host snapshots `output.render(...)` too, so the durable content must be lossless.
    const definition = harness.tools.get(name);
    try {
      const rendered = definition.output.render(args, snapshot);
      const renderedSnapshot = validator.snapshotJsonValue(rendered);
      if (renderedSnapshot === undefined) renderProblems.push(`${name}: render 结果不是 lossless JSON（content 快照会失败）`);
    } catch (error) {
      renderProblems.push(`${name}: render 抛错 ${String(error?.message || error)}`);
    }
    return result;
  };
  for (const [name, args] of calls) await checkCall(name, args);

  // --- T2 (docs/t2-structured-gui.md §2.2): the seven structured tools, same host rules ------
  const origin = new URL(fixture.url).origin;
  const t2Navigation = await harness.invoke('browser_navigate', { url: origin + '/web-t2.html' });
  await waitForEval(harness, 'document.readyState', (value) => value === 'complete', { label: 'web-t2 ready' });
  // Pre-scroll so this lossless-output probe does not depend on auto-scroll (C17 covers that).
  await evalValue(harness, 'document.getElementById("t2-inc").scrollIntoView({block:"center"}), 1');
  const t2Snapshot = await harness.invoke('browser_snapshot', {});
  const t2Refs = t2Snapshot.value?.refs || {};
  const refEntry = (role, name) => Object.entries(t2Refs).find(([, entry]) => entry.role === role && entry.name === name)?.[0];
  const incrementRef = refEntry('button', 'Increment');
  const nameRef = refEntry('textbox', 'Name');
  check('T2 页面快照可用（前置：refs 非空）', t2Navigation.ok && t2Snapshot.ok && Object.keys(t2Refs).length > 5 && Boolean(incrementRef), {
    expected: 'snapshot with refs', actual: { running: t2Navigation.ok, snapshotOk: t2Snapshot.ok, refs: Object.keys(t2Refs).length, incrementRef, error: t2Snapshot.error?.message },
  });
  const t2Calls = [
    ['browser_snapshot', {}],
    ['browser_click', { ref: incrementRef }],
    ['browser_type', { ref: nameRef, text: 'host-contract' }],
    ['browser_scroll', { direction: 'down', amount: 120 }],
    ['browser_fill_form', { fields: [{ selector: '#t2-agree', type: 'checkbox', value: true }] }],
    ['browser_node_state', { selector: '#t2-inc' }],
    ['browser_wait_for', { text: 'Item 1', timeoutMs: 2000 }],
  ];
  for (const [name, args] of t2Calls) await checkCall(name, args);
  const t2Failure = await harness.invoke('browser_click', { selector: '#t2-host-contract-missing' });
  check('T2 抛错路径（TARGET_NOT_FOUND）的 BrowserError 也可快照且带 version=1 evidence',
    t2Failure.threw === true && t2Failure.error?.code === 'TARGET_NOT_FOUND'
      && validator.isJsonValue({ name: t2Failure.error?.name, code: t2Failure.error?.code, category: t2Failure.error?.category,
        retryable: t2Failure.error?.retryable, message: t2Failure.error?.message, details: t2Failure.error?.details }) === true
      && t2Failure.error?.details?.evidence?.version === 1, {
      expected: { code: 'TARGET_NOT_FOUND', evidenceVersion: 1 },
      actual: { code: t2Failure.error?.code, evidenceVersion: t2Failure.error?.details?.evidence?.version, message: String(t2Failure.error?.message || '').slice(0, 160) },
    });
  check('全部工具（22）的 render content 都能通过宿主快照（成功结果与失败结果都算）', renderProblems.length === 0, {
    expected: [],
    actual: renderProblems,
  });

  // --- The four paths the real host rejected before this fix --------------------------------
  const undefinedValue = await harness.invoke('browser_eval', { expression: 'undefined' });
  const undefinedUndefinedPaths = undefinedValue.value ? undefinedPaths(undefinedValue.value) : ['value'];
  check('browser_eval 页面值为 undefined 时返回体仍可快照（不出现 value:undefined）', undefinedValue.ok === true
    && Object.hasOwn(undefinedValue.value || {}, 'value') === false && undefinedUndefinedPaths.length === 0
    && snapshotOf(undefinedValue.value).ok === true, {
    expected: { ok: true, hasValueProperty: false, snapshot: 'object' },
    actual: { keys: Object.keys(undefinedValue.value || {}), undefinedPaths: undefinedUndefinedPaths, snapshotOk: snapshotOf(undefinedValue.value).ok },
  });

  // A page exception is a *successful* tool value carrying {ok:false,error}, so the host snapshots
  // it: previously details.url/line/column were undefined and the whole call was rejected.
  const thrown = await harness.invoke('browser_eval', { expression: "throw new Error('host-contract-boom')" });
  const evalError = thrown.value?.error || thrown.error;
  // Copy the payload verbatim: adding a field the payload does not have (e.g. `name`) would
  // reintroduce `undefined` and make this check about the probe instead of the plugin.
  const evalErrorInfo = evalError ? { ...evalError } : {};
  check('browser_eval 页面异常（EVAL_ERROR 值）的 error+details 可快照且无 undefined', evalError?.code === 'EVAL_ERROR'
    && snapshotOf(thrown.value).ok === true && undefinedPaths(thrown.value, 'evalErrorValue').length === 0
    && validator.isJsonValue(evalErrorInfo) === true && validator.snapshotJsonValue(evalErrorInfo) !== undefined, {
    expected: { code: 'EVAL_ERROR', valueSnapshot: 'object', undefinedPaths: [] },
    actual: {
      code: evalError?.code,
      valueUndefinedPaths: undefinedPaths(thrown.value, 'evalErrorValue'),
      details: evalError?.details,
      snapshotOk: validator.snapshotJsonValue(evalErrorInfo) !== undefined,
    },
  });

  const numeric = values.find((item) => item.name === 'browser_network');
  const numericArgs = numeric?.result.value?.args?.limit;
  check('数字参数调用的 args 摘要不再产生 undefined（browser_network limit=3）', Boolean(numericArgs)
    && undefinedPaths(numericArgs, 'args.limit').length === 0 && snapshotOf(numeric.result.value).ok === true, {
    expected: { limitSummary: { type: 'number', value: 3 }, undefinedPaths: [] },
    actual: { limitSummary: numericArgs, undefinedPaths: numericArgs ? undefinedPaths(numericArgs, 'args.limit') : ['args.limit'] },
  });

  const shot = values.find((item) => item.name === 'browser_screenshot')?.result.value;
  check('无附件服务的截图返回值可快照：attachment 缺省、attachmentId=null、base64-fallback', shot?.imageDelivery === 'base64-fallback'
    && shot?.attachmentId === null && Object.hasOwn(shot || {}, 'attachment') === false
    && undefinedPaths(shot || {}, 'shot').length === 0 && snapshotOf(shot).ok === true, {
    expected: { imageDelivery: 'base64-fallback', attachmentId: null, hasAttachmentKey: false },
    actual: { imageDelivery: shot?.imageDelivery, attachmentId: shot?.attachmentId, hasAttachmentKey: Object.hasOwn(shot || {}, 'attachment'), undefinedPaths: undefinedPaths(shot || {}, 'shot') },
  });

  const network = values.find((item) => item.name === 'browser_network')?.result.value;
  const failedEntry = (network?.entries || []).find((entry) => entry.failed === true);
  check('失败网络条目（loadingFailed）可快照且无 undefined 字段', Boolean(failedEntry)
    && validator.isJsonValue(failedEntry) === true && undefinedPaths(failedEntry, 'entry').length === 0
    && typeof failedEntry.errorText === 'string', {
    expected: { failed: true, errorText: 'string', snapshot: 'object' },
    actual: failedEntry || (network?.entries || []).slice(-3),
  });

  // Operation-failure values (returned, not thrown) must also survive the host snapshot.
  const missingTarget = await harness.invoke('browser_computed_style', { selector: '#host-contract-missing', properties: ['display'] });
  check('browser_computed_style 未命中（TARGET_NOT_FOUND 值）可快照且无 undefined', missingTarget.ok === true
    && missingTarget.value?.ok === false && missingTarget.value?.error?.code === 'TARGET_NOT_FOUND'
    && snapshotOf(missingTarget.value).ok === true && undefinedPaths(missingTarget.value, 'styleErrorValue').length === 0, {
    expected: { ok: false, code: 'TARGET_NOT_FOUND', snapshot: 'object' },
    actual: { value: missingTarget.value, undefinedPaths: undefinedPaths(missingTarget.value || {}, 'styleErrorValue') },
  });

  const invalidInput = await harness.invoke('browser_input', { events: [{ kind: 'key', type: 'keyDown', key: 'Tab', modifiers: ['hyper'] }] });
  const invalidInfo = {
    name: invalidInput.error?.name, code: invalidInput.error?.code, category: invalidInput.error?.category,
    retryable: invalidInput.error?.retryable, message: invalidInput.error?.message, details: invalidInput.error?.details,
  };
  check('工具抛错路径的 details 也被清洗为 lossless JSON（INVALID_ARGUMENT）', invalidInput.threw === true
    && invalidInput.error?.code === 'INVALID_ARGUMENT' && validator.isJsonValue(invalidInfo) === true
    && validator.snapshotJsonValue(invalidInfo) !== undefined && undefinedPaths(invalidInfo).length === 0, {
    expected: { code: 'INVALID_ARGUMENT', snapshot: 'object' },
    actual: { code: invalidInput.error?.code, undefinedPaths: undefinedPaths(invalidInfo) },
  });

  // --- Registered-schema guard ---------------------------------------------------------------
  // Host registration asserts only the *output* schema against the whitelisted subset; parameter
  // schemas must merely be lossless JSON. Parameter-subset compliance is reported advisory only.
  const dshTools = await loadDshTools();
  check(`dsh-tools 校验器来源：${dshTools.real ? '真实 assertSupportedJsonSchema' : '不可用（需真实 DSH 安装）'}（版本 ${dshTools.version || 'n/a'}）`,
    dshTools.real, { expected: { real: true }, actual: dshTools }, { advisory: !dshTools.real });
  if (dshTools.real) {
    const outputProblems = [];
    for (const definition of harness.toolDefinitions()) {
      try { dshTools.assertSupportedJsonSchema(definition.output.schema); }
      catch (error) { outputProblems.push(`${definition.name}: ${String(error?.message || error).slice(0, 240)}`); }
    }
    check('全部工具（22）的 output.schema 全部通过宿主 assertSupportedJsonSchema', outputProblems.length === 0,
      { expected: [], actual: outputProblems });
  }
  const parameterProblems = [];
  const parameterSubsetProblems = [];
  for (const definition of harness.toolDefinitions()) {
    const schema = definition.parameters;
    if (!validator.isJsonValue(schema) || validator.snapshotJsonValue(schema) === undefined) parameterProblems.push(`${definition.name}: 参数 schema 不是 lossless JSON`);
    if (!schema || schema.type !== 'object') parameterProblems.push(`${definition.name}: 参数 schema 根 type != object`);
    if (!Array.isArray(schema?.required)) parameterProblems.push(`${definition.name}: 参数 schema 缺 required 数组`);
    if (dshTools.real) {
      try { dshTools.assertSupportedJsonSchema(schema); }
      catch (error) { parameterSubsetProblems.push(`${definition.name}: ${String(error?.message || error).slice(0, 160)}`); }
    }
  }
  check('全部工具（22）的参数 schema 可快照且根为 object/required 数组', parameterProblems.length === 0,
    { expected: [], actual: parameterProblems });
  check('提示：参数 schema 也落在宿主白名单子集（非必需，仅收紧）', parameterSubsetProblems.length === 0,
    { expected: [], actual: parameterSubsetProblems }, { advisory: true });
}

/** Second half of the attachment checks, using a harness whose saveImage returns a class instance. */
export async function attachmentProjectionProbe({ createHarness, check }) {
  const reference = new FakeAttachment({ attachmentId: 'host-contract-image', id: 'host-contract-image', mediaType: 'image/png', bytes: 128, width: 1280, height: 800, name: 'host-contract.png' });
  const attached = await createHarness({ name: 'host-contract-attachment', attachments: { async saveImage() { return reference; } } });
  try {
    const result = await attached.invoke('browser_screenshot');
    const value = result.value || {};
    const plain = Object.getPrototypeOf(value.attachment || {}) === Object.prototype;
    const snapshot = inlineSnapshotJsonValue(value);
    check('附件服务返回类实例时，工具值把 attachment 投影为纯 JSON 字段并通过快照', result.ok && plain
      && value.attachment?.attachmentId === 'host-contract-image' && value.attachment?.mediaType === 'image/png'
      && value.attachmentId === 'host-contract-image' && inlineIsJsonValue(value) === true && snapshot !== undefined, {
      expected: { plainPrototype: true, attachmentId: 'host-contract-image', mediaType: 'image/png', isJsonValue: true },
      actual: { plainPrototype: plain, attachment: value.attachment, attachmentId: value.attachmentId, isJsonValue: inlineIsJsonValue(value) },
    });
    const block = result.content?.find((item) => item.type === 'image');
    check('render 的 image block 携带投影后的纯 JSON 附件且可快照', Boolean(block)
      && Object.getPrototypeOf(block.attachment || {}) === Object.prototype
      && inlineSnapshotJsonValue(result.content) !== undefined, {
      expected: { blockType: 'image', attachmentPlain: true, contentSnapshot: 'array' },
      actual: { block: block && { type: block.type, attachment: block.attachment }, contentSnapshotOk: inlineSnapshotJsonValue(result.content) !== undefined },
    });
  } finally {
    try { await attached.closeBrowser(); } catch { /* ignore */ }
    await attached.dispose();
  }
}

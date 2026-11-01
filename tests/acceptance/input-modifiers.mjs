/**
 * P20 — browser_input 功能键与修饰键（N2）。
 *
 * Everything here goes through the registered `browser_input` / `browser_eval` tools against the
 * plugin's own headless Chromium. Ground truth is the page: a capture-phase listener records the
 * real DOM events the renderer produced, and the assertions read that buffer back with
 * `browser_eval`. No screenshot or pixel inspection is used to claim success.
 *
 * Covered: Tab / Shift+Tab focus traversal, Ctrl+A keydown flags, `virtualKeyCode` → `e.keyCode`,
 * integer bitmask modifiers, `autoRepeat` → `e.repeat`, mouse/wheel modifiers, the legacy minimal
 * payloads (no new fields), and INVALID_ARGUMENT for unknown modifier names / bad types / bad
 * key types (with no event reaching the page).
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function navigateFixture(harness, url) {
  const navigation = await harness.invoke('browser_navigate', { url });
  if (!navigation.ok || !navigation.value?.ok) return { navigation, loaded: false };
  await waitForEval(harness, 'document.readyState', (value) => value === 'complete', { label: 'readyState' });
  return { navigation, loaded: true };
}

/** Install a capture-phase recorder and focus #inc (first focusable in the fixture tab order). */
const INSTALL_RECORDER = `(() => {
  window.__rec = [];
  for (const type of ['keydown', 'keyup', 'mousedown', 'wheel']) {
    document.addEventListener(type, (e) => {
      window.__rec.push({ type, key: e.key, code: e.code, keyCode: e.keyCode, which: e.which,
        ctrl: e.ctrlKey === true, shift: e.shiftKey === true, alt: e.altKey === true, meta: e.metaKey === true,
        repeat: e.repeat === true, location: e.location, target: e.target && e.target.id ? e.target.id : null });
    }, true);
  }
  document.getElementById('inc').focus();
  return document.activeElement ? document.activeElement.id : null;
})()`;

const RECORD = 'window.__rec';

/** Wait until the page recorded an event matching `predicate`. */
async function waitForRecord(harness, predicate, { timeoutMs = 5000, label = 'record' } = {}) {
  const startedAt = Date.now();
  let last;
  while (Date.now() - startedAt < timeoutMs) {
    last = await evalValue(harness, RECORD);
    const match = Array.isArray(last) ? last.find(predicate) : undefined;
    if (match) return { match, records: last };
    await sleep(100);
  }
  throw new Error(`等待页面记录超时（${label}）：${JSON.stringify(last)}`);
}

function centerOf(harness, id) {
  return evalValue(harness, `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
}

function errorIs(result, code) {
  return result.ok === false && result.threw === true && result.error?.code === code
    && result.error?.category === 'input' && result.error?.retryable === false
    && typeof result.error?.message === 'string' && result.error.message.includes(`[${code}]`);
}

export async function inputModifiersProbe({ harness, check, fixture }) {
  const loaded = await navigateFixture(harness, fixture.url);
  check('P20 前置：可导航到 fixture 并加载完成', loaded.loaded === true, {
    expected: { ok: true, readyState: 'complete' },
    actual: loaded.navigation.error || loaded.navigation.value,
  });

  const focused = await evalValue(harness, INSTALL_RECORDER);
  check('页面记录器已安装且焦点在 #inc（Tab 顺序起点）', focused === 'inc', {
    expected: 'inc',
    actual: focused,
  });

  // --- Tab: forward focus traversal with a real virtualKeyCode -------------------------------
  const tab = await harness.invoke('browser_input', {
    events: [
      { kind: 'key', type: 'keyDown', key: 'Tab', code: 'Tab', virtualKeyCode: 9 },
      { kind: 'key', type: 'keyUp', key: 'Tab', code: 'Tab', virtualKeyCode: 9 },
    ],
  });
  const afterTab = await waitForEval(harness, 'document.activeElement && document.activeElement.id', (value) => value === 'name', { label: 'Tab focus' });
  check('无修饰键 Tab 让焦点前进：#inc → #name（页面 activeElement 真值）', tab.ok && tab.value?.ok === true && afterTab === 'name', {
    expected: { tool: { ok: true, applied: 2 }, activeElement: 'name' },
    actual: { tool: tab.error || tab.value, activeElement: afterTab },
  });
  const tabRecord = await waitForRecord(harness, (item) => item.type === 'keydown' && item.key === 'Tab');
  check('Tab keydown 的 e.keyCode 来自 virtualKeyCode=9', tabRecord.match.keyCode === 9 && tabRecord.match.code === 'Tab', {
    expected: { keyCode: 9, code: 'Tab' },
    actual: tabRecord.match,
  });

  // --- Shift+Tab: reverse focus traversal ---------------------------------------------------
  const shiftTab = await harness.invoke('browser_input', {
    events: [
      { kind: 'key', type: 'keyDown', key: 'Tab', code: 'Tab', virtualKeyCode: 9, modifiers: ['shift'] },
      { kind: 'key', type: 'keyUp', key: 'Tab', code: 'Tab', virtualKeyCode: 9, modifiers: ['shift'] },
    ],
  });
  const afterShiftTab = await waitForEval(harness, 'document.activeElement && document.activeElement.id', (value) => value === 'inc', { label: 'Shift+Tab focus' });
  check('Shift+Tab 让焦点反向移动：#name → #inc', shiftTab.ok && shiftTab.value?.ok === true && afterShiftTab === 'inc', {
    expected: { tool: { ok: true, applied: 2 }, activeElement: 'inc' },
    actual: { tool: shiftTab.error || shiftTab.value, activeElement: afterShiftTab },
  });
  const shiftTabRecord = await waitForRecord(harness, (item) => item.type === 'keydown' && item.key === 'Tab' && item.shift === true);
  check('Shift+Tab 的 keydown 带 e.shiftKey=true', shiftTabRecord.match.shift === true && shiftTabRecord.match.ctrl === false && shiftTabRecord.match.alt === false, {
    expected: { shift: true, ctrl: false, alt: false },
    actual: shiftTabRecord.match,
  });

  // --- Ctrl+A: modifier array form ----------------------------------------------------------
  const ctrlA = await harness.invoke('browser_input', {
    events: [
      { kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', virtualKeyCode: 65, text: 'a', modifiers: ['ctrl'] },
      { kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA', virtualKeyCode: 65, modifiers: ['ctrl'] },
    ],
  });
  const ctrlARecord = await waitForRecord(harness, (item) => item.type === 'keydown' && item.key === 'a' && item.code === 'KeyA');
  check("Ctrl+A 的页面 keydown 为 e.ctrlKey===true、e.key==='a'、e.keyCode=65", ctrlA.ok && ctrlA.value?.ok === true
    && ctrlARecord.match.ctrl === true && ctrlARecord.match.key === 'a' && ctrlARecord.match.keyCode === 65
    && ctrlARecord.match.shift === false && ctrlARecord.match.meta === false, {
    expected: { key: 'a', ctrl: true, shift: false, meta: false, keyCode: 65 },
    actual: { tool: ctrlA.error || ctrlA.value, record: ctrlARecord.match },
  });

  // --- Integer bitmask form (Ctrl=2 | Shift=8) ----------------------------------------------
  const bitmask = await harness.invoke('browser_input', {
    events: [
      { kind: 'key', type: 'keyDown', key: 'z', code: 'KeyZ', virtualKeyCode: 90, modifiers: 2 | 8 },
      { kind: 'key', type: 'keyUp', key: 'z', code: 'KeyZ', virtualKeyCode: 90, modifiers: 2 | 8 },
    ],
  });
  const bitmaskRecord = await waitForRecord(harness, (item) => item.type === 'keydown' && item.key === 'z');
  check('整数位掩码 modifiers=10 等价于 ctrl+shift（e.ctrlKey/e.shiftKey 均为 true）', bitmask.ok && bitmask.value?.ok === true
    && bitmaskRecord.match.ctrl === true && bitmaskRecord.match.shift === true && bitmaskRecord.match.alt === false && bitmaskRecord.match.meta === false
    && bitmaskRecord.match.keyCode === 90, {
    expected: { ctrl: true, shift: true, alt: false, meta: false, keyCode: 90 },
    actual: { tool: bitmask.error || bitmask.value, record: bitmaskRecord.match },
  });

  // --- autoRepeat passthrough ---------------------------------------------------------------
  await harness.invoke('browser_input', {
    events: [
      { kind: 'key', type: 'keyDown', key: 'x', code: 'KeyX', virtualKeyCode: 88 },
      { kind: 'key', type: 'keyDown', key: 'x', code: 'KeyX', virtualKeyCode: 88, autoRepeat: true },
      { kind: 'key', type: 'keyUp', key: 'x', code: 'KeyX', virtualKeyCode: 88 },
    ],
  });
  const repeatRecord = await waitForRecord(harness, (item) => item.type === 'keydown' && item.key === 'x' && item.repeat === true);
  check('autoRepeat:true 透传为页面 e.repeat===true', repeatRecord.match.repeat === true, {
    expected: { repeat: true },
    actual: repeatRecord.match,
  });

  // --- location passthrough (standard vs digits pad vs left/right) --------------------------
  await harness.invoke('browser_input', {
    events: [
      { kind: 'key', type: 'keyDown', key: '1', code: 'Numpad1', virtualKeyCode: 97, text: '1', location: 3, isKeypad: true },
      { kind: 'key', type: 'keyDown', key: 'Shift', code: 'ShiftLeft', virtualKeyCode: 16, location: 1 },
    ],
  });
  const numpadRecord = await waitForRecord(harness, (item) => item.type === 'keydown' && item.code === 'Numpad1');
  const shiftLeftRecord = await waitForRecord(harness, (item) => item.type === 'keydown' && item.code === 'ShiftLeft');
  check('location/isKeypad 透传：数字键盘 e.location=3、左 Shift e.location=1、虚拟键码 97/16', numpadRecord.match.location === 3
    && numpadRecord.match.keyCode === 97 && shiftLeftRecord.match.location === 1 && shiftLeftRecord.match.keyCode === 16, {
    expected: { numpad: { location: 3, keyCode: 97 }, shiftLeft: { location: 1, keyCode: 16 } },
    actual: { numpad: numpadRecord.match, shiftLeft: shiftLeftRecord.match },
  });

  // --- Mouse modifiers still produce the old click side effect -------------------------------
  const point = await centerOf(harness, 'inc');
  const beforeClick = await evalValue(harness, 'document.getElementById("counter").textContent');
  const shiftClick = await harness.invoke('browser_input', {
    events: [
      { kind: 'mouse', type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, modifiers: ['shift'] },
      { kind: 'mouse', type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, modifiers: ['shift'] },
    ],
  });
  const shiftDown = await waitForRecord(harness, (item) => item.type === 'mousedown' && item.target === 'inc' && item.shift === true);
  const afterClick = await waitForEval(harness, 'document.getElementById("counter").textContent', (value) => value !== beforeClick, { label: '#counter increment' });
  check('mouse modifiers=[shift] 的 mousedown 带 e.shiftKey=true，且点击副作用仍生效', shiftClick.ok && shiftClick.value?.ok === true
    && shiftDown.match.shift === true && Number(afterClick) === Number(beforeClick) + 1, {
    expected: { shift: true, counter: `${beforeClick} → +1` },
    actual: { tool: shiftClick.error || shiftClick.value, record: shiftDown.match, counter: afterClick },
  });

  // --- Wheel modifiers ----------------------------------------------------------------------
  const wheel = await harness.invoke('browser_input', {
    events: [{ kind: 'wheel', x: point.x, y: point.y, deltaY: 120, modifiers: ['ctrl'] }],
  });
  const wheelRecord = await waitForRecord(harness, (item) => item.type === 'wheel' && item.ctrl === true);
  check('wheel modifiers=[ctrl] 的 wheel 事件带 e.ctrlKey=true', wheel.ok && wheel.value?.ok === true && wheelRecord.match.ctrl === true, {
    expected: { ok: true, applied: 1, ctrl: true },
    actual: { tool: wheel.error || wheel.value, record: wheelRecord.match },
  });

  // --- Legacy minimal payloads must keep working --------------------------------------------
  const recordsBeforeLegacy = await evalValue(harness, 'window.__rec.length');
  const legacyKey = await harness.invoke('browser_input', { events: [{ kind: 'key', type: 'keyDown', key: 'A', code: 'KeyA' }] });
  const legacyKeyRecord = await waitForRecord(harness, (item) => item.type === 'keydown' && item.key === 'A');
  // Legacy mouse payload: the pre-N2 schema declared button/clickCount but not
  // buttons/modifiers/pointerType, so an old caller sends exactly these fields.
  const legacyMouse = await harness.invoke('browser_input', {
    events: [
      { kind: 'mouse', type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 },
      { kind: 'mouse', type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 },
    ],
  });
  const counterAfterLegacy = await waitForEval(harness, 'document.getElementById("counter").textContent', (value) => Number(value) > Number(afterClick), { label: 'legacy click' });
  check('老式最小 key 调用（只有 kind/type/key/code）仍可用并派发到页面', legacyKey.ok && legacyKey.value?.ok === true && legacyKey.value?.applied === 1
    && legacyKeyRecord.records.length > recordsBeforeLegacy && legacyKeyRecord.match.ctrl === false && legacyKeyRecord.match.shift === false, {
    expected: { ok: true, applied: 1, record: { key: 'A', ctrl: false, shift: false } },
    actual: { tool: legacyKey.error || legacyKey.value, record: legacyKeyRecord.match },
  });
  check('老式最小 mouse 调用（button/clickCount，无 buttons/modifiers/pointerType）仍可点击生效', legacyMouse.ok && legacyMouse.value?.ok === true && legacyMouse.value?.applied === 2
    && Number(counterAfterLegacy) === Number(afterClick) + 1, {
    expected: { ok: true, applied: 2, counter: 'increment by 1' },
    actual: { tool: legacyMouse.error || legacyMouse.value, counter: counterAfterLegacy },
  });

  // --- Invalid arguments: classified error objects, no event reaches the page ---------------
  const lengthBeforeInvalid = await evalValue(harness, 'window.__rec.length');
  const badName = await harness.invoke('browser_input', { events: [{ kind: 'key', type: 'keyDown', key: 'Tab', modifiers: ['hyper'] }] });
  const badType = await harness.invoke('browser_input', { events: [{ kind: 'key', type: 'keyDown', key: 'Tab', modifiers: 'ctrl' }] });
  const badMask = await harness.invoke('browser_input', { events: [{ kind: 'key', type: 'keyDown', key: 'Tab', modifiers: 16 }] });
  const badKeyType = await harness.invoke('browser_input', { events: [{ kind: 'key', type: 'keyPress', key: 'Tab' }] });
  const badPointerType = await harness.invoke('browser_input', { events: [{ kind: 'mouse', type: 'mouseMoved', x: point.x, y: point.y, pointerType: 'touch' }] });
  const lengthAfterInvalid = await evalValue(harness, 'window.__rec.length');

  check('非法修饰键名抛 INVALID_ARGUMENT（input 类、不可重试、消息带 [CODE]）', errorIs(badName, 'INVALID_ARGUMENT'), {
    expected: { code: 'INVALID_ARGUMENT', category: 'input', retryable: false },
    actual: badName.error || badName.value,
  });
  check('非法 modifiers 类型（字符串 "ctrl"）抛 INVALID_ARGUMENT', errorIs(badType, 'INVALID_ARGUMENT'), {
    expected: { code: 'INVALID_ARGUMENT' },
    actual: badType.error || badType.value,
  });
  check('越界位掩码 modifiers=16 抛 INVALID_ARGUMENT', errorIs(badMask, 'INVALID_ARGUMENT'), {
    expected: { code: 'INVALID_ARGUMENT' },
    actual: badMask.error || badMask.value,
  });
  check('非法 key.type（"keyPress"）抛 INVALID_ARGUMENT，只接受 keyDown/keyUp/rawKeyDown/char', errorIs(badKeyType, 'INVALID_ARGUMENT'), {
    expected: { code: 'INVALID_ARGUMENT', allowedTypes: ['keyDown', 'keyUp', 'rawKeyDown', 'char'] },
    actual: badKeyType.error || badKeyType.value,
  });
  check('非法 pointerType（"touch"）抛 INVALID_ARGUMENT', errorIs(badPointerType, 'INVALID_ARGUMENT'), {
    expected: { code: 'INVALID_ARGUMENT' },
    actual: badPointerType.error || badPointerType.value,
  });
  check('被拒绝的 5 次调用没有向页面派发任何事件（校验发生在启动/派发之前）', lengthAfterInvalid === lengthBeforeInvalid, {
    expected: lengthBeforeInvalid,
    actual: lengthAfterInvalid,
  });

  // --- The schema itself must declare the new fields (Agent discoverability) ----------------
  const definition = harness.tools.get('browser_input');
  const itemProperties = definition?.parameters?.properties?.events?.items?.properties || {};
  const requiredFields = ['kind', 'type', 'x', 'y', 'button', 'buttons', 'pointerType', 'clickCount', 'modifiers', 'key', 'code', 'text',
    'virtualKeyCode', 'autoRepeat', 'unmodifiedText', 'commands', 'location', 'isKeypad', 'deltaX', 'deltaY'];
  const missingFields = requiredFields.filter((name) => !itemProperties[name]);
  const modifiersSchema = itemProperties.modifiers || {};
  const modifierVariants = Array.isArray(modifiersSchema.oneOf) ? modifiersSchema.oneOf : [];
  const hasArrayForm = modifierVariants.some((variant) => variant.type === 'array' && ['alt', 'ctrl', 'meta', 'shift'].every((name) => (variant.items?.enum || []).includes(name)));
  // Host-pluggable schema subset forbids minimum/maximum: the 0–15 range is enforced at execution
  // time (the modifiers=16 INVALID_ARGUMENT check above).
  const hasMaskForm = modifierVariants.some((variant) => variant.type === 'integer');
  const keyTypeDescription = String(itemProperties.type?.description || '');
  check('browser_input schema 声明 modifiers/buttons/pointerType/virtualKeyCode 等全部新字段', missingFields.length === 0, {
    expected: requiredFields,
    actual: { missing: missingFields, declared: Object.keys(itemProperties) },
  });
  check('schema 的 modifiers 同时声明字符串数组与整数位掩码两种形式（范围在执行时校验）', hasArrayForm && hasMaskForm, {
    expected: { arrayOf: ['alt', 'ctrl', 'meta', 'shift'], integerForm: true },
    actual: modifiersSchema,
  });
  check('schema 的 key.type 描述列出四种合法类型，items.required 仍只有 kind', ['keyDown', 'keyUp', 'rawKeyDown', 'char'].every((type) => keyTypeDescription.includes(type))
    && JSON.stringify(definition?.parameters?.properties?.events?.items?.required) === JSON.stringify(['kind']), {
    expected: { descriptionMentions: ['keyDown', 'keyUp', 'rawKeyDown', 'char'], required: ['kind'] },
    actual: { description: keyTypeDescription, required: definition?.parameters?.properties?.events?.items?.required },
  });
}

/**
 * P20b — page-truth probes added by the T1 close-out (contract §9.4):
 *  - `commands:['selectAll']` must change the real selection (with a no-commands control run)
 *  - `unmodifiedText` must not be asserted via a DOM field that does not exist; only the visible
 *    input semantics are assertable (its unique effect stays INCONCLUSIVE when unobservable)
 *  - `pointerType:'pen'` must surface as `PointerEvent.pointerType === 'pen'` in the page, not
 *    merely as an accepted tool argument.
 * Inconclusive platform behaviour is recorded as an advisory finding, never folded into PASS.
 */
export async function inputPageTruthProbe({ harness, check, finding, fixture }) {
  const loaded = await navigateFixture(harness, fixture.url);
  if (!loaded.loaded) {
    check('P20b 前置：可导航到 fixture 并加载完成', false, { actual: loaded.navigation.error || loaded.navigation.value });
    return;
  }

  // --- commands: selectAll through the renderer's editing command path ----------------------
  const setup = await evalValue(harness, `(() => {
    document.getElementById('p20-probe')?.remove();
    const input = document.createElement('input');
    input.id = 'p20-probe';
    document.body.appendChild(input);
    input.value = 'abcdef';
    input.focus();
    input.setSelectionRange(3, 3);
    window.__p20 = [];
    for (const type of ['keydown', 'keyup', 'beforeinput', 'input']) {
      input.addEventListener(type, (e) => window.__p20.push({ type, key: e.key, code: e.code,
        data: e.data === undefined ? null : e.data, inputType: e.inputType === undefined ? null : e.inputType,
        ctrl: e.ctrlKey === true, shift: e.shiftKey === true,
        value: input.value, start: input.selectionStart, end: input.selectionEnd }), true);
    }
    return { active: document.activeElement.id, start: input.selectionStart, end: input.selectionEnd, value: input.value };
  })()`);
  check('P20b commands 前置：临时 input 聚焦且 selection=3/3', setup.active === 'p20-probe' && setup.start === 3 && setup.end === 3, setup);

  const runRawKeyDown = async (withCommand) => {
    await evalValue(harness, `(() => { const i = document.getElementById('p20-probe'); i.value = 'abcdef'; i.focus(); i.setSelectionRange(3, 3); window.__p20 = []; return true; })()`);
    const event = { kind: 'key', type: 'rawKeyDown', key: 'a', code: 'KeyA', virtualKeyCode: 65 };
    if (withCommand) event.commands = ['selectAll'];
    const sent = await harness.invoke('browser_input', { events: [event, { kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA', virtualKeyCode: 65 }] });
    const state = await evalValue(harness, `(() => { const i = document.getElementById('p20-probe');
      return { start: i.selectionStart, end: i.selectionEnd, value: i.value, active: document.activeElement.id, records: window.__p20.slice() }; })()`);
    return { sent, state };
  };
  const commandRun = await runRawKeyDown(true);
  const controlRun = await runRawKeyDown(false);
  const commandEffect = commandRun.state.start === 0 && commandRun.state.end === 6;
  const controlEffect = controlRun.state.start === 0 && controlRun.state.end === 6;
  check('P20b commands：rawKeyDown 携带 commands:["selectAll"] 使页面 selection=0/6（无 commands 对照仍 3/3）',
    commandRun.sent.ok === true && commandEffect && controlEffect === false,
    { commandRun: commandRun.state, controlRun: controlRun.state });
  if (!commandEffect || controlEffect) {
    finding({
      id: 'P20-commands-inconclusive', severity: 'info', advisory: true,
      summary: '当前平台未观察到 commands:["selectAll"] 的页面可编辑区效果（或对照也全选），按契约记 INCONCLUSIVE',
      evidence: { command: commandRun.state, control: controlRun.state },
    });
  }

  // --- unmodifiedText: only visible input semantics are assertable -------------------------
  const typeChar = async (withUnmodified) => {
    await evalValue(harness, `(() => { const i = document.getElementById('p20-probe'); i.value = ''; i.focus(); i.setSelectionRange(0, 0); window.__p20 = []; return true; })()`);
    const event = { kind: 'key', type: 'char', key: 'A', code: 'KeyA', text: 'A', modifiers: ['shift'], virtualKeyCode: 65 };
    if (withUnmodified) event.unmodifiedText = 'a';
    const sent = await harness.invoke('browser_input', { events: [event] });
    const state = await evalValue(harness, `(() => { const i = document.getElementById('p20-probe'); return { value: i.value, records: window.__p20.slice() }; })()`);
    return { sent, state };
  };
  const withUnmodified = await typeChar(true);
  const withoutUnmodified = await typeChar(false);
  const inputRecord = (run) => (run.state.records || []).find((entry) => entry.type === 'input') || null;
  const withInput = inputRecord(withUnmodified);
  const withoutInput = inputRecord(withoutUnmodified);
  check('P20b unmodifiedText：页面最终 value 与 input.data 均为 "A"，无额外小写 a',
    withUnmodified.sent.ok === true && withUnmodified.state.value === 'A' && withInput?.data === 'A',
    { withUnmodified: withUnmodified.state, withoutUnmodified: withoutUnmodified.state });
  if (JSON.stringify(withInput) === JSON.stringify(withoutInput)
    && withUnmodified.state.value === withoutUnmodified.state.value) {
    finding({
      id: 'P20-unmodifiedText-inconclusive', severity: 'info', advisory: true,
      summary: '传/不传 unmodifiedText 的页面可观察结果相同；DOM 无该字段，特有作用 INCONCLUSIVE（不伪造 DOM 字段）',
      evidence: { withUnmodified: withInput, withoutUnmodified: withoutInput },
    });
  }

  // --- pointerType: pen comes from the real PointerEvent ----------------------------------
  const pointerSetup = await evalValue(harness, `(() => {
    window.__ptr = [];
    const el = document.getElementById('inc');
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
      el.addEventListener(type, (e) => window.__ptr.push({ type, pointerType: e.pointerType,
        x: Math.round(e.clientX), y: Math.round(e.clientY), button: e.button, buttons: e.buttons }), true);
    }
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  const pen = await harness.invoke('browser_input', { events: [
    { kind: 'mouse', type: 'mouseMoved', x: pointerSetup.x, y: pointerSetup.y, button: 'none', clickCount: 0, pointerType: 'pen' },
    { kind: 'mouse', type: 'mousePressed', x: pointerSetup.x, y: pointerSetup.y, button: 'left', clickCount: 1, pointerType: 'pen' },
    { kind: 'mouse', type: 'mouseReleased', x: pointerSetup.x, y: pointerSetup.y, button: 'left', clickCount: 1, pointerType: 'pen' },
  ] });
  const penEvents = await evalValue(harness, 'window.__ptr.slice()');
  const penDowns = penEvents.filter((entry) => entry.type === 'pointerdown');
  check('P20b pointerType:pen → 页面 pointerdown.pointerType === "pen"（坐标/button/buttons 与顺序）',
    pen.ok === true && penDowns.length === 1 && penDowns[0].pointerType === 'pen'
    && penDowns[0].x === pointerSetup.x && penDowns[0].y === pointerSetup.y
    && penDowns[0].button === 0 && penDowns[0].buttons === 1
    && penEvents.findIndex((entry) => entry.type === 'pointermove') < penEvents.findIndex((entry) => entry.type === 'pointerdown')
    && penEvents.findIndex((entry) => entry.type === 'pointerdown') < penEvents.findIndex((entry) => entry.type === 'pointerup'),
    { penEvents, pointerSetup });
  await evalValue(harness, '(() => { window.__ptr = []; const c = document.getElementById("counter"); c.textContent = "0"; return true; })()');
  const mouse = await harness.invoke('browser_input', { events: [
    { kind: 'mouse', type: 'mouseMoved', x: pointerSetup.x, y: pointerSetup.y, button: 'none', clickCount: 0 },
    { kind: 'mouse', type: 'mousePressed', x: pointerSetup.x, y: pointerSetup.y, button: 'left', clickCount: 1 },
    { kind: 'mouse', type: 'mouseReleased', x: pointerSetup.x, y: pointerSetup.y, button: 'left', clickCount: 1 },
  ] });
  const mouseEvents = await evalValue(harness, 'window.__ptr.slice()');
  const mouseDowns = mouseEvents.filter((entry) => entry.type === 'pointerdown');
  check('P20b 默认 mouse 对照：页面 pointerdown.pointerType === "mouse"',
    mouse.ok === true && mouseDowns.length === 1 && mouseDowns[0].pointerType === 'mouse', { mouseEvents });
  await evalValue(harness, '(() => { document.getElementById("p20-probe")?.remove(); return true; })()');
}

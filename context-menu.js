/** Debug-panel context menu bridge. Chromium's browser UI is absent from page frames. */
import { randomUUID } from 'node:crypto';
import { BrowserError } from './browser-safety.js';

function frameOf(tree, id) {
  if (tree?.frame?.id === id) return tree.frame;
  for (const child of tree?.childFrames || []) {
    const found = frameOf(child, id);
    if (found) return found;
  }
  return null;
}
const stale = () => new BrowserError('INVALID_ARGUMENT', '右键目标已变化，请重新打开菜单', { reason: 'stale-target' });
const boundedText = (value) => typeof value === 'string' ? value.slice(0, 65536) : '';
function webUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
}

// Run in an isolated world of the hit frame. Retain the Event itself, then read its final
// cancellation flag in a separate CDP call AFTER dispatch; capture-time/microtask guesses are wrong.
export function contextProbeExpression(key, read = false) {
  const name = JSON.stringify(key);
  if (read) return `(() => {
    const probe = globalThis[${name}];
    if (!probe) return null;
    probe.dispose(); delete globalThis[${name}];
    const event = probe.event;
    if (!event || !event.isTrusted || event.eventPhase !== 0) return null;
    if (event.defaultPrevented) return { status: 'handled' };
    const node = probe.node;
    const el = node && node.nodeType === 1 ? node : node?.parentElement;
    if (!el || !el.isConnected) return null;
    const input = el.closest('input,textarea');
    const password = input?.type === 'password';
    let text = '';
    if (!password) {
      if (input && typeof input.selectionStart === 'number') text = String(input.value).slice(input.selectionStart, input.selectionEnd);
      else text = String(window.getSelection() || '');
    }
    const link = el.closest('a[href]');
    return { status: 'default', text: text.slice(0,65536), link: link?.href || '',
      image: el.tagName === 'IMG' ? el.currentSrc || el.src : '' };
  })()`;
  return `(() => {
    const probe = { event: null, node: null };
    const listener = event => { if (event.isTrusted && event.button === 2) { probe.event = event; probe.node = event.composedPath()[0]; } };
    window.addEventListener('contextmenu', listener, true);
    const timer = setTimeout(() => { probe.dispose(); delete globalThis[${name}]; }, 5000);
    probe.dispose = () => { clearTimeout(timer); window.removeEventListener('contextmenu', listener, true); };
    globalThis[${name}] = probe;
    return true;
  })()`;
}

export function contextItems(facts, history, pageUrl) {
  const items = [
    { id: 'back', label: '后退', disabled: !(history.currentIndex > 0) },
    { id: 'forward', label: '前进', disabled: !(history.currentIndex < (history.entries?.length || 0) - 1) },
    { id: 'reload', label: '重新加载' },
  ];
  const copy = (id, label, text) => { if (text) items.push({ id, label, text }); };
  copy('copy', '复制', boundedText(facts.text));
  copy('copy-link', '复制链接地址', webUrl(facts.link));
  copy('copy-image', '复制图片地址', webUrl(facts.image));
  copy('copy-page', '复制页面地址', webUrl(pageUrl));
  return items;
}

/** Called inside the same Runtime serial queue/GUI gate as input. x/y are viewport CSS px. */
export async function openPageContextMenu(runtime, { x, y, modifiers = 0 }, signal) {
  if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || !Number.isInteger(modifiers) || modifiers < 0 || modifiers > 15) {
    throw new BrowserError('INVALID_ARGUMENT', '右键坐标或修饰键无效');
  }
  runtime.panelContextMenu = null;
  await runtime.ensure(signal);
  const send = (method, params) => runtime.send(method, params, signal);
  const metrics = await send('Page.getLayoutMetrics', {});
  const view = metrics.cssLayoutViewport || metrics.layoutViewport;
  if (!view || x >= view.clientWidth || y >= view.clientHeight) throw new BrowserError('INVALID_ARGUMENT', '右键坐标超出页面');
  const tree = await send('Page.getFrameTree', {});
  let contextId, backendNodeId, frame, key;
  try {
    const hit = await send('DOM.getNodeForLocation', { x: Math.floor(x + view.pageX), y: Math.floor(y + view.pageY), includeUserAgentShadowDOM: false });
    frame = frameOf(tree.frameTree, hit.frameId || tree.frameTree.frame.id);
    backendNodeId = hit.backendNodeId;
    if (frame?.loaderId && backendNodeId) {
      const world = await send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'dsh-panel-context-menu' });
      contextId = world.executionContextId;
      key = '__dsh_context_' + randomUUID().replaceAll('-', '');
      const armed = await send('Runtime.evaluate', { contextId, expression: contextProbeExpression(key), returnByValue: true });
      if (armed.result?.value !== true || armed.exceptionDetails) contextId = null;
    }
  } catch { contextId = null; }
  let answer;
  try {
    await runtime.input([{ kind: 'mouse', type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1, modifiers }], signal);
  } finally {
    // One queued gesture always pairs the release, including cancellation and leaving the image.
    if (runtime.cdp && !runtime.cdp.closed) {
      await runtime.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1, modifiers });
    }
  }
  if (!contextId) return { status: 'unknown' };
  try {
    answer = await send('Runtime.evaluate', { contextId, expression: contextProbeExpression(key, true), returnByValue: true });
  } catch { return { status: 'unknown' }; }
  const facts = answer.result?.value;
  if (facts?.status === 'handled') return { status: 'handled' };
  if (facts?.status !== 'default') return { status: 'unknown' };
  const after = await send('Page.getFrameTree', {});
  if (frameOf(after.frameTree, frame.id)?.loaderId !== frame.loaderId || after.frameTree.frame.loaderId !== tree.frameTree.frame.loaderId) return { status: 'unknown' };
  const history = await send('Page.getNavigationHistory', {});
  const items = contextItems(facts, history, after.frameTree.frame.url);
  const token = randomUUID();
  runtime.panelContextMenu = { token, at: Date.now(), frameId: frame.id, loaderId: frame.loaderId,
    mainLoaderId: tree.frameTree.frame.loaderId, backendNodeId, contextId, items };
  return { status: 'default', menu: { token, items } };
}

/** Exact recent gesture and document required; never execute a client-supplied URL or script. */
export async function applyPageContextAction(runtime, request, signal) {
  const menu = runtime.panelContextMenu;
  if (!menu || request.token !== menu.token || Date.now() - menu.at > 60000) throw stale();
  const item = menu.items.find(item => item.id === request.action && !item.disabled);
  if (!item) throw new BrowserError('INVALID_ARGUMENT', '右键菜单项无效');
  const tree = await runtime.send('Page.getFrameTree', {}, signal);
  if (tree.frameTree.frame.loaderId !== menu.mainLoaderId || frameOf(tree.frameTree, menu.frameId)?.loaderId !== menu.loaderId) throw stale();
  runtime.panelContextMenu = null;
  if (item.text) return { text: item.text };
  if (item.id === 'reload') return runtime.reload(signal);
  if (item.id === 'back' || item.id === 'forward') return runtime.historyMove(item.id, signal);
  throw stale();
}

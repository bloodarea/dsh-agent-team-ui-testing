/** 页面右键菜单在预览区内的真实回归（宿主菜单阻断 + 右键派发给页面）。 */
export async function runPanelContextChecks(api) {
  const { fixtureUrl, pageEvaluate, hostEvalJson, measurePreview, hostState, screenPointFor,
    clickAt, centerOf, pressEscape, setAddressBar, waitFor, check, capturePng, observations, state } = api;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await pageEvaluate(`(() => {
    window.__contextTrace=[];
    const record=(type,data)=>window.__contextTrace.push({at:Date.now(),type,...data});
    const fetch=window.fetch;
    window.fetch=async(...args)=>{const response=await fetch(...args);if(String(args[0]).includes('/context-menu')){const json=await response.clone().json();record('response',{status:json.status,http:response.status,items:json.menu?.items.map(x=>x.id)});}return response;};
    document.addEventListener('scroll',e=>record('scroll',{tag:e.target?.tagName,cls:String(e.target?.className||''),root:e.target===document}),true);
    window.addEventListener('blur',()=>record('blur',{}));
    new MutationObserver(records=>{for(const r of records){for(const n of r.addedNodes)if(n.matches?.('[data-utb-context-menu]'))record('menu-add',{});for(const n of r.removedNodes)if(n.matches?.('[data-utb-context-menu]'))record('menu-remove',{});}}).observe(document.querySelector('.utb'),{subtree:true,childList:true});
    return true;
  })()`);
  await setAddressBar(fixtureUrl);
  await waitFor(async () => (await hostState()).ui?.address === fixtureUrl, { label: 'context fixture navigation' });
  await waitFor(async () => hostEvalJson(`document.title === '右键菜单回归靶机' && !!document.getElementById('ctx-zone')`), { label: 'context fixture document ready' });
  await waitFor(async () => pageEvaluate(`document.querySelector('[data-utb-pick-entry]')?.dataset.utbPickEntry === 'ready'`), { label: 'context preview ready' });

  // 面板侧记录：document 冒泡阶段的 contextmenu 是否还能收到（宿主菜单正是挂在这一层）。
  await pageEvaluate(`(() => {
    window.__ctxSeen = [];
    if (!window.__ctxProbe) {
      window.__ctxProbe = true;
      document.addEventListener('contextmenu', (event) => {
        window.__ctxSeen.push({
          target: event.target && String(event.target.className || event.target.tagName || ''),
          inStage: !!(event.target && event.target.closest && event.target.closest('.utb-stage')),
          prevented: event.defaultPrevented,
        });
      });
    }
    return true;
  })()`);

  const rightClickAt = async (point) => {
    await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
    await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'right', buttons: 2, clickCount: 1 });
    await sleep(90);
    await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'right', buttons: 0, clickCount: 1 });
    await sleep(220);
  };
  const docPointFor = async (expression) => {
    const rect = await hostEvalJson(expression);
    const snapshot = await hostState();
    const preview = await measurePreview();
    return { rect, point: screenPointFor(preview, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, snapshot.ui.view, snapshot.ui.canvas) };
  };
  const zoneRect = (id) => `(()=>{const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height}})()`;
  const hostMenu = () => pageEvaluate(`(()=>{const n=document.querySelector('[role="menu"]:not([data-utb-context-menu]), [data-context-menu]');return n?{tag:n.tagName,cls:String(n.className||'')}:null})()`);

  await pageEvaluate('window.__ctxSeen = []');
  await hostEvalJson('window.ctxEvents = []; window.ctxChosen = null; document.getElementById("ctx-menu").hidden = true; true');

  /* C1/C2：页面自绘菜单区 —— 右键进页面、宿主菜单不弹、页面菜单出现在帧里。 */
  const ctx = await docPointFor(zoneRect('ctx-zone'));
  observations.contextZone = ctx.rect;
  await rightClickAt(ctx.point);
  const pageEvents = await waitFor(async () => {
    const list = await hostEvalJson('window.ctxEvents.slice()');
    return list.some((entry) => entry.type === 'contextmenu') ? list : null;
  }, { label: 'page receives contextmenu inside preview' });
  const ctxEvent = pageEvents.find((entry) => entry.type === 'contextmenu');
  const menuState = await hostEvalJson(`(()=>{const m=document.getElementById('ctx-menu');const r=m.getBoundingClientRect();return {hidden:m.hidden,left:r.x,top:r.y,point:window.ctxMenuPoint}})()`);
  observations.contextPageEvents = pageEvents.slice(-6);
  observations.contextMenuState = menuState;
  check('C1', '预览区右键前进到页面：mousedown/contextmenu/mouseup 都是 button=2 且坐标命中点击点',
    ctxEvent.button === 2 && ctxEvent.buttons === 2 && ctxEvent.trusted === true && ctxEvent.target === 'ctx-zone'
      && Math.abs(ctxEvent.clientX - (ctx.rect.width ? (ctx.rect.x + ctx.rect.width / 2) : ctxEvent.clientX)) <= 2
      && pageEvents.some((entry) => entry.type === 'mousedown' && entry.button === 2)
      && pageEvents.some((entry) => entry.type === 'mouseup' && entry.button === 2),
    'button=2, contextmenu at click point', { contextmenu: ctxEvent, events: pageEvents.slice(-4) });
  check('C2', '页面自绘菜单真的打开了，且贴在右键位置（页面像素里可见）',
    menuState.hidden === false
      && Math.abs(menuState.point.x - ctxEvent.clientX) <= 1 && Math.abs(menuState.point.y - ctxEvent.clientY) <= 1,
    'ctx-menu visible at click point', menuState);
  await capturePng('context-menu-open.png');
  const hostMenuAfterPageClick = await hostMenu();
  const panelSeen = await pageEvaluate('window.__ctxSeen.slice()');
  observations.contextHostMenu = hostMenuAfterPageClick;
  observations.contextPanelSeen = panelSeen;
  check('C3', '预览内右键不再弹宿主菜单（面板 DOM 里没有 menu，document 也收不到 contextmenu）',
    hostMenuAfterPageClick === null && panelSeen.length === 0,
    { hostMenu: null, panelContextmenuEvents: 0 }, { hostMenu: hostMenuAfterPageClick, panelSeen });

  /* C4：点页面菜单项 —— 菜单项是页面 DOM，走正常左键派发。 */
  // 菜单项在页面文档里（不是面板 DOM）：按页面矩形换算屏幕坐标再点。
  const itemDoc = await docPointFor(`(()=>{const r=document.getElementById('ctx-item-a').getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height}})()`);
  observations.contextMenuItem = itemDoc.rect;
  await clickAt(itemDoc.point.x, itemDoc.point.y);
  const chosen = await waitFor(async () => {
    const value = await hostEvalJson('window.ctxChosen');
    return value ? value : null;
  }, { label: 'page menu item click' });
  check('C4', '点页面菜单项生效（页面拿到 click，菜单收起）',
    chosen === 'a' && (await hostEvalJson('document.getElementById("ctx-menu").hidden')) === true,
    'ctxChosen=a, menu hidden', { chosen, hidden: await hostEvalJson('document.getElementById("ctx-menu").hidden') });
  await capturePng('context-menu-chosen.png');

  /* C5：页面允许默认菜单时，在面板显示真实可操作的菜单。 */
  await pageEvaluate('window.__ctxSeen = []');
  await hostEvalJson('window.ctxEvents = []');
  const plain = await docPointFor(zoneRect('plain-zone'));
  await rightClickAt(plain.point);
  const plainEvents = await waitFor(async () => {
    const list = await hostEvalJson('window.ctxEvents.slice()');
    return list.some((entry) => entry.type === 'contextmenu') ? list : null;
  }, { label: 'page receives default contextmenu' });
  const plainCtx = plainEvents.find((entry) => entry.type === 'contextmenu');
  observations.contextPlainEvents = plainEvents.slice(-4);
  await waitFor(() => pageEvaluate(`!!document.querySelector('[data-utb-context-menu="default"]')`), { label: 'default panel menu visible' });
  const fallback = await pageEvaluate(`(()=>{const n=document.querySelector('[data-utb-context-menu]'),r=n.getBoundingClientRect();return {role:n.role,focused:document.activeElement===n,items:Array.from(n.querySelectorAll('[data-utb-context-action]')).map(x=>x.dataset.utbContextAction),rect:{x:r.x,y:r.y,width:r.width,height:r.height}}})()`);
  observations.contextFallback = fallback;
  check('C5', '无处理器区域显示面板默认菜单，页面事件可信且宿主菜单被阻断',
    plainCtx.button === 2 && plainCtx.prevented === false && plainCtx.target === 'plain-zone'
      && fallback.focused && fallback.items.includes('reload') && fallback.items.includes('copy-page')
      && (await hostMenu()) === null && (await pageEvaluate('window.__ctxSeen.length')) === 0,
    'default menu focused, no host menu', { plainCtx, fallback });
  await capturePng('context-default-menu.png');
  const siblingScroll = await pageEvaluate(`(()=>{const node=document.createElement('div');document.body.append(node);node.dispatchEvent(new Event('scroll'));node.remove();return !!document.querySelector('[data-utb-context-menu]')})()`);
  check('C11', '宿主其他区域滚动不会关闭预览里的菜单', siblingScroll, true, siblingScroll);

  // Real menu action: reload must reset the page ledger, not just hide the menu.
  const reloadPoint = await centerOf(`document.querySelector('[data-utb-context-action="reload"]')`);
  await clickAt(reloadPoint.x, reloadPoint.y);
  await waitFor(() => hostEvalJson('Array.isArray(window.ctxEvents) && window.ctxEvents.length === 0'), { label: 'context reload fresh document' });
  check('C7', '默认菜单重新加载确实刷新页面并收起菜单',
    !(await pageEvaluate(`!!document.querySelector('[data-utb-context-menu]')`)), false, false);
  await waitFor(() => pageEvaluate(`document.querySelector('[data-utb-pick-entry]')?.dataset.utbPickEntry === 'ready'`), { label: 'reloaded context preview ready' });

  // Reload/reopen repeatedly without retries: a transaction must adopt its own document state,
  // instead of opening against a stale polling snapshot then disappearing when the next poll arrives.
  for (let round = 0; round < 3; round++) {
    await rightClickAt((await docPointFor(zoneRect('plain-zone'))).point);
    await waitFor(() => pageEvaluate(`!!document.querySelector('[data-utb-context-menu]')`), { label: 'menu after reload round ' + round });
    await sleep(600); // span a /state poll, not a retry of a missing menu
    const stays = await pageEvaluate(`!!document.querySelector('[data-utb-context-menu]')`);
    check('C14.' + round, '刷新后菜单跨状态轮询保持可见（第 ' + (round + 1) + ' 次）', stays, true, stays);
    const point = await centerOf(`document.querySelector('[data-utb-context-action="reload"]')`);
    await clickAt(point.x, point.y);
    await waitFor(() => hostEvalJson('ctxEvents.length === 0'), { label: 'reload fresh document round ' + round });
  }

  // Keyboard navigation and clipboard bridge. Clipboard permission is granted only to this test GUI origin.
  const guiOrigin = await pageEvaluate('location.origin');
  await state.chrome.cdp.send('Browser.grantPermissions', { origin: guiOrigin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  const plainAfterReload = await docPointFor(zoneRect('plain-zone'));
  await rightClickAt(plainAfterReload.point);
  await waitFor(() => pageEvaluate(`!!document.querySelector('[data-utb-context-menu]')`), { label: 'menu reopened' });
  const menuKey = async (key, code) => {
    await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code });
    await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
  };
  await menuKey('End', 35);
  await menuKey('ArrowUp', 38);
  await menuKey('ArrowDown', 40);
  const activeAction = await pageEvaluate(`(()=>{const n=document.querySelector('[data-utb-context-menu]');return document.getElementById(n.getAttribute('aria-activedescendant'))?.dataset.utbContextAction})()`);
  check('C12', '菜单方向键和 End 实际移动当前项，且不穿透目标页', activeAction === 'copy-page', 'copy-page', activeAction);
  await menuKey('Enter', 13);
  const copied = await waitFor(() => pageEvaluate(`navigator.clipboard.readText()`), { label: 'context clipboard write' });
  check('C8', '复制页面地址写入 GUI 剪贴板', copied === fixtureUrl, fixtureUrl, copied);

  await rightClickAt((await docPointFor(zoneRect('plain-zone'))).point);
  await waitFor(() => pageEvaluate(`!!document.querySelector('[data-utb-context-menu]')`), { label: 'menu before Escape' });
  await pressEscape();
  check('C9', 'Escape 关闭默认菜单并恢复预览焦点',
    await pageEvaluate(`!document.querySelector('[data-utb-context-menu]') && document.activeElement===document.querySelector('.utb-frame')`), true, true);

  // Down outside image after press: Host already released at the original point, no stuck button.
  await hostEvalJson('window.ctxEvents=[];true');
  const releasePoint = (await docPointFor(zoneRect('plain-zone'))).point;
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: releasePoint.x, y: releasePoint.y, button: 'right', buttons: 2, clickCount: 1 });
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 2, button: 'right', buttons: 0, clickCount: 1 });
  const released = await waitFor(async () => { const list=await hostEvalJson('ctxEvents.slice()');return list.some(x=>x.type==='mouseup')?list:null; }, { label:'right release despite leaving preview' });
  check('C10', '右键在画面外抬起仍完整释放，且没有重复页面事务', released.filter(x=>x.type==='mousedown').length===1 && released.filter(x=>x.type==='mouseup').length===1, 'one down / one up', released);
  await pressEscape();

  await pageEvaluate(`(()=>{window.__contextClipboardWrite=navigator.clipboard.writeText;Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:()=>Promise.reject(new Error('test permission denied'))});return true})()`);
  try {
    await rightClickAt((await docPointFor(zoneRect('plain-zone'))).point);
    await waitFor(() => pageEvaluate(`!!document.querySelector('[data-utb-context-menu]')`), { label: 'menu before clipboard refusal' });
    const point = await centerOf(`document.querySelector('[data-utb-context-action="copy-page"]')`);
    await clickAt(point.x, point.y);
    const refusal = await waitFor(() => pageEvaluate(`document.querySelector('.utb')?.textContent.includes('无法访问剪贴板')`), { label: 'clipboard refusal shown' });
    check('C13', '剪贴板权限失败会反馈，不报告复制成功', refusal, true, refusal);
  } finally {
    await pageEvaluate(`(()=>{delete navigator.clipboard.writeText;delete window.__contextClipboardWrite;return true})()`);
  }

  /* C6：宿主菜单的对照 —— 预览外（面板工具栏）右键仍冒泡到 document，说明阻断只在视图内部。 */
  await pageEvaluate('window.__ctxSeen = []');
  const outside = await pageEvaluate(`(()=>{const n=document.querySelector('[data-utb-pick-entry]')||document.querySelector('.utb-bar');if(!n)return null;const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  if (outside) {
    await rightClickAt(outside);
    await sleep(150);
    const seenOutside = await pageEvaluate('window.__ctxSeen.slice()');
    observations.contextOutside = { point: outside, seen: seenOutside };
    check('C6', '预览外的右键不受影响：document 仍收到 contextmenu（阻断只限视图内部）',
      seenOutside.length >= 1 && seenOutside[0].inStage === false,
      'outside event reaches document', seenOutside);
  } else {
    check('C6', '预览外的右键对照点可用', false, 'pick entry button present', null);
  }
  await pressEscape();
}

/** 页面右键菜单在预览区内的真实回归（宿主菜单阻断 + 右键派发给页面）。 */
export async function runPanelContextChecks(api) {
  const { fixtureUrl, pageEvaluate, hostEvalJson, measurePreview, hostState, screenPointFor,
    clickAt, centerOf, pressEscape, setAddressBar, waitFor, check, capturePng, observations, state } = api;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  const hostMenu = () => pageEvaluate(`(()=>{const n=document.querySelector('[role="menu"], [data-context-menu]');return n?{tag:n.tagName,cls:String(n.className||'')}:null})()`);

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

  /* C5：没有菜单处理的区域 —— 右键照样进页面（原生默认菜单由浏览器 UI 绘制，不在帧里）。 */
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
  check('C5', '无处理器区域同样是页面事件（button=2、页面未阻止默认），宿主菜单仍不弹',
    plainCtx.button === 2 && plainCtx.prevented === false && plainCtx.target === 'plain-zone'
      && (await hostMenu()) === null && (await pageEvaluate('window.__ctxSeen.length')) === 0,
    'page default contextmenu, no host menu', { plainCtx, panelSeen: await pageEvaluate('window.__ctxSeen.slice()') });

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

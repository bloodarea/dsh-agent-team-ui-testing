/** Real panel/Host regression checks, shared with the element-picker GUI harness. */
export async function runPanelSelectChecks(api) {
  const { fixtureUrl, pageEvaluate, hostEvalJson, pageHostFetch, jsonHeaders, measurePreview,
    hostState, screenPointFor, clickAt, centerOf, pressEscape, setAddressBar, waitFor, check,
    capturePng, observations, state } = api;
  await setAddressBar(fixtureUrl);
  await waitFor(async () => (await hostState()).ui?.address === fixtureUrl, { label: 'select fixture navigation' });
  await waitFor(async () => hostEvalJson(`document.title === '原生下拉浮层回归靶机' && !!document.getElementById('space')`), { label: 'select fixture document ready' });
  await waitFor(async () => pageEvaluate(`document.querySelector('.utb')?.dataset.utbReady === 'true' || document.querySelector('[data-utb-pick-entry]')?.dataset.utbPickEntry === 'ready'`), { label: 'select preview ready' });
  const truth = () => hostEvalJson(`({values:Array.from(document.querySelectorAll('select')).map(s=>({id:s.id,value:s.value,index:s.selectedIndex})),events:window.selectEvents.slice()})`);
  const clickControl = async (id) => {
    const rect = await hostEvalJson(`(()=>{const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return {x:r.x+scrollX+r.width/2,y:r.y+scrollY+r.height/2}})()`);
    const snapshot = await hostState();
    const preview = await measurePreview();
    const point = screenPointFor(preview, rect, snapshot.ui.view, snapshot.ui.canvas);
    await clickAt(point.x, point.y);
  };
  const readPop = () => pageEvaluate(`(()=>{const p=document.querySelector('[data-utb-select-pop]');return p?{state:p.dataset.utbSelectPop,items:Array.from(p.querySelectorAll('[role=option]')).map(n=>({text:n.textContent,value:n.dataset.utbSelectValue,disabled:n.getAttribute('aria-disabled')})),rect:(()=>{const r=p.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()}:null})()`);
  // 面板在刚导航/刚滚动的瞬间可能还没收到第一帧或指针事件，单次点击偶尔会落空；重试不改语义
  // （功能真坏了三次都开不出来），只是去掉这类环境抖动。
  const open = async id => {
    let last = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await clickControl(id);
      try {
        return await waitFor(readPop, { label: `select popover ${id}`, timeoutMs: 5000 });
      } catch (error) {
        last = error;
        await pressEscape();
        await pageEvaluate('new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,120)))');
      }
    }
    throw last;
  };
  const choose = async index => {
    const point = await centerOf(`document.querySelectorAll('[data-utb-select-item]')[${index}]`);
    await clickAt(point.x, point.y);
    await waitFor(async () => !(await readPop()), { label: 'select closes after choice' });
  };
  await pageEvaluate('window.getSelection()?.removeAllRanges()');
  const first = await open('space');
  check('S1', 'native select renders real panel options', first.items.map(x=>x.text).join('|') === 'Parent|World|Local', 'Parent|World|Local', first);
  await capturePng('select-open.png');
  const lastRequest = state.elementTraffic.at(-1);
  if (lastRequest) {
    const body = await state.chrome.cdp.send('Network.getResponseBody', { requestId: lastRequest.requestId });
    observations.selectElementResponse = JSON.parse(body.body);
    check('S2', '/element response contains authored select and target identity', observations.selectElementResponse.element?.tag === 'select' && !!observations.selectElementResponse.element?.select?.target?.loaderId, 'select + target', observations.selectElementResponse);
  }
  await choose(1);
  let observed = await waitFor(async () => { const t=await truth();return t.values.find(x=>x.id==='space')?.value==='world'?t:null; }, { label: 'World readback' });
  check('S3', 'choice reaches page with exactly input then change', JSON.stringify(observed.events) === JSON.stringify([{type:'input',id:'space',value:'world',index:1},{type:'change',id:'space',value:'world',index:1}]), 'input/change once', observed);
  check('S4', 'choice restores preview keyboard focus', await pageEvaluate(`document.activeElement === document.querySelector('.utb-frame')`), true, await pageEvaluate('document.activeElement.tagName'));
  await open('duplicate'); await choose(1);
  observed = await waitFor(async () => { const t=await truth();return t.values.find(x=>x.id==='duplicate')?.index===1?t:null; }, { label: 'duplicate value second option' });
  check('S5', 'duplicate value selects exact second option', observed.values.find(x=>x.id==='duplicate').index === 1, 1, observed);
  const disabled = await open('disabled');
  check('S6', 'disabled option and optgroup are unavailable', disabled.items[1].disabled === 'true' && disabled.items[2].disabled === 'true', [true,true], disabled);
  const before = await truth(); await chooseDisabled(2);
  check('S7', 'clicking disabled group does not write or close', JSON.stringify(await truth()) === JSON.stringify(before) && !!(await readPop()), before, await truth());
  await pressEscape();
  await waitFor(async () => !(await readPop()), { label: 'Escape closes select' });
  check('S8', 'Escape restores preview focus', await pageEvaluate(`document.activeElement === document.querySelector('.utb-frame')`), true, await pageEvaluate('document.activeElement.tagName'));
  await clickControl('multiple');
  const multi = await waitFor(() => pageEvaluate(`(()=>{const n=document.querySelector('[data-utb-select-unsupported]'),img=document.querySelector('.utb-frame'),bar=document.querySelector('.utb-bar');if(!n||!img||!bar)return null;const r=n.getBoundingClientRect(),p=img.getBoundingClientRect(),b=bar.getBoundingClientRect();return {reason:n.dataset.utbSelectUnsupported,noteBottom:r.bottom,previewTop:p.top,noteTop:r.top,addressBottom:b.bottom,inPreview:!!n.closest('.utb-stage'),focused:document.activeElement===img,position:getComputedStyle(n).position}})()`), {label:'unsupported notice outside preview'});
  check('S9', 'multiple shape shows keyboard hint outside preview below address bar', multi.reason === 'multiple' && !multi.inPreview && multi.noteBottom <= multi.previewTop && multi.noteTop >= multi.addressBottom && multi.position === 'static', 'normal-flow note between address and preview', multi);
  check('S9a', 'unsupported hint does not create a listbox or take keyboard focus', !(await readPop()) && multi.focused, 'no popover, preview focused', multi);
  observations.selectUnsupportedNotice = multi;
  await capturePng('select-unsupported-outside.png');
  await pageEvaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  await pageEvaluate(`(()=>{
    const notice=document.querySelector('[data-utb-select-unsupported]');
    const stage=document.querySelector('.utb-stage'),image=document.querySelector('.utb-frame');
    const geometry=()=>[stage,image].flatMap(n=>{const r=n.getBoundingClientRect();return [r.x,r.y,r.width,r.height]});
    const baseline=geometry();
    const monitor=window.__selectHintRepeat={notice,removals:0,replacements:0,samples:0,maxDeviation:0};
    monitor.observer=new MutationObserver(records=>{for(const r of records)for(const n of r.removedNodes){if(n===notice||n.contains?.(notice))monitor.removals++}});
    monitor.observer.observe(document.querySelector('.utb'),{subtree:true,childList:true});
    const sample=()=>{monitor.samples++;monitor.maxDeviation=Math.max(monitor.maxDeviation,...geometry().map((v,i)=>Math.abs(v-baseline[i])));if(document.querySelector('[data-utb-select-unsupported]')!==notice)monitor.replacements++;monitor.frame=requestAnimationFrame(sample)};
    sample();
  })()`);
  for (const id of ['multiple','multiple','list','multiple']) {
    const previousRequests = state.elementTraffic.length;
    await clickControl(id);
    await waitFor(() => state.elementTraffic.length > previousRequests && state.elementTraffic.at(-1)?.status === 200, { label: 'repeat hint probe completes' });
    await pageEvaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  }
  const repeated = await pageEvaluate(`(()=>{const m=window.__selectHintRepeat;cancelAnimationFrame(m.frame);m.observer.disconnect();return {removals:m.removals,replacements:m.replacements,samples:m.samples,maxDeviation:m.maxDeviation,sameNotice:document.querySelector('[data-utb-select-unsupported]')===m.notice}})()`);
  observations.selectHintRepeat = repeated;
  check('S9b', 'visible hint is not removed or replaced by repeated unsupported clicks', repeated.sameNotice && repeated.removals===0 && repeated.replacements===0, 'one unchanged hint node', repeated);
  check('S9c', 'preview geometry stays fixed throughout repeated hint triggers', repeated.samples>2 && repeated.maxDeviation<=0.5, 'max deviation <=0.5 CSS px', repeated);
  const beforeKey = (await truth()).values.find(x=>x.id==='multiple').index;
  const expectedIndex = Math.min(2, beforeKey + 1);
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40 });
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type:'keyUp',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40 });
  await waitFor(async () => (await truth()).values.find(x=>x.id==='multiple').index === expectedIndex, { label: 'unsupported shape keyboard forwarding' });
  check('S10', 'unsupported shape still forwards keyboard to page', beforeKey !== expectedIndex && (await truth()).values.find(x=>x.id==='multiple').index === expectedIndex, expectedIndex, await truth());
  await pressEscape();
  await waitFor(async () => pageEvaluate(`!document.querySelector('[data-utb-select-unsupported]')`), {label:'Escape dismisses unsupported notice'});
  check('S10a', 'Escape dismisses the outside hint', await pageEvaluate(`!document.querySelector('[data-utb-select-unsupported]')`), true, true);
  await clickControl('multiple');
  await waitFor(() => pageEvaluate(`!!document.querySelector('[data-utb-select-unsupported]')`), {label:'hint can trigger after dismissal'});
  check('S10b', 'hint may trigger again after dismissal', await pageEvaluate(`document.querySelector('[data-utb-select-unsupported]')!==window.__selectHintRepeat.notice`), true, true);
  await open('space');
  check('S10c', 'normal select can still open while an unsupported hint is visible', await pageEvaluate(`!document.querySelector('[data-utb-select-unsupported]') && !!document.querySelector('[data-utb-select-pop]')`), true, true);
  await hostEvalJson(`document.getElementById('duplicate').focus()`);
  await choose(2);
  observed = await waitFor(async () => { const t=await truth();return t.values.find(x=>x.id==='space').value==='local'?t:null; }, { label: 'bound target after focus change' });
  check('S11', 'focus change cannot redirect a popover write', observed.values.find(x=>x.id==='space').value==='local' && observed.values.find(x=>x.id==='duplicate').index===1, 'space=local, duplicate index=1', observed);
  const long = await open('long');
  check('S12', 'large list is bounded at 200 options', long.items.length === 200, 200, {count:long.items.length});
  await pressEscape();

  /* ---- iframe 内的 <select>：Host 只给可核验的子 frame 命中，浮层与写回必须照旧工作 ---- */
  const syncScroll = async (label) => {
    await waitFor(async () => {
      const live = await hostEvalJson('scrollY');
      const snapshot = await hostState();
      return Number.isFinite(live) && Math.abs(Number(snapshot.ui?.view?.y) - live) <= 1;
    }, { label });
    const snapshot = await hostState();
    const preview = await measurePreview();
    return { snapshot, preview };
  };
  await hostEvalJson(`document.getElementById('frame').scrollIntoView({block:'center',inline:'nearest'})`);
  let frameSync = await syncScroll('iframe scrolled into view');
  const frameSelect = await hostEvalJson(`(()=>{const f=document.getElementById('frame');const fr=f.getBoundingClientRect();const s=f.contentDocument.getElementById('inner');const r=s.getBoundingClientRect();return {x:fr.x+r.x+scrollX,y:fr.y+r.y+scrollY,width:r.width,height:r.height,mainSelectorHits:!!document.querySelector('#inner')}})()`);
  observations.selectIframeTarget = frameSelect;
  const frameDocPoint = {x:frameSelect.x+frameSelect.width/2, y:frameSelect.y+frameSelect.height/2};
  const frameClick = screenPointFor(frameSync.preview, frameDocPoint, frameSync.snapshot.ui.view, frameSync.snapshot.ui.canvas);
  observations.selectIframeClick = { docPoint: frameDocPoint, screenPoint: frameClick, preview: frameSync.preview.painted, view: frameSync.snapshot.ui.view, canvas: frameSync.snapshot.ui.canvas };
  // 先做一次样式化的指针移动：面板会按它自己的映射发一次 hover 命中，用它的 doc 坐标核对映射。
  const trafficBeforeHover = state.elementTraffic.length;
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:frameClick.x, y:frameClick.y, buttons:0 });
  await pageEvaluate('new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,250)))');
  const hoverEntry = state.elementTraffic.slice(trafficBeforeHover).find((entry) => String(entry.method || 'POST') === 'POST');
  const panelHitTest = await pageEvaluate(`(()=>{const n=document.elementFromPoint(${frameClick.x},${frameClick.y});const img=document.querySelector('.utb-frame');const r=img.getBoundingClientRect();return {tag:n&&n.tagName,cls:n&&String(n.className||''),isImage:n===img,insideImage:!!(img&&img.contains(n)),imgRect:{x:r.x,y:r.y,w:r.width,h:r.height}}})()`);
  observations.selectIframeMapping = { click: frameClick, docPoint: frameDocPoint, hoverPostData: hoverEntry?.postData || null, panelHitTest };
  let framePop = null;
  for (let attempt = 0; attempt < 3 && !framePop; attempt += 1) {
    await clickAt(frameClick.x, frameClick.y);
    try {
      framePop = await waitFor(readPop, {label:'iframe select popover', timeoutMs:5000});
    } catch {
      framePop = null;
      await pressEscape();
      await pageEvaluate('new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,120)))');
    }
  }
  if (!framePop) {
    // 失败诊断：Host 对同一点的真实投影、iframe 内焦点、面板浮层 DOM、最近 /element 流量。
    const hostProjection = await pageHostFetch('/element', {method:'POST', headers:jsonHeaders(), body:frameDocPoint}).catch((error) => ({error:String(error && error.message || error)}));
    const iframeFocus = await hostEvalJson(`(()=>{const d=document.getElementById('frame').contentDocument;return {active:d.activeElement&&d.activeElement.id,value:d.getElementById('inner').value}})()`);
    const panelPop = await pageEvaluate(`(()=>{const p=document.querySelector('[data-utb-select-pop]');const n=document.querySelector('[data-utb-select-unsupported]');return {pop:p?p.dataset.utbSelectPop:null,items:document.querySelectorAll('[data-utb-select-item]').length,note:n?n.dataset.utbSelectUnsupported:null}})()`);
    const traffic = state.elementTraffic.slice(-3).map((entry) => ({ status: entry.status, postData: entry.postData, failure: entry.failure }));
    observations.selectIframeDiagnostics = { hostProjection: hostProjection.json || hostProjection, iframeFocus, panelPop, traffic };
  }
  check('S16', 'iframe 内 <select> 打开真实面板选项', (framePop?.items || []).map(x=>x.text).join('|') === 'iframe-A|iframe-B', 'iframe-A|iframe-B', framePop || observations.selectIframeDiagnostics);
  await capturePng('select-iframe-open.png');
  const frameRequest = state.elementTraffic.at(-1);
  if (frameRequest) {
    try {
      const body = await state.chrome.cdp.send('Network.getResponseBody', { requestId: frameRequest.requestId });
      observations.selectIframeResponse = JSON.parse(body.body);
    } catch { observations.selectIframeResponse = null; }
  }
  const frameElement = observations.selectIframeResponse?.element || null;
  check('S16a', '/element 对 iframe 命中给出子 frame 标识与该 frame 的 target',
    frameElement?.frame?.main === false && typeof frameElement?.frame?.id === 'string' && frameElement.frame.id.length > 0
      && !!frameElement?.select?.target?.loaderId && frameSelect.mainSelectorHits === false,
    'frame.main=false, frame.id, child loaderId, main document has no #inner', frameElement && {frame:frameElement.frame, target:frameElement.select?.target, mainSelectorHits:frameSelect.mainSelectorHits});
  check('S16b', 'iframe 命中的 selector 属于该 frame 文档（主文档同名选择器不存在）', frameSelect.mainSelectorHits === false, false, frameSelect.mainSelectorHits);
  const mainSpaceBefore = (await truth()).values.find(x=>x.id==='space');
  await choose(1);
  const frameTruth = () => hostEvalJson(`(()=>{const d=document.getElementById('frame').contentDocument;return {value:d.getElementById('inner').value,index:d.getElementById('inner').selectedIndex,events:d.defaultView.frameSelectEvents.slice()}})()`);
  const frameObserved = await waitFor(async () => { const t = await frameTruth(); return t.value === 'frame-b' ? t : null; }, { label: 'iframe option readback' });
  check('S17', 'iframe 内选中的值写回该 frame 的 <select>，input/change 各一次',
    frameObserved.index === 1 && JSON.stringify(frameObserved.events) === JSON.stringify([{type:'input',value:'frame-b',index:1},{type:'change',value:'frame-b',index:1}]),
    'frame-b, input/change once', frameObserved);
  const mainAfter = (await truth()).values.find(x=>x.id==='space');
  check('S17a', 'iframe 写回不触碰主文档 select', JSON.stringify(mainAfter) === JSON.stringify(mainSpaceBefore), mainSpaceBefore, mainAfter);
  observations.selectIframe = frameObserved;
  await hostEvalJson('scrollTo(0, 0)');
  await syncScroll('scroll back to top');
  await open('space');
  const target = observations.selectElementResponse.element.select.target;
  await setAddressBar(fixtureUrl + '?next-document');
  await waitFor(async () => !(await readPop()), { label: 'navigation invalidates popover' });
  const rejected = await pageHostFetch('/select', {method:'POST',headers:jsonHeaders(),body:{value:'world',optionIndex:1,target}});
  check('S13', 'navigation rejects old document target with zero write', rejected.status===400 && rejected.json.details?.reason==='stale-target' && (await truth()).events.length===0, '400 stale-target, zero events', rejected);
  await clickControl('keyboard');
  for (const type of ['keyDown', 'keyUp']) await state.chrome.cdp.send('Input.dispatchKeyEvent', { type, key:'a', code:'KeyA', windowsVirtualKeyCode:65, modifiers:2 });
  const selection = await waitFor(async () => hostEvalJson(`(()=>{const e=document.getElementById('keyboard');return e.selectionStart===0 && e.selectionEnd===e.value.length?{start:e.selectionStart,end:e.selectionEnd,value:e.value}:null})()`), { label: 'Ctrl+A selects input text through panel' });
  check('S14', 'panel Ctrl+A executes select-all in target input', selection.start===0 && selection.end===selection.value.length, 'entire input selected', selection);
  await state.chrome.cdp.send('Input.dispatchKeyEvent', {type:'keyDown',key:'x',code:'KeyX',windowsVirtualKeyCode:88,text:'x'});
  await state.chrome.cdp.send('Input.dispatchKeyEvent', {type:'keyUp',key:'x',code:'KeyX',windowsVirtualKeyCode:88});
  await waitFor(async () => (await hostEvalJson(`document.getElementById('keyboard').value`))==='x', {label:'printable key replaces selection'});
  check('S15', 'printable key still inserts text after shortcut', (await hostEvalJson(`document.getElementById('keyboard').value`))==='x', 'x', await hostEvalJson(`document.getElementById('keyboard').value`));
  await capturePng('select-final.png');
  observations.selectTruth = await truth();

  async function chooseDisabled(index) {
    const point = await centerOf(`document.querySelectorAll('[data-utb-select-item]')[${index}]`);
    await clickAt(point.x, point.y);
  }
}

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
  const open = async id => {
    await clickControl(id);
    return waitFor(readPop, { label: `select popover ${id}`, timeoutMs: 10000 });
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
  const beforeKey = (await truth()).values.find(x=>x.id==='multiple').index;
  const expectedIndex = Math.min(2, beforeKey + 1);
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40 });
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type:'keyUp',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40 });
  await waitFor(async () => (await truth()).values.find(x=>x.id==='multiple').index === expectedIndex, { label: 'unsupported shape keyboard forwarding' });
  check('S10', 'unsupported shape still forwards keyboard to page', beforeKey !== expectedIndex && (await truth()).values.find(x=>x.id==='multiple').index === expectedIndex, expectedIndex, await truth());
  await pressEscape();
  await waitFor(async () => pageEvaluate(`!document.querySelector('[data-utb-select-unsupported]')`), {label:'Escape dismisses unsupported notice'});
  check('S10a', 'Escape dismisses the outside hint', await pageEvaluate(`!document.querySelector('[data-utb-select-unsupported]')`), true, true);
  await open('space');
  await hostEvalJson(`document.getElementById('duplicate').focus()`);
  await choose(2);
  observed = await waitFor(async () => { const t=await truth();return t.values.find(x=>x.id==='space').value==='local'?t:null; }, { label: 'bound target after focus change' });
  check('S11', 'focus change cannot redirect a popover write', observed.values.find(x=>x.id==='space').value==='local' && observed.values.find(x=>x.id==='duplicate').index===1, 'space=local, duplicate index=1', observed);
  const long = await open('long');
  check('S12', 'large list is bounded at 200 options', long.items.length === 200, 200, {count:long.items.length});
  await pressEscape();
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

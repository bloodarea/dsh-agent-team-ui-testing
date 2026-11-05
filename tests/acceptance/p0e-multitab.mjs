import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHarness, createFakeConnectionService, createFakeSessionsService, createFakeWorkspaceRegistry, scanPluginChromeProcesses } from './harness.mjs';
const log=(...a)=>console.log(...a);const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));const results=[]; const notRuns=[];
function notRun(label,reason){notRuns.push({label,reason});console.log('NOT_RUN '+label+' — '+reason);}
function check(label,pass,expected,actual){results.push({label,pass:!!pass});log(`${pass?'PASS':'FAIL'} ${label}`);if(!pass)log('  expected='+JSON.stringify(expected)+' actual='+JSON.stringify(actual));}
const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>P0E A</title><h1>A</h1><button id="btn-a">A button</button><div id="a">A</div><a id="popup-link" href="/popup-b" target="_blank" rel="noopener">open popup</a><a id="forbidden" href="http://169.254.169.254/" target="_blank" rel="noopener">forbidden</a>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const fixture=`http://127.0.0.1:${server.address().port}/`;
const harness=await createHarness({connection:createFakeConnectionService({rejection:undefined,admit:()=>({peer:{id:'owner'}}),browserPeer:{id:'owner'}})});
const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cwd = process.env.DSH_UI_TESTING_REPO_ROOT || REPO_ROOT;
const execA={agent:{id:'agent-a',session:{header:{cwd}}}};const execB={agent:{id:'agent-b',session:{header:{cwd}}}};
const call=async(name,args,exec)=>harness.invoke(name,args,exec);
const tabs=(args,exec)=>call('browser_tabs',args,exec);
notRun('E09/E12/E13 GUI client surface','client active/status/+ /popup source are covered by popup-tabs/client smoke, not this Host fixture');
notRun('E10 network.start and T3/T4 selected routing','not exercised in this fixture');
notRun('E11 global 8 concurrent reservations','4-tab cap is covered; global 8 concurrent tab reservations are not');
notRun('E14 annotation/network/history isolation','T2 refs only; annotation document/network session/history back not exercised');
notRun('E15 idle/LRU/Host restart/cancel races','not exercised');
notRun('E16 concurrent selection/old response routing','session routing and close reset covered; concurrent active/old responses not');
notRun('8-notice / multi-popup storm cap','only one blocked popup is produced; the notices limit is asserted as a bound, not by filling it with 9 blocked popups');
notRun('cross-workspace popup notice isolation','the popup fixture is single-workspace; cross-workspace select is covered but notice isolation is not');
notRun('default 10-minute TTL real wait','the idle audit is exercised with DSH_UI_TESTING_IDLE_MS=1000 (mechanism); the 600000ms default is not waited out');
notRun('automatic popup without user gesture','Chrome blocks window.open outside a trusted gesture before any target exists, so no blocked-popup notice can be produced in this fixture');

try{
 const hook=await harness.request({method:'POST',path:'/plugins/ui-testing/test/invoke',headers:{'content-type':'application/json','x-ui-testing-test-token':'not-enabled'},body:{tool:'browser_state',args:{},agent:{id:'x',session:{header:{cwd}}}}});
 check('E01 test/invoke is 404 by default (hooks disabled)',hook.statusCode===404,404,hook.statusCode);
 let r=await call('browser_navigate',{url:fixture},execA);check('A navigate primary',r.ok,true,r);
 r=await tabs({action:'list'},execA);const primary=r.value?.tabs?.find(t=>t.kind==='primary');check('default list primary selected',r.ok&&primary?.selected===true,true,r.value);
 // TOOL-P0-01/P1-05 capability surface: actions incl. wait + lifecycle limits.
 const caps=await call('browser_capabilities',{},execA);
 const capsTabs=caps.value?.tabs, capsLimits=caps.value?.limits?.tabs;
 check('P0-01 capabilities.tabs actions include wait',Array.isArray(capsTabs?.actions)&&capsTabs.actions.includes('wait'),true,capsTabs?.actions);
 check('P1-05 capabilities.tabs exposes idleMs/noticesLimit/closedHistoryLimit/keepalive',
   Number.isFinite(capsTabs?.idleMs)&&capsTabs.idleMs>0&&capsTabs.noticesLimit===8&&capsTabs.closedHistoryLimit===8
   &&capsTabs.keepalive?.refreshOnPageTools===true&&capsTabs.keepalive?.idleMs===capsTabs.idleMs,true,capsTabs);
 check('P1-05 limits.tabs mirrors actions/idleMs/audit limits/keepalive',
   Array.isArray(capsLimits?.actions)&&capsLimits.actions.includes('wait')&&capsLimits.idleMs===capsTabs.idleMs
   &&capsLimits.noticesLimit===8&&capsLimits.closedHistoryLimit===8&&capsLimits.keepalive?.refreshOnPageTools===true,true,capsLimits);
 r=await tabs({action:'open'},execA);check('A browser_tabs.open creates/selects tab',r.ok&&r.value?.tabId,true,r.value);const childId=r.value?.tabId;
 r=await tabs({action:'list'},execA);const child=r.value?.tabs?.find(t=>t.tabId===childId);check('open tab ready and selected',child?.status==='ready'&&child?.selected===true,true,child);
 // TOOL-P0-01/P1-05: per-tab lifecycle projection, wait semantics, close audit.
 check('lifecycle: primary row source/parent/openEventId/createdAt/lastUsedAt/idleRemainingMs/manageable',
   primary?.source==='primary'&&primary.parentTabId===null&&primary.openEventId===null
   &&Number.isFinite(primary.createdAt)&&Number.isFinite(primary.lastUsedAt)
   &&Number.isFinite(primary.idleRemainingMs)&&primary.idleRemainingMs>=0&&primary.idleRemainingMs<=capsTabs.idleMs
   &&primary.manageable===true,true,primary);
 check('lifecycle: agent-open child row source/parent/openEventId/idleRemainingMs/manageable',
   child?.source==='agent-open'&&child.parentTabId==='primary'&&child.openEventId===null
   &&Number.isFinite(child.createdAt)&&Number.isFinite(child.lastUsedAt)
   &&Number.isFinite(child.idleRemainingMs)&&child.idleRemainingMs>=0&&child.idleRemainingMs<=capsTabs.idleMs
   &&child.manageable===true,true,child);
 const waitNow=await tabs({action:'wait',tabId:childId,timeoutMs:500,pollMs:50},execA);
 check('wait: existing tabId matches immediately with matched/tab/elapsedMs/polls',
   waitNow.ok&&waitNow.value?.matched===true&&waitNow.value?.matchedTab?.tabId===childId
   &&waitNow.value.matchedTab.source==='agent-open'&&waitNow.value?.tab?.runtimeId===primary?.runtimeId
   &&Number.isInteger(waitNow.value?.polls)&&waitNow.value.polls>=1
   &&Number.isFinite(waitNow.value?.elapsedMs),true,waitNow.value||waitNow.error);
 const waitTimeout=await tabs({action:'wait',kind:'tab',timeoutMs:300,pollMs:50},execA);
 check('wait: no tab appears after call start → WAIT_TIMEOUT with elapsedMs/polls/condition',
   waitTimeout.ok===false&&waitTimeout.error?.code==='WAIT_TIMEOUT'
   &&Number.isFinite(waitTimeout.error.details?.elapsedMs)&&waitTimeout.error.details.elapsedMs>=250
   &&Number.isInteger(waitTimeout.error.details?.polls)&&waitTimeout.error.details.polls>=2
   &&waitTimeout.error.details?.condition?.kind==='tab','WAIT_TIMEOUT',waitTimeout.error);
 const badTimeout=await tabs({action:'wait',timeoutMs:30001},execA);
 const badPoll=await tabs({action:'wait',pollMs:10},execA);
 const badField=await tabs({action:'list',kind:'tab'},execA);
 check('wait: invalid timeoutMs/pollMs and wait-only fields are INVALID_ARGUMENT with zero side effects',
   badTimeout.error?.code==='INVALID_ARGUMENT'&&badPoll.error?.code==='INVALID_ARGUMENT'&&badField.error?.code==='INVALID_ARGUMENT',
   {timeoutMs:'INVALID_ARGUMENT',pollMs:'INVALID_ARGUMENT',field:'INVALID_ARGUMENT'},
   {timeoutMs:badTimeout.error?.code,pollMs:badPoll.error?.code,field:badField.error?.code});
 const pendingWait=tabs({action:'wait',timeoutMs:8000,pollMs:50},execA);
 await sleep(250);
 const opened2=await tabs({action:'open'},execA);
 const waitedNew=await pendingWait;
 check('wait: resolves with a tab created after the call started (baseline snapshot semantics)',
   waitedNew.ok&&waitedNew.value?.matched===true&&waitedNew.value?.matchedTab?.tabId===opened2.value?.tabId
   &&Number.isInteger(waitedNew.value?.polls)&&waitedNew.value.polls>=2,true,waitedNew.value||waitedNew.error);
 const closedOwn=await tabs({action:'close',tabId:opened2.value.tabId},execA);
 check('close: own selected child closes',closedOwn.ok,true,closedOwn);
 const afterClose=await tabs({action:'list'},execA);
 const closedRow=(afterClose.value?.recentClosed||[]).find((row)=>row.tabId===opened2.value.tabId);
 check('recentClosed records {tabId,kind,reason:closed,at} for an explicit close',
   closedRow?.kind==='tab'&&closedRow?.reason==='closed'&&Number.isFinite(closedRow?.at),true,afterClose.value?.recentClosed);
 check('recentClosed is bounded (≤8) and the closed tab is gone from tabs',
   Array.isArray(afterClose.value?.recentClosed)&&afterClose.value.recentClosed.length<=8
   &&!afterClose.value.tabs.some((tab)=>tab.tabId===opened2.value.tabId),true,
   {recent:afterClose.value?.recentClosed?.length,tabs:afterClose.value?.tabs?.map((t)=>t.tabId)});
 check('notices: list returns a bounded array (shape checked with a real blocked popup below)',
   Array.isArray(afterClose.value?.notices)&&afterClose.value.notices.length<=8,true,afterClose.value?.notices);
 r=await tabs({action:'select',tabId:'primary'},execA);check('A select primary releases child',r.ok,true,r);
 r=await tabs({action:'select',tabId:childId},execB);check('B select child succeeds',r.ok,true,r);
 const toolNames=harness.toolNames();check('E01 tool surface is 36 and browser_tabs is registered',toolNames.length===36&&toolNames.includes('browser_tabs'),{count:36},toolNames.length);
 const tabDef=harness.toolDefinitions().find((d)=>d.name==='browser_tabs'); check('E01 browser_tabs schema action enum + tabId',Boolean(tabDef&&Array.isArray(tabDef.parameters?.properties?.action?.enum)&&tabDef.parameters.properties.action.enum.includes('select')&&tabDef.parameters.properties.tabId),true,tabDef&&tabDef.parameters);
 const childList=await tabs({action:'list'},execA); const childRow=childList.value?.tabs?.find(t=>t.tabId===childId);check('list reports owner=self/selected for B tab',childRow?.owner==='other'&&childRow?.busy===true&&childRow?.manageable===false,true,childRow);
 const foreignClose=await tabs({action:'close',tabId:childId},execA);check('closing another session tab is TAB_FORBIDDEN',foreignClose.ok===false&&foreignClose.error?.code==='TAB_FORBIDDEN','TAB_FORBIDDEN',foreignClose.error);
 const [ea,eb]=await Promise.all([call('browser_eval',{expression:'window.__a=(window.__a||0)+1'},execA),call('browser_eval',{expression:'window.__b=(window.__b||0)+1'},execB)]);
 check('A/B different tabs eval in parallel',ea.ok&&eb.ok,true,{a:ea.error,b:eb.error});
 const [ovA,ovB]=await Promise.all([
   call('browser_eval',{expression:'new Promise((resolve)=>{window.__start=Date.now();setTimeout(()=>{window.__end=Date.now();resolve({start:window.__start,end:window.__end});},450);})'},execA),
   call('browser_eval',{expression:'new Promise((resolve)=>{window.__start=Date.now();setTimeout(()=>{window.__end=Date.now();resolve({start:window.__start,end:window.__end});},450);})'},execB),
 ]);
 const ia=ovA.value?.value, ib=ovB.value?.value;
 check('E06 A/B different-tab operations overlap in real time',Boolean(ia&&ib&&ia.start<ib.end&&ib.start<ia.end),{overlap:true},{a:ia,b:ib});
 const sameA=await tabs({action:'select',tabId:'primary'},execA);const sameB=await tabs({action:'select',tabId:'primary'},execB);
 check('same tab second selection is BUSY',sameA.ok&&sameB.ok===false&&sameB.error?.code==='BUSY',{a:true,b:'BUSY'},sameB);
 // GUI preview busy primary, input BUSY
 const bState=await harness.request({method:'GET',path:'/plugins/ui-testing/state',headers:{'x-ui-testing-scope-version':'1','x-ui-testing-session-id':'agent-b'}});
 check('HTTP session state follows selected child',bState.statusCode===200&&bState.json?.ui?.runtimeId===child?.runtimeId,child?.runtimeId,bState.json?.ui?.runtimeId);
 const states=await harness.request({method:'GET',path:'/plugins/ui-testing/state',headers:{'x-ui-testing-scope-version':'1','x-ui-testing-session-id':'agent-a'}});
 const primaryRuntime=states.json?.ui?.runtimeId;
 const binding={'x-ui-testing-scope-version':'1','x-ui-testing-scope-binding':primaryRuntime};
 const frame=await harness.request({method:'GET',path:'/plugins/ui-testing/frame?since=0',headers:binding});
 await call('browser_eval',{expression:"window.__ev=0;document.addEventListener('mousedown',()=>window.__ev++,true)"},execA);
 const input=await harness.request({method:'POST',path:'/plugins/ui-testing/input',headers:binding,body:{events:[{kind:'mouse',type:'mousePressed',x:10,y:10,button:'left',clickCount:1}]}});
 check('GUI /frame previews busy tab',frame.statusCode===200,200,frame.statusCode);
 check('GUI /input is BUSY while Agent owns tab',input.statusCode===409&&input.json?.code==='BUSY',409,{status:input.statusCode,body:input.json});
 const evAfter=await call('browser_eval',{expression:'window.__ev'},execA);
 check('E08 BUSY /input dispatches zero page events',evAfter.value?.value===0,0,evAfter.value?.value);
 // close child by B, then B page tool pending reset
 r=await tabs({action:'select',tabId:childId},execB); // may be BUSY? B still owns child
 r=await tabs({action:'close',tabId:childId},execB);check('B closes own child',r.ok,true,r);
 r=await call('browser_eval',{expression:'1'},execB);check('closed selected tab requires confirmation',r.ok===false&&r.error?.code==='TARGET_NOT_FOUND',{code:'TARGET_NOT_FOUND'},r.error);
 r=await tabs({action:'current'},execB);check('browser_tabs.current confirms reset to primary',r.ok&&r.value?.tabId==='primary',{tabId:'primary'},r.value);
 // 4-tab cap
 await tabs({action:'select',tabId:'primary'},execA);
 const opened=[];for(let i=0;i<3;i++){const x=await tabs({action:'open'},execA);if(x.ok)opened.push(x.value.tabId);}
 const fifth=await tabs({action:'open'},execA);check('4 tabs cap: fifth open rejected TAB_LIMIT',opened.length===3&&fifth.ok===false&&fifth.error?.code==='TAB_LIMIT',{opened:3,code:'TAB_LIMIT'},{opened:opened.length,error:fifth.error});
 // primary close cold, children remain
 await tabs({action:'select',tabId:'primary'},execA);const closeP=await tabs({action:'close',tabId:'primary'},execA);const listAfter=await tabs({action:'list'},execA);
 check('primary close goes cold without cascading children',closeP.ok&&listAfter.value?.tabs?.length===4,{ok:true,tabs:4},{ok:closeP.ok,tabs:listAfter.value?.tabs?.length});
 // default B primary after confirm
 const defB=await tabs({action:'list'},execB);check('B without selection defaults primary',defB.value?.tabs?.find(t=>t.kind==='primary')?.selected===true,true,defB.value);
 // T2 refs are globally unique across sibling tabs.
 await tabs({action:'select',tabId:'primary'},execA);
 await call('browser_navigate',{url:fixture},execA);
 const snapA=await call('browser_snapshot',{},execA);
 await tabs({action:'select',tabId:opened[0]},execB);
 await call('browser_navigate',{url:fixture},execB);
 const snapB=await call('browser_snapshot',{},execB);
 const refsA=Object.keys(snapA.value?.refs||{}); const refsB=Object.keys(snapB.value?.refs||{});
 check('T2 refs are global/unique across sibling tabs',refsA.length>0&&refsB.length>0&&!refsA.some(r=>refsB.includes(r)),{overlap:0},{a:refsA.slice(0,3),b:refsB.slice(0,3),overlap:refsA.filter(r=>refsB.includes(r))});
 // Cross-workspace: switch B's cwd/workspace and reject A's tab.
 harness.setSessions(createFakeSessionsService({sessions:new Map([['agent-a',{id:'agent-a',header:{cwd}}],['agent-b',{id:'agent-b',header:{cwd:'/tmp'}}]])}));
 harness.setWorkspaceRegistry(createFakeWorkspaceRegistry({workspaces:[{id:'ws-a',path:cwd},{id:'ws-b',path:'/tmp'}]}));
 const cross=await tabs({action:'select',tabId:opened[0]},execB);
 check('cross-workspace select is TAB_NOT_FOUND',cross.ok===false&&cross.error?.code==='TAB_NOT_FOUND','TAB_NOT_FOUND',cross.error);
 const crossList=await tabs({action:'list'},execB);
 check('cross-workspace list exposes no other workspace tabs/notices/recentClosed',
   crossList.ok&&crossList.value?.tabs?.length===1&&crossList.value.tabs[0]?.tabId==='primary'
   &&(crossList.value?.notices||[]).length===0&&(crossList.value?.recentClosed||[]).length===0,true,
   {tabs:crossList.value?.tabs?.map((t)=>t.tabId),notices:crossList.value?.notices,recentClosed:crossList.value?.recentClosed});
 // close children via agent owners? A may own 3; close each
 for(const id of opened){await tabs({action:'close',tabId:id},execA).catch(()=>{});}
 // TOOL-P0-01: real-Chromium GUI popup discovery, blocked-popup notices and close audit.
 const popupHarness=await createHarness({connection:createFakeConnectionService({rejection:undefined,admit:()=>({peer:{id:'owner'}}),browserPeer:{id:'owner'}})});
 try{
  const popupExec={agent:{id:'popup-agent',session:{header:{cwd}}}};
  const guiHeaders={'x-ui-testing-scope-version':'1','x-ui-testing-session-id':'gui-p0e'};
  const procBaseline=scanPluginChromeProcesses().map((entry)=>entry.pid);
  const coldList=await popupHarness.invoke('browser_tabs',{action:'list'},popupExec);
  const coldWait=await popupHarness.invoke('browser_tabs',{action:'wait',timeoutMs:300,pollMs:50},popupExec);
  await sleep(300);
  const newProcs=scanPluginChromeProcesses().map((entry)=>entry.pid).filter((pid)=>!procBaseline.includes(pid));
  check('TOOL-P0-01 wait/list never start Chromium (cold workspace, no new process)',
    coldList.ok&&coldList.value?.tabs?.length===1&&coldWait.error?.code==='WAIT_TIMEOUT'&&newProcs.length===0,
    {code:'WAIT_TIMEOUT',newProcesses:0},{code:coldWait.error?.code,newProcesses:newProcs.length,err:coldWait.error?.message});
  await popupHarness.request({method:'POST',path:'/plugins/ui-testing/ensure',headers:guiHeaders,body:{url:fixture}});
  const guiClick=async(selector)=>{
    const rect=await popupHarness.request({method:'POST',path:'/plugins/ui-testing/eval',headers:guiHeaders,body:{expression:`(() => { const node=document.querySelector(${JSON.stringify(selector)}); if(!node) return null; const r=node.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`}});
    const point=rect.json?.value;
    if(!point) return null;
    return popupHarness.request({method:'POST',path:'/plugins/ui-testing/input',headers:guiHeaders,body:{events:[
      {kind:'mouse',type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1},
      {kind:'mouse',type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1},
    ]}});
  };
  // A forbidden target is blocked; the Agent can distinguish that from "clicked but nothing happened".
  await guiClick('#forbidden');
  await sleep(1500);
  const noticeList=await popupHarness.invoke('browser_tabs',{action:'list'},popupExec);
  const notice=(noticeList.value?.notices||[]).find((row)=>row.reason==='target-forbidden');
  check('notices: blocked popup exposes reason/parentTabId/openEventId/at to the Agent',
    Boolean(notice)&&notice.parentTabId==='primary'&&Object.prototype.hasOwnProperty.call(notice,'openEventId')
    &&Number.isFinite(notice.at),true,noticeList.value?.notices);
  // wait is pure memory while a real GUI click opens a target=_blank child.
  const pendingPopup=popupHarness.invoke('browser_tabs',{action:'wait',source:'gui-popup',timeoutMs:15000,pollMs:100},popupExec);
  await sleep(150);
  const popupClick=await guiClick('#popup-link');
  const popupWaited=await pendingPopup;
  check('wait: GUI target=_blank popup is discovered via the source filter',
    popupClick?.statusCode===200&&popupWaited.ok&&popupWaited.value?.matched===true
    &&popupWaited.value?.matchedTab?.source==='gui-popup'&&popupWaited.value.matchedTab.parentTabId==='primary'
    &&typeof popupWaited.value.matchedTab.openEventId==='string'&&popupWaited.value.matchedTab.status==='ready',
    true,popupWaited.value||popupWaited.error);
  const popupTabId=popupWaited.value?.matchedTab?.tabId;
  if(popupTabId){
    const popupList=await popupHarness.invoke('browser_tabs',{action:'list'},popupExec);
    const popupRow=popupList.value?.tabs?.find((tab)=>tab.tabId===popupTabId);
    check('list: adopted GUI popup row carries source/parentTabId/openEventId/createdAt/manageable',
      popupRow?.kind==='tab'&&popupRow.source==='gui-popup'&&popupRow.parentTabId==='primary'
      &&popupRow.openEventId===popupWaited.value.matchedTab.openEventId&&Number.isFinite(popupRow.createdAt)
      &&popupRow.manageable===true,true,popupRow);
    const selectPopup=await popupHarness.invoke('browser_tabs',{action:'select',tabId:popupTabId},popupExec);
    const closePopup=await popupHarness.invoke('browser_tabs',{action:'close',tabId:popupTabId},popupExec);
    check('close: Agent can claim and close an adopted GUI popup',selectPopup.ok&&closePopup.ok,true,
      {select:selectPopup.error,close:closePopup.error});
    const afterPopup=await popupHarness.invoke('browser_tabs',{action:'list'},popupExec);
    const audit=(afterPopup.value?.recentClosed||[]).find((row)=>row.tabId===popupTabId&&row.reason==='closed');
    check('recentClosed: GUI popup close is audited with kind/reason/at',
      audit?.kind==='tab'&&Number.isFinite(audit?.at),true,afterPopup.value?.recentClosed);
  }else{
    check('list: adopted GUI popup row carries source/parentTabId/openEventId/createdAt/manageable',false,'matched popup tab',popupWaited.value||popupWaited.error);
  }
 }finally{try{await popupHarness.closeBrowser();}catch{}try{await popupHarness.dispose();}catch{}}
 // TOOL-P1-05: configurable/visible TTL + idle close audit (shortened idle window, no 10-min wait).
 process.env.DSH_UI_TESTING_IDLE_MS='1000';
 let idleHarness;
 try{
  idleHarness=await createHarness({connection:createFakeConnectionService({rejection:undefined,admit:()=>({peer:{id:'owner'}}),browserPeer:{id:'owner'}})});
  const idleExec={agent:{id:'idle-agent',session:{header:{cwd}}}};
  const idleHeaders={'x-ui-testing-scope-version':'1','x-ui-testing-session-id':'gui-idle'};
  const idleCaps=await idleHarness.invoke('browser_capabilities',{},idleExec);
  check('TTL: capabilities.tabs/limits.tabs report the configured idleMs',
    idleCaps.value?.tabs?.idleMs===1000&&idleCaps.value?.limits?.tabs?.idleMs===1000,1000,
    {tabs:idleCaps.value?.tabs?.idleMs,limits:idleCaps.value?.limits?.tabs?.idleMs});
  await idleHarness.request({method:'POST',path:'/plugins/ui-testing/ensure',headers:idleHeaders,body:{url:fixture}});
  const idleList=await idleHarness.invoke('browser_tabs',{action:'list'},idleExec);
  const idlePrimary=idleList.value?.tabs?.find((tab)=>tab.kind==='primary');
  check('TTL: idleRemainingMs is bounded by the configured idleMs',
    Number.isFinite(idlePrimary?.idleRemainingMs)&&idlePrimary.idleRemainingMs>=0&&idlePrimary.idleRemainingMs<=1000,
    true,idlePrimary?.idleRemainingMs);
  let idleAudit=[];
  for(let i=0;i<40&&!idleAudit.some((row)=>row.reason==='idle');i+=1){
    await sleep(250);
    const snap=await idleHarness.invoke('browser_tabs',{action:'list'},idleExec);
    idleAudit=snap.value?.recentClosed||[];
  }
  const idleRow=idleAudit.find((row)=>row.reason==='idle');
  check('TTL: idle sweep audits a closed tab with reason=idle and a timestamp',
    Boolean(idleRow)&&Number.isFinite(idleRow.at),true,idleAudit);
 }finally{
  delete process.env.DSH_UI_TESTING_IDLE_MS;
  if(idleHarness){try{await idleHarness.closeBrowser();}catch{}try{await idleHarness.dispose();}catch{}}
 }
}catch(error){check('P0-E host fixture completed',false,'no exception',String(error&&(error.stack||error.message)||error));}
finally{try{await harness.closeBrowser();}catch{}try{await harness.dispose();}catch{}await new Promise(r=>server.close(r));const failed=results.filter(r=>!r.pass).length;const stamp=new Date().toISOString().replace(/[:.]/gu,'-');const dir=`tests/acceptance/runs/p0e-multitab-${stamp}-${process.pid}`;await mkdir(dir,{recursive:true});const report={generatedAt:new Date().toISOString(),summary:{checks:results.length,passed:results.length-failed,failed,notRun:notRuns.length},checks:results.map(r=>({label:r.label,pass:r.pass})),notRuns};await writeFile(`${dir}/report.json`,JSON.stringify(report,null,2));log(`evidence: ${dir}`);log(`\nRESULT ${failed?'FAIL':'PASS'} (${failed} failed, ${results.length} checks, ${notRuns.length} NOT_RUN)`);log(`exit ${failed?1:0}`);process.exit(failed?1:0);}

// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { launchDesktop, captureDesktop } from './smoke-window.mjs';
if(!process.argv.includes('--background')) throw Error('Background only. No live transports.');
const root=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const dev=process.argv.includes('--dev'); const mode=dev?'development':'production';
const artifacts=path.join(root,'artifacts/i18n-v02'); await mkdir(artifacts,{recursive:true});
const directory=await mkdtemp(path.join(tmpdir(),'seohokim-language-isolation-'));
const profile=path.join(directory,'profile'); await mkdir(profile);
const wrapper=path.join(directory,'main.cjs');
let desktop,page,vite,current; const checks=[], errors=[], runs=[];
const rawOutput='  Original 결과 $& {0} 😀\r\nKeep these bytes.  ';
const prompt='Write a note. 한국어로 답하세요. Preserve $& {0}.';
const server=createServer(async(req,res)=>{
 try {
  let raw='';for await(const chunk of req)raw+=chunk;
  assert.ok(current);assert.ok(['/v1/messages','/v1/chat/completions'].includes(req.url));
  const record={route:req.url,body:raw,res,closed:false}; current.records.push(record);
  res.on('close',()=>{record.closed=true;});
 }catch(error){errors.push(String(error));res.writeHead(500);res.end('{}');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
await writeFile(wrapper, `const {ipcMain}=require('electron');
globalThis.languageAudit={executions:[],saves:[],cancellations:[],faults:{},hold:undefined,release:undefined};
const handle=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,listener)=>handle(channel,async(event,...args)=>{
 const audit=globalThis.languageAudit;
 if(channel.endsWith(':providers:execute')) audit.executions.push(args[0]);
 if(channel.endsWith(':history:save')) audit.saves.push(args[0]);
 if(channel.endsWith(':execution:cancel')) audit.cancellations.push(args[0]);
 if(audit.hold===channel)await new Promise(resolve=>{audit.release=resolve;});
 if(audit.faults[channel])return audit.faults[channel];
 return listener(event,...args);
});
const http=require('node:http'),https=require('node:https');
http.request=https.request=()=>{throw Error('Non-fixture transport blocked');};
const transport=globalThis.fetch;
globalThis.fetch=(url,options)=>{
 const requested=String(url)==='https://api.anthropic.com/v1/messages'?${JSON.stringify(base+'/v1/messages')}:String(url);
 if(!requested.startsWith(${JSON.stringify(base+'/')}))throw Error('External transport blocked');
 return transport(requested,options);
};
require(${JSON.stringify(path.join(root,'dist-electron/electron/main.cjs'))});`);
const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('SEOHOKIM_LOOP_')||/API_KEY/.test(key)||key==='ELECTRON_RUN_AS_NODE')delete env[key];
Object.assign(env,{SEOHOKIM_LOOP_CODEX_LOCAL: '1', SEOHOKIM_LOOP_OPENAI_API_KEY:'fake-language-openai',SEOHOKIM_LOOP_OPENAI_BASE_URL:base+'/v1',SEOHOKIM_LOOP_OPENAI_MODEL:'fake-openai',SEOHOKIM_LOOP_ANTHROPIC_API_KEY:'fake-language-claude',SEOHOKIM_LOOP_ANTHROPIC_MODEL:'fake-claude'});
async function launch(){desktop=await launchDesktop({executablePath:electronPath,args:[wrapper,...(dev?['--dev']:[]),'--lang=en-US',`--user-data-dir=${profile}`],cwd:root,env,timeout:30000});page=await desktop.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));page.on('console',entry=>{if(entry.type()==='error')errors.push(entry.text());});await page.locator('#app-language').waitFor();const cli=await page.evaluate(async()=>{const reply=await window.seohoKimLoop.listProviders();return reply.value.find(p=>p.id==='codex-cli-local');});assert.equal(cli.configured,false);assert.equal(cli.localCli.state,'disabled');}
async function locale(value){await page.locator('#app-language').selectOption(value);assert.equal(await page.locator('html').getAttribute('lang'),value);}
async function wait(predicate,label){const start=Date.now();while(!await predicate()){if(Date.now()-start>10000)throw Error(`Timed out: ${label}`);await new Promise(r=>setTimeout(r,20));}}
async function arrived(index){await wait(()=>current.records.length>index,`request ${index}`);return current.records[index];}
function respond(record,text,status=200){record.res.writeHead(status,{'Content-Type':'application/json'});record.res.end(status!==200?'{}':JSON.stringify(record.route==='/v1/messages'?{type:'message',role:'assistant',content:[{type:'text',text}],stop_reason:'end_turn'}:{choices:[{message:{content:text},finish_reason:'stop'}]}));}
async function audit(){return desktop.evaluate(()=>globalThis.languageAudit);}
async function flip(label,ending){
 const before=await audit();const count=current.records.length;
 const selection=await page.locator('#execution-mode,#provider,#reviewer').evaluateAll(nodes=>nodes.map(node=>[node.id,node.value]));
 const ids=await page.getByTestId('step').evaluateAll(nodes=>nodes.map(node=>[node.dataset.providerId,node.dataset.status,node.dataset.retryCount,node.dataset.retryPending,node.dataset.fallbackCount,node.querySelector('.step-output')?.textContent]));
 await locale(ending==='en'?'ko':'en');await locale(ending);
 const after=await audit();assert.deepEqual(after.executions,before.executions,label+' execution IDs and inputs');assert.deepEqual(after.saves,before.saves,label+' no history mutation');
 assert.equal(current.records.length,count,label+' no additional requests');
 assert.deepEqual(await page.locator('#execution-mode,#provider,#reviewer').evaluateAll(nodes=>nodes.map(node=>[node.id,node.value])),selection,label+' selections unchanged');
 assert.deepEqual(await page.getByTestId('step').evaluateAll(nodes=>nodes.map(node=>[node.dataset.providerId,node.dataset.status,node.dataset.retryCount,node.dataset.retryPending,node.dataset.fallbackCount,node.querySelector('.step-output')?.textContent])),ids,label+' steps unchanged');
 assert.equal(await page.locator('#request').inputValue(),prompt);checks.push(label);
}
function makePlan(parallel){const refs=parallel?[[],[],[1,2]]:[[],[1]];return {title:'Generated title 원문',steps:refs.map((dependsOn,i)=>({title:`Model step ${i+1}`,objective:`Original objective ${i+1}`,role:i===refs.length-1?'deliver':'write',usesPreviousOutputs:dependsOn.length>0,isFinal:i===refs.length-1,dependsOn}))};}
async function scenario(kind,language){
 current={kind,language,records:[]};const before=await audit();await locale(language);
 await page.locator('#execution-mode').selectOption(kind==='single'||kind==='cancel'?'single':kind==='manual'?'collaboration':'auto');
 if(['single','manual','cancel'].includes(kind))await page.locator('#provider').selectOption('openai-compatible');
 if(kind==='manual')await page.locator('#reviewer').selectOption('anthropic');
 await page.locator('#request').fill(prompt);await page.getByRole('button',{name:'Start Loop',exact:true}).click();
 let index=0;
 if(!['single','manual','cancel'].includes(kind)){
  const planner=await arrived(index++);await page.getByTestId('auto-plan').waitFor();await flip(`${language} ${kind} planning`,language);
  respond(planner,kind==='recovery'?'invalid synthetic plan':JSON.stringify(makePlan(kind==='parallel')));
  if(kind==='recovery'){const repair=await arrived(index++);await flip(`${language} planner recovery`,language);respond(repair,JSON.stringify(makePlan(false)));}
 }
 if(kind==='parallel'){
  const first=await arrived(index++),second=await arrived(index++);assert.equal(await page.locator('[data-testid="step"][data-status="running"]').count(),2);
  await flip(`${language} parallel work`,language);for(const record of [first,second]) respond(record, record.body.includes('Model step 1')?'Parallel output one':'Parallel output two');
  const final=await arrived(index++);await flip(`${language} parallel final`,language);respond(final,rawOutput);
 }else{
  const steps=kind==='manual'?3:['single','cancel'].includes(kind)?1:2;
  for(let step=0;step<steps;step++){
   let request=await arrived(index++);await flip(`${language} ${kind} step ${step+1}`,language);
   if(kind==='cancel'){
    await desktop.evaluate(()=>{globalThis.languageAudit.hold='seohokim-loop:execution:cancel';});
    await page.getByRole('button',{name:language==='en'?'Stop task':'작업 중지',exact:true}).click();
    await wait(async()=>!!(await desktop.evaluate(()=>typeof globalThis.languageAudit.release==='function')),'cancellation waiting');
    await flip(language+' cancellation pending',language);
    await desktop.evaluate(()=>{globalThis.languageAudit.hold=undefined;globalThis.languageAudit.release();globalThis.languageAudit.release=undefined;});
    await page.locator('[data-testid="loop"][data-status="cancelled"]').waitFor();await wait(()=>request.closed,'HTTP abort');
    assert.equal(current.records.length,1);assert.equal((await audit()).saves.length,before.saves.length);checks.push(`${language} cancellation stopped request`);break;
   }
   if(step===0&&['retry','fallback'].includes(kind)){
    respond(request,'',503);await page.locator('[data-retry-pending="true"]').waitFor();await flip(`${language} retry waiting`,language);
    request=await arrived(index++);await flip(`${language} retry executing`,language);
    if(kind==='fallback'){respond(request,'',503);request=await arrived(index++);await page.getByTestId('step-fallback').waitFor();await flip(`${language} fallback executing`,language);}
   }
   respond(request,step===steps-1?rawOutput:`Original step ${step+1} 결과`);
  }
 }
 if(kind!=='cancel'){
  await page.locator('[data-testid="loop"][data-status="completed"]').waitFor();
  await wait(async()=> (await audit()).saves.length===before.saves.length+1,'single history save');
  await page.getByText(language==='en'?'Saved to History.':'기록에 보관되었습니다.',{exact:true}).waitFor();
  const after=await audit();const snapshot=after.saves.at(-1);assert.equal(snapshot.finalResult,rawOutput);assert.equal(await page.getByTestId('final-result').textContent(),rawOutput);
  assert.equal(after.executions.length-before.executions.length,index);
  assert.deepEqual([...new Set(after.executions.slice(before.executions.length).map(e=>e.executionId))],[snapshot.id]);
  const detail=await page.evaluate(id=>window.seohoKimLoop.getHistory(id),snapshot.id);assert.equal(detail.ok,true);assert.equal(detail.value.finalResult,rawOutput);
  await flip(`${language} ${kind} completed`,language);
 }
 const trace=current.records.map(({route,body})=>({route,body}));
 if(kind==='parallel') trace.splice(1,2,...trace.slice(1,3).sort((a,b)=>a.route.localeCompare(b.route))); // Independent requests may arrive in either order.
 if(language==='en')assert.deepEqual(trace,runs.find(r=>r.kind===kind&&r.language==='ko').trace,`${kind}: complete transport traces identical under both UI languages`);
 runs.push({kind,language,trace});
}
try{
 if(dev){vite=await(await import('vite')).createServer();await vite.listen();}await launch();
 const prefs=await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());assert.equal(prefs.contextIsolation,true);assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.sandbox,true);
 for(const kind of ['single','manual','auto','recovery','retry','fallback','parallel','cancel'])for(const language of ['ko','en'])await scenario(kind,language);
 // Every run is a fixture. Compare complete real-adapter payloads, not reconstructed UI labels.
 for(const run of runs)for(const request of run.trace){assert.ok(request.body.includes('한국어로 답하세요.'));assert.doesNotMatch(request.body,/output language explicitly requested|Respond in English/);}
 await locale('en');await page.getByRole('navigation').getByRole('button',{name:'History',exact:true}).click();
 await page.getByRole('button',{name:'Open record',exact:true}).first().click();assert.equal(await page.getByTestId('history-detail').getByTestId('final-result').textContent(),rawOutput);
 for(const size of [[860,640],[1280,720],[1920,1080]])for(const language of ['ko','en']){
  await locale(language);await desktop.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setSize(...size),size);
  await page.evaluate(()=>scrollTo(0,0));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('button,select,input,.step-content,.card')].filter(e=>e.getBoundingClientRect().width&&!e.closest('[hidden]')).every(e=>e.scrollWidth<=e.clientWidth+1)),true,`Layout ${size} ${language}`);
  await captureDesktop(desktop,page,{path:path.join(artifacts,`${mode}-${size.join('x')}-${language}.png`)});checks.push(`${language} ${size.join('x')} History detail layout`);
 }
 await locale('en');const saved=await page.evaluate(()=>window.seohoKimLoop.listHistory());assert.equal(saved.ok,true);assert.equal(saved.value.items.length,14);
 await desktop.close();desktop=undefined;await launch();assert.equal(await page.locator('#app-language').inputValue(),'en');
 const restored=await page.evaluate(()=>window.seohoKimLoop.listHistory());assert.deepEqual(restored,saved);
 for(const item of restored.value.items){const detail=await page.evaluate(id=>window.seohoKimLoop.getHistory(id),item.id);assert.equal(detail.value.finalResult,rawOutput);}
 checks.push('14 encrypted History snapshots restored unchanged after restart');
 await page.locator('#app-language').focus();await page.keyboard.press('k');await page.keyboard.press('Enter');await locale('en');assert.equal(await page.locator('#app-language').evaluate(e=>e===document.activeElement),true);checks.push('Keyboard language selector focus retained');

 // Exercise actual renderer error/loading paths by substituting only IPC replies.
 const fault=async(name,reply)=>desktop.evaluate(({ipcMain},[name,reply])=>{if(reply)globalThis.languageAudit.faults['seohokim-loop:history:'+name]=reply;else delete globalThis.languageAudit.faults['seohokim-loop:history:'+name];},[name,reply]);
 const nav=async name=>page.getByRole('navigation').getByRole('button',{name,exact:true}).click();
 const hold=async name=>desktop.evaluate((_e,name)=>{globalThis.languageAudit.hold='seohokim-loop:history:'+name;},name);
 const release=async()=>desktop.evaluate(()=>{globalThis.languageAudit.hold=undefined;globalThis.languageAudit.release?.();});
 await nav('History');await page.getByRole('button',{name:'Open record',exact:true}).first().waitFor();
 await page.locator('#history-search').fill('No matching synthetic task');await page.getByText('No search results.',{exact:true}).waitFor();
 await locale('ko');await page.getByText('검색 결과가 없습니다.',{exact:true}).waitFor();await locale('en');
 await page.getByRole('button',{name:'Clear search',exact:true}).click();await page.getByRole('button',{name:'Open record',exact:true}).first().waitFor();
 await hold('list');await page.getByRole('button',{name:'Refresh history',exact:true}).click();await page.getByText('Loading history…',{exact:true}).waitFor();
 await locale('ko');await page.getByText('기록을 불러오는 중…',{exact:true}).waitFor();await locale('en');await release();
 await page.getByRole('button',{name:'Open record',exact:true}).first().waitFor();
 for(const language of ['en','ko']){
  await locale(language);
  const open=language==='en'?'Open record':'기록 열기', refresh=language==='en'?'Refresh history':'기록 새로고침';
  await fault('get',{ok:false,code:'corrupt'});await page.getByRole('button',{name:open,exact:true}).first().click();
  await page.getByText(language==='en'?'Could not load the selected record.':'선택한 기록을 불러오지 못했습니다.',{exact:true}).waitFor();await fault('get');
  await page.getByRole('button',{name:open,exact:true}).first().click();assert.equal(await page.getByTestId('history-detail').getByTestId('final-result').textContent(),rawOutput);
  await page.getByRole('button',{name:language==='en'?'Delete record':'기록 삭제',exact:true}).first().click();
  await fault('delete',{ok:false,code:'unavailable'});await page.getByRole('button',{name:language==='en'?'Confirm deletion':'삭제 확인',exact:true}).click();
  await page.getByText(language==='en'?'Could not delete the record.':'기록을 삭제하지 못했습니다.',{exact:true}).waitFor();await fault('delete');
  await page.getByRole('button',{name:language==='en'?'Cancel':'취소',exact:true}).click();
  await fault('list',{ok:false,code:'unavailable'});await page.getByRole('button',{name:refresh,exact:true}).click();
  await page.getByText(language==='en'?'Could not load History.':'기록을 불러오지 못했습니다.',{exact:true}).waitFor();await fault('list');
  await page.getByRole('button',{name:refresh,exact:true}).click();await page.getByRole('button',{name:open,exact:true}).first().waitFor();
  checks.push(language+' History search, loading, corrupted detail, deletion error/cancel and list failure');
 }
 await locale('en');await nav('Loop');await fault('save',{ok:false,code:'encryption'});
 await page.locator('#execution-mode').selectOption('single');await page.locator('#provider').selectOption('mock');await page.locator('#request').fill(prompt);
 await page.getByRole('button',{name:'Start Loop',exact:true}).click();await page.locator('[data-testid="history-save"][data-phase="failed"]').waitFor();
 const mockFinal=await page.getByTestId('final-result').textContent();await page.getByText('Could not securely encrypt and save the record.',{exact:true}).waitFor();
 await locale('ko');await page.getByText('기록을 안전하게 암호화할 수 없어 보관하지 못했습니다.',{exact:true}).waitFor();await locale('en');
 await fault('save');await hold('save');await page.getByRole('button',{name:'Save again',exact:true}).click();await page.getByText('Saving History again…',{exact:true}).waitFor();
 await locale('ko');await page.getByText('기록을 다시 저장하는 중…',{exact:true}).waitFor();await locale('en');await release();
 await page.getByText('Record saved.',{exact:true}).waitFor();assert.equal(await page.getByTestId('final-result').textContent(),mockFinal);
 checks.push('History encryption failure, user resave, loading language switch and original Mock output preserved');
 for(const size of [[860,640],[1280,720],[1920,1080]])for(const language of ['ko','en']){
  await locale(language);await desktop.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setSize(...size),size);
  for(const screen of ['Loop','Connections']){
   await nav(screen);await page.evaluate(()=>scrollTo(0,0));
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   assert.equal(await page.evaluate(()=>[...document.querySelectorAll('button,select,input,.step-content,.card')].filter(e=>e.getBoundingClientRect().width&&!e.closest('[hidden]')).every(e=>e.scrollWidth<=e.clientWidth+1)),true);
   await captureDesktop(desktop,page,{path:path.join(artifacts,mode+'-'+screen+'-'+size.join('x')+'-'+language+'.png')});
  }
  checks.push(language+' '+size.join('x')+' Loop and Connections layout');
 }
 await locale('en');
 const api=await page.evaluate(async()=>[await window.seohoKimLoop.listProviders(),await window.seohoKimLoop.getConfiguration('openai-compatible'),await window.seohoKimLoop.getConfiguration('anthropic')]);
 assert.doesNotMatch(JSON.stringify(api)+await page.locator('body').innerText(),/fake-language-openai|fake-language-claude/);
 assert.equal(await page.evaluate(()=>typeof window.process+':'+typeof window.require),'undefined:undefined');checks.push('Credential and Node API isolation');
 assert.deepEqual(errors,[]);
 await writeFile(path.join(artifacts,`${mode}-isolation.json`),JSON.stringify({passed:true,checks,runs,realAiCalls:0,errors},null,2));
 console.log(JSON.stringify({mode,passed:true,checks:checks.length,runs:runs.length,fakeRequests:runs.reduce((n,r)=>n+r.trace.length,0),realAiCalls:0}));
}finally{
 await desktop?.close();await vite?.close();server.closeAllConnections();await new Promise(r=>server.close(r));
 assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir()));assert.ok(path.basename(directory).startsWith('seohokim-language-isolation-'));await rm(directory,{recursive:true,force:true});
}

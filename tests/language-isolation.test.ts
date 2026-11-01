// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir, access } from 'node:fs/promises';
import { english, type MessageKey } from '../src/i18n/catalog.ts';
import { localizeError, providerLabel, translate, type Locale } from '../src/i18n/messages.ts';
import { IpcProvider } from '../src/providers/ipc-provider.ts';
import { createProviderGateway } from '../electron/provider-gateway.ts';
import { ProviderRegistry } from '../src/providers/provider-registry.ts';
import { LoopService } from '../src/application/loop-service.ts';
import { MockPlanner } from '../src/application/mock-planner.ts';
import { DraftReviewImprove } from '../src/application/draft-review-improve.ts';
import { TaskPlanner } from '../src/application/task-planner.ts';
import { withTextAttachments } from '../src/providers/text-attachments.ts';
import { OpenAICompatibleProvider } from '../electron/providers/openai-compatible.ts';
import { AnthropicProvider } from '../electron/providers/anthropic.ts';
import { OllamaProvider } from '../electron/providers/ollama.ts';
import { CodexCliProvider } from '../electron/providers/codex-cli.ts';
import type { ProviderRequest, AIProvider } from '../src/providers/ai-provider.ts';
import { historySnapshot } from '../src/domain/loop-history.ts';

const output = '  Original 원문 😀 $& {0}\r\nDo not translate.  ';
const plan = { title: 'Generated 계획', steps: [
  { title: '초안 작성', role: 'write', objective: 'Original 목표', usesPreviousOutputs: false, isFinal: false, dependsOn: [] },
  { title: '결과', role: 'deliver', objective: 'Preserve 원문', usesPreviousOutputs: true, isFinal: true, dependsOn: [1] },
] };
const requests = ['한국어로 작성해 주세요.', 'Please answer in English.', '한국어와 English mixed.', 'Write a note.'];
const attachmentText = '첨부 raw data\r\n  $& {0}';
const attachments = [{ id: '00000000-0000-4000-8000-000000000001', name: '참고.txt', type: 'txt' as const, text: attachmentText, size: Buffer.byteLength(attachmentText) }];
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

test('runtime missing keys use safe locale fallback without an identifier or exception', () => {
  assert.equal(translate('en', 'private_missing_key' as MessageKey), 'Information unavailable.');
  assert.equal(translate('ko', 'private_missing_key' as MessageKey), '정보를 표시할 수 없습니다.');
});
test('unknown errors and tampered coded messages never expose diagnostic secrets', () => {
  for (const locale of ['ko','en'] as const) for (const raw of ['secret-token at C:\\Users\\person', '[TIMEOUT] secret-token', '[UNKNOWN_CODE] secret-token']) {
    const translated = localizeError(locale, raw); assert.doesNotMatch(translated, /secret-token|Users|undefined/);
    if(locale === 'en') assert.doesNotMatch(translated, /[가-힣]/);
  }
});
test('provider display names are opaque even when they equal a translation key', () => {
  for(const name of ['완료','Running','검토','로컬 AI (Ollama)']) assert.equal(providerLabel('en',{id:'custom',displayName:name}), name);
  assert.equal(providerLabel('en',{id:'ollama-local',displayName:'로컬 AI (Ollama)'}),'Local AI (Ollama)');
});
test('catalog keys are unique, nonempty, placeholder-aligned and every literal t call exists', async () => {
  const catalog = await readFile(new URL('../src/i18n/catalog.ts',import.meta.url),'utf8');
  const keys = [...catalog.matchAll(/^  ("(?:[^"\\]|\\.)*"):/gm)].map(m=>JSON.parse(m[1]!));
  assert.equal(new Set(keys).size,keys.length); assert.equal(keys.length,Object.keys(english).length);
  for(const key of keys) { assert.ok(key.trim()); assert.ok(english[key as MessageKey].trim()); }
  const root = new URL('../src/',import.meta.url);
  for(const file of await readdir(root,{recursive:true})) if(/\.tsx?$/.test(file) && !file.includes('catalog')) {
    const source=await readFile(new URL(file.replaceAll('\\','/'),root),'utf8');
    for(const m of source.matchAll(/\bt\(\s*((?:"(?:[^"\\]|\\.)*")|(?:'[^'\n]*'))/g)) {
      const key=m[1]!.startsWith('"')?JSON.parse(m[1]!):m[1]!.slice(1,-1).replaceAll('\\n','\n').replaceAll('\\r','\r').replaceAll("\\'","'");
      assert.ok(Object.hasOwn(english,key),`${file}: missing ${key}`);
    }
  }
});

for(const type of ['openai','claude','ollama','codex'] as const) for(const userRequest of requests) test(`${type}: identical real-adapter inputs under ko/en UI for ${userRequest}`, async () => {
  const captured: { data: string; args?: readonly string[]; cwd?: string }[]=[];
  const fetcher: typeof fetch = async (url, init={}) => {
    const route=new URL(String(url)).pathname;
    if(route==='/api/version') return json({version:'0.34.0'});
    if(route==='/api/tags') return json({models:[{name:'fixture:latest',model:'fixture:latest',size:1,digest:'a'.repeat(64),details:{format:'gguf'}}]});
    if(route==='/api/show') return json({details:{format:'gguf'},model_info:{architecture:'synthetic'},capabilities:['completion']});
    captured.push({data:JSON.stringify({url:String(url),body:String(init.body),headers:init.headers})});
    return json(type==='openai'?{choices:[{message:{content:output},finish_reason:'stop'}]}:type==='claude'?{type:'message',role:'assistant',content:[{type:'text',text:output}],stop_reason:'end_turn'}:{model:'fixture:latest',done:true,done_reason:'stop',message:{role:'assistant',content:output}});
  };
  let provider: AIProvider;
  if(type==='openai') provider=new OpenAICompatibleProvider({id:'openai-compatible',displayName:'Fixture',model:'fixture',apiKey:'fake-key',baseUrl:'https://fixture.invalid/v1'},fetcher);
  else if(type==='claude') provider=new AnthropicProvider({model:'fixture',apiKey:'fake-key'},fetcher);
  else if(type==='ollama') {
    const ollama=new OllamaProvider({read:async()=> 'fixture:latest',save:async()=>{}},{installed:async()=>true,fetch:fetcher});
    await ollama.refresh(); assert.equal(ollama.configured,true); provider=ollama;
  } else provider=new CodexCliProvider(true,{environment:{},discover:async()=>({file:'never-spawned',prefix:[]}),run:async(_cmd,args,options)=>{
    if(args.includes('--version')) return {code:0,stdout:'codex-cli 0.160.1',stderr:''};
    if(args.includes('--help')) return {code:0,stdout:'--json --ephemeral --ignore-user-config --ignore-rules --strict-config --sandbox --skip-git-repo-check --stdio',stderr:''};
    if(args[0]==='login') return {code:0,stdout:'Logged in using ChatGPT',stderr:''};
    if(args[0]==='app-server') return {code:0,stdout:'',stderr:''};
    captured.push({data:options.input!,args:[...args],cwd:options.cwd});
    return {code:0,stderr:'',stdout:[{type:'thread.started',thread_id:'synthetic'},{type:'turn.started'},{type:'item.completed',item:{id:'synthetic',type:'agent_message',phase:'final_answer',text:output}},{type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}].map(v=>JSON.stringify(v)).join('\n')+'\n'};
  }});
  const request: ProviderRequest={userRequest,stepTitle:'초안 생성',objective:'Keep 원래 goal.',previousOutputs:['이전 원문\r\n  ','Review $& {0}'],isFinalStep:true,...(type==='codex'||type==='ollama'?{}:{attachments})};
  // Test adapter defense even if a caller explicitly supplies the obsolete real-provider locale.
  for(const locale of ['ko','en'] as const) assert.equal((await provider.execute({...request,locale})).output,output);
  assert.equal(captured.length,2); assert.equal(captured[0]!.data,captured[1]!.data);
  assert.deepEqual(captured[0]!.args,captured[1]!.args);
  for(const call of captured) if(call.cwd) await assert.rejects(access(call.cwd));
  const registry=new ProviderRegistry(); registry.register(provider,{type,configured:true});
  const gateway=createProviderGateway(registry); const ipcRequests: ProviderRequest[]=[];
  const bridge={...gateway,executeProvider:async(input:Parameters<typeof gateway.executeProvider>[0])=>{ipcRequests.push(input.request);return gateway.executeProvider(input);}};
  for(const locale of ['ko','en'] as const) assert.equal((await new IpcProvider(registry.list()[0]!,bridge,locale).execute({...request,locale})).output,output);
  assert.deepEqual(ipcRequests[0],ipcRequests[1]); assert.equal(Object.hasOwn(ipcRequests[0]!,'locale'),false);
  assert.equal(captured[2]!.data,captured[3]!.data);
  for(const call of captured) if(call.cwd) await assert.rejects(access(call.cwd));
});

for(const mode of ['single','manual','planner-recovery'] as const) test(`${mode}: renderer adapter preserves request/context/attachments and history across UI language`, async()=>{
  const traces: ProviderRequest[][]=[]; const results: string[]=[];
  for(const locale of ['ko','en'] as Locale[]) {
    const trace: ProviderRequest[]=[]; traces.push(trace); let calls=0;
    const registry=new ProviderRegistry();
    for(const id of ['primary','reviewer']) registry.register({id,displayName:id,execute:async request=>{trace.push(request);calls++;return {output: mode==='planner-recovery'?(calls===1?'invalid':JSON.stringify(plan)):output};}},{type:'api',configured:true});
    const gateway=createProviderGateway(registry);const adapters=new ProviderRegistry();
    for(const connection of registry.list()) adapters.register(withTextAttachments(new IpcProvider(connection,gateway,locale),attachments),connection);
    if(mode==='planner-recovery') {
      const result=await new TaskPlanner(adapters.get('primary')).plan('Original 요청');assert.deepEqual(result,plan);assert.equal(calls,2);
    }else {
      const service=mode==='manual'?new LoopService(new DraftReviewImprove('primary','reviewer'),adapters):new LoopService(new MockPlanner('single-work',locale),adapters.get('primary'));
      const loop=await service.run(service.create('Original 요청','manual')); assert.equal(loop.status,'completed');
      assert.equal(loop.finalResult,output);assert.equal(historySnapshot(loop).finalResult,output);results.push(loop.finalResult!);
      assert.equal(calls,mode==='manual'?3:1);
    }
  }
  assert.deepEqual(traces[0],traces[1]);assert.deepEqual(results,mode==='planner-recovery'?[]:[output,output]);
  for(const request of traces.flat()) {assert.equal(request.userRequest,'Original 요청'); assert.deepEqual(request.attachments,attachments); assert.equal(request.locale,undefined);}
});

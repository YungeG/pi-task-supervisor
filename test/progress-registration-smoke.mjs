// Actual owned SDK / trusted host-registration resource probe. Not progress credit,
// real CLI/human/product acceptance, or a new execution/permission mechanism.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {createAgentSession,createEventBus,ModelRuntime,DefaultResourceLoader,SessionManager,SettingsManager} from '@earendil-works/pi-coding-agent';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),artifacts=resolve(root,'../control-remediation-artifacts');
const count=Number(process.env.P8_REGISTRATION_COUNT??'1');assert([1,10,100].includes(count));assert.equal(process.version,'v25.9.0');
const dir=mkdtempSync(join(tmpdir(),'owned-p8-registration-')),previous=process.env.PI_CODING_AGENT_DIR,fetch=globalThis.fetch;
let session,passed=false,result=null,metrics=null,failure=null,network=0;
const errors=[];
const tool=(name,args,id)=>fauxAssistantMessage(fauxToolCall(name,args,{id}),{stopReason:'toolUse'});
const latest=manager=>[...manager.getBranch()].reverse().find(row=>row.type==='custom'&&row.customType==='continuous-tasks:supervisor'&&row.data.version===3)?.data;
try{
 process.env.PI_CODING_AGENT_DIR=dir;globalThis.fetch=async()=>{network++;throw Error('Owned registration probe forbids network');};
 execFileSync('git',['init','--quiet',dir],{stdio:'ignore',timeout:2000});writeFileSync(join(dir,'.gitignore'),'*\n!.gitignore\n!fixed-input.txt\n');writeFileSync(join(dir,'fixed-input.txt'),'Fixed owned input\n');
 const runtime=await ModelRuntime.create({refreshOnCreate:false,modelsPath:null}),faux=fauxProvider({provider:'owned-p8-registration-faux',models:[{id:'test',contextWindow:128000}]});runtime.registerNativeProvider(faux.provider);const model=runtime.getModel('owned-p8-registration-faux','test');assert(model);
 const manager=SessionManager.create(dir,join(dir,'sessions')),settingsManager=SettingsManager.inMemory({compaction:{enabled:false}}),events=createEventBus();
 events.on('owned-p8-registration',value=>{metrics=value;});events.on('owned-p8-registration-failure',value=>{failure=value;});
 const advice=action=>context=>{const packet=JSON.parse(context.messages.findLast(message=>message.role==='user').content);assert.equal(packet.goal,'Owned bounded registration resource');assert.equal(packet.progress.credited,0);return fauxAssistantMessage(JSON.stringify({action,message:action==='hold'?'Owned bounded registration sample complete; never Goal acceptance':'Claim the owned implementing task',taskIds:['t-1.1'],evidenceRefs:[]}));};
 faux.setResponses([
  tool('write_tasks',{mode:'replace',phases:[{title:'Implement',tasks:[{title:'Owned registration',prompt:'Fixed metadata only',profile:'main'}]},{title:'Final',tasks:[{title:'Do not accept',prompt:'Keep incomplete',profile:'main'}]}]},'plan'),
  tool('edit_tasks',{tasks:[{id:'t-2.1',type:'blockers',data:{dependencies:['t-1.1']}}]},'deps'),
  tool('compile_tasks',{finalAcceptanceTaskId:'t-2.1'},'compile'),fauxAssistantMessage('Owned plan ready.'),advice('next_batch'),
  tool('get_ready_tasks',{count:1},'claim'),fauxAssistantMessage('Bounded trusted host registrations only; task remains implementing.'),advice('hold'),
 ]);
 const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,eventBus:events,noSkills:true,noPromptTemplates:true,noContextFiles:true,additionalExtensionPaths:[join(root,'test/progress-registration-extension.ts')]});await loader.reload();
 const created=await createAgentSession({cwd:dir,agentDir:dir,modelRuntime:runtime,model,resourceLoader:loader,settingsManager,sessionManager:manager,noTools:'builtin'});assert.deepEqual(created.extensionsResult.errors,[]);session=created.session;
 await session.bindExtensions({mode:'rpc',uiContext:{setWidget(){},setStatus(){},notify(){}},onError:error=>errors.push(String(error)),commandContextActions:{waitForIdle:()=>session.waitForIdle()}});
 const command=session.extensionRunner.getCommand('task-supervisor');assert(command);void session.prompt('Exercise the owned trusted-host registration-resource mechanism').catch(error=>errors.push(String(error)));
 const deadline=Date.now()+20000;while(latest(manager)?.status!=='paused'){if(Date.now()>deadline)throw Error(`Owned registration did not settle: ${JSON.stringify({failure,errors,state:latest(manager)})}`);await new Promise(done=>setTimeout(done,5));}await session.waitForIdle();
 assert.deepEqual(errors,[]);assert.equal(failure,null);assert(metrics,'Actual registration measurements missing');assert.equal(metrics.registered,count);assert.equal(metrics.definitions,count);assert(metrics.elapsedMs<=10000,'Original100-call10s budget is unchanged');assert.equal(metrics.source,'actual-sdk-get_ready_tasks-kernel-end');if(count===100)assert.equal(metrics.capHeld,true);
 assert(metrics.decode.entries<=8192&&metrics.decode.bytes<=32*1024*1024);assert.equal(latest(manager).holdCause,'advisor_hold');assert.equal(latest(manager).reviews,2);assert.equal(latest(manager).continuations,1);
 const board=[...manager.getBranch()].reverse().find(row=>row.type==='custom'&&row.customType==='continuous-tasks:snapshot')?.data;assert.equal(board.tasks[0].status,'implementing');assert.equal(board.tasks[1].status,'configured');
 const defs=manager.getBranch().filter(row=>row.type==='custom'&&row.customType==='continuous-tasks:control-facts'&&row.data.kind==='progress-definition');assert.equal(defs.length,count);assert.equal(new Set(defs.map(row=>row.data.definitionId)).size,count);assert.equal(manager.getBranch().filter(row=>row.type==='custom'&&row.customType==='continuous-tasks:control-facts'&&row.data.kind==='progress-observed').length,0);assert.equal(network,0);assert.equal(faux.getPendingResponseCount(),0);
 const file=manager.getSessionFile();assert(file);result={result:'PASS',kind:'actual-owned-sdk-trusted-registration-resource',count,metrics,settledJournalBytes:statSync(file).size,modelCalls:faux.state.callCount,network,taskStillImplementing:true,goalAccepted:false,original100CallBudgetMs:10000,realCliHumanProductAcceptance:false};
 const output=process.env.P8_REGISTRATION_REPORT;if(output){assert.equal(dirname(resolve(output)),artifacts);assert.match(basename(output),/^p8-[a-z0-9-]+\.json$/);writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});}
 console.log(JSON.stringify(result));passed=true;
}catch(error){console.error(JSON.stringify({result:'FAIL',count,dir,metrics,failure,errors,error:error instanceof Error?error.message:'Unknown failure',nativeTaskCompletion:false}));throw error;
}finally{session?.dispose();globalThis.fetch=fetch;if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;if(passed)rmSync(dir,{recursive:true,force:true});else console.error('Owned registration failure retained:',dir);}

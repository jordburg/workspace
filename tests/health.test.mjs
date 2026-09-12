import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHealthService, HealthError, loopbackWorkspace } from '../build/health.ts';
import { healthSnapshotSchema, healthWorkoutDay, healthWorkoutTimeZone, uniqueHealthWorkouts } from '../lib/health.ts';

test('Health snapshots preserve missing values and reject incomplete date ranges',()=>{
  const sample={version:1,id:randomUUID(),generatedAt:new Date().toISOString(),timeZone:'America/Los_Angeles',from:'2026-09-11',to:'2026-09-11',days:[{date:'2026-09-11',steps:null,sleepMinutes:null,restingHeartRate:null,weightKg:null}],workouts:[]};
  assert.equal(healthSnapshotSchema.parse(sample).days[0].steps,null);
  assert.equal(healthSnapshotSchema.safeParse({...sample,to:'2026-09-12'}).success,false);
});
test('Health wire offsets validate and workout dates prefer recorded zones with case-insensitive UUID dedupe',()=>{
  const id=randomUUID(),base={id,name:'Climbing',start:'2026-09-11T06:30:00Z',end:'2026-09-11T08:00:00Z',minutes:90,activity:'climbing',sourceId:null,sourceName:null};
  const recorded={...base,timeZone:'America/Los_Angeles'};
  assert.equal(healthWorkoutTimeZone(recorded,'UTC'),'America/Los_Angeles');
  assert.equal(healthWorkoutDay(recorded,'UTC'),'2026-09-10');
  assert.equal(healthWorkoutDay({...base,timeZone:null},'UTC'),'2026-09-11');
  assert.equal(uniqueHealthWorkouts([recorded,{...recorded,id:id.toUpperCase()}]).length,1);
  const sample={version:1,id:randomUUID(),generatedAt:new Date().toISOString(),timeZone:'-07:00',from:'2026-09-11',to:'2026-09-11',days:[{date:'2026-09-11',steps:null,sleepMinutes:null,restingHeartRate:null,weightKg:null}],workouts:[{...recorded,timeZone:'+05:30'}]};
  assert.equal(healthSnapshotSchema.parse(sample).timeZone,'-07:00');
});
test('Health workouts accept legacy snapshots and preserve enriched climbing provenance',()=>{
  const base={version:1,id:randomUUID(),generatedAt:new Date().toISOString(),timeZone:'America/Los_Angeles',from:'2026-09-11',to:'2026-09-11',days:[{date:'2026-09-11',steps:null,sleepMinutes:null,restingHeartRate:null,weightKg:null}]};
  const legacy={id:randomUUID(),name:'Workout',start:'2026-09-11T18:00:00-07:00',end:'2026-09-11T19:30:00-07:00',minutes:82};
  const parsedLegacy=healthSnapshotSchema.parse({...base,workouts:[legacy]}).workouts[0];
  assert.deepEqual({activity:parsedLegacy.activity,sourceId:parsedLegacy.sourceId,sourceName:parsedLegacy.sourceName,timeZone:parsedLegacy.timeZone},{activity:'other',sourceId:null,sourceName:null,timeZone:null});
  const climbing={...legacy,name:'Climbing',activity:'climbing',sourceId:'com.apple.health|Watch6,18',sourceName:'Apple Health · Apple Watch',timeZone:'America/Los_Angeles'};
  assert.deepEqual(healthSnapshotSchema.parse({...base,workouts:[climbing]}).workouts[0],climbing);
  assert.equal(healthSnapshotSchema.safeParse({...base,workouts:[{...climbing,activity:'stair-climbing'}]}).success,false);
  assert.equal(healthSnapshotSchema.safeParse({...base,workouts:[{...climbing,timeZone:'Not/A_Time_Zone'}]}).success,false);
});
test('Workspace loopback stops a chunked response above the 10 MB phone limit',async()=>{
  const desktop=createServer((_req,res)=>{
    res.writeHead(200,{'Content-Type':'application/json'});res.write('{"value":"');
    const chunk=Buffer.alloc(100_000,120);for(let index=0;index<101;index++)res.write(chunk);res.end('"}');
  });
  await new Promise(resolve=>desktop.listen(0,'127.0.0.1',resolve));
  try{
    await assert.rejects(loopbackWorkspace({httpServer:desktop},'/large','GET'),error=>{
      assert.equal(error instanceof HealthError,true);assert.equal(error.status,413);assert.match(error.message,/too large for the phone/);return true;
    });
  }finally{desktop.closeAllConnections();await new Promise(resolve=>desktop.close(resolve));}
});
test('Health HTTPS pairing, private device scope, and confirmed weight receipts',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'workspace-health-'));const proxyCalls=[];let mutationAuthorized;const app=createHealthService(directory,{addresses:()=>['127.0.0.1'],port:0,onPhoneWorkspaceMutationAuthorized:path=>mutationAuthorized?.(path),workspaceRequest:async(path,method,body)=>{proxyCalls.push({path,method,body});if(path==='/api/workspace'&&method==='GET')return {status:200,data:{version:1,revision:4,items:[]}};if(path==='/api/workspace'&&method==='PUT')return {status:200,data:{...body,revision:body.revision+1}};if(path==='/api/chess'&&method==='GET')return {status:200,data:{capability:{id:'chess',version:1,canWrite:true},catalog:{courses:[],lessons:[]},reviewQueue:[],state:{version:1,revision:0,progress:[],reviewCards:[],reviewAttempts:[],studySessions:[]},summary:{reviewsDue:0}}};if(path==='/api/chess/progress'&&method==='POST')return {status:200,data:{view:{state:{revision:body.revision+1}},replayed:false}};if(path==='/api/chess/review'&&method==='POST')return {status:200,data:{view:{state:{revision:body.revision+1}},replayed:false,result:{grade:'good'}}};if(path==='/api/chess/session'&&method==='POST')return {status:200,data:{view:{state:{revision:body.revision+1}},replayed:false,session:{id:body.requestId}}};if(path==='/api/integrations/gmail/mutate'&&method==='POST')return {status:200,data:{gmail:{connected:true},messages:[]}};if(path==='/api/integrations/gmail/send'&&method==='POST')return {status:200,data:{gmail:{connected:true},messages:[]}};if(path==='/api/writing')throw new HealthError('This Workspace response is too large for the phone. Narrow the requested history on the Mac.',413);return {status:404,data:{error:'Unknown local route'}};}});const server=createServer(app.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  const local=async(path,body={})=>{const r=await fetch(origin+'/api/health'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  try{
    let publicView=await (await fetch(origin+'/api/health')).json();assert.equal(publicView.enabled,false);
    const enabled=await local('/enable',{address:'127.0.0.1'});assert.equal(enabled.status,200);assert.equal(enabled.data.online,true);
    const pairing=(await local('/pairing')).data;assert.equal(pairing.version,2);assert.equal(pairing.type,'personal-workspace-pairing');assert.equal(pairing.scope,'workspace');const cert=await readFile(join(directory,'health-certificate.pem'));
    const phone=(path,token,body,pin=pairing.fingerprint)=>new Promise((resolve,reject)=>{
      const req=request(pairing.url+path,{method:body===undefined?'GET':'POST',ca:cert,headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},checkServerIdentity:(host,certificate)=>checkServerIdentity(host,certificate)||(createHash('sha256').update(certificate.raw).digest('hex')!==pin?new Error('Certificate pin mismatch'):undefined)},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString())}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
    });
    const heldPhonePost=(path,token,payload)=>{
      const split=Math.max(1,Math.floor(payload.length/2));let req;
      const result=new Promise((resolve,reject)=>{req=request(pairing.url+path,{method:'POST',ca:cert,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)},checkServerIdentity:(host,certificate)=>checkServerIdentity(host,certificate)||(createHash('sha256').update(certificate.raw).digest('hex')!==pairing.fingerprint?new Error('Certificate pin mismatch'):undefined)},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString())}));});req.on('error',reject);req.write(payload.slice(0,split));});
      return {result,finish:()=>req.end(payload.slice(split))};
    };
    await assert.rejects(phone('/commands','wrong',undefined,'0'.repeat(64)),/pin mismatch/);
    const paired=await phone('/pair',pairing.code,{});assert.equal(paired.status,200);const token=paired.data.token;
    assert.equal((await phone('/pair',pairing.code,{})).status,401);assert.equal((await phone('/commands','wrong')).status,401);
    assert.deepEqual((await phone('/capabilities',token)).data,{version:2,scope:'workspace',workspace:true,health:true});
    assert.equal((await phone('/v1/workspace','wrong')).status,401);
    assert.deepEqual((await phone('/v1/workspace',token)).data,{version:1,revision:4,items:[]});
    const changed={version:1,revision:4,items:[{id:randomUUID(),kind:'note',title:'From iPhone',area:'personal',date:null,time:null,endTime:null,done:false}]};
    assert.equal((await phone('/v1/workspace',token,changed)).data.revision,5);assert.deepEqual(proxyCalls.slice(-2),[{path:'/api/workspace',method:'GET',body:undefined},{path:'/api/workspace',method:'PUT',body:changed}]);
    assert.equal((await phone('/v1/chess',token)).data.capability.id,'chess');assert.deepEqual(proxyCalls.at(-1),{path:'/api/chess',method:'GET',body:undefined});
    const chessProgress={revision:0,requestId:randomUUID(),courseId:'sicilian-defense',lessonId:'sicilian-najdorf-foundations',currentSegmentId:'why-c5',currentStepId:null,completedStepIds:[]};
    assert.equal((await phone('/v1/chess/progress',token,chessProgress)).data.view.state.revision,1);assert.deepEqual(proxyCalls.at(-1),{path:'/api/chess/progress',method:'POST',body:chessProgress});
    const chessReview={revision:0,requestId:randomUUID(),courseId:'sicilian-defense',lessonId:'sicilian-najdorf-foundations',stepId:'play-nf3',moveUci:'g1f3',reasonChoiceId:'prepare-d4'};
    assert.equal((await phone('/v1/chess/review',token,chessReview)).data.result.grade,'good');assert.deepEqual(proxyCalls.at(-1),{path:'/api/chess/review',method:'POST',body:chessReview});
    const chessSession={revision:1,requestId:randomUUID(),mode:'lesson',courseId:'sicilian-defense',lessonId:'sicilian-najdorf-foundations',startedAt:'2026-09-12T17:30:00.000Z',endedAt:'2026-09-12T17:50:00.000Z',stepIds:['play-nf3'],reviewAttemptIds:[]};
    assert.equal((await phone('/v1/chess/session',token,chessSession)).data.session.id,chessSession.requestId);assert.deepEqual(proxyCalls.at(-1),{path:'/api/chess/session',method:'POST',body:chessSession});
    const mailMutation={action:'archive',id:'message-1',version:'history-1',requestId:randomUUID()};
    assert.equal((await phone('/v1/integrations/gmail/mutate',token,mailMutation)).status,200);assert.deepEqual(proxyCalls.at(-1),{path:'/api/integrations/gmail/mutate',method:'POST',body:mailMutation});
    const mailSend={to:['friend@example.com'],cc:[],bcc:[],subject:'Hello',body:'From Workspace',requestId:randomUUID(),confirm:true};
    assert.equal((await phone('/v1/integrations/gmail/send',token,mailSend)).status,200);assert.deepEqual(proxyCalls.at(-1),{path:'/api/integrations/gmail/send',method:'POST',body:mailSend});
    assert.equal((await phone('/v1/integrations/gmail/send',token,{...mailSend,body:'x'.repeat(256_001)})).status,413);
    const oversized=await phone('/v1/writing',token);assert.equal(oversized.status,413);assert.match(oversized.data.error,/too large for the phone/);
    const sample={version:1,id:randomUUID(),generatedAt:new Date().toISOString(),timeZone:'America/Los_Angeles',from:'2026-09-11',to:'2026-09-11',days:[{date:'2026-09-11',steps:1234,sleepMinutes:null,restingHeartRate:60,weightKg:null}],workouts:[]};
    assert.equal((await phone('/snapshot',token,sample)).status,200);
    assert.equal((await phone('/snapshot',token,{...sample,generatedAt:'2026-01-01T00:00:00Z'})).status,409);
    const sleepBatch={version:1,generatedAt:new Date().toISOString(),timeZone:'UTC',from:'2026-09-10T00:00:00Z',to:'2026-09-11T00:00:00Z',samples:[{id:randomUUID(),start:'2026-09-10T01:00:00Z',end:'2026-09-10T07:00:00Z',stage:'core',sourceId:'test-watch',sourceName:'Synthetic watch'}],days:[{date:'2026-09-10',steps:3000,restingHeartRate:60,hrv:null,activeEnergy:null,exerciseMinutes:null,respiratoryRate:null,oxygenSaturation:null}]};
    assert.equal((await phone('/sleep-batch','wrong',sleepBatch)).status,401);
    assert.equal((await phone('/sleep-batch',token,sleepBatch)).status,200);
    assert.equal((await phone('/sleep-batch',token,sleepBatch)).status,200);
    let sleepView=await (await fetch(origin+'/api/health/sleep')).json();assert.equal(sleepView.samples.length,1);assert.equal(sleepView.settings.sourceId,'test-watch');
    const settings=await local('/sleep/settings',{...sleepView.settings,awakeMinutes:75,revision:sleepView.settingsRevision});assert.equal(settings.status,200);
    assert.equal((await local('/sleep/settings',{...sleepView.settings,revision:sleepView.settingsRevision})).status,409);
    const note=await local('/sleep/note',{date:'2026-09-10',revision:0,text:'夜'.repeat(4000),tags:['stress']});assert.equal(note.status,200);assert.equal(note.data.note.revision,1);
    assert.equal((await local('/sleep/note',{date:'2026-09-10',revision:0,text:'A stale overwrite',tags:[]})).status,409);
    assert.equal((await phone('/sleep-batch',token,{...sleepBatch,days:[]})).status,400);
    assert.equal((await phone('/sleep-batch',token,{...sleepBatch,samples:[],generatedAt:new Date().toISOString()})).status,200);
    sleepView=await (await fetch(origin+'/api/health/sleep')).json();assert.equal(sleepView.samples.length,0);assert.equal(sleepView.notes[0].text.length,4000);assert.equal(sleepView.settings.awakeMinutes,75);
    const command={id:randomUUID(),kg:75,measuredAt:new Date().toISOString()};const queued=await local('/weight',command);assert.equal(queued.status,200);assert.equal(queued.data.commands[0].status,'pending');
    assert.equal((await local('/weight',command)).data.commands.length,1);assert.equal((await local('/weight',{...command,kg:80})).status,409);
    const pending=(await phone('/commands',token)).data.commands[0];assert.equal((await phone('/receipt',token,{id:pending.id,payloadHash:'0'.repeat(64)})).status,409);
    assert.equal((await phone('/receipt',token,{id:pending.id,payloadHash:pending.payloadHash})).status,200);assert.equal((await phone('/commands',token)).data.commands.length,0);
    publicView=await (await fetch(origin+'/api/health')).json();assert.equal(publicView.phoneScope,'workspace');assert.equal(publicView.commands[0].status,'applied');assert.equal(publicView.snapshot.days[0].steps,1234);assert.equal(JSON.stringify(publicView).includes(token),false);assert.equal(JSON.stringify(publicView).includes(pairing.code),false);
    assert.equal((await fetch(origin+'/api/health',{headers:{Origin:'https://example.com'}})).status,403);
    const saved=JSON.parse(await readFile(join(directory,'health.private.json'),'utf8'));saved.tokenScope='health';await writeFile(join(directory,'health.private.json'),JSON.stringify(saved));
    assert.equal((await phone('/v1/workspace',token)).status,403);assert.equal((await phone('/v1/integrations/gmail/mutate',token,mailMutation)).status,403);assert.equal((await phone('/v1/integrations/gmail/send',token,mailSend)).status,403);assert.equal((await phone('/commands',token)).status,200);
    saved.tokenScope='workspace';await writeFile(join(directory,'health.private.json'),JSON.stringify(saved));
    assert.equal((await phone('/unpair',token)).status,404);
    const authorized=new Promise(resolve=>{mutationAuthorized=resolve;});const beforeRevocation=proxyCalls.length;const held=heldPhonePost('/v1/workspace',token,JSON.stringify({...changed,revision:5}));
    assert.equal(await authorized,'/v1/workspace');mutationAuthorized=undefined;assert.deepEqual((await phone('/unpair',token,{})).data,{revoked:true});held.finish();const revokedWrite=await held.result;assert.equal(revokedWrite.status,401);assert.equal(proxyCalls.length,beforeRevocation);assert.equal((await phone('/commands',token)).status,401);
    publicView=await (await fetch(origin+'/api/health')).json();assert.equal(publicView.paired,false);
    const legacyPairing=(await local('/pairing')).data;const legacyPaired=await phone('/pair',legacyPairing.code,{});const legacyToken=legacyPaired.data.token;
    const legacySaved=JSON.parse(await readFile(join(directory,'health.private.json'),'utf8'));delete legacySaved.tokenScope;await writeFile(join(directory,'health.private.json'),JSON.stringify(legacySaved));
    assert.deepEqual((await phone('/capabilities',legacyToken)).data,{version:2,scope:'health',workspace:false,health:true});assert.equal((await phone('/v1/workspace',legacyToken)).status,403);assert.equal((await phone('/commands',legacyToken)).status,200);assert.deepEqual((await phone('/unpair',legacyToken,{})).data,{revoked:true});assert.equal((await phone('/commands',legacyToken)).status,401);
    await local('/disable');assert.equal((await (await fetch(origin+'/api/health')).json()).paired,false);
  }finally{await app.stop();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}
});

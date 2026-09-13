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
      assert.equal(error instanceof HealthError,true);assert.equal(error.status,413);assert.match(error.message,/too large for the companion device/);return true;
    });
  }finally{desktop.closeAllConnections();await new Promise(resolve=>desktop.close(resolve));}
});
test('Health HTTPS multi-device pairing, private device scope, and confirmed weight receipts',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'workspace-health-'));
  const proxyCalls=[];
  const rawProxyCalls=[];
  let mutationAuthorized;
  const mediaBytes=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4]);
  const mediaGoalId=randomUUID(),mediaReferenceId=randomUUID(),planningLinkId=randomUUID(),gmailRelationId=randomUUID();
  const mediaState={version:1,revision:4,sessions:[],goals:[],routines:[],plans:[],goalReferences:[{id:mediaReferenceId,goalId:mediaGoalId,kind:'image',label:'Crux',url:null,fileName:'beta.png',mimeType:'image/png',byteSize:mediaBytes.length,createdAt:'2026-09-12T08:00:00.000Z'}]};
  const integrationView={
    todoist:{connected:true,configured:true,sources:[],selected:[],lastSynced:'2026-09-12T08:00:00.000Z',error:null},
    google:{connected:true,configured:true,sources:[],selected:[],lastSynced:'2026-09-12T08:00:00.000Z',error:null},
    gmail:{connected:true,configured:true,account:'private@example.com',unreadCount:1,relations:[{id:gmailRelationId,entityKind:'gmail-message'}]},
    tasks:[{id:'task-1',title:'Personal task'}],
    events:[{id:'event-1',title:'Personal event'}],
    messages:[{id:'mail-1',subject:'Private mail',snippet:'Never send this to the phone'}],
    links:[{id:planningLinkId,entityKind:'goal'}],
    range:null,
    privateServerField:'must never leave the Mac bridge',
  };
  const financeView={configured:true,banks:[{id:'bank-1',name:'Personal bank'}],transactions:[{id:'transaction-1',name:'Groceries'}]};
  const writingView={repository:'/Users/private/Documents/personal-site',available:true,error:null,entries:[{slug:'hello',title:'Hello'}],drafts:[],pendingExports:[]};
  const app=createHealthService(directory,{
    addresses:()=>['127.0.0.1'],
    port:0,
    onPhoneWorkspaceMutationAuthorized:path=>mutationAuthorized?.(path),
    workspaceRequest:async(path,method,body)=>{
      proxyCalls.push({path,method,body});
      if(path==='/api/workspace'&&method==='GET')return {status:200,data:{version:1,revision:4,items:[]}};
      if(path==='/api/workspace'&&method==='PUT')return {status:200,data:{...body,revision:body.revision+1}};
      if(path==='/api/workspace'&&method==='POST')return {status:200,data:{version:2,revision:5,items:[body.item],tombstones:[],receipts:[]}};
      if(path==='/api/climbing'&&method==='GET')return {status:200,data:{version:1,revision:2,sessions:[],goals:[],routines:[],plans:[]}};
      if(path==='/api/climbing'&&method==='POST')return {status:200,data:{version:1,revision:3,sessions:[],goals:[],routines:[],plans:[]}};
      if(path==='/api/climbing/media/link'&&method==='POST')return {status:200,data:mediaState};
      if(path==='/api/climbing/media/delete'&&method==='POST')return {status:200,data:{...mediaState,revision:5,goalReferences:[]}};
      if(path==='/api/chess'&&method==='GET')return {status:200,data:{capability:{id:'chess',version:1,canWrite:true},catalog:{courses:[],lessons:[]},reviewQueue:[],state:{version:1,revision:0,progress:[],reviewCards:[],reviewAttempts:[],studySessions:[]},summary:{reviewsDue:0}}};
      if(path==='/api/chess/progress'&&method==='POST')return {status:200,data:{view:{state:{revision:body.revision+1}},replayed:false}};
      if(path==='/api/chess/session'&&method==='POST')return {status:200,data:{view:{state:{revision:body.revision+1}},replayed:false,session:{id:body.requestId}}};
      if(path==='/api/chess/review'&&method==='POST')return {status:200,data:{view:{state:{revision:body.revision+1}},attempt:{id:body.requestId}}};
      if(path==='/api/finance'&&method==='GET')return {status:200,data:financeView};
      if(path==='/api/finance/sync'&&method==='POST')return {status:200,data:financeView};
      if(path==='/api/finance/annotate'&&method==='POST')return {status:200,data:financeView};
      if(path==='/api/writing'&&method==='GET')return {status:200,data:writingView};
      if(path==='/api/writing/save'&&method==='POST')return {status:200,data:{...writingView,drafts:[body]}};
      if(path==='/api/health'&&method==='GET')return {status:200,data:{enabled:true,online:true,paired:true,pairedDeviceCount:2,healthOwnerPaired:true,phoneScope:'workspace',endpoint:'https://127.0.0.1:5174',addresses:['127.0.0.1'],error:null,lastSynced:null,snapshot:null,commands:[{id:'private-command'}]}};
      if(path==='/api/integrations'&&method==='GET')return {status:200,data:integrationView};
      if(path==='/api/integrations/mutate/planning'&&method==='POST'&&body?.link?.entityKind==='gmail-message')return {status:403,data:{error:'Mail follow-ups can be created only from the iPad or Mac.'}};
      if(path==='/api/integrations/unlink/planning'&&method==='POST'&&body?.id===gmailRelationId)return {status:403,data:{error:'This link can be managed only from Mail on the iPad or Mac.'}};
      if(path.startsWith('/api/integrations/')&&method==='POST')return {status:200,data:integrationView};
      return {status:404,data:{error:'Unknown local route'}};
    },
    workspaceRawRequest:async(path,method,headers,body)=>{
      const chunks=[];
      if(body)for await(const chunk of body)chunks.push(Buffer.from(chunk));
      rawProxyCalls.push({path,method,headers,body:Buffer.concat(chunks)});
      if(path==='/api/climbing/media/upload'&&method==='POST')return new Response(JSON.stringify(mediaState),{status:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
      if(path===`/api/climbing/media/${mediaReferenceId}`&&method==='HEAD')return new Response(null,{status:200,headers:{'Content-Type':'image/png','Content-Length':String(mediaBytes.length),'Accept-Ranges':'bytes'}});
      if(path===`/api/climbing/media/${mediaReferenceId}`&&method==='GET'){
        const ranged=headers.range==='bytes=8-10';
        return new Response(ranged?mediaBytes.subarray(8,11):mediaBytes,{status:ranged?206:200,headers:{'Content-Type':'image/png','Content-Length':String(ranged?3:mediaBytes.length),'Accept-Ranges':'bytes',...(ranged?{'Content-Range':`bytes 8-10/${mediaBytes.length}`}:{})}});
      }
      return new Response(JSON.stringify({error:'Unknown local media route'}),{status:404,headers:{'Content-Type':'application/json'}});
    },
  });
  const server=createServer(app.handle);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const local=async(path,body={})=>{const r=await fetch(origin+'/api/health'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  try{
    let publicView=await (await fetch(origin+'/api/health')).json();assert.equal(publicView.enabled,false);assert.equal(publicView.pairedDeviceCount,0);assert.equal(publicView.healthOwnerPaired,false);
    const enabled=await local('/enable',{address:'127.0.0.1'});assert.equal(enabled.status,200);assert.equal(enabled.data.online,true);assert.equal(enabled.data.pairedDeviceCount,0);assert.equal(enabled.data.healthOwnerPaired,false);
    assert.equal((await local('/pairing',{})).status,400);
    const pairing=(await local('/pairing',{deviceClass:'phone'})).data;assert.equal(pairing.version,2);assert.equal(pairing.type,'personal-workspace-pairing');assert.equal(pairing.scope,'workspace');assert.equal(pairing.deviceClass,'phone');const cert=await readFile(join(directory,'health-certificate.pem'));
    const phone=(path,token,body,pin=pairing.fingerprint)=>new Promise((resolve,reject)=>{
      const req=request(pairing.url+path,{method:body===undefined?'GET':'POST',ca:cert,headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},checkServerIdentity:(host,certificate)=>checkServerIdentity(host,certificate)||(createHash('sha256').update(certificate.raw).digest('hex')!==pin?new Error('Certificate pin mismatch'):undefined)},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString())}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
    });
    const phoneRaw=(path,token,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
      const req=request(pairing.url+path,{method,ca:cert,headers:{Authorization:'Bearer '+token,...headers},checkServerIdentity:(host,certificate)=>checkServerIdentity(host,certificate)||(createHash('sha256').update(certificate.raw).digest('hex')!==pairing.fingerprint?new Error('Certificate pin mismatch'):undefined)},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:Buffer.concat(chunks)}));});req.on('error',reject);req.end(body);
    });
    const heldPhonePost=(path,token,payload)=>{
      const split=Math.max(1,Math.floor(payload.length/2));let req;
      const result=new Promise((resolve,reject)=>{req=request(pairing.url+path,{method:'POST',ca:cert,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)},checkServerIdentity:(host,certificate)=>checkServerIdentity(host,certificate)||(createHash('sha256').update(certificate.raw).digest('hex')!==pairing.fingerprint?new Error('Certificate pin mismatch'):undefined)},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString())}));});req.on('error',reject);req.write(payload.slice(0,split));});
      return {result,finish:()=>req.end(payload.slice(split))};
    };
    await assert.rejects(phone('/commands','wrong',undefined,'0'.repeat(64)),/pin mismatch/);
    const paired=await phone('/pair',pairing.code,{});assert.equal(paired.status,200);assert.equal(paired.data.deviceClass,'phone');let token=paired.data.token;
    const pairingReplay=await phone('/pair',pairing.code,{});assert.equal(pairingReplay.status,200);assert.equal(pairingReplay.data.token,token);assert.equal((await phone('/pair',pairing.code,{deviceClass:'tablet'})).status,403);assert.equal((await phone('/commands','wrong')).status,401);
    assert.deepEqual((await phone('/capabilities',token)).data,{version:2,scope:'workspace',deviceClass:'phone',workspace:true,health:true});
    const unboundWorkspacePairing=(await local('/pairing',{deviceClass:'phone'})).data;
    const unboundState=JSON.parse(await readFile(join(directory,'health.private.json'),'utf8'));delete unboundState.pairing.deviceClass;await writeFile(join(directory,'health.private.json'),JSON.stringify(unboundState));
    assert.equal((await phone('/pair',unboundWorkspacePairing.code,{deviceClass:'phone'})).status,409);assert.equal((await phone('/commands',token)).status,200);
    const replacementPairing=(await local('/pairing',{deviceClass:'phone'})).data;
    assert.equal((await phone('/pair',replacementPairing.code,{deviceClass:'watch'})).status,400);
    const replaced=await phone('/pair',replacementPairing.code,{deviceClass:'phone',replacesToken:token});assert.equal(replaced.status,200);const replacedToken=token;token=replaced.data.token;
    const replacementReplay=await phone('/pair',replacementPairing.code,{deviceClass:'phone',replacesToken:replacedToken});assert.equal(replacementReplay.status,200);assert.equal(replacementReplay.data.token,token);
    assert.notEqual(token,replacedToken);assert.equal((await phone('/commands',replacedToken)).status,401);publicView=await (await fetch(origin+'/api/health')).json();assert.equal(publicView.pairedDeviceCount,1);
    const secondPairing=(await local('/pairing',{deviceClass:'tablet'})).data;assert.equal(secondPairing.deviceClass,'tablet');assert.equal((await phone('/pair',secondPairing.code,{deviceClass:'phone'})).status,403);const secondPaired=await phone('/pair',secondPairing.code,{deviceClass:'tablet'}),secondToken=secondPaired.data.token;
    assert.equal(secondPaired.status,200);assert.equal(secondPaired.data.deviceClass,'tablet');assert.notEqual(secondToken,token);assert.deepEqual((await phone('/capabilities',token)).data,{version:2,scope:'workspace',deviceClass:'phone',workspace:true,health:true});assert.deepEqual((await phone('/capabilities',secondToken)).data,{version:2,scope:'workspace',deviceClass:'tablet',workspace:true,health:false});
    const anotherPhonePairing=(await local('/pairing',{deviceClass:'phone'})).data;
    const crossClassRotation=await phone('/pair',anotherPhonePairing.code,{deviceClass:'phone',replacesToken:secondToken});assert.equal(crossClassRotation.status,409);assert.match(crossClassRotation.data.error,/same device class/);
    assert.equal((await phone('/pair',anotherPhonePairing.code,{deviceClass:'phone'})).status,409);assert.equal((await phone('/commands',token)).status,200);
    publicView=await (await fetch(origin+'/api/health')).json();assert.equal(publicView.paired,true);assert.equal(publicView.pairedDeviceCount,2);assert.equal(publicView.healthOwnerPaired,true);assert.equal(publicView.phoneScope,'workspace');
    let savedTokenText=await readFile(join(directory,'health.private.json'),'utf8'),savedTokens=JSON.parse(savedTokenText);assert.equal(savedTokens.tokens.length,2);assert.deepEqual(savedTokens.tokens.map(entry=>entry.deviceClass).sort(),['phone','tablet']);assert.equal(Object.hasOwn(savedTokens,'tokenHash'),false);assert.equal(Object.hasOwn(savedTokens,'tokenScope'),false);assert.equal(savedTokenText.includes(token),false);assert.equal(savedTokenText.includes(secondToken),false);
    const invalidOwners=JSON.parse(savedTokenText);invalidOwners.tokens.push({hash:'a'.repeat(64),scope:'workspace',deviceClass:'phone'});await writeFile(join(directory,'health.private.json'),JSON.stringify(invalidOwners));assert.equal((await fetch(origin+'/api/health')).status,500);await writeFile(join(directory,'health.private.json'),savedTokenText);
    assert.equal((await phone('/v1/workspace','wrong')).status,401);
    assert.deepEqual((await phone('/v1/workspace',token)).data,{version:1,revision:4,items:[]});
    const changed={version:1,revision:4,items:[{id:randomUUID(),kind:'note',title:'From iPhone',area:'personal',date:null,time:null,endTime:null,done:false}]};
    assert.equal((await phone('/v1/workspace',token,changed)).data.revision,5);assert.deepEqual(proxyCalls.slice(-2),[{path:'/api/workspace',method:'GET',body:undefined},{path:'/api/workspace',method:'PUT',body:changed}]);
    const captureCommand={action:'upsert',requestId:randomUUID(),expectedItemRevision:null,item:changed.items[0]};
    assert.equal((await phone('/v1/workspace/command',token,captureCommand)).data.revision,5);assert.deepEqual(proxyCalls.at(-1),{path:'/api/workspace',method:'POST',body:captureCommand});
    assert.equal((await phone('/v1/climbing',token)).data.revision,2);assert.deepEqual(proxyCalls.at(-1),{path:'/api/climbing',method:'GET',body:undefined});
    const climbingCommand={requestId:randomUUID(),changes:[]};
    assert.equal((await phone('/v1/climbing/command',token,climbingCommand)).data.revision,3);assert.deepEqual(proxyCalls.at(-1),{path:'/api/climbing',method:'POST',body:climbingCommand});
    const linkReference={id:randomUUID(),goalId:mediaGoalId,kind:'link',label:'Route beta',url:'https://example.com/beta',fileName:null,mimeType:null,byteSize:null,createdAt:'2026-09-12T08:00:00.000Z'};
    const mediaLinkCommand={requestId:randomUUID(),reference:linkReference};
    assert.equal((await phone('/v1/climbing/media/link',token,mediaLinkCommand)).data.revision,4);
    assert.deepEqual(proxyCalls.at(-1),{path:'/api/climbing/media/link',method:'POST',body:mediaLinkCommand});
    const mediaDeleteCommand={requestId:randomUUID(),goalId:mediaGoalId,referenceId:mediaReferenceId};
    assert.equal((await phone('/v1/climbing/media/delete',token,mediaDeleteCommand)).data.revision,5);
    assert.deepEqual(proxyCalls.at(-1),{path:'/api/climbing/media/delete',method:'POST',body:mediaDeleteCommand});

    assert.equal((await phoneRaw(`/v1/climbing/media/${mediaReferenceId}`,'wrong')).status,401);
    assert.equal(rawProxyCalls.length,0);
    const uploadHeaders={
      'Content-Type':'image/png',
      'Content-Length':String(mediaBytes.length),
      'X-Workspace-Request-Id':randomUUID(),
      'X-Workspace-Reference-Id':mediaReferenceId,
      'X-Workspace-Goal-Id':mediaGoalId,
      'X-Workspace-File-Name':encodeURIComponent('beta.png'),
      'X-Workspace-Label':encodeURIComponent('Crux'),
      'X-Private-Header':'must-not-forward',
    };
    let mediaResponse=await phoneRaw('/v1/climbing/media/upload',token,{method:'POST',headers:uploadHeaders,body:mediaBytes});
    assert.equal(mediaResponse.status,200);
    assert.equal(JSON.parse(mediaResponse.data.toString()).goalReferences[0].id,mediaReferenceId);
    assert.equal(rawProxyCalls.at(-1).path,'/api/climbing/media/upload');
    assert.equal(rawProxyCalls.at(-1).method,'POST');
    assert.deepEqual(rawProxyCalls.at(-1).body,mediaBytes);
    assert.equal(rawProxyCalls.at(-1).headers['x-workspace-reference-id'],mediaReferenceId);
    assert.equal(Object.hasOwn(rawProxyCalls.at(-1).headers,'authorization'),false);
    assert.equal(Object.hasOwn(rawProxyCalls.at(-1).headers,'x-private-header'),false);

    mediaResponse=await phoneRaw(`/v1/climbing/media/${mediaReferenceId}`,token,{headers:{Range:'bytes=8-10'}});
    assert.equal(mediaResponse.status,206);
    assert.equal(mediaResponse.headers['content-range'],`bytes 8-10/${mediaBytes.length}`);
    assert.deepEqual(mediaResponse.data,mediaBytes.subarray(8,11));
    assert.deepEqual(rawProxyCalls.at(-1).headers,{range:'bytes=8-10'});
    mediaResponse=await phoneRaw(`/v1/climbing/media/${mediaReferenceId}`,token,{method:'HEAD'});
    assert.equal(mediaResponse.status,200);
    assert.equal(mediaResponse.headers['content-length'],String(mediaBytes.length));
    assert.equal(mediaResponse.data.length,0);
    const assertSanitizedIntegration=response=>{
      assert.equal(response.status,200);
      assert.equal(Object.hasOwn(response.data,'gmail'),false);
      assert.equal(Object.hasOwn(response.data,'messages'),false);
      assert.equal(Object.hasOwn(response.data,'privateServerField'),false);
      assert.equal(response.data.tasks[0].title,'Personal task');
      assert.equal(JSON.stringify(response.data).includes('Private mail'),false);
    };
    assertSanitizedIntegration(await phone('/v1/integrations',token));
    assert.deepEqual(proxyCalls.at(-1),{path:'/api/integrations',method:'GET',body:undefined});
    const integrationSync={date:'2026-09-12',timeZone:'America/Los_Angeles'};
    assertSanitizedIntegration(await phone('/v1/integrations/sync',token,integrationSync));
    assert.deepEqual(proxyCalls.at(-1),{path:'/api/integrations/sync',method:'POST',body:integrationSync});
    const todoistMutation={provider:'todoist',action:'complete',id:'task-1',version:'version-1',requestId:randomUUID(),anchorDate:'2026-09-12'};
    assertSanitizedIntegration(await phone('/v1/integrations/mutate',token,todoistMutation));
    assert.deepEqual(proxyCalls.at(-1),{path:'/api/integrations/mutate/planning',method:'POST',body:todoistMutation});
    const unlink={id:planningLinkId};
    assertSanitizedIntegration(await phone('/v1/integrations/unlink',token,unlink));
    assert.deepEqual(proxyCalls.at(-1),{path:'/api/integrations/unlink/planning',method:'POST',body:unlink});
    const gmailLinkedMutation={provider:'todoist',action:'create',sourceId:'personal',title:'Follow up: Private mail',date:'2026-09-12',anchorDate:'2026-09-12',timeZone:'America/Los_Angeles',requestId:randomUUID(),link:{entityKind:'gmail-message',entityId:'mail-1',role:'follow-up-task'}};
    assert.equal((await phone('/v1/integrations/mutate',token,gmailLinkedMutation)).status,403);assert.deepEqual(proxyCalls.at(-1),{path:'/api/integrations/mutate/planning',method:'POST',body:gmailLinkedMutation});
    assert.equal((await phone('/v1/integrations/mutate',secondToken,gmailLinkedMutation)).status,200);assert.deepEqual(proxyCalls.at(-1),{path:'/api/integrations/mutate',method:'POST',body:gmailLinkedMutation});
    const gmailUnlink={id:gmailRelationId};
    assert.equal((await phone('/v1/integrations/unlink',token,gmailUnlink)).status,403);assert.deepEqual(proxyCalls.at(-1),{path:'/api/integrations/unlink/planning',method:'POST',body:gmailUnlink});
    assert.equal((await phone('/v1/integrations/unlink',secondToken,gmailUnlink)).status,200);assert.deepEqual(proxyCalls.at(-1),{path:'/api/integrations/unlink',method:'POST',body:gmailUnlink});
    const tabletIntegrations=await phone('/v1/integrations',secondToken);
    assert.equal(tabletIntegrations.status,200);assert.equal(tabletIntegrations.data.gmail.account,'private@example.com');assert.equal(tabletIntegrations.data.messages[0].subject,'Private mail');assert.equal(Object.hasOwn(tabletIntegrations.data,'privateServerField'),false);
    assert.equal((await phone('/v1/chess',token)).data.capability.id,'chess');assert.deepEqual(proxyCalls.at(-1),{path:'/api/chess',method:'GET',body:undefined});
    const chessProgress={revision:0,requestId:randomUUID(),courseId:'scotch-game',lessonId:'scotch-game-foundations',currentSegmentId:'scotch-purpose',currentStepId:null,completedStepIds:[]};
    assert.equal((await phone('/v1/chess/progress',token,chessProgress)).data.view.state.revision,1);assert.deepEqual(proxyCalls.at(-1),{path:'/api/chess/progress',method:'POST',body:chessProgress});
    const chessSession={revision:1,requestId:randomUUID(),mode:'lesson',courseId:'scotch-game',lessonId:'scotch-game-foundations',startedAt:'2026-09-12T17:30:00.000Z',endedAt:'2026-09-12T17:50:00.000Z',stepIds:['scotch-strike-d4'],reviewAttemptIds:[]};
    assert.equal((await phone('/v1/chess/session',token,chessSession)).data.session.id,chessSession.requestId);assert.deepEqual(proxyCalls.at(-1),{path:'/api/chess/session',method:'POST',body:chessSession});
    const chessReview={revision:0,requestId:randomUUID(),courseId:'scotch-game',lessonId:'scotch-game-foundations',stepId:'scotch-strike-d4',moveUci:'d2d4',reasonChoiceId:'challenge-e5'};
    const mailMutation={action:'archive',id:'message-1',version:'history-1',requestId:randomUUID()};
    const mailSend={to:['friend@example.com'],cc:[],bcc:[],subject:'Hello',body:'From Workspace',requestId:randomUUID(),confirm:true};
    const tabletRoutes=[
      ['/v1/chess/review',chessReview],
      ['/v1/finance',undefined],
      ['/v1/finance/sync',{}],
      ['/v1/finance/annotate',{transactionId:'transaction-1',category:'Food',note:'Weekly groceries',excludeFromSpending:false,revision:0}],
      ['/v1/writing',undefined],
      ['/v1/writing/save',{id:randomUUID(),revision:0,slug:'ipad-draft',title:'iPad draft'}],
      ['/v1/integrations/gmail/sync',{}],
      ['/v1/integrations/gmail/mutate',mailMutation],
      ['/v1/integrations/gmail/send',mailSend],
    ];
    const beforeTabletRoutes=proxyCalls.length;
    for(const [path,body] of tabletRoutes)assert.equal((await phone(path,token,body)).status,403,path);
    assert.equal(proxyCalls.length,beforeTabletRoutes);
    assert.equal((await phone('/v1/chess/review',secondToken,chessReview)).data.attempt.id,chessReview.requestId);assert.deepEqual(proxyCalls.at(-1),{path:'/api/chess/review',method:'POST',body:chessReview});
    assert.equal((await phone('/v1/finance',secondToken)).data.banks[0].name,'Personal bank');assert.deepEqual(proxyCalls.at(-1),{path:'/api/finance',method:'GET',body:undefined});
    assert.equal((await phone('/v1/finance/sync',secondToken,{})).data.transactions[0].name,'Groceries');assert.deepEqual(proxyCalls.at(-1),{path:'/api/finance/sync',method:'POST',body:{}});
    const financeAnnotation=tabletRoutes[3][1];assert.equal((await phone('/v1/finance/annotate',secondToken,financeAnnotation)).status,200);assert.deepEqual(proxyCalls.at(-1),{path:'/api/finance/annotate',method:'POST',body:financeAnnotation});
    const writing=await phone('/v1/writing',secondToken);assert.equal(writing.status,200);assert.equal(writing.data.repository,'');assert.equal(writing.data.available,true);assert.equal(writing.data.entries[0].title,'Hello');assert.equal(JSON.stringify(writing.data).includes('/Users/private'),false);assert.deepEqual(proxyCalls.at(-1),{path:'/api/writing',method:'GET',body:undefined});
    const writingSave=tabletRoutes[5][1],savedWriting=await phone('/v1/writing/save',secondToken,writingSave);assert.equal(savedWriting.data.repository,'');assert.equal(savedWriting.data.drafts[0].title,'iPad draft');assert.equal(JSON.stringify(savedWriting.data).includes('/Users/private'),false);assert.deepEqual(proxyCalls.at(-1),{path:'/api/writing/save',method:'POST',body:writingSave});
    const tabletMailSync=await phone('/v1/integrations/gmail/sync',secondToken,{});assert.equal(tabletMailSync.data.messages[0].subject,'Private mail');assert.equal(Object.hasOwn(tabletMailSync.data,'privateServerField'),false);assert.deepEqual(proxyCalls.at(-1),{path:'/api/integrations/gmail/sync',method:'POST',body:{}});
    const tabletMailMutation=await phone('/v1/integrations/gmail/mutate',secondToken,mailMutation);assert.equal(tabletMailMutation.data.messages[0].subject,'Private mail');assert.equal(Object.hasOwn(tabletMailMutation.data,'privateServerField'),false);assert.deepEqual(proxyCalls.at(-1),{path:'/api/integrations/gmail/mutate',method:'POST',body:mailMutation});
    const tabletMailSend=await phone('/v1/integrations/gmail/send',secondToken,mailSend);assert.equal(tabletMailSend.data.gmail.account,'private@example.com');assert.equal(Object.hasOwn(tabletMailSend.data,'privateServerField'),false);assert.deepEqual(proxyCalls.at(-1),{path:'/api/integrations/gmail/send',method:'POST',body:mailSend});
    const tabletHealthView=await phone('/v1/health-view',secondToken);assert.equal(tabletHealthView.status,200);assert.equal(tabletHealthView.data.healthOwnerPaired,true);assert.deepEqual(tabletHealthView.data.commands,[]);assert.deepEqual(proxyCalls.at(-1),{path:'/api/health',method:'GET',body:undefined});
    const sample={version:1,id:randomUUID(),generatedAt:new Date().toISOString(),timeZone:'America/Los_Angeles',from:'2026-09-11',to:'2026-09-11',days:[{date:'2026-09-11',steps:1234,sleepMinutes:null,restingHeartRate:60,weightKg:null}],workouts:[]};
    assert.equal((await phone('/commands',secondToken)).status,403);assert.equal((await phone('/snapshot',secondToken,sample)).status,403);
    assert.equal((await phone('/snapshot',token,sample)).status,200);
    assert.equal((await phone('/snapshot',token,{...sample,generatedAt:'2026-01-01T00:00:00Z'})).status,409);
    const sleepBatch={version:1,generatedAt:new Date().toISOString(),timeZone:'UTC',from:'2026-09-10T00:00:00Z',to:'2026-09-11T00:00:00Z',samples:[{id:randomUUID(),start:'2026-09-10T01:00:00Z',end:'2026-09-10T07:00:00Z',stage:'core',sourceId:'test-watch',sourceName:'Synthetic watch'}],days:[{date:'2026-09-10',steps:3000,restingHeartRate:60,hrv:null,activeEnergy:null,exerciseMinutes:null,respiratoryRate:null,oxygenSaturation:null}]};
    assert.equal((await phone('/sleep-batch','wrong',sleepBatch)).status,401);
    assert.equal((await phone('/sleep-batch',secondToken,sleepBatch)).status,403);assert.equal((await phone('/receipt',secondToken,{id:randomUUID(),payloadHash:'0'.repeat(64)})).status,403);
    assert.equal((await phone('/sleep-batch',token,sleepBatch)).status,200);
    assert.equal((await phone('/sleep-batch',token,sleepBatch)).status,200);
    let sleepView=await (await fetch(origin+'/api/health/sleep')).json();assert.equal(sleepView.samples.length,1);assert.equal(sleepView.settings.sourceId,'test-watch');
    const sleepFile=join(directory,'sleep.private.json'),sleepBeforeUserChanges=await readFile(sleepFile,'utf8');
    const summaryUrl=origin+'/api/health/sleep/summary?sourceId=test-watch&from=2026-09-01&to=2026-09-10';
    let summaryResponse=await fetch(summaryUrl),summary=await summaryResponse.json(),summaryTag=summaryResponse.headers.get('etag');
    assert.equal(summaryResponse.status,200);assert.match(summaryTag,/^"[a-f0-9]{64}"$/);assert.equal(summary.sourceId,'test-watch');assert.equal(summary.sources[0].samples,1);assert.equal(summary.nights.length,1);assert.equal(summary.nights[0].date,'2026-09-10');assert.equal(summary.nights[0].hours.length,24);assert.equal(Object.hasOwn(summary,'samples'),false);assert.equal(Object.hasOwn(summary.nights[0],'segments'),false);
    const unchangedSummary=await fetch(summaryUrl,{headers:{'If-None-Match':summaryTag}});assert.equal(unchangedSummary.status,304);assert.equal(await unchangedSummary.text(),'');
    const detailUrl=origin+'/api/health/sleep/night?sourceId=test-watch&date=2026-09-10';
    const detailResponse=await fetch(detailUrl),detail=await detailResponse.json(),detailTag=detailResponse.headers.get('etag');assert.equal(detailResponse.status,200);assert.equal(detail.night.segments.length,1);assert.equal(detail.night.segments[0].stage,'core');assert.equal((await fetch(detailUrl,{headers:{'If-None-Match':detailTag}})).status,304);
    assert.equal((await fetch(origin+'/api/health/sleep/summary?from=2026-09-01')).status,400);
    const settings=await local('/sleep/settings',{...sleepView.settings,awakeMinutes:75,revision:sleepView.settingsRevision});assert.equal(settings.status,200);
    assert.equal((await local('/sleep/settings',{...sleepView.settings,revision:sleepView.settingsRevision})).status,409);
    const note=await local('/sleep/note',{date:'2026-09-10',revision:0,text:'夜'.repeat(4000),tags:['stress']});assert.equal(note.status,200);assert.equal(note.data.note.revision,1);
    assert.equal((await local('/sleep/note',{date:'2026-09-10',revision:0,text:'A stale overwrite',tags:[]})).status,409);
    assert.equal(await readFile(sleepFile,'utf8'),sleepBeforeUserChanges);
    const sleepUser=JSON.parse(await readFile(join(directory,'sleep-user.private.json'),'utf8'));assert.equal(sleepUser.settings.awakeMinutes,75);assert.equal(sleepUser.notes[0].text.length,4000);
    summaryResponse=await fetch(summaryUrl,{headers:{'If-None-Match':summaryTag}});summary=await summaryResponse.json();assert.equal(summaryResponse.status,200);assert.notEqual(summaryResponse.headers.get('etag'),summaryTag);assert.equal(summary.settings.awakeMinutes,75);assert.equal(summary.notes[0].revision,1);
    assert.equal((await phone('/sleep-batch',token,{...sleepBatch,days:[]})).status,400);
    assert.equal((await phone('/sleep-batch',token,{...sleepBatch,samples:[],generatedAt:new Date().toISOString()})).status,200);
    sleepView=await (await fetch(origin+'/api/health/sleep')).json();assert.equal(sleepView.samples.length,0);assert.equal(sleepView.notes[0].text.length,4000);assert.equal(sleepView.settings.awakeMinutes,75);
    const command={id:randomUUID(),kg:75,measuredAt:new Date().toISOString()};const queued=await local('/weight',command);assert.equal(queued.status,200);assert.equal(queued.data.commands[0].status,'pending');
    assert.equal((await local('/weight',command)).data.commands.length,1);assert.equal((await local('/weight',{...command,kg:80})).status,409);
    const pending=(await phone('/commands',token)).data.commands[0];assert.equal((await phone('/receipt',token,{id:pending.id,payloadHash:'0'.repeat(64)})).status,409);
    assert.equal((await phone('/receipt',token,{id:pending.id,payloadHash:pending.payloadHash})).status,200);assert.equal((await phone('/commands',token)).data.commands.length,0);
    publicView=await (await fetch(origin+'/api/health')).json();assert.equal(publicView.phoneScope,'workspace');assert.equal(publicView.pairedDeviceCount,2);assert.equal(publicView.healthOwnerPaired,true);assert.equal(publicView.commands[0].status,'applied');assert.equal(publicView.snapshot.days[0].steps,1234);assert.equal(JSON.stringify(publicView).includes(token),false);assert.equal(JSON.stringify(publicView).includes(secondToken),false);assert.equal(JSON.stringify(publicView).includes(pairing.code),false);
    assert.equal((await fetch(origin+'/api/health',{headers:{Origin:'https://example.com'}})).status,403);
    const tokenHash=createHash('sha256').update(token).digest('hex');
    const saved=JSON.parse(await readFile(join(directory,'health.private.json'),'utf8'));saved.tokens.find(entry=>entry.hash===tokenHash).scope='health';await writeFile(join(directory,'health.private.json'),JSON.stringify(saved));
    assert.deepEqual((await phone('/capabilities',token)).data,{version:2,scope:'health',deviceClass:'phone',workspace:false,health:true});assert.equal((await phone('/v1/workspace',token)).status,403);assert.equal((await phoneRaw(`/v1/climbing/media/${mediaReferenceId}`,token)).status,403);assert.equal((await phone('/commands',token)).status,200);
    assert.deepEqual((await phone('/capabilities',secondToken)).data,{version:2,scope:'workspace',deviceClass:'tablet',workspace:true,health:false});publicView=await (await fetch(origin+'/api/health')).json();assert.equal(publicView.phoneScope,'health');
    saved.tokens.find(entry=>entry.hash===tokenHash).scope='workspace';await writeFile(join(directory,'health.private.json'),JSON.stringify(saved));
    assert.equal((await phone('/unpair',token)).status,404);
    const pendingPairing=(await local('/pairing',{deviceClass:'phone'})).data;
    const authorized=new Promise(resolve=>{mutationAuthorized=resolve;});const beforeRevocation=proxyCalls.length;const held=heldPhonePost('/v1/workspace',token,JSON.stringify({...changed,revision:5}));
    assert.equal(await authorized,'/v1/workspace');mutationAuthorized=undefined;assert.deepEqual((await phone('/unpair',token,{})).data,{revoked:true});held.finish();const revokedWrite=await held.result;assert.equal(revokedWrite.status,401);assert.equal(proxyCalls.length,beforeRevocation);assert.equal((await phone('/commands',token)).status,401);
    assert.equal((await phone('/commands',secondToken)).status,403);savedTokens=JSON.parse(await readFile(join(directory,'health.private.json'),'utf8'));assert.equal(savedTokens.tokens.length,1);assert.equal(savedTokens.pairing.hash,createHash('sha256').update(pendingPairing.code).digest('hex'));
    publicView=await (await fetch(origin+'/api/health')).json();assert.equal(publicView.paired,true);assert.equal(publicView.pairedDeviceCount,1);assert.equal(publicView.healthOwnerPaired,false);assert.equal(publicView.phoneScope,null);
    const tabletOnlyWeight=await local('/weight',{id:randomUUID(),kg:74,measuredAt:new Date().toISOString()});assert.equal(tabletOnlyWeight.status,400);assert.match(tabletOnlyWeight.data.error,/Pair an iPhone/);
    const thirdPaired=await phone('/pair',pendingPairing.code,{}),thirdToken=thirdPaired.data.token;assert.equal(thirdPaired.status,200);assert.equal(thirdPaired.data.deviceClass,'phone');assert.equal((await phone('/commands',secondToken)).status,403);assert.equal((await phone('/commands',thirdToken)).status,200);
    assert.deepEqual((await phone('/unpair',secondToken,{})).data,{revoked:true});assert.equal((await phone('/commands',secondToken)).status,401);assert.equal((await phone('/commands',thirdToken)).status,200);
    const legacySaved=JSON.parse(await readFile(join(directory,'health.private.json'),'utf8')),legacyEntry=legacySaved.tokens[0];delete legacySaved.tokens;legacySaved.tokenHash=legacyEntry.hash;delete legacySaved.tokenScope;await writeFile(join(directory,'health.private.json'),JSON.stringify(legacySaved));
    const legacyToken=thirdToken;
    assert.deepEqual((await phone('/capabilities',legacyToken)).data,{version:2,scope:'health',deviceClass:'phone',workspace:false,health:true});assert.equal((await phone('/v1/workspace',legacyToken)).status,403);assert.equal((await phone('/commands',legacyToken)).status,200);
    assert.equal((await phone('/snapshot',legacyToken,{...sample,id:randomUUID(),generatedAt:new Date(Date.now()+100).toISOString()})).status,200);const migratedLegacy=JSON.parse(await readFile(join(directory,'health.private.json'),'utf8'));assert.equal(migratedLegacy.tokens[0].deviceClass,'phone');assert.equal(Object.hasOwn(migratedLegacy,'tokenHash'),false);
    assert.deepEqual((await phone('/unpair',legacyToken,{})).data,{revoked:true});assert.equal((await phone('/commands',legacyToken)).status,401);assert.equal(Object.hasOwn(JSON.parse(await readFile(join(directory,'health.private.json'),'utf8')),'pairing'),false);
    const boundedTokens=[];
    for(let index=0;index<8;index++){const deviceClass=index===0?'phone':'tablet',nextPairing=(await local('/pairing',{deviceClass})).data,nextPaired=await phone('/pair',nextPairing.code,{deviceClass});assert.equal(nextPaired.status,200);boundedTokens.push(nextPaired.data.token);}
    publicView=await (await fetch(origin+'/api/health')).json();assert.equal(publicView.pairedDeviceCount,8);assert.equal((await phone('/commands',boundedTokens[0])).status,200);assert.equal((await phone('/commands',boundedTokens.at(-1))).status,403);
    const overflowPairing=(await local('/pairing',{deviceClass:'tablet'})).data,overflow=await phone('/pair',overflowPairing.code,{deviceClass:'tablet'});assert.equal(overflow.status,409);assert.match(overflow.data.error,/maximum of 8 paired devices/);
    savedTokens=JSON.parse(await readFile(join(directory,'health.private.json'),'utf8'));assert.equal(savedTokens.tokens.length,8);assert.equal(savedTokens.pairing.hash,createHash('sha256').update(overflowPairing.code).digest('hex'));
    const disabled=await local('/disable');assert.equal(disabled.data.paired,false);assert.equal(disabled.data.pairedDeviceCount,0);publicView=await (await fetch(origin+'/api/health')).json();assert.equal(publicView.paired,false);assert.equal(publicView.pairedDeviceCount,0);
    savedTokens=JSON.parse(await readFile(join(directory,'health.private.json'),'utf8'));assert.deepEqual(savedTokens.tokens,[]);assert.equal(Object.hasOwn(savedTokens,'pairing'),false);
  }finally{await app.stop();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}
});

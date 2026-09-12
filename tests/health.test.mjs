import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHealthService } from '../build/health.ts';
import { healthSnapshotSchema } from '../lib/health.ts';

test('Health snapshots preserve missing values and reject incomplete date ranges',()=>{
  const sample={version:1,id:randomUUID(),generatedAt:new Date().toISOString(),timeZone:'America/Los_Angeles',from:'2026-09-11',to:'2026-09-11',days:[{date:'2026-09-11',steps:null,sleepMinutes:null,restingHeartRate:null,weightKg:null}],workouts:[]};
  assert.equal(healthSnapshotSchema.parse(sample).days[0].steps,null);
  assert.equal(healthSnapshotSchema.safeParse({...sample,to:'2026-09-12'}).success,false);
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
test('Health HTTPS pairing, private device scope, and confirmed weight receipts',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'workspace-health-'));const proxyCalls=[];const app=createHealthService(directory,{addresses:()=>['127.0.0.1'],port:0,workspaceRequest:async(path,method,body)=>{proxyCalls.push({path,method,body});if(path==='/api/workspace'&&method==='GET')return {status:200,data:{version:1,revision:4,items:[]}};if(path==='/api/workspace'&&method==='PUT')return {status:200,data:{...body,revision:body.revision+1}};return {status:404,data:{error:'Unknown local route'}};}});const server=createServer(app.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  const local=async(path,body={})=>{const r=await fetch(origin+'/api/health'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  try{
    let publicView=await (await fetch(origin+'/api/health')).json();assert.equal(publicView.enabled,false);
    const enabled=await local('/enable',{address:'127.0.0.1'});assert.equal(enabled.status,200);assert.equal(enabled.data.online,true);
    const pairing=(await local('/pairing')).data;assert.equal(pairing.version,2);assert.equal(pairing.type,'personal-workspace-pairing');assert.equal(pairing.scope,'workspace');const cert=await readFile(join(directory,'health-certificate.pem'));
    const phone=(path,token,body,pin=pairing.fingerprint)=>new Promise((resolve,reject)=>{
      const req=request(pairing.url+path,{method:body===undefined?'GET':'POST',ca:cert,headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},checkServerIdentity:(host,certificate)=>checkServerIdentity(host,certificate)||(createHash('sha256').update(certificate.raw).digest('hex')!==pin?new Error('Certificate pin mismatch'):undefined)},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString())}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
    });
    await assert.rejects(phone('/commands','wrong',undefined,'0'.repeat(64)),/pin mismatch/);
    const paired=await phone('/pair',pairing.code,{});assert.equal(paired.status,200);const token=paired.data.token;
    assert.equal((await phone('/pair',pairing.code,{})).status,401);assert.equal((await phone('/commands','wrong')).status,401);
    assert.deepEqual((await phone('/capabilities',token)).data,{version:2,scope:'workspace',workspace:true,health:true});
    assert.equal((await phone('/v1/workspace','wrong')).status,401);
    assert.deepEqual((await phone('/v1/workspace',token)).data,{version:1,revision:4,items:[]});
    const changed={version:1,revision:4,items:[{id:randomUUID(),kind:'note',title:'From iPhone',area:'personal',date:null,time:null,endTime:null,done:false}]};
    assert.equal((await phone('/v1/workspace',token,changed)).data.revision,5);assert.deepEqual(proxyCalls.slice(-2),[{path:'/api/workspace',method:'GET',body:undefined},{path:'/api/workspace',method:'PUT',body:changed}]);
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
    assert.equal((await phone('/v1/workspace',token)).status,403);assert.equal((await phone('/commands',token)).status,200);
    await local('/disable');assert.equal((await (await fetch(origin+'/api/health')).json()).paired,false);
  }finally{await app.stop();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}
});

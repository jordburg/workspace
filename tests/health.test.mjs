import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHealthService } from '../build/health.ts';
import { healthSnapshotSchema } from '../lib/health.ts';

test('Health snapshots preserve missing values and reject incomplete date ranges',()=>{
  const sample={version:1,id:randomUUID(),generatedAt:new Date().toISOString(),timeZone:'America/Los_Angeles',from:'2026-09-11',to:'2026-09-11',days:[{date:'2026-09-11',steps:null,sleepMinutes:null,restingHeartRate:null,weightKg:null}],workouts:[]};
  assert.equal(healthSnapshotSchema.parse(sample).days[0].steps,null);
  assert.equal(healthSnapshotSchema.safeParse({...sample,to:'2026-09-12'}).success,false);
});
test('Health HTTPS pairing, private device scope, and confirmed weight receipts',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'workspace-health-'));const app=createHealthService(directory,{addresses:()=>['127.0.0.1'],port:0});const server=createServer(app.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  const local=async(path,body={})=>{const r=await fetch(origin+'/api/health'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  try{
    let publicView=await (await fetch(origin+'/api/health')).json();assert.equal(publicView.enabled,false);
    const enabled=await local('/enable',{address:'127.0.0.1'});assert.equal(enabled.status,200);assert.equal(enabled.data.online,true);
    const pairing=(await local('/pairing')).data;const cert=await readFile(join(directory,'health-certificate.pem'));
    const phone=(path,token,body,pin=pairing.fingerprint)=>new Promise((resolve,reject)=>{
      const req=request(pairing.url+path,{method:body===undefined?'GET':'POST',ca:cert,headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},checkServerIdentity:(host,certificate)=>checkServerIdentity(host,certificate)||(createHash('sha256').update(certificate.raw).digest('hex')!==pin?new Error('Certificate pin mismatch'):undefined)},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString())}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
    });
    await assert.rejects(phone('/commands','wrong',undefined,'0'.repeat(64)),/pin mismatch/);
    const paired=await phone('/pair',pairing.code,{});assert.equal(paired.status,200);const token=paired.data.token;
    assert.equal((await phone('/pair',pairing.code,{})).status,401);assert.equal((await phone('/commands','wrong')).status,401);
    const sample={version:1,id:randomUUID(),generatedAt:new Date().toISOString(),timeZone:'America/Los_Angeles',from:'2026-09-11',to:'2026-09-11',days:[{date:'2026-09-11',steps:1234,sleepMinutes:null,restingHeartRate:60,weightKg:null}],workouts:[]};
    assert.equal((await phone('/snapshot',token,sample)).status,200);
    assert.equal((await phone('/snapshot',token,{...sample,generatedAt:'2026-01-01T00:00:00Z'})).status,409);
    const command={id:randomUUID(),kg:75,measuredAt:new Date().toISOString()};const queued=await local('/weight',command);assert.equal(queued.status,200);assert.equal(queued.data.commands[0].status,'pending');
    assert.equal((await local('/weight',command)).data.commands.length,1);assert.equal((await local('/weight',{...command,kg:80})).status,409);
    const pending=(await phone('/commands',token)).data.commands[0];assert.equal((await phone('/receipt',token,{id:pending.id,payloadHash:'0'.repeat(64)})).status,409);
    assert.equal((await phone('/receipt',token,{id:pending.id,payloadHash:pending.payloadHash})).status,200);assert.equal((await phone('/commands',token)).data.commands.length,0);
    publicView=await (await fetch(origin+'/api/health')).json();assert.equal(publicView.commands[0].status,'applied');assert.equal(publicView.snapshot.days[0].steps,1234);assert.equal(JSON.stringify(publicView).includes(token),false);assert.equal(JSON.stringify(publicView).includes(pairing.code),false);
    assert.equal((await fetch(origin+'/api/health',{headers:{Origin:'https://example.com'}})).status,403);
    await local('/disable');assert.equal((await (await fetch(origin+'/api/health')).json()).paired,false);
  }finally{await app.stop();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}
});

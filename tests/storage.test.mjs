import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtemp, readFile, writeFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localWorkspace } from "../build/local-workspace.ts";
import { withPrivateLock } from "../build/private-store.ts";
import { itemSchema } from "../lib/workspace.ts";

test("local workspace preserves saved records and rejects unsafe writes", async t => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-storage-test-"));
  process.env.WORKSPACE_DATA_DIR = directory;
  let handler;
  localWorkspace().configureServer({ middlewares: { use: (_path, fn) => { handler = fn; } } });
  delete process.env.WORKSPACE_DATA_DIR;
  const server = createServer((req,res) => handler(req,res));
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = () => fetch(`${origin}/api/workspace`);
  const put = (data,headers={}) => fetch(`${origin}/api/workspace`, {method:"PUT",headers:{"Content-Type":"application/json",Origin:origin,...headers},body:JSON.stringify(data)});
  const post = (data,headers={}) => fetch(`${origin}/api/workspace`, {method:"POST",headers:{"Content-Type":"application/json",Origin:origin,...headers},body:JSON.stringify(data)});
  let state = {version:2,revision:0,items:[],tombstones:[],receipts:[]};
  const priority = itemSchema.parse({id:"b9bc3ff8-deed-404a-8fc7-ec776c8a6fd9",kind:"priority",title:"Test priority",area:"personal",date:"2026-09-11",time:null,endTime:null,done:false});
  try {
    await t.test("starts empty and persists validated data", async () => {
      assert.deepEqual(await (await get()).json(),state);
      const saved = await put({...state,items:[priority]}); assert.equal(saved.status,200); state=await saved.json();
      assert.equal(state.version,2); assert.equal(state.items[0].revision,1); assert.ok(state.items[0].createdAt); assert.ok(state.items[0].updatedAt);
      assert.equal(state.revision,1); assert.deepEqual(JSON.parse(await readFile(join(directory,"workspace.json"),"utf8")),state);
      assert.deepEqual(await (await get()).json(),state);
    });
    await t.test("supports conditional reads", async () => {
      const first=await get();const etag=first.headers.get("etag");assert.ok(etag);await first.arrayBuffer();
      const unchanged=await fetch(`${origin}/api/workspace`,{headers:{"If-None-Match":etag}});assert.equal(unchanged.status,304);assert.equal(await unchanged.text(),"");
    });
    await t.test("applies per-item commands once and rejects stale item revisions", async () => {
      const current=state.items[0];const requestId="70c39270-7b4f-49c0-90f4-191ea2280450";
      const command={action:"upsert",requestId,expectedItemRevision:current.revision,item:{...current,title:"Edited independently"}};
      const saved=await post(command);assert.equal(saved.status,200);state=await saved.json();assert.equal(state.items[0].title,"Edited independently");assert.equal(state.items[0].revision,current.revision+1);
      const revision=state.revision;const replay=await post(command);assert.equal(replay.status,200);state=await replay.json();assert.equal(state.revision,revision);assert.equal(replay.headers.get("x-idempotent-replay"),"true");
      const reused=await post({...command,item:{...command.item,title:"Different payload"}});assert.equal(reused.status,409);assert.equal((await reused.json()).code,"request_id_conflict");
      const stale=await post({...command,requestId:"08880503-f258-435d-8949-48cf7b8fdd20"});assert.equal(stale.status,409);assert.equal((await stale.json()).code,"item_revision_conflict");
    });
    await t.test("tracks capture triage and deletion without widening the conflict", async () => {
      const capture=itemSchema.parse({id:"1552ef48-d7ac-45f8-8324-fd8145a34741",kind:"note",title:"Keep the origin",area:"personal",date:null,time:null,endTime:null,done:false});
      let response=await post({action:"upsert",requestId:"9bd4921b-cb4d-4c14-be67-da0977d4066b",expectedItemRevision:null,item:capture});assert.equal(response.status,200);state=await response.json();
      const saved=state.items.find(item=>item.id===capture.id);response=await post({action:"triage",requestId:"a4ba905a-6093-4f23-9377-2a7965408084",id:capture.id,expectedItemRevision:saved.revision,status:"reviewed"});assert.equal(response.status,200);state=await response.json();assert.equal(state.items.find(item=>item.id===capture.id).triageStatus,"reviewed");
      const reviewed=state.items.find(item=>item.id===capture.id);response=await post({action:"delete",requestId:"9a06d834-1a76-49e1-8589-fbc352b12170",id:capture.id,expectedItemRevision:reviewed.revision});assert.equal(response.status,200);state=await response.json();assert.equal(state.items.some(item=>item.id===capture.id),false);assert.equal(state.tombstones.at(-1).id,capture.id);
      const deletedRevision=state.tombstones.at(-1).revision;response=await post({action:"restore",requestId:"d2fb1e00-65ca-4f54-a405-c9c997080978",expectedTombstoneRevision:deletedRevision,item:reviewed});assert.equal(response.status,200);state=await response.json();assert.equal(state.items.find(item=>item.id===capture.id).revision,deletedRevision+1);assert.equal(state.tombstones.some(item=>item.id===capture.id),false);
      response=await post({action:"upsert",requestId:"53aab971-e8e4-4997-8e90-209f219f4248",expectedItemRevision:reviewed.revision,item:{...reviewed,title:"Stale resurrection"}});assert.equal(response.status,409);
    });
    await t.test("rejects stale revisions without overwriting", async () => {
      const response=await put({...state,revision:0,items:[]});assert.equal(response.status,409);assert.equal((await response.json()).code,"revision_conflict");assert.deepEqual(await (await get()).json(),state);
    });
    await t.test("protects a live lock and recovers an abandoned lock", async () => {
      const lock=join(directory,".write-lock");const old=new Date(Date.now()-10*60_000);
      await writeFile(lock,JSON.stringify({pid:process.pid,createdAt:"2020-01-01T00:00:00.000Z"}));await utimes(lock,old,old);
      try {const response=await put(state);assert.equal(response.status,409);assert.equal((await response.json()).code,"store_busy");}
      finally {await rm(lock,{force:true});}
      await writeFile(lock,JSON.stringify({pid:99999999,createdAt:"2020-01-01T00:00:00.000Z"}));await utimes(lock,old,old);
      const recovered=await put(state);assert.equal(recovered.status,200);state=await recovered.json();
    });
    await t.test("serializes concurrent writers; exactly one succeeds", async () => {
      const previousRevision=state.revision;
      const responses=await Promise.all([put({...state,items:[{...priority,title:"First edit"}]}),put({...state,items:[{...priority,title:"Second edit"}]})]);
      assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]); state=await (await get()).json(); assert.equal(state.revision,previousRevision+1);
    });
    await t.test("rejects cross-origin and rebound-host requests", async () => {
      assert.equal((await put(state,{Origin:"https://example.com"})).status,403);
      const status = await new Promise((resolve,reject) => { const req = request(`${origin}/api/workspace`,{headers:{Host:"example.com:5173"}},res=>{ res.resume(); resolve(res.statusCode); }); req.on("error",reject); req.end(); });
      assert.equal(status,403);
      assert.deepEqual(await (await get()).json(),state);
    });
    await t.test("rejects impossible dates, invalid time ranges, and duplicate IDs",async () => {
      assert.equal(itemSchema.safeParse({...priority,date:"2026-02-30"}).success,false);
      assert.equal(itemSchema.safeParse({...priority,kind:"plan",time:"14:00",endTime:"13:00"}).success,false);
      assert.equal((await put({...state,items:[priority,priority]})).status,400);
      assert.deepEqual(await (await get()).json(),state);
    });
    await t.test("retains the previous version as a backup", async () => {
      const previous=state; const response=await put({...state,items:state.items.map(i=>({...i,done:true}))}); assert.equal(response.status,200);state=await response.json();
      assert.deepEqual(JSON.parse(await readFile(join(directory,"workspace.backup.json"),"utf8")),previous);
    });
    await t.test("corrupt storage is never reset or overwritten", async () => {
      await writeFile(join(directory,"workspace.json"),"broken json");assert.equal((await get()).status,500);assert.equal((await put(state)).status,500);
      assert.equal(await readFile(join(directory,"workspace.json"),"utf8"),"broken json");
    });
  } finally { await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true}); }
});

test("local workspace reads version-one files as version two without mutating them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-v1-migration-test-"));
  const legacy = {version:1,revision:4,items:[{id:"72ea850b-6456-4892-89f5-4b7e287d42b5",kind:"note",title:"An older capture",area:"personal",date:null,time:null,endTime:null,done:false}]};
  await writeFile(join(directory,"workspace.json"),JSON.stringify(legacy));
  process.env.WORKSPACE_DATA_DIR=directory;let handler;localWorkspace().configureServer({middlewares:{use:(_path,fn)=>{handler=fn;}}});delete process.env.WORKSPACE_DATA_DIR;
  const server=createServer((req,res)=>handler(req,res));await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  try {
    const response=await fetch(`${origin}/api/workspace`);assert.equal(response.status,200);const migrated=await response.json();assert.equal(migrated.version,2);assert.equal(migrated.revision,4);assert.equal(migrated.items[0].triageStatus,"new");assert.deepEqual(migrated.tombstones,[]);assert.deepEqual(JSON.parse(await readFile(join(directory,"workspace.json"),"utf8")),legacy);
  } finally {await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});

test("private stores recover an abandoned lock without weakening active-lock protection", async () => {
  const directory=await mkdtemp(join(tmpdir(),"workspace-private-lock-test-"));const file=join(directory,"state.json");const lock=`${file}.lock`;
  try{
    const old=new Date(Date.now()-10*60_000);await writeFile(lock,JSON.stringify({pid:process.pid,createdAt:"2020-01-01T00:00:00.000Z"}));await utimes(lock,old,old);
    await assert.rejects(()=>withPrivateLock(file,async()=>"unsafe"),/Another request is updating/);await rm(lock,{force:true});
    await writeFile(lock,JSON.stringify({pid:99999999,createdAt:"2020-01-01T00:00:00.000Z"}));await utimes(lock,old,old);
    const result=await withPrivateLock(file,async()=>"saved");assert.equal(result,"saved");await assert.rejects(()=>stat(lock),error=>error.code==="ENOENT");
    await writeFile(lock,"busy");await assert.rejects(()=>withPrivateLock(file,async()=>"unsafe"),/Another request is updating/);
  } finally {await rm(directory,{recursive:true,force:true});}
});

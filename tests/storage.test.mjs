import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localWorkspace } from "../build/local-workspace.ts";
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
  let state = {version:1,revision:0,items:[]};
  const priority = {id:"b9bc3ff8-deed-404a-8fc7-ec776c8a6fd9",kind:"priority",title:"Test priority",area:"personal",date:"2026-09-11",time:null,endTime:null,done:false};
  try {
    await t.test("starts empty and persists validated data", async () => {
      assert.deepEqual(await (await get()).json(),state);
      const saved = await put({...state,items:[priority]}); assert.equal(saved.status,200); state=await saved.json();
      assert.equal(state.revision,1); assert.deepEqual(JSON.parse(await readFile(join(directory,"workspace.json"),"utf8")),state);
      assert.deepEqual(await (await get()).json(),state);
    });
    await t.test("rejects stale revisions without overwriting", async () => {
      const response=await put({...state,revision:0,items:[]});assert.equal(response.status,409);assert.equal((await response.json()).code,"revision_conflict");assert.deepEqual(await (await get()).json(),state);
    });
    await t.test("distinguishes a busy store from a stale revision", async () => {
      const lock=join(directory,".write-lock");await writeFile(lock,"test");
      try {const response=await put(state);assert.equal(response.status,409);assert.equal((await response.json()).code,"store_busy");}
      finally {await rm(lock,{force:true});}
    });
    await t.test("serializes concurrent writers; exactly one succeeds", async () => {
      const responses=await Promise.all([put({...state,items:[{...priority,title:"First edit"}]}),put({...state,items:[{...priority,title:"Second edit"}]})]);
      assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]); state=await (await get()).json(); assert.equal(state.revision,2);
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, mkdir, readFile, writeFile, readdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { createWritingService, renderSiteEntry } from '../build/writing.ts';

const input=(slug='a-new-note')=>({id:randomUUID(),revision:0,slug,title:'A new note: "quoted"',summary:'A short summary.',body:'## A thought\n\nOrdinary Markdown.',timeframe:'2026',kind:'writing',format:'Note',primaryThread:'writing',threads:['writing'],topics:[],relatedEntries:[]});
const hash=text=>createHash('sha256').update(text).digest('hex');
async function harness(){
  const root=await realpath(await mkdtemp(join(tmpdir(),'workspace-writing-')));const repo=join(root,'personal-site');const directory=join(root,'data');const content=join(repo,'src/content/entries');await mkdir(content,{recursive:true});await writeFile(join(repo,'package.json'),JSON.stringify({name:'personal-site'}));
  const original=`---\n${stringify({order:1,title:'Original',summary:'Existing prose.',kind:'writing',primaryThread:'writing',draft:false})}---\n\nOriginal content.\n`;await writeFile(join(content,'original.md'),original);
  const app=createWritingService(directory,repo);const server=createServer(app.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  const post=async(path,body)=>{const r=await fetch(origin+'/api/writing'+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  const get=async()=>await(await fetch(origin+'/api/writing')).json();
  return {root,repo,directory,content,original,origin,post,get,cleanup:async()=>{await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}};
}
test('Writing persists private drafts, safely creates site drafts, and prevents stale edits or overwrites',async()=>{
  const h=await harness();try{
    assert.equal((await h.get()).entries.length,1);const draft=input();let saved=await h.post('/save',draft);assert.equal(saved.status,200);assert.equal((await h.get()).drafts.length,1);
    assert.equal((await h.post('/save',draft)).status,409);
    const exported=await h.post('/export',{id:draft.id,revision:1});assert.equal(exported.status,200,JSON.stringify(exported.data));
    const text=await readFile(join(h.content,'a-new-note.md'),'utf8');const metadata=parse(text.match(/^---\n([\s\S]*?)\n---/)[1]);assert.equal(metadata.draft,true);assert.equal(metadata.order,2);assert.equal(metadata.timeframe,'2026');assert.equal(metadata.title,draft.title);
    assert.equal(await readFile(join(h.content,'original.md'),'utf8'),h.original);assert.equal((await h.post('/export',{id:draft.id,revision:1})).status,200);assert.equal((await readdir(h.content)).length,2);
    assert.equal((await h.post('/save',{...draft,revision:2,title:'Cannot overwrite'})).status,409);
    const duplicate=input('original');await h.post('/save',duplicate);assert.equal((await h.post('/export',{id:duplicate.id,revision:1})).status,409);assert.equal(await readFile(join(h.content,'original.md'),'utf8'),h.original);
    assert.equal((await h.post('/save',input('../outside'))).status,400);assert.equal((await fetch(h.origin+'/api/writing',{headers:{Origin:'https://evil.example'}})).status,403);
  }finally{await h.cleanup();}
});
test('Writing honors site namespaces, related entries, and actual Markdown code versus HTML',async()=>{
  const h=await harness();try{
    for(const slug of ['notes','systems','tools','writing','about','project-original-heading']){const d=input(slug);await h.post('/save',d);assert.equal((await h.post('/export',{id:d.id,revision:1})).status,409,slug);}
    for(const [index,body] of ['<div>raw</div>','```bad`info\n<div>raw HTML</div>\n```'].entries()){const d={...input(`bad-html-${index}`),body};await h.post('/save',d);assert.equal((await h.post('/export',{id:d.id,revision:1})).status,400);}
    const safe={...input('code-and-link'),body:'See <https://example.com>.\n\n    <div>an indented example</div>\n\n```html\n<div>a fenced example</div>\n```',relatedEntries:['original']};await h.post('/save',safe);assert.equal((await h.post('/export',{id:safe.id,revision:1})).status,200);
    const missing={...input('missing-reference'),relatedEntries:['unknown']};await h.post('/save',missing);assert.equal((await h.post('/export',{id:missing.id,revision:1})).status,400);
    const outside=join(h.root,'outside.md');await writeFile(outside,'outside stays intact');await symlink(outside,join(h.content,'linked.md'));assert.equal((await h.get()).available,false);assert.equal(await readFile(outside,'utf8'),'outside stays intact');
  }finally{await h.cleanup();}
});
test('Writing recovers an interrupted export without duplicate files or overwriting independent edits',async()=>{
  const h=await harness();try{
    const draft=input('recover-me');await h.post('/save',draft);const path=join(h.directory,'writing.private.json');const state=JSON.parse(await readFile(path,'utf8'));const saved=state.drafts[0];const content=renderSiteEntry(saved,2);
    state.pending[saved.id]={content,hash:hash(content),order:2,file:'src/content/entries/recover-me.md',at:new Date().toISOString()};await writeFile(path,JSON.stringify(state));await writeFile(join(h.content,'recover-me.md'),content);
    const recovered=await h.post('/export',{id:saved.id,revision:1});assert.equal(recovered.status,200);assert.ok(recovered.data.drafts[0].exported);assert.equal((await readdir(h.content)).length,2);
    const next=input('another-draft');await h.post('/save',next);const state2=JSON.parse(await readFile(path,'utf8'));const d=state2.drafts.find(d=>d.id===next.id);const pendingText=renderSiteEntry(d,3);state2.pending[d.id]={content:pendingText,hash:hash(pendingText),order:3,file:'src/content/entries/another-draft.md',at:new Date().toISOString()};await writeFile(path,JSON.stringify(state2));
    const outsideText=renderSiteEntry({...d,title:'An independent edit'},3);await writeFile(join(h.content,'another-draft.md'),outsideText);assert.equal((await h.post('/export',{id:d.id,revision:1})).status,409);
    const released=await h.post('/recover',{id:d.id,revision:1});assert.equal(released.status,200);assert.deepEqual(released.data.pendingExports,[]);assert.equal(await readFile(join(h.content,'another-draft.md'),'utf8'),outsideText);
    assert.equal((await h.post('/save',{...next,revision:2,slug:'new-address'})).status,200);assert.equal((await h.post('/export',{id:next.id,revision:3})).status,200);
  }finally{await h.cleanup();}
});

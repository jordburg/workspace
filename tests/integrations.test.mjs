import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createIntegrationService } from '../build/integrations.ts';
import { integrationLinkSchema, todoistSources, personalProjects, normalizeEvent, eventOnDay, PERSONAL_CALENDAR } from '../lib/integrations/model.ts';

const zone='America/Los_Angeles';
const source={id:PERSONAL_CALENDAR,name:'Personal',area:'personal',blocked:false};
const baseEvent={id:'event1',etag:'"v1"',summary:'Focus time',organizer:{self:true},start:{dateTime:'2026-09-11T09:00:30-07:00'},end:{dateTime:'2026-09-11T10:00:30-07:00'}};
const baseTask={id:'task1',project_id:'personal',content:'Personal task',due:{date:'2026-09-11',is_recurring:false},priority:3,updated_at:'one',checked:false};

async function harness() {
  const directory=await mkdtemp(join(tmpdir(),'workspace-integration-test-'));
  const remote={calls:[],task:{...baseTask},event:structuredClone(baseEvent),failTasks:false,failEvents:false,projects:[{id:'personal',name:'Personal'},{id:'learning',name:'Learning',parent_id:'personal'},{id:'work',name:'Artek'},{id:'work-child',name:'Personal',parent_id:'work'}],pagination:false,primaryId:PERSONAL_CALENDAR,tokenExchanges:[],commands:new Map(),googleWrites:[],todoistWrites:0,mutationDelay:0};
  const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
  const fakeFetch=async(input,options={})=>{
    const url=new URL(String(input));remote.calls.push({url:url.href,method:options.method||'GET'});
    const method=options.method||'GET';
    if(url.href==='https://oauth2.googleapis.com/token') {remote.tokenExchanges.push(Object.fromEntries(new URLSearchParams(options.body)));return json({access_token:'test-google-access',refresh_token:'test-google-refresh',expires_in:3600,scope:'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.owned'});}
    if(url.hostname==='api.todoist.com') {
      if(url.pathname.endsWith('/projects'))return json({results:remote.projects,next_cursor:null});
      if(url.pathname.endsWith('/tasks')) {if(remote.failTasks)return json({error:'offline'},503);const project=url.searchParams.get('project_id');assert.ok(['personal','learning'].includes(project),'must never fetch the work or inbox tasks');if(remote.pagination && project==='personal' && !url.searchParams.has('cursor'))return json({results:[],next_cursor:'next'});return json({results:project==='personal'&&!remote.task.checked?[remote.task]:[],next_cursor:null});}
      if(url.pathname.endsWith('/tasks/task1')&&method==='GET')return json(remote.task);
      if(url.pathname.endsWith('/tasks/task1/close')){remote.todoistWrites++;if(remote.task.due?.is_recurring){remote.task.due={...remote.task.due,date:'2026-09-12'};remote.task.updated_at=randomUUID();}else remote.task.checked=true;return json(null);}
      if(url.pathname.endsWith('/sync')){
        assert.equal(options.headers['Content-Type'],'application/x-www-form-urlencoded');
        const [command]=JSON.parse(new URLSearchParams(options.body).get('commands'));
        if(!remote.commands.has(command.uuid)){remote.commands.set(command.uuid,command);remote.todoistWrites++;if(command.type==='item_update'){remote.task={...remote.task,...(command.args.content?{content:command.args.content}:{}),...(Object.hasOwn(command.args,'due')?{due:command.args.due}:{}),updated_at:randomUUID()};}}
        return json({sync_status:{[command.uuid]:'ok'},temp_id_mapping:command.temp_id?{[command.temp_id]:'created-task'}:{}});
      }
    }
    if(url.hostname==='www.googleapis.com') {
      if(url.pathname.endsWith('/calendarList/primary'))return json({id:remote.primaryId,summary:remote.primaryId,primary:true,accessRole:'owner'});
      assert.ok(url.pathname.includes(encodeURIComponent(PERSONAL_CALENDAR)),'must use the exact Gmail calendar');
      if(url.pathname.endsWith('/events')&&method==='GET'){if(remote.failEvents)return json({},503);if(remote.pagination && !url.searchParams.has('pageToken'))return json({items:[],nextPageToken:'next'});return json({items:[remote.event],nextPageToken:null});}
      if(url.pathname.endsWith('/events/event1')&&method==='GET')return json(remote.event);
      if(url.pathname.endsWith('/events/event1')&&method==='PATCH'){
        assert.equal(options.headers['If-Match'],remote.event.etag);
        const body=JSON.parse(options.body);remote.googleWrites.push(body);remote.event={...remote.event,...body,etag:'"'+randomUUID()+'"'};
        for(const boundary of ['start','end'])if(body[boundary])remote.event[boundary]=Object.fromEntries(Object.entries(body[boundary]).filter(([,value])=>value!==null));
        return json(remote.event);
      }
      if(/\/events\/[a-f0-9]{32}$/.test(url.pathname)&&method==='GET')return json({},404);
      if(url.pathname.endsWith('/events')&&method==='POST'){if(remote.mutationDelay)await new Promise(resolve=>setTimeout(resolve,remote.mutationDelay));const body=JSON.parse(options.body);remote.googleWrites.push(body);remote.event={...body,etag:'"created"',organizer:{self:true}};return json(remote.event);}
    }
    throw new Error(`Unexpected mock endpoint: ${method} ${url}`);
  };
  const service=createIntegrationService(directory,fakeFetch);
  const server=createServer(service.handle);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  async function post(path,body){const response=await fetch(`${origin}/api/integrations${path}`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};}
  async function view(){return (await fetch(`${origin}/api/integrations`)).json();}
  async function googleConnect(){
    assert.equal((await post('/google/configure',{installed:{client_id:'test-client.apps.googleusercontent.com',client_secret:'fake-client-secret'}})).status,200);
    const start=await post('/google/start',{});assert.equal(start.status,200);const auth=new URL(start.data.url);
    assert.equal(auth.searchParams.get('code_challenge_method'),'S256');assert.equal(auth.searchParams.get('login_hint'),PERSONAL_CALENDAR);
    assert.equal((await fetch(`${origin}/api/integrations/google/callback?state=wrong&code=fake`,{redirect:'manual'})).status,400);
    const callback=await fetch(`${origin}/api/integrations/google/callback?state=${auth.searchParams.get('state')}&code=fake`,{redirect:'manual'});assert.equal(callback.status,302);
    assert.equal(createHash('sha256').update(remote.tokenExchanges.at(-1).code_verifier).digest('base64url'),auth.searchParams.get('code_challenge'));
    assert.equal((await fetch(`${origin}/api/integrations/google/callback?state=${auth.searchParams.get('state')}&code=fake`,{redirect:'manual'})).status,400);
  }
  return {remote,fakeFetch,post,view,googleConnect,directory,origin,cleanup:async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}};
}

test('project boundaries and calendar day normalization',()=>{
  const sources=todoistSources([{id:'p',name:'Personal'},{id:'kid',name:'Learning',parent_id:'p'},{id:'a',name:'Artek'},{id:'w',name:'Personal',parent_id:'a'},{id:'wk',name:'Nested',parent_id:'w'}]);
  assert.deepEqual(personalProjects(sources).map(s=>s.id),['p','kid']);
  assert.equal(sources.find(s=>s.id==='wk').blocked,true);
  const allDay=normalizeEvent({...baseEvent,start:{date:'2026-09-11'},end:{date:'2026-09-13'}},source,zone);
  assert.equal(eventOnDay(allDay,'2026-09-11'),true);assert.equal(eventOnDay(allDay,'2026-09-12'),true);assert.equal(eventOnDay(allDay,'2026-09-13'),false);
  const overnight=normalizeEvent({...baseEvent,start:{dateTime:'2026-09-12T06:00:00Z'},end:{dateTime:'2026-09-12T07:00:00Z'}},source,zone);
  assert.equal(overnight.startDate,'2026-09-11');assert.equal(eventOnDay(overnight,'2026-09-12'),false);
  assert.equal(normalizeEvent({...baseEvent,recurrence:['RRULE:FREQ=WEEKLY']},source,zone).editable,false);
  assert.equal(normalizeEvent({...baseEvent,attendees:[{self:false}]},source,zone).editable,false);
  assert.equal(normalizeEvent({...baseEvent,status:'cancelled'},source,zone),null);
});

test('Todoist sync and guarded write-back',async t=>{
  const h=await harness();try{
    await t.test('does not expose credentials; imports only Personal',async()=>{
      const connected=await h.post('/todoist/connect',{token:'fake-todoist-token-for-tests'});assert.equal(connected.status,200);
      assert.equal(JSON.stringify(connected.data).includes('fake-todoist'),false);
      const sync=await h.post('/sync',{date:'2026-09-11',timeZone:zone});assert.equal(sync.status,200);assert.deepEqual(sync.data.todoist.sources.map(s=>s.id),['personal','learning']);assert.equal(sync.data.tasks.length,1);
      assert.equal((await stat(join(h.directory,'integrations.private.json'))).mode&0o777,0o600);
      h.remote.pagination=true;const paged=await h.post('/sync',{date:'2026-09-11',timeZone:zone});assert.equal(paged.data.tasks.length,1);h.remote.pagination=false;
    });
    await t.test('preserves cached edits when the next read fails',async()=>{
      const task=(await h.view()).tasks[0];h.remote.failTasks=true;
      const mutation={provider:'todoist',action:'update',id:task.id,version:task.version,title:'Edited personal task',date:task.dueDate,timeZone:zone,requestId:randomUUID()};
      const result=await h.post('/mutate',mutation);assert.equal(result.status,200);assert.equal(h.remote.task.content,'Edited personal task');assert.equal(result.data.tasks[0].title,'Edited personal task');assert.ok(result.data.todoist.error);
      const writes=h.remote.todoistWrites;assert.equal((await h.post('/mutate',mutation)).status,200);assert.equal(h.remote.todoistWrites,writes);
      assert.equal((await h.post('/mutate',{...mutation,title:'Different payload'})).status,409);
      h.remote.failTasks=false;await h.post('/sync',{date:'2026-09-11',timeZone:zone});
    });
    await t.test('completes one recurring occurrence and never replays completion',async()=>{
      h.remote.task.due={date:'2026-09-11',is_recurring:true};await h.post('/sync',{date:'2026-09-11',timeZone:zone});const task=(await h.view()).tasks[0];const request={provider:'todoist',action:'complete',id:task.id,version:task.version,requestId:randomUUID(),timeZone:zone};const completed=await h.post('/mutate',request);assert.equal(completed.status,200);assert.equal(completed.data.tasks[0].dueDate,'2026-09-12');const writes=h.remote.todoistWrites;await h.post('/mutate',request);assert.equal(h.remote.todoistWrites,writes);
    });
    await t.test('rejects stale, timed, recurring and out-of-scope edits',async()=>{
      let task=(await h.view()).tasks[0];h.remote.task.content='Changed outside workspace';
      const base={provider:'todoist',action:'update',id:task.id,title:'New title',date:'2026-09-12',timeZone:zone};
      const before=h.remote.todoistWrites;
      assert.equal((await h.post('/mutate',{...base,version:task.version,requestId:randomUUID()})).status,409);
      h.remote.task.due={date:'2026-09-11T09:00:00',is_recurring:false};await h.post('/sync',{date:'2026-09-11',timeZone:zone});task=(await h.view()).tasks[0];
      assert.equal((await h.post('/mutate',{...base,version:task.version,requestId:randomUUID()})).status,400);
      h.remote.task.project_id='work';
      assert.equal((await h.post('/mutate',{...base,version:task.version,requestId:randomUUID()})).status,403);assert.equal(h.remote.todoistWrites,before);
    });
    await t.test('missing Personal never falls back to Inbox',async()=>{
      h.remote.projects=[{id:'inbox',name:'Inbox'},{id:'work',name:'Artek'}];assert.equal((await h.post('/todoist/connect',{token:'different-fake-todoist-token'})).status,400);
    });
  }finally{await h.cleanup();}
});

test('linked provider creates retain exact remote identities',async t=>{
  await t.test('Todoist goal task persists its link across replay, sync, and disconnect',async()=>{
    const h=await harness();try{
      assert.equal((await h.post('/todoist/connect',{token:'linked-todoist-token-for-tests'})).status,200);
      const entityId=randomUUID();const requestId=randomUUID();
      const mutation={provider:'todoist',action:'create',sourceId:'personal',title:'[Climbing] Book a lead lesson',date:'2026-09-18',anchorDate:'2026-09-18',timeZone:zone,requestId,link:{entityKind:'goal',entityId,role:'goal-next-step'}};
      const created=await h.post('/mutate',mutation);assert.equal(created.status,200);assert.equal(created.data.links.length,1);
      const link=integrationLinkSchema.parse(created.data.links[0]);assert.deepEqual({...link,id:undefined,createdAt:undefined},{id:undefined,createdAt:undefined,entityKind:'goal',entityId,role:'goal-next-step',provider:'todoist',remoteId:'created-task',requestId});
      const writes=h.remote.todoistWrites;const replay=await h.post('/mutate',mutation);assert.equal(replay.status,200);assert.equal(h.remote.todoistWrites,writes);assert.equal(replay.data.links[0].id,link.id);
      const refreshed=await h.post('/sync',{date:'2026-09-18',timeZone:zone});assert.equal(refreshed.data.links[0].id,link.id);
      const disconnected=await h.post('/disconnect',{provider:'todoist'});assert.equal(disconnected.status,200);assert.equal(disconnected.data.links[0].remoteId,'created-task');
      const saved=JSON.parse(await readFile(join(h.directory,'integrations.private.json'),'utf8'));assert.equal(saved.receipts[requestId].id,'created-task');assert.equal(saved.view.links[0].id,link.id);
    }finally{await h.cleanup();}
  });
  await t.test('Google scheduled session persists location and allows only one event per plan',async()=>{
    const h=await harness();try{
      await h.googleConnect();const entityId=randomUUID();const requestId=randomUUID();
      const mutation={provider:'google',action:'create',title:'Climbing · Power session',date:'2026-09-19',endDate:'2026-09-19',time:'18:00',endTime:'19:30',allDay:false,location:'Movement Portland',anchorDate:'2026-09-19',timeZone:zone,requestId,link:{entityKind:'plan',entityId,role:'scheduled-session'}};
      const created=await h.post('/mutate',mutation);assert.equal(created.status,200);assert.equal(h.remote.googleWrites.at(-1).location,'Movement Portland');
      const link=integrationLinkSchema.parse(created.data.links[0]);assert.equal(link.remoteId,requestId.replaceAll('-',''));assert.equal(link.entityId,entityId);assert.equal(link.role,'scheduled-session');
      const writes=h.remote.googleWrites.length;const replay=await h.post('/mutate',mutation);assert.equal(replay.status,200);assert.equal(h.remote.googleWrites.length,writes);assert.equal(replay.data.links[0].id,link.id);
      const duplicate=await h.post('/mutate',{...mutation,requestId:randomUUID(),title:'Duplicate climbing block'});assert.equal(duplicate.status,409);assert.equal(h.remote.googleWrites.length,writes);
      const detached=await h.post('/unlink',{id:link.id});assert.equal(detached.status,200);assert.deepEqual(detached.data.links,[]);
      const retiredReplay=await h.post('/mutate',mutation);assert.equal(retiredReplay.status,409);assert.equal(h.remote.googleWrites.length,writes);
      const replacement=await h.post('/mutate',{...mutation,requestId:randomUUID(),title:'Replacement climbing block'});assert.equal(replacement.status,200);assert.equal(replacement.data.links.length,1);assert.equal(h.remote.googleWrites.length,writes+1);
      const disconnected=await h.post('/disconnect',{provider:'google'});assert.equal(disconnected.status,200);assert.equal(disconnected.data.links[0].id,replacement.data.links[0].id);
    }finally{await h.cleanup();}
  });
});

test('integration mutations use a cross-process lock around provider writes',async()=>{
  const h=await harness();let second;try{
    await h.googleConnect();h.remote.mutationDelay=75;
    const service=createIntegrationService(h.directory,h.fakeFetch);second=createServer(service.handle);await new Promise(resolve=>second.listen(0,'127.0.0.1',resolve));
    const secondOrigin=`http://127.0.0.1:${second.address().port}`;
    const postSecond=async(path,body)=>{const response=await fetch(`${secondOrigin}/api/integrations${path}`,{method:'POST',headers:{'Content-Type':'application/json',Origin:secondOrigin},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
    const entityId=randomUUID();const common={provider:'google',action:'create',title:'Climbing · Locked plan',date:'2026-09-20',endDate:'2026-09-20',time:'10:00',endTime:'11:00',allDay:false,anchorDate:'2026-09-20',timeZone:zone,link:{entityKind:'plan',entityId,role:'scheduled-session'}};
    const results=await Promise.all([h.post('/mutate',{...common,requestId:randomUUID()}),postSecond('/mutate',{...common,requestId:randomUUID()})]);
    assert.deepEqual(results.map(result=>result.status).sort((a,b)=>a-b),[200,423]);
    assert.equal(h.remote.googleWrites.length,1);
    const saved=JSON.parse(await readFile(join(h.directory,'integrations.private.json'),'utf8'));assert.equal(saved.view.links.length,1);assert.equal(Object.keys(saved.receipts).length>0,true);
  }finally{if(second)await new Promise(resolve=>second.close(resolve));await h.cleanup();}
});

test('integration link validation rejects mismatched or non-create mutations',async()=>{
  const h=await harness();try{
    const goal={entityKind:'goal',entityId:randomUUID(),role:'goal-next-step'};
    const plan={entityKind:'plan',entityId:randomUUID(),role:'scheduled-session'};
    assert.equal((await h.post('/mutate',{provider:'google',action:'create',requestId:randomUUID(),title:'Wrong provider',date:'2026-09-11',endDate:'2026-09-11',time:'09:00',endTime:'10:00',allDay:false,timeZone:zone,link:goal})).status,400);
    assert.equal((await h.post('/mutate',{provider:'todoist',action:'create',requestId:randomUUID(),title:'Wrong provider',timeZone:zone,link:plan})).status,400);
    assert.equal((await h.post('/mutate',{provider:'google',action:'update',id:'event1',version:'"v1"',requestId:randomUUID(),title:'Cannot add link',date:'2026-09-11',endDate:'2026-09-11',time:'09:00',endTime:'10:00',allDay:false,timeZone:zone,link:plan})).status,400);
    assert.equal((await h.post('/mutate',{provider:'todoist',action:'create',requestId:randomUUID(),title:'No Todoist location',location:'Gym',timeZone:zone})).status,400);
  }finally{await h.cleanup();}
});

test('saved integration views without links migrate to an empty link list',async()=>{
  const h=await harness();try{
    assert.equal((await h.post('/todoist/connect',{token:'migration-todoist-token-for-tests'})).status,200);
    const path=join(h.directory,'integrations.private.json');const saved=JSON.parse(await readFile(path,'utf8'));delete saved.view.links;await writeFile(path,JSON.stringify(saved));
    const migrated=await h.view();assert.deepEqual(migrated.links,[]);
    const persisted=await h.post('/sync',{date:'2026-09-11',timeZone:zone});assert.deepEqual(persisted.data.links,[]);assert.deepEqual(JSON.parse(await readFile(path,'utf8')).view.links,[]);
  }finally{await h.cleanup();}
});

test('Google client replacement rejects Web credentials and expires old authorization links',async()=>{
  const h=await harness();try{
    await h.googleConnect();
    const path=join(h.directory,'integrations.private.json');
    const before=await readFile(path,'utf8');
    const oldAuth=new URL((await h.post('/google/start',{})).data.url);
    const rejected=await h.post('/google/configure',{web:{client_id:'new-web.apps.googleusercontent.com',client_secret:'fake-web-secret'}});
    assert.equal(rejected.status,400);
    assert.match(rejected.data.error,/Web application.*Desktop app/);
    assert.equal(JSON.stringify(rejected.data).includes('fake-web-secret'),false);
    assert.equal(await readFile(path,'utf8'),before,'rejected replacement must preserve the saved connection');
    const malformed=await h.post('/google/configure',{installed:{client_id:'missing-secret.apps.googleusercontent.com'}});
    assert.equal(malformed.status,400);
    assert.match(malformed.data.error,/not saved/);
    assert.equal(await readFile(path,'utf8'),before);
    const replacement=await h.post('/google/configure',{installed:{client_id:'new-desktop.apps.googleusercontent.com',client_secret:'fake-new-secret'}});
    assert.equal(replacement.status,200);
    assert.equal(replacement.data.google.connected,false);
    assert.equal(replacement.data.google.configured,true);
    assert.equal(JSON.stringify(replacement.data).includes('fake-new-secret'),false);
    const exchanges=h.remote.tokenExchanges.length;
    const callback=await fetch(`${h.origin}/api/integrations/google/callback?state=${oldAuth.searchParams.get('state')}&code=fake`,{redirect:'manual'});
    assert.equal(callback.status,400);
    assert.equal(h.remote.tokenExchanges.length,exchanges,'old authorization must not exchange a code using the new client');
    const nextAuth=new URL((await h.post('/google/start',{})).data.url);
    assert.equal(nextAuth.searchParams.get('client_id'),'new-desktop.apps.googleusercontent.com');
  }finally{await h.cleanup();}
});

test('Google OAuth and precise calendar edits',async t=>{
  const h=await harness();try{
    await t.test('validates state, PKCE, account, and one-use callback',async()=>{await h.googleConnect();const view=await h.view();assert.equal(view.google.connected,true);assert.equal(JSON.stringify(view).includes('test-google-access'),false);});
    await t.test('refreshes expired access without exposing credentials',async()=>{
      const path=join(h.directory,'integrations.private.json');const saved=JSON.parse(await readFile(path,'utf8'));saved.googleTokens.expiresAt=0;await writeFile(path,JSON.stringify(saved));h.remote.pagination=true;const result=await h.post('/sync',{date:'2026-09-11',timeZone:zone});assert.equal(result.data.events.length,1);assert.equal(h.remote.tokenExchanges.at(-1).grant_type,'refresh_token');h.remote.pagination=false;
    });
    await t.test('title-only PATCH preserves seconds and original boundaries',async()=>{
      await h.post('/sync',{date:'2026-09-11',timeZone:zone});const event=(await h.view()).events[0];
      h.remote.failEvents=true;
      const result=await h.post('/mutate',{provider:'google',action:'update',id:event.id,version:event.version,title:'Renamed event',date:event.startDate,endDate:event.endDate,time:event.startTime,endTime:event.endTime,allDay:false,timeZone:zone,requestId:randomUUID()});
      assert.equal(result.status,200);assert.deepEqual(h.remote.googleWrites.at(-1),{summary:'Renamed event'});assert.equal(h.remote.event.start.dateTime,'2026-09-11T09:00:30-07:00');assert.equal(result.data.events[0].title,'Renamed event');assert.ok(result.data.google.error);h.remote.failEvents=false;
    });
    await t.test('converts timed events to all-day by clearing nested fields',async()=>{
      const event=(await h.view()).events[0];const result=await h.post('/mutate',{provider:'google',action:'update',id:event.id,version:event.version,title:event.title,date:'2026-09-11',endDate:'2026-09-12',time:null,endTime:null,allDay:true,timeZone:zone,requestId:randomUUID()});
      assert.equal(result.status,200);assert.deepEqual(h.remote.googleWrites.at(-1).start,{date:'2026-09-11',dateTime:null,timeZone:null});assert.equal(result.data.events[0].allDay,true);
    });
    await t.test('updates an event location without replacing its time boundaries',async()=>{
      const event=(await h.view()).events[0];const result=await h.post('/mutate',{provider:'google',action:'update',id:event.id,version:event.version,title:event.title,date:event.startDate,endDate:event.endDate,time:null,endTime:null,allDay:true,location:'Portland Rock Gym',timeZone:zone,requestId:randomUUID()});
      assert.equal(result.status,200);assert.deepEqual(h.remote.googleWrites.at(-1),{summary:event.title,location:'Portland Rock Gym'});assert.equal(result.data.events[0].location,'Portland Rock Gym');
    });
    await t.test('refuses stale versions, series masters, and guest meetings',async()=>{
      const event=(await h.view()).events[0];const base={provider:'google',action:'delete',id:event.id,version:event.version,timeZone:zone,requestId:randomUUID()};const writes=h.remote.googleWrites.length;
      h.remote.event.etag='"newer"';assert.equal((await h.post('/mutate',base)).status,409);
      h.remote.event.attendees=[{self:false}];assert.equal((await h.post('/mutate',{...base,version:h.remote.event.etag,requestId:randomUUID()})).status,400);
      delete h.remote.event.attendees;h.remote.event.recurrence=['RRULE:FREQ=WEEKLY'];assert.equal((await h.post('/mutate',{...base,version:h.remote.event.etag,requestId:randomUUID()})).status,400);assert.equal(h.remote.googleWrites.length,writes);
    });
    await t.test('refuses a different Google primary account',async()=>{
      h.remote.primaryId='jordan@artek.energy';const current=(await h.view()).events[0];const result=await h.post('/mutate',{provider:'google',action:'delete',id:current.id,version:current.version,timeZone:zone,requestId:randomUUID()});assert.equal(result.status,400);h.remote.primaryId=PERSONAL_CALENDAR;
    });
    await t.test('blocks cross-origin writes and unknown OAuth callbacks',async()=>{
      const response=await fetch(h.origin+'/api/integrations/disconnect',{method:'POST',headers:{Origin:'https://example.com','Content-Type':'application/json'},body:JSON.stringify({provider:'google'})});assert.equal(response.status,403);assert.equal((await h.view()).google.connected,true);
    });
  }finally{await h.cleanup();}
});

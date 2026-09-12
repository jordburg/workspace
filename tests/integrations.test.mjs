import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createIntegrationService, GMAIL_SCOPE } from '../build/integrations.ts';
import { integrationLinkSchema, integrationLinksSchema, todoistSources, personalProjects, normalizeEvent, eventOnDay, PERSONAL_CALENDAR } from '../lib/integrations/model.ts';

const zone='America/Los_Angeles';
const source={id:PERSONAL_CALENDAR,name:'Personal',area:'personal',blocked:false};
const baseEvent={id:'event1',etag:'"v1"',summary:'Focus time',organizer:{self:true},start:{dateTime:'2026-09-11T09:00:30-07:00'},end:{dateTime:'2026-09-11T10:00:30-07:00'}};
const baseTask={id:'task1',project_id:'personal',content:'Personal task',due:{date:'2026-09-11',is_recurring:false},priority:3,updated_at:'one',checked:false};
const mail=(id,overrides={})=>({id,threadId:`thread-${id}`,labelIds:['INBOX','UNREAD'],snippet:`Preview for ${id}`,historyId:`history-${id}`,internalDate:'1789156800000',payload:{headers:[{name:'From',value:`Sender ${id} <sender-${id}@example.com>`},{name:'Reply-To',value:`reply-${id}@example.com`},{name:'To',value:PERSONAL_CALENDAR},{name:'Subject',value:`Subject ${id}`},{name:'Date',value:'Fri, 11 Sep 2026 12:00:00 -0700'},{name:'Message-ID',value:`<${id}@example.com>`},{name:'References',value:'<earlier@example.com>'}]},...overrides});

async function harness() {
  const directory=await mkdtemp(join(tmpdir(),'workspace-integration-test-'));
  const remote={calls:[],task:{...baseTask},event:structuredClone(baseEvent),failTasks:false,failEvents:false,failGmail:false,failSendUncertain:false,sendCommittedStatus:null,sendRejectedStatus:null,failModifyUncertain:false,failTrashUncertain:false,gmailMetadataDelay:0,gmailMetadataActive:0,gmailMetadataMax:0,missingGmailIds:new Set(),projects:[{id:'personal',name:'Personal'},{id:'learning',name:'Learning',parent_id:'personal'},{id:'work',name:'Artek'},{id:'work-child',name:'Personal',parent_id:'work'}],pagination:false,primaryId:PERSONAL_CALENDAR,gmailProfile:PERSONAL_CALENDAR,gmailTokenScope:`${GMAIL_SCOPE} openid email https://www.googleapis.com/auth/userinfo.profile`,calendarTokenScope:'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.owned openid profile',gmailMessages:[mail('personal'),mail('personal-two'),mail('header-work',{payload:{headers:[{name:'From',value:'Colleague <person@artek.energy>'},{name:'To',value:PERSONAL_CALENDAR},{name:'Subject',value:'Work mail'}]}}),mail('label-work',{labelIds:['INBOX','UNREAD','Label_Work_Artek']})],tokenExchanges:[],commands:new Map(),googleWrites:[],gmailWrites:[],gmailSends:[],todoistWrites:0,mutationDelay:0};
  const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
  const fakeFetch=async(input,options={})=>{
    const url=new URL(String(input));remote.calls.push({url:url.href,method:options.method||'GET'});
    const method=options.method||'GET';
    if(url.href==='https://oauth2.googleapis.com/token') {const exchange=Object.fromEntries(new URLSearchParams(options.body));remote.tokenExchanges.push(exchange);const gmail=exchange.redirect_uri?.includes('/gmail/callback')||exchange.refresh_token==='test-gmail-refresh';return json({access_token:gmail?'test-gmail-access':'test-google-access',refresh_token:gmail?'test-gmail-refresh':'test-google-refresh',expires_in:3600,scope:gmail?remote.gmailTokenScope:remote.calendarTokenScope});}
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
    if(url.hostname==='gmail.googleapis.com') {
      if(url.pathname.endsWith('/profile'))return json({emailAddress:remote.gmailProfile,messagesTotal:remote.gmailMessages.length,threadsTotal:remote.gmailMessages.length,historyId:'profile-history'});
      if(url.pathname.endsWith('/labels'))return json({labels:[{id:'INBOX',name:'INBOX'},{id:'Label_Artek',name:'Artek'},{id:'Label_Artek_Nested',name:'Artek/Clients'},{id:'Label_Work_Artek',name:'Work/Artek'}]});
      if(url.pathname.endsWith('/messages/send')&&method==='POST'){const body=JSON.parse(options.body);remote.gmailSends.push(body);if(remote.sendRejectedStatus)return json({error:'message rejected before delivery'},remote.sendRejectedStatus);const mime=Buffer.from(body.raw,'base64url').toString('utf8');const messageId=/^Message-ID: (.+)$/m.exec(mime)?.[1].trim()||'';const requestBinding=/^X-Workspace-Request-Binding: (.+)$/m.exec(mime)?.[1].trim()||'';const sentId=`sent-${remote.gmailSends.length}`;remote.gmailMessages.push(mail(sentId,{threadId:body.threadId||`sent-thread-${remote.gmailSends.length}`,labelIds:['SENT'],historyId:randomUUID(),payload:{headers:[{name:'From',value:PERSONAL_CALENDAR},{name:'To',value:'friend@example.com'},{name:'Subject',value:'Sent message'},{name:'Message-ID',value:messageId},{name:'X-Workspace-Request-Binding',value:requestBinding}]}}));if(remote.failSendUncertain)throw new Error('connection dropped after delivery');if(remote.sendCommittedStatus)return json({error:'response lost after delivery'},remote.sendCommittedStatus);return json({id:sentId,threadId:body.threadId||`sent-thread-${remote.gmailSends.length}`});}
      if(url.pathname.endsWith('/messages')&&method==='GET'){const query=url.searchParams.get('q');if(remote.failGmail&&!query)return json({error:'offline'},503);if(query){const expected=query.replace(/^rfc822msgid:/,'');return json({messages:remote.gmailMessages.filter(message=>message.labelIds.includes('SENT')&&message.payload?.headers.some(header=>header.name.toLowerCase()==='message-id'&&header.value===expected)).map(({id,threadId})=>({id,threadId}))});}assert.deepEqual(url.searchParams.getAll('labelIds'),['INBOX']);return json({messages:remote.gmailMessages.filter(message=>message.labelIds.includes('INBOX')).map(({id,threadId})=>({id,threadId}))});}
      const match=url.pathname.match(/\/messages\/([^/]+?)(?:\/(modify|trash))?$/);if(match){const id=decodeURIComponent(match[1]);const message=remote.gmailMessages.find(item=>item.id===id);if(!message||remote.missingGmailIds.has(id))return json({},404);if(method==='GET'){remote.gmailMetadataActive++;remote.gmailMetadataMax=Math.max(remote.gmailMetadataMax,remote.gmailMetadataActive);if(remote.gmailMetadataDelay)await new Promise(resolve=>setTimeout(resolve,remote.gmailMetadataDelay));remote.gmailMetadataActive--;return json(message);}if(match[2]==='modify'&&method==='POST'){const body=JSON.parse(options.body);remote.gmailWrites.push({id,action:'modify',body,hasBody:options.body!==undefined,url:url.href});message.labelIds=[...new Set(message.labelIds.filter(label=>!body.removeLabelIds.includes(label)).concat(body.addLabelIds))];message.historyId=randomUUID();if(remote.failModifyUncertain)throw new Error('connection dropped after modify');return json(message);}if(match[2]==='trash'&&method==='POST'){remote.gmailWrites.push({id,action:'trash',hasBody:options.body!==undefined,url:url.href});message.labelIds=[...new Set(message.labelIds.filter(label=>label!=='INBOX').concat('TRASH'))];message.historyId=randomUUID();if(remote.failTrashUncertain)throw new Error('connection dropped after trash');return json(message);}}
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
    assert.equal(auth.searchParams.get('code_challenge_method'),'S256');assert.equal(auth.searchParams.get('login_hint'),PERSONAL_CALENDAR);assert.equal(auth.searchParams.has('include_granted_scopes'),false);
    assert.equal((await fetch(`${origin}/api/integrations/google/callback?state=wrong&code=fake`,{redirect:'manual'})).status,400);
    const callback=await fetch(`${origin}/api/integrations/google/callback?state=${auth.searchParams.get('state')}&code=fake`,{redirect:'manual'});assert.equal(callback.status,302);
    assert.equal(createHash('sha256').update(remote.tokenExchanges.at(-1).code_verifier).digest('base64url'),auth.searchParams.get('code_challenge'));
    assert.equal((await fetch(`${origin}/api/integrations/google/callback?state=${auth.searchParams.get('state')}&code=fake`,{redirect:'manual'})).status,400);
  }
  async function gmailConnect(){
    const before=await view();if(!before.google.configured&&!before.gmail.configured)assert.equal((await post('/google/configure',{installed:{client_id:'test-client.apps.googleusercontent.com',client_secret:'fake-client-secret'}})).status,200);
    const start=await post('/gmail/start',{});assert.equal(start.status,200);const auth=new URL(start.data.url);assert.equal(auth.searchParams.get('scope'),GMAIL_SCOPE);assert.equal(auth.searchParams.get('scope').includes('mail.google.com'),false);assert.equal(auth.searchParams.get('login_hint'),PERSONAL_CALENDAR);assert.equal(auth.searchParams.get('code_challenge_method'),'S256');assert.equal(auth.searchParams.has('include_granted_scopes'),false);
    assert.equal((await fetch(`${origin}/api/integrations/google/callback?state=${auth.searchParams.get('state')}&code=fake`,{redirect:'manual'})).status,400,'Gmail state cannot be redeemed at the Calendar callback');
    const retry=await post('/gmail/start',{});const retryAuth=new URL(retry.data.url);const callback=await fetch(`${origin}/api/integrations/gmail/callback?state=${retryAuth.searchParams.get('state')}&code=fake`,{redirect:'manual'});assert.equal(callback.status,302);assert.equal(callback.headers.get('location'),'/?connected=gmail');assert.equal(createHash('sha256').update(remote.tokenExchanges.at(-1).code_verifier).digest('base64url'),retryAuth.searchParams.get('code_challenge'));
  }
  return {remote,fakeFetch,post,view,googleConnect,gmailConnect,directory,origin,cleanup:async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}};
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
  await t.test('Todoist goal task requires an explicit unlink before replacement even when its task is absent from the cache',async()=>{
    const h=await harness();try{
      assert.equal((await h.post('/todoist/connect',{token:'linked-todoist-token-for-tests'})).status,200);
      const entityId=randomUUID();const requestId=randomUUID();
      const mutation={provider:'todoist',action:'create',sourceId:'personal',title:'[Climbing] Book a lead lesson',date:'2026-09-18',anchorDate:'2026-09-18',timeZone:zone,requestId,link:{entityKind:'goal',entityId,role:'goal-next-step'}};
      const created=await h.post('/mutate',mutation);assert.equal(created.status,200);assert.equal(created.data.links.length,1);
      const link=integrationLinkSchema.parse(created.data.links[0]);assert.deepEqual({...link,id:undefined,createdAt:undefined},{id:undefined,createdAt:undefined,entityKind:'goal',entityId,role:'goal-next-step',provider:'todoist',remoteId:'created-task',requestId});
      const writes=h.remote.todoistWrites;const replay=await h.post('/mutate',mutation);assert.equal(replay.status,200);assert.equal(h.remote.todoistWrites,writes);assert.equal(replay.data.links[0].id,link.id);
      const refreshed=await h.post('/sync',{date:'2026-09-18',timeZone:zone});assert.equal(refreshed.data.links[0].id,link.id);assert.equal(refreshed.data.tasks.some(task=>task.id===link.remoteId),false);
      const duplicate=await h.post('/mutate',{...mutation,requestId:randomUUID(),title:'[Climbing] Duplicate next step'});assert.equal(duplicate.status,409);assert.equal(h.remote.todoistWrites,writes);
      const detached=await h.post('/unlink',{id:link.id});assert.equal(detached.status,200);assert.deepEqual(detached.data.links,[]);assert.equal(h.remote.todoistWrites,writes);
      const retiredReplay=await h.post('/mutate',mutation);assert.equal(retiredReplay.status,409);assert.equal(h.remote.todoistWrites,writes);
      const replacement=await h.post('/mutate',{...mutation,requestId:randomUUID(),title:'[Climbing] Replacement next step'});assert.equal(replacement.status,200);assert.equal(replacement.data.links.length,1);assert.equal(h.remote.todoistWrites,writes+1);
      const disconnected=await h.post('/disconnect',{provider:'todoist'});assert.equal(disconnected.status,200);assert.equal(disconnected.data.links[0].remoteId,'created-task');
      const saved=JSON.parse(await readFile(join(h.directory,'integrations.private.json'),'utf8'));assert.equal(saved.receipts[requestId].id,'created-task');assert.equal(saved.detachedRequests.includes(requestId),true);assert.equal(saved.view.links[0].id,replacement.data.links[0].id);
    }finally{await h.cleanup();}
  });
  await t.test('Google scheduled session persists location and allows only one event per plan',async()=>{
    const h=await harness();try{
      await h.googleConnect();const entityId=randomUUID();const requestId=randomUUID();
      const mutation={provider:'google',action:'create',title:'Climbing · Power session',date:'2026-09-19',endDate:'2026-09-19',time:'18:00',endTime:'19:30',allDay:false,location:'Movement Portland',anchorDate:'2026-09-19',timeZone:zone,requestId,link:{entityKind:'plan',entityId,role:'scheduled-session'}};
      const created=await h.post('/mutate',mutation);assert.equal(created.status,200);assert.equal(h.remote.googleWrites.at(-1).location,'Movement Portland');
      const link=integrationLinkSchema.parse(created.data.links[0]);assert.equal(link.remoteId,requestId.replaceAll('-',''));assert.equal(link.entityId,entityId);assert.equal(link.role,'scheduled-session');
      const writes=h.remote.googleWrites.length;const replay=await h.post('/mutate',mutation);assert.equal(replay.status,200);assert.equal(h.remote.googleWrites.length,writes);assert.equal(replay.data.links[0].id,link.id);
      h.remote.event={...h.remote.event,status:'cancelled'};const missing=await h.post('/sync',{date:'2026-09-19',timeZone:zone});assert.deepEqual(missing.data.events,[]);assert.equal(missing.data.links[0].id,link.id);
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

test('integration link collections allow only one current link for each climbing goal or plan',()=>{
  const goalId=randomUUID();const planId=randomUUID();const now=new Date().toISOString();
  const goalLink={id:randomUUID(),entityKind:'goal',entityId:goalId,role:'goal-next-step',provider:'todoist',remoteId:'task-a',requestId:randomUUID(),createdAt:now};
  const planLink={id:randomUUID(),entityKind:'plan',entityId:planId,role:'scheduled-session',provider:'google',remoteId:'event-a',requestId:randomUUID(),createdAt:now};
  assert.equal(integrationLinksSchema.safeParse([goalLink,{...goalLink,id:randomUUID(),remoteId:'task-b',requestId:randomUUID()}]).success,false);
  assert.equal(integrationLinksSchema.safeParse([planLink,{...planLink,id:randomUUID(),remoteId:'event-b',requestId:randomUUID()}]).success,false);
  assert.equal(integrationLinksSchema.safeParse([goalLink,planLink]).success,true);
});

test('saved integration views without links migrate to an empty link list',async()=>{
  const h=await harness();try{
    assert.equal((await h.post('/todoist/connect',{token:'migration-todoist-token-for-tests'})).status,200);
    const path=join(h.directory,'integrations.private.json');const saved=JSON.parse(await readFile(path,'utf8'));delete saved.view.links;await writeFile(path,JSON.stringify(saved));
    delete saved.view.gmail;delete saved.view.messages;await writeFile(path,JSON.stringify(saved));
    const migrated=await h.view();assert.deepEqual(migrated.links,[]);assert.deepEqual(migrated.messages,[]);assert.equal(migrated.gmail.connected,false);assert.equal(migrated.gmail.configured,false);assert.equal(migrated.gmail.unreadCount,0);
    const persisted=await h.post('/sync',{date:'2026-09-11',timeZone:zone});assert.deepEqual(persisted.data.links,[]);assert.deepEqual(persisted.data.messages,[]);assert.deepEqual(JSON.parse(await readFile(path,'utf8')).view.links,[]);
  }finally{await h.cleanup();}
});

test('Gmail OAuth, personal boundary, bounded cache, and independent disconnect',async t=>{
  await t.test('uses a separate exact-scope PKCE grant and retains only personal mail',async()=>{
    const h=await harness();try{
      await h.googleConnect();await h.gmailConnect();
      h.remote.gmailMessages=[mail('header-work',{payload:{headers:[{name:'From',value:'Colleague <person@sub.artek.energy>'},{name:'To',value:PERSONAL_CALENDAR},{name:'Subject',value:'Work mail'}]}}),mail('list-work',{payload:{headers:[{name:'From',value:'Mailer <news@example.com>'},{name:'To',value:PERSONAL_CALENDAR},{name:'List-Id',value:'Artek Updates <updates.sub.artek.energy>'},{name:'Subject',value:'List mail'}]}}),mail('label-work',{labelIds:['INBOX','UNREAD','Label_Work_Artek']}),...Array.from({length:45},(_,index)=>mail(`safe-${index}`,{labelIds:index%2?['INBOX']:['INBOX','UNREAD','STARRED','IMPORTANT']}))];
      const synced=await h.post('/sync',{date:'2026-09-11',timeZone:zone});assert.equal(synced.status,200);assert.equal(synced.data.gmail.connected,true);assert.equal(synced.data.gmail.account,PERSONAL_CALENDAR);assert.equal(synced.data.messages.length,40);assert.equal(synced.data.gmail.unreadCount,20);assert.equal(synced.data.messages.some(message=>message.id.includes('work')),false);assert.equal(Object.hasOwn(synced.data.messages[0],'messageId'),false);assert.equal(JSON.stringify(synced.data).includes('test-gmail'),false);
      assert.equal(synced.data.google.connected,true,'the Calendar grant remains connected');
      const cached=structuredClone(synced.data.messages);h.remote.failGmail=true;const failed=await h.post('/gmail/sync',{date:'2026-09-11',timeZone:zone});assert.equal(failed.status,200);assert.deepEqual(failed.data.messages,cached);assert.ok(failed.data.gmail.error);h.remote.failGmail=false;
      const charset=await fetch(`${h.origin}/api/integrations/gmail/sync`,{method:'POST',headers:{Origin:h.origin,'Content-Type':'application/json; charset=utf-8'},body:'{}'});assert.equal(charset.status,200);const jsonp=await fetch(`${h.origin}/api/integrations/gmail/sync`,{method:'POST',headers:{Origin:h.origin,'Content-Type':'application/jsonp'},body:'{}'});assert.equal(jsonp.status,415);
      const disconnected=await h.post('/disconnect',{provider:'gmail'});assert.equal(disconnected.status,200);assert.equal(disconnected.data.gmail.connected,false);assert.equal(disconnected.data.gmail.configured,true);assert.deepEqual(disconnected.data.messages,[]);assert.equal(disconnected.data.google.connected,true);assert.equal(disconnected.data.events.length,1);
      const saved=JSON.parse(await readFile(join(h.directory,'integrations.private.json'),'utf8'));assert.ok(saved.googleClient);assert.ok(saved.googleTokens);assert.equal(saved.gmailTokens,undefined);
    }finally{await h.cleanup();}
  });
  await t.test('rejects a Gmail authorization for any other account',async()=>{
    const h=await harness();try{
      assert.equal((await h.post('/google/configure',{installed:{client_id:'test-client.apps.googleusercontent.com',client_secret:'fake-client-secret'}})).status,200);h.remote.gmailProfile='jordan@artek.energy';const started=await h.post('/gmail/start',{});const auth=new URL(started.data.url);const callback=await fetch(`${h.origin}/api/integrations/gmail/callback?state=${auth.searchParams.get('state')}&code=fake`,{redirect:'manual'});assert.equal(callback.status,400);assert.match((await callback.json()).error,new RegExp(PERSONAL_CALENDAR.replace('.','\\.')));assert.equal((await h.view()).gmail.connected,false);assert.equal(JSON.parse(await readFile(join(h.directory,'integrations.private.json'),'utf8')).gmailTokens,undefined);
    }finally{await h.cleanup();}
  });
  await t.test('rejects a Gmail token that carries an unexpected sensitive scope',async()=>{
    const h=await harness();try{
      assert.equal((await h.post('/google/configure',{installed:{client_id:'test-client.apps.googleusercontent.com',client_secret:'fake-client-secret'}})).status,200);h.remote.gmailTokenScope=`${GMAIL_SCOPE} https://mail.google.com/`;const started=await h.post('/gmail/start',{});const auth=new URL(started.data.url);assert.equal(auth.searchParams.has('include_granted_scopes'),false);const callback=await fetch(`${h.origin}/api/integrations/gmail/callback?state=${auth.searchParams.get('state')}&code=fake`,{redirect:'manual'});assert.equal(callback.status,400);assert.match((await callback.json()).error,/exactly the requested mail permissions/);assert.equal((await h.view()).gmail.connected,false);assert.equal(JSON.parse(await readFile(join(h.directory,'integrations.private.json'),'utf8')).gmailTokens,undefined);
    }finally{await h.cleanup();}
  });
  await t.test('inspects at most 50 newest IDs concurrently and skips a message that disappears mid-sync',async()=>{
    const h=await harness();try{
      await h.gmailConnect();h.remote.gmailMetadataDelay=2;h.remote.gmailMessages=Array.from({length:120},(_,index)=>mail(`blocked-${index}`,{labelIds:['INBOX','Label_Artek']}));h.remote.missingGmailIds.add('blocked-7');const before=h.remote.calls.length;const synced=await h.post('/gmail/sync',{});assert.equal(synced.status,200);assert.equal(synced.data.gmail.error,null);assert.deepEqual(synced.data.messages,[]);const inspected=h.remote.calls.slice(before).filter(call=>call.method==='GET'&&/\/messages\/[^/?]+\?/.test(call.url));assert.equal(inspected.length,50);assert.equal(h.remote.gmailMetadataMax>1,true);assert.equal(h.remote.gmailMetadataMax<=6,true);assert.equal(h.remote.calls.slice(before).filter(call=>call.url.includes('pageToken=')).length,0);
    }finally{await h.cleanup();}
  });
  await t.test('derives connected state from stored credentials instead of stale cached flags',async()=>{
    const h=await harness();try{
      await h.gmailConnect();await h.post('/gmail/sync',{});const path=join(h.directory,'integrations.private.json');const saved=JSON.parse(await readFile(path,'utf8'));delete saved.gmailTokens;saved.view.gmail.connected=true;saved.view.gmail.account=PERSONAL_CALENDAR;assert.equal(saved.view.messages.length>0,true);await writeFile(path,JSON.stringify(saved));const migrated=await h.view();assert.equal(migrated.gmail.connected,false);assert.equal(migrated.gmail.configured,true);assert.equal(migrated.gmail.account,null);assert.deepEqual(migrated.messages,[]);saved.gmailBindingKey='not-a-canonical-32-byte-key';await writeFile(path,JSON.stringify(saved));const invalid=await fetch(`${h.origin}/api/integrations`);assert.equal(invalid.status,500);assert.equal(JSON.parse(await readFile(path,'utf8')).gmailBindingKey,'not-a-canonical-32-byte-key','invalid private state must be rejected without rewriting it');
    }finally{await h.cleanup();}
  });
});

test('Gmail desired-state mutations are guarded, replay-safe, and never permanently delete',async()=>{
  const h=await harness();try{
    await h.gmailConnect();await h.post('/gmail/sync',{});let message=(await h.view()).messages[0];
    const readRequest={id:message.id,version:message.version,action:'read',requestId:randomUUID()};h.remote.failModifyUncertain=true;assert.equal((await h.post('/gmail/mutate',readRequest)).status,502);const readWrites=h.remote.gmailWrites.length;h.remote.failModifyUncertain=false;const read=await h.post('/gmail/mutate',readRequest);assert.equal(read.status,200);assert.equal(read.data.messages.find(item=>item.id===message.id).unread,false);assert.equal(h.remote.gmailWrites.length,readWrites);assert.deepEqual(h.remote.gmailWrites.at(-1).body,{addLabelIds:[],removeLabelIds:['UNREAD']});assert.match(h.remote.gmailWrites.at(-1).url,/\/messages\/personal\/modify$/);assert.equal((await h.post('/gmail/mutate',readRequest)).status,200);assert.equal((await h.post('/gmail/mutate',{...readRequest,action:'star'})).status,409);
    message=(await h.view()).messages.find(item=>item.id===message.id);const starRequest={id:message.id,version:message.version,action:'star',requestId:randomUUID()};h.remote.failModifyUncertain=true;assert.equal((await h.post('/gmail/mutate',starRequest)).status,502);const starWrites=h.remote.gmailWrites.length;h.remote.failModifyUncertain=false;const starred=await h.post('/gmail/mutate',starRequest);assert.equal(starred.status,200);assert.equal(starred.data.messages.find(item=>item.id===message.id).starred,true);assert.equal(h.remote.gmailWrites.length,starWrites);
    message=(await h.view()).messages.find(item=>item.id===message.id);h.remote.gmailMessages.find(item=>item.id===message.id).historyId='changed-elsewhere';const staleId=randomUUID();assert.equal((await h.post('/gmail/mutate',{id:message.id,version:message.version,action:'unstar',requestId:staleId})).status,409);assert.equal(JSON.parse(await readFile(join(h.directory,'integrations.private.json'),'utf8')).requests[staleId],undefined);
    await h.post('/gmail/sync',{});message=(await h.view()).messages.find(item=>item.id===message.id);const privatePath=join(h.directory,'integrations.private.json');const bloated=JSON.parse(await readFile(privatePath,'utf8'));for(let index=0;index<1005;index++){const id=randomUUID();bloated.requests[id]=`old-${index}`;bloated.receipts[id]={provider:'gmail',id:`old-${index}`};}await writeFile(privatePath,JSON.stringify(bloated));const archiveRequest={id:message.id,version:message.version,action:'archive',requestId:randomUUID()};h.remote.failModifyUncertain=true;assert.equal((await h.post('/gmail/mutate',archiveRequest)).status,502);const archiveWrites=h.remote.gmailWrites.length;h.remote.failModifyUncertain=false;const archive=await h.post('/gmail/mutate',archiveRequest);assert.equal(archive.status,200);assert.equal(archive.data.messages.some(item=>item.id===message.id),false);assert.equal(h.remote.gmailWrites.length,archiveWrites);assert.deepEqual(h.remote.gmailWrites.at(-1).body,{addLabelIds:[],removeLabelIds:['INBOX']});const pruned=JSON.parse(await readFile(privatePath,'utf8'));assert.equal(Object.keys(pruned.receipts).length<=1000,true);assert.equal(Object.keys(pruned.requests).length<=1000,true);
    message=(await h.view()).messages[0];const beforeTrash=h.remote.gmailWrites.length;assert.equal((await h.post('/gmail/mutate',{id:message.id,version:message.version,action:'trash',requestId:randomUUID()})).status,400);const trashRequest={id:message.id,version:message.version,action:'trash',requestId:randomUUID(),confirm:true};h.remote.failTrashUncertain=true;assert.equal((await h.post('/gmail/mutate',trashRequest)).status,502);assert.equal(h.remote.gmailWrites.length,beforeTrash+1);h.remote.failTrashUncertain=false;const trashed=await h.post('/gmail/mutate',trashRequest);assert.equal(trashed.status,200);assert.equal(h.remote.gmailWrites.length,beforeTrash+1);assert.equal(h.remote.gmailWrites.at(-1).action,'trash');assert.equal(h.remote.gmailWrites.at(-1).hasBody,false);assert.match(h.remote.gmailWrites.at(-1).url,/\/messages\/[^/]+\/trash$/);assert.equal(h.remote.calls.some(call=>call.method==='DELETE'&&call.url.includes('gmail.googleapis.com')),false);
  }finally{await h.cleanup();}
});

test('Gmail explicit send and reply use safe text MIME and durable request receipts',async()=>{
  const h=await harness();let second;try{
    await h.gmailConnect();await h.post('/gmail/sync',{});const message=(await h.view()).messages[0];
    const privatePath=join(h.directory,'integrations.private.json');const beforeSendState=JSON.parse(await readFile(privatePath,'utf8'));assert.equal(beforeSendState.gmailBindingKey,undefined,'read-only setup and sync must not create a send-binding key');
    assert.equal((await h.post('/gmail/send',{requestId:randomUUID(),to:['person@artek.energy'],subject:'No',body:'No',confirm:true})).status,400);
    assert.equal((await h.post('/gmail/send',{requestId:randomUUID(),to:['person@team.artek.energy'],subject:'No',body:'No',confirm:true})).status,400);
    assert.equal((await h.post('/gmail/send',{requestId:randomUUID(),to:['friend@example.com\r\nBcc: attacker@example.com'],subject:'No',body:'No',confirm:true})).status,400);
    assert.equal((await h.post('/gmail/send',{requestId:randomUUID(),to:['friend@example.com'],subject:'No\r\nBcc: attacker@example.com',body:'No',confirm:true})).status,400);
    assert.equal((await h.post('/gmail/send',{requestId:randomUUID(),to:['friend@example.com'],subject:'Needs confirmation',body:'No'})).status,400);
    const requestId=randomUUID();const outbound={requestId,to:['friend@example.com'],cc:[],bcc:['blind@example.com'],subject:'Café plans',body:'First line\nSecond line',confirm:true};const sent=await h.post('/gmail/send',outbound);assert.equal(sent.status,200);assert.equal(h.remote.gmailSends.length,1);const decoded=Buffer.from(h.remote.gmailSends[0].raw,'base64url').toString('utf8');assert.match(decoded,/^To: friend@example\.com\r\n/);assert.match(decoded,/^Bcc: blind@example\.com\r\n/m);assert.match(decoded,/Subject: =\?UTF-8\?B\?/);assert.match(decoded,new RegExp(`Message-ID: <workspace\\.${requestId}@jordmburg-workspace\\.local>`));const binding=/^X-Workspace-Request-Binding: ([A-Za-z0-9_-]{43})$/m.exec(decoded)?.[1];assert.ok(binding);const canonical={requestId,confirm:true,to:['friend@example.com'],cc:[],bcc:['blind@example.com'],subject:'Café plans',body:'First line\nSecond line'};const unkeyed=createHash('sha256').update(JSON.stringify(canonical)).digest();assert.notEqual(binding,unkeyed.toString('base64url'),'the sent header must not expose an unkeyed payload hash that can reveal Bcc by guessing');assert.equal(decoded.includes(unkeyed.toString('hex')),false);assert.equal(decoded.includes('X-Workspace-Request-Hash'),false);assert.match(decoded,/Content-Type: text\/plain; charset=UTF-8/);assert.equal(decoded.includes('fake-client-secret'),false);assert.equal(decoded.includes('test-gmail-access'),false);
    const keyedState=JSON.parse(await readFile(privatePath,'utf8'));assert.match(keyedState.gmailBindingKey,/^[A-Za-z0-9_-]{43}$/);assert.equal((await stat(privatePath)).mode&0o777,0o600);assert.equal(JSON.stringify(sent.data).includes(keyedState.gmailBindingKey),false);
    const encodedBody=decoded.split('\r\n\r\n')[1].replace(/\s/g,'');assert.equal(Buffer.from(encodedBody,'base64').toString('utf8'),'First line\r\nSecond line');
    assert.equal((await h.post('/gmail/send',outbound)).status,200);assert.equal(h.remote.gmailSends.length,1);assert.equal((await h.post('/gmail/send',{...outbound,subject:'Different'})).status,409);
    const replyBase={to:[message.replyTo],body:'Thanks!',replyToId:message.id,confirm:true};const beforeReply=h.remote.gmailSends.length;const badReplyId=randomUUID();assert.equal((await h.post('/gmail/send',{...replyBase,requestId:badReplyId,subject:'Edited thread subject'})).status,409);assert.equal(h.remote.gmailSends.length,beforeReply);assert.equal(JSON.parse(await readFile(join(h.directory,'integrations.private.json'),'utf8')).requests[badReplyId],undefined);const replyId=randomUUID();const reply=await h.post('/gmail/send',{...replyBase,requestId:replyId,subject:`Re: ${message.subject}`});assert.equal(reply.status,200);assert.equal(h.remote.gmailSends.at(-1).threadId,message.threadId);const replyMime=Buffer.from(h.remote.gmailSends.at(-1).raw,'base64url').toString('utf8');assert.match(replyMime,/In-Reply-To: <personal@example\.com>/);assert.match(replyMime,/References: <earlier@example\.com>\r\n <personal@example\.com>/);
    const alreadyRemote=h.remote.gmailMessages.find(item=>item.id==='personal-two');alreadyRemote.payload.headers.find(header=>header.name==='Subject').value='Re: Existing subject';await h.post('/gmail/sync',{});const already=(await h.view()).messages.find(item=>item.id==='personal-two');const alreadyReply=await h.post('/gmail/send',{requestId:randomUUID(),to:[already.replyTo],subject:'Re: Existing subject',body:'Still threaded',replyToId:already.id,confirm:true});assert.equal(alreadyReply.status,200);assert.match(Buffer.from(h.remote.gmailSends.at(-1).raw,'base64url').toString('utf8'),/Subject: Re: Existing subject/);
    const uncertainId=randomUUID();h.remote.failGmail=true;const uncertain={requestId:uncertainId,to:['friend@example.com'],subject:'Sent before refresh failed',body:'Only once',confirm:true};const uncertainResult=await h.post('/gmail/send',uncertain);assert.equal(uncertainResult.status,200);assert.ok(uncertainResult.data.gmail.error);const sends=h.remote.gmailSends.length;h.remote.failGmail=false;assert.equal((await h.post('/gmail/send',uncertain)).status,200);assert.equal(h.remote.gmailSends.length,sends,'a successful send receipt prevents duplicate delivery');
    const bloated=JSON.parse(await readFile(privatePath,'utf8'));for(let index=0;index<1005;index++){const id=randomUUID();bloated.requests[id]=`old-${index}`;bloated.receipts[id]={provider:'gmail',id:`old-${index}`};}await writeFile(privatePath,JSON.stringify(bloated));const longSubject='A'.repeat(998);assert.equal((await h.post('/gmail/send',{requestId:randomUUID(),to:['friend@example.com'],subject:longSubject,body:'Fold safely',confirm:true})).status,200);assert.match(Buffer.from(h.remote.gmailSends.at(-1).raw,'base64url').toString('utf8'),/Subject: =\?UTF-8\?B\?/);const pruned=JSON.parse(await readFile(privatePath,'utf8'));assert.equal(pruned.receipts[requestId],undefined);assert.equal(pruned.requests[requestId],undefined);
    const committedId=randomUUID();const committed={requestId:committedId,to:['friend@example.com'],subject:'Committed before 503',body:'Recover this once',confirm:true};h.remote.sendCommittedStatus=503;const committedFailure=await h.post('/gmail/send',committed);assert.equal(committedFailure.status,502);const afterCommitted=h.remote.gmailSends.length;assert.equal(JSON.parse(await readFile(privatePath,'utf8')).receipts[committedId].provider,'gmail-send-pending','ambiguous 5xx must retain the durable pending marker');h.remote.sendCommittedStatus=null;
    const secondService=createIntegrationService(h.directory,h.fakeFetch);second=createServer(secondService.handle);await new Promise(resolve=>second.listen(0,'127.0.0.1',resolve));const secondOrigin=`http://127.0.0.1:${second.address().port}`;const postSecond=async(path,body)=>{const response=await fetch(`${secondOrigin}/api/integrations${path}`,{method:'POST',headers:{'Content-Type':'application/json',Origin:secondOrigin},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};};const committedRecovery=await postSecond('/gmail/send',committed);assert.equal(committedRecovery.status,200);assert.equal(h.remote.gmailSends.length,afterCommitted,'a fresh service recovers a 503 response-loss send without delivering it again');assert.equal(JSON.parse(await readFile(privatePath,'utf8')).receipts[committedId].provider,'gmail');for(const status of [408,429,500,599]){const ambiguous={requestId:randomUUID(),to:['friend@example.com'],subject:`Ambiguous ${status}`,body:'Recover once',confirm:true};h.remote.sendCommittedStatus=status;const result=await h.post('/gmail/send',ambiguous);assert.equal(result.status,status===429?429:502);const afterAttempt=h.remote.gmailSends.length;assert.equal(JSON.parse(await readFile(privatePath,'utf8')).receipts[ambiguous.requestId].provider,'gmail-send-pending');h.remote.sendCommittedStatus=null;assert.equal((await postSecond('/gmail/send',ambiguous)).status,200);assert.equal(h.remote.gmailSends.length,afterAttempt);}const rejected={requestId:randomUUID(),to:['friend@example.com'],subject:'Definite rejection',body:'May retry',confirm:true};h.remote.sendRejectedStatus=400;assert.equal((await h.post('/gmail/send',rejected)).status,502);h.remote.sendRejectedStatus=null;const afterRejection=JSON.parse(await readFile(privatePath,'utf8'));assert.equal(afterRejection.receipts[rejected.requestId],undefined);assert.equal(afterRejection.requests[rejected.requestId],undefined);const beforeRecovery=h.remote.gmailSends.length;assert.equal((await postSecond('/gmail/send',{...outbound,body:'Different after pruning'})).status,409,'the recovered MIME binding still ties a pruned request ID to its original payload');assert.equal((await postSecond('/gmail/send',outbound)).status,200);assert.equal(h.remote.gmailSends.length,beforeRecovery,'a restarted service recovers a pruned receipt from deterministic Message-ID search');
    const droppedId=randomUUID();const dropped={requestId:droppedId,to:['friend@example.com'],subject:'Connection dropped',body:'Maybe sent once',confirm:true};h.remote.failSendUncertain=true;const droppedResult=await h.post('/gmail/send',dropped);assert.equal(droppedResult.status,409);assert.match(droppedResult.data.error,/may already have sent.*Check Sent/i);const afterDrop=h.remote.gmailSends.length;h.remote.failSendUncertain=false;const recovered=await postSecond('/gmail/send',dropped);assert.equal(recovered.status,200);assert.equal(h.remote.gmailSends.length,afterDrop);assert.equal(JSON.parse(await readFile(privatePath,'utf8')).receipts[droppedId].provider,'gmail');
    const unindexedId=randomUUID();const unindexed={requestId:unindexedId,to:['friend@example.com'],subject:'Not indexed yet',body:'Check Sent',confirm:true};h.remote.failSendUncertain=true;assert.equal((await h.post('/gmail/send',unindexed)).status,409);const unindexedSentId=`sent-${h.remote.gmailSends.length}`;h.remote.gmailMessages=h.remote.gmailMessages.filter(item=>item.id!==unindexedSentId);h.remote.failSendUncertain=false;const afterUnindexed=h.remote.gmailSends.length;const terminal=await postSecond('/gmail/send',unindexed);assert.equal(terminal.status,409);assert.match(terminal.data.error,/not searchable yet.*Check Sent/i);assert.equal(h.remote.gmailSends.length,afterUnindexed);const pendingBloat=JSON.parse(await readFile(privatePath,'utf8'));for(let index=0;index<1005;index++){const id=randomUUID();pendingBloat.requests[id]=`later-${index}`;pendingBloat.receipts[id]={provider:'gmail',id:`later-${index}`};}await writeFile(privatePath,JSON.stringify(pendingBloat));const inbox=(await h.view()).messages[0];await h.post('/gmail/mutate',{id:inbox.id,version:inbox.version,action:inbox.unread?'read':'unread',requestId:randomUUID()});const afterPendingPrune=JSON.parse(await readFile(privatePath,'utf8'));assert.equal(afterPendingPrune.receipts[unindexedId].provider,'gmail-send-pending');assert.equal(Object.keys(afterPendingPrune.receipts).length<=1000,true);
    const oversized=await h.post('/gmail/send',{requestId:randomUUID(),to:['friend@example.com'],subject:'Too large',body:'é'.repeat(140000),confirm:true});assert.equal(oversized.status,413);
  }finally{if(second)await new Promise(resolve=>second.close(resolve));await h.cleanup();}
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
    await t.test('rejects a Calendar token that carries another sensitive product scope',async()=>{
      const isolated=await harness();try{assert.equal((await isolated.post('/google/configure',{installed:{client_id:'test-client.apps.googleusercontent.com',client_secret:'fake-client-secret'}})).status,200);isolated.remote.calendarTokenScope=`https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.owned ${GMAIL_SCOPE}`;const started=await isolated.post('/google/start',{});const auth=new URL(started.data.url);assert.equal(auth.searchParams.has('include_granted_scopes'),false);const callback=await fetch(`${isolated.origin}/api/integrations/google/callback?state=${auth.searchParams.get('state')}&code=fake`,{redirect:'manual'});assert.equal(callback.status,400);assert.match((await callback.json()).error,/exactly the requested Calendar permissions/);assert.equal((await isolated.view()).google.connected,false);assert.equal(JSON.parse(await readFile(join(isolated.directory,'integrations.private.json'),'utf8')).googleTokens,undefined);}finally{await isolated.cleanup();}
    });
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

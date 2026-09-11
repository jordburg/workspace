import { readFile, mkdir, open, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { z } from "zod";
import { daySchema } from "../lib/workspace.ts";
import { emptySync, googleSources, todoistSources, personalProjects, normalizeTask, normalizeEvent, syncRequestSchema, PERSONAL_CALENDAR, isArtek, type SyncView, type Source, type RemoteTask, type RemoteEvent } from "../lib/integrations/model.ts";

const TODOIST = "https://api.todoist.com/api/v1";
const GOOGLE = "https://www.googleapis.com/calendar/v3";
const SCOPES = ["https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events.owned"];
const tokenSchema=z.object({access_token:z.string().min(1),refresh_token:z.string().optional(),expires_in:z.number().positive(),scope:z.string().optional()});
const clientSchema=z.object({installed:z.object({client_id:z.string().endsWith(".apps.googleusercontent.com"),client_secret:z.string().min(1)})});
const timeSchema=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const mutationSchema=z.object({provider:z.enum(["todoist","google"]),action:z.enum(["create","update","delete","complete"]),id:z.string().max(500).optional(),version:z.string().max(10000).optional(),requestId:z.string().uuid(),sourceId:z.string().max(500).optional(),anchorDate:daySchema.optional(),title:z.string().trim().min(1).max(2000).optional(),date:daySchema.nullable().optional(),endDate:daySchema.optional(),time:timeSchema.nullable().optional(),endTime:timeSchema.nullable().optional(),allDay:z.boolean().optional(),timeZone:z.string().max(100)}).strict();
type Mutation=z.infer<typeof mutationSchema>;
type SecretState={version:1;view:SyncView;todoistToken?:string;googleClient?:{client_id:string;client_secret:string};googleTokens?:{accessToken:string;refreshToken:string;expiresAt:number};receipts:Record<string,{provider:string;id?:string}>;requests:Record<string,string>};
class PublicError extends Error { readonly status:number; constructor(message:string,status=400){super(message);this.status=status;} }
const cleanError=(err:unknown)=>err instanceof PublicError?err.message:"The service could not be reached. Your last successful sync is still available. Try again.";

export function createIntegrationService(directory:string, remoteFetch:typeof fetch=fetch) {
  const file=join(directory,"integrations.private.json");
  const pending=new Map<string,{verifier:string;redirectUri:string;expires:number}>();
  let queue:Promise<unknown>=Promise.resolve();
  async function read():Promise<SecretState> {try {const data=JSON.parse(await readFile(file,"utf8")); if(data.version!==1 || !data.view || !data.receipts) throw new Error("Invalid integration data");data.requests ??= {};return data;} catch(err){if((err as NodeJS.ErrnoException).code==="ENOENT")return {version:1,view:emptySync(),receipts:{},requests:{}};throw new PublicError("Connection data could not be read. It has been left untouched.",500);} }
  async function write(state:SecretState) {await mkdir(directory,{recursive:true,mode:0o700});const temp=await open(`${file}.tmp`,"w",0o600);try{await temp.writeFile(JSON.stringify(state));await temp.sync();}finally{await temp.close();}await rename(`${file}.tmp`,file);}
  const exclusive=<T>(action:()=>Promise<T>):Promise<T>=>{const next=queue.catch(()=>{}).then(action);queue=next;return next;};
  async function request(url:string,token:string,options:RequestInit={}) {
    let response:Response;
    try{response=await remoteFetch(url,{...options,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",...options.headers},signal:AbortSignal.timeout(20000)});}catch{throw new PublicError("The service did not confirm this request. Refresh before retrying a change.",502);}
    if(!response.ok) {if(response.status===412)throw new PublicError("This event changed in Google Calendar. Close this editor, sync, and review the latest version before editing again.",409);if([401,403].includes(response.status))throw new PublicError("This connection needs permission to read and edit the selected personal source. Reconnect the correct account.",401);if(response.status===429)throw new PublicError("The service is limiting requests. Wait a moment before syncing again.",429);if(response.status===404)throw new PublicError("This item is no longer available. Refresh your workspace.",409);throw new PublicError(`The service rejected this request (${response.status}). Your draft has been kept.`,502);}
    const text=await response.text();return text?JSON.parse(text):null;
  }
  async function todoistPages(path:string,token:string) {const results:unknown[]=[];let cursor:string|null=null;const seen=new Set<string>();do {const url=new URL(TODOIST+path);url.searchParams.set("limit","200");if(cursor)url.searchParams.set("cursor",cursor);const data=await request(url.href,token);if(!Array.isArray(data.results))throw new PublicError("Todoist returned an unexpected response. Nothing was replaced.",502);results.push(...data.results);cursor=data.next_cursor || null;if(cursor && (seen.has(cursor)||seen.size>300))throw new PublicError("Todoist pagination did not finish. Nothing was replaced.",502);if(cursor)seen.add(cursor);}while(cursor);return results;}
  async function googlePages(path:string,token:string) {const items:unknown[]=[];let pageToken:string|null=null;const seen=new Set<string>();do{const url=new URL(GOOGLE+path);if(pageToken)url.searchParams.set("pageToken",pageToken);const data=await request(url.href,token);if(data.items!==undefined && !Array.isArray(data.items))throw new PublicError("Calendar returned an unexpected response. Nothing was replaced.",502);items.push(...(data.items||[]));pageToken=data.nextPageToken||null;if(pageToken&&(seen.has(pageToken)||seen.size>300))throw new PublicError("Calendar pagination did not finish. Nothing was replaced.",502);if(pageToken)seen.add(pageToken);}while(pageToken);return items;}
  async function googleToken(state:SecretState) {
    if(!state.googleClient || !state.googleTokens)throw new PublicError("Connect your personal Google account first.");
    if(state.googleTokens.expiresAt>Date.now()+60000)return state.googleTokens.accessToken;
    const response=await remoteFetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:state.googleTokens.refreshToken,...state.googleClient}),signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new PublicError("Google authorization expired or was revoked. Reconnect Google Calendar.",401);
    const token=tokenSchema.parse(await response.json());state.googleTokens={accessToken:token.access_token,refreshToken:token.refresh_token||state.googleTokens.refreshToken,expiresAt:Date.now()+token.expires_in*1000};return token.access_token;
  }
  async function personalGoogle(token:string):Promise<Source> {
    const calendar=await request(`${GOOGLE}/users/me/calendarList/primary`,token);
    if(calendar.id!==PERSONAL_CALENDAR || calendar.accessRole!=="owner")throw new PublicError(`Sign in as ${PERSONAL_CALENDAR}, which owns the personal calendar. The work account's shared access is not enough.`);
    return googleSources([calendar])[0];
  }
  async function personalTodoist(token:string) {const sources=todoistSources(await todoistPages("/projects",token));const allowed=personalProjects(sources);if(!allowed.length)throw new PublicError("No Personal project was found in this Todoist account. Create it in Todoist or connect the account that contains it. Artek and Inbox will not be used.");return allowed;}
  async function syncState(state:SecretState,date:string,timeZone:string) {
    const fromDate=new Date(`${date}T12:00:00Z`);fromDate.setUTCDate(fromDate.getUTCDate()-7);
    const toDate=new Date(`${date}T12:00:00Z`);toDate.setUTCDate(toDate.getUTCDate()+35);
    const from=fromDate.toISOString().slice(0,10);const to=toDate.toISOString().slice(0,10);
    if(state.todoistToken)try{
      const sources=await personalTodoist(state.todoistToken);const allowed=new Set(sources.map(source=>source.id));state.view.tasks=state.view.tasks.filter(task=>allowed.has(task.sourceId));state.view.todoist.sources=sources;state.view.todoist.selected=sources.map(source=>({id:source.id,area:source.area}));const tasks:RemoteTask[]=[];
      for(const source of sources){const raw=await todoistPages(`/tasks?project_id=${encodeURIComponent(source.id)}`,state.todoistToken);for(const row of raw){const task=normalizeTask(row,source,timeZone);if(task)tasks.push(task);}}
      state.view.tasks=tasks;state.view.todoist={connected:true,configured:true,sources,selected:sources.map(s=>({id:s.id,area:s.area})),lastSynced:new Date().toISOString(),error:null};
    }catch(err){if(err instanceof PublicError && err.message.startsWith("No Personal project")){state.view.tasks=[];state.view.todoist.sources=[];state.view.todoist.selected=[];}state.view.todoist.error=cleanError(err);}
    if(state.googleTokens)try{
      const token=await googleToken(state);const source=await personalGoogle(token);
      // Extra UTC margin covers all IANA offsets; display filtering uses local date parts.
      const params=new URLSearchParams({timeMin:`${from}T00:00:00Z`,timeMax:`${to}T23:59:59Z`,singleEvents:"true",orderBy:"startTime",timeZone,maxResults:"2500"});
      const raw=await googlePages(`/calendars/${encodeURIComponent(PERSONAL_CALENDAR)}/events?${params}`,token);
      const events=raw.map(event=>normalizeEvent(event,source,timeZone)).filter((e):e is RemoteEvent=>e!==null);
      state.view.events=events;state.view.range={from,to,timeZone};state.view.google={connected:true,configured:true,sources:[source],selected:[{id:source.id,area:source.area}],lastSynced:new Date().toISOString(),error:null};
    }catch(err){state.view.google.error=cleanError(err);}
    return state.view;
  }
  async function todoistCommand(token:string,command:object,uuid:string) {
    const result=await request(`${TODOIST}/sync`,token,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({commands:JSON.stringify([command])})});
    if(result.sync_status?.[uuid]!=="ok")throw new PublicError("Todoist did not apply this change. Refresh and review the task before trying again.",409);
    return result;
  }
  async function mutate(state:SecretState,input:Mutation) {
    const hash=createHash("sha256").update(JSON.stringify(input)).digest("hex");
    if(state.requests[input.requestId] && state.requests[input.requestId]!==hash)throw new PublicError("This request was already used for a different edit. Close the editor and start a fresh edit.",409);
    if(state.receipts[input.requestId])return;
    state.requests[input.requestId]=hash;await write(state);
    syncRequestSchema.parse({date:input.date || new Date().toISOString().slice(0,10),timeZone:input.timeZone});
    if(input.provider==="todoist"){
      const token=state.todoistToken;if(!token)throw new PublicError("Connect Todoist first.");
      const sources=await personalTodoist(token);let task:RemoteTask|null=null;
      if(input.action!=="create"){
        if(!input.id || !input.version)throw new PublicError("Refresh this task before editing it.");
        const raw=await request(`${TODOIST}/tasks/${encodeURIComponent(input.id)}`,token);const source=sources.find(s=>s.id===raw.project_id);if(!source)throw new PublicError("This task is outside the Personal project.",403);
        task=normalizeTask(raw,source,input.timeZone);if(!task || task.version!==input.version)throw new PublicError("This task changed in Todoist. Close this editor, sync, and review the latest version before editing again.",409);
      }
      if(input.action==="create"){
        const source=sources.find(s=>s.id===input.sourceId)||sources.find(s=>/^personal$/i.test(s.name.trim()));if(!source || (input.sourceId && input.sourceId!==source.id))throw new PublicError("Choose a project inside Personal.");
        if(!input.title)throw new PublicError("A task title is required.");
        const result=await todoistCommand(token,{type:"item_add",uuid:input.requestId,temp_id:input.requestId,args:{content:input.title,project_id:source.id,...(input.date?{due:{date:input.date}}:{})}},input.requestId);
        state.receipts[input.requestId]={provider:"todoist",id:result.temp_id_mapping?.[input.requestId]};
      } else if(input.action==="complete"){
        await request(`${TODOIST}/tasks/${encodeURIComponent(input.id!)}/close`,token,{method:"POST"});state.receipts[input.requestId]={provider:"todoist",id:input.id};
      } else if(input.action==="delete"){
        const projectTasks=await todoistPages(`/tasks?project_id=${encodeURIComponent(task!.sourceId)}`,token);
        if(projectTasks.some(raw=>(raw as {parent_id?:string}).parent_id===input.id))throw new PublicError("This task has subtasks. Delete it in Todoist so you can review the whole group.");
        await request(`${TODOIST}/tasks/${encodeURIComponent(input.id!)}`,token,{method:"DELETE"});state.receipts[input.requestId]={provider:"todoist",id:input.id};
      } else {
        if(!input.title)throw new PublicError("A task title is required.");
        const changeDate=input.date!==undefined && input.date!==task!.dueDate;
        if(changeDate && (task!.recurring || task!.dueTime))throw new PublicError("Change recurring or timed due dates in Todoist to preserve their scheduling details. Title edits are supported here.");
        await todoistCommand(token,{type:"item_update",uuid:input.requestId,args:{id:input.id,content:input.title,...(changeDate?{due:input.date?{date:input.date}:null}:{})}},input.requestId);state.receipts[input.requestId]={provider:"todoist",id:input.id};
      }
      if(input.action==="delete" || input.action==="complete")state.view.tasks=state.view.tasks.filter(t=>t.id!==input.id);
      else if(input.action==="update")state.view.tasks=state.view.tasks.map(t=>t.id===input.id?{...t,title:input.title!,dueDate:input.date===undefined?t.dueDate:input.date}:t);
      else {const createdId=state.receipts[input.requestId]?.id;const source=sources.find(s=>s.id===input.sourceId)||sources.find(s=>/^personal$/i.test(s.name.trim()));if(createdId&&source){const created=normalizeTask({id:createdId,project_id:source.id,content:input.title,due:input.date?{date:input.date}:null},source,input.timeZone);if(created)state.view.tasks=[...state.view.tasks.filter(t=>t.id!==createdId),created];}}
    }else{
      const token=await googleToken(state);const source=await personalGoogle(token);
      if(input.action==="complete")throw new PublicError("Calendar events are not tasks.");
      let event:RemoteEvent|null=null;
      if(input.action!=="create"){
        if(!input.id||!input.version)throw new PublicError("Refresh this event before editing it.");
        const raw=await request(`${GOOGLE}/calendars/${encodeURIComponent(PERSONAL_CALENDAR)}/events/${encodeURIComponent(input.id)}`,token);event=normalizeEvent(raw,source,input.timeZone);
        if(!event || event.version!==input.version)throw new PublicError("This event changed in Google Calendar. Close this editor, sync, and review the latest version before editing again.",409);
        if(!event.editable)throw new PublicError("Edit meetings with guests and special calendar events in Google Calendar.");
      }
      const base=`${GOOGLE}/calendars/${encodeURIComponent(PERSONAL_CALENDAR)}/events`;
      const headers=input.version?{"If-Match":input.version}:undefined;
      if(input.action==="delete"){
        if(event!.recurring)await request(`${base}/${encodeURIComponent(input.id!)}?sendUpdates=none`,token,{method:"PATCH",headers,body:JSON.stringify({status:"cancelled"})});
        else await request(`${base}/${encodeURIComponent(input.id!)}?sendUpdates=none`,token,{method:"DELETE",headers});
      }else{
        if(!input.title || !input.date || !input.endDate)throw new PublicError("A title, start date, and end date are required.");
        const allDay=!!input.allDay;let start:object;let end:object;
        if(allDay){if(input.endDate<=input.date)throw new PublicError("The end date is exclusive and must follow the start date.");start={date:input.date,...(event&&!event.allDay?{dateTime:null,timeZone:null}:{})};end={date:input.endDate,...(event&&!event.allDay?{dateTime:null,timeZone:null}:{})};}
        else {if(!input.time||!input.endTime || `${input.endDate}T${input.endTime}`<=`${input.date}T${input.time}`)throw new PublicError("End time must be after start time.");start={dateTime:`${input.date}T${input.time}:00`,timeZone:input.timeZone,...(event?.allDay?{date:null}:{})};end={dateTime:`${input.endDate}T${input.endTime}:00`,timeZone:input.timeZone,...(event?.allDay?{date:null}:{})};}
        const startChanged=!event||event.startDate!==input.date||event.allDay!==allDay||(!allDay&&event.startTime!==input.time);
        const endChanged=!event||event.endDate!==input.endDate||event.allDay!==allDay||(!allDay&&event.endTime!==input.endTime);
        const body={summary:input.title,...(startChanged?{start}:{}),...(endChanged?{end}:{}),...(input.action==="create"?{id:input.requestId.replaceAll("-","")}:{})};
        if(input.action==="create"){
          try{const existing=await request(`${base}/${input.requestId.replaceAll("-","")}`,token);const normalized=normalizeEvent(existing,source,input.timeZone);state.receipts[input.requestId]={provider:"google",id:existing.id};if(normalized)state.view.events=[...state.view.events.filter(e=>e.id!==existing.id),normalized];return;}catch(err){if(!(err instanceof PublicError) || err.status!==409)throw err;}
        }
        const result=await request(input.action==="create"?`${base}?sendUpdates=none`:`${base}/${encodeURIComponent(input.id!)}?sendUpdates=none`,token,{method:input.action==="create"?"POST":"PATCH",headers,body:JSON.stringify(body)});
        state.receipts[input.requestId]={provider:"google",id:result.id};
        const savedEvent=normalizeEvent(result,source,input.timeZone);if(savedEvent)state.view.events=[...state.view.events.filter(e=>e.id!==result.id),savedEvent];
      }
      state.receipts[input.requestId]??={provider:"google",id:input.id};if(input.action==="delete")state.view.events=state.view.events.filter(e=>e.id!==input.id);
    }
    const receiptKeys=Object.keys(state.receipts);for(const key of receiptKeys.slice(0,-1000)){delete state.receipts[key];delete state.requests[key];}
  }
  async function handle(req:IncomingMessage,res:ServerResponse) {
    const host=req.headers.host||"";const url=new URL(req.url||"/",`http://${host||"localhost"}`);const path=url.pathname.replace(/^\/api\/integrations/,"") || "/";
    const send=(code:number,value:unknown)=>{res.statusCode=code;res.setHeader("Content-Type","application/json");res.setHeader("Cache-Control","no-store");res.end(JSON.stringify(value));};
    if(!/^(localhost|127\.0\.0\.1):\d+$/.test(host))return send(403,{error:"Only the local workspace can access connections."});
    if(path==="/google/callback" && req.method==="GET") {
      const stateKey=url.searchParams.get("state")||"";const flow=pending.get(stateKey);pending.delete(stateKey);
      if(!flow || flow.expires<Date.now())return send(400,{error:"This Google connection request expired. Start again from Connections."});
      if(url.searchParams.has("error"))return send(400,{error:"Google connection was cancelled. You can return to your workspace."});
      try {await exclusive(async()=>{const state=await read();if(!state.googleClient)throw new PublicError("Configure the Google client first.");const response=await remoteFetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"authorization_code",code:url.searchParams.get("code")||"",code_verifier:flow.verifier,redirect_uri:flow.redirectUri,...state.googleClient}),signal:AbortSignal.timeout(20000)});if(!response.ok)throw new PublicError("Google did not complete authorization. Try connecting again.");const token=tokenSchema.parse(await response.json());if(!SCOPES.every(scope=>token.scope?.split(" ").includes(scope)))throw new PublicError("Google did not grant the requested Calendar permissions.");await personalGoogle(token.access_token);if(!token.refresh_token)throw new PublicError("Google did not return offline access. Remove this app's old Google grant and reconnect.");state.googleTokens={accessToken:token.access_token,refreshToken:token.refresh_token,expiresAt:Date.now()+token.expires_in*1000};state.view.google.connected=true;state.view.google.configured=true;state.view.google.error=null;await write(state);});res.statusCode=302;res.setHeader("Location","/?connected=google");res.setHeader("Referrer-Policy","no-referrer");res.end();}catch(err){send(err instanceof PublicError?err.status:500,{error:cleanError(err)});}return;
    }
    if((req.headers.origin && req.headers.origin!==`http://${host}`) || req.headers["sec-fetch-site"]==="cross-site")return send(403,{error:"Open Connections from the local workspace."});
    if(req.method==="GET" && path==="/"){try{const state=await read();send(200,state.view);}catch(err){send(500,{error:cleanError(err)});}return;}
    if(req.method!=="POST")return send(405,{error:"Method not allowed"});
    if(!req.headers["content-type"]?.startsWith("application/json"))return send(415,{error:"JSON is required"});
    try{
      const chunks:Buffer[]=[];let size=0;for await(const raw of req){const chunk=Buffer.from(raw);size+=chunk.length;if(size>64000)throw new PublicError("This request is too large.",413);chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString("utf8")||"{}");
      const result=await exclusive(async()=>{
        const state=await read();
        if(path==="/todoist/connect"){
          const token=z.string().trim().min(20).max(500).parse(body.token);
          const sources=await personalTodoist(token);state.todoistToken=token;state.view.todoist={connected:true,configured:true,sources,selected:sources.map(s=>({id:s.id,area:s.area})),lastSynced:null,error:null};state.view.tasks=[];await write(state);return state.view;
        }
        if(path==="/google/configure"){
          if(body && typeof body==="object" && "web" in body)throw new PublicError("This file is for a Web application client. Create an OAuth client with application type Desktop app in your personal Google Cloud project, then upload its JSON file. Your previously saved client has not been replaced.");
          const parsed=clientSchema.safeParse(body);
          if(!parsed.success)throw new PublicError("Choose the downloaded JSON file for a Google Desktop app OAuth client. This file was not saved; any previous client is still configured.");
          const client=parsed.data.installed;state.googleClient=client;delete state.googleTokens;state.view.google={...emptySync().google,configured:true};state.view.events=[];await write(state);pending.clear();return state.view;
        }
        if(path==="/google/start"){
          if(!state.googleClient)throw new PublicError("Choose your Google Desktop OAuth client file first.");
          const stateKey=randomBytes(32).toString("base64url");const verifier=randomBytes(32).toString("base64url");const redirectUri=`http://127.0.0.1:${host.split(":")[1]}/api/integrations/google/callback`;
          for(const [key,flow] of pending)if(flow.expires<Date.now())pending.delete(key);
          pending.set(stateKey,{verifier,redirectUri,expires:Date.now()+600000});
          const query=new URLSearchParams({client_id:state.googleClient.client_id,redirect_uri:redirectUri,response_type:"code",scope:SCOPES.join(" "),state:stateKey,code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256",access_type:"offline",prompt:"consent",login_hint:PERSONAL_CALENDAR});
          const authUrl=`https://accounts.google.com/o/oauth2/v2/auth?${query}`;
          if(process.platform==="darwin" && remoteFetch===fetch)execFile("/usr/bin/open",[authUrl],()=>{});
          return {url:authUrl};
        }
        if(path==="/disconnect"){
          const provider=z.enum(["todoist","google"]).parse(body.provider);
          if(provider==="todoist"){delete state.todoistToken;state.view.todoist=emptySync().todoist;state.view.tasks=[];}else{delete state.googleTokens;delete state.googleClient;state.view.google=emptySync().google;state.view.events=[];state.view.range=null;pending.clear();}
          await write(state);return state.view;
        }
        if(path==="/sync"){
          const input=syncRequestSchema.parse(body);await syncState(state,input.date,input.timeZone);await write(state);return state.view;
        }
        if(path==="/mutate"){
          const input=mutationSchema.parse(body);await mutate(state,input);await write(state);await syncState(state,input.anchorDate||input.date||new Date().toISOString().slice(0,10),input.timeZone);await write(state);return state.view;
        }
        throw new PublicError("Unknown connection action.",404);
      });send(200,result);
    }catch(err){send(err instanceof PublicError?err.status:err instanceof z.ZodError?400:500,{error:err instanceof z.ZodError?"Check the connection file, dates, and required fields.":cleanError(err)});}
  }
  return {handle};
}
export function integrations():Plugin {const service=createIntegrationService(process.env.WORKSPACE_DATA_DIR||join(homedir(),"Data","personal-workspace"));return {name:"workspace-integrations",configureServer(server){server.middlewares.use("/api/integrations",service.handle);}};}

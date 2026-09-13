import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash, createHmac, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { z } from "zod";
import { daySchema, workspaceSchema } from "../lib/workspace.ts";
import { emptySync, googleSources, todoistSources, personalProjects, normalizeTask, normalizeEvent, integrationRelationSchema, integrationRelationTargetSchema, integrationRelationsSchema, integrationLinksSchema, gmailRelationsSchema, workspaceRelationRequestSchema, syncRequestSchema, PERSONAL_CALENDAR, type IntegrationRelation, type SyncView, type Source, type RemoteTask, type RemoteEvent, type RemoteMail } from "../lib/integrations/model.ts";
import { StoreBusyError, withPrivateLock, writePrivateJson } from "./private-store.ts";

const TODOIST = "https://api.todoist.com/api/v1";
const GOOGLE = "https://www.googleapis.com/calendar/v3";
const GMAIL = "https://gmail.googleapis.com/gmail/v1";
const SCOPES = ["https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events.owned"];
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const BENIGN_GOOGLE_SCOPES = new Set(["openid","email","profile","https://www.googleapis.com/auth/userinfo.email","https://www.googleapis.com/auth/userinfo.profile"]);
const tokenSchema=z.object({access_token:z.string().min(1),refresh_token:z.string().optional(),expires_in:z.number().positive(),scope:z.string().optional()});
const clientSchema=z.object({installed:z.object({client_id:z.string().endsWith(".apps.googleusercontent.com"),client_secret:z.string().min(1)})});
const timeSchema=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const linkRequestSchema=integrationRelationTargetSchema;
const mutationSchema=z.object({provider:z.enum(["todoist","google"]),action:z.enum(["create","update","delete","complete"]),id:z.string().max(500).optional(),version:z.string().max(10000).optional(),requestId:z.string().uuid(),sourceId:z.string().max(500).optional(),anchorDate:daySchema.optional(),title:z.string().trim().min(1).max(2000).optional(),date:daySchema.nullable().optional(),endDate:daySchema.optional(),time:timeSchema.nullable().optional(),endTime:timeSchema.nullable().optional(),allDay:z.boolean().optional(),location:z.string().trim().max(1000).optional(),link:linkRequestSchema.optional(),timeZone:z.string().max(100)}).strict().superRefine((input,ctx)=>{
  if(input.link && input.action!=="create")ctx.addIssue({code:"custom",path:["link"],message:"Integration links can be added only while creating an item."});
  if(input.link){
    const todoistRelation=(input.link.entityKind==="goal"&&input.link.role==="goal-next-step")||(input.link.entityKind==="gmail-message"&&input.link.role==="follow-up-task");
    const calendarRelation=(input.link.entityKind==="plan"&&input.link.role==="scheduled-session")||(input.link.entityKind==="gmail-message"&&input.link.role==="time-block");
    if((input.provider==="todoist")!==todoistRelation||(input.provider==="google")!==calendarRelation)ctx.addIssue({code:"custom",path:["link"],message:"Choose the provider and role that match this linked Workspace item."});
  }
  if(input.location!==undefined&&(input.provider!=="google"||!["create","update"].includes(input.action)))ctx.addIssue({code:"custom",path:["location"],message:"A location can be saved only on a Google Calendar event."});
});
type Mutation=z.infer<typeof mutationSchema>;
const gmailMutationSchema=z.object({id:z.string().min(1).max(500),version:z.string().min(1).max(10000),action:z.enum(["read","unread","star","unstar","archive","trash"]),requestId:z.string().uuid(),confirm:z.literal(true).optional()}).strict().superRefine((input,ctx)=>{if(input.action==="trash"&&input.confirm!==true)ctx.addIssue({code:"custom",path:["confirm"],message:"Confirm before moving this message to Trash."});});
const artekDomain=(value:string)=>{const domain=value.toLowerCase().split("@").at(-1)||"";return domain==="artek.energy"||domain.endsWith(".artek.energy");};
const emailAddressSchema=z.string().trim().min(3).max(320).email().refine(value=>!/[\r\n]/.test(value),"Invalid email address").transform(value=>value.toLowerCase()).refine(value=>!artekDomain(value),"Artek email addresses are outside this workspace.");
const emailListSchema=z.array(emailAddressSchema).max(20);
const gmailSendSchema=z.object({requestId:z.string().uuid(),confirm:z.literal(true),to:emailListSchema.min(1),cc:emailListSchema.optional().default([]),bcc:emailListSchema.optional().default([]),subject:z.string().trim().min(1).max(998).refine(value=>!/[\r\n]/.test(value),"Subject cannot contain line breaks."),body:z.string().max(50000),replyToId:z.string().min(1).max(500).optional()}).strict().superRefine((input,ctx)=>{const recipients=[...input.to,...input.cc,...input.bcc];if(recipients.length>32)ctx.addIssue({code:"custom",path:["to"],message:"A message can have at most 32 recipients."});if(new Set(recipients).size!==recipients.length)ctx.addIssue({code:"custom",path:["to"],message:"List each recipient only once."});});
const gmailSyncSchema=z.union([z.object({}).strict(),syncRequestSchema]);
const todoistSyncSchema=syncRequestSchema.pick({timeZone:true});
const gmailHeaderSchema=z.object({name:z.string().max(100),value:z.string().max(10000)}).passthrough();
const gmailMessageSchema=z.object({id:z.string().min(1).max(500),threadId:z.string().min(1).max(500),labelIds:z.array(z.string().max(500)).max(200).optional().default([]),snippet:z.string().max(10000).optional().default(""),historyId:z.string().max(1000).optional().default(""),internalDate:z.string().max(30).optional(),payload:z.object({headers:z.array(gmailHeaderSchema).max(200).optional().default([])}).passthrough().optional()}).passthrough();
type GmailMutation=z.infer<typeof gmailMutationSchema>;
type GmailSend=z.infer<typeof gmailSendSchema>;
type StoredTokens={accessToken:string;refreshToken:string;expiresAt:number};
const storedTokensSchema=z.object({accessToken:z.string().min(1).max(10000),refreshToken:z.string().min(1).max(10000),expiresAt:z.number().finite()}).strict();
const storedClientSchema=z.object({client_id:z.string().endsWith(".apps.googleusercontent.com"),client_secret:z.string().min(1).max(10000)}).strict();
const gmailBindingKeySchema=z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine(value=>{const decoded=Buffer.from(value,"base64url");return decoded.length===32&&decoded.toString("base64url")===value;});
const cachedGmailSchema=z.object({sources:z.array(z.object({id:z.string().max(500),name:z.string().max(1000),area:z.enum(["personal","independent"]),blocked:z.boolean(),parentId:z.string().max(500).optional()}).strict()).max(10).optional(),selected:z.array(z.object({id:z.string().max(500),area:z.enum(["personal","independent"])}).strict()).max(10).optional(),lastSynced:z.string().datetime({offset:true}).nullable().optional(),error:z.string().max(2000).nullable().optional()}).passthrough();
const cachedMailSchema=z.object({id:z.string().min(1).max(500),threadId:z.string().min(1).max(500),from:z.string().max(500),replyTo:z.union([z.literal(""),z.string().email().max(320)]),subject:z.string().max(998),snippet:z.string().max(1000),receivedAt:z.string().datetime({offset:true}),unread:z.boolean(),starred:z.boolean(),important:z.boolean(),version:z.string().regex(/^[a-f0-9]{64}$/),url:z.string().url().refine(value=>{const parsed=new URL(value);return parsed.protocol==="https:"&&parsed.hostname==="mail.google.com";})}).strict();
type SecretState={version:1;storeRevision:number;view:SyncView;relations:IntegrationRelation[];calendarAnchor?:string;todoistToken?:string;googleClient?:{client_id:string;client_secret:string};googleTokens?:StoredTokens;gmailTokens?:StoredTokens;gmailBindingKey?:string;receipts:Record<string,{provider:string;id?:string}>;requests:Record<string,string>;detachedRequests:string[]};
class PublicError extends Error { readonly status:number; constructor(message:string,status=400){super(message);this.status=status;} }
class MissingRemoteError extends PublicError { constructor(){super("This item is no longer available. Refresh your workspace.",409);} }
class UncertainRemoteError extends PublicError { constructor(){super("The service did not confirm this request. Refresh before retrying a change.",502);} }
const cleanError=(err:unknown)=>err instanceof PublicError||err instanceof StoreBusyError?err.message:"The service could not be reached. Your last successful sync is still available. Try again.";
const responseError=(response:Response)=>{if(response.status===412)return new PublicError("This event changed in Google Calendar. Close this editor, sync, and review the latest version before editing again.",409);if([401,403].includes(response.status))return new PublicError("This connection needs permission to read and edit the selected personal source. Reconnect the correct account.",401);if(response.status===429)return new PublicError("The service is limiting requests. Wait a moment before syncing again.",429);if(response.status===404)return new MissingRemoteError();return new PublicError(`The service rejected this request (${response.status}). Your draft has been kept.`,502);};
function requireExactGoogleScopes(granted:string|undefined,required:readonly string[],provider:"google"|"gmail") {
  const scopes=new Set((granted||"").split(/\s+/).filter(Boolean));const missing=required.some(scope=>!scopes.has(scope));const unexpected=[...scopes].some(scope=>!required.includes(scope)&&!BENIGN_GOOGLE_SCOPES.has(scope));
  if(missing||unexpected)throw new PublicError(`${provider==="gmail"?"Gmail":"Google"} did not grant exactly the requested ${provider==="gmail"?"mail":"Calendar"} permissions.`);
}

export function createIntegrationService(directory:string, remoteFetch:typeof fetch=fetch) {
  const file=join(directory,"integrations.private.json");
  const pending=new Map<string,{provider:"google"|"gmail";verifier:string;redirectUri:string;expires:number}>();
  type Provider="todoist"|"google"|"gmail";
  const providerQueues:Record<Provider,Promise<unknown>>={todoist:Promise.resolve(),google:Promise.resolve(),gmail:Promise.resolve()};
  let stateQueue:Promise<unknown>=Promise.resolve();
  function publishRelations(state:SecretState) {
    state.view.links=integrationLinksSchema.parse(state.relations.filter(relation=>relation.entityKind==="goal"||relation.entityKind==="plan"));
    state.view.gmail.relations=gmailRelationsSchema.parse(state.relations.filter(relation=>relation.entityKind==="gmail-message"));
    state.view.workspaceRelations=state.relations.filter(relation=>relation.entityKind==="capture");
  }
  async function pruneWorkspaceRelations(state:SecretState) {
    if(!state.relations.some(relation=>relation.entityKind==="capture"))return;
    try{const workspace=workspaceSchema.parse(JSON.parse(await readFile(join(directory,"workspace.json"),"utf8")));const notes=new Set(workspace.items.filter(item=>item.kind==="note").map(item=>item.id));const priorities=new Set(workspace.items.filter(item=>item.kind==="priority").map(item=>item.id));state.relations=state.relations.filter(relation=>relation.entityKind!=="capture"||(notes.has(relation.entityId)&&priorities.has(relation.targetId)));}catch{}
  }
  async function read(prune=true):Promise<SecretState> {try {const data=JSON.parse(await readFile(file,"utf8")); if(data.version!==1 || !data.view || !data.receipts) throw new Error("Invalid integration data");data.storeRevision=z.number().int().nonnegative().parse(data.storeRevision??0);if(data.googleClient!==undefined)data.googleClient=storedClientSchema.parse(data.googleClient);if(data.googleTokens!==undefined)data.googleTokens=storedTokensSchema.parse(data.googleTokens);if(data.gmailTokens!==undefined)data.gmailTokens=storedTokensSchema.parse(data.gmailTokens);if(data.gmailBindingKey!==undefined)data.gmailBindingKey=gmailBindingKeySchema.parse(data.gmailBindingKey);if(data.calendarAnchor!==undefined)data.calendarAnchor=daySchema.parse(data.calendarAnchor);data.requests ??= {};data.detachedRequests=z.array(z.string().uuid()).max(10000).parse(data.detachedRequests??[]);const legacyLinks=integrationLinksSchema.parse(data.view.links??[]);const cachedGmail=cachedGmailSchema.parse(data.view.gmail??{});const cachedGmailRelations=gmailRelationsSchema.parse((cachedGmail as {relations?:unknown}).relations??[]);data.relations=integrationRelationsSchema.parse(data.relations??[...legacyLinks,...cachedGmailRelations,...(data.view.workspaceRelations??[])]);const gmailConnected=!!data.googleClient&&!!data.gmailTokens;data.view.gmail={...emptySync().gmail,...cachedGmail,configured:!!data.googleClient,connected:gmailConnected,account:gmailConnected?PERSONAL_CALENDAR:null,unreadCount:0,relations:[]};data.view.messages=gmailConnected?z.array(cachedMailSchema).max(40).parse(data.view.messages??[]):[];data.view.gmail.unreadCount=data.view.messages.filter((message:RemoteMail)=>message.unread).length;if(prune)await pruneWorkspaceRelations(data);publishRelations(data);return data;} catch(err){if((err as NodeJS.ErrnoException).code==="ENOENT")return {version:1,storeRevision:0,view:emptySync(),relations:[],receipts:{},requests:{},detachedRequests:[]};throw new PublicError("Connection data could not be read. It has been left untouched.",500);} }
  const write=async(state:SecretState)=>{await pruneWorkspaceRelations(state);publishRelations(state);return writePrivateJson(file,state);};
  const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);
  const changedValue=<T>(base:T,staged:T,latest:T,label:string):T=>{
    if(same(staged,base))return structuredClone(latest);
    if(same(latest,base)||same(latest,staged))return structuredClone(staged);
    throw new PublicError(`${label} changed while this request was running. Refresh and try again.`,409);
  };
  const mergeRecord=<T>(base:Record<string,T>,staged:Record<string,T>,latest:Record<string,T>,label:string)=>{
    const next:Record<string,T>={...latest};
    for(const key of new Set([...Object.keys(base),...Object.keys(staged)])){
      const baseHas=Object.hasOwn(base,key);const stagedHas=Object.hasOwn(staged,key);const latestHas=Object.hasOwn(latest,key);
      if(baseHas===stagedHas&&same(base[key],staged[key]))continue;
      if(latestHas!==baseHas||!same(latest[key],base[key])){if(latestHas===stagedHas&&same(latest[key],staged[key]))continue;throw new PublicError(`${label} changed while this request was running. Refresh and try again.`,409);}
      if(stagedHas)next[key]=structuredClone(staged[key]);else delete next[key];
    }
    return next;
  };
  const mergeRelations=(base:IntegrationRelation[],staged:IntegrationRelation[],latest:IntegrationRelation[])=>{
    const keyed=(relations:IntegrationRelation[])=>Object.fromEntries(relations.map(relation=>[relation.id,relation]));
    return integrationRelationsSchema.parse(Object.values(mergeRecord(keyed(base),keyed(staged),keyed(latest),"Connection links")));
  };
  function mergeView(base:SyncView,staged:SyncView,latest:SyncView):SyncView {
    const next=structuredClone(latest);
    for(const key of ["todoist","google","tasks","events","messages","range"] as const)next[key]=changedValue(base[key],staged[key],latest[key],"Connection data") as never;
    const gmail=structuredClone(latest.gmail);for(const key of ["connected","configured","sources","selected","account","unreadCount","lastSynced","error"] as const)gmail[key]=changedValue(base.gmail[key],staged.gmail[key],latest.gmail[key],"Gmail data") as never;next.gmail=gmail;
    return next;
  }
  function mergeState(base:SecretState,staged:SecretState,latest:SecretState):SecretState {
    if(latest.storeRevision===base.storeRevision)return structuredClone(staged);
    const next=structuredClone(latest);const optionalKeys=["calendarAnchor","todoistToken","googleClient","googleTokens","gmailTokens","gmailBindingKey"] as const;
    for(const key of optionalKeys){const value=changedValue(base[key],staged[key],latest[key],"Connection settings");if(value===undefined)delete next[key];else (next as unknown as Record<string,unknown>)[key]=value;}
    next.view=mergeView(base.view,staged.view,latest.view);next.relations=mergeRelations(base.relations,staged.relations,latest.relations);next.receipts=mergeRecord(base.receipts,staged.receipts,latest.receipts,"Request receipts");next.requests=mergeRecord(base.requests,staged.requests,latest.requests,"Request history");
    const removed=new Set(base.detachedRequests.filter(id=>!staged.detachedRequests.includes(id)));next.detachedRequests=latest.detachedRequests.filter(id=>!removed.has(id));for(const id of staged.detachedRequests)if(!base.detachedRequests.includes(id)&&!next.detachedRequests.includes(id))next.detachedRequests.push(id);next.detachedRequests=next.detachedRequests.slice(-10000);
    return next;
  }
  const stateExclusive=<T>(action:()=>Promise<T>):Promise<T>=>{const next=stateQueue.catch(()=>{}).then(()=>withPrivateLock(file,action));stateQueue=next;return next;};
  const snapshot=(prune=true)=>stateExclusive(()=>read(prune));
  const atomicUpdate=<T>(action:(state:SecretState)=>Promise<T>,prune=true)=>stateExclusive(async()=>{const state=await read(prune);const result=await action(state);state.storeRevision++;await write(state);return result;});
  const commit=async(base:SecretState,staged:SecretState)=>stateExclusive(async()=>{const latest=await read();const next=mergeState(base,staged,latest);next.storeRevision=latest.storeRevision+1;await write(next);return next;});
  const providerExclusive=<T>(providers:Provider|Provider[],action:()=>Promise<T>):Promise<T>=>{
    const ordered=[...new Set(Array.isArray(providers)?providers:[providers])].sort() as Provider[];const waits=ordered.map(provider=>providerQueues[provider].catch(()=>{}));
    const withLocks=(index:number):Promise<T>=>index===ordered.length?action():withPrivateLock(`${file}.${ordered[index]}`,()=>withLocks(index+1));
    const next=Promise.all(waits).then(()=>withLocks(0));for(const provider of ordered)providerQueues[provider]=next;return next;
  };
  const providerState=<T>(provider:Provider,action:(state:SecretState,save:()=>Promise<void>)=>Promise<T>,prune=true)=>providerExclusive(provider,async()=>{
    let base=await snapshot(prune);const state=structuredClone(base);const save=async()=>{const saved=await commit(base,state);for(const key of Object.keys(state))delete (state as unknown as Record<string,unknown>)[key];Object.assign(state,structuredClone(saved));base=structuredClone(saved);};return action(state,save);
  });
  async function request(url:string,token:string,options:RequestInit={}) {
    let response:Response;
    const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000);
    try{response=await remoteFetch(url,{...options,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",...options.headers},signal});}catch{throw new UncertainRemoteError();}
    if(!response.ok)throw responseError(response);
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
  async function gmailToken(state:SecretState,deadline?:AbortSignal) {
    if(!state.googleClient || !state.gmailTokens)throw new PublicError("Connect your personal Gmail account first.");
    if(state.gmailTokens.expiresAt>Date.now()+60000)return state.gmailTokens.accessToken;
    const response=await remoteFetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:state.gmailTokens.refreshToken,...state.googleClient}),signal:deadline?AbortSignal.any([deadline,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});
    if(!response.ok)throw new PublicError("Gmail authorization expired or was revoked. Reconnect Gmail.",401);
    const token=tokenSchema.parse(await response.json());state.gmailTokens={accessToken:token.access_token,refreshToken:token.refresh_token||state.gmailTokens.refreshToken,expiresAt:Date.now()+token.expires_in*1000};return token.access_token;
  }
  async function personalGoogle(token:string):Promise<Source> {
    const calendar=await request(`${GOOGLE}/users/me/calendarList/primary`,token);
    if(calendar.id!==PERSONAL_CALENDAR || calendar.accessRole!=="owner")throw new PublicError(`Sign in as ${PERSONAL_CALENDAR}, which owns the personal calendar. The work account's shared access is not enough.`);
    return googleSources([calendar])[0];
  }
  async function personalGmail(token:string,deadline?:AbortSignal):Promise<Source> {
    const profile=z.object({emailAddress:z.string(),messagesTotal:z.number().optional(),threadsTotal:z.number().optional(),historyId:z.string().optional()}).passthrough().parse(await request(`${GMAIL}/users/me/profile`,token,{signal:deadline}));
    if(profile.emailAddress.toLowerCase()!==PERSONAL_CALENDAR)throw new PublicError(`Sign in as ${PERSONAL_CALENDAR}. The work account is outside this workspace.`);
    return {id:PERSONAL_CALENDAR,name:"Gmail",area:"personal",blocked:false};
  }
  async function personalTodoist(token:string) {const sources=todoistSources(await todoistPages("/projects",token));const allowed=personalProjects(sources);if(!allowed.length)throw new PublicError("No Personal project was found in this Todoist account. Create it in Todoist or connect the account that contains it. Artek and Inbox will not be used.");return allowed;}
  const headerValues=(headers:{name:string;value:string}[],name:string)=>headers.filter(header=>header.name.toLowerCase()===name.toLowerCase()).map(header=>header.value);
  const headerValue=(headers:{name:string;value:string}[],name:string)=>headerValues(headers,name)[0]||"";
  const cleanText=(value:string,max:number)=>value.replace(/[\u0000-\u001f\u007f]+/g," ").replace(/\s+/g," ").trim().slice(0,max);
  const addresses=(value:string)=>[...value.matchAll(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/gi)].map(match=>match[0].toLowerCase());
  const isArtekAddress=(value:string)=>addresses(value).some(artekDomain);
  const isArtekList=(value:string)=>addresses(value).some(artekDomain)||[...value.matchAll(/[A-Z0-9.-]+\.[A-Z]{2,}/gi)].some(match=>{const domain=match[0].toLowerCase();return domain==="artek.energy"||domain.endsWith(".artek.energy");});
  async function gmailLabels(token:string,deadline?:AbortSignal):Promise<Set<string>> {
    const data=z.object({labels:z.array(z.object({id:z.string().max(500),name:z.string().max(1000)}).passthrough()).max(10000).optional().default([])}).passthrough().parse(await request(`${GMAIL}/users/me/labels`,token,{signal:deadline}));
    return new Set(data.labels.filter(label=>label.name.split("/").some(segment=>/^artek$/i.test(segment.trim()))).map(label=>label.id));
  }
  function normalizeMail(raw:unknown,blockedLabels:Set<string>,requireInbox=true):RemoteMail|null {
    const message=gmailMessageSchema.parse(raw);const labels=new Set(message.labelIds);
    if(requireInbox&&!labels.has("INBOX"))return null;
    if(message.labelIds.some(label=>blockedLabels.has(label)))return null;
    const headers=message.payload?.headers||[];const structured=["from","sender","reply-to","to","cc","bcc","resent-from","resent-to","resent-cc","return-path"];
    if(structured.some(name=>headerValues(headers,name).some(isArtekAddress)))return null;
    if(headerValues(headers,"list-id").some(isArtekList))return null;
    const from=cleanText(headerValue(headers,"from")||"Unknown sender",500);
    const replyCandidate=addresses(headerValue(headers,"reply-to")||headerValue(headers,"from"))[0]||"";const parsedReply=emailAddressSchema.safeParse(replyCandidate);const replyTo=parsedReply.success?parsedReply.data:"";
    const subject=cleanText(headerValue(headers,"subject")||"(no subject)",998);
    const internal=Number(message.internalDate);const headerDate=Date.parse(headerValue(headers,"date"));const candidate=Number.isFinite(internal)&&internal>=0?internal:Number.isFinite(headerDate)?headerDate:0;const milliseconds=candidate<=8.64e15?candidate:0;
    const version=createHash("sha256").update(JSON.stringify([message.historyId,[...labels].sort()])).digest("hex");
    return {id:message.id,threadId:message.threadId,from,replyTo,subject,snippet:cleanText(message.snippet,1000),receivedAt:new Date(milliseconds).toISOString(),unread:labels.has("UNREAD"),starred:labels.has("STARRED"),important:labels.has("IMPORTANT"),version,url:`https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(message.threadId)}`};
  }
  async function gmailMessage(token:string,id:string,deadline?:AbortSignal) {
    const url=new URL(`${GMAIL}/users/me/messages/${encodeURIComponent(id)}`);url.searchParams.set("format","metadata");for(const name of ["From","Sender","Reply-To","To","Cc","Bcc","Resent-From","Resent-To","Resent-Cc","Return-Path","List-Id","Subject","Date","Message-ID","References","X-Workspace-Request-Binding"])url.searchParams.append("metadataHeaders",name);return request(url.href,token,{signal:deadline});
  }
  async function syncGmail(state:SecretState) {
    if(!state.gmailTokens)return state.view;
    try{
      const cancel=new AbortController();const deadline=AbortSignal.any([cancel.signal,AbortSignal.timeout(24000)]);const token=await gmailToken(state,deadline);const source=await personalGmail(token,deadline);const blockedLabels=await gmailLabels(token,deadline);
      const url=new URL(`${GMAIL}/users/me/messages`);url.searchParams.append("labelIds","INBOX");url.searchParams.set("maxResults","50");
      const data=z.object({messages:z.array(z.object({id:z.string().min(1).max(500),threadId:z.string().max(500).optional()}).passthrough()).max(500).optional().default([]),nextPageToken:z.string().max(2000).optional()}).passthrough().parse(await request(url.href,token,{signal:deadline}));
      const candidates=data.messages.slice(0,50);const normalized=new Array<RemoteMail|null>(candidates.length).fill(null);let cursor=0;
      const worker=async()=>{while(cursor<candidates.length){const index=cursor++;try{const raw=await gmailMessage(token,candidates[index].id,deadline);normalized[index]=normalizeMail(raw,blockedLabels);}catch(err){if(err instanceof MissingRemoteError)continue;cancel.abort();throw err;}}};
      const settled=await Promise.allSettled(Array.from({length:Math.min(6,candidates.length)},worker));const failed=settled.find((result):result is PromiseRejectedResult=>result.status==="rejected");if(failed)throw failed.reason;const messages=normalized.filter((message):message is RemoteMail=>message!==null).slice(0,40);
      state.view.messages=messages;state.view.gmail={...state.view.gmail,connected:true,configured:true,sources:[source],selected:[{id:source.id,area:source.area}],account:PERSONAL_CALENDAR,unreadCount:messages.filter(message=>message.unread).length,lastSynced:new Date().toISOString(),error:null};
    }catch(err){state.view.gmail.error=cleanError(err);}
    return state.view;
  }
  async function syncTodoist(state:SecretState,timeZone:string) {
    if(!state.todoistToken)return state.view;
    try{
      const sources=await personalTodoist(state.todoistToken);const allowed=new Set(sources.map(source=>source.id));state.view.tasks=state.view.tasks.filter(task=>allowed.has(task.sourceId));state.view.todoist.sources=sources;state.view.todoist.selected=sources.map(source=>({id:source.id,area:source.area}));const tasks:RemoteTask[]=[];
      for(const source of sources){const raw=await todoistPages(`/tasks?project_id=${encodeURIComponent(source.id)}`,state.todoistToken);for(const row of raw){const task=normalizeTask(row,source,timeZone);if(task)tasks.push(task);}}
      state.view.tasks=tasks;state.view.todoist={connected:true,configured:true,sources,selected:sources.map(s=>({id:s.id,area:s.area})),lastSynced:new Date().toISOString(),error:null};
    }catch(err){if(err instanceof PublicError && err.message.startsWith("No Personal project")){state.view.tasks=[];state.view.todoist.sources=[];state.view.todoist.selected=[];}state.view.todoist.error=cleanError(err);}
    return state.view;
  }
  async function syncGoogle(state:SecretState,date:string,timeZone:string) {
    state.calendarAnchor=date;
    const fromDate=new Date(`${date}T12:00:00Z`);fromDate.setUTCDate(fromDate.getUTCDate()-7);
    const toDate=new Date(`${date}T12:00:00Z`);toDate.setUTCDate(toDate.getUTCDate()+35);
    const from=fromDate.toISOString().slice(0,10);const to=toDate.toISOString().slice(0,10);
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
  function linkConflict(state:SecretState,input:Mutation):IntegrationRelation|undefined {
    if(!input.link)return undefined;
    return state.relations.find(link=>link.entityKind===input.link!.entityKind&&link.entityId===input.link!.entityId&&link.role===input.link!.role&&link.requestId!==input.requestId);
  }
  function linkConflictError(role:IntegrationRelation["role"]):PublicError {
    if(role==="goal-next-step")return new PublicError("This climbing goal already has a Todoist next step. Unlink it before creating another one.",409);
    if(role==="scheduled-session")return new PublicError("This climbing plan already has a Calendar event. Unlink it before creating another one.",409);
    if(role==="follow-up-task")return new PublicError("This Gmail message already has a Todoist follow-up task.",409);
    return new PublicError("This Gmail message already has a Calendar time block.",409);
  }
  function ensureIntegrationLink(state:SecretState,input:Mutation):IntegrationRelation|null {
    if(!input.link)return null;
    const receipt=state.receipts[input.requestId];
    if(!receipt?.id)throw new PublicError("The connected app saved the item but did not return its identifier. Retry this same request to finish linking it.",502);
    const existing=state.relations.find(link=>link.requestId===input.requestId);
    if(existing){
      if(existing.entityKind==="capture"||existing.provider!==input.provider||existing.remoteId!==receipt.id||existing.entityKind!==input.link.entityKind||existing.entityId!==input.link.entityId||existing.role!==input.link.role)throw new PublicError("This integration request is already linked to a different item.",409);
      return existing;
    }
    if(linkConflict(state,input))throw linkConflictError(input.link.role);
    const link=integrationRelationSchema.parse({id:randomUUID(),...input.link,provider:input.provider,remoteId:receipt.id,requestId:input.requestId,createdAt:new Date().toISOString()});
    state.relations=integrationRelationsSchema.parse([...state.relations,link]);publishRelations(state);return link;
  }
  function checkLinkAvailability(state:SecretState,input:Mutation) {
    if(!input.link)return;
    if(input.link.entityKind==="gmail-message"&&(!state.gmailTokens||!state.view.messages.some(message=>message.id===input.link!.entityId)))throw new PublicError("Refresh Gmail before creating a follow-up from this message.",409);
    if(linkConflict(state,input))throw linkConflictError(input.link.role);
  }
  async function addWorkspaceRelation(state:SecretState,input:z.infer<typeof workspaceRelationRequestSchema>) {
    const existingRequest=state.relations.find(relation=>relation.requestId===input.requestId);
    if(existingRequest){
      if(existingRequest.entityKind!=="capture"||existingRequest.entityId!==input.entityId||existingRequest.targetId!==input.targetId)throw new PublicError("This relation request was already used for different Workspace items.",409);
      return existingRequest;
    }
    const existingSource=state.relations.find(relation=>relation.entityKind==="capture"&&relation.entityId===input.entityId&&relation.role===input.role);
    if(existingSource){if(existingSource.entityKind==="capture"&&existingSource.targetId===input.targetId)return existingSource;throw new PublicError("This capture already has a derived priority.",409);}
    if(state.relations.some(relation=>relation.entityKind==="capture"&&relation.targetId===input.targetId))throw new PublicError("This priority is already linked to another capture.",409);
    let workspace:z.infer<typeof workspaceSchema>;
    try{workspace=workspaceSchema.parse(JSON.parse(await readFile(join(directory,"workspace.json"),"utf8")));}catch(err){if((err as NodeJS.ErrnoException).code==="ENOENT")throw new PublicError("Save the capture and priority before linking them.",409);throw new PublicError("The saved Workspace items could not be verified. No relation was added.",500);}
    if(!workspace.items.some(item=>item.id===input.entityId&&item.kind==="note"))throw new PublicError("The source capture is no longer available. Refresh before linking it.",409);
    if(!workspace.items.some(item=>item.id===input.targetId&&item.kind==="priority"))throw new PublicError("The derived priority is no longer available. Refresh before linking it.",409);
    const relation=integrationRelationSchema.parse({...input,id:randomUUID(),createdAt:new Date().toISOString()});state.relations=integrationRelationsSchema.parse([...state.relations,relation]);publishRelations(state);return relation;
  }
  function pruneRequests(state:SecretState) {
    const linkedRequests=new Set(state.relations.map(link=>link.requestId));const receiptKeys=Object.keys(state.receipts).filter(key=>!linkedRequests.has(key));const pending=receiptKeys.filter(key=>state.receipts[key].provider==="gmail-send-pending");const completed=receiptKeys.filter(key=>state.receipts[key].provider!=="gmail-send-pending");const completedLimit=Math.max(0,1000-pending.length);for(const key of completed.slice(0,Math.max(0,completed.length-completedLimit))){delete state.receipts[key];delete state.requests[key];}
    const unreceipted=Object.keys(state.requests).filter(key=>!linkedRequests.has(key)&&!state.receipts[key]);for(const key of unreceipted.slice(0,-1000))delete state.requests[key];
  }
  async function mutate(state:SecretState,input:Mutation,save:()=>Promise<void>) {
    const hash=createHash("sha256").update(JSON.stringify(input)).digest("hex");
    if(state.detachedRequests.includes(input.requestId))throw new PublicError(`This integration request was detached. Start a fresh link from the climbing ${input.link?.entityKind||"item"}.`,409);
    if(state.requests[input.requestId] && state.requests[input.requestId]!==hash)throw new PublicError("This request was already used for a different edit. Close the editor and start a fresh edit.",409);
    if(state.receipts[input.requestId]){ensureIntegrationLink(state,input);return;}
    checkLinkAvailability(state,input);
    state.requests[input.requestId]=hash;await save();
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
        const locationChanged=input.location!==undefined&&(!event||event.location!==input.location);
        const body={summary:input.title,...(startChanged?{start}:{}),...(endChanged?{end}:{}),...(locationChanged?{location:input.location}:{}),...(input.action==="create"?{id:input.requestId.replaceAll("-","")}:{})};
        if(input.action==="create"){
          try{const existing=await request(`${base}/${input.requestId.replaceAll("-","")}`,token);const normalized=normalizeEvent(existing,source,input.timeZone);state.receipts[input.requestId]={provider:"google",id:existing.id};if(normalized)state.view.events=[...state.view.events.filter(e=>e.id!==existing.id),normalized];ensureIntegrationLink(state,input);return;}catch(err){if(!(err instanceof PublicError) || err.status!==409)throw err;}
        }
        const result=await request(input.action==="create"?`${base}?sendUpdates=none`:`${base}/${encodeURIComponent(input.id!)}?sendUpdates=none`,token,{method:input.action==="create"?"POST":"PATCH",headers,body:JSON.stringify(body)});
        state.receipts[input.requestId]={provider:"google",id:result.id};
        const savedEvent=normalizeEvent(result,source,input.timeZone);if(savedEvent)state.view.events=[...state.view.events.filter(e=>e.id!==result.id),savedEvent];
      }
      state.receipts[input.requestId]??={provider:"google",id:input.id};if(input.action==="delete")state.view.events=state.view.events.filter(e=>e.id!==input.id);
    }
    ensureIntegrationLink(state,input);
    pruneRequests(state);
  }
  const requestHash=(input:unknown)=>createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const gmailRequestBinding=(key:string,hash:string)=>createHmac("sha256",Buffer.from(key,"base64url")).update(hash).digest("base64url");
  function beginGmailRequest(state:SecretState,requestId:string,input:unknown) {
    const hash=requestHash(input);if(state.requests[requestId]&&state.requests[requestId]!==hash)throw new PublicError("This request was already used for a different Gmail action. Refresh and try again.",409);return hash;
  }
  async function mutateGmail(state:SecretState,input:GmailMutation,save:()=>Promise<void>) {
    const existingHash=state.requests[input.requestId];const hash=beginGmailRequest(state,input.requestId,input);if(state.receipts[input.requestId]&&existingHash===hash)return;
    let token:string;let blockedLabels:Set<string>;let raw:unknown;let current:RemoteMail;try{token=await gmailToken(state);await personalGmail(token);blockedLabels=await gmailLabels(token);raw=await gmailMessage(token,input.id);const normalized=normalizeMail(raw,blockedLabels,false);if(!normalized)throw new PublicError("This message is outside the personal Gmail connection.",403);current=normalized;}catch(err){if(!state.receipts[input.requestId]&&state.requests[input.requestId]){delete state.requests[input.requestId];await save();}throw err;}
    const parsed=gmailMessageSchema.parse(raw);const labels=new Set(parsed.labelIds);const satisfied=input.action==="read"?!labels.has("UNREAD"):input.action==="unread"?labels.has("UNREAD"):input.action==="star"?labels.has("STARRED"):input.action==="unstar"?!labels.has("STARRED"):input.action==="archive"?!labels.has("INBOX"):labels.has("TRASH");
    if(satisfied){state.requests[input.requestId]=hash;state.receipts[input.requestId]={provider:"gmail",id:input.id};const cached=normalizeMail(raw,blockedLabels);if(cached)state.view.messages=state.view.messages.map(message=>message.id===input.id?cached:message);else state.view.messages=state.view.messages.filter(message=>message.id!==input.id);state.view.gmail.unreadCount=state.view.messages.filter(message=>message.unread).length;pruneRequests(state);await save();await syncGmail(state);return;}
    if(!labels.has("INBOX")){if(state.requests[input.requestId]){delete state.requests[input.requestId];await save();}throw new PublicError("This message is no longer in the personal inbox. Refresh before changing it.",409);}
    if(current.version!==input.version){if(state.requests[input.requestId]){delete state.requests[input.requestId];await save();}throw new PublicError("This message changed in Gmail. Refresh the inbox before changing it.",409);}
    let addLabelIds:string[]=[];let removeLabelIds:string[]=[];
    if(input.action==="read"&&labels.has("UNREAD"))removeLabelIds=["UNREAD"];
    if(input.action==="unread"&&!labels.has("UNREAD"))addLabelIds=["UNREAD"];
    if(input.action==="star"&&!labels.has("STARRED"))addLabelIds=["STARRED"];
    if(input.action==="unstar"&&labels.has("STARRED"))removeLabelIds=["STARRED"];
    if(input.action==="archive"&&labels.has("INBOX"))removeLabelIds=["INBOX"];
    state.requests[input.requestId]=hash;await save();let result:unknown=raw;
    try{if(input.action==="trash")result=await request(`${GMAIL}/users/me/messages/${encodeURIComponent(input.id)}/trash`,token,{method:"POST"});else result=await request(`${GMAIL}/users/me/messages/${encodeURIComponent(input.id)}/modify`,token,{method:"POST",body:JSON.stringify({addLabelIds,removeLabelIds})});}catch(err){if(!(err instanceof UncertainRemoteError)){delete state.requests[input.requestId];await save();}throw err;}
    state.receipts[input.requestId]={provider:"gmail",id:input.id};
    if(input.action==="archive"||input.action==="trash")state.view.messages=state.view.messages.filter(message=>message.id!==input.id);
    else {
      const merged={...parsed,...(result&&typeof result==="object"?result:{}),payload:parsed.payload,snippet:parsed.snippet,internalDate:parsed.internalDate};const updated=normalizeMail(merged,blockedLabels);
      if(updated)state.view.messages=state.view.messages.map(message=>message.id===input.id?updated:message);
    }
    state.view.gmail.unreadCount=state.view.messages.filter(message=>message.unread).length;pruneRequests(state);await save();await syncGmail(state);
  }
  const safeMessageId=(value:string)=>/^<[^<>\r\n]{1,480}>$/.test(value)?value:"";
  const workspaceMessageId=(requestId:string)=>`<workspace.${requestId}@jordmburg-workspace.local>`;
  async function recoverSentMessage(token:string,requestId:string,binding:string|null,knownBound:boolean):Promise<string|null> {
    const expectedId=workspaceMessageId(requestId);const url=new URL(`${GMAIL}/users/me/messages`);url.searchParams.set("q",`rfc822msgid:${expectedId}`);url.searchParams.set("includeSpamTrash","true");url.searchParams.set("maxResults","10");
    const data=z.object({messages:z.array(z.object({id:z.string().min(1).max(500)}).passthrough()).max(10).optional().default([])}).passthrough().parse(await request(url.href,token));let unresolved=false;
    for(const item of data.messages){let raw;try{raw=gmailMessageSchema.parse(await gmailMessage(token,item.id));}catch(err){if(err instanceof MissingRemoteError)continue;throw err;}const headers=raw.payload?.headers||[];if(!raw.labelIds.includes("SENT")||safeMessageId(headerValue(headers,"message-id"))!==expectedId)continue;const savedBinding=headerValue(headers,"x-workspace-request-binding");if(binding&&savedBinding===binding)return raw.id;if(!savedBinding&&knownBound)return raw.id;unresolved=true;}
    if(unresolved)throw new PublicError("This request ID already belongs to a different or unverifiable sent message. Check Sent and start a fresh message.",409);return null;
  }
  function encodeSubject(value:string) {
    if(/^[\x20-\x7e]*$/.test(value)&&value.length<=70)return value;
    const chunks:string[]=[];let current="";for(const character of value){if(current&&Buffer.byteLength(current+character,"utf8")>42){chunks.push(current);current="";}current+=character;}if(current)chunks.push(current);
    return chunks.map(chunk=>`=?UTF-8?B?${Buffer.from(chunk,"utf8").toString("base64")}?=`).join("\r\n ");
  }
  function mimeMessage(input:GmailSend,binding:string,reply?:{messageId:string;references:string[]}) {
    const addressHeader=(name:string,values:string[])=>`${name}: ${values.join(",\r\n ")}`;const headers=[addressHeader("To",input.to)];if(input.cc.length)headers.push(addressHeader("Cc",input.cc));if(input.bcc.length)headers.push(addressHeader("Bcc",input.bcc));headers.push(`Subject: ${encodeSubject(input.subject)}`,`Message-ID: ${workspaceMessageId(input.requestId)}`,`X-Workspace-Request-Binding: ${binding}`);
    if(reply){headers.push(`In-Reply-To: ${reply.messageId}`);const references=[...reply.references,reply.messageId].slice(-20);if(references.length)headers.push(`References: ${references.join("\r\n ")}`);}
    headers.push("MIME-Version: 1.0","Content-Type: text/plain; charset=UTF-8","Content-Transfer-Encoding: base64");
    const encodedBody=Buffer.from(input.body.replace(/\r?\n/g,"\r\n"),"utf8").toString("base64").replace(/.{1,76}/g,"$&\r\n").trimEnd();return `${headers.join("\r\n")}\r\n\r\n${encodedBody}`;
  }
  async function sendGmail(state:SecretState,input:GmailSend,save:()=>Promise<void>) {
    const existingHash=state.requests[input.requestId];const hash=beginGmailRequest(state,input.requestId,input);const prior=state.receipts[input.requestId];if(prior&&existingHash===hash&&prior.provider!=="gmail-send-pending")return;
    let token:string;try{token=await gmailToken(state);await personalGmail(token);const binding=state.gmailBindingKey?gmailRequestBinding(state.gmailBindingKey,hash):null;const recovered=await recoverSentMessage(token,input.requestId,binding,existingHash===hash);if(recovered){state.requests[input.requestId]=hash;state.receipts[input.requestId]={provider:"gmail",id:recovered};pruneRequests(state);await save();return;}if(prior)throw new PublicError(prior.provider==="gmail-send-pending"?"Gmail may already have sent this message, but it is not searchable yet. Check Sent before starting a fresh send.":"This Gmail request ID is already in use. Check Sent and start a fresh message.",409);}catch(err){if(!prior&&state.requests[input.requestId]){delete state.requests[input.requestId];await save();}throw err;}
    let threadId:string|undefined;let reply:undefined|{messageId:string;references:string[]};
    try{if(input.replyToId){
      const blockedLabels=await gmailLabels(token);const raw=gmailMessageSchema.parse(await gmailMessage(token,input.replyToId));const original=normalizeMail(raw,blockedLabels,false);if(!original)throw new PublicError("This message is outside the personal Gmail connection.",403);if(!original.replyTo)throw new PublicError("Gmail did not provide a safe reply address for this message.");
      if(input.to.length!==1||input.to[0]!==original.replyTo)throw new PublicError("Refresh this message and use its displayed reply address before sending.",409);
      const expectedSubject=/^re:/i.test(original.subject.trim())?original.subject.trim():`Re: ${original.subject.trim()}`;if(input.subject!==expectedSubject)throw new PublicError(`Use the reply subject “${expectedSubject}” so Gmail can keep this message in its thread.`,409);
      const headers=raw.payload?.headers||[];const messageId=safeMessageId(headerValue(headers,"message-id"));if(!messageId)throw new PublicError("This message does not include a valid reply identifier. Open it in Gmail to reply.");
      const references=[...headerValue(headers,"references").matchAll(/<[^<>\r\n]{1,480}>/g)].map(match=>match[0]);threadId=raw.threadId;reply={messageId,references};
    }}catch(err){if(!prior&&state.requests[input.requestId]){delete state.requests[input.requestId];await save();}throw err;}
    if(Object.values(state.receipts).filter(receipt=>receipt.provider==="gmail-send-pending").length>=1000)throw new PublicError("Resolve pending Gmail sends in Sent before sending another message from Workspace.",409);state.gmailBindingKey??=randomBytes(32).toString("base64url");const binding=gmailRequestBinding(state.gmailBindingKey,hash);const raw=Buffer.from(mimeMessage(input,binding,reply),"utf8").toString("base64url");state.requests[input.requestId]=hash;state.receipts[input.requestId]={provider:"gmail-send-pending"};pruneRequests(state);await save();
    let response:Response;try{response=await remoteFetch(`${GMAIL}/users/me/messages/send`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({raw,...(threadId?{threadId}:{})}),signal:AbortSignal.timeout(20000)});}catch{throw new PublicError("Gmail may already have sent this message. Check Sent before starting a fresh send.",409);}
    if(!response.ok){const definiteClientFailure=response.status>=400&&response.status<500&&response.status!==408&&response.status!==429;if(definiteClientFailure){delete state.receipts[input.requestId];delete state.requests[input.requestId];await save();}throw responseError(response);}
    let sent:{id:string;threadId?:string};try{sent=z.object({id:z.string().min(1),threadId:z.string().optional()}).passthrough().parse(await response.json());}catch{throw new PublicError("Gmail may already have sent this message. Check Sent before starting a fresh send.",409);}
    state.receipts[input.requestId]={provider:"gmail",id:sent.id};pruneRequests(state);await save();await syncGmail(state);
  }
  type ScheduledProvider=Provider;
  const scheduledTimers:Partial<Record<ScheduledProvider,ReturnType<typeof setTimeout>>>={};
  const scheduledFailures:Record<ScheduledProvider,number>={todoist:0,google:0,gmail:0};let schedulerRunning=false;
  const localDay=(timeZone:string)=>{const parts=new Intl.DateTimeFormat("en",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());const part=(type:string)=>parts.find(value=>value.type===type)?.value||"";return `${part("year")}-${part("month")}-${part("day")}`;};
  const providerConfigured=(state:SecretState,provider:ScheduledProvider)=>provider==="todoist"?!!state.todoistToken:provider==="google"?!!state.googleTokens:!!state.gmailTokens;
  const providerError=(state:SecretState,provider:ScheduledProvider)=>provider==="todoist"?state.view.todoist.error:provider==="google"?state.view.google.error:state.view.gmail.error;
  const scheduleProvider=(provider:ScheduledProvider,delay:number)=>{if(!schedulerRunning)return;const timer=setTimeout(()=>void runScheduledProvider(provider),delay);timer.unref?.();scheduledTimers[provider]=timer;};
  async function runScheduledProvider(provider:ScheduledProvider) {
    let failed=false;
    try{await providerState(provider,async(state,save)=>{if(!providerConfigured(state,provider))return;const timeZone=state.view.range?.timeZone||Intl.DateTimeFormat().resolvedOptions().timeZone;if(provider==="todoist")await syncTodoist(state,timeZone);else if(provider==="google")await syncGoogle(state,state.calendarAnchor||localDay(timeZone),timeZone);else await syncGmail(state);failed=!!providerError(state,provider);await save();});}catch{failed=true;}
    scheduledFailures[provider]=failed?Math.min(scheduledFailures[provider]+1,6):0;const retry=failed?Math.min(300_000,15_000*2**(scheduledFailures[provider]-1)):300_000;scheduleProvider(provider,retry);
  }
  function startScheduler(initialDelays:Partial<Record<ScheduledProvider,number>>={}){if(schedulerRunning)return;schedulerRunning=true;scheduleProvider("todoist",initialDelays.todoist??1_000);scheduleProvider("google",initialDelays.google??2_000);scheduleProvider("gmail",initialDelays.gmail??3_000);}
  function stopScheduler(){schedulerRunning=false;for(const provider of ["todoist","google","gmail"] as const){const timer=scheduledTimers[provider];if(timer)clearTimeout(timer);delete scheduledTimers[provider];scheduledFailures[provider]=0;}}
  async function handle(req:IncomingMessage,res:ServerResponse) {
    const host=req.headers.host||"";const url=new URL(req.url||"/",`http://${host||"localhost"}`);const path=url.pathname.replace(/^\/api\/integrations/,"") || "/";
    const send=(code:number,value?:unknown,headers:Record<string,string>={})=>{res.statusCode=code;for(const [name,header] of Object.entries(headers))res.setHeader(name,header);res.setHeader("Cache-Control","no-store");if(code===304){res.end();return;}res.setHeader("Content-Type","application/json");res.end(JSON.stringify(value));};
    if(!/^(localhost|127\.0\.0\.1):\d+$/.test(host))return send(403,{error:"Only the local workspace can access connections."});
    const callbackProvider=path==="/google/callback"?"google":path==="/gmail/callback"?"gmail":null;
    if(callbackProvider && req.method==="GET") {
      const stateKey=url.searchParams.get("state")||"";const flow=pending.get(stateKey);pending.delete(stateKey);
      if(!flow || flow.provider!==callbackProvider || flow.expires<Date.now())return send(400,{error:`This ${callbackProvider==="gmail"?"Gmail":"Google"} connection request expired. Start again from Settings.`});
      if(url.searchParams.has("error"))return send(400,{error:`${callbackProvider==="gmail"?"Gmail":"Google"} connection was cancelled. You can return to your workspace.`});
      try {await providerState(callbackProvider,async(state,save)=>{if(!state.googleClient)throw new PublicError("Configure the Google client first.");const response=await remoteFetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"authorization_code",code:url.searchParams.get("code")||"",code_verifier:flow.verifier,redirect_uri:flow.redirectUri,...state.googleClient}),signal:AbortSignal.timeout(20000)});if(!response.ok)throw new PublicError(`${callbackProvider==="gmail"?"Gmail":"Google"} did not complete authorization. Try connecting again.`);const token=tokenSchema.parse(await response.json());const required=callbackProvider==="gmail"?[GMAIL_SCOPE]:SCOPES;requireExactGoogleScopes(token.scope,required,callbackProvider);
        if(callbackProvider==="gmail"){await personalGmail(token.access_token);const refreshToken=token.refresh_token||state.gmailTokens?.refreshToken;if(!refreshToken)throw new PublicError("Gmail did not return offline access. Remove this app's old Google grant and reconnect.");state.gmailTokens={accessToken:token.access_token,refreshToken,expiresAt:Date.now()+token.expires_in*1000};state.view.gmail={...state.view.gmail,connected:true,configured:true,account:PERSONAL_CALENDAR,error:null};state.view.messages=[];}
        else {await personalGoogle(token.access_token);const refreshToken=token.refresh_token||state.googleTokens?.refreshToken;if(!refreshToken)throw new PublicError("Google did not return offline access. Remove this app's old Google grant and reconnect.");state.googleTokens={accessToken:token.access_token,refreshToken,expiresAt:Date.now()+token.expires_in*1000};state.view.google.connected=true;state.view.google.configured=true;state.view.google.error=null;}
        await save();});res.statusCode=302;res.setHeader("Location",`/?connections=1&connected=${callbackProvider}`);res.setHeader("Referrer-Policy","no-referrer");res.end();}catch(err){send(err instanceof PublicError?err.status:err instanceof StoreBusyError?423:500,{error:cleanError(err)});}return;
    }
    if((req.headers.origin && req.headers.origin!==`http://${host}`) || req.headers["sec-fetch-site"]==="cross-site")return send(403,{error:"Open Settings in the local workspace."});
    if(req.method==="GET" && path==="/"){try{const state=await read();const payload=JSON.stringify(state.view);const etag=`"${createHash("sha256").update(payload).digest("hex")}"`;if(req.headers["if-none-match"]===etag)send(304,undefined,{ETag:etag});else send(200,state.view,{ETag:etag});}catch(err){send(500,{error:cleanError(err)});}return;}
    if(req.method!=="POST")return send(405,{error:"Method not allowed"});
    if(req.headers["content-type"]?.split(";",1)[0].trim().toLowerCase()!=="application/json")return send(415,{error:"JSON is required"});
    try{
      const chunks:Buffer[]=[];let size=0;const maxRequestBytes=path==="/gmail/send"?256000:64000;for await(const raw of req){const chunk=Buffer.from(raw);size+=chunk.length;if(size>maxRequestBytes)throw new PublicError("This request is too large.",413);chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString("utf8")||"{}");
      let result:unknown;
      if(path==="/todoist/connect"){
        const token=z.string().trim().min(20).max(500).parse(body.token);result=await providerState("todoist",async(state,save)=>{const sources=await personalTodoist(token);state.todoistToken=token;state.view.todoist={connected:true,configured:true,sources,selected:sources.map(s=>({id:s.id,area:s.area})),lastSynced:null,error:null};state.view.tasks=[];await save();return state.view;});
      }else if(path==="/google/configure"){
        if(body && typeof body==="object" && "web" in body)throw new PublicError("This file is for a Web application client. Create an OAuth client with application type Desktop app in your personal Google Cloud project, then upload its JSON file. Your previously saved client has not been replaced.");
        const parsed=clientSchema.safeParse(body);if(!parsed.success)throw new PublicError("Choose the downloaded JSON file for a Google Desktop app OAuth client. This file was not saved; any previous client is still configured.");
        result=await providerExclusive(["google","gmail"],()=>atomicUpdate(async state=>{const client=parsed.data.installed;state.googleClient=client;delete state.googleTokens;delete state.gmailTokens;delete state.calendarAnchor;state.view.google={...emptySync().google,configured:true};state.view.gmail={...emptySync().gmail,configured:true};state.view.events=[];state.view.messages=[];pending.clear();return state.view;}));
      }else if(path==="/google/start"||path==="/gmail/start"){
        const provider=path==="/gmail/start"?"gmail":"google";const state=await snapshot();if(!state.googleClient)throw new PublicError("Choose your Google Desktop OAuth client file first.");
        const stateKey=randomBytes(32).toString("base64url");const verifier=randomBytes(32).toString("base64url");const redirectUri=`http://127.0.0.1:${host.split(":")[1]}/api/integrations/${provider}/callback`;for(const [key,flow] of pending)if(flow.expires<Date.now())pending.delete(key);pending.set(stateKey,{provider,verifier,redirectUri,expires:Date.now()+600000});
        const scope=provider==="gmail"?GMAIL_SCOPE:SCOPES.join(" ");const query=new URLSearchParams({client_id:state.googleClient.client_id,redirect_uri:redirectUri,response_type:"code",scope,state:stateKey,code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256",access_type:"offline",prompt:"consent",login_hint:PERSONAL_CALENDAR});const authUrl=`https://accounts.google.com/o/oauth2/v2/auth?${query}`;if(process.platform==="darwin"&&remoteFetch===fetch)execFile("/usr/bin/open",[authUrl],()=>{});result={url:authUrl};
      }else if(path==="/disconnect"){
        const provider=z.enum(["todoist","google","gmail"]).parse(body.provider);result=await providerExclusive(provider,()=>atomicUpdate(async state=>{if(provider==="todoist"){delete state.todoistToken;state.view.todoist=emptySync().todoist;state.view.tasks=[];}else if(provider==="gmail"){delete state.gmailTokens;state.view.gmail={...emptySync().gmail,configured:!!state.googleClient};state.view.messages=[];for(const [key,flow] of pending)if(flow.provider==="gmail")pending.delete(key);}else{delete state.googleTokens;delete state.calendarAnchor;state.view.google={...emptySync().google,configured:!!state.gmailTokens};state.view.events=[];state.view.range=null;for(const [key,flow] of pending)if(flow.provider==="google")pending.delete(key);if(!state.gmailTokens)delete state.googleClient;}return state.view;}));
      }else if(path==="/sync"){
        const input=syncRequestSchema.parse(body);await Promise.all([providerState("todoist",async(state,save)=>{await syncTodoist(state,input.timeZone);await save();}),providerState("google",async(state,save)=>{await syncGoogle(state,input.date,input.timeZone);await save();})]);result=(await snapshot()).view;
      }else if(path==="/sync/todoist"){
        const input=todoistSyncSchema.parse(body);result=await providerState("todoist",async(state,save)=>{await syncTodoist(state,input.timeZone);await save();return state.view;});
      }else if(path==="/sync/google"){
        const input=syncRequestSchema.parse(body);result=await providerState("google",async(state,save)=>{await syncGoogle(state,input.date,input.timeZone);await save();return state.view;});
      }else if(path==="/gmail/sync"){
        gmailSyncSchema.parse(body);result=await providerState("gmail",async(state,save)=>{await syncGmail(state);await save();return state.view;});
      }else if(path==="/gmail/mutate"){
        const input=gmailMutationSchema.parse(body);result=await providerState("gmail",async(state,save)=>{await mutateGmail(state,input,save);await save();return state.view;});
      }else if(path==="/gmail/send"){
        const input=gmailSendSchema.parse(body);result=await providerState("gmail",async(state,save)=>{await sendGmail(state,input,save);await save();return state.view;});
      }else if(path==="/relations"){
        const input=workspaceRelationRequestSchema.parse(body);result=await atomicUpdate(async state=>{await addWorkspaceRelation(state,input);return state.view;});
      }else if(path==="/unlink"){
        const {id}=z.object({id:z.string().uuid()}).strict().parse(body);result=await atomicUpdate(async state=>{const link=state.relations.find(item=>item.id===id);if(!link)throw new PublicError("This connection link is no longer available. Refresh Workspace.",409);state.relations=state.relations.filter(item=>item.id!==id);state.detachedRequests=[...new Set([...state.detachedRequests,link.requestId])].slice(-10000);return state.view;},false);
      }else if(path==="/mutate"){
        const input=mutationSchema.parse(body);result=await providerState(input.provider,async(state,save)=>{await mutate(state,input,save);await save();if(input.provider==="todoist")await syncTodoist(state,input.timeZone);else await syncGoogle(state,input.anchorDate||input.date||new Date().toISOString().slice(0,10),input.timeZone);await save();return state.view;});
      }else throw new PublicError("Unknown connection action.",404);
      send(200,result);
    }catch(err){send(err instanceof PublicError?err.status:err instanceof StoreBusyError?423:err instanceof z.ZodError?400:500,{error:err instanceof z.ZodError?"Check the connection file, dates, and required fields.":cleanError(err)});}
  }
  return {handle,startScheduler,stopScheduler};
}
export function integrations():Plugin {const service=createIntegrationService(process.env.WORKSPACE_DATA_DIR||join(homedir(),"Data","personal-workspace"));return {name:"workspace-integrations",configureServer(server){server.middlewares.use("/api/integrations",service.handle);const start=()=>service.startScheduler();if(server.httpServer?.listening)start();else server.httpServer?.once("listening",start);server.httpServer?.once("close",()=>service.stopScheduler());}};}

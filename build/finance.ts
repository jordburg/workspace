import { readFile } from "node:fs/promises";
import { StoreBusyError, withPrivateLock, writePrivateJson } from "./private-store.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { z } from "zod";
import { emptyFinance, normalizeAccount, normalizeTransaction, noteSchema, type BankConnection, type FinanceView, type Transaction, type TransactionNote } from "../lib/finance.ts";

type Config={clientId:string;secret:string;environment:"production"|"sandbox"};
type Item={institutionId?:string;id:string;token:string;name:string;accounts:BankConnection["accounts"];selected:string[];cursors:Record<string,string>;transactions:Transaction[];lastSynced:string|null;error:string|null;updateStatus:string|null};
type State={version:1;userId:string;config?:Config;items:Item[];annotations:Record<string,TransactionNote>;exchanges:Record<string,string>};
class FinanceError extends Error {readonly status:number;readonly code:string;constructor(message:string,status=400,code=""){super(message);this.status=status;this.code=code;}}
const message=(e:unknown)=>e instanceof FinanceError||e instanceof StoreBusyError?e.message:"The bank connection could not be refreshed. Your last saved data is still available.";
const configSchema=z.object({clientId:z.string().trim().min(10).max(100),secret:z.string().trim().min(10).max(200),environment:z.enum(["production","sandbox"])}).strict();

export function createFinanceService(directory:string,remoteFetch:typeof fetch=fetch){
  const file=join(directory,"finance.private.json");let queue:Promise<unknown>=Promise.resolve();
  const exclusive=<T>(fn:()=>Promise<T>):Promise<T>=>{const next=queue.catch(()=>{}).then(()=>withPrivateLock(file,fn));queue=next;return next;};
  async function read():Promise<State>{try{const s=JSON.parse(await readFile(file,"utf8"));if(s.version!==1||!Array.isArray(s.items)||!s.annotations||!s.exchanges)throw new Error();return s;}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return {version:1,userId:randomUUID(),items:[],annotations:{},exchanges:{}};throw new FinanceError("Saved finance data could not be read. It has been left untouched.",500);}}
  async function write(s:State){await writePrivateJson(file,s); }
  function view(s:State):FinanceView{return {configured:!!s.config,environment:s.config?.environment||null,banks:s.items.map(({id,name,accounts,lastSynced,error,updateStatus})=>({id,name,accounts,lastSynced,error,updateStatus})),transactions:s.items.flatMap(i=>i.transactions).sort((a,b)=>b.date.localeCompare(a.date)),annotations:s.annotations};}
  async function plaid(config:Config|undefined,path:string,body:object={}){
    if(!config)throw new FinanceError("Set up your Plaid connection first.");
    let response:Response;try{response=await remoteFetch(`https://${config.environment}.plaid.com${path}`,{method:"POST",headers:{"Content-Type":"application/json","Plaid-Version":"2020-09-14"},body:JSON.stringify({client_id:config.clientId,secret:config.secret,...body}),signal:AbortSignal.timeout(30000)});}catch{throw new FinanceError("Plaid could not confirm the request. Your saved connection has been kept.",502);}
    const data=z.record(z.unknown()).parse(await response.json());if(!response.ok){const code=typeof data.error_code==="string"?data.error_code:"";
      const text=code==="ITEM_LOGIN_REQUIRED"?"Your bank needs you to reconnect. Choose Repair connection.":code==="TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"?"Bank transactions changed during sync. Try syncing again.":code==="PRODUCT_NOT_READY"?"The bank is still preparing transactions. Sync again in a few minutes.":code==="INVALID_CREDENTIALS"||code==="INVALID_API_KEYS"?"Check the Plaid client ID, secret, and environment.":"Plaid could not complete this request. Check your Plaid access and try again.";
      throw new FinanceError(text,502,code);
    }return data;
  }
  function prune(s:State,item:Item){const selected=new Set(item.accounts.filter(a=>a.selected&&!a.blocked).map(a=>a.id));item.selected=[...selected];const removed=item.transactions.filter(t=>!selected.has(t.accountId));item.transactions=item.transactions.filter(t=>selected.has(t.accountId));for(const t of removed)delete s.annotations[t.id];for(const id of Object.keys(item.cursors))if(!selected.has(id))delete item.cursors[id];}
  async function accounts(s:State,item:Item){const data=await plaid(s.config,"/accounts/get",{access_token:item.token});if(!item.institutionId){const metadata=data.item||(await plaid(s.config,"/item/get",{access_token:item.token})).item;item.institutionId=z.object({institution_id:z.string().min(1)}).parse(metadata).institution_id;}item.accounts=z.array(z.unknown()).parse(data.accounts).map(a=>normalizeAccount(a,new Set(item.selected)));prune(s,item);}
  async function syncItem(s:State,item:Item){
    try{
      await accounts(s,item);
      const staged=structuredClone(item);const annotations=structuredClone(s.annotations);let ready=true;
      for(const accountId of staged.selected){
        const originalCursor=staged.cursors[accountId];let completed=false;
        for(let attempt=0;attempt<2&&!completed;attempt++){
          let cursor=originalCursor;const changes=new Map(staged.transactions.filter(t=>t.accountId===accountId).map(t=>[t.id,t]));const moved:Record<string,TransactionNote>={};const removedIds=new Set<string>();const seen=new Set<string>();
          try{
            for(let page=0;page<200;page++){
              const data=await plaid(s.config,"/transactions/sync",{access_token:staged.token,...(cursor?{cursor}:{}),count:500,options:{account_id:accountId}});
              const result=z.object({added:z.array(z.unknown()),modified:z.array(z.unknown()),removed:z.array(z.object({transaction_id:z.string()})),next_cursor:z.string(),has_more:z.boolean(),transactions_update_status:z.string().optional()}).parse(data);
              for(const raw of [...result.added,...result.modified]){const t=normalizeTransaction(raw,item.id,accountId);changes.set(t.id,t);if(t.pendingId&&annotations[t.pendingId]&&!annotations[t.id])moved[t.id]=annotations[t.pendingId];}
              for(const removed of result.removed){changes.delete(removed.transaction_id);removedIds.add(removed.transaction_id);}
              cursor=result.next_cursor;staged.updateStatus=result.transactions_update_status||null;
              if(result.transactions_update_status==="NOT_READY")ready=false;
              if(!result.has_more){completed=true;break;}
              if(seen.has(cursor)||page===199)throw new FinanceError("Bank pagination did not finish. Your previous transactions have been kept.",502);seen.add(cursor);
            }
            staged.transactions=[...staged.transactions.filter(t=>t.accountId!==accountId),...changes.values()];if(cursor)staged.cursors[accountId]=cursor;
            Object.assign(annotations,moved);for(const id of removedIds)delete annotations[id];
          }catch(e){if(e instanceof FinanceError&&e.code==="TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"&&attempt===0)continue;throw e;}
        }
      }
      item.transactions=staged.transactions;item.cursors=staged.cursors;item.updateStatus=ready?staged.updateStatus:"NOT_READY";s.annotations=annotations;item.lastSynced=new Date().toISOString();item.error=null;
    }catch(e){item.error=message(e);}
  }
  async function handle(req:IncomingMessage,res:ServerResponse,next?:()=>void){
    if(!req.url?.startsWith("/api/finance")){next?.();return;}
    const send=(code:number,data:unknown)=>{res.statusCode=code;res.setHeader("Content-Type","application/json");res.setHeader("Cache-Control","no-store");res.end(JSON.stringify(data));};
    const host=req.headers.host||"";if(!/^(localhost|127\.0\.0\.1):\d+$/.test(host))return send(403,{error:"Finance connections are only available on this Mac."});
    if((req.headers.origin&&req.headers.origin!==`http://${host}`)||req.headers["sec-fetch-site"]==="cross-site")return send(403,{error:"Open finances from your local workspace."});
    const path=new URL(req.url,`http://${host}`).pathname.slice("/api/finance".length)||"/";
    try{
      if(req.method==="GET"&&path==="/")return send(200,view(await read()));
      if(req.method!=="POST")return send(405,{error:"Method not allowed"});
      if(!req.headers["content-type"]?.startsWith("application/json"))return send(415,{error:"JSON is required"});
      const chunks:Buffer[]=[];let size=0;for await(const part of req){const b=Buffer.from(part);size+=b.length;if(size>64000)throw new FinanceError("Request is too large.",413);chunks.push(b);}const body=JSON.parse(Buffer.concat(chunks).toString("utf8")||"{}");
      const result=await exclusive(async()=>{const s=await read();
        if(path==="/configure"){
          const config=configSchema.parse(body);if(s.items.length)throw new FinanceError("Disconnect your existing bank connections before changing Plaid credentials.",409);
          await plaid(config,"/institutions/get",{count:1,offset:0,country_codes:["US"]});s.config=config;await write(s);return view(s);
        }
        if(path==="/link"){
          const input=z.object({itemId:z.string().optional()}).strict().parse(body);const item=input.itemId?s.items.find(i=>i.id===input.itemId):undefined;if(input.itemId&&!item)throw new FinanceError("This bank is no longer connected.",404);
          const data=await plaid(s.config,"/link/token/create",{user:{client_user_id:s.userId},client_name:"Personal Workspace",country_codes:["US"],language:"en",...(item?{access_token:item.token}:{products:["transactions"],transactions:{days_requested:90}})});await write(s);return {linkToken:z.string().parse(data.link_token)};
        }
        if(path==="/exchange"){
          const input=z.object({publicToken:z.string().min(1).max(1000)}).strict().parse(body);const hash=createHash("sha256").update(input.publicToken).digest("hex");if(s.exchanges[hash])return view(s);
          const data=await plaid(s.config,"/item/public_token/exchange",{public_token:input.publicToken});const exchange=z.object({access_token:z.string(),item_id:z.string()}).parse(data);
          const existing=s.items.find(i=>i.id===exchange.item_id);if(existing){existing.token=exchange.access_token;}else{s.items.push({id:exchange.item_id,token:exchange.access_token,name:"Bank connection",accounts:[],selected:[],cursors:{},transactions:[],lastSynced:null,error:null,updateStatus:null});}s.exchanges[hash]=exchange.item_id;await write(s);
          const item=s.items.find(i=>i.id===exchange.item_id)!;try{const info=z.object({item:z.object({institution_id:z.string().nullable()})}).parse(await plaid(s.config,"/item/get",{access_token:item.token}));if(info.item?.institution_id){item.institutionId=info.item.institution_id;const institution=z.object({institution:z.object({name:z.string()})}).parse(await plaid(s.config,"/institutions/get_by_id",{institution_id:info.item.institution_id,country_codes:["US"]}));item.name=String(institution.institution?.name||"Bank connection").slice(0,200);}await accounts(s,item);}catch(e){item.error=message(e);}await write(s);return view(s);
        }
        if(path==="/accounts"){
          const input=z.object({itemId:z.string(),accountIds:z.array(z.string()).max(100)}).strict().parse(body);const item=s.items.find(i=>i.id===input.itemId);if(!item)throw new FinanceError("This bank is no longer connected.",404);
          const kept=item.selected.filter(id=>input.accountIds.includes(id));if(kept.length!==item.selected.length){item.accounts=item.accounts.map(a=>({...a,selected:kept.includes(a.id),current:kept.includes(a.id)?a.current:null,available:kept.includes(a.id)?a.available:null}));prune(s,item);await write(s);}
          const additions=input.accountIds.filter(id=>!item.selected.includes(id));if(additions.length)await accounts(s,item);if(new Set(input.accountIds).size!==input.accountIds.length||input.accountIds.some(id=>!item.accounts.some(a=>a.id===id&&!a.blocked&&["depository","credit"].includes(a.type))))throw new FinanceError("Choose personal checking, savings, or credit card accounts from this connection.");
          if(input.accountIds.length&&!item.institutionId)throw new FinanceError("Sync this bank’s account details before selecting accounts.",409);
          if(input.accountIds.length&&item.institutionId&&s.items.some(other=>other.id!==item.id&&other.institutionId===item.institutionId&&other.selected.length))throw new FinanceError("Accounts from this bank are already selected in another connection. Use Repair connection, or deselect the old connection before selecting a replacement.",409);
          item.selected=input.accountIds;item.accounts=item.accounts.map(a=>({...a,selected:input.accountIds.includes(a.id),current:null,available:null}));prune(s,item);await write(s);if(item.selected.length){await syncItem(s,item);await write(s);}return view(s);
        }
        if(path==="/sync"){for(const item of s.items)await syncItem(s,item);await write(s);return view(s);}
        if(path==="/annotate"){
          const input=noteSchema.parse(body);if(!s.items.some(i=>i.transactions.some(t=>t.id===input.transactionId)))throw new FinanceError("This transaction is no longer available. Refresh and try again.",409);
          const current=s.annotations[input.transactionId];if((current?.revision||0)!==input.revision)throw new FinanceError("These notes changed elsewhere. Reopen the transaction before editing.",409);
          s.annotations[input.transactionId]={category:input.category,note:input.note,excludeFromSpending:input.excludeFromSpending,revision:input.revision+1};await write(s);return view(s);
        }
        if(path==="/disconnect"){
          const {itemId}=z.object({itemId:z.string()}).strict().parse(body);const item=s.items.find(i=>i.id===itemId);if(!item)throw new FinanceError("This bank is no longer connected.",404);await plaid(s.config,"/item/remove",{access_token:item.token});for(const t of item.transactions)delete s.annotations[t.id];s.items=s.items.filter(i=>i.id!==itemId);for(const [key,id] of Object.entries(s.exchanges))if(id===itemId)delete s.exchanges[key];await write(s);return view(s);
        }
        throw new FinanceError("Unknown finance action.",404);
      });send(200,result);
    }catch(e){send(e instanceof FinanceError?e.status:e instanceof StoreBusyError?409:e instanceof z.ZodError||e instanceof SyntaxError?400:500,{error:e instanceof z.ZodError||e instanceof SyntaxError?"Check the connection details and selected accounts.":message(e)});}
  }
  return {handle};
}
export function finance():Plugin {const service=createFinanceService(process.env.WORKSPACE_DATA_DIR||join(homedir(),"Data/personal-workspace"));return {name:"personal-finances",configureServer(server){server.middlewares.use(service.handle);}};}

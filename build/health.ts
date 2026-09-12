import { readFile, mkdir, chmod, rename, unlink } from "node:fs/promises";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from "node:crypto";
import { createServer, type Server } from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, ViteDevServer } from "vite";
import { z } from "zod";
import { healthSnapshotSchema, weightInputSchema, type HealthView, type HealthSnapshot, type WeightCommand } from "../lib/health.ts";
import { withPrivateLock, writePrivateJson, StoreBusyError } from "./private-store.ts";
import { emptySleep, mergeSleepBatch, sleepBatchSchema, sleepNoteInputSchema, sleepSettingsSchema, type SleepArchive } from "../lib/sleep.ts";

type PhoneScope="health"|"workspace";
type State={version:1;enabled:boolean;address?:string;tokenHash?:string;tokenScope?:PhoneScope;pairing?:{hash:string;expires:number;scope?:PhoneScope};snapshot:HealthSnapshot|null;lastSynced:string|null;commands:WeightCommand[]};
type WorkspaceResponse={status:number;data:unknown};
type WorkspaceRequest=(path:string,method:"GET"|"POST"|"PUT",body?:unknown)=>Promise<WorkspaceResponse>;
type HealthServiceOptions={addresses?:()=>string[];port?:number;workspaceRequest?:WorkspaceRequest};
class HealthError extends Error {readonly status:number;constructor(message:string,status=400){super(message);this.status=status;}}
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const matches=(value:string,expected?:string)=>!!expected&&expected.length===64&&timingSafeEqual(Buffer.from(hash(value),"hex"),Buffer.from(expected,"hex"));
export const lanAddresses=()=>Object.values(networkInterfaces()).flatMap(entries=>entries||[]).filter(a=>a.family==="IPv4"&&!a.internal&&/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)).map(a=>a.address).filter((a,i,all)=>all.indexOf(a)===i);
const errorMessage=(e:unknown)=>e instanceof HealthError||e instanceof StoreBusyError?e.message:"Health sync could not finish. The last saved snapshot has been kept.";
const phoneWorkspaceRoutes:Record<string,{path:string;method:"GET"|"POST"|"PUT";max?:number}>={
  "GET /workspace":{path:"/api/workspace",method:"GET"},
  "POST /workspace":{path:"/api/workspace",method:"PUT",max:2_000_000},
  "GET /climbing":{path:"/api/climbing",method:"GET"},
  "POST /climbing":{path:"/api/climbing",method:"PUT",max:3_000_000},
  "GET /finance":{path:"/api/finance",method:"GET"},
  "POST /finance/sync":{path:"/api/finance/sync",method:"POST"},
  "POST /finance/annotate":{path:"/api/finance/annotate",method:"POST",max:64_000},
  "GET /writing":{path:"/api/writing",method:"GET"},
  "POST /writing/save":{path:"/api/writing/save",method:"POST",max:500_000},
  "GET /integrations":{path:"/api/integrations",method:"GET"},
  "POST /integrations/sync":{path:"/api/integrations/sync",method:"POST",max:64_000},
  "POST /integrations/mutate":{path:"/api/integrations/mutate",method:"POST",max:64_000},
  "POST /integrations/unlink":{path:"/api/integrations/unlink",method:"POST",max:64_000},
  "GET /health-view":{path:"/api/health",method:"GET"},
};

export function createHealthService(directory:string,options:HealthServiceOptions={}){
  const file=join(directory,"health.private.json");const certificate=join(directory,"health-certificate.pem");const privateKey=join(directory,"health-key.pem");
  const sleepFile=join(directory,"sleep.private.json");
  let server:Server|undefined;let endpoint:string|null=null;let runtimeError:string|null=null;let queue:Promise<unknown>=Promise.resolve();
  const addresses=options.addresses||lanAddresses;
  const exclusive=<T>(fn:()=>Promise<T>)=>{const next=queue.catch(()=>{}).then(()=>withPrivateLock(file,fn));queue=next;return next;};
  async function read():Promise<State>{try{const state=JSON.parse(await readFile(file,"utf8"));if(state.version!==1||!Array.isArray(state.commands)||typeof state.enabled!=="boolean")throw new Error();if(state.tokenHash&&!state.tokenScope)state.tokenScope="health";if(state.pairing&&!state.pairing.scope)state.pairing.scope="health";return state;}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return {version:1,enabled:false,snapshot:null,lastSynced:null,commands:[]};throw new HealthError("Saved health data could not be read. It has been left untouched.",500);}}
  const write=(s:State)=>writePrivateJson(file,s);
  async function readSleep():Promise<SleepArchive>{try{const archive=JSON.parse(await readFile(sleepFile,"utf8"));if(archive.version!==1||!Array.isArray(archive.samples)||!Array.isArray(archive.days)||!Array.isArray(archive.notes)||!Array.isArray(archive.ranges)||!sleepSettingsSchema.safeParse(archive.settings).success)throw new Error();archive.settingsRevision??=0;return archive;}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return emptySleep();throw new HealthError("Saved sleep data could not be read. It has been left untouched.",500);}}
  function view(s:State):HealthView{return {enabled:s.enabled,online:!!server?.listening,paired:!!s.tokenHash,phoneScope:s.tokenHash?s.tokenScope??"health":null,endpoint,addresses:addresses(),error:runtimeError,lastSynced:s.lastSynced,snapshot:s.snapshot,commands:s.commands};}
  async function generateCertificate(address:string){
    await mkdir(directory,{recursive:true,mode:0o700});const suffix=randomUUID();const key=`${privateKey}.${suffix}.tmp`;const cert=`${certificate}.${suffix}.tmp`;
    try{await promisify(execFile)("openssl",["req","-x509","-newkey","rsa:2048","-sha256","-nodes","-keyout",key,"-out",cert,"-days","365","-subj","/CN=Personal Workspace Health","-addext",`subjectAltName=IP:${address}`,"-addext","extendedKeyUsage=serverAuth","-addext","keyUsage=critical,digitalSignature,keyEncipherment"],{timeout:20000});await chmod(key,0o600);await chmod(cert,0o600);await rename(key,privateKey);await rename(cert,certificate);}catch{throw new HealthError("The private health certificate could not be created. OpenSSL is required on this Mac.",500);}finally{await unlink(key).catch(()=>{});await unlink(cert).catch(()=>{});}
  }
  const send=(res:ServerResponse,code:number,data:unknown)=>{res.statusCode=code;res.setHeader("Content-Type","application/json");res.setHeader("Cache-Control","no-store");res.end(JSON.stringify(data));};
  async function body(req:IncomingMessage,max=2_000_000){if(!req.headers["content-type"]?.startsWith("application/json"))throw new HealthError("JSON is required.",415);let size=0;const chunks:Buffer[]=[];for await(const part of req){const b=Buffer.from(part);size+=b.length;if(size>max)throw new HealthError("This request is too large.",413);chunks.push(b);}return JSON.parse(Buffer.concat(chunks).toString("utf8")||"{}");}
  async function phone(req:IncomingMessage,res:ServerResponse){
    try{
      const path=req.url?.split("?")[0];if(req.headers.origin)throw new HealthError("Only the paired companion app can use this endpoint.",403);
      const credential=req.headers.authorization?.replace(/^Bearer /,"")||"";if(credential.length>200)throw new HealthError("Pair this iPhone again.",401);
      const initial=await read();if(!initial.enabled)throw new HealthError("iPhone sync is disabled.",403);
      if(path==="/pair"&&req.method==="POST"){
        const result=await exclusive(async()=>{const s=await read();if(!s.enabled||!s.pairing||s.pairing.expires<Date.now()||!matches(credential,s.pairing.hash))throw new HealthError("This pairing code expired or was already used. Create a new pairing file on your Mac.",401);const token=randomBytes(32).toString("base64url");s.tokenHash=hash(token);s.tokenScope=s.pairing.scope??"health";delete s.pairing;await write(s);return {token,scope:s.tokenScope};});send(res,200,result);return;
      }
      if(!matches(credential,initial.tokenHash))throw new HealthError("Pair this iPhone again.",401);
      if(path==="/capabilities"&&req.method==="GET"){send(res,200,{version:2,scope:initial.tokenScope??"health",workspace:(initial.tokenScope??"health")==="workspace",health:true});return;}
      if(path==="/commands"&&req.method==="GET"){send(res,200,{commands:initial.commands.filter(c=>c.status==="pending")});return;}
      const workspaceRoute=phoneWorkspaceRoutes[`${req.method} ${path}`];
      if(workspaceRoute){
        if((initial.tokenScope??"health")!=="workspace")throw new HealthError("This phone is paired for Health only. Download a new Workspace pairing file on your Mac and pair again.",403);
        if(!options.workspaceRequest)throw new HealthError("Workspace data is unavailable. Keep the desktop Workspace open and try again.",503);
        const input=req.method==="POST"?await body(req,workspaceRoute.max??2_000_000):undefined;
        let result:WorkspaceResponse;try{result=await options.workspaceRequest(workspaceRoute.path,workspaceRoute.method,input);}catch{throw new HealthError("The desktop Workspace could not complete this request. Its saved data has been kept.",503);}
        send(res,result.status,result.data);return;
      }
      if(req.method!=="POST")throw new HealthError("Unknown health endpoint.",404);
      const input=await body(req,path==="/sleep-batch"?20_000_000:2_000_000);
      const result=await exclusive(async()=>{const s=await read();if(!s.enabled||!matches(credential,s.tokenHash))throw new HealthError("Pair this iPhone again.",401);
        if(path==="/snapshot"){
          const snapshot=healthSnapshotSchema.parse(input);if(Date.parse(snapshot.generatedAt)>Date.now()+300000)throw new HealthError("Check the iPhone’s clock before syncing.");if(s.snapshot&&Date.parse(snapshot.generatedAt)<Date.parse(s.snapshot.generatedAt))throw new HealthError("A newer health snapshot is already saved.",409);
          s.snapshot=snapshot;s.lastSynced=new Date().toISOString();await write(s);return {saved:true};
        }
        if(path==="/sleep-batch"){
          const batch=sleepBatchSchema.parse(input);
          if(Date.parse(batch.generatedAt)>Date.now()+300000||Date.parse(batch.to)>Date.now()+86400000)throw new HealthError("Check the iPhone’s clock before syncing.");
          const archive=await readSleep();let merged:SleepArchive;
          try{merged=mergeSleepBatch(archive,batch);}catch(e){throw new HealthError((e as Error).message,409);}
          await writePrivateJson(sleepFile,merged);return {saved:true};
        }
        if(path==="/receipt"){
          const receipt=z.object({id:z.string().uuid(),payloadHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(input);const command=s.commands.find(c=>c.id===receipt.id);if(!command||command.payloadHash!==receipt.payloadHash)throw new HealthError("This health entry does not match the saved request.",409);command.status="applied";command.appliedAt??=new Date().toISOString();await write(s);return {saved:true};
        }
        throw new HealthError("Unknown health endpoint.",404);
      });send(res,200,result);
    }catch(e){send(res,e instanceof HealthError?e.status:e instanceof StoreBusyError?409:e instanceof z.ZodError||e instanceof SyntaxError?400:500,{error:e instanceof z.ZodError||e instanceof SyntaxError?"Check the health snapshot or entry format.":errorMessage(e)});}
  }
  async function stop(){const old=server;server=undefined;endpoint=null;if(old){old.closeAllConnections();await new Promise<void>(resolve=>old.close(()=>resolve()));}}
  async function start(s:State){
    if(!s.enabled||!s.address)return;if(server?.listening){runtimeError=null;return;}
    if(!addresses().includes(s.address))throw new HealthError("The Mac’s network address changed. Disable sync, then enable and pair again.");
    const cert=await readFile(certificate);const x509=new X509Certificate(cert);if(!x509.checkIP(s.address)||Date.parse(x509.validTo)<Date.now())throw new HealthError("The health certificate needs renewal. Disable sync, then enable and pair again.");
    const candidate=createServer({key:await readFile(privateKey),cert,minVersion:"TLSv1.2"},phone);candidate.requestTimeout=30000;candidate.headersTimeout=15000;candidate.maxRequestsPerSocket=50;
    try{await new Promise<void>((resolve,reject)=>{candidate.once("error",reject);candidate.listen(options.port??5174,s.address,()=>{candidate.removeListener("error",reject);resolve();});});candidate.on("error",()=>{runtimeError="The iPhone connection stopped. Disable and enable sync to retry.";});server=candidate;const address=candidate.address();endpoint=`https://${s.address}:${typeof address==="object"&&address?address.port:5174}`;runtimeError=null;}catch{candidate.close();throw new HealthError("The health connection could not listen on this address. Check the Wi-Fi connection and whether port 5174 is already in use.",503);}
  }
  async function resume(){try{await exclusive(async()=>start(await read()));}catch(e){runtimeError=errorMessage(e);}}
  async function handle(req:IncomingMessage,res:ServerResponse,next?:()=>void){
    if(!req.url?.startsWith("/api/health")){next?.();return;}
    const host=req.headers.host||"";if(!/^(localhost|127\.0\.0\.1):\d+$/.test(host)||(req.headers.origin&&req.headers.origin!==`http://${host}`)||req.headers["sec-fetch-site"]==="cross-site")return send(res,403,{error:"Open health settings from your local workspace."});
    const path=new URL(req.url,`http://${host}`).pathname.slice("/api/health".length)||"/";
    try{
      if(path==="/"&&req.method==="GET")return send(res,200,view(await read()));
      if(path==="/sleep"&&req.method==="GET")return send(res,200,await readSleep());
      if(req.method!=="POST")throw new HealthError("Method not allowed.",405);const input=await body(req,path==="/sleep/note"?40000:10000);
      const result=await exclusive(async()=>{const s=await read();
        if(path==="/sleep/settings"){const archive=await readSleep();const {revision,...settings}=sleepSettingsSchema.extend({revision:z.number().int().nonnegative()}).parse(input);if(revision!==archive.settingsRevision)throw new HealthError("Sleep settings changed in another window. Refresh to review the current settings before saving.",409);archive.settings=settings;archive.settingsRevision++;await writePrivateJson(sleepFile,archive);return {settings:archive.settings,settingsRevision:archive.settingsRevision};}
        if(path==="/sleep/note"){
          const note=sleepNoteInputSchema.parse(input);const archive=await readSleep();const old=archive.notes.find(n=>n.date===note.date);
          if(note.revision!==(old?.revision||0))throw new HealthError("This note changed in another window. Your text is still here; reload the saved note before replacing it.",409);
          const saved={...note,tags:[...new Set(note.tags)],revision:note.revision+1,updatedAt:new Date().toISOString()};archive.notes=[...archive.notes.filter(n=>n.date!==note.date),saved];await writePrivateJson(sleepFile,archive);return {note:saved};
        }
        if(path==="/open-companion"){await promisify(execFile)("/usr/bin/open",[join(process.cwd(),"companion/WorkspaceHealth.xcodeproj")]);return {opened:true};}
        if(path==="/retry"){await start(s);return view(s);}
        if(path==="/enable"){
          const {address}=z.object({address:z.string()}).strict().parse(input);if(!addresses().includes(address))throw new HealthError("Choose this Mac’s current Wi-Fi address.");if(s.enabled)throw new HealthError("Disable the existing iPhone connection before setting it up again.",409);
          await generateCertificate(address);s.address=address;s.enabled=true;delete s.tokenHash;delete s.tokenScope;delete s.pairing;await start(s);await write(s);return view(s);
        }
        if(path==="/disable"){s.enabled=false;delete s.tokenHash;delete s.tokenScope;delete s.pairing;await write(s);await stop();runtimeError=null;return view(s);}
        if(path==="/pairing"){
          if(!s.enabled||!server?.listening||!endpoint)throw new HealthError("Enable the iPhone connection first.");const code=randomBytes(32).toString("base64url");s.pairing={hash:hash(code),expires:Date.now()+600000,scope:"workspace"};await write(s);const cert=new X509Certificate(await readFile(certificate));return {version:2,type:"personal-workspace-pairing",scope:"workspace",url:endpoint,fingerprint:hashBuffer(cert.raw),code,expiresAt:new Date(s.pairing.expires).toISOString()};
        }
        if(path==="/weight"){
          const value=weightInputSchema.parse(input);if(!s.tokenHash)throw new HealthError("Pair your iPhone before sending a health entry.");if(Date.parse(value.measuredAt)>Date.now()+300000)throw new HealthError("A measurement cannot be in the future.");const payloadHash=hash(JSON.stringify({id:value.id,kg:value.kg,measuredAt:value.measuredAt}));const old=s.commands.find(c=>c.id===value.id);if(old){if(old.payloadHash!==payloadHash)throw new HealthError("This request ID already belongs to another health entry.",409);return view(s);}if(s.commands.filter(c=>c.status==="pending").length>=100)throw new HealthError("Review the pending entries on your iPhone first.");s.commands.push({...value,kind:"weight",payloadHash,status:"pending",createdAt:new Date().toISOString(),appliedAt:null});await write(s);return view(s);
        }
        throw new HealthError("Unknown health action.",404);
      });send(res,200,result);
    }catch(e){send(res,e instanceof HealthError?e.status:e instanceof StoreBusyError?409:e instanceof z.ZodError||e instanceof SyntaxError?400:500,{error:e instanceof z.ZodError||e instanceof SyntaxError?"Check the health connection settings.":errorMessage(e)});}
  }
  return {handle,resume,stop};
}
const hashBuffer=(value:Buffer)=>createHash("sha256").update(value).digest("hex");
async function loopbackWorkspace(server:ViteDevServer,path:string,method:"GET"|"POST"|"PUT",body?:unknown):Promise<WorkspaceResponse>{
  const address=server.httpServer?.address();
  if(!address||typeof address==="string")throw new HealthError("The desktop Workspace is not listening yet.",503);
  const response=await fetch(`http://127.0.0.1:${address.port}${path}`,{method,headers:body===undefined?undefined:{"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45_000)});
  const text=await response.text();
  if(Buffer.byteLength(text)>10_000_000)throw new HealthError("This Workspace response is too large for the phone. Narrow the requested history on the Mac.",413);
  let data:unknown;try{data=JSON.parse(text||"{}");}catch{throw new HealthError("The desktop Workspace returned an unreadable response.",502);}
  return {status:response.status,data};
}
export function health():Plugin {
  let desktop:ViteDevServer|undefined;
  const service=createHealthService(process.env.WORKSPACE_DATA_DIR||join(homedir(),"Data/personal-workspace"),{workspaceRequest:(path,method,body)=>{
    if(!desktop)throw new HealthError("The desktop Workspace is not available.",503);
    return loopbackWorkspace(desktop,path,method,body);
  }});
  return {name:"personal-health",configureServer(server){desktop=server;server.middlewares.use(service.handle);void service.resume();server.httpServer?.once("listening",()=>{void service.resume();});server.httpServer?.once("close",()=>{void service.stop();});}};
}

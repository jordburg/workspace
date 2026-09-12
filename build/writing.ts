import { readFile, readdir, realpath, lstat, open, link, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { parseDocument, stringify } from "yaml";
import { fromMarkdown } from "mdast-util-from-markdown";
import { z } from "zod";
import { siteThreads, writingInputSchema, type SiteEntry, type WritingDraft, type WritingView } from "../lib/writing.ts";
import { withPrivateLock, writePrivateJson, StoreBusyError } from "./private-store.ts";

class WritingError extends Error {readonly status: number; constructor(message: string, status=400) {super(message); this.status=status;}}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const reserved = new Set(["notes", "systems", "tools", "work", "signal-mapping", "working-interface", "field-notes", "decision-ledger", "evidence-desk", "small-manuals", "archive", "main-content", "archive-selection", "about", "about-heading", "mobile-thread-heading", "mobile-entry-heading", ...siteThreads, ...siteThreads.flatMap(t=>[`thread-${t}-heading`,`thread-${t}-entries`,`thread-${t}-connections`])]);
const receiptSchema = z.object({file:z.string(),hash:z.string().regex(/^[a-f0-9]{64}$/),order:z.number().int().positive(),at:z.string().datetime()}).strict();
// The input schema is strict; validate its fields independently of saved metadata.
function parseDraft(value: WritingDraft): WritingDraft {
  const {updatedAt, exported, ...input}=value;
  return {...writingInputSchema.parse(input), updatedAt:z.string().datetime().parse(updatedAt), exported:receiptSchema.nullable().parse(exported)};
}
type State = {version:1; drafts:WritingDraft[]; pending: Record<string,{content:string; hash:string; order:number; file:string; at:string}>};
export function renderSiteEntry(draft: WritingDraft, order: number) {
  return `---\n${stringify({order, title:draft.title, timeframe:draft.timeframe, kind:draft.kind, format:draft.format, summary:draft.summary, topics:draft.topics, relatedEntries:draft.relatedEntries, primaryThread:draft.primaryThread, threads:draft.threads, draft:true})}---\n\n${draft.body.trim()}\n`;
}
export function createWritingService(directory: string, repository: string) {
  const file=join(directory,"writing.private.json"); const repo=resolve(repository); const contentDirectory=join(repo,"src/content/entries");
  let queue:Promise<unknown>=Promise.resolve();
  const exclusive=<T>(fn:()=>Promise<T>)=>{const next=queue.catch(()=>{}).then(()=>withPrivateLock(file,fn));queue=next;return next;};
  async function read():Promise<State>{
    try {const value=JSON.parse(await readFile(file,"utf8")); if(value.version!==1||!Array.isArray(value.drafts)||!value.pending||typeof value.pending!=="object")throw new Error(); return {...value,drafts:value.drafts.map(parseDraft)};}
    catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return {version:1,drafts:[],pending:{}};throw new WritingError("Your writing drafts could not be read. The saved file has been left untouched.",500);}
  }
  async function entries():Promise<SiteEntry[]> {
    if(await realpath(repo)!==repo || await realpath(contentDirectory)!==contentDirectory)throw new WritingError("The site folder must be a real local folder, without redirected content paths.",409);
    const pkg=JSON.parse(await readFile(join(repo,"package.json"),"utf8")); if(pkg.name!=="personal-site")throw new WritingError("The connected folder is not your personal-site project.",409);
    const files=await readdir(contentDirectory,{withFileTypes:true}); const result:SiteEntry[]=[];
    for(const entry of files) {
      if(entry.isDirectory()||entry.isSymbolicLink())throw new WritingError("The site’s content layout has changed. Review the connection before adding entries.",409);
      if(!entry.name.endsWith(".md"))continue;
      const path=join(contentDirectory,entry.name);const stat=await lstat(path);if(!stat.isFile()||stat.size>500000)throw new WritingError("A site entry could not be read safely.",409);
      const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let text:string;try{text=await handle.readFile("utf8");}finally{await handle.close();}
      const match=text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/); if(!match)throw new WritingError(`Check the metadata in ${entry.name} before adding another entry.`,409);
      const document=parseDocument(match[1],{uniqueKeys:true,stringKeys:true}); if(document.errors.length||document.warnings.length)throw new WritingError(`Check the metadata in ${entry.name} before adding another entry.`,409);
      const data=z.object({order:z.number().int().positive(),title:z.string(),summary:z.string(),kind:z.enum(["work","idea","writing"]),primaryThread:z.string(),draft:z.boolean().optional()}).parse(document.toJS({maxAliasCount:0}));
      result.push({slug:entry.name.slice(0,-3),title:data.title,summary:data.summary,kind:data.kind,order:data.order,draft:data.draft??false,primaryThread:data.primaryThread});
    }
    if(new Set(result.map(e=>e.order)).size!==result.length)throw new WritingError("Two site entries use the same order. Resolve that in the site before adding another entry.",409);
    return result.sort((a,b)=>a.order-b.order);
  }
  async function view(state?:State):Promise<WritingView>{
    const s=state||await read();try{return {repository:repo,available:true,error:null,entries:await entries(),drafts:s.drafts,pendingExports:Object.keys(s.pending)};}
    catch(e){return {repository:repo,available:false,error:e instanceof WritingError?e.message:"The personal site could not be read. Your Workspace drafts are still available.",entries:[],drafts:s.drafts,pendingExports:Object.keys(s.pending)};}
  }
  async function exportDraft(state:State,draft:WritingDraft){
    if(draft.exported)return;
    await entries();
    return withPrivateLock(join(repo,".workspace-writing"),async()=>{
    const current=await entries();
    if(!draft.body.trim()||!draft.summary.trim()||!draft.timeframe.trim()||!draft.format.trim())throw new WritingError("Add a summary, timeframe, format, and body before sending this draft to your site.");
    if(reserved.has(draft.slug)||current.some(e=>[`project-${e.slug}-heading`,`project-${e.slug}-feature`].includes(draft.slug)||[`project-${draft.slug}-heading`,`project-${draft.slug}-feature`].includes(e.slug)))throw new WritingError("This address is reserved by the site. Choose another.",409);
    // Inspect parsed Markdown so code examples and autolinks are preserved.
    const nodes: {type:string;children?:unknown[]}[]=[fromMarkdown(draft.body)];
    while(nodes.length){const node=nodes.pop()!;if(node.type==="html")throw new WritingError("Your site accepts Markdown rather than raw HTML. Put HTML examples in a fenced code block.");if(node.children)nodes.push(...node.children as typeof nodes);}
    if(draft.relatedEntries.some(slug=>slug===draft.slug||!current.some(e=>e.slug===slug)))throw new WritingError("Choose up to three existing related entries; the entry cannot link to itself.");
    let pending=state.pending[draft.id];
    const target=join(contentDirectory,`${draft.slug}.md`);
    if(!pending){
      if(current.some(e=>e.slug===draft.slug))throw new WritingError("That site address already exists. Choose another; existing entries are never overwritten.",409);
      const order=Math.max(0,...current.map(e=>e.order))+1;const content=renderSiteEntry(draft,order);
      pending={content,hash:digest(content),order,file:`src/content/entries/${draft.slug}.md`,at:new Date().toISOString()};
      state.pending[draft.id]=pending;await writePrivateJson(file,state);
    }
    // A persisted export intent allows recovery if the file was created but the receipt save failed.
    try {
      const stat=await lstat(target);if(!stat.isFile()||stat.isSymbolicLink())throw new WritingError("That site path already exists and cannot be replaced.",409);
      const handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);let existing:string;try{existing=await handle.readFile("utf8");}finally{await handle.close();}
      if(digest(existing)!==pending.hash)throw new WritingError("The site entry changed outside Workspace. It has been left untouched.",409);
    } catch(e) {
      if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;
      if(current.some(entry=>entry.order===pending.order))throw new WritingError("The site’s ordering changed during this export. Review the pending draft before retrying.",409);
      const temporary=join(contentDirectory,`.workspace-${randomUUID()}.tmp`);const handle=await open(temporary,"wx",0o600);
      try {await handle.writeFile(pending.content);await handle.sync();await handle.close();await link(temporary,target);}
      catch(e){await handle.close().catch(()=>{});if((e as NodeJS.ErrnoException).code==="EEXIST")throw new WritingError("That site address was just created elsewhere. It has been left untouched.",409);throw e;}
      finally{await unlink(temporary).catch(()=>{});}
    }
    await entries();
    draft.exported={file:pending.file,hash:pending.hash,order:pending.order,at:pending.at};draft.revision++;draft.updatedAt=new Date().toISOString();delete state.pending[draft.id];await writePrivateJson(file,state);
    });
  }
  async function handle(req:IncomingMessage,res:ServerResponse){
    const send=(code:number,data:unknown)=>{res.statusCode=code;res.setHeader("Content-Type","application/json");res.setHeader("Cache-Control","no-store");res.end(JSON.stringify(data));};
    try {
      const host=req.headers.host||"";if(!/^(localhost|127\.0\.0\.1):\d+$/.test(host)||(req.headers.origin&&req.headers.origin!==`http://${host}`)||req.headers["sec-fetch-site"]==="cross-site")throw new WritingError("Only this local Workspace can access your writing.",403);
      const path=(req.url||"/").split("?")[0].replace(/^\/api\/writing/,"")||"/";
      if(req.method==="GET"&&path==="/"){send(200,await view());return;}
      if(req.method!=="POST")throw new WritingError("Unknown writing action.",404);
      if(!req.headers["content-type"]?.startsWith("application/json"))throw new WritingError("JSON is required.",415);
      let size=0;const chunks:Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>500000)throw new WritingError("This draft is too large.",413);chunks.push(Buffer.from(chunk));}
      const input=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const result=await exclusive(async()=>{
        const state=await read();
        if(path==="/save"){
          const next=writingInputSchema.parse(input);const existing=state.drafts.find(d=>d.id===next.id);
          if(existing?.exported)throw new WritingError("This draft has already been sent to the site. Continue editing in the site project.",409);
          if(state.pending[next.id])throw new WritingError("This draft has an unfinished handoff. Retry it, or recover the Workspace draft before editing.",409);
          if(next.revision!==(existing?.revision??0))throw new WritingError("This draft changed in another window. Your text is kept here; save it as a separate draft to preserve both versions.",409);
          if(state.drafts.some(d=>d.id!==next.id&&d.slug===next.slug))throw new WritingError("Another draft uses that address. Choose a unique address.",409);
          if(!existing&&state.drafts.length>=500)throw new WritingError("Your writing collection has reached its local limit.");
          const draft={...next,revision:next.revision+1,updatedAt:new Date().toISOString(),exported:null};state.drafts=existing?state.drafts.map(d=>d.id===next.id?draft:d):[...state.drafts,draft];await writePrivateJson(file,state);
        } else if(path==="/export") {
          const {id,revision}=z.object({id:z.string().uuid(),revision:z.number().int().nonnegative()}).strict().parse(input);const draft=state.drafts.find(d=>d.id===id);if(!draft)throw new WritingError("Save this draft first.",404);
          if(!draft.exported&&draft.revision!==revision)throw new WritingError("The saved draft has changed. Review the latest version before sending it to the site.",409);
          await exportDraft(state,draft);
        } else if(path==="/recover") {
          const {id,revision}=z.object({id:z.string().uuid(),revision:z.number().int().nonnegative()}).strict().parse(input);const draft=state.drafts.find(d=>d.id===id);const pending=state.pending[id];
          if(!draft||!pending||draft.revision!==revision)throw new WritingError("Reload the latest saved draft before recovering this handoff.",409);
          await entries();let matches=false;
          try{const handle=await open(join(contentDirectory,`${draft.slug}.md`),constants.O_RDONLY|constants.O_NOFOLLOW);try{matches=digest(await handle.readFile("utf8"))===pending.hash;}finally{await handle.close();}}
          catch(e){if(!["ENOENT","ELOOP"].includes((e as NodeJS.ErrnoException).code||""))throw e;}
          if(matches)draft.exported={file:pending.file,hash:pending.hash,order:pending.order,at:pending.at};
          delete state.pending[id];draft.revision++;draft.updatedAt=new Date().toISOString();await writePrivateJson(file,state);
        } else throw new WritingError("Unknown writing action.",404);
        return view(state);
      });send(200,result);
    } catch(e){send(e instanceof WritingError?e.status:e instanceof StoreBusyError?409:e instanceof z.ZodError||e instanceof SyntaxError?400:500,{error:e instanceof WritingError||e instanceof StoreBusyError?e.message:e instanceof z.ZodError?e.issues[0]?.message:"This writing request could not finish. Your saved data has been kept."});}
  }
  return {handle};
}
export function writing():Plugin {const service=createWritingService(process.env.WORKSPACE_DATA_DIR||join(homedir(),"Data/personal-workspace"),resolve(process.cwd(),"../personal-site"));return {name:"workspace-writing",configureServer(server){server.middlewares.use("/api/writing",service.handle);}};}

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { z } from "zod";
import { climbingStateSchema, emptyClimbing, type ClimbingState } from "../lib/climbing.ts";
import { StoreBusyError, withPrivateLock, writePrivateJson } from "./private-store.ts";

class ClimbingError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status=400, code="invalid_request") { super(message); this.status=status; this.code=code; }
}

export function createClimbingService(directory: string) {
  const file=join(directory,"climbing.private.json"); let queue:Promise<unknown>=Promise.resolve();
  const exclusive=<T>(operation:()=>Promise<T>)=>{const next=queue.catch(()=>{}).then(()=>withPrivateLock(file,operation));queue=next;return next;};
  async function read():Promise<ClimbingState>{try{return climbingStateSchema.parse(JSON.parse(await readFile(file,"utf8")));}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return structuredClone(emptyClimbing);if(e instanceof z.ZodError||e instanceof SyntaxError)throw new ClimbingError("Your climbing log could not be read. The saved file has been left untouched.",500);throw e;}}
  const send=(res:ServerResponse,code:number,value:unknown)=>{res.statusCode=code;res.setHeader("Content-Type","application/json");res.setHeader("Cache-Control","no-store");res.end(JSON.stringify(value));};
  async function handle(req:IncomingMessage,res:ServerResponse){
    try{
      const host=req.headers.host||"";if(!/^(localhost|127\.0\.0\.1):\d+$/.test(host)||(req.headers.origin&&req.headers.origin!==`http://${host}`)||req.headers["sec-fetch-site"]==="cross-site")throw new ClimbingError("Only this local Workspace can access your climbing log.",403);
      if(req.method==="GET"){send(res,200,await read());return;}
      if(req.method!=="PUT")throw new ClimbingError("Method not allowed.",405);
      if(!req.headers["content-type"]?.startsWith("application/json"))throw new ClimbingError("JSON is required.",415);
      let size=0;const chunks:Buffer[]=[];for await(const part of req){const value=Buffer.from(part);size+=value.length;if(size>3_000_000)throw new ClimbingError("Your climbing update is too large.",413);chunks.push(value);}
      const input=climbingStateSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")||"{}"));
      const saved=await exclusive(async()=>{const current=await read();if(input.revision!==current.revision)throw new ClimbingError("Your climbing log changed in another window. Your open draft is still here; review the latest saved records before trying again.",409,"revision_conflict");const next={...input,revision:current.revision+1};await writePrivateJson(file,next);return next;});
      send(res,200,saved);
    }catch(e){send(res,e instanceof ClimbingError?e.status:e instanceof StoreBusyError?423:e instanceof z.ZodError||e instanceof SyntaxError?400:500,{code:e instanceof ClimbingError?e.code:e instanceof StoreBusyError?"store_busy":e instanceof z.ZodError||e instanceof SyntaxError?"invalid_state":"save_failed",error:e instanceof ClimbingError||e instanceof StoreBusyError?e.message:e instanceof z.ZodError?e.issues[0]?.message:"Your climbing update could not be saved. Your existing log has been kept."});}
  }
  return {handle};
}
export function climbing():Plugin {const service=createClimbingService(process.env.WORKSPACE_DATA_DIR||join(homedir(),"Data/personal-workspace"));return {name:"workspace-climbing",configureServer(server){server.middlewares.use("/api/climbing",service.handle);}};}

import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export class StoreBusyError extends Error {constructor(){super("Another request is updating this data. Try again. If this persists after an interrupted save, see the recovery instructions.");}}
async function openPrivateLock(path:string){
  const lockPath=`${path}.lock`;
  const attempt=async()=>{const handle=await open(lockPath,"wx",0o600);await handle.writeFile(JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}));return handle;};
  try{return await attempt();}catch(error){
    if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
    try{
      const [details,info]=await Promise.all([readFile(lockPath,"utf8"),stat(lockPath)]);
      let pid=Number(details);try{const parsed=JSON.parse(details) as {pid?:unknown};pid=typeof parsed.pid==="number"?parsed.pid:pid;}catch{}
      const hasOwner=Number.isInteger(pid)&&pid>0;
      let running:boolean|null=hasOwner?true:null;
      if(hasOwner)try{process.kill(pid,0);}catch(cause){running=(cause as NodeJS.ErrnoException).code!=="ESRCH";}
      const age=Date.now()-info.mtimeMs;
      if((running===false&&age>5_000)||(running===null&&age>5*60_000)){await unlink(lockPath);return await attempt();}
    }catch(cause){if((cause as NodeJS.ErrnoException).code==="ENOENT")return await attempt();throw cause;}
    throw new StoreBusyError();
  }
}
export async function withPrivateLock<T>(path:string,operation:()=>Promise<T>):Promise<T>{
  await mkdir(dirname(path),{recursive:true,mode:0o700});let lock;
  lock=await openPrivateLock(path);
  try{return await operation();}finally{await lock.close();await unlink(`${path}.lock`);}
}
export async function writePrivateJson(path:string,value:unknown){
  await mkdir(dirname(path),{recursive:true,mode:0o700});const tempPath=`${path}.${randomUUID()}.tmp`;const temp=await open(tempPath,"wx",0o600);
  try{await temp.writeFile(JSON.stringify(value));await temp.sync();await temp.close();await rename(tempPath,path);}catch(e){await temp.close().catch(()=>{});throw e;}finally{await unlink(tempPath).catch(()=>{});}
}

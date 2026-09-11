import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export class StoreBusyError extends Error {constructor(){super("Another request is updating this data. Try again. If this persists after an interrupted save, see the recovery instructions.");}}
export async function withPrivateLock<T>(path:string,operation:()=>Promise<T>):Promise<T>{
  await mkdir(dirname(path),{recursive:true,mode:0o700});let lock;
  try{lock=await open(`${path}.lock`,"wx",0o600);}catch(e){if((e as NodeJS.ErrnoException).code==="EEXIST")throw new StoreBusyError();throw e;}
  try{await lock.writeFile(String(process.pid));return await operation();}finally{await lock.close();await unlink(`${path}.lock`);}
}
export async function writePrivateJson(path:string,value:unknown){
  await mkdir(dirname(path),{recursive:true,mode:0o700});const tempPath=`${path}.${randomUUID()}.tmp`;const temp=await open(tempPath,"wx",0o600);
  try{await temp.writeFile(JSON.stringify(value));await temp.sync();await temp.close();await rename(tempPath,path);}catch(e){await temp.close().catch(()=>{});throw e;}finally{await unlink(tempPath).catch(()=>{});}
}

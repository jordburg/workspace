import { z } from "zod";
import { daySchema } from "./workspace.ts";
const timestamp=z.string().datetime({offset:true});
const metric=(max:number)=>z.number().finite().nonnegative().max(max).nullable();
const timeZone=z.string().max(100).refine(value=>{try{new Intl.DateTimeFormat("en",{timeZone:value});return true;}catch{return false;}});
export const healthWorkoutActivitySchema=z.enum(["climbing","walking","running","cycling","swimming","hiking","yoga","traditional-strength-training","functional-strength-training","hiit","other"]);
export const healthWorkoutSchema=z.object({
  id:z.string().uuid(),name:z.string().max(100),start:timestamp,end:timestamp,minutes:z.number().finite().nonnegative().max(10080),
  activity:healthWorkoutActivitySchema.default("other"),sourceId:z.string().min(1).max(500).nullable().default(null),sourceName:z.string().min(1).max(200).nullable().default(null),timeZone:timeZone.nullable().default(null),
}).strict().refine(w=>new Date(w.end)>=new Date(w.start));
export const healthDaySchema=z.object({date:daySchema,steps:metric(200000),sleepMinutes:metric(1500),restingHeartRate:metric(300),weightKg:metric(700)}).strict();
export const healthSnapshotSchema=z.object({version:z.literal(1),id:z.string().uuid(),generatedAt:timestamp,timeZone,from:daySchema,to:daySchema,days:z.array(healthDaySchema).min(1).max(92),workouts:z.array(healthWorkoutSchema).max(2000)}).strict().superRefine((s,ctx)=>{
  const expected=(Date.parse(`${s.to}T00:00:00Z`)-Date.parse(`${s.from}T00:00:00Z`))/86400000+1;
  if(expected<1||expected>92||s.days.length!==expected||new Set(s.days.map(d=>d.date)).size!==expected||s.days.some(d=>d.date<s.from||d.date>s.to))ctx.addIssue({code:"custom",message:"Health snapshot must cover every day in its reporting range."});
});
export type HealthSnapshot=z.input<typeof healthSnapshotSchema>;
export type HealthWorkout=z.input<typeof healthWorkoutSchema>;
export type HealthWorkoutActivity=z.infer<typeof healthWorkoutActivitySchema>;
export type WeightCommand={id:string;kind:"weight";kg:number;measuredAt:string;payloadHash:string;status:"pending"|"applied";createdAt:string;appliedAt:string|null};
export type HealthView={enabled:boolean;online:boolean;paired:boolean;phoneScope:"health"|"workspace"|null;endpoint:string|null;addresses:string[];error:string|null;lastSynced:string|null;snapshot:HealthSnapshot|null;commands:WeightCommand[]};
export const emptyHealth=():HealthView=>({enabled:false,online:false,paired:false,phoneScope:null,endpoint:null,addresses:[],error:null,lastSynced:null,snapshot:null,commands:[]});
export const weightInputSchema=z.object({id:z.string().uuid(),kg:z.number().finite().min(1).max(700),measuredAt:timestamp}).strict();

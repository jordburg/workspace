import { z } from "zod";
import { daySchema } from "../workspace.ts";

export type Provider = "todoist" | "google";
export type LifeArea = "personal" | "independent";
export type Source = { id: string; name: string; area: LifeArea; blocked: boolean; parentId?: string };
export type RemoteTask = { id: string; sourceId: string; sourceName: string; title: string; area: LifeArea; dueDate: string | null; dueTime: string | null; deadline: string | null; recurring: boolean; priority: number; version: string; parentId: string | null; url: string };
export type RemoteEvent = { id: string; sourceId: string; sourceName: string; title: string; area: LifeArea; startDate: string; endDate: string; startTime: string | null; endTime: string | null; allDay: boolean; version: string; editable: boolean; recurring: boolean; url: string; location: string };
export type RemoteMail = { id: string; threadId: string; from: string; replyTo: string; subject: string; snippet: string; receivedAt: string; unread: boolean; starred: boolean; important: boolean; version: string; url: string };
export type Selection = { id: string; area: LifeArea };
export type ProviderState = { connected: boolean; configured: boolean; sources: Source[]; selected: Selection[]; lastSynced: string | null; error: string | null };
export type GmailState = ProviderState & { account: string | null; unreadCount: number };
export const integrationLinkSchema = z.object({
  id: z.string().uuid(), entityKind: z.enum(["goal", "plan"]), entityId: z.string().uuid(), role: z.enum(["goal-next-step", "scheduled-session"]),
  provider: z.enum(["todoist", "google"]), remoteId: z.string().min(1).max(500), requestId: z.string().uuid(), createdAt: z.string().datetime({ offset: true }),
}).strict().superRefine((link, ctx) => {
  const goalTask = link.entityKind === "goal" && link.role === "goal-next-step" && link.provider === "todoist";
  const scheduledSession = link.entityKind === "plan" && link.role === "scheduled-session" && link.provider === "google";
  if (!goalTask && !scheduledSession) ctx.addIssue({ code: "custom", message: "Choose the provider and role that match this linked Workspace item." });
});
export const integrationLinksSchema = z.array(integrationLinkSchema).max(10000).superRefine((links, ctx) => {
  if (new Set(links.map(link => link.id)).size !== links.length) ctx.addIssue({ code: "custom", message: "Integration link IDs must be unique." });
  if (new Set(links.map(link => link.requestId)).size !== links.length) ctx.addIssue({ code: "custom", message: "Each integration request can create only one link." });
  const goalNextSteps = links.filter(link => link.role === "goal-next-step").map(link => link.entityId);
  if (new Set(goalNextSteps).size !== goalNextSteps.length) ctx.addIssue({ code: "custom", message: "A climbing goal can link to only one Todoist next step." });
  const scheduledPlans = links.filter(link => link.role === "scheduled-session").map(link => link.entityId);
  if (new Set(scheduledPlans).size !== scheduledPlans.length) ctx.addIssue({ code: "custom", message: "A climbing plan can link to only one Calendar event." });
});
export type IntegrationLink = z.infer<typeof integrationLinkSchema>;
export type SyncView = { todoist: ProviderState; google: ProviderState; gmail: GmailState; tasks: RemoteTask[]; events: RemoteEvent[]; messages: RemoteMail[]; links: IntegrationLink[]; range: { from: string; to: string; timeZone: string } | null };
export const selectionSchema = z.array(z.object({ id: z.string().min(1).max(500), area: z.enum(["personal", "independent"]) }).strict()).max(100).refine(items => new Set(items.map(i => i.id)).size === items.length, "Choose each source only once");
export const syncRequestSchema = z.object({ date: daySchema, timeZone: z.string().min(1).max(100).refine(zone => { try { new Intl.DateTimeFormat("en", {timeZone: zone}); return true; } catch { return false; } }, "Invalid time zone") }).strict();
export const isArtek = (name: string) => /artek/i.test(name);
export const emptyProvider = (): ProviderState => ({connected:false,configured:false,sources:[],selected:[],lastSynced:null,error:null});
export const emptyGmail = (): GmailState => ({...emptyProvider(),account:null,unreadCount:0});
export const emptySync = (): SyncView => ({todoist:emptyProvider(),google:emptyProvider(),gmail:emptyGmail(),tasks:[],events:[],messages:[],links:[],range:null});

const projectSchema = z.object({id:z.string(),name:z.string(),parent_id:z.string().nullable().optional()});
export function todoistSources(raw: unknown[]): Source[] {
  const projects = raw.map(value => projectSchema.parse(value));
  const blocked = new Set(projects.filter(p => isArtek(p.name)).map(p => p.id));
  let changed = true;
  while (changed) { changed=false; for (const p of projects) if (p.parent_id && blocked.has(p.parent_id) && !blocked.has(p.id)) {blocked.add(p.id);changed=true;} }
  return projects.map(p => ({id:p.id,name:p.name,area:"personal",blocked:blocked.has(p.id),...(p.parent_id ? {parentId:p.parent_id}: {})}));
}
export function googleSources(raw: unknown[]): Source[] {
  return raw.map(value => z.object({id:z.string(),summary:z.string().optional(),summaryOverride:z.string().optional(),accessRole:z.string().optional()}).parse(value)).map(c => ({id:c.id,name:c.summaryOverride || c.summary || c.id,area:"personal",blocked:isArtek(`${c.id} ${c.summary || ""} ${c.summaryOverride || ""}`) || !["owner","writer","reader"].includes(c.accessRole || "")}));
}
export function selectedSources(sources: Source[], selections: Selection[]): Source[] {
  return selections.map(selection => { const source=sources.find(s=>s.id===selection.id && !s.blocked); if(!source) throw new Error("A selected source is unavailable or belongs to Artek. Review your selections."); return {...source,area:selection.area}; });
}
export function localParts(value: string, timeZone: string): {date:string;time:string} {
  const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new Error("Invalid event time");
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(date);
  const part=(type:string)=>parts.find(p=>p.type===type)?.value || "";
  return {date:`${part("year")}-${part("month")}-${part("day")}`,time:`${part("hour")}:${part("minute")}`};
}
export function normalizeTask(raw: unknown, source: Source, timeZone: string): RemoteTask | null {
  const task=z.object({id:z.string(),project_id:z.string(),content:z.string(),checked:z.boolean().optional(),is_deleted:z.boolean().optional(),is_uncompletable:z.boolean().optional(),priority:z.number().optional(),parent_id:z.string().nullable().optional(),updated_at:z.string().optional(),due:z.object({date:z.string(),is_recurring:z.boolean().optional(),timezone:z.string().nullable().optional()}).nullable().optional(),deadline:z.object({date:z.string()}).nullable().optional()}).parse(raw);
  if(task.project_id!==source.id || task.checked || task.is_deleted || task.is_uncompletable) return null;
  let dueDate: string | null=null; let dueTime: string | null=null;
  if(task.due) { const value=task.due.date; if(/[zZ]$|[+-]\d\d:\d\d$/.test(value)) {const parts=localParts(value,timeZone);dueDate=parts.date;dueTime=parts.time;} else {dueDate=daySchema.parse(value.slice(0,10));dueTime=value.includes("T")?value.slice(11,16):null;} }
  return {id:task.id,sourceId:source.id,sourceName:source.name,title:task.content,area:source.area,dueDate,dueTime,deadline:task.deadline?.date || null,recurring:!!task.due?.is_recurring,priority:task.priority || 1,parentId:task.parent_id || null,version:JSON.stringify([task.updated_at,task.content,task.due,task.deadline,task.priority,task.project_id]),url:`https://app.todoist.com/app/task/${encodeURIComponent(task.id)}`};
}
const eventBoundary=z.object({date:z.string().optional(),dateTime:z.string().optional(),timeZone:z.string().optional()});
export function normalizeEvent(raw: unknown, source: Source, timeZone: string): RemoteEvent | null {
  const event=z.object({id:z.string(),status:z.string().optional(),summary:z.string().optional(),location:z.string().optional(),htmlLink:z.string().optional(),etag:z.string(),recurringEventId:z.string().optional(),recurrence:z.array(z.string()).optional(),locked:z.boolean().optional(),attendeesOmitted:z.boolean().optional(),organizer:z.object({self:z.boolean().optional()}).optional(),eventType:z.string().optional(),start:eventBoundary.optional(),end:eventBoundary.optional(),attendees:z.array(z.object({self:z.boolean().optional(),responseStatus:z.string().optional()})).optional()}).parse(raw);
  if(event.status==="cancelled" || event.attendees?.some(a=>a.self&&a.responseStatus==="declined")) return null;
  if(!event.start || !event.end) throw new Error("An event is missing its dates");
  const allDay=!!event.start.date;
  const start=allDay?{date:daySchema.parse(event.start.date),time:null}:localParts(event.start.dateTime || "",timeZone);
  const end=allDay?{date:daySchema.parse(event.end.date),time:null}:localParts(event.end.dateTime || "",timeZone);
  let url="https://calendar.google.com/calendar/u/0/r";
  if(event.htmlLink) { const parsed=new URL(event.htmlLink); if(parsed.protocol==="https:" && ["www.google.com","calendar.google.com"].includes(parsed.hostname)) url=parsed.href; }
  return {id:event.id,sourceId:source.id,sourceName:source.name,title:event.summary || "Busy",area:source.area,startDate:start.date,endDate:end.date,startTime:start.time,endTime:end.time,allDay,version:event.etag,recurring:!!event.recurringEventId,editable:!event.recurrence?.length && !!event.organizer?.self && !event.locked && !event.attendeesOmitted && !event.attendees?.some(a=>!a.self) && (!event.eventType || event.eventType === "default"),url,location:event.location || ""};
}
export function eventOnDay(event: RemoteEvent, day: string) { return event.startDate<=day && (event.endDate>day || (event.endDate===day && !event.allDay && event.endTime!=="00:00")); }

export const PERSONAL_CALENDAR = "jordmburg@gmail.com";
export function personalProjects(sources: Source[]): Source[] {
  const included = new Set(sources.filter(s=>!s.blocked && /^personal$/i.test(s.name.trim())).map(s=>s.id));
  let changed=true; while(changed) {changed=false;for(const source of sources) if(!source.blocked && source.parentId && included.has(source.parentId) && !included.has(source.id)){included.add(source.id);changed=true;}}
  return sources.filter(s=>included.has(s.id));
}

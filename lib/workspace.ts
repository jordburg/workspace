import { z } from "zod";
export const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T12:00:00`);
  return !isNaN(date.getTime()) && dateKey(date) === value;
}, "Choose a valid date");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const itemSchema = z.object({
  id: z.string().uuid(), kind: z.enum(["priority", "plan", "note"]),
  title: z.string().trim().min(1).max(2000), area: z.enum(["personal", "independent"]),
  date: daySchema.nullable(), time: time.nullable(), endTime: time.nullable(), done: z.boolean(),
}).strict().superRefine((item, ctx) => {
  if (item.kind !== "note" && !item.date) ctx.addIssue({ code: "custom", message: "A date is required" });
  if (item.kind === "plan" && !item.time) ctx.addIssue({ code: "custom", message: "A start time is required" });
  if (item.endTime && (!item.time || item.endTime <= item.time)) ctx.addIssue({ code: "custom", message: "End time must be after start time" });
  if (item.kind !== "plan" && (item.time || item.endTime)) ctx.addIssue({ code: "custom", message: "Only plans have times" });
  if (item.kind === "note" && item.date) ctx.addIssue({ code: "custom", message: "Inbox thoughts are undated" });
});
export const workspaceSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), items: z.array(itemSchema).max(10000) }).strict().refine(state => new Set(state.items.map(item => item.id)).size === state.items.length, "Duplicate item IDs");
export type Item = z.infer<typeof itemSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export const emptyWorkspace: Workspace = { version: 1, revision: 0, items: [] };
export function dateKey(date: Date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`; }
export function dateFromKey(key: string) { return new Date(`${key}T12:00:00`); }

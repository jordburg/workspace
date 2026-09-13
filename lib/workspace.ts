import { z } from "zod";

export const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T12:00:00`);
  return !isNaN(date.getTime()) && dateKey(date) === value;
}, "Choose a valid date");

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const timestampSchema = z.string().datetime({ offset: true });
export const triageStatusSchema = z.enum(["new", "reviewed", "linked", "archived"]);

const itemFields = {
  id: z.string().uuid(),
  kind: z.enum(["priority", "plan", "note"]),
  title: z.string().trim().min(1).max(2000),
  area: z.enum(["personal", "independent"]),
  date: daySchema.nullable(),
  time: timeSchema.nullable(),
  endTime: timeSchema.nullable(),
  done: z.boolean(),
};

const validateItem = (item: {
  kind: "priority" | "plan" | "note";
  date: string | null;
  time: string | null;
  endTime: string | null;
}, ctx: z.RefinementCtx) => {
  if (item.kind !== "note" && !item.date) ctx.addIssue({ code: "custom", message: "A date is required" });
  if (item.kind === "plan" && !item.time) ctx.addIssue({ code: "custom", message: "A start time is required" });
  if (item.endTime && (!item.time || item.endTime <= item.time)) ctx.addIssue({ code: "custom", message: "End time must be after start time" });
  if (item.kind !== "plan" && (item.time || item.endTime)) ctx.addIssue({ code: "custom", message: "Only plans have times" });
  if (item.kind === "note" && item.date) ctx.addIssue({ code: "custom", message: "Captures are undated" });
};

const legacyItemSchema = z.object(itemFields).strict().superRefine(validateItem);
const currentItemInputSchema = z.object({
  ...itemFields,
  revision: z.number().int().nonnegative().optional(),
  createdAt: timestampSchema.nullable().optional(),
  updatedAt: timestampSchema.nullable().optional(),
  triageStatus: triageStatusSchema.nullable().optional(),
}).strict().superRefine(validateItem);

export const itemSchema = currentItemInputSchema.transform(item => ({
  ...item,
  revision: item.revision ?? 0,
  createdAt: item.createdAt ?? null,
  updatedAt: item.updatedAt ?? null,
  triageStatus: item.kind === "note" ? item.triageStatus ?? "new" as const : null,
}));

export const workspaceTombstoneSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  deletedAt: timestampSchema,
}).strict();

export const workspaceReceiptSchema = z.object({
  requestId: z.string().uuid(),
  action: z.enum(["upsert", "restore", "delete", "toggle", "triage"]),
  itemId: z.string().uuid(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  workspaceRevision: z.number().int().nonnegative(),
  completedAt: timestampSchema,
}).strict();

const uniqueItems = <T extends { items: Array<{ id: string }> }>(state: T) => new Set(state.items.map(item => item.id)).size === state.items.length;
const legacyWorkspaceSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  items: z.array(legacyItemSchema).max(10000),
}).strict().refine(uniqueItems, "Duplicate item IDs");

const currentWorkspaceSchema = z.object({
  version: z.literal(2),
  revision: z.number().int().nonnegative(),
  items: z.array(itemSchema).max(10000),
  tombstones: z.array(workspaceTombstoneSchema).max(10000).default([]),
  receipts: z.array(workspaceReceiptSchema).max(1000).default([]),
}).strict().refine(uniqueItems, "Duplicate item IDs");

export const workspaceSchema = z.union([currentWorkspaceSchema, legacyWorkspaceSchema]).transform(state => {
  if (state.version === 2) return state;
  return {
    version: 2 as const,
    revision: state.revision,
    items: state.items.map(item => itemSchema.parse(item)),
    tombstones: [],
    receipts: [],
  };
});

export const workspaceCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("upsert"), requestId: z.string().uuid(), expectedItemRevision: z.number().int().nonnegative().nullable(), item: itemSchema }).strict(),
  z.object({ action: z.literal("restore"), requestId: z.string().uuid(), expectedTombstoneRevision: z.number().int().positive(), item: itemSchema }).strict(),
  z.object({ action: z.literal("delete"), requestId: z.string().uuid(), id: z.string().uuid(), expectedItemRevision: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal("toggle"), requestId: z.string().uuid(), id: z.string().uuid(), expectedItemRevision: z.number().int().nonnegative(), done: z.boolean() }).strict(),
  z.object({ action: z.literal("triage"), requestId: z.string().uuid(), id: z.string().uuid(), expectedItemRevision: z.number().int().nonnegative(), status: triageStatusSchema }).strict(),
]);

export type Item = z.infer<typeof itemSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceCommand = z.infer<typeof workspaceCommandSchema>;
export const emptyWorkspace: Workspace = { version: 2, revision: 0, items: [], tombstones: [], receipts: [] };

export function dateKey(date: Date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
export function dateFromKey(key: string) { return new Date(`${key}T12:00:00`); }

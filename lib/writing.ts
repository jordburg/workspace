import { z } from "zod";

export const siteThreads = ["engineering", "fieldwork", "research", "writing"] as const;
export const siteKinds = ["writing", "idea", "work"] as const;
export const entrySlug = z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase words separated by hyphens.");
export const writingInputSchema = z.object({
  id: z.string().uuid(), revision: z.number().int().nonnegative(),
  slug: entrySlug, title: z.string().trim().min(1).max(200),
  summary: z.string().max(2000), body: z.string().max(100000),
  timeframe: z.string().max(100), kind: z.enum(siteKinds), format: z.string().max(100),
  primaryThread: z.enum(siteThreads), threads: z.array(z.enum(siteThreads)).min(1).max(4),
  topics: z.array(z.string().trim().min(1).max(80)).max(12),
  relatedEntries: z.array(entrySlug).max(3),
}).strict().refine(d => d.threads.includes(d.primaryThread), {message: "Include the primary thread in the entry’s threads."})
  .refine(d => new Set(d.threads).size === d.threads.length && new Set(d.relatedEntries).size === d.relatedEntries.length, {message: "Choose each thread and related entry once."});
export type WritingInput = z.infer<typeof writingInputSchema>;
export type WritingDraft = WritingInput & {updatedAt: string; exported: {file: string; hash: string; order: number; at: string} | null};
export type SiteEntry = {slug: string; title: string; summary: string; kind: string; order: number; draft: boolean; primaryThread: string};
export type WritingView = {repository: string; available: boolean; error: string | null; entries: SiteEntry[]; drafts: WritingDraft[]; pendingExports: string[]};
export const emptyWriting: WritingView = {repository: "", available: false, error: null, entries: [], drafts: [], pendingExports: []};
export const slugify = (title: string) => title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0,100).replace(/-$/, "");

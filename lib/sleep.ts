import { z } from "zod";
import { daySchema } from "./workspace.ts";

const timestamp = z.string().datetime({ offset: true });
const zone = z.string().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } });
const measure = (max: number) => z.number().finite().nonnegative().max(max).nullable();
export const sleepSampleSchema = z.object({
  id: z.string().uuid(), start: timestamp, end: timestamp,
  stage: z.enum(["inBed", "awake", "asleep", "core", "deep", "rem"]),
  sourceId: z.string().min(1).max(500), sourceName: z.string().min(1).max(200),
  timeZone: zone.optional(), sourceVersion: z.string().max(100).optional(),
}).strict().refine(s => Date.parse(s.end) > Date.parse(s.start) && Date.parse(s.end) - Date.parse(s.start) <= 172800000, "Invalid sleep interval.");
export const sleepContextSchema = z.object({
  date: daySchema, steps: measure(200000), restingHeartRate: measure(300), hrv: measure(2000),
  activeEnergy: measure(20000), exerciseMinutes: measure(1440), respiratoryRate: measure(150), oxygenSaturation: measure(100),
}).strict();
export const sleepBatchSchema = z.object({
  version: z.literal(1), generatedAt: timestamp, timeZone: zone, from: timestamp, to: timestamp,
  samples: z.array(sleepSampleSchema).max(30000), days: z.array(sleepContextSchema).max(35),
}).strict().superRefine((batch, ctx) => {
  const from = Date.parse(batch.from), to = Date.parse(batch.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return;
  try { new Intl.DateTimeFormat("en", { timeZone: batch.timeZone }).format(from); } catch { return; }
  if (to <= from || to - from > 35 * 86400000 || batch.samples.some(s => Date.parse(s.start) >= to || Date.parse(s.end) <= from) || new Set(batch.samples.map(s => s.id)).size !== batch.samples.length || new Set(batch.days.map(d => d.date)).size !== batch.days.length)
    ctx.addIssue({ code: "custom", message: "Send a complete, bounded sleep reporting range with unique samples." });
  if (batch.days.some(d => d.date < localDay(from, batch.timeZone) || d.date > localDay(to - 1, batch.timeZone))) ctx.addIssue({ code: "custom", message: "Context days must belong to this reporting range." });
  const expectedDays = Math.round((Date.parse(`${localDay(to - 1, batch.timeZone)}T12:00:00Z`) - Date.parse(`${localDay(from, batch.timeZone)}T12:00:00Z`)) / 86400000) + 1;
  if (batch.days.length !== expectedDays) ctx.addIssue({ code: "custom", message: "Include every context day, using null for unavailable measurements." });
});
export const sleepSettingsSchema = z.object({
  sourceId: z.string().max(500).nullable(), shortMinutes: z.number().int().min(180).max(600),
  awakeMinutes: z.number().int().min(15).max(240), sleepShare: z.number().int().min(50).max(99),
}).strict();
export const sleepNoteInputSchema = z.object({
  date: daySchema, revision: z.number().int().nonnegative(),
  text: z.string().max(5000), tags: z.array(z.enum(["caffeine", "medication", "alcohol", "stress", "nap", "late meal", "temperature", "illness", "night sweats", "exercise"])).max(10),
}).strict();
export const sleepNoteSchema = sleepNoteInputSchema.extend({ updatedAt: timestamp }).strict();
export const sleepUserStateSchema = z.object({
  version: z.literal(1), settings: sleepSettingsSchema, settingsRevision: z.number().int().nonnegative(), notes: z.array(sleepNoteSchema),
}).strict();
export const sleepSummaryQuerySchema = z.object({
  sourceId: z.string().min(1).max(500).optional(), from: daySchema.optional(), to: daySchema.optional(),
}).strict().superRefine((query, ctx) => {
  if ((query.from === undefined) !== (query.to === undefined)) ctx.addIssue({ code: "custom", message: "Choose both ends of the sleep summary range." });
  if (query.from && query.to && (query.from > query.to || Date.parse(`${query.to}T12:00:00Z`) - Date.parse(`${query.from}T12:00:00Z`) > 400 * 86400000))
    ctx.addIssue({ code: "custom", message: "Choose a sleep summary range of 400 days or less." });
});
export const sleepNightQuerySchema = z.object({ sourceId: z.string().min(1).max(500), date: daySchema }).strict();
export type SleepSample = z.infer<typeof sleepSampleSchema>;
export type SleepContext = z.infer<typeof sleepContextSchema>;
export type SleepBatch = z.infer<typeof sleepBatchSchema>;
export type SleepSettings = z.infer<typeof sleepSettingsSchema>;
export type SleepNote = z.infer<typeof sleepNoteSchema>;
export type SleepUserState = z.infer<typeof sleepUserStateSchema>;
export type SleepArchive = { version: 1; generatedAt: string | null; timeZone: string; samples: SleepSample[]; days: SleepContext[]; ranges: { from: string; to: string }[]; settings: SleepSettings; settingsRevision: number; notes: SleepNote[] };
export const emptySleep = (): SleepArchive => ({ version: 1, generatedAt: null, timeZone: "America/Los_Angeles", samples: [], days: [], ranges: [], settings: { sourceId: null, shortMinutes: 330, awakeMinutes: 60, sleepShare: 85 }, settingsRevision: 0, notes: [] });
export const localDay = (date: number | string, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(date));
export const shiftDay = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
export const minutesText = (value: number | null | undefined) => { if (value == null) return "—"; const n = Math.round(value); return `${Math.floor(n / 60)}h ${n % 60}m`; };
export const median = (values: number[]) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
export const average = (values: number[]) => values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
export type SleepSourceSummary = { id: string; name: string; staged: number; samples: number; first: number; last: number };
export const sleepSources = (samples: SleepSample[]): SleepSourceSummary[] => {
  const sources = new Map<string, { id: string; name: string; staged: number; samples: number; first: number; last: number }>();
  for (const s of samples) { const first = Date.parse(s.start), last = Date.parse(s.end); const source = sources.get(s.sourceId) || { id: s.sourceId, name: s.sourceName, staged: 0, samples: 0, first, last }; source.samples++; source.first = Math.min(source.first, first); source.last = Math.max(source.last, last); if (["core", "deep", "rem"].includes(s.stage)) source.staged++; sources.set(s.sourceId, source); }
  return [...sources.values()].sort((a, b) => b.staged - a.staged || b.samples - a.samples || a.id.localeCompare(b.id));
};
export type SleepSegment = { start: number; end: number; stage: Exclude<SleepSample["stage"], "inBed"> | "unknown" };
export type SleepNight = { date: string; start: number; end: number; asleep: number; awake: number | null; unknown: number; share: number | null; awakenings: number | null; longestAwake: number | null; stages: Record<"core" | "deep" | "rem" | "asleep", number>; segments: SleepSegment[]; otherSleep: number; hasStages: boolean; boundary: boolean };
export type SleepNightMetrics = Omit<SleepNight, "segments">;
export type SleepHourSummary = { awake: number; coverage: number };
export type SleepNightSummary = SleepNightMetrics & { hours: SleepHourSummary[] | null };
export type SleepSummary = {
  version: 1; revision: string; generatedAt: string | null; timeZone: string; from: string; to: string;
  sources: SleepSourceSummary[]; sourceId: string | null; nights: SleepNightSummary[]; days: SleepContext[];
  ranges: SleepArchive["ranges"]; settings: SleepSettings; settingsRevision: number; notes: SleepNote[];
};
export type SleepNightDetail = { revision: string; sourceId: string; date: string; night: SleepNight | null };
export const emptySleepSummary = (): SleepSummary => {
  const archive = emptySleep();
  return { version: 1, revision: "", generatedAt: archive.generatedAt, timeZone: archive.timeZone, from: "", to: "", sources: [], sourceId: null, nights: [], days: [], ranges: [], settings: archive.settings, settingsRevision: 0, notes: [] };
};

// Sweep intervals from one selected source. Conflicting stage claims remain unknown;
// an unspecified asleep interval can underlie a more specific stage without doubling it.
export function normalizeSleep(samples: SleepSample[]): SleepSegment[] {
  const events = new Map<number, { stage: string; delta: number }[]>();
  for (const s of samples.filter(s => s.stage !== "inBed")) for (const [time, delta] of [[Date.parse(s.start), 1], [Date.parse(s.end), -1]]) { const entries = events.get(time) || []; entries.push({ stage: s.stage, delta }); events.set(time, entries); }
  const times = [...events.keys()].sort((a, b) => a - b), counts = new Map<string, number>(), result: SleepSegment[] = [];
  for (let i = 0; i < times.length - 1; i++) {
    for (const event of events.get(times[i])!) counts.set(event.stage, (counts.get(event.stage) || 0) + event.delta);
    const active = [...counts].filter(([, n]) => n > 0).map(([stage]) => stage);
    const specific = active.filter(stage => stage !== "asleep");
    const stage = (specific.length === 1 && !(specific[0] === "awake" && active.includes("asleep")) ? specific[0] : specific.length === 0 && active.includes("asleep") ? "asleep" : "unknown") as SleepSegment["stage"];
    const previous = result.at(-1);
    if (previous?.stage === stage && previous.end === times[i]) previous.end = times[i + 1];
    else result.push({ start: times[i], end: times[i + 1], stage });
  }
  return result;
}
export function buildNights(samples: SleepSample[], sourceId: string, timeZone: string, ranges?: SleepArchive["ranges"]): SleepNight[] {
  const source = samples.filter(s => s.sourceId === sourceId && s.stage !== "inBed").sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const groups: SleepSample[][] = []; let end = 0, start = 0;
  for (const s of source) { const a = Date.parse(s.start), b = Date.parse(s.end); if (!groups.length || a - end > 3 * 3600000 || (a >= end && b - start > 20 * 3600000)) { groups.push([]); start = a; end = b; } groups.at(-1)!.push(s); end = Math.max(end, b); }
  const nights = new Map<string, SleepNight>();
  for (const group of groups) {
    const normalized = normalizeSleep(group), asleepSegments = normalized.filter(s => !["awake", "unknown"].includes(s.stage));
    if (!asleepSegments.length) continue;
    const start = asleepSegments[0].start, end = asleepSegments.at(-1)!.end;
    if (end - start > 20 * 3600000) continue;
    const segments = normalized.filter(s => s.end > start && s.start < end).map(s => ({ ...s, start: Math.max(start, s.start), end: Math.min(end, s.end) }));
    const stages = { core: 0, deep: 0, rem: 0, asleep: 0 }; let awake = 0, unknown = 0, awakenings = 0, longestAwake = 0;
    for (const segment of segments) { const minutes = (segment.end - segment.start) / 60000; if (segment.stage === "unknown") unknown += minutes; else if (segment.stage === "awake") { awake += minutes; longestAwake = Math.max(longestAwake, minutes); if (minutes >= 5) awakenings++; } else stages[segment.stage] += minutes; }
    const asleep = Object.values(stages).reduce((sum, v) => sum + v, 0), hasStages = stages.core + stages.deep + stages.rem > 0;
    const observesWake = hasStages || awake > 0;
    const span = (end - start) / 60000;
    const boundary = !!ranges && !ranges.some(r => Date.parse(r.from) <= start - 3 * 3600000 && Date.parse(r.to) >= end + 3 * 3600000);
    const date = localDay(end, timeZone), night: SleepNight = { date, start, end, asleep, awake: observesWake ? awake : null, unknown, share: observesWake && !boundary && unknown / span <= .05 ? asleep / span * 100 : null, awakenings: observesWake ? awakenings : null, longestAwake: observesWake ? longestAwake : null, stages, segments, otherSleep: 0, hasStages, boundary };
    const old = nights.get(date);
    if (!old || old.asleep < asleep) { night.otherSleep = old ? old.asleep + old.otherSleep : 0; nights.set(date, night); } else old.otherSleep += asleep;
  }
  return [...nights.values()].sort((a, b) => a.date.localeCompare(b.date));
}
export const hasSleepCoverage = (night: SleepNightMetrics) => !night.boundary && night.unknown / ((night.end - night.start) / 60000) <= .05;
export const nightFlags = (night: SleepNightMetrics, settings: SleepSettings) => ({ short: hasSleepCoverage(night) && night.asleep < settings.shortMinutes, fragmented: (night.awake != null && night.awake >= settings.awakeMinutes) || (night.share != null && night.share < settings.sleepShare) });
export function sleepEpisodes<T extends SleepNightMetrics>(nights: T[], settings: SleepSettings) {
  const episodes: { from: string; to: string; nights: T[] }[] = [];
  for (const night of nights) { if (!nightFlags(night, settings).fragmented) continue; const previous = episodes.at(-1); if (previous && shiftDay(previous.to, 1) === night.date) { previous.to = night.date; previous.nights.push(night); } else episodes.push({ from: night.date, to: night.date, nights: [night] }); }
  return episodes.filter(e => e.nights.length >= 2).reverse();
}

function summarizeHours(segments: SleepSegment[], awake: number | null, timeZone: string): SleepHourSummary[] | null {
  if (awake == null) return null;
  const result = Array.from({ length: 24 }, () => ({ awake: 0, coverage: 0 }));
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" });
  for (const segment of segments.filter(segment => segment.stage !== "unknown")) {
    for (let time = segment.start; time < segment.end;) {
      const next = Math.min(segment.end, (Math.floor(time / 60000) + 1) * 60000);
      const hour = Number(formatter.format(new Date(time)));
      const minutes = (next - time) / 60000;
      result[hour].coverage += minutes;
      if (segment.stage === "awake") result[hour].awake += minutes;
      time = next;
    }
  }
  return result;
}

export function summarizeSleepArchive(
  archive: SleepArchive,
  revision: string,
  options: { sourceId?: string; from?: string; to?: string; nights?: SleepNight[] } = {},
): SleepSummary {
  const sources = sleepSources(archive.samples);
  const sourceId = options.sourceId ?? archive.settings.sourceId ?? sources[0]?.id ?? null;
  const allNights = options.nights ?? (sourceId ? buildNights(archive.samples, sourceId, archive.timeZone, archive.ranges) : []);
  const to = options.to ?? allNights.at(-1)?.date ?? localDay(Date.now(), archive.timeZone);
  const from = options.from ?? shiftDay(to, -117);
  const nights = allNights.filter(night => night.date >= from && night.date <= to).map(night => {
    const { segments, ...metrics } = night;
    return { ...metrics, hours: summarizeHours(segments, night.awake, archive.timeZone) };
  });
  return {
    version: 1, revision, generatedAt: archive.generatedAt, timeZone: archive.timeZone, from, to, sources, sourceId, nights,
    days: archive.days.filter(day => day.date >= from && day.date <= to),
    ranges: archive.ranges, settings: archive.settings, settingsRevision: archive.settingsRevision,
    notes: archive.notes.filter(note => note.date >= from && note.date <= to),
  };
}

export function sleepNightDetail(archive: SleepArchive, revision: string, sourceId: string, date: string, nights?: SleepNight[]): SleepNightDetail {
  const allNights = nights ?? buildNights(archive.samples, sourceId, archive.timeZone, archive.ranges);
  return { revision, sourceId, date, night: allNights.find(night => night.date === date) ?? null };
}
export function mergeSleepBatch(archive: SleepArchive, batch: SleepBatch): SleepArchive {
  if (archive.generatedAt && Date.parse(batch.generatedAt) < Date.parse(archive.generatedAt)) throw new Error("A newer sleep sync is already saved. Sync again from your iPhone.");
  const from = Date.parse(batch.from), to = Date.parse(batch.to), ids = new Set(batch.samples.map(s => s.id));
  const samples = [...archive.samples.filter(s => !ids.has(s.id) && !(Date.parse(s.start) < to && Date.parse(s.end) > from)), ...batch.samples].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  if (samples.length > 500000) throw new Error("The sleep archive has reached its sample limit. Your saved data has been kept.");
  const firstDay = localDay(from, batch.timeZone), lastDay = localDay(to - 1, batch.timeZone);
  const days = [...archive.days.filter(d => d.date < firstDay || d.date > lastDay), ...batch.days].sort((a, b) => a.date.localeCompare(b.date));
  const ranges: SleepArchive["ranges"] = [];
  // The requested range controls replacement, but future hours were not observed.
  const observedTo = new Date(Math.min(to, Date.parse(batch.generatedAt))).toISOString();
  const observedRanges = Date.parse(observedTo) > from ? [{ from: batch.from, to: observedTo }] : [];
  for (const range of [...archive.ranges, ...observedRanges].sort((a, b) => Date.parse(a.from) - Date.parse(b.from))) { const previous = ranges.at(-1); if (previous && Date.parse(range.from) <= Date.parse(previous.to)) previous.to = Date.parse(range.to) > Date.parse(previous.to) ? range.to : previous.to; else ranges.push({ ...range }); }
  const sourceId = archive.settings.sourceId ?? sleepSources(samples)[0]?.id ?? null;
  const changedSource = sourceId !== archive.settings.sourceId;
  return { ...archive, generatedAt: batch.generatedAt, timeZone: batch.timeZone, samples, days, ranges, settings: { ...archive.settings, sourceId }, settingsRevision: archive.settingsRevision + (changedSource ? 1 : 0) };
}

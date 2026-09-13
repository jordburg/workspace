import { z } from "zod";
import { daySchema } from "./workspace.ts";

const timestamp = z.string().datetime({ offset: true });
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const optionalText = (max: number) => z.string().trim().max(max);
export const gradeSystemSchema = z.enum(["v-scale", "font", "yds", "french", "uiaa", "uk", "gym", "custom"]);
export const climbingEnvironmentSchema = z.enum(["indoor", "outdoor"]);
export const climbDisciplineSchema = z.enum(["boulder", "route"]);
export const ropeStyleSchema = z.enum(["top-rope", "sport-lead", "trad-lead", "follow", "auto-belay"]);
export const routineFocusSchema = z.enum(["technique", "strength", "power", "power-endurance", "endurance", "mobility", "recovery", "general"]);
export const climbSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(120), discipline: climbDisciplineSchema,
  ropeStyle: ropeStyleSchema.nullable(),
  gradeSystem: gradeSystemSchema.nullable(), grade: z.string().trim().min(1).max(30).nullable(),
  outcome: z.enum(["flash", "onsight", "redpoint", "send", "repeat", "attempt"]), attempts: z.number().int().min(1).max(99).nullable(), notes: optionalText(1000),
}).strict().superRefine((climb, ctx) => {
  if ((climb.gradeSystem === null) !== (climb.grade === null)) ctx.addIssue({ code: "custom", message: "Choose both a grade and its grading system, or leave both blank." });
  if (climb.discipline === "boulder" && climb.ropeStyle !== null) ctx.addIssue({ code: "custom", message: "Only roped climbs use a rope style." });
  if (climb.discipline === "route" && climb.ropeStyle === null) ctx.addIssue({ code: "custom", message: "Choose how you climbed this route." });
  if (climb.discipline === "boulder" && climb.gradeSystem && ["yds", "french", "uiaa", "uk"].includes(climb.gradeSystem)) ctx.addIssue({ code: "custom", message: "Choose a bouldering grade system for a boulder." });
  if (climb.discipline === "route" && climb.gradeSystem && ["v-scale", "font"].includes(climb.gradeSystem)) ctx.addIssue({ code: "custom", message: "Choose a route grade system for a roped route." });
  if (["flash", "onsight"].includes(climb.outcome) && climb.attempts !== 1) ctx.addIssue({ code: "custom", message: "A flash or onsight has one attempt." });
  if (climb.discipline === "boulder" && ["onsight", "redpoint"].includes(climb.outcome)) ctx.addIssue({ code: "custom", message: "Onsight and redpoint outcomes apply to roped routes." });
});
export const routineStepSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(160), prescription: z.string().trim().min(1).max(500), rest: z.string().trim().max(200), notes: optionalText(500),
}).strict();
export const routineSchema = z.object({
  id: z.string().uuid(), title: z.string().trim().min(1).max(160), focus: routineFocusSchema,
  description: optionalText(2000), estimatedMinutes: z.number().int().min(5).max(360).nullable(), steps: z.array(routineStepSchema).min(1).max(50), version: z.number().int().min(1).max(10000), archived: z.boolean(), updatedAt: timestamp,
}).strict().refine(r => new Set(r.steps.map(s => s.id)).size === r.steps.length, "Routine step IDs must be unique.");
export const routineExecutionSchema = z.object({
  routineId: z.string().uuid(), version: z.number().int().min(1).max(10000), title: z.string().trim().min(1).max(160), focus: routineFocusSchema,
  description: optionalText(2000), estimatedMinutes: z.number().int().min(5).max(360).nullable(),
  steps: z.array(routineStepSchema.extend({ status: z.enum(["not-logged", "done", "skipped", "modified"]), result: optionalText(500) }).strict()).min(1).max(50),
}).strict();
export const climbingSessionSchema = z.object({
  id: z.string().uuid(), date: daySchema, environment: climbingEnvironmentSchema, venue: z.string().trim().min(1).max(200),
  focus: z.enum(["bouldering", "routes", "mixed", "training", "other"]), durationMinutes: z.number().int().min(5).max(900).nullable(),
  effort: z.number().int().min(1).max(10).nullable(), readiness: z.enum(["fresh", "steady", "tired", "sore"]).nullable(), notes: optionalText(5000),
  climbs: z.array(climbSchema).max(200), routine: routineExecutionSchema.nullable(), planId: z.string().uuid().nullable().optional(),
  healthWorkoutId: z.string().uuid().nullable().optional(), deletedAt: timestamp.nullable(), createdAt: timestamp, updatedAt: timestamp,
}).strict().superRefine((session, ctx) => {
  if (new Set(session.climbs.map(c => c.id)).size !== session.climbs.length) ctx.addIssue({ code: "custom", message: "Climb IDs must be unique within a session." });
  if (session.routine && new Set(session.routine.steps.map(s => s.id)).size !== session.routine.steps.length) ctx.addIssue({ code: "custom", message: "Routine step IDs must be unique within a session." });
});
export const climbingGoalSchema = z.object({
  id: z.string().uuid(), title: z.string().trim().min(1).max(200), kind: z.enum(["consistency", "project", "skill", "training", "custom"]),
  description: optionalText(3000), status: z.enum(["active", "paused", "completed"]), archivedAt: timestamp.nullable(), progress: z.number().int().min(0).max(100),
  nextStep: optionalText(500), startDate: daySchema.nullable(), targetDate: daySchema.nullable(), sessionTarget: z.number().int().min(1).max(365).nullable(),
  venue: z.string().trim().max(200).nullable(), environment: climbingEnvironmentSchema.nullable().default(null),
  discipline: climbDisciplineSchema.nullable().default(null), ropeStyle: ropeStyleSchema.nullable().default(null),
  gradeSystem: gradeSystemSchema.nullable(), grade: z.string().trim().min(1).max(30).nullable(),
  attempts: z.number().int().min(0).max(9999).nullable().default(null), routineId: z.string().uuid().nullable(), updatedAt: timestamp,
}).strict().superRefine((goal, ctx) => {
  if ((goal.gradeSystem === null) !== (goal.grade === null)) ctx.addIssue({ code: "custom", message: "Choose both a target grade and its grading system, or leave both blank." });
  if (goal.ropeStyle !== null && goal.discipline !== "route") ctx.addIssue({ code: "custom", message: "Only roped projects use a rope style." });
  if (goal.discipline === "boulder" && goal.gradeSystem && ["yds", "french", "uiaa", "uk"].includes(goal.gradeSystem)) ctx.addIssue({ code: "custom", message: "Choose a bouldering grade system for a boulder project." });
  if (goal.discipline === "route" && goal.gradeSystem && ["v-scale", "font"].includes(goal.gradeSystem)) ctx.addIssue({ code: "custom", message: "Choose a route grade system for a roped project." });
  if (goal.kind === "consistency" && (!goal.startDate || !goal.targetDate || !goal.sessionTarget)) ctx.addIssue({ code: "custom", message: "A consistency goal needs a date range and session target." });
  if (goal.kind === "consistency" && goal.startDate && goal.targetDate && goal.targetDate < goal.startDate) ctx.addIssue({ code: "custom", message: "The target date must be on or after the start date." });
});
export const goalReferenceSchema = z.object({
  id: z.string().uuid(), goalId: z.string().uuid(), kind: z.enum(["link", "image", "video"]), label: optionalText(160),
  url: z.string().trim().url().max(2048).nullable(), fileName: z.string().trim().min(1).max(240).nullable(),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "video/mp4", "video/quicktime"]).nullable(),
  byteSize: z.number().int().min(1).max(200_000_000).nullable(), createdAt: timestamp,
}).strict().superRefine((reference, ctx) => {
  if (reference.kind === "link") {
    if (!reference.url || !reference.url.startsWith("https://")) ctx.addIssue({ code: "custom", path: ["url"], message: "Media links must use HTTPS." });
    if (reference.fileName !== null || reference.mimeType !== null || reference.byteSize !== null) ctx.addIssue({ code: "custom", message: "A media link cannot include uploaded-file details." });
    return;
  }
  if (reference.url !== null || reference.fileName === null || reference.mimeType === null || reference.byteSize === null) ctx.addIssue({ code: "custom", message: "Uploaded media needs a file name, type, and size." });
  if (reference.kind === "image" && reference.mimeType && !reference.mimeType.startsWith("image/")) ctx.addIssue({ code: "custom", path: ["mimeType"], message: "An image reference must use an image type." });
  if (reference.kind === "video" && reference.mimeType && !reference.mimeType.startsWith("video/")) ctx.addIssue({ code: "custom", path: ["mimeType"], message: "A video reference must use a video type." });
});
export const climbingPlanSchema = z.object({
  id: z.string().uuid(), title: z.string().trim().min(1).max(200), date: daySchema,
  startTime: time.nullable(), endDate: daySchema.nullable(), endTime: time.nullable(),
  environment: climbingEnvironmentSchema, venue: optionalText(200),
  focus: z.enum(["bouldering", "routes", "mixed", "training", "other"]), goalId: z.string().uuid().nullable(),
  routine: routineExecutionSchema.nullable(), status: z.enum(["planned", "logged", "cancelled"]),
  sessionId: z.string().uuid().nullable(), createdAt: timestamp, updatedAt: timestamp,
}).strict().superRefine((plan, ctx) => {
  const schedule = [plan.startTime, plan.endDate, plan.endTime];
  const scheduled = schedule.every(value => value !== null);
  if (!scheduled && schedule.some(value => value !== null)) ctx.addIssue({ code: "custom", message: "Choose a start time, end date, and end time together." });
  if (scheduled && `${plan.endDate}T${plan.endTime}` <= `${plan.date}T${plan.startTime}`) ctx.addIssue({ code: "custom", message: "A climbing plan must end after it starts." });
  if (plan.status === "logged" && !plan.sessionId) ctx.addIssue({ code: "custom", message: "A logged climbing plan must link to its session." });
  if (plan.status !== "logged" && plan.sessionId) ctx.addIssue({ code: "custom", message: "Only a logged climbing plan can link to a session." });
  if (plan.routine && new Set(plan.routine.steps.map(step => step.id)).size !== plan.routine.steps.length) ctx.addIssue({ code: "custom", message: "Routine step IDs must be unique within a plan." });
  if (plan.routine?.steps.some(step => step.status !== "not-logged" || step.result !== "")) ctx.addIssue({ code: "custom", message: "A planned routine must keep every step unlogged until the session records the result." });
});
export const climbingStateSchema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(), sessions: z.array(climbingSessionSchema).max(5000), goals: z.array(climbingGoalSchema).max(500), routines: z.array(routineSchema).max(200), plans: z.array(climbingPlanSchema).max(5000).default([]), goalReferences: z.array(goalReferenceSchema).max(6000).default([]),
}).strict().superRefine((state, ctx) => {
  for (const [kind, ids] of [["session", state.sessions.map(value => value.id)], ["goal", state.goals.map(value => value.id)], ["routine", state.routines.map(value => value.id)], ["plan", state.plans.map(value => value.id)]] as const) if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: `Duplicate ${kind} IDs.` });
  const routineIds = new Set(state.routines.map(r => r.id));
  if (state.goals.some(goal => goal.routineId && !routineIds.has(goal.routineId))) ctx.addIssue({ code: "custom", message: "A goal links to a routine that no longer exists." });
  const goalIds = new Set(state.goals.map(goal => goal.id));
  if (new Set(state.goalReferences.map(reference => reference.id)).size !== state.goalReferences.length) ctx.addIssue({ code: "custom", path: ["goalReferences"], message: "Goal reference IDs must be unique." });
  for (const [index, reference] of state.goalReferences.entries()) if (!goalIds.has(reference.goalId)) ctx.addIssue({ code: "custom", path: ["goalReferences", index, "goalId"], message: "A media reference links to a goal that no longer exists." });
  for (const goalId of goalIds) if (state.goalReferences.filter(reference => reference.goalId === goalId).length > 12) ctx.addIssue({ code: "custom", path: ["goalReferences"], message: "A climbing goal can keep at most 12 media references." });
  for (const goalId of goalIds) if (state.goalReferences.filter(reference => reference.goalId === goalId).reduce((total, reference) => total + (reference.byteSize ?? 0), 0) > 1_000_000_000) ctx.addIssue({ code: "custom", path: ["goalReferences"], message: "A climbing goal can keep at most 1 GB of uploaded media." });
  if (state.goalReferences.reduce((total, reference) => total + (reference.byteSize ?? 0), 0) > 5_000_000_000) ctx.addIssue({ code: "custom", path: ["goalReferences"], message: "Climbing can keep at most 5 GB of uploaded media." });
  const plansById = new Map(state.plans.map(plan => [plan.id, plan]));
  const sessionsByPlan = new Map<string, typeof state.sessions>();
  // Removed sessions remain here: their reciprocal plan and Health links are reserved so restoring the tombstone is safe.
  for (const session of state.sessions) if (session.planId) sessionsByPlan.set(session.planId, [...(sessionsByPlan.get(session.planId) ?? []), session]);
  const healthWorkoutIds = state.sessions.flatMap(session => session.healthWorkoutId ? [session.healthWorkoutId.toLowerCase()] : []);
  if (new Set(healthWorkoutIds).size !== healthWorkoutIds.length) ctx.addIssue({ code: "custom", message: "An Apple Health workout can link to only one climbing session." });
  for (const [index, plan] of state.plans.entries()) {
    if (plan.goalId && !goalIds.has(plan.goalId)) ctx.addIssue({ code: "custom", path: ["plans", index, "goalId"], message: "A climbing plan links to a goal that no longer exists." });
    const linked = sessionsByPlan.get(plan.id) ?? [];
    if (plan.status === "logged" && (linked.length !== 1 || linked[0]?.id !== plan.sessionId)) ctx.addIssue({ code: "custom", path: ["plans", index, "sessionId"], message: "A logged climbing plan must link reciprocally to exactly one session." });
    if (plan.status !== "logged" && linked.length) ctx.addIssue({ code: "custom", path: ["plans", index, "status"], message: "A planned or cancelled climbing plan cannot have a linked session." });
  }
  for (const [index, session] of state.sessions.entries()) if (session.planId) {
    const plan = plansById.get(session.planId);
    if (!plan || plan.status !== "logged" || plan.sessionId !== session.id) ctx.addIssue({ code: "custom", path: ["sessions", index, "planId"], message: "A climbing session must link reciprocally to its logged plan." });
  }
});

const climbingChangeBase = { expectedUpdatedAt: timestamp.nullable() };
export const climbingChangeSchema = z.discriminatedUnion("kind", [
  z.object({ ...climbingChangeBase, kind: z.literal("session"), value: climbingSessionSchema }).strict(),
  z.object({ ...climbingChangeBase, kind: z.literal("goal"), value: climbingGoalSchema }).strict(),
  z.object({ ...climbingChangeBase, kind: z.literal("routine"), value: routineSchema }).strict(),
  z.object({ ...climbingChangeBase, kind: z.literal("plan"), value: climbingPlanSchema }).strict(),
]);
export const climbingCommandSchema = z.object({
  requestId: z.string().uuid(),
  changes: z.array(climbingChangeSchema).min(1).max(20),
}).strict().refine(command => new Set(command.changes.map(change => `${change.kind}:${change.value.id}`)).size === command.changes.length, "Each climbing record can change only once per command.");

export type GradeSystem = z.infer<typeof gradeSystemSchema>;
export type Climb = z.infer<typeof climbSchema>;
export type RoutineStep = z.infer<typeof routineStepSchema>;
export type Routine = z.infer<typeof routineSchema>;
export type RoutineExecution = z.infer<typeof routineExecutionSchema>;
export type ClimbingSession = z.infer<typeof climbingSessionSchema>;
export type ClimbingGoal = z.infer<typeof climbingGoalSchema>;
export type GoalReference = z.infer<typeof goalReferenceSchema>;
export type ClimbingPlan = z.infer<typeof climbingPlanSchema>;
export type ClimbingState = z.infer<typeof climbingStateSchema>;
export type ClimbingChange = z.infer<typeof climbingChangeSchema>;
export type ClimbingCommand = z.infer<typeof climbingCommandSchema>;
export const emptyClimbing: ClimbingState = { version: 1, revision: 0, sessions: [], goals: [], routines: [], plans: [], goalReferences: [] };

export const gradeSystemNames: Record<GradeSystem, string> = { "v-scale": "V-scale", font: "Fontainebleau", yds: "YDS", french: "French", uiaa: "UIAA", uk: "UK", gym: "Gym label / color", custom: "Custom" };
export const focusNames: Record<ClimbingSession["focus"], string> = { bouldering: "Bouldering", routes: "Routes", mixed: "Mixed climbing", training: "Training", other: "Other" };
export const routineFocusNames: Record<Routine["focus"], string> = { technique: "Technique", strength: "Strength", power: "Power", "power-endurance": "Power endurance", endurance: "Endurance", mobility: "Mobility", recovery: "Recovery", general: "General" };
export const goalKindNames: Record<ClimbingGoal["kind"], string> = { consistency: "Consistency", project: "Climb project", skill: "Skill", training: "Training", custom: "Custom" };
export const sessionSends = (session: ClimbingSession) => session.climbs.filter(climb => climb.outcome !== "attempt").length;
export function consistencyProgress(goal: ClimbingGoal, sessions: ClimbingSession[]) {
  if (goal.kind !== "consistency" || !goal.startDate || !goal.targetDate || !goal.sessionTarget) return { completed: 0, target: 0, percent: goal.progress };
  const completed = sessions.filter(session => !session.deletedAt && session.date >= goal.startDate! && session.date <= goal.targetDate!).length;
  return { completed, target: goal.sessionTarget, percent: Math.min(100, completed / goal.sessionTarget * 100) };
}
export function routineSnapshot(routine: Routine): RoutineExecution {
  return { routineId: routine.id, version: routine.version, title: routine.title, focus: routine.focus, description: routine.description, estimatedMinutes: routine.estimatedMinutes, steps: routine.steps.map(step => ({ ...step, status: "not-logged", result: "" })) };
}

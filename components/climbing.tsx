"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { ZodError } from "zod";
import { Activity, Archive, ArrowDown, ArrowUp, CalendarClock, CalendarDays, Check, Dumbbell, ExternalLink, FileVideo, Flag, HeartPulse, Image as ImageIcon, Link2, ListTodo, Mountain, Paperclip, Plus, RotateCcw, Timer, Trash2, Upload } from "lucide-react";
import { useIntegrations, type RemoteDraft } from "@/components/integrations";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  climbingGoalSchema, climbingPlanSchema, climbingSessionSchema, climbingStateSchema, consistencyProgress, emptyClimbing,
  focusNames, goalKindNames, gradeSystemNames, prefixByUtf16Units, projectGoalHistory, routineFocusNames, routineSchema, routineSnapshot, sessionSends,
  type Climb, type ClimbingChange, type ClimbingGoal, type ClimbingPlan, type ClimbingSession, type ClimbingState, type GoalReference, type GradeSystem,
  type Routine, type RoutineExecution, type RoutineStep,
} from "@/lib/climbing";
import { climbingCloudMediaViewSchema, emptyClimbingCloudMedia, type ClimbingCloudMediaItem, type ClimbingCloudMediaView } from "@/lib/climbing-cloud-media";
import { healthWorkoutDay, healthWorkoutTimeZone, uniqueHealthWorkouts, type HealthView, type HealthWorkout } from "@/lib/health";
import type { IntegrationLink, RemoteEvent, RemoteTask } from "@/lib/integrations/model";
import { dateKey } from "@/lib/workspace";

type ClimbingTab = "sessions" | "goals" | "routines";
type Editor =
  | { kind: "session"; value: ClimbingSession; isNew: boolean }
  | { kind: "plan"; value: ClimbingPlan; isNew: boolean }
  | { kind: "goal"; value: ClimbingGoal; isNew: boolean }
  | { kind: "routine"; value: Routine; isNew: boolean };

const now = () => new Date().toISOString();
const responseError = (value: unknown, fallback: string) => typeof value === "object" && value !== null && "error" in value && typeof value.error === "string" ? value.error : fallback;
const responseCode = (value: unknown) => typeof value === "object" && value !== null && "code" in value && typeof value.code === "string" ? value.code : "";
const errorMessage = (cause: unknown, fallback: string) => cause instanceof ZodError ? cause.issues[0]?.message ?? fallback : cause instanceof Error ? cause.message : fallback;
const dayLabel = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const minutesLabel = (minutes: number) => minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60 ? `${minutes % 60}m` : ""}`.trim() : `${minutes}m`;
const nullableNumber = (value: string) => value === "" ? null : Number(value);
const nextDay = (day: string) => { const value = new Date(`${day}T12:00:00`); value.setDate(value.getDate() + 1); return dateKey(value); };
const gradeFits = (discipline: Climb["discipline"], system: GradeSystem | null) => {
  if (!system || system === "gym" || system === "custom") return true;
  return discipline === "boulder" ? !["yds", "french", "uiaa", "uk"].includes(system) : !["v-scale", "font"].includes(system);
};
const ropeStyleNames: Record<NonNullable<Climb["ropeStyle"]>, string> = { "top-rope": "Top rope", "sport-lead": "Sport lead", "trad-lead": "Trad lead", follow: "Follow", "auto-belay": "Auto belay" };
const linkFor = (links: IntegrationLink[], role: IntegrationLink["role"], entityId: string) => links.find(link => link.role === role && link.entityId === entityId);
const remoteFor = <T extends { id: string }>(items: T[], link?: IntegrationLink) => link ? items.find(item => item.id === link.remoteId) : undefined;
const referenceHref = (reference: GoalReference) => reference.kind === "link" ? reference.url ?? "" : `/api/climbing/media/${encodeURIComponent(reference.id)}`;
const referenceName = (reference: GoalReference) => reference.label || reference.fileName || (reference.kind === "link" && reference.url ? new URL(reference.url).hostname : "Beta reference");
const referenceDetail = (reference: GoalReference, cloud?: ClimbingCloudMediaItem) => {
  if (reference.kind === "link") { try { return new URL(reference.url ?? "").hostname.replace(/^www\./, ""); } catch { return "Link"; } }
  const size = reference.byteSize ? reference.byteSize >= 1_000_000 ? `${(reference.byteSize / 1_000_000).toFixed(reference.byteSize >= 10_000_000 ? 0 : 1)} MB` : `${Math.max(1, Math.round(reference.byteSize / 1000))} KB` : "";
  const sync = cloud?.operation === "upload" ? cloud.status === "confirmed" ? "iCloud copy last confirmed" : cloud.status === "error" ? "iCloud copy needs attention" : "iCloud copy pending" : "";
  return `${reference.kind === "video" ? "Video" : "Image"}${size ? ` · ${size}` : ""}${sync ? ` · ${sync}` : ""}`;
};
const outcomeNames: Record<Climb["outcome"], string> = { attempt: "Attempt", send: "Send", flash: "Flash", onsight: "Onsight", redpoint: "Redpoint", repeat: "Repeat" };

function workoutTime(workout: HealthWorkout, snapshotTimeZone: string) { return new Date(workout.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: healthWorkoutTimeZone(workout, snapshotTimeZone) }); }
function workoutActivity(workout: HealthWorkout) {
  const names: Record<string, string> = { climbing: "Climbing", walking: "Walking", running: "Running", cycling: "Cycling", swimming: "Swimming", hiking: "Hiking", yoga: "Yoga", "traditional-strength-training": "Traditional strength training", "functional-strength-training": "Functional strength training", hiit: "HIIT", other: "Other workout" };
  return names[workout.activity ?? "other"] ?? "Other workout";
}

function newSession(state: ClimbingState, routine: Routine | null = null): ClimbingSession {
  const recent = [...state.sessions].filter(session => !session.deletedAt).sort((a, b) => b.date.localeCompare(a.date))[0];
  const stamp = now();
  return { id: crypto.randomUUID(), date: dateKey(new Date()), environment: recent?.environment ?? "indoor", venue: recent?.venue ?? "", focus: routine ? "training" : recent?.focus ?? "bouldering", durationMinutes: null, effort: null, readiness: null, notes: "", climbs: [], routine: routine ? routineSnapshot(routine) : null, planId: null, healthWorkoutId: null, deletedAt: null, createdAt: stamp, updatedAt: stamp };
}
function newPlan(state: ClimbingState, routine: Routine | null = null): ClimbingPlan {
  const recent = [...state.sessions].filter(session => !session.deletedAt).sort((a, b) => b.date.localeCompare(a.date))[0];
  const stamp = now();
  return { id: crypto.randomUUID(), title: routine?.title ?? "Climbing session", date: dateKey(new Date()), startTime: null, endDate: null, endTime: null, environment: recent?.environment ?? "indoor", venue: recent?.venue ?? "", focus: routine ? "training" : recent?.focus ?? "bouldering", goalId: null, routine: routine ? routineSnapshot(routine) : null, status: "planned", sessionId: null, createdAt: stamp, updatedAt: stamp };
}
function projectClimb(goal: ClimbingGoal): Climb {
  const discipline = goal.discipline ?? "boulder";
  return {
    id: crypto.randomUUID(), projectGoalId: goal.id, name: prefixByUtf16Units(goal.title, 120), discipline,
    ropeStyle: discipline === "route" ? goal.ropeStyle ?? "top-rope" : null,
    gradeSystem: gradeFits(discipline, goal.gradeSystem) ? goal.gradeSystem : null,
    grade: gradeFits(discipline, goal.gradeSystem) ? goal.grade : null,
    outcome: "attempt", attempts: null, notes: "",
  };
}
function sessionFromPlan(plan: ClimbingPlan, event?: RemoteEvent): ClimbingSession {
  const stamp = now();
  return { id: crypto.randomUUID(), date: event?.startDate ?? plan.date, environment: plan.environment, venue: event?.location.trim() || plan.venue, focus: plan.focus, durationMinutes: null, effort: null, readiness: null, notes: "", climbs: [], routine: plan.routine ? structuredClone(plan.routine) : null, planId: plan.id, healthWorkoutId: null, deletedAt: null, createdAt: stamp, updatedAt: stamp };
}
function newGoal(): ClimbingGoal { return { id: crypto.randomUUID(), title: "", kind: "consistency", description: "", status: "active", archivedAt: null, progress: 0, nextStep: "", startDate: dateKey(new Date()), targetDate: null, sessionTarget: 8, environment: null, discipline: null, ropeStyle: null, venue: null, gradeSystem: null, grade: null, attempts: null, routineId: null, updatedAt: now() }; }
function newStep(): RoutineStep { return { id: crypto.randomUUID(), name: "", prescription: "", rest: "", notes: "" }; }
function newRoutine(): Routine { return { id: crypto.randomUUID(), title: "", focus: "general", description: "", estimatedMinutes: null, steps: [newStep()], version: 1, archived: false, updatedAt: now() }; }
function newClimb(session: ClimbingSession): Climb {
  const route = session.focus === "routes";
  const discipline = route ? "route" : "boulder";
  const previous = session.climbs.at(-1);
  const gradeSystem = gradeFits(discipline, previous?.gradeSystem ?? null) ? previous?.gradeSystem ?? null : null;
  return { id: crypto.randomUUID(), projectGoalId: null, name: "", discipline, ropeStyle: route ? "top-rope" : null, gradeSystem, grade: gradeSystem ? "" : null, outcome: "attempt", attempts: null, notes: "" };
}

function climbingChanges(current: ClimbingState, next: ClimbingState): ClimbingChange[] {
  const changes: ClimbingChange[] = [];
  for (const value of next.sessions) { const existing = current.sessions.find(item => item.id === value.id); if (JSON.stringify(existing) !== JSON.stringify(value)) changes.push({ kind: "session", expectedUpdatedAt: existing?.updatedAt ?? null, value }); }
  for (const value of next.goals) { const existing = current.goals.find(item => item.id === value.id); if (JSON.stringify(existing) !== JSON.stringify(value)) changes.push({ kind: "goal", expectedUpdatedAt: existing?.updatedAt ?? null, value }); }
  for (const value of next.routines) { const existing = current.routines.find(item => item.id === value.id); if (JSON.stringify(existing) !== JSON.stringify(value)) changes.push({ kind: "routine", expectedUpdatedAt: existing?.updatedAt ?? null, value }); }
  for (const value of next.plans) { const existing = current.plans.find(item => item.id === value.id); if (JSON.stringify(existing) !== JSON.stringify(value)) changes.push({ kind: "plan", expectedUpdatedAt: existing?.updatedAt ?? null, value }); }
  return changes;
}

export function ClimbingPanel({ active = true, openHealth }: { active?: boolean; openHealth: () => void }) {
  const integrations = useIntegrations();
  const [data, setData] = useState<ClimbingState>(emptyClimbing);
  const dataRef = useRef(data);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<ClimbingTab>("sessions");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [removeSession, setRemoveSession] = useState<ClimbingSession | null>(null);
  const [removeReference, setRemoveReference] = useState<GoalReference | null>(null);
  const [forgetCandidate, setForgetCandidate] = useState<IntegrationLink | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [health, setHealth] = useState<HealthView | null>(null);
  const [healthLoaded, setHealthLoaded] = useState(false);
  const [healthError, setHealthError] = useState("");
  const [cloudMedia, setCloudMedia] = useState<ClimbingCloudMediaView>(() => ({ version: emptyClimbingCloudMedia.version, revision: emptyClimbingCloudMedia.revision, items: [] }));
  const [cloudMediaError, setCloudMediaError] = useState("");
  const dirtyRef = useRef(false);
  const etagRef = useRef("");
  const cloudMediaEtagRef = useRef("");

  const receive = useCallback((next: ClimbingState) => { dataRef.current = next; setData(next); }, []);
  const load = useCallback(async (silent = false) => {
    try {
      const response = await fetch("/api/climbing", { cache: "no-store", headers: etagRef.current ? { "If-None-Match": etagRef.current } : {} });
      if (response.status === 304) return true;
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(responseError(result, "Your climbing log could not be loaded."));
      receive(climbingStateSchema.parse(result)); etagRef.current = response.headers.get("etag") || ""; setLoaded(true); if (!silent) setError(""); return true;
    } catch (cause) { if (!silent) setError(errorMessage(cause, "Your climbing log could not be loaded.")); return false; }
  }, [receive]);
  const loadHealth = useCallback(async () => {
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      const result = await response.json() as HealthView & { error?: string };
      if (!response.ok) throw new Error(result.error || "Apple Health could not be loaded.");
      setHealth(result); setHealthError("");
    } catch (cause) { setHealthError(errorMessage(cause, "Apple Health could not be loaded.")); }
    finally { setHealthLoaded(true); }
  }, []);
  const loadCloudMedia = useCallback(async () => {
    try {
      const response = await fetch("/api/climbing/media/cloud/status", { cache: "no-store", headers: cloudMediaEtagRef.current ? { "If-None-Match": cloudMediaEtagRef.current } : {} });
      if (response.status === 304) return true;
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(responseError(result, "Media sync status could not be loaded."));
      setCloudMedia(climbingCloudMediaViewSchema.parse(result)); cloudMediaEtagRef.current = response.headers.get("etag") || ""; setCloudMediaError(""); return true;
    } catch (cause) { setCloudMediaError(errorMessage(cause, "Media sync status could not be loaded.")); return false; }
  }, []);
  useEffect(() => { if (!active) return; const timer = setTimeout(() => { void load(); void loadHealth(); void loadCloudMedia(); }, 0); return () => clearTimeout(timer); }, [active, load, loadHealth, loadCloudMedia]);
  useEffect(() => { if (!active) return; const timer = setInterval(() => { if (document.visibilityState === "visible") { void load(true); void loadCloudMedia(); } }, 15_000); return () => clearInterval(timer); }, [active, load, loadCloudMedia]);
  useEffect(() => { if (!active) return; const timer = setInterval(() => { if (document.visibilityState === "visible") void loadHealth(); }, 60000); return () => clearInterval(timer); }, [active, loadHealth]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 5000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { if (!editor) return; const warn = (event: BeforeUnloadEvent) => { if (dirtyRef.current) event.preventDefault(); }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [editor]);

  function openEditor(next: Editor) { dirtyRef.current = false; setConflict(false); setError(""); setEditor(next); }
  function finishEditor() { dirtyRef.current = false; setConflict(false); setDiscardOpen(false); setError(""); setEditor(null); }
  function requestEditorClose() { if (dirtyRef.current) setDiscardOpen(true); else finishEditor(); }
  async function save(next: ClimbingState, message: string) {
    if (busyRef.current || !loaded) return false;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const candidate = climbingStateSchema.parse({ ...next, revision: dataRef.current.revision });
      const changes = climbingChanges(dataRef.current, candidate);
      if (!changes.length) return true;
      const response = await fetch("/api/climbing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: crypto.randomUUID(), changes }) });
      const result: unknown = await response.json();
      if (!response.ok) { if (response.status === 409 && ["revision_conflict", "entity_revision_conflict"].includes(responseCode(result))) { setConflict(true); await load(); } throw new Error(responseError(result, "Your change could not be saved.")); }
      receive(climbingStateSchema.parse(result)); etagRef.current = response.headers.get("etag") || ""; setNotice(message); return true;
    } catch (cause) { setError(errorMessage(cause, "Your change could not be saved.")); return false; }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function referenceOutcome(referenceId: string, expected: "present" | "missing") {
    if (!await load(true)) return false;
    const exists = dataRef.current.goalReferences.some(reference => reference.id === referenceId);
    return expected === "present" ? exists : !exists;
  }
  async function mutateGoalReferences(request: () => Promise<Response>, message: string, referenceId: string, expected: "present" | "missing") {
    if (busyRef.current || !loaded) return false;
    busyRef.current = true; setBusy(true); setError("");
    try {
      let response: Response;
      try { response = await request(); }
      catch (cause) {
        if (await referenceOutcome(referenceId, expected)) { setNotice(message); return true; }
        throw cause;
      }
      let result: unknown;
      try { result = await response.json(); }
      catch (cause) {
        if (!response.ok) throw new Error(`That reference could not be saved (HTTP ${response.status}).`);
        if (await referenceOutcome(referenceId, expected)) { setNotice(message); return true; }
        throw cause;
      }
      if (!response.ok) throw new Error(responseError(result, `That reference could not be saved (HTTP ${response.status}).`));
      try { receive(climbingStateSchema.parse(result)); }
      catch (cause) {
        if (await referenceOutcome(referenceId, expected)) { setNotice(message); return true; }
        throw cause;
      }
      etagRef.current = response.headers.get("etag") || ""; void loadCloudMedia(); setNotice(message); return true;
    } catch (cause) { setError(errorMessage(cause, "That reference could not be saved.")); return false; }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function addGoalLink(goalId: string, label: string, url: string) {
    const reference: GoalReference = { id: crypto.randomUUID(), goalId, kind: "link", label, url, fileName: null, mimeType: null, byteSize: null, createdAt: now() };
    const requestId = crypto.randomUUID();
    return mutateGoalReferences(() => fetch("/api/climbing/media/link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId, reference }) }), "Reference added", reference.id, "present");
  }
  async function uploadGoalFile(goalId: string, file: File) {
    if (file.size < 1) { setError("Choose a non-empty photo or video."); return false; }
    if (file.size > 200_000_000) { setError("Choose a photo or video smaller than 200 MB."); return false; }
    const label = file.name.replace(/\.[^.]+$/, "").trim() || file.name;
    const requestId = crypto.randomUUID();
    const referenceId = crypto.randomUUID();
    return mutateGoalReferences(() => fetch("/api/climbing/media/upload", {
      method: "POST",
      headers: {
        "X-Workspace-Request-Id": requestId,
        "X-Workspace-Reference-Id": referenceId,
        "X-Workspace-Goal-Id": goalId,
        "X-Workspace-File-Name": encodeURIComponent(file.name),
        "X-Workspace-Label": encodeURIComponent(label),
      },
      body: file,
    }), "Beta file added", referenceId, "present");
  }
  async function deleteGoalReference(reference: GoalReference) {
    const requestId = crypto.randomUUID();
    await mutateGoalReferences(() => fetch("/api/climbing/media/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId, goalId: reference.goalId, referenceId: reference.id }) }), "Reference removed", reference.id, "missing");
    setRemoveReference(null);
  }
  async function saveEditor(draft: Editor) {
    if (conflict) { setError("This draft is based on an older copy. Copy anything you need, then reopen the latest saved record before editing again."); return; }
    if (!draft.isNew) {
      const currentUpdatedAt = draft.kind === "session"
        ? dataRef.current.sessions.find(item => item.id === draft.value.id)?.updatedAt
        : draft.kind === "plan"
          ? dataRef.current.plans.find(item => item.id === draft.value.id)?.updatedAt
          : draft.kind === "goal"
            ? dataRef.current.goals.find(item => item.id === draft.value.id)?.updatedAt
            : dataRef.current.routines.find(item => item.id === draft.value.id)?.updatedAt;
      if (currentUpdatedAt !== draft.value.updatedAt) {
        setConflict(true);
        setError("This record changed while you were editing. Your draft is still here for review or copying; close it and reopen the latest saved version before saving.");
        return;
      }
    }
    try {
      const stamp = now();
      if (draft.kind === "session") {
        const value = climbingSessionSchema.parse({ ...draft.value, updatedAt: stamp });
        const sessions = draft.isNew ? [...dataRef.current.sessions, value] : dataRef.current.sessions.map(item => item.id === value.id ? value : item);
        const plans = value.planId ? dataRef.current.plans.map(plan => plan.id === value.planId ? { ...plan, status: "logged" as const, sessionId: value.id, updatedAt: stamp } : plan) : dataRef.current.plans;
        if (await save({ ...dataRef.current, sessions, plans }, draft.isNew && value.planId ? "Session logged and linked to its plan" : draft.isNew ? "Session logged" : "Session updated")) finishEditor();
      } else if (draft.kind === "plan") {
        const value = climbingPlanSchema.parse({ ...draft.value, updatedAt: stamp });
        const plans = draft.isNew ? [...dataRef.current.plans, value] : dataRef.current.plans.map(item => item.id === value.id ? value : item);
        if (await save({ ...dataRef.current, plans }, draft.isNew ? "Session planned" : "Plan updated")) finishEditor();
      } else if (draft.kind === "goal") {
        const value = climbingGoalSchema.parse({ ...draft.value, updatedAt: stamp });
        const goals = draft.isNew ? [...dataRef.current.goals, value] : dataRef.current.goals.map(item => item.id === value.id ? value : item);
        if (await save({ ...dataRef.current, goals }, draft.isNew ? "Goal added" : "Goal updated")) finishEditor();
      } else {
        const value = routineSchema.parse({ ...draft.value, version: draft.isNew ? 1 : draft.value.version + 1, updatedAt: stamp });
        const routines = draft.isNew ? [...dataRef.current.routines, value] : dataRef.current.routines.map(item => item.id === value.id ? value : item);
        if (await save({ ...dataRef.current, routines }, draft.isNew ? "Routine created" : "Routine updated")) finishEditor();
      }
    } catch (cause) { setError(errorMessage(cause, "Check the details and try again.")); }
  }
  async function toggleGoal(goal: ClimbingGoal) { const archivedAt = goal.archivedAt ? null : now(); await save({ ...dataRef.current, goals: dataRef.current.goals.map(item => item.id === goal.id ? { ...item, archivedAt, updatedAt: now() } : item) }, archivedAt ? "Goal archived" : "Goal restored"); }
  async function toggleRoutine(routine: Routine) { await save({ ...dataRef.current, routines: dataRef.current.routines.map(item => item.id === routine.id ? { ...item, archived: !item.archived, updatedAt: now() } : item) }, routine.archived ? "Routine restored" : "Routine archived"); }
  async function togglePlan(plan: ClimbingPlan) {
    if (plan.status === "logged") return;
    const status = plan.status === "cancelled" ? "planned" : "cancelled";
    await save({ ...dataRef.current, plans: dataRef.current.plans.map(item => item.id === plan.id ? { ...item, status, sessionId: null, updatedAt: now() } : item) }, status === "cancelled" ? "Local plan cancelled; its Calendar event was left unchanged" : "Plan restored; its Calendar event was left unchanged");
  }
  async function tombstone(session: ClimbingSession) { if (await save({ ...dataRef.current, sessions: dataRef.current.sessions.map(item => item.id === session.id ? { ...item, deletedAt: now(), updatedAt: now() } : item) }, "Session removed — you can restore it below")) { finishEditor(); setRemoveSession(null); } }
  async function restore(session: ClimbingSession) { await save({ ...dataRef.current, sessions: dataRef.current.sessions.map(item => item.id === session.id ? { ...item, deletedAt: null, updatedAt: now() } : item) }, "Session restored"); }
  function useRoutine(routine: Routine) { setTab("sessions"); openEditor({ kind: "session", value: newSession(dataRef.current, routine), isNew: true }); }
  function planRoutine(routine: Routine) { setTab("sessions"); openEditor({ kind: "plan", value: newPlan(dataRef.current, routine), isNew: true }); }
  function openRemote(draft: RemoteDraft) { integrations.openEditor(draft); }
  function schedulePlan(plan: ClimbingPlan) {
    if (!integrations.view.google.connected) { integrations.openSettings(); return; }
    const timed = plan.startTime !== null;
    openRemote({ provider: "google", day: plan.date, preset: { title: `Climbing · ${plan.title}`, date: plan.date, endDate: timed ? plan.endDate ?? plan.date : nextDay(plan.date), time: plan.startTime ?? undefined, endTime: plan.endTime ?? undefined, allDay: !timed, location: plan.venue }, link: { entityKind: "plan", entityId: plan.id, role: "scheduled-session" }, description: "Review this one-time climbing event before saving it. After it is linked, Google Calendar supplies the live date, time, and location." });
  }
  function createGoalTask(goal: ClimbingGoal) {
    if (!integrations.view.todoist.connected) { integrations.openSettings(); return; }
    openRemote({ provider: "todoist", day: goal.targetDate ?? dateKey(new Date()), preset: { title: goal.nextStep || goal.title, date: goal.targetDate }, link: { entityKind: "goal", entityId: goal.id, role: "goal-next-step" }, description: "Review this next action before saving it to your Personal project in Todoist. The climbing goal remains local." });
  }
  async function forgetCalendarLink(link: IntegrationLink) {
    try {
      await integrations.perform("/unlink", { id: link.id });
      setNotice("Calendar link forgotten; the external event was left unchanged");
    } catch (cause) {
      setError(errorMessage(cause, "The Calendar link could not be forgotten."));
    }
  }

  const sessions = useMemo(() => [...data.sessions].filter(session => !session.deletedAt).sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt)), [data.sessions]);
  const removed = useMemo(() => [...data.sessions].filter(session => session.deletedAt).sort((a, b) => (b.deletedAt ?? "").localeCompare(a.deletedAt ?? "")), [data.sessions]);
  const summary = useMemo(() => {
    const today = dateKey(new Date()); const start = new Date(); start.setDate(start.getDate() - 27); const startKey = dateKey(start);
    const recent = sessions.filter(session => session.date >= startKey && session.date <= today);
    return { count: recent.length, minutes: recent.reduce((sum, session) => sum + (session.durationMinutes ?? 0), 0), timed: recent.filter(session => session.durationMinutes !== null).length, indoor: recent.filter(session => session.environment === "indoor").length, outdoor: recent.filter(session => session.environment === "outdoor").length, sends: recent.reduce((sum, session) => sum + sessionSends(session), 0), attempts: recent.reduce((sum, session) => sum + session.climbs.reduce((count, climb) => count + (climb.attempts ?? 0), 0), 0) };
  }, [sessions]);
  const activeGoals = data.goals.filter(goal => !goal.archivedAt);
  const archivedGoals = data.goals.filter(goal => goal.archivedAt);
  const activeRoutines = data.routines.filter(routine => !routine.archived);
  const archivedRoutines = data.routines.filter(routine => routine.archived);
  const links = integrations.view.links ?? [];
  const createSession = () => openEditor({ kind: "session", value: newSession(dataRef.current), isNew: true });
  const createPlan = () => openEditor({ kind: "plan", value: newPlan(dataRef.current), isNew: true });
  const createGoal = () => openEditor({ kind: "goal", value: newGoal(), isNew: true });
  const createRoutine = () => openEditor({ kind: "routine", value: newRoutine(), isNew: true });

  return <div className="climbing-panel">
    {error && !editor && <div className="error-banner" role="alert"><p>{error}</p><button onClick={() => { if (loaded) setError(""); else void load(); }}>{loaded ? "Dismiss" : "Retry"}</button></div>}
    {integrations.error && !editor && <div className="settings-link-notice" role="alert"><p>Calendar or Todoist items need attention.</p><Button variant="outline" onClick={integrations.openSettings}>Open Settings</Button></div>}
    <Tabs value={tab} onValueChange={value => setTab(value as ClimbingTab)} className="climbing-tabs">
      <TabsList aria-label="Climbing views"><TabsTrigger value="sessions"><CalendarDays/>Sessions</TabsTrigger><TabsTrigger value="goals"><Flag/>Goals</TabsTrigger><TabsTrigger value="routines"><Dumbbell/>Routines</TabsTrigger></TabsList>
      <TabsContent value="sessions"><SessionsView loaded={loaded} busy={busy} integrationBusy={integrations.busy} sessions={sessions} goals={data.goals} plans={data.plans} removed={removed} summary={summary} links={links} events={integrations.view.events} calendarConnected={integrations.view.google.connected} edit={session => openEditor({ kind: "session", value: structuredClone(session), isNew: false })} editPlan={plan => openEditor({ kind: "plan", value: structuredClone(plan), isNew: false })} create={createSession} createPlan={createPlan} schedule={schedulePlan} openCalendar={event => openRemote({ provider: "google", item: event, day: event.startDate })} logPlan={(plan, event) => openEditor({ kind: "session", value: sessionFromPlan(plan, event), isNew: true })} togglePlan={togglePlan} forgetLink={setForgetCandidate} restore={restore}/></TabsContent>
      <TabsContent value="goals"><GoalsView loaded={loaded} busy={busy || integrations.busy} goals={activeGoals} archived={archivedGoals} goalReferences={data.goalReferences} sessions={sessions} links={links} tasks={integrations.view.tasks} todoistConnected={integrations.view.todoist.connected} edit={goal => openEditor({ kind: "goal", value: structuredClone(goal), isNew: false })} editSession={session => openEditor({ kind: "session", value: structuredClone(session), isNew: false })} create={createGoal} archive={toggleGoal} createTask={createGoalTask} openTask={task => openRemote({ provider: "todoist", item: task, day: task.dueDate ?? dateKey(new Date()) })}/></TabsContent>
      <TabsContent value="routines"><RoutinesView loaded={loaded} busy={busy} routines={activeRoutines} archived={archivedRoutines} edit={routine => openEditor({ kind: "routine", value: structuredClone(routine), isNew: false })} create={createRoutine} archive={toggleRoutine} use={useRoutine} plan={planRoutine}/></TabsContent>
    </Tabs>
    <Dialog open={editor?.kind === "session"} onOpenChange={open => { if (!open && !busy) requestEditorClose(); }}>{editor?.kind === "session" && <DialogContent className="editor-dialog climbing-dialog"><DialogTitle>{editor.isNew ? editor.value.planId ? "Log your planned session" : editor.value.routine ? `Use ${editor.value.routine.title}` : "Log a climbing session" : "Edit climbing session"}</DialogTitle><DialogDescription>{editor.value.planId ? "Record what happened. Saving links the session back to its plan in one step." : "Record what happened as completely or lightly as you like. Climb-by-climb details are optional."}</DialogDescription>{error && <EditorError error={error} conflict={conflict}/>}<SessionEditor draft={editor} goals={data.goals} plannedProject={editor.value.planId ? data.goals.find(goal => goal.kind === "project" && goal.id === data.plans.find(plan => plan.id === editor.value.planId)?.goalId) ?? null : null} dirtyRef={dirtyRef} busy={busy} blocked={conflict} health={health} healthLoaded={healthLoaded} healthError={healthError} allSessions={data.sessions} openHealth={() => { finishEditor(); openHealth(); }} save={saveEditor} remove={session => setRemoveSession(session)}/></DialogContent>}</Dialog>
    <Dialog open={editor?.kind === "plan"} onOpenChange={open => { if (!open && !busy) requestEditorClose(); }}>{editor?.kind === "plan" && <DialogContent className="editor-dialog climbing-dialog"><DialogTitle>{editor.isNew ? "Plan a climbing session" : "Edit climbing plan"}</DialogTitle><DialogDescription>Choose the local intent first. You can review and add the plan to Google Calendar after it is saved.</DialogDescription>{error && <EditorError error={error} conflict={conflict}/>}<PlanEditor draft={editor} goals={data.goals} routines={data.routines} calendarLink={linkFor(links, "scheduled-session", editor.value.id)} event={remoteFor(integrations.view.events, linkFor(links, "scheduled-session", editor.value.id))} dirtyRef={dirtyRef} busy={busy} blocked={conflict} save={saveEditor}/></DialogContent>}</Dialog>
    <Dialog open={editor?.kind === "goal"} onOpenChange={open => { if (!open && !busy) requestEditorClose(); }}>{editor?.kind === "goal" && <DialogContent className="editor-dialog climbing-dialog"><DialogTitle>{editor.isNew ? "Set a climbing goal" : "Edit climbing goal"}</DialogTitle><DialogDescription>Use a climb project for a specific route or problem, or track consistency, skill, and training.</DialogDescription>{error && <EditorError error={error} conflict={conflict}/>}<GoalEditor draft={editor} routines={data.routines} references={data.goalReferences.filter(reference => reference.goalId === editor.value.id)} cloudItems={cloudMedia.items} cloudError={cloudMediaError} sessions={data.sessions} dirtyRef={dirtyRef} busy={busy} blocked={conflict} save={saveEditor} addLink={addGoalLink} uploadFile={uploadGoalFile} removeReference={setRemoveReference}/></DialogContent>}</Dialog>
    <Dialog open={editor?.kind === "routine"} onOpenChange={open => { if (!open && !busy) requestEditorClose(); }}>{editor?.kind === "routine" && <DialogContent className="editor-dialog climbing-dialog"><DialogTitle>{editor.isNew ? "Create a training routine" : "Edit training routine"}</DialogTitle><DialogDescription>Write the workload you want to follow. Each plan or session keeps a copy of the version used.</DialogDescription>{error && <EditorError error={error} conflict={conflict}/>}<RoutineEditor draft={editor} dirtyRef={dirtyRef} busy={busy} blocked={conflict} save={saveEditor}/></DialogContent>}</Dialog>
    <AlertDialog open={!!removeSession} onOpenChange={open => !open && setRemoveSession(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Remove this session?</AlertDialogTitle><AlertDialogDescription>It will stop counting toward summaries and goals. You can restore it from the removed sessions list. Any linked plan and Health workout are retained for a safe restore.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>Keep session</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={busy} onClick={() => removeSession && void tombstone(removeSession)}>Remove session</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <AlertDialog open={!!removeReference} onOpenChange={open => !open && setRemoveReference(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Remove this reference?</AlertDialogTitle><AlertDialogDescription>{removeReference?.kind === "link" ? "The saved link will be removed from this goal." : "The saved file will be permanently removed from this Mac."}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>Keep reference</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={busy} onClick={() => removeReference && void deleteGoalReference(removeReference)}>Remove</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <AlertDialog open={!!forgetCandidate} onOpenChange={open => !open && setForgetCandidate(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Forget this Calendar link?</AlertDialogTitle><AlertDialogDescription>The event in Google Calendar will stay unchanged if it still exists. This plan keeps its local details, and you can link it to a replacement event afterward.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={integrations.busy}>Keep link</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={integrations.busy} onClick={() => { const link = forgetCandidate; setForgetCandidate(null); if (link) void forgetCalendarLink(link); }}>Forget link</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Discard these unsaved changes?</AlertDialogTitle><AlertDialogDescription>Your saved climbing log will stay as it is, but the changes in this editor will be lost.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep editing</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={finishEditor}>Discard changes</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    {notice && <div className="toast" role="status"><Check size={16}/><span>{notice}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setNotice("")}>×</button></div>}
  </div>;
}

function EditorError({ error, conflict }: { error: string; conflict: boolean }) { return <div className="form-error climbing-editor-error" role="alert"><p>{error}</p>{conflict && <p>Saving is disabled for this draft so it cannot overwrite the latest record.</p>}</div>; }

type Summary = { count: number; minutes: number; timed: number; indoor: number; outdoor: number; sends: number; attempts: number };

function SessionsView({ loaded, busy, integrationBusy, sessions, goals, plans, removed, summary, links, events, calendarConnected, edit, editPlan, create, createPlan, schedule, openCalendar, logPlan, togglePlan, forgetLink, restore }: {
  loaded: boolean; busy: boolean; integrationBusy: boolean; sessions: ClimbingSession[]; goals: ClimbingGoal[]; plans: ClimbingPlan[]; removed: ClimbingSession[]; summary: Summary;
  links: IntegrationLink[]; events: RemoteEvent[]; calendarConnected: boolean; edit: (session: ClimbingSession) => void; editPlan: (plan: ClimbingPlan) => void;
  create: () => void; createPlan: () => void; schedule: (plan: ClimbingPlan) => void; openCalendar: (event: RemoteEvent) => void; logPlan: (plan: ClimbingPlan, event?: RemoteEvent) => void;
  togglePlan: (plan: ClimbingPlan) => Promise<void>; forgetLink: (link: IntegrationLink) => void; restore: (session: ClimbingSession) => Promise<void>;
}) {
  const planned = plans.filter(plan => plan.status === "planned").sort((a, b) => a.date.localeCompare(b.date) || (a.startTime ?? "").localeCompare(b.startTime ?? ""));
  const cancelled = plans.filter(plan => plan.status === "cancelled").sort((a, b) => b.date.localeCompare(a.date));
  const goalsById = new Map(goals.map(goal => [goal.id, goal]));
  const today = dateKey(new Date());
  return <div className="climbing-stack">
    {loaded && summary.count > 0 && <section className="climbing-summary"><div className="climbing-summary-heading"><div><span className="climbing-kicker">LAST 4 WEEKS</span><h2>Recent climbing</h2></div><span>{summary.indoor} gym · {summary.outdoor} outside</span></div><div className="climbing-metrics"><article><span>Sessions</span><strong>{summary.count}</strong></article>{summary.minutes > 0 && <article><span>Time</span><strong>{minutesLabel(summary.minutes)}</strong></article>}{summary.sends > 0 && <article><span>Sends</span><strong>{summary.sends}</strong></article>}{summary.attempts > 0 && <article><span>Attempts</span><strong>{summary.attempts}</strong></article>}</div></section>}

    <section className="climbing-card climbing-plans"><div className="climbing-card-heading"><div><span className="climbing-kicker">PLAN</span><h2>Upcoming sessions</h2></div>{planned.length > 0 && <Button variant="outline" disabled={busy} onClick={createPlan}><Plus/>Plan session</Button>}</div>
      {!loaded ? <p className="climbing-loading">Loading your plans…</p> : planned.length ? <div className="climbing-plan-list">{planned.map(plan => {
        const link = linkFor(links, "scheduled-session", plan.id);
        const event = remoteFor(events, link);
        const effectiveDay = event?.startDate ?? plan.date;
        const effectiveVenue = event?.location || plan.venue;
        const scheduleLabel = event ? event.allDay ? "All day" : `${event.startTime}–${event.endTime}` : plan.startTime ? `${plan.startTime}–${plan.endTime}` : "Time open";
        return <article className="climbing-plan-row" key={plan.id}>
          <div className="climbing-plan-date"><CalendarClock/><strong>{dayLabel(effectiveDay)}</strong><span>{scheduleLabel}</span></div>
          <div className="climbing-plan-copy"><div className="climbing-plan-title"><h3>{plan.title}</h3>{link && <span className="connection-chip calendar"><CalendarDays/>Calendar linked</span>}</div><p>{focusNames[plan.focus]} · {plan.environment === "indoor" ? "Gym" : "Outside"}{effectiveVenue ? ` · ${effectiveVenue}` : ""}</p>{plan.routine && <small>Routine snapshot · {plan.routine.title} v{plan.routine.version}</small>}{link && !event && <p className="climbing-source-warning">Calendar event unavailable. The local plan is retained, and its saved schedule stays locked.</p>}{event && <p className="climbing-source-note">Schedule from Google Calendar{event.title !== `Climbing · ${plan.title}` ? ` · ${event.title}` : ""}</p>}</div>
          <div className="climbing-plan-actions">
            {!link && <Button size="sm" variant="outline" disabled={integrationBusy} onClick={() => schedule(plan)}>{calendarConnected ? <><CalendarDays/>Add to Calendar</> : <><Link2/>Open Settings</>}</Button>}
            {event && <Button size="sm" variant="outline" disabled={integrationBusy} onClick={() => openCalendar(event)}>Edit Calendar</Button>}
            <Button size="sm" disabled={busy || effectiveDay > today} title={effectiveDay > today ? "Log this session on or after its scheduled day" : undefined} onClick={() => logPlan(plan, event)}>Log session</Button>
            <button className="climbing-quiet-action" disabled={busy} aria-label={`Edit plan ${plan.title}`} onClick={() => editPlan(plan)}>Edit plan</button>
            {link && !event && <button className="climbing-quiet-action danger" disabled={integrationBusy} aria-label={`Forget unavailable Calendar link for ${plan.title}`} onClick={() => forgetLink(link)}>Forget Calendar link</button>}
            <button className="climbing-quiet-action" disabled={busy} aria-label={`Cancel local plan ${plan.title}`} onClick={() => void togglePlan(plan)}>Cancel locally</button>
          </div>
        </article>;
      })}</div> : <div className="climbing-plan-empty"><CalendarClock/><div><h3>Plan the next session.</h3><p>Add a session here first. Scheduling it in Calendar is a separate, reviewable step.</p></div><Button disabled={busy} onClick={createPlan}><Plus/>Plan a session</Button></div>}
      {cancelled.length > 0 && <ArchivedList label="Cancelled local plans">{cancelled.map(plan => <div key={plan.id}><span><strong>{dayLabel(plan.date)} · {plan.title}</strong><small>{linkFor(links, "scheduled-session", plan.id) ? "Calendar link retained · external event unchanged" : "No Calendar event linked"}</small></span><Button size="sm" variant="outline" disabled={busy} onClick={() => void togglePlan(plan)}><RotateCcw/>Restore</Button></div>)}</ArchivedList>}
    </section>

    <section className="climbing-card"><div className="climbing-card-heading"><div><span className="climbing-kicker">DO · REFLECT</span><h2>Session log</h2></div>{sessions.length > 0 && <Button variant="outline" disabled={busy} onClick={create}><Plus/>Log session</Button>}</div>
      {!loaded ? <p className="climbing-loading">Loading your climbing log…</p> : sessions.length ? <div className="session-list">{sessions.map(session => {
        const sends = sessionSends(session);
        const planLink = session.planId ? linkFor(links, "scheduled-session", session.planId) : undefined;
        const projectIds = [...new Set(session.climbs.flatMap(climb => climb.projectGoalId ? [climb.projectGoalId] : []))];
        const projectLabel = projectIds.length === 1 ? `Project · ${goalsById.get(projectIds[0])?.title ?? "Linked project"}` : `${projectIds.length} projects`;
        return <button className="session-row" key={session.id} onClick={() => edit(session)} aria-label={`Edit climbing session at ${session.venue} on ${dayLabel(session.date)}`}><span className={`session-marker ${session.environment}`}><Mountain/></span><span className="session-main"><strong>{dayLabel(session.date)} · {session.venue}</strong><small>{focusNames[session.focus]}{session.durationMinutes ? ` · ${minutesLabel(session.durationMinutes)}` : ""}</small><span className="climbing-session-links">{projectIds.length > 0 && <span className="connection-chip project"><Flag/>{projectLabel}</span>}{planLink && <span className="connection-chip calendar"><CalendarDays/>Planned in Calendar</span>}{session.healthWorkoutId && <span className="connection-chip health"><HeartPulse/>Health linked</span>}</span>{session.notes && <p>{session.notes}</p>}</span><span className="session-counts">{session.climbs.length ? <><strong>{session.climbs.length}</strong><small>climbs</small><em>{sends} {sends === 1 ? "send" : "sends"}</em></> : session.routine ? <><Dumbbell/><small>{session.routine.title}</small></> : <small>Session note</small>}</span></button>;
      })}</div> : <div className="climbing-empty"><span><Mountain/></span><h3>Log your last climbing session.</h3><p>A quick entry only needs a date, place, and session type. Add climbs or training detail when it helps.</p><Button disabled={busy} onClick={create}><Plus/>Log a session</Button></div>}
      {removed.length > 0 && <details className="climbing-archive"><summary>{removed.length} removed {removed.length === 1 ? "session" : "sessions"}</summary>{removed.map(session => <div key={session.id}><span><strong>{dayLabel(session.date)} · {session.venue}</strong><small>{focusNames[session.focus]}{session.planId ? " · plan link retained" : ""}{session.healthWorkoutId ? " · Health link retained" : ""}</small></span><Button size="sm" variant="outline" disabled={busy} onClick={() => void restore(session)}><RotateCcw/>Restore</Button></div>)}</details>}
    </section>
  </div>;
}

type ProjectHistory = ReturnType<typeof projectGoalHistory>;

function ProjectStats({ history }: { history: ProjectHistory }) {
  const manualAttempts = history.manualAttemptCount ?? 0;
  if (!history.linkedSessionCount && !history.knownLinkedAttempts && !manualAttempts && !history.uncountedLinkedClimbs) return null;
  return <section className="goal-project-stats" aria-label="Project session totals">
    <div>{history.linkedSessionCount > 0 && <span><strong>{history.linkedSessionCount}</strong><small>{history.linkedSessionCount === 1 ? "linked session" : "linked sessions"}</small></span>}{history.knownLinkedAttempts > 0 && <span><strong>{history.knownLinkedAttempts}</strong><small>session-recorded attempts</small></span>}{manualAttempts > 0 && <span><strong>{manualAttempts}</strong><small>manual attempt total</small></span>}{history.uncountedLinkedClimbs > 0 && <span className="needs-count"><strong>{history.uncountedLinkedClimbs}</strong><small>{history.uncountedLinkedClimbs === 1 ? "linked entry without a count" : "linked entries without counts"}</small></span>}</div>
    {(history.lastTriedOn || history.firstCompletion) && <p>{history.lastTriedOn && <span>Last worked {dayLabel(history.lastTriedOn)}</span>}{history.firstCompletion && <span>Sent {dayLabel(history.firstCompletion.session.date)} · {outcomeNames[history.firstCompletion.climb.outcome]}</span>}</p>}
  </section>;
}

function ProjectHistoryDetails({ history, openSession }: { history: ProjectHistory; openSession?: (session: ClimbingSession) => void }) {
  if (!history.entries.length) return null;
  return <details className="goal-project-history">
    <summary><span><Activity/>Session history</span><small>{history.linkedSessionCount}</small></summary>
    <div>{[...history.entries].reverse().map(({ session, climb }) => {
      const copy = <><span><strong>{dayLabel(session.date)} · {session.venue}</strong><small>{outcomeNames[climb.outcome]} · {climb.attempts === null ? "Attempt count missing" : `${climb.attempts} ${climb.attempts === 1 ? "attempt" : "attempts"}`}</small>{climb.notes && <small className="project-history-note">{climb.notes}</small>}</span>{openSession && <ExternalLink/>}</>;
      return openSession ? <button type="button" key={`${session.id}:${climb.id}`} onClick={() => openSession(session)} aria-label={`Open ${session.venue} session from ${dayLabel(session.date)}`}>{copy}</button> : <div key={`${session.id}:${climb.id}`}>{copy}</div>;
    })}</div>
  </details>;
}

function GoalsView({ loaded, busy, goals, archived, goalReferences, sessions, links, tasks, todoistConnected, edit, editSession, create, archive, createTask, openTask }: {
  loaded: boolean; busy: boolean; goals: ClimbingGoal[]; archived: ClimbingGoal[]; goalReferences: GoalReference[]; sessions: ClimbingSession[]; links: IntegrationLink[]; tasks: RemoteTask[]; todoistConnected: boolean;
  edit: (goal: ClimbingGoal) => void; editSession: (session: ClimbingSession) => void; create: () => void; archive: (goal: ClimbingGoal) => Promise<void>; createTask: (goal: ClimbingGoal) => void; openTask: (task: RemoteTask) => void;
}) {
  return <div className="climbing-stack"><section className="climbing-card"><div className="climbing-card-heading"><div><h2>What you’re working toward</h2></div>{goals.length > 0 && <Button variant="outline" disabled={busy} onClick={create}><Plus/>New goal</Button>}</div>
    {!loaded ? <p className="climbing-loading">Loading your goals…</p> : goals.length ? <div className="goal-grid">{goals.map(goal => {
      const measured = consistencyProgress(goal, sessions);
      const percent = goal.kind === "consistency" ? measured.percent : goal.progress;
      const history = goal.kind === "project" ? projectGoalHistory(goal, sessions) : null;
      const taskLinks = links.filter(link => link.role === "goal-next-step" && link.entityId === goal.id);
      const references = goalReferences.filter(reference => reference.goalId === goal.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const firstReference = references[0];
      const projectMeta = goal.kind === "project" ? [
        goal.grade,
        goal.venue,
        goal.environment === "indoor" ? "Gym" : goal.environment === "outdoor" ? "Outside" : null,
        goal.ropeStyle ? ropeStyleNames[goal.ropeStyle] : null,
      ].filter(Boolean).join(" · ") : "";
      const projectKind = goal.discipline === "boulder" ? "Boulder project" : goal.discipline === "route" ? "Route project" : goalKindNames.project;
      const effectiveProjectStatus = goal.kind === "project" && history ? history.effectiveStatus : goal.status;
      const statusLabel = goal.kind === "project" ? { active: "Projecting", paused: "Paused", completed: "Sent" }[effectiveProjectStatus] : goal.status;
      return <article className="goal-card" key={goal.id}><div className="goal-top"><span className={`goal-status ${effectiveProjectStatus}`}>{statusLabel}</span><span>{goal.kind === "project" ? projectKind : goalKindNames[goal.kind]}</span></div><div className="goal-body"><h3>{goal.title}</h3>{projectMeta && <div className="goal-project-meta">{projectMeta}</div>}{goal.description && <p>{goal.description}</p>}{history && <><ProjectStats history={history}/><ProjectHistoryDetails history={history} openSession={editSession}/></>}{goal.kind !== "project" && <div className="goal-progress"><Progress value={percent} aria-label={`${goal.title} progress`}/><span>{goal.kind === "consistency" ? `${measured.completed} of ${measured.target} sessions` : `${goal.progress}%`}</span></div>}{goal.nextStep && <small><strong>Next:</strong> {goal.nextStep}</small>}{goal.targetDate && <small>Target · {dayLabel(goal.targetDate)}</small>}
        {firstReference && <a className="goal-reference-summary" href={referenceHref(firstReference)} target="_blank" rel="noreferrer" aria-label={`Open ${referenceName(firstReference)} for ${goal.title}`}><ReferenceIcon reference={firstReference}/><span><strong>Beta · {references.length}</strong><small>{referenceName(firstReference)}</small></span><ExternalLink/></a>}
        {taskLinks.length > 0 && <div className="goal-linked-tasks" aria-label={`Todoist actions linked to ${goal.title}`}>{taskLinks.map(link => { const task = remoteFor(tasks, link); return task ? <button key={link.id} disabled={busy} onClick={() => openTask(task)} aria-label={`Edit linked Todoist task ${task.title}`}><ListTodo/><span><strong>{task.title}</strong><small>{task.dueDate ? `Due ${dayLabel(task.dueDate)}` : "No due date"}</small></span></button> : <div className="goal-missing-task" key={link.id}><ListTodo/><span><strong>{todoistConnected ? "No longer active in Todoist" : "Todoist disconnected"}</strong><small>{todoistConnected ? "It may be completed, deleted, or moved outside Personal." : "The saved task link is retained."}</small></span></div>; })}</div>}
      </div><div className="goal-actions"><div className="goal-primary-actions"><Button size="sm" variant="outline" disabled={busy} onClick={() => createTask(goal)}>{todoistConnected ? <><Plus/>Add next action to Todoist</> : <><Link2/>Open Settings</>}</Button><button className="climbing-quiet-action" disabled={busy} onClick={() => edit(goal)}>Edit goal</button></div><button className="climbing-quiet-action" disabled={busy} onClick={() => void archive(goal)}><Archive/>Archive</button></div></article>;
    })}</div> : <div className="climbing-empty"><span><Flag/></span><h3>Give the next chapter a direction.</h3><p>Track a consistency target, a specific climb project, a skill, or a goal in your own words.</p><Button disabled={busy} onClick={create}><Plus/>Set a goal</Button></div>}
    {archived.length > 0 && <ArchivedList label="Archived goals">{archived.map(goal => <div key={goal.id}><span><strong>{goal.title}</strong><small>{goalKindNames[goal.kind]}</small></span><Button size="sm" variant="outline" disabled={busy} onClick={() => void archive(goal)}><RotateCcw/>Restore</Button></div>)}</ArchivedList>}
  </section></div>;
}

function RoutinesView({ loaded, busy, routines, archived, edit, create, archive, use, plan }: {
  loaded: boolean; busy: boolean; routines: Routine[]; archived: Routine[]; edit: (routine: Routine) => void; create: () => void;
  archive: (routine: Routine) => Promise<void>; use: (routine: Routine) => void; plan: (routine: Routine) => void;
}) {
  return <div className="climbing-stack"><section className="climbing-card"><div className="climbing-card-heading"><div><h2>Training routines</h2></div>{routines.length > 0 && <Button variant="outline" disabled={busy} onClick={create}><Plus/>New routine</Button>}</div>
    {!loaded ? <p className="climbing-loading">Loading your routines…</p> : routines.length ? <div className="routine-grid">{routines.map(routine => <article className="routine-card" key={routine.id}><div className="routine-icon"><Dumbbell/></div><div className="routine-copy"><span>{routineFocusNames[routine.focus]} · v{routine.version}</span><h3>{routine.title}</h3>{routine.description && <p>{routine.description}</p>}<ol>{routine.steps.slice(0, 3).map(step => <li key={step.id}>{step.name}<small>{step.prescription}</small></li>)}</ol>{routine.steps.length > 3 && <small>+ {routine.steps.length - 3} more steps</small>}<div className="routine-meta">{routine.estimatedMinutes && <span><Timer/>{routine.estimatedMinutes} min</span>}<span>{routine.steps.length} {routine.steps.length === 1 ? "step" : "steps"}</span></div><div className="routine-actions"><Button disabled={busy} onClick={() => use(routine)}>Use now</Button><Button variant="outline" disabled={busy} onClick={() => plan(routine)}><CalendarClock/>Plan session</Button><Button variant="outline" disabled={busy} onClick={() => edit(routine)}>Edit</Button><button className="climbing-quiet-action" disabled={busy} onClick={() => void archive(routine)}><Archive/>Archive</button></div></div></article>)}</div> : <div className="climbing-empty"><span><Dumbbell/></span><h3>Turn a workout into a routine.</h3><p>Add the steps and workload you choose. A plan or session receives its own snapshot, so later routine edits do not rewrite history.</p><Button disabled={busy} onClick={create}><Plus/>Create a routine</Button></div>}
    {archived.length > 0 && <ArchivedList label="Archived routines">{archived.map(routine => <div key={routine.id}><span><strong>{routine.title}</strong><small>{routineFocusNames[routine.focus]} · v{routine.version}</small></span><Button size="sm" variant="outline" disabled={busy} onClick={() => void archive(routine)}><RotateCcw/>Restore</Button></div>)}</ArchivedList>}
  </section></div>;
}

function ArchivedList({ label, children }: { label: string; children: ReactNode }) { return <details className="climbing-archive"><summary>{label}</summary>{children}</details>; }

function PlanEditor({ draft, goals, routines, calendarLink, event, dirtyRef, busy, blocked, save }: {
  draft: Extract<Editor, { kind: "plan" }>; goals: ClimbingGoal[]; routines: Routine[]; calendarLink?: IntegrationLink; event?: RemoteEvent;
  dirtyRef: MutableRefObject<boolean>; busy: boolean; blocked: boolean; save: (draft: Editor) => Promise<void>;
}) {
  const [value, setValue] = useState(draft.value);
  const scheduleLocked = !!calendarLink;
  const timed = value.startTime !== null;
  const dirty = JSON.stringify(value) !== JSON.stringify(draft.value);
  useEffect(() => { dirtyRef.current = dirty; return () => { dirtyRef.current = false; }; }, [dirty, dirtyRef]);
  const goalOptions = goals.filter(goal => !goal.archivedAt || goal.id === value.goalId);
  const routineOptions = routines.filter(routine => !routine.archived || routine.id === value.routine?.routineId);
  function changeTimed(checked: boolean) { setValue(current => checked ? { ...current, startTime: "18:00", endDate: current.date, endTime: "20:00" } : { ...current, startTime: null, endDate: null, endTime: null }); }
  function chooseRoutine(id: string) { const routine = routines.find(item => item.id === id); setValue(current => ({ ...current, routine: routine ? routineSnapshot(routine) : null, focus: routine ? "training" : current.focus })); }
  return <form className="climbing-form" onSubmit={submit => { submit.preventDefault(); void save({ ...draft, value }); }}>
    {scheduleLocked && <section className="climbing-connected-context"><CalendarDays/><div><strong>Google Calendar supplies this plan’s schedule.</strong><p>{event ? `${dayLabel(event.startDate)}${event.allDay ? " · All day" : ` · ${event.startTime}–${event.endTime}`}${event.location ? ` · ${event.location}` : ""}` : "The event is unavailable or outside the current sync. The saved link and local schedule are retained."}</p></div></section>}
    <label>Plan name<Input required maxLength={200} disabled={busy} value={value.title} placeholder="Evening bouldering, Smith Rock day…" onChange={change => setValue({ ...value, title: change.target.value })}/></label>
    <div className="climbing-form-grid three"><label>Date<Input required type="date" disabled={busy || scheduleLocked} value={value.date} onChange={change => setValue(current => ({ ...current, date: change.target.value, ...(current.startTime && current.endDate === current.date ? { endDate: change.target.value } : {}) }))}/></label><label>Setting<select disabled={busy} value={value.environment} onChange={change => setValue({ ...value, environment: change.target.value as ClimbingPlan["environment"] })}><option value="indoor">Gym</option><option value="outdoor">Outside</option></select></label><label>Session type<select disabled={busy} value={value.focus} onChange={change => setValue({ ...value, focus: change.target.value as ClimbingPlan["focus"] })}>{Object.entries(focusNames).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label></div>
    <label>Venue or area <span>optional</span><Input maxLength={200} disabled={busy || scheduleLocked} value={value.venue} placeholder={value.environment === "indoor" ? "Gym name" : "Crag or area"} onChange={change => setValue({ ...value, venue: change.target.value })}/></label>
    <label className="climbing-timed-control"><input type="checkbox" checked={timed} disabled={busy || scheduleLocked} onChange={change => changeTimed(change.target.checked)}/>Choose a start and end time</label>
    {timed && <div className="climbing-form-grid three"><label>Starts<Input required type="time" disabled={busy || scheduleLocked} value={value.startTime ?? ""} onChange={change => setValue({ ...value, startTime: change.target.value || null })}/></label><label>Ends on<Input required type="date" min={value.date} disabled={busy || scheduleLocked} value={value.endDate ?? ""} onChange={change => setValue({ ...value, endDate: change.target.value || null })}/></label><label>Ends<Input required type="time" disabled={busy || scheduleLocked} value={value.endTime ?? ""} onChange={change => setValue({ ...value, endTime: change.target.value || null })}/></label></div>}
    <div className="climbing-form-grid two"><label>Related goal <span>optional</span><select disabled={busy} value={value.goalId ?? ""} onChange={change => setValue({ ...value, goalId: change.target.value || null })}><option value="">No linked goal</option>{goalOptions.map(goal => <option key={goal.id} value={goal.id}>{goal.title}{goal.archivedAt ? " (archived)" : ""}</option>)}</select></label><label>Routine snapshot <span>optional</span><select disabled={busy} value={value.routine?.routineId ?? ""} onChange={change => chooseRoutine(change.target.value)}><option value="">No routine</option>{routineOptions.map(routine => <option key={routine.id} value={routine.id}>{routine.title} · v{routine.version}{routine.archived ? " (archived)" : ""}</option>)}</select></label></div>
    {value.routine && <p className="climbing-form-note"><Dumbbell/>This plan keeps {value.routine.title} v{value.routine.version}. Future edits to the reusable routine will not change this copy.</p>}
    {!scheduleLocked && <p className="climbing-form-note"><CalendarDays/>Saving creates a local plan only. You will review the Calendar event in a separate step.</p>}
    <div className="editor-actions"><span/><div><DialogClose asChild><Button type="button" variant="outline" disabled={busy}>Cancel</Button></DialogClose><Button type="submit" disabled={busy || blocked}>{busy ? "Saving…" : blocked ? "Reopen latest to save" : draft.isNew ? "Save plan" : "Save changes"}</Button></div></div>
  </form>;
}

function SessionEditor({ draft, goals, plannedProject, dirtyRef, busy, blocked, health, healthLoaded, healthError, allSessions, openHealth, save, remove }: {
  draft: Extract<Editor, { kind: "session" }>; goals: ClimbingGoal[]; plannedProject: ClimbingGoal | null; dirtyRef: MutableRefObject<boolean>; busy: boolean; blocked: boolean; health: HealthView | null;
  healthLoaded: boolean; healthError: string; allSessions: ClimbingSession[]; openHealth: () => void; save: (draft: Editor) => Promise<void>; remove: (session: ClimbingSession) => void;
}) {
  const [value, setValue] = useState(draft.value);
  const [today] = useState(() => dateKey(new Date()));
  const dirty = JSON.stringify(value) !== JSON.stringify(draft.value);
  useEffect(() => { dirtyRef.current = dirty; return () => { dirtyRef.current = false; }; }, [dirty, dirtyRef]);
  const updateClimb = (id: string, update: Partial<Climb>) => setValue(current => ({ ...current, climbs: current.climbs.map(climb => climb.id === id ? { ...climb, ...update } : climb) }));
  const projectGoals = goals.filter(goal => goal.kind === "project").sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt) || a.title.localeCompare(b.title));
  const linkedProjectIds = new Set(value.climbs.flatMap(climb => climb.projectGoalId ? [climb.projectGoalId] : []));
  const persistedClimbIds = new Set(draft.isNew ? [] : draft.value.climbs.map(climb => climb.id));
  const availableProjects = projectGoals.filter(goal => !linkedProjectIds.has(goal.id));
  const suggestedProject = plannedProject && !linkedProjectIds.has(plannedProject.id) ? plannedProject : null;
  const pickerProjects = availableProjects.filter(goal => goal.id !== suggestedProject?.id);
  const addProject = (goalId: string) => {
    const goal = projectGoals.find(candidate => candidate.id === goalId);
    if (goal && !linkedProjectIds.has(goal.id)) setValue(current => ({ ...current, climbs: [...current.climbs, projectClimb(goal)] }));
  };
  const updateRoutine = (update: RoutineExecution) => setValue(current => ({ ...current, routine: update }));
  const snapshot = health?.snapshot;
  const selectedWorkoutId = value.healthWorkoutId?.toLowerCase() ?? null;
  const usedWorkoutIds = new Set(allSessions.flatMap(session => session.id !== value.id && session.healthWorkoutId ? [session.healthWorkoutId.toLowerCase()] : []));
  const snapshotWorkouts = snapshot ? uniqueHealthWorkouts(snapshot.workouts) : [];
  const linkedWorkout = selectedWorkoutId ? snapshotWorkouts.find(workout => workout.id.toLowerCase() === selectedWorkoutId) : undefined;
  const workouts = snapshot ? snapshotWorkouts.filter(workout => healthWorkoutDay(workout, snapshot.timeZone) === value.date && (!usedWorkoutIds.has(workout.id.toLowerCase()) || workout.id.toLowerCase() === selectedWorkoutId)).sort((a, b) => Number((b.activity ?? "other") === "climbing") - Number((a.activity ?? "other") === "climbing") || a.start.localeCompare(b.start)) : [];
  const healthDay = snapshot?.days.find(day => day.date === value.date);
  const linkedWorkoutDay = linkedWorkout && snapshot ? healthWorkoutDay(linkedWorkout, snapshot.timeZone) : null;
  return <form className="climbing-form" onSubmit={event => { event.preventDefault(); void save({ ...draft, value }); }}>
    {value.planId && <section className="climbing-connected-context"><CalendarClock/><div><strong>This session comes from a saved plan.</strong><p>Saving logs the session and completes the local plan together. Actual duration and results remain yours to record.</p></div></section>}
    <div className="climbing-form-grid three"><label>Date<Input required type="date" max={today} disabled={busy} value={value.date} onChange={event => setValue({ ...value, date: event.target.value })}/></label><label>Setting<select disabled={busy} value={value.environment} onChange={event => setValue({ ...value, environment: event.target.value as ClimbingSession["environment"] })}><option value="indoor">Gym</option><option value="outdoor">Outside</option></select></label><label>Session type<select disabled={busy} value={value.focus} onChange={event => setValue({ ...value, focus: event.target.value as ClimbingSession["focus"] })}>{Object.entries(focusNames).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label></div>
    <label>Venue or area<Input required maxLength={200} disabled={busy} value={value.venue} placeholder={value.environment === "indoor" ? "Gym name" : "Crag or area"} onChange={event => setValue({ ...value, venue: event.target.value })}/></label>
    <div className="climbing-form-grid three"><label>Duration <span>optional</span><Input type="number" min={5} max={900} disabled={busy} value={value.durationMinutes ?? ""} placeholder="Minutes" onChange={event => setValue({ ...value, durationMinutes: nullableNumber(event.target.value) })}/></label><label>Effort <span>optional</span><select disabled={busy} value={value.effort ?? ""} onChange={event => setValue({ ...value, effort: nullableNumber(event.target.value) })}><option value="">Not logged</option>{Array.from({ length: 10 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1} / 10</option>)}</select></label><label>How you arrived <span>optional</span><select disabled={busy} value={value.readiness ?? ""} onChange={event => setValue({ ...value, readiness: event.target.value ? event.target.value as ClimbingSession["readiness"] : null })}><option value="">Not logged</option><option value="fresh">Fresh</option><option value="steady">Steady</option><option value="tired">Tired</option><option value="sore">Sore</option></select></label></div>
    <HealthContext health={health} healthLoaded={healthLoaded} error={healthError} day={value.date} healthDay={healthDay} workouts={workouts} linkedWorkout={linkedWorkout} linkedWorkoutDay={linkedWorkoutDay} selectedId={value.healthWorkoutId ?? null} duration={value.durationMinutes} busy={busy} navigationDisabled={dirty} choose={id => setValue(current => ({ ...current, healthWorkoutId: id }))} applyDuration={minutes => setValue(current => ({ ...current, durationMinutes: minutes }))} openHealth={openHealth}/>
    {value.routine && <section className="routine-execution"><div><span className="climbing-kicker">ROUTINE SNAPSHOT · V{value.routine.version}</span><h3>{value.routine.title}</h3><p>{value.routine.description || "This copy belongs to this session and will not change when you edit the routine."}{value.routine.estimatedMinutes ? ` · Planned ${value.routine.estimatedMinutes} minutes.` : ""}</p></div>{value.routine.steps.map((step, index) => <div className="execution-step" key={step.id}><span>{index + 1}</span><div><strong>{step.name}</strong><small>{step.prescription}{step.rest ? ` · Rest ${step.rest}` : ""}{step.notes ? ` · ${step.notes}` : ""}</small><select aria-label={`${step.name} status`} disabled={busy} value={step.status} onChange={event => updateRoutine({ ...value.routine!, steps: value.routine!.steps.map(item => item.id === step.id ? { ...item, status: event.target.value as typeof step.status } : item) })}><option value="not-logged">Not marked</option><option value="done">Done as planned</option><option value="modified">Modified</option><option value="skipped">Skipped</option></select><Input aria-label={`${step.name} result`} disabled={busy} maxLength={500} value={step.result} placeholder="What you did (optional)" onChange={event => updateRoutine({ ...value.routine!, steps: value.routine!.steps.map(item => item.id === step.id ? { ...item, result: event.target.value } : item) })}/></div></div>)}</section>}
    <section className="climb-editor"><div className="climbing-card-heading"><div><h3>Climbs</h3><p>Link project work here so attempts and sends stay with both records.</p></div><div className="climb-editor-actions">{pickerProjects.length > 0 && value.climbs.length < 200 && <label><Flag/><span>Project</span><select aria-label="Add a project climb" disabled={busy} value="" onChange={event => addProject(event.target.value)}><option value="" disabled>Add project climb…</option>{pickerProjects.map(goal => <option key={goal.id} value={goal.id}>{goal.title}{goal.grade ? ` · ${goal.grade}` : ""}{goal.archivedAt ? " (archived)" : ""}</option>)}</select></label>}<Button type="button" variant="outline" disabled={busy || value.climbs.length >= 200} onClick={() => setValue({ ...value, climbs: [...value.climbs, newClimb(value)] })}><Plus/>Add other climb</Button></div></div>{suggestedProject && value.climbs.length < 200 && <div className="planned-project-suggestion"><Flag/><span><strong>{suggestedProject.title}</strong><small>Planned project{suggestedProject.archivedAt ? " · archived" : ""}. Add it only if you worked on it.</small></span><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => addProject(suggestedProject.id)}>Add project work</Button></div>}{value.climbs.map((climb, index) => <ClimbEditor key={climb.id} climb={climb} index={index} busy={busy} projects={projectGoals.filter(goal => !linkedProjectIds.has(goal.id) || goal.id === climb.projectGoalId)} preserveSnapshotOnLink={persistedClimbIds.has(climb.id)} update={update => updateClimb(climb.id, update)} remove={() => setValue({ ...value, climbs: value.climbs.filter(item => item.id !== climb.id) })}/>)}</section>
    <label>Session notes <span>optional</span><Textarea maxLength={5000} disabled={busy} value={value.notes} placeholder="What felt good, what you learned, or what to return to…" onChange={event => setValue({ ...value, notes: event.target.value })}/></label>
    <div className="editor-actions">{!draft.isNew ? <button className="delete-button" type="button" disabled={busy} onClick={() => remove(value)}><Trash2/>Remove session</button> : <span/>}<div><DialogClose asChild><Button type="button" variant="outline" disabled={busy}>Cancel</Button></DialogClose><Button type="submit" disabled={busy || blocked}>{busy ? "Saving…" : blocked ? "Reopen latest to save" : draft.isNew ? "Save session" : "Save changes"}</Button></div></div>
  </form>;
}

type CalendarHealthDay = { date: string; steps: number | null; sleepMinutes: number | null; restingHeartRate: number | null; weightKg: number | null };
function HealthContext({ health, healthLoaded, error, day, healthDay, workouts, linkedWorkout, linkedWorkoutDay, selectedId, duration, busy, navigationDisabled, choose, applyDuration, openHealth }: {
  health: HealthView | null; healthLoaded: boolean; error: string; day: string; healthDay?: CalendarHealthDay; workouts: HealthWorkout[]; linkedWorkout?: HealthWorkout;
  linkedWorkoutDay: string | null; selectedId: string | null; duration: number | null; busy: boolean; navigationDisabled: boolean; choose: (id: string | null) => void; applyDuration: (minutes: number) => void; openHealth: () => void;
}) {
  const snapshot = health?.snapshot;
  const copiedMinutes = linkedWorkout ? Math.round(linkedWorkout.minutes) : null;
  const missingLink = selectedId && !linkedWorkout;
  const missingMessage = error ? "Health data unavailable." : snapshot && (day < snapshot.from || day > snapshot.to) ? "Outside the latest 30 days of Health data." : "No currently accessible workout matches this saved link.";
  const metric = (amount: number | null | undefined, suffix = "") => amount == null ? "No accessible data" : `${Math.round(amount).toLocaleString()}${suffix}`;
  return <section className="health-context" aria-busy={!healthLoaded}>
    <div className="health-context-heading"><div><span className="climbing-kicker">APPLE HEALTH · READ ONLY</span><h3>Context for this calendar day</h3><p>Choose a workout to link. Nothing here changes Apple Health.</p></div><Button type="button" size="sm" variant="outline" disabled={navigationDisabled} title={navigationDisabled ? "Save or discard this draft before opening Health" : undefined} onClick={openHealth}><ExternalLink/>Open Health</Button></div>
    {!healthLoaded ? <p className="climbing-source-note">Loading Apple Health…</p> : error ? <p className="climbing-source-warning">Health data unavailable. Your climbing entry is still editable.</p> : !snapshot ? <p className="climbing-source-note">{health?.paired ? "Waiting for Health data from your iPhone." : "Use Settings to make Health workouts available here."}</p> : <>
      <div className="health-day-metrics"><span><strong>{metric(healthDay?.steps)}</strong><small>Steps within this day</small></span><span><strong>{healthDay?.sleepMinutes == null ? "No accessible data" : minutesLabel(Math.round(healthDay.sleepMinutes))}</strong><small>Asleep within this day</small></span><span><strong>{metric(healthDay?.restingHeartRate, " bpm")}</strong><small>Latest resting heart rate</small></span></div>
      {selectedId && <div className={`linked-workout ${missingLink ? "missing" : ""}`}><HeartPulse/><div>{linkedWorkout ? <><strong>{linkedWorkout.name}</strong><p>{workoutActivity(linkedWorkout)} · {workoutTime(linkedWorkout, snapshot.timeZone)} · {Math.round(linkedWorkout.minutes)} min{linkedWorkout.sourceName ? ` · ${linkedWorkout.sourceName}` : ""}</p>{linkedWorkoutDay !== day && <small>This workout is on {linkedWorkoutDay ? dayLabel(linkedWorkoutDay) : "another day"}; review the session date or unlink it.</small>}</> : <><strong>Linked workout unavailable</strong><p>{missingMessage}</p></>}</div><div>{copiedMinutes !== null && copiedMinutes >= 5 && copiedMinutes <= 900 && copiedMinutes !== duration && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => applyDuration(copiedMinutes)}>Use {copiedMinutes} min</Button>}<button type="button" className="climbing-quiet-action" disabled={busy} onClick={() => choose(null)}>Unlink workout</button></div></div>}
      {!selectedId && <div className="health-workout-picker"><h4>Same-day workouts</h4>{workouts.length ? workouts.map(workout => <button type="button" key={workout.id} disabled={busy} onClick={() => choose(workout.id)} aria-label={`Link ${workout.name} at ${workoutTime(workout, snapshot.timeZone)}`}><span className={`health-workout-icon ${(workout.activity ?? "other") === "climbing" ? "recommended" : ""}`}><Activity/></span><span><strong>{workout.name}</strong><small>{workoutActivity(workout)} · {workoutTime(workout, snapshot.timeZone)}{workout.sourceName ? ` · ${workout.sourceName}` : ""}</small></span><span>{Math.round(workout.minutes)} min{(workout.activity ?? "other") === "climbing" && <small>Suggested match</small>}</span></button>) : <p>No accessible workouts for this day.</p>}</div>}
      <p className="health-context-caption">Daily metrics use {snapshot.timeZone}. Each workout uses its recorded timezone when available. Workouts already linked to another climbing session are hidden.</p>
    </>}
  </section>;
}

function ClimbEditor({ climb, index, busy, projects, preserveSnapshotOnLink, update, remove }: { climb: Climb; index: number; busy: boolean; projects: ClimbingGoal[]; preserveSnapshotOnLink: boolean; update: (value: Partial<Climb>) => void; remove: () => void }) {
  function chooseDiscipline(discipline: Climb["discipline"]) {
    const incompatibleGrade = !gradeFits(discipline, climb.gradeSystem);
    const incompatibleOutcome = discipline === "boulder" && ["onsight", "redpoint"].includes(climb.outcome);
    update({ discipline, ropeStyle: discipline === "route" ? climb.ropeStyle ?? "top-rope" : null, ...(incompatibleGrade ? { gradeSystem: null, grade: null } : {}), ...(incompatibleOutcome ? { outcome: "send" } : {}) });
  }
  function chooseProject(goalId: string) {
    if (!goalId) { update({ projectGoalId: null }); return; }
    const goal = projects.find(candidate => candidate.id === goalId);
    if (!goal) return;
    if (preserveSnapshotOnLink) { update({ projectGoalId: goal.id }); return; }
    const discipline = goal.discipline ?? climb.discipline;
    const gradeSystem = gradeFits(discipline, goal.gradeSystem) ? goal.gradeSystem : null;
    update({
      projectGoalId: goal.id, name: prefixByUtf16Units(goal.title, 120), discipline,
      ropeStyle: discipline === "route" ? goal.ropeStyle ?? climb.ropeStyle ?? "top-rope" : null,
      gradeSystem, grade: gradeSystem ? goal.grade : null,
      ...(discipline === "boulder" && ["onsight", "redpoint"].includes(climb.outcome) ? { outcome: "send" as const } : {}),
    });
  }
  const linkedProject = projects.find(goal => goal.id === climb.projectGoalId);
  return <fieldset className="climb-entry">
    <legend>Climb {index + 1}</legend><button className="icon-button" type="button" aria-label={`Remove climb ${index + 1}`} disabled={busy} onClick={remove}><Trash2/></button>
    {(projects.length > 0 || climb.projectGoalId) && <label className="climb-project-link">Project link <span>optional</span><select disabled={busy} value={climb.projectGoalId ?? ""} onChange={event => chooseProject(event.target.value)}><option value="">Not a project climb</option>{projects.map(goal => <option key={goal.id} value={goal.id}>{goal.title}{goal.grade ? ` · ${goal.grade}` : ""}{goal.archivedAt ? " (archived)" : ""}</option>)}</select></label>}
    {linkedProject && <p className="climb-project-note"><Flag/>Linked to {linkedProject.title}. The identity below is this session’s editable snapshot.</p>}
    <label>Problem or route<Input required maxLength={120} disabled={busy} value={climb.name} placeholder="Name, number, or wall label" onChange={event => update({ name: event.target.value })}/></label>
    <div className="climbing-form-grid three"><label>Climbing type<select disabled={busy} value={climb.discipline} onChange={event => chooseDiscipline(event.target.value as Climb["discipline"])}><option value="boulder">Boulder</option><option value="route">Roped route</option></select></label>{climb.discipline === "route" && <label>Rope style<select disabled={busy} value={climb.ropeStyle ?? "top-rope"} onChange={event => update({ ropeStyle: event.target.value as NonNullable<Climb["ropeStyle"]> })}><option value="top-rope">Top rope</option><option value="sport-lead">Sport lead</option><option value="trad-lead">Trad lead</option><option value="follow">Follow</option><option value="auto-belay">Auto belay</option></select></label>}<label>Outcome<select disabled={busy} value={climb.outcome} onChange={event => { const outcome = event.target.value as Climb["outcome"]; update({ outcome, ...(["flash", "onsight"].includes(outcome) ? { attempts: 1 } : {}) }); }}><option value="attempt">Attempt</option><option value="send">Send</option><option value="flash">Flash</option>{climb.discipline === "route" && <><option value="onsight">Onsight</option><option value="redpoint">Redpoint</option></>}<option value="repeat">Repeat</option></select></label></div>
    <div className="climbing-form-grid three"><label>Grade system<select disabled={busy} value={climb.gradeSystem ?? ""} onChange={event => update(event.target.value ? { gradeSystem: event.target.value as GradeSystem, grade: climb.grade ?? "" } : { gradeSystem: null, grade: null })}><option value="">Ungraded</option>{Object.entries(gradeSystemNames).filter(([key]) => climb.discipline === "boulder" ? !["yds", "french", "uiaa", "uk"].includes(key) : !["v-scale", "font"].includes(key)).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label><label>Grade label<Input required={!!climb.gradeSystem} maxLength={30} disabled={busy || !climb.gradeSystem} value={climb.grade ?? ""} placeholder={climb.gradeSystem ? "Keep the original label" : "Choose a system first"} onChange={event => update({ grade: event.target.value })}/></label><label>Attempts <span>optional</span><Input type="number" min={1} max={99} disabled={busy || ["flash", "onsight"].includes(climb.outcome)} value={climb.attempts ?? ""} placeholder="Not logged" onChange={event => update({ attempts: nullableNumber(event.target.value) })}/></label></div>
    <label>Climb note <span>optional</span><Input maxLength={1000} disabled={busy} value={climb.notes} placeholder="Beta, movement, or what happened" onChange={event => update({ notes: event.target.value })}/></label>
  </fieldset>;
}

function ReferenceIcon({ reference }: { reference: GoalReference }) {
  return <span className={`goal-reference-icon ${reference.kind}`} aria-hidden="true">{reference.kind === "video" ? <FileVideo/> : reference.kind === "image" ? <ImageIcon/> : <Link2/>}</span>;
}

function GoalReferencesEditor({ goalId, references, cloudItems, cloudError, busy, addLink, uploadFile, removeReference }: {
  goalId: string; references: GoalReference[]; cloudItems: ClimbingCloudMediaItem[]; cloudError: string; busy: boolean;
  addLink: (goalId: string, label: string, url: string) => Promise<boolean>;
  uploadFile: (goalId: string, file: File) => Promise<boolean>;
  removeReference: (reference: GoalReference) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkLabel, setLinkLabel] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkError, setLinkError] = useState("");
  const sorted = [...references].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const full = references.length >= 12;
  async function submitLink() {
    if (full) { setLinkError("Remove a reference before adding another."); return; }
    try {
      const url = new URL(linkUrl.trim());
      if (url.protocol !== "https:") throw new Error("Use an https link.");
      const saved = await addLink(goalId, linkLabel.trim() || url.hostname.replace(/^www\./, ""), url.toString());
      if (saved) { setLinkLabel(""); setLinkUrl(""); setLinkError(""); setLinkOpen(false); }
    } catch (cause) { setLinkError(errorMessage(cause, "Enter a complete https link.")); }
  }
  return <details className="goal-reference-editor">
    <summary><span><Paperclip/>Beta &amp; references</span>{references.length > 0 && <small>{references.length}</small>}</summary>
    <div className="goal-reference-controls">
      <input ref={fileInput} hidden type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime" disabled={busy || full} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void uploadFile(goalId, file); }}/>
      <Button type="button" size="sm" variant="outline" disabled={busy || full} onClick={() => fileInput.current?.click()}><Upload/>Add file</Button>
      <Button type="button" size="sm" variant="outline" disabled={busy || full} aria-expanded={linkOpen} onClick={() => { setLinkOpen(open => !open); setLinkError(""); }}><Link2/>Add link</Button>
      {full && <span>12-reference limit reached</span>}
      {cloudError && <span role="status">iCloud copy status unavailable</span>}
    </div>
    {linkOpen && <div className="goal-reference-link-fields">
      <label>Link<Input type="url" inputMode="url" autoComplete="url" disabled={busy || full} value={linkUrl} placeholder="https://…" onChange={event => setLinkUrl(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void submitLink(); } }}/></label>
      <label>Label <span>optional</span><Input maxLength={160} disabled={busy || full} value={linkLabel} placeholder="Crux beta, route page…" onChange={event => setLinkLabel(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void submitLink(); } }}/></label>
      <Button type="button" size="sm" disabled={busy || full || !linkUrl.trim()} onClick={() => void submitLink()}>Save link</Button>
      {linkError && <p role="alert">{linkError}</p>}
    </div>}
    {sorted.length > 0 && <div className="goal-reference-list">{sorted.map(reference => <div className="goal-reference-row" key={reference.id}>
      <ReferenceIcon reference={reference}/><a href={referenceHref(reference)} target="_blank" rel="noreferrer"><strong>{referenceName(reference)}</strong><small>{referenceDetail(reference, cloudItems.find(item => item.referenceId === reference.id))}</small></a><button type="button" className="icon-button" disabled={busy} aria-label={`Remove ${referenceName(reference)}`} onClick={() => removeReference(reference)}><Trash2/></button>
    </div>)}</div>}
  </details>;
}

function GoalEditor({ draft, routines, references, cloudItems, cloudError, sessions, dirtyRef, busy, blocked, save, addLink, uploadFile, removeReference }: {
  draft: Extract<Editor, { kind: "goal" }>; routines: Routine[]; references: GoalReference[]; cloudItems: ClimbingCloudMediaItem[]; cloudError: string; sessions: ClimbingSession[]; dirtyRef: MutableRefObject<boolean>; busy: boolean; blocked: boolean;
  save: (draft: Editor) => Promise<void>; addLink: (goalId: string, label: string, url: string) => Promise<boolean>; uploadFile: (goalId: string, file: File) => Promise<boolean>; removeReference: (reference: GoalReference) => void;
}) {
  const [value, setValue] = useState(draft.value);
  const routineOptions = routines.filter(routine => !routine.archived || routine.id === value.routineId);
  const hasLinkedSession = sessions.some(session => session.climbs.some(climb => climb.projectGoalId === value.id));
  const history = value.kind === "project" ? projectGoalHistory(value, sessions) : null;
  function normalizedGoal(candidate: ClimbingGoal) {
    const project = candidate.kind === "project";
    const gradeSystem = project && candidate.discipline && gradeFits(candidate.discipline, candidate.gradeSystem) ? candidate.gradeSystem : null;
    return {
      ...candidate,
      startDate: candidate.kind === "consistency" ? candidate.startDate : null,
      sessionTarget: candidate.kind === "consistency" ? candidate.sessionTarget : null,
      environment: project ? candidate.environment : null,
      discipline: project ? candidate.discipline : null,
      ropeStyle: project && candidate.discipline === "route" ? candidate.ropeStyle : null,
      venue: project ? candidate.venue : null,
      gradeSystem,
      grade: gradeSystem ? candidate.grade : null,
      attempts: project ? candidate.attempts : null,
      routineId: candidate.kind === "training" ? candidate.routineId : null,
    } satisfies ClimbingGoal;
  }
  const dirty = JSON.stringify(normalizedGoal(value)) !== JSON.stringify(normalizedGoal(draft.value));
  useEffect(() => { dirtyRef.current = dirty; return () => { dirtyRef.current = false; }; }, [dirty, dirtyRef]);
  function chooseKind(kind: ClimbingGoal["kind"]) {
    setValue(current => ({
      ...current,
      kind,
      ...(kind === "consistency" ? { startDate: current.startDate ?? dateKey(new Date()), sessionTarget: current.sessionTarget ?? 8 } : {}),
      ...(kind === "project" ? { environment: current.environment ?? "indoor", discipline: current.discipline ?? "boulder" } : {}),
    }));
  }
  function chooseDiscipline(discipline: NonNullable<ClimbingGoal["discipline"]>) {
    setValue(current => ({ ...current, discipline }));
  }
  const projectGradeSystems = Object.entries(gradeSystemNames).filter(([key]) => !value.discipline || gradeFits(value.discipline, key as GradeSystem));
  const visibleGradeSystem = value.gradeSystem && (!value.discipline || gradeFits(value.discipline, value.gradeSystem)) ? value.gradeSystem : null;
  return <form className="climbing-form" onSubmit={event => { event.preventDefault(); void save({ ...draft, value: normalizedGoal(value) }); }}>
    <div className="climbing-form-grid two"><label>Goal type<select disabled={busy || hasLinkedSession} value={value.kind} onChange={event => chooseKind(event.target.value as ClimbingGoal["kind"])}>{Object.entries(goalKindNames).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label><label>Status<select disabled={busy} value={value.status} onChange={event => setValue({ ...value, status: event.target.value as ClimbingGoal["status"] })}><option value="active">{value.kind === "project" ? "Projecting" : "Active"}</option><option value="paused">Paused</option><option value="completed">{value.kind === "project" ? "Sent" : "Completed"}</option></select></label></div>
    {value.kind === "project" && history?.completedByLinkedSession && value.status !== "completed" && <p className="climbing-form-note"><Check/>A linked session records a send, so this project appears as Sent. This saved status remains available if that session is later edited, unlinked, or removed.</p>}
    {hasLinkedSession && <p className="climbing-form-note"><Flag/>This remains a climb project because session history is linked to it.</p>}
    <label>{value.kind === "project" ? "Route or problem name" : "Goal"}<Input required maxLength={200} disabled={busy} value={value.title} placeholder={value.kind === "project" ? "Name of the route or boulder problem" : "What are you working toward?"} onChange={event => setValue({ ...value, title: event.target.value })}/></label>
    <label>{value.kind === "project" ? "Project notes" : "What success means"} <span>optional</span><Textarea maxLength={3000} disabled={busy} value={value.description} placeholder={value.kind === "project" ? "Key moves, why it matters, or useful context…" : "A clear finish line, or why this matters…"} onChange={event => setValue({ ...value, description: event.target.value })}/></label>
    {value.kind === "consistency" && <div className="climbing-form-grid three"><label>Start date<Input required type="date" disabled={busy} value={value.startDate ?? ""} onChange={event => setValue({ ...value, startDate: event.target.value || null })}/></label><label>End date<Input required type="date" disabled={busy} min={value.startDate ?? undefined} value={value.targetDate ?? ""} onChange={event => setValue({ ...value, targetDate: event.target.value || null })}/></label><label>Sessions to log<Input required type="number" min={1} max={365} disabled={busy} value={value.sessionTarget ?? ""} onChange={event => setValue({ ...value, sessionTarget: nullableNumber(event.target.value) })}/></label></div>}
    {value.kind !== "consistency" && value.kind !== "project" && <div className="climbing-form-grid two"><label>Target date <span>optional</span><Input type="date" disabled={busy} value={value.targetDate ?? ""} onChange={event => setValue({ ...value, targetDate: event.target.value || null })}/></label><label>Progress<Input type="number" min={0} max={100} disabled={busy} value={value.progress} onChange={event => setValue({ ...value, progress: Number(event.target.value) })}/></label></div>}
    {value.kind === "project" && <>
      <div className={`climbing-form-grid ${value.discipline === "route" ? "three" : "two"}`}>
        <label>Setting<select required disabled={busy} value={value.environment ?? ""} onChange={event => setValue({ ...value, environment: event.target.value as NonNullable<ClimbingGoal["environment"]> })}><option value="" disabled>Choose setting</option><option value="indoor">Gym</option><option value="outdoor">Outside</option></select></label>
        <label>Climb type<select required disabled={busy} value={value.discipline ?? ""} onChange={event => chooseDiscipline(event.target.value as NonNullable<ClimbingGoal["discipline"]>)}><option value="" disabled>Choose type</option><option value="boulder">Boulder</option><option value="route">Route</option></select></label>
        {value.discipline === "route" && <label>Rope style <span>optional</span><select disabled={busy} value={value.ropeStyle ?? ""} onChange={event => setValue({ ...value, ropeStyle: event.target.value ? event.target.value as NonNullable<Climb["ropeStyle"]> : null })}><option value="">Any style</option>{Object.entries(ropeStyleNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>}
      </div>
      <label>Gym, crag, or area <span>optional</span><Input maxLength={200} disabled={busy} value={value.venue ?? ""} placeholder={value.environment === "indoor" ? "Gym or wall" : "Crag, area, or sector"} onChange={event => setValue({ ...value, venue: event.target.value || null })}/></label>
      <div className="climbing-form-grid two"><label>Grade system <span>optional</span><select disabled={busy || !value.discipline} value={visibleGradeSystem ?? ""} onChange={event => { const gradeSystem = event.target.value ? event.target.value as GradeSystem : null; setValue({ ...value, gradeSystem, grade: gradeSystem ? gradeSystem === value.gradeSystem ? value.grade ?? "" : "" : null }); }}><option value="">Ungraded</option>{projectGradeSystems.map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label><label>Grade<Input required={!!visibleGradeSystem} maxLength={30} disabled={busy || !visibleGradeSystem} value={visibleGradeSystem ? value.grade ?? "" : ""} placeholder="V7, 5.12a, blue…" onChange={event => setValue({ ...value, grade: event.target.value })}/></label></div>
      <div className="climbing-form-grid two"><label>Target date <span>optional</span><Input type="date" disabled={busy} value={value.targetDate ?? ""} onChange={event => setValue({ ...value, targetDate: event.target.value || null })}/></label><label>Manual attempt total <span>optional, kept separate</span><Input type="number" min={0} max={9999} step={1} disabled={busy} value={value.attempts ?? ""} placeholder="Not set" onChange={event => setValue({ ...value, attempts: nullableNumber(event.target.value) })}/></label></div>
      <p className="climbing-form-note"><Activity/>Use this only for a separate total you maintain yourself. It may overlap session-recorded attempts, so Workspace never adds the two together.</p>
      {history && <section className="project-editor-history"><div><span className="climbing-kicker">PROJECT WORK</span><h3>Linked sessions</h3></div><ProjectStats history={history}/>{history.entries.length ? <ProjectHistoryDetails history={history}/> : <p>No sessions are linked yet. Add this project while logging a climb to build its history.</p>}</section>}
    </>}
    {value.kind === "training" && <label>Related routine <span>optional</span><select disabled={busy} value={value.routineId ?? ""} onChange={event => setValue({ ...value, routineId: event.target.value || null })}><option value="">No linked routine</option>{routineOptions.map(routine => <option key={routine.id} value={routine.id}>{routine.title}{routine.archived ? " (archived)" : ""}</option>)}</select></label>}
    <label>Next action <span>optional</span><Input maxLength={500} disabled={busy} value={value.nextStep} placeholder="The next useful move" onChange={event => setValue({ ...value, nextStep: event.target.value })}/></label>
    {!draft.isNew && <GoalReferencesEditor goalId={value.id} references={references} cloudItems={cloudItems} cloudError={cloudError} busy={busy} addLink={addLink} uploadFile={uploadFile} removeReference={removeReference}/>}
    <p className="climbing-form-note"><ListTodo/>Saving this goal stays local. Use “Add next action to Todoist” on its card when you want a connected task.</p>
    <div className="editor-actions"><span/><div><DialogClose asChild><Button type="button" variant="outline" disabled={busy}>Cancel</Button></DialogClose><Button type="submit" disabled={busy || blocked}>{busy ? "Saving…" : blocked ? "Reopen latest to save" : draft.isNew ? "Add goal" : "Save changes"}</Button></div></div>
  </form>;
}

function RoutineEditor({ draft, dirtyRef, busy, blocked, save }: { draft: Extract<Editor, { kind: "routine" }>; dirtyRef: MutableRefObject<boolean>; busy: boolean; blocked: boolean; save: (draft: Editor) => Promise<void> }) {
  const [value, setValue] = useState(draft.value);
  const dirty = JSON.stringify(value) !== JSON.stringify(draft.value);
  useEffect(() => { dirtyRef.current = dirty; return () => { dirtyRef.current = false; }; }, [dirty, dirtyRef]);
  const updateStep = (id: string, update: Partial<RoutineStep>) => setValue(current => ({ ...current, steps: current.steps.map(step => step.id === id ? { ...step, ...update } : step) }));
  const move = (index: number, amount: number) => setValue(current => { const steps = [...current.steps]; const target = index + amount; if (target < 0 || target >= steps.length) return current; [steps[index], steps[target]] = [steps[target], steps[index]]; return { ...current, steps }; });
  return <form className="climbing-form" onSubmit={event => { event.preventDefault(); void save({ ...draft, value }); }}>
    <div className="climbing-form-grid two"><label>Routine name<Input required maxLength={160} disabled={busy} value={value.title} placeholder="Power session, movement practice…" onChange={event => setValue({ ...value, title: event.target.value })}/></label><label>Focus<select disabled={busy} value={value.focus} onChange={event => setValue({ ...value, focus: event.target.value as Routine["focus"] })}>{Object.entries(routineFocusNames).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label></div>
    <div className="climbing-form-grid two"><label>Estimated duration <span>optional</span><Input type="number" min={5} max={360} disabled={busy} value={value.estimatedMinutes ?? ""} placeholder="Minutes" onChange={event => setValue({ ...value, estimatedMinutes: nullableNumber(event.target.value) })}/></label></div>
    <label>Purpose <span>optional</span><Textarea maxLength={2000} disabled={busy} value={value.description} placeholder="What this routine is for…" onChange={event => setValue({ ...value, description: event.target.value })}/></label>
    <section className="routine-step-editor"><div className="climbing-card-heading"><div><h3>Steps</h3><p>Describe the exact workload you want to follow.</p></div><Button type="button" variant="outline" disabled={busy || value.steps.length >= 50} onClick={() => setValue({ ...value, steps: [...value.steps, newStep()] })}><Plus/>Add step</Button></div>{value.steps.map((step, index) => <fieldset className="routine-step" key={step.id}><legend>Step {index + 1}</legend><div className="step-controls"><button type="button" className="icon-button" disabled={busy || index === 0} aria-label={`Move step ${index + 1} up`} onClick={() => move(index, -1)}><ArrowUp/></button><button type="button" className="icon-button" disabled={busy || index === value.steps.length - 1} aria-label={`Move step ${index + 1} down`} onClick={() => move(index, 1)}><ArrowDown/></button><button type="button" className="icon-button" disabled={busy || value.steps.length === 1} aria-label={`Remove step ${index + 1}`} onClick={() => setValue({ ...value, steps: value.steps.filter(item => item.id !== step.id) })}><Trash2/></button></div><label>Step name<Input required maxLength={160} disabled={busy} value={step.name} placeholder="Warm up, repeaters, footwork…" onChange={event => updateStep(step.id, { name: event.target.value })}/></label><label>Planned work<Textarea required maxLength={500} disabled={busy} value={step.prescription} placeholder="Sets, reps, duration, load, or instructions" onChange={event => updateStep(step.id, { prescription: event.target.value })}/></label><div className="climbing-form-grid two"><label>Rest <span>optional</span><Input maxLength={200} disabled={busy} value={step.rest} placeholder="Between sets or efforts" onChange={event => updateStep(step.id, { rest: event.target.value })}/></label><label>Notes <span>optional</span><Input maxLength={500} disabled={busy} value={step.notes} placeholder="Cues or setup" onChange={event => updateStep(step.id, { notes: event.target.value })}/></label></div></fieldset>)}</section>
    <div className="editor-actions"><span/><div><DialogClose asChild><Button type="button" variant="outline" disabled={busy}>Cancel</Button></DialogClose><Button type="submit" disabled={busy || blocked}>{busy ? "Saving…" : blocked ? "Reopen latest to save" : draft.isNew ? "Create routine" : "Save new version"}</Button></div></div>
  </form>;
}

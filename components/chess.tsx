"use client";

import { useCallback, useEffect, useRef, useState, type ComponentType, type CSSProperties } from "react";
import { Chess, type Move } from "chess.js";
import type { ChessboardOptions, SquareHandlerArgs } from "react-chessboard";
import {
  ArrowRight,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Crown,
  Lightbulb,
  ListTodo,
  LoaderCircle,
  RotateCcw,
  Sparkles,
  Target,
  Trophy,
} from "lucide-react";
import { useIntegrations } from "@/components/integrations";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  chessStateSchema,
  getTrainerMoveSolution,
  getTrainerSteps,
  type ChessView,
  type Course,
  type Lesson,
  type LessonProgress,
  type LessonSegment,
  type ProgressRequest,
  type ReviewCard,
  type ReviewChoice,
  type ReviewRequest,
  type StudySessionRequest,
  type TrainerStep,
} from "@/lib/chess";
import { eventOnDay } from "@/lib/integrations/model";
import { dateKey } from "@/lib/workspace";
import styles from "./chess.module.css";

type ChessTab = "overview" | "learn" | "review";
type LessonTarget = { courseId: string; lessonId: string };
type MutationResult = { view: ChessView; replayed: boolean };
type SavedReview = {
  attemptId: string;
  moveCorrect: boolean;
  reasonCorrect: boolean;
  grade: "again" | "good";
  dueAt: string;
};
type MoveAttempt = {
  correct: boolean;
  fen: string;
  from: string;
  san: string;
  to: string;
  uci: string;
};
type Feedback = { kind: "idle" | "correct" | "incorrect" | "info"; text: string };
type ProgressDraft = Omit<ProgressRequest, "requestId" | "revision">;
type PendingProgress = { body: ProgressRequest; fingerprint: string; logical: ProgressDraft; rebase: boolean };
type ReviewDraft = Omit<ReviewRequest, "requestId" | "revision">;
type PendingReview = { body: ReviewRequest; fingerprint: string; logical: ReviewDraft; rebase: boolean };
type PendingSession = { body: StudySessionRequest; rebase: boolean };

class ChessMutationError extends Error {
  readonly code: string;
  readonly latestView: ChessView | null;
  readonly status: number;

  constructor(text: string, code: string, status: number, latestView: ChessView | null = null) {
    super(text);
    this.name = "ChessMutationError";
    this.code = code;
    this.status = status;
    this.latestView = latestView;
  }
}

const responseError = (value: unknown, fallback: string) =>
  typeof value === "object" && value !== null && "error" in value && typeof value.error === "string" ? value.error : fallback;
const responseCode = (value: unknown) =>
  typeof value === "object" && value !== null && "code" in value && typeof value.code === "string" ? value.code : "";
const message = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;
const now = () => new Date().toISOString();

type ChessboardComponent = ComponentType<{ options?: ChessboardOptions }>;
let loadedChessboard: ChessboardComponent | null = null;

function ClientChessboard({ options }: { options: ChessboardOptions }) {
  const [Component, setComponent] = useState<ChessboardComponent | null>(() => loadedChessboard);

  useEffect(() => {
    let active = true;
    if (!Component) {
      void import("react-chessboard").then(module => {
        loadedChessboard = module.Chessboard;
        if (active) setComponent(() => module.Chessboard);
      });
    }
    return () => { active = false; };
  }, [Component]);

  return Component
    ? <Component options={options}/>
    : <div className={styles.boardLoading} role="status">Loading board…</div>;
}

function parseChessView(value: unknown): ChessView {
  if (typeof value !== "object" || value === null) throw new Error("Chess returned an invalid response.");
  const candidate = value as Partial<ChessView>;
  if (candidate.capability?.id !== "chess" || candidate.capability.version !== 1 || !candidate.catalog || !Array.isArray(candidate.catalog.courses) || !Array.isArray(candidate.catalog.lessons) || !Array.isArray(candidate.reviewQueue) || !candidate.summary) {
    throw new Error("Chess returned an invalid response.");
  }
  return { ...candidate, state: chessStateSchema.parse(candidate.state) } as ChessView;
}

function moveOnBoard(step: TrainerStep, from: string, to: string): MoveAttempt | null {
  const board = new Chess(step.fen);
  let move: Move | null = null;
  try { move = board.move({ from, to, promotion: "q" }); } catch { move = null; }
  if (!move) return null;
  const uci = `${move.from}${move.to}${move.promotion ?? ""}`;
  return { correct: step.acceptedMoves.includes(uci), fen: board.fen(), from: move.from, san: move.san, to: move.to, uci };
}

function solutionLabel(step: TrainerStep) {
  const solution = getTrainerMoveSolution(step);
  if (!solution) return null;
  const board = new Chess(step.fen);
  let move: Move | null = null;
  try { move = board.move({ from: solution.from, to: solution.to, promotion: solution.uci.slice(4) || "q" }); } catch { move = null; }
  return { ...solution, san: move?.san ?? solution.uci };
}

export function ChessPanel({ active = true, selectedDay }: { active?: boolean; selectedDay: string }) {
  const integrations = useIntegrations();
  const [view, setView] = useState<ChessView | null>(null);
  const viewRef = useRef<ChessView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<ChessTab>("overview");
  const [lessonTarget, setLessonTarget] = useState<LessonTarget | null>(null);

  const receive = useCallback((next: ChessView) => { viewRef.current = next; setView(next); }, []);
  const load = useCallback(async (quiet = false) => {
    try {
      const response = await fetch("/api/chess", { cache: "no-store" });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(responseError(result, "Chess could not be loaded."));
      receive(parseChessView(result));
      setLoaded(true);
      if (!quiet) setError("");
      return true;
    } catch (cause) {
      if (!quiet || !viewRef.current) setError(message(cause, "Chess could not be loaded."));
      return false;
    }
  }, [receive]);

  useEffect(() => {
    if (!active) return;
    const initial = setTimeout(() => void load(), 0);
    const timer = setInterval(() => { if (document.visibilityState === "visible" && !busyRef.current) void load(true); }, 60_000);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, [active, load]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 5000); return () => clearTimeout(timer); }, [notice]);
  const mutate = useCallback(async <T extends MutationResult>(path: string, body: object, success: string): Promise<T> => {
    if (busyRef.current) throw new ChessMutationError("Wait for the current Chess update to finish.", "client_busy", 409);
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/chess${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result: unknown = await response.json();
      if (!response.ok) {
        const code = responseCode(result);
        if (response.status === 409 && (code === "revision_conflict" || code === "review_not_due")) {
          const refreshed = await load(true);
          const latest = refreshed ? viewRef.current : null;
          const text = code === "review_not_due"
            ? refreshed ? "That position was already saved and is not due now. The current review queue has been loaded." : "That position was already saved and is not due now. Reload the review queue before continuing."
            : refreshed ? "Chess changed in another view. The latest saved copy is loaded; your work is still here, so you can retry it." : "Chess changed in another view. Your work is still here, but the latest saved copy could not be loaded.";
          throw new ChessMutationError(text, code, response.status, latest);
        }
        if (response.status === 409 && code === "request_id_conflict") throw new ChessMutationError("This save key was already used for different Chess data. A fresh save key will be used when you retry.", code, response.status);
        if (response.status === 423) throw new ChessMutationError("Chess is finishing another save. Your work is still here; try again in a moment.", code || "store_busy", response.status);
        throw new ChessMutationError(responseError(result, "Your Chess update could not be saved."), code || "request_failed", response.status);
      }
      const envelope = result as T;
      receive(parseChessView(envelope.view));
      setNotice(success);
      return envelope;
    } catch (cause) {
      const text = message(cause, "Your Chess update could not be saved.");
      if (cause instanceof ChessMutationError && cause.code === "review_not_due" && cause.latestView) { setError(""); setNotice(text); }
      else setError(text);
      if (cause instanceof ChessMutationError) throw cause;
      throw new ChessMutationError(text, "network_error", 0);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [load, receive]);

  function openLesson(target: LessonTarget) { setLessonTarget(target); setTab("learn"); setError(""); }
  function scheduleStudy() {
    if (!integrations.view.google.connected) { integrations.openSettings(); return; }
    const window = studyWindow(selectedDay || dateKey(new Date()));
    integrations.openEditor({
      provider: "google",
      day: window.date,
      preset: { title: "Chess study · 20-minute review", date: window.date, endDate: window.endDate, time: window.time, endTime: window.endTime, allDay: false },
      description: "Review this 20-minute focus block before saving it to your personal Google Calendar.",
    });
  }
  function addReviewTask() {
    if (!integrations.view.todoist.connected) { integrations.openSettings(); return; }
    const due = view?.summary.reviewsDue ?? 0;
    integrations.openEditor({
      provider: "todoist",
      day: selectedDay || dateKey(new Date()),
      preset: { title: due ? `Chess · Review ${due} position${due === 1 ? "" : "s"}` : "Chess · Review a lesson", date: selectedDay || dateKey(new Date()) },
      description: "Review this task before saving it to your Personal project in Todoist. Chess progress remains in Workspace.",
    });
  }

  if (!loaded && !view) return <div className={styles.panel}>{error ? <LoadFailure error={error} retry={() => void load()}/> : <div className={styles.loading}><span><LoaderCircle className={styles.spin} size={17}/> Loading Chess…</span></div>}</div>;
  if (!view) return <div className={styles.panel}><LoadFailure error={error || "Chess could not be loaded."} retry={() => void load()}/></div>;
  const resolvedLessonTarget = lessonTarget ?? (view.summary.currentCourseId && view.summary.currentLessonId
    ? { courseId: view.summary.currentCourseId, lessonId: view.summary.currentLessonId }
    : firstLesson(view));

  return <div className={styles.panel}>
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {error && <div className={styles.error} role="alert"><p>{error}</p><div className={styles.errorActions}><button className={styles.quietButton} disabled={busy} onClick={() => void load()}><RotateCcw size={14}/>Load latest saved Chess data</button></div></div>}
    <Tabs className={styles.tabs} value={tab} onValueChange={value => setTab(value as ChessTab)}>
      <TabsList aria-label="Chess views"><TabsTrigger value="overview"><Trophy size={16}/>Overview</TabsTrigger><TabsTrigger value="learn"><BookOpen size={16}/>Learn</TabsTrigger><TabsTrigger value="review"><Sparkles size={16}/>Review {view.summary.reviewsDue ? `(${view.summary.reviewsDue})` : ""}</TabsTrigger></TabsList>
      <TabsContent value="overview"><Overview view={view} openLesson={openLesson} openReview={() => setTab("review")} scheduleStudy={scheduleStudy} addReviewTask={addReviewTask}/></TabsContent>
      <TabsContent value="learn">{resolvedLessonTarget ? <LearnView key={`${resolvedLessonTarget.courseId}:${resolvedLessonTarget.lessonId}`} view={view} target={resolvedLessonTarget} busy={busy} chooseLesson={openLesson} mutate={mutate}/> : <EmptyCatalog/>}</TabsContent>
      <TabsContent value="review"><ReviewView key={view.state.studySessions.length} initialView={view} busy={busy} mutate={mutate} scheduleStudy={scheduleStudy} addReviewTask={addReviewTask}/></TabsContent>
    </Tabs>
  </div>;
}

function Overview({ view, openLesson, openReview, scheduleStudy, addReviewTask }: { view: ChessView; openLesson: (target: LessonTarget) => void; openReview: () => void; scheduleStudy: () => void; addReviewTask: () => void }) {
  const current = currentLesson(view);
  const accuracy = view.summary.recentReviewAccuracy;
  const studyMinutes = view.state.studySessions.reduce((total, session) => total + Math.max(0, new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 60000, 0);
  const hasSummary = view.summary.reviewsDue > 0 || view.summary.stepsCovered > 0 || accuracy !== null || view.state.studySessions.length > 0;
  return <div className={styles.stack}>
    {hasSummary&&<section className={styles.summary}>
      <div className={styles.summaryHeading}><h2>{view.summary.reviewsDue ? `${view.summary.reviewsDue} position${view.summary.reviewsDue === 1 ? " is" : "s are"} ready for recall.` : "Recent practice"}</h2></div>
      <div className={styles.metrics}>
        {view.summary.stepsCovered>0&&<article><span>Steps covered</span><strong>{view.summary.stepsCovered}/{view.summary.totalSteps}</strong></article>}
        {view.summary.reviewsDue>0&&<article><span>Due now</span><strong>{view.summary.reviewsDue}</strong><small>{nextDueLabel(view.summary.nextDueAt)}</small></article>}
        {accuracy!==null&&<article><span>Recent recall</span><strong>{Math.round(accuracy * 100)}%</strong></article>}
        {view.state.studySessions.length>0&&<article><span>Practice time</span><strong>{Math.round(studyMinutes)}m</strong><small>{view.state.studySessions.length} recorded {view.state.studySessions.length === 1 ? "session" : "sessions"}</small></article>}
      </div>
    </section>}
    <div className={styles.overviewGrid}>
      <section className={styles.card}>
        <div className={styles.cardHeader}><div><h2>Continue learning</h2><p>Return to the last lesson position or start the course from the beginning.</p></div><span>{view.catalog.courses.length} {view.catalog.courses.length === 1 ? "course" : "courses"}</span></div>
        {current ? <div className={styles.nextLesson}><span className={styles.nextLessonIcon}><BookOpen size={20}/></span><div className={styles.nextLessonCopy}><span>{current.course.title}</span><h3>{current.lesson.title}</h3><p>{current.course.description}</p><Button variant="outline" onClick={() => openLesson({ courseId: current.course.id, lessonId: current.lesson.id })}>Continue lesson <ArrowRight size={15}/></Button></div></div> : <EmptyCatalog/>}
      </section>
      <section className={styles.card}>
        <div className={styles.cardHeader}><div><h3>Practice</h3></div></div>
        <div className={styles.planningList}>
          <button className={styles.planningButton} onClick={scheduleStudy}><span><CalendarClock size={17}/></span><span><strong>Block 20 minutes</strong><small>Google Calendar</small></span><ChevronRight size={15}/></button>
          <button className={styles.planningButton} onClick={addReviewTask}><span><ListTodo size={17}/></span><span><strong>Add a review task</strong><small>Todoist</small></span><ChevronRight size={15}/></button>
          <button className={styles.planningButton} disabled={!view.summary.reviewsDue} onClick={openReview}><span><Target size={17}/></span><span><strong>Start due reviews</strong><small>{view.summary.reviewsDue ? `${view.summary.reviewsDue} ready now` : "Queue clear"}</small></span><ChevronRight size={15}/></button>
        </div>
      </section>
    </div>
    <section className={styles.card}>
      <div className={styles.cardHeader}><div><h2>Courses</h2><p>Short authored lessons from both sides of the board.</p></div></div>
      <div className={styles.courseList}>{view.catalog.courses.map(course => <CourseCard key={course.id} course={course} view={view} openLesson={openLesson}/>)}</div>
    </section>
  </div>;
}

function CourseCard({ course, view, openLesson }: { course: Course; view: ChessView; openLesson: (target: LessonTarget) => void }) {
  const lessons = course.lessonIds.map(id => view.catalog.lessons.find(lesson => lesson.courseId === course.id && lesson.id === id)).filter((lesson): lesson is Lesson => Boolean(lesson));
  const stepIds = lessons.flatMap(getTrainerSteps).map(step => step.id);
  const completed = new Set(view.state.progress.filter(progress => progress.courseId === course.id).flatMap(progress => progress.completedStepIds));
  const count = stepIds.filter(id => completed.has(id)).length;
  const percent = stepIds.length ? Math.round(count / stepIds.length * 100) : 0;
  const resume = view.summary.currentCourseId === course.id && view.summary.currentLessonId && lessons.some(lesson => lesson.id === view.summary.currentLessonId) ? view.summary.currentLessonId : lessons[0]?.id;
  return <button className={styles.courseButton} disabled={!resume} onClick={() => resume && openLesson({ courseId: course.id, lessonId: resume })}>
    <span className={styles.courseIcon}><Crown size={19}/></span><span className={styles.courseCopy}><span>{course.level}</span><h3>{course.title}</h3><p>{course.description}</p><span className={styles.progressTrack} aria-label={`${percent}% of course steps covered`}><span style={{ width: `${percent}%` }}/></span><small>{count}/{stepIds.length} steps covered · {lessons.length} {lessons.length === 1 ? "lesson" : "lessons"}</small></span>
  </button>;
}

function LearnView({ view, target, busy, chooseLesson, mutate }: { view: ChessView; target: LessonTarget; busy: boolean; chooseLesson: (target: LessonTarget) => void; mutate: <T extends MutationResult>(path: string, body: object, success: string) => Promise<T> }) {
  const lesson = view.catalog.lessons.find(item => item.courseId === target.courseId && item.id === target.lessonId);
  const course = view.catalog.courses.find(item => item.id === target.courseId);
  const saved = view.state.progress.find(item => item.courseId === target.courseId && item.lessonId === target.lessonId);
  const initialSegmentIndex = lesson ? Math.max(0, lesson.segments.findIndex(segment => segment.id === saved?.currentSegmentId)) : 0;
  const [segmentIndex, setSegmentIndex] = useState(initialSegmentIndex);
  const [stepIndexBySegment, setStepIndexBySegment] = useState<Map<string, number>>(() => initialStepMap(lesson, saved));
  const [completed, setCompleted] = useState<string[]>(saved?.completedStepIds ?? []);
  const [boardFen, setBoardFen] = useState(lesson?.initialFen ?? "start");
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [lastAttempt, setLastAttempt] = useState<MoveAttempt | null>(null);
  const [revealed, setRevealed] = useState<ReturnType<typeof solutionLabel>>(null);
  const [hintIndex, setHintIndex] = useState(-1);
  const [feedback, setFeedback] = useState<Feedback>({ kind: "idle", text: "Read the idea, then use the board when the lesson asks for a move." });
  const [localError, setLocalError] = useState("");
  const [progressState, setProgressState] = useState<"saved" | "saving" | "failed">("saved");
  const pendingProgress = useRef<PendingProgress | null>(null);
  const progressBlockedRef = useRef(false);
  const pendingSession = useRef<PendingSession | null>(null);
  const sessionEndedAt = useRef<string | null>(null);
  const sessionInFlight = useRef(false);
  const sessionRecordedRef = useRef(false);
  const [sessionRecorded, setSessionRecorded] = useState(false);
  const startedAt = useRef(now());
  const touchedSteps = useRef(new Set<string>());

  const segment = lesson?.segments[segmentIndex];
  const stepIndex = segment?.type === "trainer" ? stepIndexBySegment.get(segment.id) ?? 0 : 0;
  const step = segment?.type === "trainer" ? segment.steps[stepIndex] ?? null : null;
  const orientation = step?.boardOrientation ?? segment?.boardOrientation ?? "white";
  const allSteps = lesson ? getTrainerSteps(lesson) : [];
  const coveredCount = allSteps.filter(item => completed.includes(item.id)).length;
  const percent = lesson?.segments.length ? Math.round((segmentIndex + 1) / lesson.segments.length * 100) : 0;

  useEffect(() => {
    if (!lesson || !segment) return;
    const nextStep = segment.type === "trainer" ? segment.steps[stepIndex] ?? null : null;
    resetPosition(segment, nextStep, lesson.initialFen, setBoardFen, setSelectedSquare, setLastAttempt, setRevealed, setHintIndex, setFeedback);
  }, [lesson, segment, stepIndex]);

  if (!lesson || !course || !segment) return <EmptyCatalog/>;

  function progressBody(logical: ProgressDraft): ProgressRequest {
    return { ...logical, revision: view.state.revision, requestId: crypto.randomUUID() };
  }

  async function submitProgress(pending: PendingProgress) {
    if (progressBlockedRef.current && progressState === "saving") return false;
    progressBlockedRef.current = true;
    setProgressState("saving");
    setLocalError("");
    try {
      await mutate("/progress", pending.body, "Lesson progress saved");
      pendingProgress.current = null;
      progressBlockedRef.current = false;
      setProgressState("saved");
      setLocalError("");
      return true;
    } catch (cause) {
      if (cause instanceof ChessMutationError && ["revision_conflict", "request_id_conflict"].includes(cause.code)) pending.rebase = true;
      pendingProgress.current = pending;
      setProgressState("failed");
      setLocalError(message(cause, "Lesson progress could not be saved."));
      return false;
    }
  }

  async function persist(nextSegment: LessonSegment, nextStep: TrainerStep | null, nextCompleted = completed) {
    if (progressBlockedRef.current) return false;
    const logical: ProgressDraft = { courseId: course!.id, lessonId: lesson!.id, currentSegmentId: nextSegment.id, currentStepId: nextStep?.id ?? null, completedStepIds: nextCompleted };
    const fingerprint = JSON.stringify(logical);
    let pending = pendingProgress.current;
    if (!pending || pending.fingerprint !== fingerprint) pending = { body: progressBody(logical), fingerprint, logical, rebase: false };
    else if (pending.rebase) pending = { ...pending, body: progressBody(pending.logical), rebase: false };
    pendingProgress.current = pending;
    return submitProgress(pending);
  }

  async function retryProgress() {
    const existing = pendingProgress.current;
    if (!existing || progressState === "saving") return;
    const pending = existing.rebase ? { ...existing, body: progressBody(existing.logical), rebase: false } : existing;
    pendingProgress.current = pending;
    progressBlockedRef.current = false;
    await submitProgress(pending);
  }

  function changeSegment(nextIndex: number) {
    if (progressBlockedRef.current || sessionInFlight.current) return;
    const bounded = Math.max(0, Math.min(lesson!.segments.length - 1, nextIndex));
    const nextSegment = lesson!.segments[bounded]!;
    const nextStep = nextSegment.type === "trainer" ? nextSegment.steps[stepIndexBySegment.get(nextSegment.id) ?? 0] ?? null : null;
    setSegmentIndex(bounded);
    void persist(nextSegment, nextStep);
  }

  async function completeStep(nextFeedback: Feedback, nextFen?: string) {
    if (!step || progressBlockedRef.current || sessionInFlight.current) return;
    touchedSteps.current.add(step.id);
    const nextCompleted = completed.includes(step.id) ? completed : [...completed, step.id];
    setCompleted(nextCompleted);
    if (nextFen) setBoardFen(nextFen);
    setFeedback(nextFeedback);
    await persist(segment!, step, nextCompleted);
  }

  function attempt(from: string, to: string) {
    if (!step || busy || progressBlockedRef.current || sessionInFlight.current) return false;
    const result = moveOnBoard(step, from, to);
    setSelectedSquare(null);
    setRevealed(null);
    if (!result) { setLastAttempt(null); setFeedback({ kind: "incorrect", text: "That move is illegal in this position. Try another square." }); return false; }
    setLastAttempt(result);
    if (!result.correct) { setFeedback({ kind: "incorrect", text: `${result.san} is legal, but it is not the authored lesson move. Try the central idea again or use a hint.` }); return false; }
    void completeStep({ kind: "correct", text: `${result.san} is right. ${step.explanation}` }, result.fen);
    return true;
  }

  function clickSquare({ piece, square }: SquareHandlerArgs) {
    if (!step || busy) return;
    if (!selectedSquare) { if (piece) setSelectedSquare(square); return; }
    if (selectedSquare === square) { setSelectedSquare(null); return; }
    attempt(selectedSquare, square);
  }

  function revealHint() { if (step?.hints.length && !progressBlockedRef.current) setHintIndex(index => Math.min(index + 1, step.hints.length - 1)); }
  function revealMove() {
    if (!step || progressBlockedRef.current || sessionInFlight.current) return;
    const solution = solutionLabel(step);
    if (!solution) { setFeedback({ kind: "incorrect", text: "The authored move could not be shown for this position." }); return; }
    setRevealed(solution);
    setLastAttempt(null);
    void completeStep({ kind: "info", text: `The lesson move is ${solution.san} (${solution.uci}). Follow the arrow, then connect it to the idea.` });
  }

  async function finishLesson() {
    if (sessionRecordedRef.current || sessionInFlight.current) return;
    if (progressBlockedRef.current || pendingProgress.current) {
      setLocalError("Save the current lesson progress before recording this session.");
      return;
    }
    sessionInFlight.current = true;
    sessionEndedAt.current ??= now();
    let pending = pendingSession.current;
    if (!pending || pending.rebase) pending = { body: { revision: view.state.revision, requestId: crypto.randomUUID(), mode: "lesson", courseId: course!.id, lessonId: lesson!.id, startedAt: startedAt.current, endedAt: sessionEndedAt.current, stepIds: [...touchedSteps.current], reviewAttemptIds: [] }, rebase: false };
    pendingSession.current = pending;
    try { setLocalError(""); await mutate("/session", pending.body, "Lesson session recorded"); sessionRecordedRef.current = true; setSessionRecorded(true); }
    catch (cause) { if (cause instanceof ChessMutationError && ["revision_conflict", "request_id_conflict"].includes(cause.code)) pending.rebase = true; setLocalError(message(cause, "The lesson session could not be recorded.")); }
    finally { sessionInFlight.current = false; }
  }

  function next() {
    if (progressBlockedRef.current || sessionInFlight.current || sessionRecordedRef.current) return;
    if (segment!.type === "trainer" && stepIndex + 1 < segment!.steps.length) {
      const nextIndex = stepIndex + 1;
      const nextMap = new Map(stepIndexBySegment); nextMap.set(segment!.id, nextIndex); setStepIndexBySegment(nextMap);
      void persist(segment!, segment!.steps[nextIndex]!);
      return;
    }
    if (segmentIndex + 1 < lesson!.segments.length) { changeSegment(segmentIndex + 1); return; }
    void finishLesson();
  }

  const boardStyles = squareStyles(selectedSquare, lastAttempt, revealed);
  const isFinal = segmentIndex === lesson.segments.length - 1 && (segment.type !== "trainer" || stepIndex === segment.steps.length - 1);
  const progressBlocked = progressState !== "saved";
  const canContinue = !progressBlocked && !sessionRecorded && (segment.type !== "trainer" || !step || completed.includes(step.id));
  const courseLessons = course.lessonIds.map(id => view.catalog.lessons.find(item => item.courseId === course.id && item.id === id)).filter((item): item is Lesson => Boolean(item));

  return <div className={styles.stack}>
    {localError && <div className={styles.error} role="alert"><p>{localError}</p>{progressState === "failed" && <div className={styles.errorActions}><button className={styles.quietButton} disabled={busy} onClick={() => void retryProgress()}><RotateCcw size={14}/>Retry progress save</button></div>}</div>}
    <div className={styles.learnLayout}>
      <aside className={styles.lessonRail} aria-label="Lesson sections">
        <p className={styles.kicker}>{course.title}</p><h2>{lesson.title}</h2><p>{course.level}</p>
        <div className={styles.railProgress}><div><span>{percent}% through lesson</span><span>{coveredCount}/{allSteps.length} steps</span></div><div className={styles.progressTrack}><span style={{ width: `${percent}%` }}/></div></div>
        <ol className={styles.segmentList}>{lesson.segments.map((item, index) => <li key={item.id}><button className={index === segmentIndex ? styles.activeSegmentButton : styles.segmentButton} disabled={busy || progressBlocked} onClick={() => changeSegment(index)}><span>{index + 1}</span>{item.title}</button></li>)}</ol>
        {courseLessons.length > 1 && <div className={styles.lessonPicker}>{courseLessons.map(item => <button key={item.id} aria-current={item.id === lesson.id} disabled={busy || progressBlocked} onClick={() => chooseLesson({ courseId: course.id, lessonId: item.id })}><span>{item.title}</span><small>{item.id === lesson.id ? "Open" : "Study"}</small></button>)}</div>}
      </aside>
      <div className={styles.boardPane}><div className={styles.boardFrame}><ClientChessboard options={{ allowDrawingArrows: true, animationDurationInMs: 220, arrows: revealed ? [{ color: "rgba(185, 67, 49, 0.82)", startSquare: revealed.from, endSquare: revealed.to }] : [], boardOrientation: orientation, boardStyle: { borderRadius: "0", boxShadow: "none", overflow: "hidden" }, darkSquareStyle: { backgroundColor: "#6f6e68" }, lightSquareStyle: { backgroundColor: "#f3f2ee" }, onPieceDrop: ({ sourceSquare, targetSquare }) => targetSquare ? attempt(sourceSquare, targetSquare) : false, onSquareClick: clickSquare, position: boardFen, showNotation: true, squareStyles: boardStyles }}/></div></div>
      <section className={styles.lessonPane} aria-label="Lesson content">
        <p className={styles.kicker}>{segment.type === "trainer" ? `Practice ${stepIndex + 1} of ${segment.steps.length}` : segment.type}</p><h2>{segment.title}</h2>
        <div className={styles.bodyCopy}>{segment.body.map(paragraph => <p key={paragraph}>{paragraph}</p>)}</div>
        {step && <div className={styles.trainer}><p className={styles.prompt}>{step.prompt}</p><p className={`${styles.feedback} ${feedbackClass(feedback.kind)}`} role="status">{feedback.text}</p>{hintIndex >= 0 && <p className={styles.hint}><strong>Hint {hintIndex + 1}:</strong> {step.hints[hintIndex]}</p>}<div className={styles.trainerActions}><Button variant="outline" size="sm" disabled={busy || progressBlocked || !step.hints.length || hintIndex >= step.hints.length - 1} onClick={revealHint}><Lightbulb size={14}/>{hintIndex < 0 ? "Hint" : "Another hint"}</Button><button className={styles.quietButton} disabled={busy || progressBlocked || Boolean(revealed)} onClick={revealMove}><Target size={14}/>Reveal move</button><button className={styles.quietButton} disabled={busy || progressBlocked} onClick={() => resetPosition(segment!, step, lesson!.initialFen, setBoardFen, setSelectedSquare, setLastAttempt, setRevealed, setHintIndex, setFeedback)}><RotateCcw size={14}/>Reset board</button></div></div>}
        <div className={styles.lessonNav}><Button variant="ghost" disabled={busy || progressBlocked || segmentIndex === 0} onClick={() => changeSegment(segmentIndex - 1)}><ChevronLeft size={15}/>Previous</Button><Button className={styles.primary} disabled={busy || !canContinue} onClick={next}>{busy ? <><LoaderCircle className={styles.spin} size={15}/>Saving…</> : sessionRecorded ? <><CheckCircle2 size={15}/>Session recorded</> : <>{isFinal ? "Finish lesson" : "Continue"}<ChevronRight size={15}/></>}</Button></div>
      </section>
    </div>
  </div>;
}

function ReviewView({ initialView, busy, mutate, scheduleStudy, addReviewTask }: { initialView: ChessView; busy: boolean; mutate: <T extends MutationResult>(path: string, body: object, success: string) => Promise<T>; scheduleStudy: () => void; addReviewTask: () => void }) {
  const [run, setRun] = useState<ReviewCard[]>(() => [...initialView.reviewQueue]);
  const [index, setIndex] = useState(0);
  const [boardFen, setBoardFen] = useState(run[0]?.fen ?? "start");
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<MoveAttempt | null>(null);
  const [reasonId, setReasonId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("Find the move from memory, then choose the reason it works.");
  const [saved, setSaved] = useState<SavedReview | null>(null);
  const [localError, setLocalError] = useState("");
  const [finished, setFinished] = useState(false);
  const [attemptCount, setAttemptCount] = useState(0);
  const attemptIds = useRef<string[]>([]);
  const startedAt = useRef(now());
  const pendingReview = useRef<PendingReview | null>(null);
  const reviewInFlight = useRef(false);
  const pendingSession = useRef<PendingSession | null>(null);
  const sessionInFlight = useRef(false);
  const sessionRecorded = useRef(false);
  const sessionEndedAt = useRef<string | null>(null);
  const current = run[index] ?? null;
  const solution = current ? solutionLabel(current.step) : null;

  function resetCard(nextIndex: number) {
    const card = run[nextIndex] ?? null;
    setIndex(nextIndex); setBoardFen(card?.fen ?? "start"); setSelectedSquare(null); setAttempt(null); setReasonId(null); setFeedback("Find the move from memory, then choose the reason it works."); setSaved(null); setLocalError("");
  }
  function replaceRun(cards: ReviewCard[], note: string) {
    const card = cards[0] ?? null;
    setRun([...cards]); setIndex(0); setBoardFen(card?.fen ?? "start"); setSelectedSquare(null); setAttempt(null); setReasonId(null); setFeedback("Find the move from memory, then choose the reason it works."); setSaved(null); setFinished(false); setLocalError(note);
  }
  function attemptMove(from: string, to: string) {
    if (!current || attempt || saved || busy) return false;
    const result = moveOnBoard(current.step, from, to);
    setSelectedSquare(null);
    if (!result) { setFeedback("That move is illegal in this position. Try another square."); return false; }
    setAttempt(result);
    if (result.correct) { setBoardFen(result.fen); setFeedback(`${result.san} is the authored move. Now choose why it works.`); return true; }
    setFeedback(`${result.san} is legal, but it is not the review move. Choose the reason you had in mind, then submit.`); return false;
  }
  function clickSquare({ piece, square }: SquareHandlerArgs) {
    if (!current || attempt || saved || busy) return;
    if (!selectedSquare) { if (piece) setSelectedSquare(square); return; }
    if (selectedSquare === square) { setSelectedSquare(null); return; }
    attemptMove(selectedSquare, square);
  }
  async function submitReview() {
    if (!current || !attempt || !reasonId || saved || reviewInFlight.current) return;
    const logical: ReviewDraft = { courseId: current.courseId, lessonId: current.lessonId, stepId: current.stepId, moveUci: attempt.uci, reasonChoiceId: reasonId };
    const fingerprint = JSON.stringify(logical);
    let pending = pendingReview.current;
    if (!pending || pending.fingerprint !== fingerprint) pending = { body: { ...logical, revision: initialView.state.revision, requestId: crypto.randomUUID() }, fingerprint, logical, rebase: false };
    else if (pending.rebase) pending = { ...pending, body: { ...pending.logical, revision: initialView.state.revision, requestId: crypto.randomUUID() }, rebase: false };
    pendingReview.current = pending;
    reviewInFlight.current = true;
    try {
      setLocalError("");
      const result = await mutate<MutationResult & { result: SavedReview }>("/review", pending.body, "Review saved");
      pendingReview.current = null;
      setSaved(result.result);
      if (!attemptIds.current.includes(result.result.attemptId)) { attemptIds.current.push(result.result.attemptId); setAttemptCount(attemptIds.current.length); }
      setFeedback(result.result.moveCorrect && result.result.reasonCorrect ? "Clean recall. This position moves farther out in the schedule." : "This position will return sooner. Check both the move and the idea before continuing.");
    } catch (cause) {
      if (cause instanceof ChessMutationError) {
        const cardStillDue = cause.latestView?.reviewQueue.some(card => card.id === current.id) ?? true;
        if (cause.code === "review_not_due" || (cause.code === "revision_conflict" && cause.latestView && !cardStillDue)) {
          pendingReview.current = null;
          const queue = cause.latestView?.reviewQueue ?? run.filter(card => card.id !== current.id);
          replaceRun(queue, cause.message);
          return;
        }
        if (["revision_conflict", "request_id_conflict"].includes(cause.code)) pending.rebase = true;
      }
      pendingReview.current = pending;
      setLocalError(message(cause, "This review could not be saved."));
    } finally { reviewInFlight.current = false; }
  }
  async function finishRun() {
    if (sessionRecorded.current || sessionInFlight.current) return;
    if (!attemptIds.current.length) { setFinished(true); return; }
    sessionInFlight.current = true;
    sessionEndedAt.current ??= now();
    let pending = pendingSession.current;
    if (!pending || pending.rebase) pending = { body: { revision: initialView.state.revision, requestId: crypto.randomUUID(), mode: "review", courseId: null, lessonId: null, startedAt: startedAt.current, endedAt: sessionEndedAt.current, stepIds: [], reviewAttemptIds: [...attemptIds.current] }, rebase: false };
    pendingSession.current = pending;
    try { setLocalError(""); const result = await mutate<MutationResult & { session: unknown }>("/session", pending.body, "Review session recorded"); sessionRecorded.current = true; setRun([...result.view.reviewQueue]); setFinished(true); }
    catch (cause) { if (cause instanceof ChessMutationError && ["revision_conflict", "request_id_conflict"].includes(cause.code)) pending.rebase = true; setLocalError(message(cause, "The review session could not be recorded.")); }
    finally { sessionInFlight.current = false; }
  }
  function advance() { if (index + 1 < run.length) resetCard(index + 1); else void finishRun(); }

  if (!current || finished) return <div className={styles.stack}>{localError && <p className={styles.error} role="alert">{localError}</p>}<section className={styles.card}><div className={styles.empty}><span><CheckCircle2 size={27}/></span><h2>Review queue clear</h2><p>{nextDueLabel(initialView.summary.nextDueAt)} Missed positions return sooner; clean recalls space themselves out.</p><div className={styles.inlineActions}>{!finished && attemptCount > 0 && <Button variant="outline" disabled={busy} onClick={() => void finishRun()}>Finish review</Button>}<Button variant="outline" onClick={addReviewTask}><ListTodo size={15}/>Add review task</Button><Button className={styles.primary} onClick={scheduleStudy}><CalendarClock size={15}/>Plan the next session</Button></div></div></section></div>;

  const completed = index + (saved ? 1 : 0);
  const percent = Math.round(completed / run.length * 100);
  const correctChoice = current.choices.find(choice => choice.isCorrect);
  const boardStyles = squareStyles(selectedSquare, attempt, saved ? solution : null);
  return <div className={styles.stack}>
    {localError && <p className={styles.error} role="alert">{localError}</p>}
    <div className={styles.reviewLayout}>
      <aside className={styles.reviewRail} aria-label="Review status"><p className={styles.kicker}>Active recall</p><h2>Opening repertoire review</h2><p>Scotch as White · Sicilian as Black. Play the move, then name the idea.</p><div className={styles.reviewCount}><strong>{run.length - completed}</strong><span>remaining in this session</span></div><div className={styles.reviewProgress}><div><span>{percent}% complete</span></div><div className={styles.progressTrack}><span style={{ width: `${percent}%` }}/></div></div></aside>
      <div className={styles.boardPane}><div className={styles.boardFrame}><ClientChessboard options={{ allowDrawingArrows: true, animationDurationInMs: 220, arrows: saved && solution ? [{ color: "rgba(185, 67, 49, 0.82)", startSquare: solution.from, endSquare: solution.to }] : [], boardOrientation: current.boardOrientation, boardStyle: { borderRadius: "0", boxShadow: "none", overflow: "hidden" }, darkSquareStyle: { backgroundColor: "#6f6e68" }, lightSquareStyle: { backgroundColor: "#f3f2ee" }, onPieceDrop: ({ sourceSquare, targetSquare }) => targetSquare ? attemptMove(sourceSquare, targetSquare) : false, onSquareClick: clickSquare, position: boardFen, showNotation: true, squareStyles: boardStyles }}/></div></div>
      <section className={styles.reviewPane} aria-label="Review prompt"><p className={styles.kicker}>{current.lessonTitle} · Card {index + 1} of {run.length}</p><h2>{current.prompt}</h2><p className={styles.feedback} role="status">{feedback}</p><div className={styles.reasonBlock}><p className={styles.reasonQuestion}>{current.question}</p><div className={styles.choices}>{current.choices.map(choice => <ReviewChoiceControl key={choice.id} choice={choice} disabled={!attempt || Boolean(saved) || busy} selected={reasonId === choice.id} saved={saved} onSelect={setReasonId}/>)}</div></div>
        {saved && <div className={styles.result}><p>Move: <strong>{saved.moveCorrect ? "remembered" : "needs review"}</strong></p><p>Reason: <strong>{saved.reasonCorrect ? "understood" : "needs review"}</strong></p>{solution && <p>Correct move: <strong>{solution.san}</strong> ({solution.uci})</p>}{correctChoice && <p>Key idea: {correctChoice.text}</p>}<p>{current.step.explanation}</p><p>Next due {formatDateTime(saved.dueAt)}.</p></div>}
        <div className={styles.actionRow}><Button className={styles.primary} disabled={!attempt || !reasonId || Boolean(saved) || busy} onClick={() => void submitReview()}>{busy && !saved ? <><LoaderCircle className={styles.spin} size={15}/>Saving…</> : "Submit review"}</Button><Button variant="outline" disabled={!saved || busy} onClick={advance}>{index + 1 < run.length ? "Next position" : "Finish review"}<ChevronRight size={15}/></Button></div>
      </section>
    </div>
  </div>;
}

function ReviewChoiceControl({ choice, disabled, selected, saved, onSelect }: { choice: ReviewChoice; disabled: boolean; selected: boolean; saved: SavedReview | null; onSelect: (id: string) => void }) {
  const className = saved && choice.isCorrect ? styles.correctChoice : saved && selected && !choice.isCorrect ? styles.incorrectChoice : selected ? styles.selectedChoice : styles.choice;
  return <label className={className}><input type="radio" name="chess-review-reason" checked={selected} disabled={disabled} onChange={() => onSelect(choice.id)}/><span>{choice.text}</span></label>;
}

export function TodayChessCard({ day, openChess }: { day: string; openChess: () => void }) {
  const { view: integrations } = useIntegrations();
  const [view, setView] = useState<ChessView | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try { const response = await fetch("/api/chess", { cache: "no-store" }); const value: unknown = await response.json(); if (response.ok && active) setView(parseChessView(value)); }
      catch {}
      finally { if (active) setLoaded(true); }
    };
    void load(); const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const plannedEvent = integrations.events.filter(event => eventOnDay(event, day) && /^chess\b/i.test(event.title.trim())).sort((a, b) => (a.startTime ?? "99:99").localeCompare(b.startTime ?? "99:99"))[0];
  const plannedTask = integrations.tasks.filter(task => task.dueDate === day && /^chess\b/i.test(task.title.trim()))[0];
  const due = view?.summary.reviewsDue ?? 0;
  if (!loaded || !view || (!due && !plannedEvent && !plannedTask)) return null;
  return <section className={styles.todayCard} aria-label="Chess today">
    <div className={styles.todayHeader}><div className={styles.todayTitle}><span className={styles.todayIcon}><Crown size={17}/></span><span><strong>Chess</strong><small>Practice loop</small></span></div><button className={styles.todayOpen} onClick={openChess}>Open <ChevronRight size={14}/></button></div>
    <div className={styles.todayBody}><div className={styles.todayLead}><strong>{due ? `${due} due` : "Planned"}</strong></div>{due > 0 && <p>Review due positions.</p>}{plannedEvent ? <span className={styles.todayPlan}><CalendarClock size={13}/>{plannedEvent.allDay ? "Planned today" : `${formatClock(plannedEvent.startTime)} · ${plannedEvent.title}`}</span> : plannedTask ? <span className={styles.todayPlan}><ListTodo size={13}/>{plannedTask.title}</span> : null}</div>
  </section>;
}

function LoadFailure({ error, retry }: { error: string; retry: () => void }) { return <section className={styles.card}><div className={styles.empty}><span><CircleAlert size={27}/></span><h2>Chess needs another try</h2><p>{error}</p><Button variant="outline" onClick={retry}><RotateCcw size={15}/>Try again</Button></div></section>; }
function EmptyCatalog() { return <section className={styles.card}><div className={styles.empty}><span><BookOpen size={27}/></span><h3>No Chess lessons are available</h3><p>The local course catalog could not provide a lesson.</p></div></section>; }

function firstLesson(view: ChessView): LessonTarget | null {
  const course = view.catalog.courses[0]; const lessonId = course?.lessonIds[0];
  return course && lessonId ? { courseId: course.id, lessonId } : null;
}
function currentLesson(view: ChessView): { course: Course; lesson: Lesson } | null {
  const target = view.summary.currentCourseId && view.summary.currentLessonId ? { courseId: view.summary.currentCourseId, lessonId: view.summary.currentLessonId } : firstLesson(view);
  if (!target) return null;
  const course = view.catalog.courses.find(item => item.id === target.courseId); const lesson = view.catalog.lessons.find(item => item.courseId === target.courseId && item.id === target.lessonId);
  return course && lesson ? { course, lesson } : null;
}
function initialStepMap(lesson: Lesson | undefined, progress: LessonProgress | undefined) {
  const values = new Map<string, number>();
  lesson?.segments.forEach(segment => { if (segment.type === "trainer") values.set(segment.id, Math.max(0, segment.steps.findIndex(step => step.id === progress?.currentStepId))); });
  return values;
}
function resetPosition(segment: LessonSegment, step: TrainerStep | null, initialFen: string, setFen: (value: string) => void, setSelected: (value: string | null) => void, setAttempt: (value: MoveAttempt | null) => void, setReveal: (value: ReturnType<typeof solutionLabel>) => void, setHint: (value: number) => void, setFeedback: (value: Feedback) => void) {
  setFen(step?.fen ?? ("fen" in segment ? segment.fen ?? initialFen : initialFen)); setSelected(null); setAttempt(null); setReveal(null); setHint(-1); setFeedback({ kind: "idle", text: segment.type === "trainer" ? "Find the authored move on the board." : "Read the idea, then continue when the position makes sense." });
}
function squareStyles(selected: string | null, attempt: Pick<MoveAttempt, "correct" | "from" | "to"> | null, revealed: { from: string; to: string } | null): Record<string, CSSProperties> {
  const result: Record<string, CSSProperties> = {};
  if (selected) result[selected] = { boxShadow: "inset 0 0 0 4px rgba(17, 17, 15, .62)" };
  if (attempt) { const color = attempt.correct ? "rgba(17, 17, 15, .72)" : "rgba(185, 67, 49, .72)"; result[attempt.from] = { boxShadow: `inset 0 0 0 4px ${color}` }; result[attempt.to] = { boxShadow: `inset 0 0 0 4px ${color}` }; }
  if (revealed) { result[revealed.from] = { boxShadow: "inset 0 0 0 4px rgba(185, 67, 49, .82)" }; result[revealed.to] = { boxShadow: "inset 0 0 0 4px rgba(185, 67, 49, .82)" }; }
  return result;
}
function feedbackClass(kind: Feedback["kind"]) { return kind === "correct" ? styles.feedbackCorrect : kind === "incorrect" ? styles.feedbackIncorrect : kind === "info" ? styles.feedbackInfo : ""; }
function nextDueLabel(value: string | null) { return value ? `Next review ${formatDateTime(value)}` : "No later reviews are scheduled yet."; }
function formatDateTime(value: string) { return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function formatClock(value: string | null) { if (!value) return "Planned"; const [hour, minute] = value.split(":").map(Number); return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "am" : "pm"}`; }
function studyWindow(day: string) {
  const current = new Date(); const today = dateKey(current); let hour = 19; let minute = 0; let endDate = day;
  if (day === today) { const rounded = new Date(current.getTime() + 15 * 60_000); rounded.setMinutes(Math.ceil(rounded.getMinutes() / 5) * 5, 0, 0); hour = rounded.getHours(); minute = rounded.getMinutes(); const end = new Date(rounded.getTime() + 20 * 60_000); endDate = dateKey(end); return { date: dateKey(rounded), endDate, time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, endTime: `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}` }; }
  return { date: day, endDate, time: "19:00", endTime: "19:20" };
}

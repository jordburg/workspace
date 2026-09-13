import { Chess } from "chess.js";
import { z } from "zod";

import { courses, getCourse, getLesson, lessons } from "./chess/catalog.ts";
import { getAllReviewCards, getReviewCard, interleaveReviewCards, type ReviewCard } from "./chess/review.ts";
import { attemptTrainerMove, getTrainerSteps, isUciMove } from "./chess/trainer.ts";
import type { Course, Lesson } from "./chess/types.ts";

const timestampSchema = z.string().datetime({ offset: true });
const idSchema = z.string().trim().min(1).max(200);
const requestIdSchema = z.string().uuid();
const unique = (values: string[]) => new Set(values).size === values.length;

export const lessonProgressSchema = z.object({
  courseId: idSchema,
  lessonId: idSchema,
  currentSegmentId: idSchema,
  currentStepId: idSchema.nullable(),
  completedStepIds: z.array(idSchema).max(500),
  updatedAt: timestampSchema,
}).strict().refine((value) => unique(value.completedStepIds), {
  message: "Completed step IDs must be unique.",
});

export const reviewCardScheduleSchema = z.object({
  courseId: idSchema,
  lessonId: idSchema,
  stepId: idSchema,
  dueAt: timestampSchema,
  intervalDays: z.number().int().min(0).max(36500),
  ease: z.number().min(1.3).max(10),
  lapses: z.number().int().min(0).max(1000000),
  consecutiveCorrect: z.number().int().min(0).max(1000000),
  lastResult: z.enum(["again", "good"]).nullable(),
  updatedAt: timestampSchema,
}).strict();

export const reviewAttemptSchema = z.object({
  id: requestIdSchema,
  requestId: requestIdSchema,
  courseId: idSchema,
  lessonId: idSchema,
  stepId: idSchema,
  moveUci: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/),
  reasonChoiceId: idSchema,
  moveCorrect: z.boolean(),
  reasonCorrect: z.boolean(),
  grade: z.enum(["again", "good"]),
  attemptedAt: timestampSchema,
  dueAt: timestampSchema,
}).strict().refine((value) => value.id === value.requestId, {
  message: "A review attempt ID must match its request ID.",
});

export const studySessionSchema = z.object({
  id: requestIdSchema,
  requestId: requestIdSchema,
  mode: z.enum(["lesson", "review", "mixed"]),
  courseId: idSchema.nullable(),
  lessonId: idSchema.nullable(),
  startedAt: timestampSchema,
  endedAt: timestampSchema,
  stepIds: z.array(idSchema).max(500),
  reviewAttemptIds: z.array(requestIdSchema).max(500),
  createdAt: timestampSchema,
}).strict().superRefine((value, ctx) => {
  if (value.id !== value.requestId) ctx.addIssue({ code: "custom", message: "A study session ID must match its request ID." });
  if ((value.courseId === null) !== (value.lessonId === null)) ctx.addIssue({ code: "custom", message: "Choose both a course and lesson, or neither." });
  const duration = new Date(value.endedAt).getTime() - new Date(value.startedAt).getTime();
  if (duration <= 0) ctx.addIssue({ code: "custom", path: ["endedAt"], message: "A study session must end after it starts." });
  if (duration > 24 * 60 * 60 * 1000) ctx.addIssue({ code: "custom", path: ["endedAt"], message: "A study session cannot be longer than 24 hours." });
  if (!unique(value.stepIds)) ctx.addIssue({ code: "custom", path: ["stepIds"], message: "Study-session step IDs must be unique." });
  if (!unique(value.reviewAttemptIds)) ctx.addIssue({ code: "custom", path: ["reviewAttemptIds"], message: "Review-attempt IDs must be unique." });
});

export const chessStateSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  progress: z.array(lessonProgressSchema).max(500),
  reviewCards: z.array(reviewCardScheduleSchema).max(5000),
  reviewAttempts: z.array(reviewAttemptSchema).max(50000),
  studySessions: z.array(studySessionSchema).max(10000),
}).strict().superRefine((state, ctx) => {
  const progressKeys = state.progress.map((value) => `${value.courseId}:${value.lessonId}`);
  const cardKeys = state.reviewCards.map((value) => `${value.courseId}:${value.lessonId}:${value.stepId}`);
  if (!unique(progressKeys)) ctx.addIssue({ code: "custom", path: ["progress"], message: "Lesson progress entries must be unique." });
  if (!unique(cardKeys)) ctx.addIssue({ code: "custom", path: ["reviewCards"], message: "Review-card schedules must be unique." });
  if (!unique(state.reviewAttempts.map((value) => value.id))) ctx.addIssue({ code: "custom", path: ["reviewAttempts"], message: "Review-attempt IDs must be unique." });
  if (!unique(state.studySessions.map((value) => value.id))) ctx.addIssue({ code: "custom", path: ["studySessions"], message: "Study-session IDs must be unique." });
});

export const progressRequestSchema = z.object({
  revision: z.number().int().nonnegative(),
  requestId: requestIdSchema,
  courseId: idSchema,
  lessonId: idSchema,
  currentSegmentId: idSchema,
  currentStepId: idSchema.nullable(),
  completedStepIds: z.array(idSchema).max(500),
}).strict().refine((value) => unique(value.completedStepIds), {
  message: "Completed step IDs must be unique.",
});

export const reviewRequestSchema = z.object({
  revision: z.number().int().nonnegative(),
  requestId: requestIdSchema,
  courseId: idSchema,
  lessonId: idSchema,
  stepId: idSchema,
  moveUci: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/),
  reasonChoiceId: idSchema,
}).strict();

export const studySessionRequestSchema = z.object({
  revision: z.number().int().nonnegative(),
  requestId: requestIdSchema,
  mode: z.enum(["lesson", "review", "mixed"]),
  courseId: idSchema.nullable(),
  lessonId: idSchema.nullable(),
  startedAt: timestampSchema,
  endedAt: timestampSchema,
  stepIds: z.array(idSchema).max(500),
  reviewAttemptIds: z.array(requestIdSchema).max(500),
}).strict().superRefine((value, ctx) => {
  if ((value.courseId === null) !== (value.lessonId === null)) ctx.addIssue({ code: "custom", message: "Choose both a course and lesson, or neither." });
  const duration = new Date(value.endedAt).getTime() - new Date(value.startedAt).getTime();
  if (duration <= 0) ctx.addIssue({ code: "custom", path: ["endedAt"], message: "A study session must end after it starts." });
  if (duration > 24 * 60 * 60 * 1000) ctx.addIssue({ code: "custom", path: ["endedAt"], message: "A study session cannot be longer than 24 hours." });
  if (!unique(value.stepIds)) ctx.addIssue({ code: "custom", path: ["stepIds"], message: "Study-session step IDs must be unique." });
  if (!unique(value.reviewAttemptIds)) ctx.addIssue({ code: "custom", path: ["reviewAttemptIds"], message: "Review-attempt IDs must be unique." });
});

export type LessonProgress = z.infer<typeof lessonProgressSchema>;
export type ReviewCardSchedule = z.infer<typeof reviewCardScheduleSchema>;
export type ReviewAttempt = z.infer<typeof reviewAttemptSchema>;
export type StudySession = z.infer<typeof studySessionSchema>;
export type ChessState = z.infer<typeof chessStateSchema>;
export type ProgressRequest = z.infer<typeof progressRequestSchema>;
export type ReviewRequest = z.infer<typeof reviewRequestSchema>;
export type StudySessionRequest = z.infer<typeof studySessionRequestSchema>;

export type ChessSummary = {
  currentCourseId: string | null;
  currentLessonId: string | null;
  nextDueAt: string | null;
  recentReviewAccuracy: number | null;
  resumePath: string | null;
  reviewsDue: number;
  stepsCovered: number;
  totalCards: number;
  totalSteps: number;
};

export type ChessView = {
  capability: { canWrite: true; id: "chess"; version: 1 };
  catalog: { courses: Course[]; lessons: Lesson[] };
  reviewQueue: ReviewCard[];
  state: ChessState;
  summary: ChessSummary;
};

export type ChessProgressResponse = {
  replayed: boolean;
  view: ChessView;
};

export type ChessReviewResult = {
  attemptId: string;
  dueAt: string;
  grade: "again" | "good";
  moveCorrect: boolean;
  reasonCorrect: boolean;
};

export type ChessReviewResponse = ChessProgressResponse & {
  result: ChessReviewResult;
};

export type ChessSessionResponse = ChessProgressResponse & {
  session: StudySession;
};

export const emptyChessState: ChessState = {
  version: 1,
  revision: 0,
  progress: [],
  reviewCards: [],
  reviewAttempts: [],
  studySessions: [],
};

export function validateChessCatalog() {
  const courseIds = courses.map((course) => course.id);
  if (!unique(courseIds)) throw new Error("Chess course IDs must be unique.");
  const lessonKeys = lessons.map((lesson) => `${lesson.courseId}:${lesson.id}`);
  if (!unique(lessonKeys)) throw new Error("Chess lesson IDs must be unique within a course.");
  for (const course of courses) {
    if (!course.id || !course.title || !course.description || !course.level || !unique(course.lessonIds)) throw new Error(`Invalid chess course ${course.id}.`);
    for (const lessonId of course.lessonIds) if (!getLesson(course.id, lessonId)) throw new Error(`Missing chess lesson ${course.id}:${lessonId}.`);
  }
  for (const lesson of lessons) {
    if (!getCourse(lesson.courseId) || !lesson.id || !lesson.title || !isFenShape(lesson.initialFen) || !unique(lesson.segments.map((segment) => segment.id))) throw new Error(`Invalid chess lesson ${lesson.id}.`);
    const stepIds = getTrainerSteps(lesson).map((step) => step.id);
    if (!unique(stepIds)) throw new Error(`Trainer step IDs must be unique in ${lesson.id}.`);
    for (const segment of lesson.segments) {
      if (!segment.id || !segment.title || !segment.body.length || ("fen" in segment && segment.fen && !isFenShape(segment.fen))) throw new Error(`Invalid chess segment ${segment.id}.`);
      if (segment.type !== "trainer") continue;
      for (const step of segment.steps) {
        if (!isFenShape(step.fen) || !step.acceptedMoves.length || step.acceptedMoves.some((move) => !isUciMove(move)) || step.opponentReplies?.some((move) => !isUciMove(move))) throw new Error(`Invalid chess trainer step ${step.id}.`);
        if (step.review.choices.filter((choice) => choice.isCorrect).length !== 1 || !unique(step.review.choices.map((choice) => choice.id))) throw new Error(`Invalid review prompt for ${step.id}.`);
        for (const move of step.acceptedMoves) {
          try {
            const result = attemptTrainerMove(
              step,
              move.slice(0, 2),
              move.slice(2, 4),
              move.slice(4),
            );
            if (result.status !== "correct") {
              throw new Error("Authored move is not legal in this position.");
            }
          } catch (error) {
            const detail = error instanceof Error ? error.message : "Invalid move sequence.";
            throw new Error(`Invalid authored line for ${step.id}: ${detail}`);
          }
        }
      }
    }
  }
  return true;
}

export function validateProgressAgainstCatalog(input: Pick<ProgressRequest, "completedStepIds" | "courseId" | "currentSegmentId" | "currentStepId" | "lessonId">) {
  const lesson = getLesson(input.courseId, input.lessonId);
  if (!lesson) throw new Error("Chess lesson not found.");
  const segment = lesson.segments.find((value) => value.id === input.currentSegmentId);
  if (!segment) throw new Error("Chess lesson section not found.");
  const stepIds = new Set(getTrainerSteps(lesson).map((step) => step.id));
  if (input.completedStepIds.some((id) => !stepIds.has(id))) throw new Error("Completed steps must belong to this lesson.");
  if (segment.type === "trainer") {
    if (input.currentStepId === null || !segment.steps.some((step) => step.id === input.currentStepId)) throw new Error("Choose a step from the current trainer section.");
  } else if (input.currentStepId !== null) {
    throw new Error("Theory and diagram sections do not have a current trainer step.");
  }
  return lesson;
}

export function validateChessStateAgainstCatalog(state: ChessState) {
  for (const progress of state.progress) validateProgressAgainstCatalog(progress);
  for (const schedule of state.reviewCards) {
    if (!getReviewCard(schedule.courseId, schedule.lessonId, schedule.stepId)) {
      throw new Error("A review-card schedule refers to missing authored content.");
    }
  }
  for (const attempt of state.reviewAttempts) {
    const card = getReviewCard(attempt.courseId, attempt.lessonId, attempt.stepId);
    if (!card) throw new Error("A review attempt refers to missing authored content.");
    const choice = card.choices.find((value) => value.id === attempt.reasonChoiceId);
    if (!choice) {
      throw new Error("A review attempt refers to a missing authored reason.");
    }
    const result = attemptTrainerMove(
      card.step,
      attempt.moveUci.slice(0, 2),
      attempt.moveUci.slice(2, 4),
      attempt.moveUci.slice(4),
    );
    if (result.status === "illegal" || result.moveUci !== attempt.moveUci) {
      throw new Error("A review attempt contains an invalid saved move.");
    }
    if (attempt.moveCorrect !== (result.status === "correct") || attempt.reasonCorrect !== choice.isCorrect) {
      throw new Error("A review attempt does not match the authored answer.");
    }
    if ((attempt.grade === "good") !== (attempt.moveCorrect && attempt.reasonCorrect)) {
      throw new Error("A review attempt has an inconsistent grade.");
    }
  }
  const attemptIds = new Set(state.reviewAttempts.map((attempt) => attempt.id));
  for (const session of state.studySessions) {
    if (session.courseId && session.lessonId) {
      const lesson = getLesson(session.courseId, session.lessonId);
      if (!lesson) throw new Error("A study session refers to missing authored content.");
      const stepIds = new Set(getTrainerSteps(lesson).map((step) => step.id));
      if (session.stepIds.some((id) => !stepIds.has(id))) {
        throw new Error("A study session refers to a missing authored step.");
      }
    } else if (session.stepIds.length) {
      throw new Error("A study session has steps without an authored lesson.");
    }
    if (session.reviewAttemptIds.some((id) => !attemptIds.has(id))) {
      throw new Error("A study session refers to a missing review attempt.");
    }
  }
  return true;
}

export function createChessView(state: ChessState, now = new Date()): ChessView {
  const allCards = getAllReviewCards();
  const schedules = new Map(state.reviewCards.map((schedule) => [`${schedule.courseId}:${schedule.lessonId}:${schedule.stepId}`, schedule]));
  const reviewQueue = interleaveReviewCards(allCards.filter((card) => {
    const schedule = schedules.get(card.id);
    return !schedule || new Date(schedule.dueAt).getTime() <= now.getTime();
  }));
  const future = state.reviewCards.filter((schedule) => new Date(schedule.dueAt).getTime() > now.getTime()).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const validStepKeys = new Set(allCards.map((card) => card.id));
  const covered = new Set(
    state.progress.flatMap((progress) =>
      progress.completedStepIds
        .map((stepId) => `${progress.courseId}:${progress.lessonId}:${stepId}`)
        .filter((key) => validStepKeys.has(key)),
    ),
  );
  const current = [...state.progress].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  const recent = state.reviewAttempts.slice(-20);
  const recentReviewAccuracy = recent.length ? recent.filter((attempt) => attempt.grade === "good").length / recent.length : null;
  return {
    capability: { canWrite: true, id: "chess", version: 1 },
    catalog: { courses, lessons },
    reviewQueue,
    state,
    summary: {
      currentCourseId: current?.courseId ?? null,
      currentLessonId: current?.lessonId ?? null,
      nextDueAt: future[0]?.dueAt ?? null,
      recentReviewAccuracy,
      resumePath: current ? `/chess/learn/${encodeURIComponent(current.courseId)}/${encodeURIComponent(current.lessonId)}` : null,
      reviewsDue: reviewQueue.length,
      stepsCovered: covered.size,
      totalCards: allCards.length,
      totalSteps: validStepKeys.size,
    },
  };
}

function isFenShape(value: string) {
  try {
    new Chess(value);
    return true;
  } catch {
    return false;
  }
}

validateChessCatalog();

export * from "./chess/catalog.ts";
export * from "./chess/review.ts";
export * from "./chess/trainer.ts";
export * from "./chess/types.ts";

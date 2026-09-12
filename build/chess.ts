import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "vite";
import { z } from "zod";

import {
  chessStateSchema,
  createChessView,
  emptyChessState,
  lessonProgressSchema,
  progressRequestSchema,
  reviewAttemptSchema,
  reviewCardScheduleSchema,
  reviewRequestSchema,
  studySessionRequestSchema,
  studySessionSchema,
  validateChessStateAgainstCatalog,
  validateProgressAgainstCatalog,
  type ChessState,
} from "../lib/chess.ts";
import { getLesson } from "../lib/chess/catalog.ts";
import {
  getReviewCard,
  gradeReview,
  scheduleNextReview,
} from "../lib/chess/review.ts";
import { attemptTrainerMove, getTrainerSteps } from "../lib/chess/trainer.ts";
import {
  StoreBusyError,
  withPrivateLock,
  writePrivateJson,
} from "./private-store.ts";

class ChessError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = "invalid_request") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const mutationResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("progress") }).strict(),
  z.object({
    kind: z.literal("review"),
    attemptId: z.string().uuid(),
    moveCorrect: z.boolean(),
    reasonCorrect: z.boolean(),
    grade: z.enum(["again", "good"]),
    dueAt: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    kind: z.literal("session"),
    sessionId: z.string().uuid(),
  }).strict(),
]);

const requestReceiptSchema = z.object({
  requestId: z.string().uuid(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime({ offset: true }),
  result: mutationResultSchema,
}).strict();

const privateChessStateSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  progress: z.array(lessonProgressSchema).max(500),
  reviewCards: z.array(reviewCardScheduleSchema).max(5000),
  reviewAttempts: z.array(reviewAttemptSchema).max(50000),
  studySessions: z.array(studySessionSchema).max(10000),
  requests: z.array(requestReceiptSchema).max(10000),
}).strict().superRefine((state, ctx) => {
  const parsed = chessStateSchema.safeParse({
    version: state.version,
    revision: state.revision,
    progress: state.progress,
    reviewCards: state.reviewCards,
    reviewAttempts: state.reviewAttempts,
    studySessions: state.studySessions,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue(issue);
  }
  const ids = state.requests.map((receipt) => receipt.requestId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", path: ["requests"], message: "Chess request IDs must be unique." });
  }
});

type MutationResult = z.infer<typeof mutationResultSchema>;
type PrivateChessState = z.infer<typeof privateChessStateSchema>;

const emptyPrivateState = (): PrivateChessState => ({
  ...structuredClone(emptyChessState),
  requests: [],
});

const publicState = (state: PrivateChessState): ChessState => {
  return chessStateSchema.parse({
    version: state.version,
    revision: state.revision,
    progress: state.progress,
    reviewCards: state.reviewCards,
    reviewAttempts: state.reviewAttempts,
    studySessions: state.studySessions,
  });
};

const requestHash = (kind: string, input: unknown) =>
  createHash("sha256").update(JSON.stringify({ kind, input })).digest("hex");

export function createChessService(
  directory: string,
  options: { now?: () => Date } = {},
) {
  const file = join(directory, "chess.private.json");
  const now = options.now ?? (() => new Date());
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(operation: () => Promise<T>) => {
    const next = queue
      .catch(() => undefined)
      .then(() => withPrivateLock(file, operation));
    queue = next;
    return next;
  };

  async function read(): Promise<PrivateChessState> {
    try {
      const parsed = privateChessStateSchema.parse(
        JSON.parse(await readFile(file, "utf8")),
      );
      try {
        validateChessStateAgainstCatalog(publicState(parsed));
      } catch {
        throw new ChessError(
          "Your chess data could not be read. The saved file has been left untouched.",
          500,
          "invalid_state",
        );
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyPrivateState();
      }
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new ChessError(
          "Your chess data could not be read. The saved file has been left untouched.",
          500,
          "invalid_state",
        );
      }
      throw error;
    }
  }

  const send = (response: ServerResponse, status: number, value: unknown) => {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    response.end(JSON.stringify(value));
  };

  const mutationReply = (
    state: PrivateChessState,
    result: MutationResult,
    replayed: boolean,
  ) => {
    const view = createChessView(publicState(state), now());
    if (result.kind === "review") {
      const reviewResult = {
        attemptId: result.attemptId,
        moveCorrect: result.moveCorrect,
        reasonCorrect: result.reasonCorrect,
        grade: result.grade,
        dueAt: result.dueAt,
      };
      return { view, result: reviewResult, replayed };
    }
    if (result.kind === "session") {
      const session = state.studySessions.find(
        (value) => value.id === result.sessionId,
      );
      if (!session) {
        throw new ChessError(
          "The saved study session could not be found.",
          500,
          "invalid_state",
        );
      }
      return { view, session, replayed };
    }
    return { view, replayed };
  };

  const existingReceipt = (
    state: PrivateChessState,
    requestId: string,
    hash: string,
  ) => {
    const receipt = state.requests.find(
      (value) => value.requestId === requestId,
    );
    if (receipt && receipt.requestHash !== hash) {
      throw new ChessError(
        "This request ID was already used for a different chess update. Start a fresh update.",
        409,
        "request_id_conflict",
      );
    }
    return receipt ?? null;
  };

  const assertRevision = (state: PrivateChessState, revision: number) => {
    if (revision !== state.revision) {
      throw new ChessError(
        "Your chess data changed elsewhere. Reload the latest progress before saving.",
        409,
        "revision_conflict",
      );
    }
  };

  const saveMutation = async (
    state: PrivateChessState,
    requestId: string,
    hash: string,
    result: MutationResult,
    at: string,
  ) => {
    state.revision += 1;
    state.requests = [
      ...state.requests,
      { requestId, requestHash: hash, createdAt: at, result },
    ].slice(-10000);
    const parsed = privateChessStateSchema.parse(state);
    validateChessStateAgainstCatalog(publicState(parsed));
    await writePrivateJson(file, parsed);
    return parsed;
  };

  async function saveProgress(input: z.infer<typeof progressRequestSchema>) {
    const hash = requestHash("progress", input);
    return exclusive(async () => {
      const state = await read();
      const receipt = existingReceipt(state, input.requestId, hash);
      if (receipt) return mutationReply(state, receipt.result, true);
      let lesson: ReturnType<typeof validateProgressAgainstCatalog>;
      try {
        lesson = validateProgressAgainstCatalog(input);
      } catch (error) {
        throw new ChessError(
          error instanceof Error ? error.message : "Invalid chess progress.",
          400,
          "invalid_progress",
        );
      }
      assertRevision(state, input.revision);
      const at = now().toISOString();
      const existing = state.progress.find(
        (value) =>
          value.courseId === input.courseId && value.lessonId === input.lessonId,
      );
      const covered = new Set([
        ...(existing?.completedStepIds ?? []),
        ...input.completedStepIds,
      ]);
      const completedStepIds = getTrainerSteps(lesson)
        .map((step) => step.id)
        .filter((stepId) => covered.has(stepId));
      const progress = lessonProgressSchema.parse({
        courseId: input.courseId,
        lessonId: input.lessonId,
        currentSegmentId: input.currentSegmentId,
        currentStepId: input.currentStepId,
        completedStepIds,
        updatedAt: at,
      });
      state.progress = [
        ...state.progress.filter(
          (value) =>
            value.courseId !== input.courseId || value.lessonId !== input.lessonId,
        ),
        progress,
      ];
      const saved = await saveMutation(
        state,
        input.requestId,
        hash,
        { kind: "progress" },
        at,
      );
      return mutationReply(saved, { kind: "progress" }, false);
    });
  }

  async function saveReview(input: z.infer<typeof reviewRequestSchema>) {
    const hash = requestHash("review", input);
    return exclusive(async () => {
      const state = await read();
      const receipt = existingReceipt(state, input.requestId, hash);
      if (receipt) return mutationReply(state, receipt.result, true);
      const card = getReviewCard(input.courseId, input.lessonId, input.stepId);
      if (!card) {
        throw new ChessError("Chess review card not found.", 404, "not_found");
      }
      assertRevision(state, input.revision);
      if (
        state.reviewAttempts.some(
          (attempt) => attempt.id === input.requestId || attempt.requestId === input.requestId,
        ) ||
        state.studySessions.some(
          (session) => session.id === input.requestId || session.requestId === input.requestId,
        )
      ) {
        throw new ChessError(
          "This request ID is already attached to saved chess activity.",
          409,
          "request_id_conflict",
        );
      }
      const atDate = now();
      const at = atDate.toISOString();
      const old = state.reviewCards.find(
        (value) =>
          value.courseId === input.courseId &&
          value.lessonId === input.lessonId &&
          value.stepId === input.stepId,
      );
      if (old && new Date(old.dueAt).getTime() > atDate.getTime()) {
        throw new ChessError(
          "This review was already saved and is not due again yet. Refresh the review queue before continuing.",
          409,
          "review_not_due",
        );
      }
      const move = attemptTrainerMove(
        card.step,
        input.moveUci.slice(0, 2),
        input.moveUci.slice(2, 4),
        input.moveUci.slice(4),
      );
      if (move.status === "illegal") {
        throw new ChessError(
          "That move is not legal in this review position.",
          400,
          "invalid_move",
        );
      }
      const choice = card.choices.find(
        (value) => value.id === input.reasonChoiceId,
      );
      if (!choice) {
        throw new ChessError(
          "Choose one of the authored reasons for this review card.",
          400,
          "invalid_reason",
        );
      }
      const moveCorrect = move.status === "correct";
      const reasonCorrect = choice.isCorrect;
      const grade = gradeReview(moveCorrect, reasonCorrect);
      const schedule = scheduleNextReview(
        old
          ? {
              consecutiveCorrect: old.consecutiveCorrect,
              ease: old.ease,
              intervalDays: old.intervalDays,
              lapses: old.lapses,
            }
          : null,
        grade,
        atDate,
      );
      const nextSchedule = reviewCardScheduleSchema.parse({
        courseId: input.courseId,
        lessonId: input.lessonId,
        stepId: input.stepId,
        dueAt: schedule.dueAt,
        intervalDays: schedule.intervalDays,
        ease: schedule.ease,
        lapses: schedule.lapses,
        consecutiveCorrect: schedule.consecutiveCorrect,
        lastResult: grade,
        updatedAt: at,
      });
      state.reviewCards = [
        ...state.reviewCards.filter(
          (value) =>
            value.courseId !== input.courseId ||
            value.lessonId !== input.lessonId ||
            value.stepId !== input.stepId,
        ),
        nextSchedule,
      ];
      const attempt = reviewAttemptSchema.parse({
        id: input.requestId,
        requestId: input.requestId,
        courseId: input.courseId,
        lessonId: input.lessonId,
        stepId: input.stepId,
        moveUci: input.moveUci,
        reasonChoiceId: input.reasonChoiceId,
        moveCorrect,
        reasonCorrect,
        grade,
        attemptedAt: at,
        dueAt: schedule.dueAt,
      });
      state.reviewAttempts = [...state.reviewAttempts, attempt].slice(-50000);
      const result = mutationResultSchema.parse({
        kind: "review",
        attemptId: attempt.id,
        moveCorrect,
        reasonCorrect,
        grade,
        dueAt: schedule.dueAt,
      });
      const saved = await saveMutation(
        state,
        input.requestId,
        hash,
        result,
        at,
      );
      return mutationReply(saved, result, false);
    });
  }

  async function saveSession(input: z.infer<typeof studySessionRequestSchema>) {
    const hash = requestHash("session", input);
    return exclusive(async () => {
      const state = await read();
      const receipt = existingReceipt(state, input.requestId, hash);
      if (receipt) return mutationReply(state, receipt.result, true);
      assertRevision(state, input.revision);
      if (
        state.reviewAttempts.some(
          (attempt) => attempt.id === input.requestId || attempt.requestId === input.requestId,
        ) ||
        state.studySessions.some(
          (session) => session.id === input.requestId || session.requestId === input.requestId,
        )
      ) {
        throw new ChessError(
          "This request ID is already attached to saved chess activity.",
          409,
          "request_id_conflict",
        );
      }
      let lesson = null;
      if (input.courseId && input.lessonId) {
        lesson = getLesson(input.courseId, input.lessonId);
        if (!lesson) throw new ChessError("Chess lesson not found.", 404, "not_found");
      } else if (input.stepIds.length) {
        throw new ChessError(
          "Choose a lesson when recording studied steps.",
          400,
          "invalid_request",
        );
      }
      const lessonStepIds = new Set(
        lesson ? getTrainerSteps(lesson).map((step) => step.id) : [],
      );
      if (input.stepIds.some((id) => !lessonStepIds.has(id))) {
        throw new ChessError(
          "Study-session steps must belong to the selected lesson.",
          400,
          "invalid_request",
        );
      }
      const attemptIds = new Set(state.reviewAttempts.map((attempt) => attempt.id));
      if (input.reviewAttemptIds.some((id) => !attemptIds.has(id))) {
        throw new ChessError(
          "A linked review attempt could not be found.",
          400,
          "invalid_request",
        );
      }
      const at = now().toISOString();
      const session = studySessionSchema.parse({
        id: input.requestId,
        requestId: input.requestId,
        mode: input.mode,
        courseId: input.courseId,
        lessonId: input.lessonId,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        stepIds: input.stepIds,
        reviewAttemptIds: input.reviewAttemptIds,
        createdAt: at,
      });
      state.studySessions = [...state.studySessions, session].slice(-10000);
      const result = mutationResultSchema.parse({
        kind: "session",
        sessionId: session.id,
      });
      const saved = await saveMutation(
        state,
        input.requestId,
        hash,
        result,
        at,
      );
      return mutationReply(saved, result, false);
    });
  }

  async function body(request: IncomingMessage) {
    if (!request.headers["content-type"]?.startsWith("application/json")) {
      throw new ChessError("JSON is required.", 415, "unsupported_media_type");
    }
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const part of request) {
      const chunk = Buffer.from(part);
      size += chunk.length;
      if (size > 1_000_000) {
        throw new ChessError(
          "Your chess update is too large.",
          413,
          "payload_too_large",
        );
      }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    try {
      const host = request.headers.host ?? "";
      if (
        !/^(localhost|127\.0\.0\.1):\d+$/.test(host) ||
        (request.headers.origin && request.headers.origin !== `http://${host}`) ||
        request.headers["sec-fetch-site"] === "cross-site"
      ) {
        throw new ChessError(
          "Only this local Workspace can access your chess data.",
          403,
          "local_only",
        );
      }
      const pathname = new URL(request.url ?? "/", `http://${host}`).pathname;
      const path = pathname.startsWith("/api/chess")
        ? pathname.slice("/api/chess".length) || "/"
        : pathname || "/";
      if (path === "/" && request.method === "GET") {
        send(response, 200, createChessView(publicState(await read()), now()));
        return;
      }
      if (request.method !== "POST") {
        throw new ChessError("Method not allowed.", 405, "method_not_allowed");
      }
      const input = await body(request);
      if (path === "/progress") {
        send(response, 200, await saveProgress(progressRequestSchema.parse(input)));
        return;
      }
      if (path === "/review") {
        send(response, 200, await saveReview(reviewRequestSchema.parse(input)));
        return;
      }
      if (path === "/session") {
        send(
          response,
          200,
          await saveSession(studySessionRequestSchema.parse(input)),
        );
        return;
      }
      throw new ChessError("Chess route not found.", 404, "not_found");
    } catch (error) {
      const known = error instanceof ChessError;
      const invalid = error instanceof z.ZodError || error instanceof SyntaxError;
      const busy = error instanceof StoreBusyError;
      send(
        response,
        known ? error.status : busy ? 423 : invalid ? 400 : 500,
        {
          code: known
            ? error.code
            : busy
              ? "store_busy"
              : invalid
                ? "invalid_request"
                : "save_failed",
          error: known || busy
            ? error.message
            : error instanceof z.ZodError
              ? error.issues[0]?.message
              : "Your chess update could not be saved. Your existing data has been kept.",
        },
      );
    }
  }

  return { handle };
}

export function chess(): Plugin {
  const service = createChessService(
    process.env.WORKSPACE_DATA_DIR ?? join(homedir(), "Data/personal-workspace"),
  );
  return {
    name: "workspace-chess",
    configureServer(server) {
      server.middlewares.use("/api/chess", service.handle);
    },
  };
}

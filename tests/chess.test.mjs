import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chess } from "chess.js";

import { createChessService } from "../build/chess.ts";
import {
  attemptTrainerMove,
  courses,
  createChessView,
  emptyChessState,
  getAllReviewCards,
  getTrainerMoveSolution,
  getTrainerSteps,
  lessons,
  scheduleNextReview,
  validateChessCatalog,
} from "../lib/chess.ts";

const fixedNow = new Date("2026-09-12T18:00:00.000Z");
const repertoire = [
  {
    courseId: "scotch-game",
    lessonId: "scotch-game-foundations",
    orientation: "white",
    stepIds: [
      "scotch-strike-d4",
      "scotch-recapture-nd4",
      "scotch-schmidt-nxc6",
      "scotch-schmidt-e5",
      "scotch-answer-qe7",
      "scotch-classical-be3",
      "scotch-classical-c3",
    ],
  },
  {
    courseId: "sicilian-defense",
    lessonId: "sicilian-accelerated-dragon",
    orientation: "black",
    stepIds: [
      "sicilian-play-c5",
      "sicilian-develop-nc6",
      "sicilian-exchange-cd4",
      "sicilian-fianchetto-g6",
      "sicilian-develop-bg7",
      "sicilian-develop-nf6",
      "sicilian-break-d5",
    ],
  },
];

function lessonFor(courseId, lessonId) {
  const lesson = lessons.find(
    (candidate) =>
      candidate.courseId === courseId && candidate.id === lessonId,
  );
  assert.ok(lesson, `Missing lesson ${courseId}:${lessonId}`);
  return lesson;
}

function stepFor(courseId, lessonId, stepId) {
  const lesson = lessonFor(courseId, lessonId);
  for (const segment of lesson.segments) {
    if (segment.type !== "trainer") continue;
    const step = segment.steps.find((candidate) => candidate.id === stepId);
    if (step) return { lesson, segment, step };
  }
  assert.fail(`Missing trainer step ${courseId}:${lessonId}:${stepId}`);
}

function solutionFor(step) {
  const solution = getTrainerMoveSolution(step);
  assert.ok(solution, `Trainer step ${step.id} has no legal authored solution`);
  return solution;
}

function choiceFor(step, isCorrect) {
  const choice = step.review.choices.find(
    (candidate) => candidate.isCorrect === isCorrect,
  );
  assert.ok(
    choice,
    `Trainer step ${step.id} needs an ${isCorrect ? "correct" : "incorrect"} review choice`,
  );
  return choice;
}

function reviewRequest(courseId, lessonId, stepId, revision, requestId = randomUUID()) {
  const { step } = stepFor(courseId, lessonId, stepId);
  return {
    revision,
    requestId,
    courseId,
    lessonId,
    stepId,
    moveUci: solutionFor(step).uci,
    reasonChoiceId: choiceFor(step, true).id,
  };
}

function legalIncorrectMove(step) {
  const authored = new Set(step.acceptedMoves.map((move) => move.toLowerCase()));
  const move = new Chess(step.fen)
    .moves({ verbose: true })
    .find((candidate) => {
      const uci = `${candidate.from}${candidate.to}${candidate.promotion ?? ""}`;
      return !authored.has(uci);
    });
  assert.ok(move, `Trainer step ${step.id} needs a legal non-authored move for testing`);
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "workspace-chess-"));
  const service = createChessService(directory, { now: () => fixedNow });
  const server = createServer(service.handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async (headers = {}) => {
    const response = await fetch(`${origin}/api/chess`, { headers });
    return { response, data: await response.json() };
  };
  const post = async (path, body, headers = {}) => {
    const response = await fetch(`${origin}/api/chess${path}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { response, data: await response.json() };
  };
  return {
    directory,
    file: join(directory, "chess.private.json"),
    get,
    post,
    close: async () => {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("Chess catalog and trainer preserve the ordered Scotch and Sicilian repertoire", () => {
  assert.equal(validateChessCatalog(), true);
  assert.deepEqual(
    courses.map((course) => ({ id: course.id, lessonIds: course.lessonIds })),
    repertoire.map(({ courseId, lessonId }) => ({
      id: courseId,
      lessonIds: [lessonId],
    })),
  );
  assert.deepEqual(
    lessons.map((lesson) => ({ courseId: lesson.courseId, id: lesson.id })),
    repertoire.map(({ courseId, lessonId }) => ({ courseId, id: lessonId })),
  );
  assert.equal(getAllReviewCards().length, 14);

  for (const expected of repertoire) {
    const lesson = lessonFor(expected.courseId, expected.lessonId);
    const steps = getTrainerSteps(lesson);
    assert.deepEqual(steps.map((step) => step.id), expected.stepIds);
    assert.equal(steps.length, 7);

    const cards = getAllReviewCards().filter(
      (card) =>
        card.courseId === expected.courseId &&
        card.lessonId === expected.lessonId,
    );
    assert.equal(cards.length, 7);
    assert.ok(
      cards.every((card) => card.boardOrientation === expected.orientation),
      `${expected.lessonId} review cards should face ${expected.orientation}`,
    );

    for (const step of steps) {
      assert.ok(solutionFor(step));
      for (const acceptedMove of step.acceptedMoves) {
        const result = attemptTrainerMove(
          step,
          acceptedMove.slice(0, 2),
          acceptedMove.slice(2, 4),
          acceptedMove.slice(4),
        );
        assert.equal(
          result.status,
          "correct",
          `${step.id} should accept its authored move ${acceptedMove}`,
        );
        assert.equal(
          result.status === "correct" ? result.replies.length : -1,
          step.opponentReplies?.length ?? 0,
          `${step.id} should apply every authored opponent continuation`,
        );
      }
    }
  }

  const first = stepFor(
    repertoire[0].courseId,
    repertoire[0].lessonId,
    repertoire[0].stepIds[0],
  ).step;
  const incorrect = legalIncorrectMove(first);
  assert.equal(
    attemptTrainerMove(
      first,
      incorrect.slice(0, 2),
      incorrect.slice(2, 4),
      incorrect.slice(4),
    ).status,
    "incorrect",
  );
  assert.equal(attemptTrainerMove(first, "a1", "a1", "").status, "illegal");

  const missed = scheduleNextReview(null, "again", fixedNow);
  const recalled = scheduleNextReview(null, "good", fixedNow);
  assert.equal(new Date(missed.dueAt).getTime() - fixedNow.getTime(), 20 * 60 * 1000);
  assert.equal(new Date(recalled.dueAt).getTime() - fixedNow.getTime(), 24 * 60 * 60 * 1000);
});

test("GET derives an unseeded review queue without writing private state", async (t) => {
  const h = await harness();
  t.after(h.close);
  const { response, data } = await h.get();
  assert.equal(response.status, 200);
  assert.deepEqual(data.capability, { canWrite: true, id: "chess", version: 1 });
  assert.equal(data.state.revision, 0);
  assert.equal(data.summary.reviewsDue, 14);
  assert.equal(data.reviewQueue.length, 14);
  assert.deepEqual(
    data.reviewQueue.map((card) => [card.courseId, card.boardOrientation]),
    Array.from({ length: 7 }, () => [
      ["scotch-game", "white"],
      ["sicilian-defense", "black"],
    ]).flat(),
  );
  await assert.rejects(readFile(h.file, "utf8"), { code: "ENOENT" });
});

test("progress writes are revision checked, idempotent, atomic, and catalog bound", async (t) => {
  const h = await harness();
  t.after(h.close);
  const first = stepFor(
    "scotch-game",
    "scotch-game-foundations",
    "scotch-strike-d4",
  );
  const second = stepFor(
    "scotch-game",
    "scotch-game-foundations",
    "scotch-recapture-nd4",
  );
  const request = {
    revision: 0,
    requestId: randomUUID(),
    courseId: first.lesson.courseId,
    lessonId: first.lesson.id,
    currentSegmentId: first.segment.id,
    currentStepId: first.step.id,
    completedStepIds: [first.step.id],
  };
  const saved = await h.post("/progress", request);
  assert.equal(saved.response.status, 200);
  assert.equal(saved.data.replayed, false);
  assert.equal(saved.data.view.state.revision, 1);
  assert.equal(saved.data.view.summary.stepsCovered, 1);
  assert.equal((await stat(h.file)).mode & 0o777, 0o600);

  const replay = await h.post("/progress", request);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.view.state.revision, 1);
  assert.equal(replay.data.view.state.progress.length, 1);

  const reused = await h.post("/progress", { ...request, completedStepIds: [] });
  assert.equal(reused.response.status, 409);
  assert.equal(reused.data.code, "request_id_conflict");

  const stale = await h.post("/progress", { ...request, requestId: randomUUID() });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.data.code, "revision_conflict");

  const unknownStep = await h.post("/progress", {
    ...request,
    revision: 1,
    requestId: randomUUID(),
    completedStepIds: ["invented-step"],
  });
  assert.equal(unknownStep.response.status, 400);
  const after = JSON.parse(await readFile(h.file, "utf8"));
  assert.equal(after.revision, 1);
  assert.equal(after.requests.length, 1);

  const staleCompletionSnapshot = await h.post("/progress", {
    ...request,
    revision: 1,
    requestId: randomUUID(),
    currentSegmentId: second.segment.id,
    currentStepId: second.step.id,
    completedStepIds: [],
  });
  assert.equal(staleCompletionSnapshot.response.status, 200);
  assert.deepEqual(
    staleCompletionSnapshot.data.view.state.progress[0].completedStepIds,
    [first.step.id],
  );
  assert.equal(staleCompletionSnapshot.data.view.state.revision, 2);
});

test("reviews are graded from authored moves and reasons and retries do not reschedule", async (t) => {
  const h = await harness();
  t.after(h.close);
  const requestId = randomUUID();
  const request = reviewRequest(
    "scotch-game",
    "scotch-game-foundations",
    "scotch-strike-d4",
    0,
    requestId,
  );
  const saved = await h.post("/review", request);
  assert.equal(saved.response.status, 200);
  assert.deepEqual(saved.data.result, {
    attemptId: requestId,
    moveCorrect: true,
    reasonCorrect: true,
    grade: "good",
    dueAt: "2026-09-13T18:00:00.000Z",
  });
  assert.equal(saved.data.view.state.reviewAttempts.length, 1);
  assert.equal(saved.data.view.state.reviewCards.length, 1);
  assert.equal(saved.data.view.summary.reviewsDue, 13);

  const replay = await h.post("/review", request);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.data.replayed, true);
  assert.deepEqual(replay.data.result, saved.data.result);
  assert.equal(replay.data.view.state.revision, 1);
  assert.equal(replay.data.view.state.reviewAttempts.length, 1);

  const duplicate = await h.post("/review", {
    ...request,
    revision: 1,
    requestId: randomUUID(),
  });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.data.code, "review_not_due");
  assert.match(duplicate.data.error, /not due again/i);
  assert.equal((await h.get()).data.state.reviewAttempts.length, 1);
  assert.equal((await h.get()).data.state.revision, 1);

  const sicilian = stepFor(
    "sicilian-defense",
    "sicilian-accelerated-dragon",
    "sicilian-play-c5",
  );
  const wrong = await h.post("/review", {
    revision: 1,
    requestId: randomUUID(),
    courseId: sicilian.lesson.courseId,
    lessonId: sicilian.lesson.id,
    stepId: sicilian.step.id,
    moveUci: legalIncorrectMove(sicilian.step),
    reasonChoiceId: choiceFor(sicilian.step, false).id,
  });
  assert.equal(wrong.response.status, 200);
  assert.equal(wrong.data.result.grade, "again");
  assert.equal(wrong.data.result.moveCorrect, false);
  assert.equal(wrong.data.result.reasonCorrect, false);
  assert.equal(wrong.data.result.dueAt, "2026-09-12T18:20:00.000Z");

  const unknownReason = await h.post("/review", {
    ...reviewRequest(
      "scotch-game",
      "scotch-game-foundations",
      "scotch-recapture-nd4",
      2,
    ),
    reasonChoiceId: "made-up-reason",
  });
  assert.equal(unknownReason.response.status, 400);
  assert.equal(unknownReason.data.code, "invalid_reason");

  const illegalMove = await h.post("/review", {
    ...reviewRequest(
      "scotch-game",
      "scotch-game-foundations",
      "scotch-schmidt-nxc6",
      2,
    ),
    moveUci: "a1a1",
  });
  assert.equal(illegalMove.response.status, 400);
  assert.equal(illegalMove.data.code, "invalid_move");
  assert.equal((await h.get()).data.state.revision, 2);
});

test("saved review correctness is verified against the authored position", async (t) => {
  const h = await harness();
  t.after(h.close);
  const authored = stepFor(
    "scotch-game",
    "scotch-game-foundations",
    "scotch-strike-d4",
  );
  await h.post(
    "/review",
    reviewRequest(
      authored.lesson.courseId,
      authored.lesson.id,
      authored.step.id,
      0,
    ),
  );
  const state = JSON.parse(await readFile(h.file, "utf8"));
  state.reviewAttempts[0].reasonChoiceId = choiceFor(authored.step, false).id;
  const corrupted = JSON.stringify(state);
  await writeFile(h.file, corrupted);

  const result = await h.get();
  assert.equal(result.response.status, 500);
  assert.equal(result.data.code, "invalid_state");
  assert.equal(await readFile(h.file, "utf8"), corrupted);
});

test("study sessions link existing review attempts and replay safely", async (t) => {
  const h = await harness();
  t.after(h.close);
  const reviewId = randomUUID();
  const authored = stepFor(
    "scotch-game",
    "scotch-game-foundations",
    "scotch-strike-d4",
  );
  await h.post(
    "/review",
    reviewRequest(
      authored.lesson.courseId,
      authored.lesson.id,
      authored.step.id,
      0,
      reviewId,
    ),
  );
  const sessionId = randomUUID();
  const request = {
    revision: 1,
    requestId: sessionId,
    mode: "mixed",
    courseId: authored.lesson.courseId,
    lessonId: authored.lesson.id,
    startedAt: "2026-09-12T17:30:00.000Z",
    endedAt: "2026-09-12T17:50:00.000Z",
    stepIds: [authored.step.id],
    reviewAttemptIds: [reviewId],
  };
  const saved = await h.post("/session", request);
  assert.equal(saved.response.status, 200);
  assert.equal(saved.data.session.id, sessionId);
  assert.equal(saved.data.view.state.revision, 2);
  assert.equal(saved.data.view.state.studySessions.length, 1);
  const replay = await h.post("/session", request);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.view.state.studySessions.length, 1);

  const missingAttempt = await h.post("/session", {
    ...request,
    revision: 2,
    requestId: randomUUID(),
    reviewAttemptIds: [randomUUID()],
  });
  assert.equal(missingAttempt.response.status, 400);
  assert.equal((await h.get()).data.state.revision, 2);
});

test("malformed private state, cross-origin access, lock contention, and body caps fail closed", async (t) => {
  const h = await harness();
  t.after(h.close);
  await writeFile(h.file, '{"version":1,"revision":9,"progress":[]}');
  const malformed = await h.get();
  assert.equal(malformed.response.status, 500);
  assert.equal(malformed.data.code, "invalid_state");
  assert.equal(await readFile(h.file, "utf8"), '{"version":1,"revision":9,"progress":[]}');

  await rm(h.file);
  const crossOrigin = await h.get({ Origin: "https://example.com" });
  assert.equal(crossOrigin.response.status, 403);
  assert.equal(crossOrigin.data.code, "local_only");

  const firstLesson = lessonFor("scotch-game", "scotch-game-foundations");
  const firstSegment = firstLesson.segments[0];
  await writeFile(`${h.file}.lock`, "busy");
  const busy = await h.post("/progress", {
    revision: 0,
    requestId: randomUUID(),
    courseId: firstLesson.courseId,
    lessonId: firstLesson.id,
    currentSegmentId: firstSegment.id,
    currentStepId: null,
    completedStepIds: [],
  });
  assert.equal(busy.response.status, 423);
  assert.equal(busy.data.code, "store_busy");
  await rm(`${h.file}.lock`);

  const oversized = await h.post("/progress", JSON.stringify({ value: "x".repeat(1_000_001) }));
  assert.equal(oversized.response.status, 413);
  assert.equal(oversized.data.code, "payload_too_large");
  assert.deepEqual(createChessView(emptyChessState, fixedNow).state, emptyChessState);
});

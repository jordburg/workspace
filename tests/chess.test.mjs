import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createChessService } from "../build/chess.ts";
import {
  attemptTrainerMove,
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

test("Chess catalog and trainer preserve the authored Najdorf lesson", () => {
  assert.equal(validateChessCatalog(), true);
  assert.equal(lessons.length, 1);
  assert.equal(getTrainerSteps(lessons[0]).length, 12);
  assert.equal(getAllReviewCards().length, 12);

  const white = getTrainerSteps(lessons[0])[0];
  assert.deepEqual(getTrainerMoveSolution(white), {
    from: "g1",
    san: "Nf3",
    to: "f3",
    uci: "g1f3",
  });
  const correct = attemptTrainerMove(white, "g1", "f3");
  assert.equal(correct.status, "correct");
  assert.equal(correct.status === "correct" ? correct.replySan : null, "d6");
  assert.equal(attemptTrainerMove(white, "b1", "c3").status, "incorrect");
  assert.equal(attemptTrainerMove(white, "a1", "a8").status, "illegal");

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
  assert.equal(data.summary.reviewsDue, 12);
  assert.equal(data.reviewQueue.length, 12);
  await assert.rejects(readFile(h.file, "utf8"), { code: "ENOENT" });
});

test("progress writes are revision checked, idempotent, atomic, and catalog bound", async (t) => {
  const h = await harness();
  t.after(h.close);
  const request = {
    revision: 0,
    requestId: randomUUID(),
    courseId: "sicilian-defense",
    lessonId: "sicilian-najdorf-foundations",
    currentSegmentId: "open-sicilian-sequence",
    currentStepId: "play-nf3",
    completedStepIds: ["play-nf3"],
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
    currentStepId: "play-d4",
    completedStepIds: [],
  });
  assert.equal(staleCompletionSnapshot.response.status, 200);
  assert.deepEqual(
    staleCompletionSnapshot.data.view.state.progress[0].completedStepIds,
    ["play-nf3"],
  );
  assert.equal(staleCompletionSnapshot.data.view.state.revision, 2);
});

test("reviews are graded from authored moves and reasons and retries do not reschedule", async (t) => {
  const h = await harness();
  t.after(h.close);
  const requestId = randomUUID();
  const request = {
    revision: 0,
    requestId,
    courseId: "sicilian-defense",
    lessonId: "sicilian-najdorf-foundations",
    stepId: "play-nf3",
    moveUci: "g1f3",
    reasonChoiceId: "prepare-d4",
  };
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
  assert.equal(saved.data.view.summary.reviewsDue, 11);

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

  const wrong = await h.post("/review", {
    revision: 1,
    requestId: randomUUID(),
    courseId: "sicilian-defense",
    lessonId: "sicilian-najdorf-foundations",
    stepId: "black-play-c5",
    moveUci: "b8c6",
    reasonChoiceId: "copy-white",
  });
  assert.equal(wrong.response.status, 200);
  assert.equal(wrong.data.result.grade, "again");
  assert.equal(wrong.data.result.moveCorrect, false);
  assert.equal(wrong.data.result.reasonCorrect, false);
  assert.equal(wrong.data.result.dueAt, "2026-09-12T18:20:00.000Z");

  const unknownReason = await h.post("/review", {
    ...request,
    revision: 2,
    requestId: randomUUID(),
    stepId: "play-d4",
    moveUci: "d2d4",
    reasonChoiceId: "made-up-reason",
  });
  assert.equal(unknownReason.response.status, 400);
  assert.equal(unknownReason.data.code, "invalid_reason");

  const illegalMove = await h.post("/review", {
    ...request,
    revision: 2,
    requestId: randomUUID(),
    stepId: "recapture-on-d4",
    moveUci: "a1a8",
  });
  assert.equal(illegalMove.response.status, 400);
  assert.equal(illegalMove.data.code, "invalid_move");
  assert.equal((await h.get()).data.state.revision, 2);
});

test("saved review correctness is verified against the authored position", async (t) => {
  const h = await harness();
  t.after(h.close);
  await h.post("/review", {
    revision: 0,
    requestId: randomUUID(),
    courseId: "sicilian-defense",
    lessonId: "sicilian-najdorf-foundations",
    stepId: "play-nf3",
    moveUci: "g1f3",
    reasonChoiceId: "prepare-d4",
  });
  const state = JSON.parse(await readFile(h.file, "utf8"));
  state.reviewAttempts[0].reasonChoiceId = "attack-c5";
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
  await h.post("/review", {
    revision: 0,
    requestId: reviewId,
    courseId: "sicilian-defense",
    lessonId: "sicilian-najdorf-foundations",
    stepId: "play-nf3",
    moveUci: "g1f3",
    reasonChoiceId: "prepare-d4",
  });
  const sessionId = randomUUID();
  const request = {
    revision: 1,
    requestId: sessionId,
    mode: "mixed",
    courseId: "sicilian-defense",
    lessonId: "sicilian-najdorf-foundations",
    startedAt: "2026-09-12T17:30:00.000Z",
    endedAt: "2026-09-12T17:50:00.000Z",
    stepIds: ["play-nf3"],
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

  await writeFile(`${h.file}.lock`, "busy");
  const busy = await h.post("/progress", {
    revision: 0,
    requestId: randomUUID(),
    courseId: "sicilian-defense",
    lessonId: "sicilian-najdorf-foundations",
    currentSegmentId: "why-c5",
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

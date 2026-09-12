import { Chess, type Move } from "chess.js";

import type { Lesson, TrainerStep } from "./types.ts";

const uciPattern = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

export type RevealedTrainerMove = {
  from: string;
  san: string;
  to: string;
  uci: string;
};

export type TrainerReplyMove = RevealedTrainerMove & {
  color: "b" | "w";
  fen: string;
};

export type TrainerMoveResult =
  | {
      fenBefore: string;
      moveUci: string;
      reason: "illegal";
      status: "illegal";
    }
  | {
      fenBefore: string;
      move: Move;
      moveUci: string;
      reason: "not-authored";
      status: "incorrect";
    }
  | {
      fenBefore: string;
      move: Move;
      moveFen: string;
      moveUci: string;
      nextFen: string;
      replies: TrainerReplyMove[];
      replySan?: string;
      status: "correct";
    };

export function toUci(move: Pick<Move, "from" | "promotion" | "to">) {
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

export function isUciMove(value: string) {
  return uciPattern.test(value);
}

export function normalizeUciMove(value: string) {
  return value.trim().toLowerCase();
}

export function isAuthoredMove(step: TrainerStep, value: string) {
  const moveUci = normalizeUciMove(value);
  if (!isUciMove(moveUci)) return false;
  const result = attemptTrainerMove(
    step,
    moveUci.slice(0, 2),
    moveUci.slice(2, 4),
    moveUci.slice(4),
  );
  return result.status === "correct";
}

export function applyUciMove(chess: Chess, uci: string) {
  const move = chess.move({
    from: uci.slice(0, 2),
    promotion: uci.length > 4 ? uci.slice(4, 5) : undefined,
    to: uci.slice(2, 4),
  });

  if (!move) {
    throw new Error(`Could not apply move ${uci}`);
  }

  return move;
}

export function getTrainerMoveSolution(
  step: TrainerStep,
  acceptedMoveIndex = 0,
): RevealedTrainerMove | null {
  const acceptedMove = step.acceptedMoves[acceptedMoveIndex];

  if (!acceptedMove) {
    return null;
  }

  const chess = new Chess(step.fen);
  let move: Move | null = null;

  try {
    if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(acceptedMove)) {
      move = chess.move({
        from: acceptedMove.slice(0, 2),
        promotion:
          acceptedMove.length > 4 ? acceptedMove.slice(4, 5) : undefined,
        to: acceptedMove.slice(2, 4),
      });
    } else {
      move = chess.move(acceptedMove);
    }
  } catch {
    move = null;
  }

  if (!move) {
    return null;
  }

  return {
    from: move.from,
    san: move.san,
    to: move.to,
    uci: toUci(move),
  };
}

export function attemptTrainerMove(
  step: TrainerStep,
  from: string,
  to: string,
  promotion = "q",
): TrainerMoveResult {
  const chess = new Chess(step.fen);
  const fenBefore = chess.fen();
  let move: Move | null = null;

  try {
    move = chess.move({ from, promotion, to });
  } catch {
    move = null;
  }

  const attemptedUci = `${from}${to}${promotion ? promotion : ""}`;

  if (!move) {
    return {
      fenBefore,
      moveUci: attemptedUci,
      reason: "illegal",
      status: "illegal",
    };
  }

  const moveUci = toUci(move);
  const isAuthoredMove =
    step.acceptedMoves.includes(moveUci) || step.acceptedMoves.includes(move.san);

  if (!isAuthoredMove) {
    return {
      fenBefore,
      move,
      moveUci,
      reason: "not-authored",
      status: "incorrect",
    };
  }

  const moveFen = chess.fen();
  const replies: TrainerReplyMove[] = [];
  let replySan: string | undefined;

  for (const reply of step.opponentReplies ?? []) {
    const replyMove = applyUciMove(chess, reply);
    replySan = replyMove.san;
    replies.push({
      color: replyMove.color,
      fen: chess.fen(),
      from: replyMove.from,
      san: replyMove.san,
      to: replyMove.to,
      uci: toUci(replyMove),
    });
  }

  return {
    fenBefore,
    move,
    moveFen,
    moveUci,
    nextFen: chess.fen(),
    replies,
    replySan,
    status: "correct",
  };
}

export function getTrainerSteps(lesson: Pick<Lesson, "segments">) {
  return lesson.segments.flatMap((segment) =>
    segment.type === "trainer" ? segment.steps : [],
  );
}

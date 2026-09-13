import type { Course, Lesson } from "./types.ts";

const scotchCourse: Course = {
  description:
    "Build a focused White repertoire against 1...e5. Learn the Scotch's central break, the safe recapture, and concrete answers to Black's two main fourth-move systems.",
  id: "scotch-game",
  lessonIds: ["scotch-game-foundations"],
  level: "Beginner to intermediate",
  title: "Scotch Game",
};

const scotchLesson: Lesson = {
  courseId: scotchCourse.id,
  id: "scotch-game-foundations",
  initialFen:
    "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
  segments: [
    {
      boardOrientation: "white",
      body: [
        "The Scotch begins 1.e4 e5 2.Nf3 Nc6 3.d4. White resolves the central tension early, opens lines, and accepts that the f3-knight may move twice to recover on d4.",
        "The exercises teach a repertoire choice, not the only legal move. Learn why each move belongs in the position before adding deeper branches.",
      ],
      fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
      id: "scotch-purpose",
      title: "Open the center on your terms",
      type: "theory",
    },
    {
      boardOrientation: "white",
      body: [
        "Build the defining Scotch position. Challenge e5, then recover on d4 without exposing the queen.",
      ],
      id: "enter-the-scotch",
      steps: [
        {
          acceptedMoves: ["d2d4"],
          explanation:
            "3.d4 defines the Scotch. White challenges e5 immediately and opens central lines before Black settles into a quieter setup.",
          fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
          hints: [
            "Challenge Black's e5 pawn with a central pawn.",
            "Advance the pawn that begins on d2.",
          ],
          id: "scotch-strike-d4",
          opponentReplies: ["e5d4"],
          prompt: "Play the move that defines the Scotch.",
          review: {
            choices: [
              {
                id: "challenge-e5",
                isCorrect: true,
                text: "Challenge e5 now and open central lines.",
              },
              {
                id: "keep-center-closed",
                isCorrect: false,
                text: "Keep the center closed and postpone exchanges.",
              },
              {
                id: "attack-f7",
                isCorrect: false,
                text: "Create an immediate attack on f7.",
              },
            ],
            question: "What is White trying to achieve with 3.d4?",
          },
        },
        {
          acceptedMoves: ["f3d4"],
          explanation:
            "4.Nxd4 recovers the pawn safely and centralizes the knight. 4.Qxd4 would lose the queen to the knight on c6.",
          fen: "r1bqkbnr/pppp1ppp/2n5/8/3pP3/5N2/PPP2PPP/RNBQKB1R w KQkq - 0 4",
          hints: [
            "The queen would be vulnerable to the knight on c6.",
            "Use the knight that already developed to f3.",
          ],
          id: "scotch-recapture-nd4",
          prompt: "Recover the pawn without exposing the queen.",
          review: {
            choices: [
              {
                id: "safe-recapture",
                isCorrect: true,
                text: "The knight recaptures safely; Qxd4 would lose the queen to ...Nxd4.",
              },
              {
                id: "force-queen-trade",
                isCorrect: false,
                text: "The knight move forces an immediate queen trade.",
              },
              {
                id: "avoid-knight-move",
                isCorrect: false,
                text: "White wants to avoid moving the same piece twice.",
              },
            ],
            question: "Why should White recapture with the knight?",
          },
        },
      ],
      title: "Enter the Scotch",
      type: "trainer",
    },
    {
      boardOrientation: "white",
      body: [
        "After 4.Nxd4, read Black's move before recalling a sequence. Against 4...Nf6, exchange on c6 and use e5. Against 4...Bc5, count the pressure on d4 and reinforce the knight.",
        "These branches train different problems: the Schmidt line is about an e-pawn advance and pin; the Classical line is about attackers and defenders on d4.",
      ],
      fen: "r1bqkbnr/pppp1ppp/2n5/8/3NP3/8/PPP2PPP/RNBQKB1R b KQkq - 0 4",
      id: "scotch-branch-map",
      title: "Read Black's fourth move",
      type: "diagram",
    },
    {
      boardOrientation: "white",
      body: [
        "In the Schmidt Variation, White uses Nxc6, e5, and Qe2 as one connected idea. Each move makes the next one possible.",
      ],
      id: "scotch-schmidt-line",
      steps: [
        {
          acceptedMoves: ["d4c6"],
          explanation:
            "5.Nxc6 removes the knight that controls e5. After ...bxc6, Black accepts doubled c-pawns and White gains the chance to advance with tempo.",
          fen: "r1bqkb1r/pppp1ppp/2n2n2/8/3NP3/8/PPP2PPP/RNBQKB1R w KQkq - 1 5",
          hints: [
            "White wants to push e5, but one black knight controls that square.",
            "Exchange the d4-knight for the knight on c6.",
          ],
          id: "scotch-schmidt-nxc6",
          opponentReplies: ["b7c6"],
          prompt: "Prepare the e-pawn advance against ...Nf6.",
          review: {
            choices: [
              {
                id: "remove-e5-defender",
                isCorrect: true,
                text: "Remove the c6-knight's control of e5 and create structural imbalance.",
              },
              {
                id: "win-c7",
                isCorrect: false,
                text: "Win Black's c7-pawn immediately.",
              },
              {
                id: "force-long-castle",
                isCorrect: false,
                text: "Force Black to castle queenside.",
              },
            ],
            question: "Why exchange on c6 before pushing e5?",
          },
        },
        {
          acceptedMoves: ["e4e5"],
          explanation:
            "6.e5 gains space and attacks the f6-knight. With the c6-knight gone, Black uses ...Qe7 and a pin rather than simply capturing the pawn.",
          fen: "r1bqkb1r/p1pp1ppp/2p2n2/8/4P3/8/PPP2PPP/RNBQKB1R w KQkq - 0 6",
          hints: [
            "Gain space while attacking the knight on f6.",
            "Advance the e-pawn one square.",
          ],
          id: "scotch-schmidt-e5",
          opponentReplies: ["d8e7"],
          prompt: "Use the missing c6-knight to gain a tempo.",
          review: {
            choices: [
              {
                id: "gain-tempo",
                isCorrect: true,
                text: "Gain space and attack Nf6 after its c6 defender has gone.",
              },
              {
                id: "defend-d4",
                isCorrect: false,
                text: "Defend a white pawn on d4.",
              },
              {
                id: "open-a-file",
                isCorrect: false,
                text: "Open the a-file for White's rook.",
              },
            ],
            question: "What is the point of 6.e5?",
          },
        },
        {
          acceptedMoves: ["d1e2"],
          explanation:
            "7.Qe2 supports e5 and places the queen between Black's queen and White's king. The e5-pawn is no longer pinned, so the f6-knight normally retreats.",
          fen: "r1b1kb1r/p1ppqppp/2p2n2/4P3/8/8/PPP2PPP/RNBQKB1R w KQkq - 1 7",
          hints: [
            "Black's queen is pinning the e5-pawn to the king.",
            "Use White's queen to block that line and support e5.",
          ],
          id: "scotch-answer-qe7",
          opponentReplies: ["f6d5"],
          prompt: "Answer ...Qe7 without surrendering the advanced pawn.",
          review: {
            choices: [
              {
                id: "unpin-e-pawn",
                isCorrect: true,
                text: "Support e5 and break the pin against White's king.",
              },
              {
                id: "trade-queens",
                isCorrect: false,
                text: "Force Black to exchange queens on e2.",
              },
              {
                id: "attack-c6",
                isCorrect: false,
                text: "Attack the pawn on c6 with the queen.",
              },
            ],
            question: "Why is 7.Qe2 the key follow-up to ...Qe7?",
          },
        },
      ],
      title: "Meet 4...Nf6",
      type: "trainer",
    },
    {
      boardOrientation: "white",
      body: [
        "The Classical Variation puts two pieces on the d4-knight. White develops another defender, then reacts accurately when Black adds the queen.",
      ],
      id: "scotch-classical-line",
      steps: [
        {
          acceptedMoves: ["c1e3"],
          explanation:
            "5.Be3 develops the dark-squared bishop and adds a second defender to d4, matching the knight on c6 and bishop on c5.",
          fen: "r1bqk1nr/pppp1ppp/2n5/2b5/3NP3/8/PPP2PPP/RNBQKB1R w KQkq - 1 5",
          hints: [
            "Count the black pieces attacking d4.",
            "Develop the c1-bishop to defend the knight.",
          ],
          id: "scotch-classical-be3",
          opponentReplies: ["d8f6"],
          prompt: "Meet the Classical pressure with development.",
          review: {
            choices: [
              {
                id: "reinforce-d4",
                isCorrect: true,
                text: "Develop the bishop and add another defender to d4.",
              },
              {
                id: "pin-f6",
                isCorrect: false,
                text: "Pin a knight on f6 to Black's king.",
              },
              {
                id: "win-bishop",
                isCorrect: false,
                text: "Force the bishop on c5 to be captured immediately.",
              },
            ],
            question: "What problem does 5.Be3 solve?",
          },
        },
        {
          acceptedMoves: ["c2c3"],
          explanation:
            "5...Qf6 adds a third attacker to d4. 6.c3 gives the knight a third defender and builds a stable base for White's development.",
          fen: "r1b1k1nr/pppp1ppp/2n2q2/2b5/3NP3/4B3/PPP2PPP/RN1QKB1R w KQkq - 3 6",
          hints: [
            "Black's queen has joined the attack on d4.",
            "The c-pawn can add one more defender.",
          ],
          id: "scotch-classical-c3",
          opponentReplies: ["g8e7"],
          prompt: "Match Black's added pressure on d4.",
          review: {
            choices: [
              {
                id: "match-d4-pressure",
                isCorrect: true,
                text: "Give d4 a third defender after ...Qf6 adds a third attacker.",
              },
              {
                id: "chase-queen",
                isCorrect: false,
                text: "Attack the queen on f6 with the c-pawn.",
              },
              {
                id: "castle-long",
                isCorrect: false,
                text: "Prepare to castle queenside on the next move.",
              },
            ],
            question: "Why is 6.c3 necessary in this repertoire line?",
          },
        },
      ],
      title: "Meet 4...Bc5",
      type: "trainer",
    },
    {
      boardOrientation: "white",
      body: [
        "The memorized line should leave you with a plan. Complete development, keep checking the d4 count, and castle before starting an attack.",
        "Against ...Nf6, Nxc6, e5, and Qe2 form one tactical unit. Against ...Bc5, Be3 and c3 form one defensive unit.",
      ],
      fen: "r1b1k2r/ppppnppp/2n2q2/2b5/3NP3/2P1B3/PP3PPP/RN1QKB1R w KQkq - 1 7",
      id: "scotch-recall-map",
      title: "Carry the idea into the middlegame",
      type: "diagram",
    },
  ],
  title: "Scotch Foundations for White",
};

const sicilianCourse: Course = {
  description:
    "Build a concrete Black repertoire against 1.e4 through the Open Sicilian and Accelerated Dragon. Learn the c-pawn exchange, fianchetto structure, and conditions for the freeing ...d5 break.",
  id: "sicilian-defense",
  lessonIds: ["sicilian-accelerated-dragon"],
  level: "Beginner to intermediate",
  title: "Sicilian Defense",
};

const sicilianLesson: Lesson = {
  courseId: sicilianCourse.id,
  id: "sicilian-accelerated-dragon",
  initialFen:
    "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
  segments: [
    {
      boardOrientation: "black",
      body: [
        "The Sicilian begins 1.e4 c5. Black challenges d4 with a flank pawn and creates an asymmetric position from the first move.",
        "This foundation chooses 2...Nc6 and the Accelerated Dragon. It assumes White enters the Open Sicilian with Nf3 and d4; anti-Sicilians belong in later lessons.",
      ],
      fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
      id: "sicilian-purpose",
      title: "Fight for d4 from the flank",
      type: "theory",
    },
    {
      boardOrientation: "black",
      body: [
        "Build the Open Sicilian from Black's side. The key transaction is trading the c-pawn for White's central d-pawn.",
      ],
      id: "sicilian-open-core",
      steps: [
        {
          acceptedMoves: ["c7c5"],
          boardOrientation: "black",
          explanation:
            "1...c5 is the Sicilian move. Black controls d4 with the c-pawn and avoids mirroring White's center with ...e5.",
          fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
          hints: [
            "Challenge d4 with a flank pawn.",
            "Move the pawn from c7 two squares.",
          ],
          id: "sicilian-play-c5",
          opponentReplies: ["g1f3"],
          prompt: "Start the Sicilian Defense.",
          review: {
            choices: [
              {
                id: "challenge-d4",
                isCorrect: true,
                text: "Challenge d4 with a flank pawn and create an imbalance.",
              },
              {
                id: "defend-e5",
                isCorrect: false,
                text: "Defend a black pawn already placed on e5.",
              },
              {
                id: "open-f8-bishop",
                isCorrect: false,
                text: "Open the diagonal of Black's f8-bishop immediately.",
              },
            ],
            question: "What is Black's strategic point with 1...c5?",
          },
        },
        {
          acceptedMoves: ["b8c6"],
          boardOrientation: "black",
          explanation:
            "2...Nc6 develops, controls d4 and e5, and keeps the d7-pawn available for a one-move ...d5 break.",
          fen: "rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
          hints: [
            "Develop the queenside knight toward the center.",
            "Keep the d7-pawn on its starting square.",
          ],
          id: "sicilian-develop-nc6",
          opponentReplies: ["d2d4"],
          prompt: "Choose the move order for the Accelerated Dragon.",
          review: {
            choices: [
              {
                id: "develop-and-stay-flexible",
                isCorrect: true,
                text: "Develop, control d4 and e5, and leave the d-pawn flexible.",
              },
              {
                id: "block-c-pawn",
                isCorrect: false,
                text: "Block the c-pawn before it can capture on d4.",
              },
              {
                id: "commit-d6",
                isCorrect: false,
                text: "Commit Black to playing ...d6 before developing.",
              },
            ],
            question: "Why does this repertoire use 2...Nc6?",
          },
        },
        {
          acceptedMoves: ["c5d4"],
          boardOrientation: "black",
          explanation:
            "3...cxd4 exchanges Black's flank c-pawn for White's central d-pawn. After Nxd4, Black gains a semi-open c-file and an asymmetric pawn structure.",
          fen: "r1bqkbnr/pp1ppppp/2n5/2p5/3PP3/5N2/PPP2PPP/RNBQKB1R b KQkq - 0 3",
          hints: [
            "Do not let White keep both central pawns.",
            "Trade the c-pawn for the d-pawn.",
          ],
          id: "sicilian-exchange-cd4",
          opponentReplies: ["f3d4"],
          prompt: "Answer White's central break.",
          review: {
            choices: [
              {
                id: "trade-flank-for-center",
                isCorrect: true,
                text: "Trade a flank pawn for a central pawn and gain a semi-open c-file.",
              },
              {
                id: "win-pawn",
                isCorrect: false,
                text: "Win the d4-pawn permanently before White can recapture.",
              },
              {
                id: "close-c-file",
                isCorrect: false,
                text: "Close the c-file so neither rook can use it.",
              },
            ],
            question: "Why is ...cxd4 the defining Open Sicilian exchange?",
          },
        },
      ],
      title: "Build the Open Sicilian",
      type: "trainer",
    },
    {
      boardOrientation: "black",
      body: [
        "After 4.Nxd4, 4...g6 defines the Accelerated Dragon. Black develops the bishop to g7, the knight to f6, and castles.",
        "Black has not spent a tempo on ...d6, so ...d5 may be available in one move. It is a conditional break, not an automatic one.",
      ],
      fen: "r1bqkbnr/pp1ppppp/2n5/8/3NP3/8/PPP2PPP/RNBQKB1R b KQkq - 0 4",
      id: "accelerated-dragon-map",
      title: "Keep the d-pawn free",
      type: "diagram",
    },
    {
      boardOrientation: "black",
      body: [
        "Build the fianchetto structure while developing with purpose. Each move should increase pressure on White's center or improve king safety.",
      ],
      id: "accelerated-dragon-setup",
      steps: [
        {
          acceptedMoves: ["g7g6"],
          boardOrientation: "black",
          explanation:
            "4...g6 prepares ...Bg7 and keeps the d7-pawn at home. That preserved tempo is what makes a later one-move ...d5 possible.",
          fen: "r1bqkbnr/pp1ppppp/2n5/8/3NP3/8/PPP2PPP/RNBQKB1R b KQkq - 0 4",
          hints: [
            "Prepare to place the f8-bishop on the long diagonal.",
            "Move the g-pawn without committing the d-pawn.",
          ],
          id: "sicilian-fianchetto-g6",
          opponentReplies: ["b1c3"],
          prompt: "Choose the move that defines the Accelerated Dragon.",
          review: {
            choices: [
              {
                id: "fianchetto-and-save-tempo",
                isCorrect: true,
                text: "Prepare ...Bg7 while preserving a one-move ...d5 break.",
              },
              {
                id: "prepare-e5",
                isCorrect: false,
                text: "Use the g-pawn to defend an immediate ...e5 advance.",
              },
              {
                id: "force-long-castle",
                isCorrect: false,
                text: "Force White to castle queenside.",
              },
            ],
            question: "What distinguishes 4...g6 in the Accelerated Dragon?",
          },
        },
        {
          acceptedMoves: ["f8g7"],
          boardOrientation: "black",
          explanation:
            "5...Bg7 completes the fianchetto, points the bishop toward d4 and b2, and clears the king's path to castle.",
          fen: "r1bqkbnr/pp1ppp1p/2n3p1/8/3NP3/2N5/PPP2PPP/R1BQKB1R b KQkq - 1 5",
          hints: [
            "Put the bishop on the long dark-square diagonal.",
            "Develop the f8-bishop to g7.",
          ],
          id: "sicilian-develop-bg7",
          opponentReplies: ["c1e3"],
          prompt: "Complete the fianchetto.",
          review: {
            choices: [
              {
                id: "long-diagonal",
                isCorrect: true,
                text: "Pressure the center from the long diagonal and prepare to castle.",
              },
              {
                id: "trade-c3",
                isCorrect: false,
                text: "Capture the knight on c3 immediately.",
              },
              {
                id: "defend-c5",
                isCorrect: false,
                text: "Defend Black's pawn on c5.",
              },
            ],
            question: "What job does ...Bg7 perform?",
          },
        },
        {
          acceptedMoves: ["g8f6"],
          boardOrientation: "black",
          explanation:
            "6...Nf6 develops with tempo against e4 and brings Black closer to castling. White must now account for pressure on the center.",
          fen: "r1bqk1nr/pp1pppbp/2n3p1/8/3NP3/2N1B3/PPP2PPP/R2QKB1R b KQkq - 3 6",
          hints: [
            "Develop a knight while attacking e4.",
            "Bring the g8-knight to its natural square.",
          ],
          id: "sicilian-develop-nf6",
          opponentReplies: ["f1e2"],
          prompt: "Develop with tempo against White's center.",
          review: {
            choices: [
              {
                id: "develop-and-hit-e4",
                isCorrect: true,
                text: "Develop the knight while attacking the e4-pawn.",
              },
              {
                id: "protect-c6",
                isCorrect: false,
                text: "Protect the c6-knight from a bishop on b5.",
              },
              {
                id: "stop-castling",
                isCorrect: false,
                text: "Prevent White from castling on either side.",
              },
            ],
            question: "Why is ...Nf6 the natural next move?",
          },
        },
      ],
      title: "Build the Accelerated Dragon",
      type: "trainer",
    },
    {
      boardOrientation: "black",
      body: [
        "After 7.Be2 O-O 8.O-O, White has developed quietly and has not added extra control to d5 with c4 or Bc4. Black should test the center immediately.",
        "Before playing ...d5, check whether White controls the square, whether e4 can capture safely, and whether the resulting exchanges activate your pieces.",
      ],
      fen: "r1bq1rk1/pp1pppbp/2n2np1/8/3NP3/2N1B3/PPP1BPPP/R2Q1RK1 b - - 7 8",
      id: "accelerated-d5-test",
      title: "Know when ...d5 works",
      type: "diagram",
    },
    {
      boardOrientation: "black",
      body: [
        "Use the move that justifies the accelerated move order. This position is chosen so the central break is timely.",
      ],
      id: "accelerated-d5-break",
      steps: [
        {
          acceptedMoves: ["d7d5"],
          boardOrientation: "black",
          explanation:
            "8...d5 is the freeing Accelerated Dragon break. Black challenges e4 in one move and opens lines before White can restrain the center.",
          fen: "r1bq1rk1/pp1pppbp/2n2np1/8/3NP3/2N1B3/PPP1BPPP/R2Q1RK1 b - - 7 8",
          hints: [
            "The d-pawn can reach the center in one turn.",
            "Challenge White's e4-pawn immediately.",
          ],
          id: "sicilian-break-d5",
          opponentReplies: ["e4d5"],
          prompt: "Play the freeing break while the position allows it.",
          review: {
            choices: [
              {
                id: "free-center",
                isCorrect: true,
                text: "Challenge White's center in one move before it can be restrained.",
              },
              {
                id: "protect-c5",
                isCorrect: false,
                text: "Protect Black's pawn on c5.",
              },
              {
                id: "kingside-storm",
                isCorrect: false,
                text: "Begin a kingside pawn storm against White's castled king.",
              },
            ],
            question: "Why is ...d5 the central Accelerated Dragon idea here?",
          },
        },
      ],
      title: "Use the freeing break",
      type: "trainer",
    },
    {
      boardOrientation: "black",
      body: [
        "White's critical 5.c4 creates the Maroczy Bind and clamps d5. Do not force the break just because it appeared in the previous exercise.",
        "Against the bind, continue with ...Bg7, ...Nf6, ...O-O, and often ...d6. Prepare ...d5 or ...b5 only when the position supports it. White's 7.Bc4 also changes the timing of ...d5.",
      ],
      fen: "r1bqkbnr/pp1ppp1p/2n3p1/8/2PNP3/8/PP3PPP/RNBQKB1R b KQkq - 0 5",
      id: "maroczy-exception",
      title: "The break has conditions",
      type: "diagram",
    },
  ],
  title: "Accelerated Dragon Foundations",
};

export const courses = [scotchCourse, sicilianCourse] satisfies Course[];
export const lessons = [scotchLesson, sicilianLesson] satisfies Lesson[];

export function getCourse(courseId: string) {
  return courses.find((course) => course.id === courseId) ?? null;
}

export function getLesson(courseId: string, lessonId: string) {
  return (
    lessons.find(
      (lesson) => lesson.courseId === courseId && lesson.id === lessonId,
    ) ?? null
  );
}

export function getCourseLessons(courseId: string) {
  return lessons.filter((lesson) => lesson.courseId === courseId);
}

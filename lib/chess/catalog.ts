import type { Course, Lesson } from "./types.ts";

const sicilianCourse: Course = {
  description:
    "Build a practical first map of the Sicilian from both seats: how White claims the center, why Black chooses ...c5, and what the Najdorf structure is trying to achieve.",
  id: "sicilian-defense",
  lessonIds: ["sicilian-najdorf-foundations"],
  level: "Club improver",
  title: "Sicilian Defense",
};

const sicilianLesson: Lesson = {
  courseId: sicilianCourse.id,
  id: "sicilian-najdorf-foundations",
  initialFen:
    "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
  segments: [
    {
      body: [
        "After 1.e4 c5, Black avoids symmetry. White owns more central space, while Black immediately challenges d4 from the flank.",
        "This lesson trains the same opening from both sides. As White, you learn how to open the center and keep development smooth. As Black, you learn which moves create the Najdorf structure and what each move is buying.",
      ],
      fen: "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
      id: "why-c5",
      title: "Why ...c5 changes the game",
      type: "theory",
    },
    {
      body: [
        "The standard open Sicilian setup starts by developing the kingside knight. This supports d4 and keeps options open for the dark-square bishop.",
        "Your white-side goal is simple: develop, open the center, recapture actively, then choose a setup after Black's ...a6.",
      ],
      id: "open-sicilian-sequence",
      steps: [
        {
          acceptedMoves: ["g1f3"],
          explanation:
            "Nf3 develops with tempo on the center. It prepares d4 and avoids committing the c-pawn too early.",
          fen: "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
          hints: [
            "Develop a kingside piece before opening the center.",
            "The knight move should make d4 easier to play.",
          ],
          id: "play-nf3",
          opponentReplies: ["d7d6"],
          prompt: "Find White's most flexible developing move.",
          review: {
            choices: [
              {
                id: "prepare-d4",
                isCorrect: true,
                text: "It develops and prepares White's d4 break.",
              },
              {
                id: "attack-c5",
                isCorrect: false,
                text: "It attacks the c5 pawn directly.",
              },
              {
                id: "force-queen-trade",
                isCorrect: false,
                text: "It forces Black to trade queens.",
              },
            ],
            question: "Why is Nf3 the natural first developing move?",
          },
        },
        {
          acceptedMoves: ["d2d4"],
          explanation:
            "d4 is the defining open Sicilian break. White trades a center pawn for activity and open lines.",
          fen: "rnbqkbnr/pp2pppp/3p4/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3",
          hints: [
            "White should challenge Black's c-pawn directly.",
            "Open the position while your knight is ready to recapture.",
          ],
          id: "play-d4",
          opponentReplies: ["c5d4"],
          prompt: "Open the center in classic Sicilian fashion.",
          review: {
            choices: [
              {
                id: "open-center",
                isCorrect: true,
                text: "It challenges Black's c-pawn and opens central lines.",
              },
              {
                id: "save-e-pawn",
                isCorrect: false,
                text: "It moves the e-pawn out of danger.",
              },
              {
                id: "attack-king",
                isCorrect: false,
                text: "It immediately attacks Black's king.",
              },
            ],
            question: "What is White trying to achieve with d4?",
          },
        },
        {
          acceptedMoves: ["f3d4"],
          explanation:
            "Nxd4 centralizes the knight and gives White active piece play. Black will usually attack it with ...Nf6 and ...a6 in Najdorf structures.",
          fen: "rnbqkbnr/pp2pppp/3p4/8/3pP3/5N2/PPP2PPP/RNBQKB1R w KQkq - 0 4",
          hints: [
            "Recapture with a piece, not the queen.",
            "The knight belongs on the central outpost.",
          ],
          id: "recapture-on-d4",
          opponentReplies: ["g8f6"],
          prompt: "Recapture on d4 with the right piece.",
          review: {
            choices: [
              {
                id: "active-knight",
                isCorrect: true,
                text: "White centralizes a knight and keeps piece activity.",
              },
              {
                id: "queen-out",
                isCorrect: false,
                text: "White wants to bring the queen out early.",
              },
              {
                id: "avoid-castling",
                isCorrect: false,
                text: "White wants to prevent either side from castling.",
              },
            ],
            question: "Why recapture on d4 with the knight?",
          },
        },
        {
          acceptedMoves: ["b1c3"],
          explanation:
            "Nc3 defends e4 and reinforces d5 control. After ...a6, you have reached the basic Najdorf tabiya.",
          fen: "rnbqkb1r/pp2pppp/3p1n2/8/3NP3/8/PPP2PPP/RNBQKB1R w KQkq - 1 5",
          hints: [
            "Defend the e4 pawn with development.",
            "Bring the queenside knight toward the center.",
          ],
          id: "play-nc3",
          opponentReplies: ["a7a6"],
          prompt: "Stabilize the center before Black starts queenside play.",
          review: {
            choices: [
              {
                id: "defend-e4",
                isCorrect: true,
                text: "It defends e4 and increases control of d5.",
              },
              {
                id: "trap-rook",
                isCorrect: false,
                text: "It traps Black's rook on a8.",
              },
              {
                id: "force-capture",
                isCorrect: false,
                text: "It forces Black to capture on c3.",
              },
            ],
            question: "What job does Nc3 do in the open Sicilian?",
          },
        },
        {
          acceptedMoves: ["c1e3"],
          explanation:
            "Be3 is a flexible Najdorf setup. It develops, prepares Qd2, and often points toward long castling or kingside pressure.",
          fen: "rnbqkb1r/1p2pppp/p2p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6",
          hints: [
            "Develop the dark-square bishop before deciding where the king belongs.",
            "This bishop move supports Qd2 and keeps the English Attack in view.",
          ],
          id: "play-be3",
          opponentReplies: ["e7e5"],
          prompt: "Choose a principled development move against the Najdorf.",
          review: {
            choices: [
              {
                id: "english-attack",
                isCorrect: true,
                text: "It develops and supports Qd2/long-castling setups.",
              },
              {
                id: "win-a6",
                isCorrect: false,
                text: "It directly wins Black's a6 pawn.",
              },
              {
                id: "block-c-pawn",
                isCorrect: false,
                text: "It blocks White's c-pawn to stop all queenside play.",
              },
            ],
            question: "Why is Be3 a common Najdorf setup move?",
          },
        },
        {
          acceptedMoves: ["d4b3"],
          explanation:
            "Nb3 keeps the knight out of Black's tempo hits and preserves control of d4 and a5. White accepts that Black has gained space, then plays around the d5 square.",
          fen: "rnbqkb1r/1p3ppp/p2p1n2/4p3/3NP3/2N1B3/PPP2PPP/R2QKB1R w KQkq - 0 7",
          hints: [
            "Black's ...e5 attacks the knight on d4.",
            "Retreat to a square that keeps the knight useful and does not block the c-pawn.",
          ],
          id: "retreat-nb3",
          prompt: "Respond to ...e5 without giving up the central knight.",
          review: {
            choices: [
              {
                id: "keep-knight-useful",
                isCorrect: true,
                text: "It preserves the knight while keeping central influence.",
              },
              {
                id: "offer-knight",
                isCorrect: false,
                text: "It intentionally sacrifices the knight for two pawns.",
              },
              {
                id: "force-mate",
                isCorrect: false,
                text: "It creates an immediate mating threat.",
              },
            ],
            question: "Why retreat the knight to b3 after ...e5?",
          },
        },
      ],
      title: "Play the white side",
      type: "trainer",
    },
    {
      body: [
        "Now flip the board. Black's Sicilian is not just a list of defensive moves. Black challenges d4, trades a flank pawn for a center pawn, develops with tempo, and uses ...a6 to control b5.",
        "The Najdorf move order is a sequence of small questions: can White build the center, can Black make that center move, and when does Black get queenside counterplay?",
      ],
      boardOrientation: "black",
      fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
      id: "black-side-map",
      title: "What Black is buying",
      type: "theory",
    },
    {
      boardOrientation: "black",
      body: [
        "Play the Najdorf skeleton from Black's side. The goal is not to parrot moves; it is to feel why each move is timed where it is.",
      ],
      id: "black-najdorf-sequence",
      steps: [
        {
          acceptedMoves: ["c7c5"],
          boardOrientation: "black",
          explanation:
            "...c5 is the Sicilian move. Black challenges d4 immediately and avoids matching White's e-pawn with ...e5.",
          fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
          hints: [
            "Challenge the center from the flank.",
            "Do not mirror White with ...e5 in this opening.",
          ],
          id: "black-play-c5",
          opponentReplies: ["g1f3"],
          prompt: "Start the Sicilian from Black's side.",
          review: {
            choices: [
              {
                id: "flank-challenge",
                isCorrect: true,
                text: "Black challenges White's center from the flank.",
              },
              {
                id: "copy-white",
                isCorrect: false,
                text: "Black copies White's e-pawn structure.",
              },
              {
                id: "open-king",
                isCorrect: false,
                text: "Black opens the king to castle long immediately.",
              },
            ],
            question: "What is the point of 1...c5?",
          },
        },
        {
          acceptedMoves: ["d7d6"],
          boardOrientation: "black",
          explanation:
            "...d6 supports the e5 square, opens the c8 bishop's diagonal later, and keeps the Najdorf/Scheveningen family available.",
          fen: "rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
          hints: [
            "Prepare a flexible Sicilian structure before White opens the center.",
            "This pawn move supports a later ...Nf6 without allowing e5 to fall apart.",
          ],
          id: "black-play-d6",
          opponentReplies: ["d2d4"],
          prompt: "Choose the flexible Najdorf-family pawn move.",
          review: {
            choices: [
              {
                id: "support-e5",
                isCorrect: true,
                text: "It supports flexible Sicilian development and a later ...e5.",
              },
              {
                id: "win-knight",
                isCorrect: false,
                text: "It immediately wins White's knight on f3.",
              },
              {
                id: "block-bishop",
                isCorrect: false,
                text: "It permanently traps Black's dark-square bishop.",
              },
            ],
            question: "Why does Black often play ...d6 here?",
          },
        },
        {
          acceptedMoves: ["c5d4"],
          boardOrientation: "black",
          explanation:
            "...cxd4 removes White's center pawn. Black is happy to trade the c-pawn for White's d-pawn because the resulting open c-file and central imbalance are the Sicilian's oxygen.",
          fen: "rnbqkbnr/pp2pppp/3p4/2p5/3PP3/5N2/PPP2PPP/RNBQKB1R b KQkq - 0 3",
          hints: [
            "White just offered the d-pawn.",
            "Black should not leave White with two central pawns.",
          ],
          id: "black-captures-d4",
          opponentReplies: ["f3d4"],
          prompt: "Answer White's central break correctly.",
          review: {
            choices: [
              {
                id: "trade-flank-center",
                isCorrect: true,
                text: "Black trades the c-pawn for White's central d-pawn.",
              },
              {
                id: "avoid-development",
                isCorrect: false,
                text: "Black avoids developing pieces for the rest of the opening.",
              },
              {
                id: "queen-check",
                isCorrect: false,
                text: "Black creates a forced queen check on h4.",
              },
            ],
            question: "Why is ...cxd4 central to the open Sicilian?",
          },
        },
        {
          acceptedMoves: ["g8f6"],
          boardOrientation: "black",
          explanation:
            "...Nf6 develops with tempo against e4. Black makes White defend the center while preparing normal kingside development.",
          fen: "rnbqkbnr/pp2pppp/3p4/8/3NP3/8/PPP2PPP/RNBQKB1R b KQkq - 0 4",
          hints: [
            "Develop a knight and ask White how e4 will be defended.",
            "The move should attack the e4 pawn.",
          ],
          id: "black-play-nf6",
          opponentReplies: ["b1c3"],
          prompt: "Develop with tempo against White's center.",
          review: {
            choices: [
              {
                id: "hit-e4",
                isCorrect: true,
                text: "It develops while attacking the e4 pawn.",
              },
              {
                id: "attack-rook",
                isCorrect: false,
                text: "It attacks White's rook on h1.",
              },
              {
                id: "force-draw",
                isCorrect: false,
                text: "It forces an immediate repetition.",
              },
            ],
            question: "Why is ...Nf6 a tempo-gaining developing move?",
          },
        },
        {
          acceptedMoves: ["a7a6"],
          boardOrientation: "black",
          explanation:
            "...a6 is the Najdorf signature. It controls b5, prepares ...b5, and prevents White pieces from landing on b5 with annoying tempo.",
          fen: "rnbqkb1r/pp2pppp/3p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R b KQkq - 2 5",
          hints: [
            "Control b5 before White uses it.",
            "Prepare queenside expansion without committing the e-pawn yet.",
          ],
          id: "black-play-a6",
          opponentReplies: ["c1e3"],
          prompt: "Play the move that makes this a Najdorf.",
          review: {
            choices: [
              {
                id: "control-b5",
                isCorrect: true,
                text: "It controls b5 and prepares queenside expansion.",
              },
              {
                id: "attack-e4",
                isCorrect: false,
                text: "It directly attacks the e4 pawn.",
              },
              {
                id: "castle",
                isCorrect: false,
                text: "It allows Black to castle through the queenside.",
              },
            ],
            question: "What does the Najdorf move ...a6 accomplish?",
          },
        },
        {
          acceptedMoves: ["e7e5"],
          boardOrientation: "black",
          explanation:
            "...e5 grabs central space and hits the knight on d4. In many Najdorf lines, Black uses this tempo to clarify White's piece placement before expanding on the queenside.",
          fen: "rnbqkb1r/1p2pppp/p2p1n2/8/3NP3/2N1B3/PPP2PPP/R2QKB1R b KQkq - 1 6",
          hints: [
            "White's bishop move no longer pins or pressures f6.",
            "Gain space while attacking the centralized knight.",
          ],
          id: "black-play-e5",
          opponentReplies: ["d4b3"],
          prompt: "Use the moment to gain space and question White's knight.",
          review: {
            choices: [
              {
                id: "space-tempo",
                isCorrect: true,
                text: "It gains central space while attacking the d4 knight.",
              },
              {
                id: "sac-queen",
                isCorrect: false,
                text: "It sacrifices the queen for long-term compensation.",
              },
              {
                id: "open-c-file",
                isCorrect: false,
                text: "It opens the c-file by itself.",
              },
            ],
            question: "Why can ...e5 be attractive after Be3?",
          },
        },
      ],
      title: "Play the black side",
      type: "trainer",
    },
    {
      body: [
        "From White's side, remember the rhythm: Nf3, d4, Nxd4, Nc3, then choose a setup. From Black's side, remember the counter-rhythm: ...c5, ...d6, ...cxd4, ...Nf6, ...a6, and sometimes ...e5.",
        "Good Sicilian players do not memorize the branches first. They learn what each side is trying to make uncomfortable for the other.",
      ],
      fen: "rnbqkb1r/1p2pppp/p2p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6",
      id: "najdorf-map",
      title: "The Najdorf map",
      type: "diagram",
    },
  ],
  title: "Najdorf Foundations",
};

export const courses = [sicilianCourse] satisfies Course[];
export const lessons = [sicilianLesson] satisfies Lesson[];

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

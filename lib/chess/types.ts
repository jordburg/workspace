export type BoardOrientation = "black" | "white";

export type Course = {
  description: string;
  id: string;
  lessonIds: string[];
  level: string;
  title: string;
};

export type Lesson = {
  courseId: string;
  id: string;
  initialFen: string;
  segments: LessonSegment[];
  title: string;
};

export type LessonSegment = DiagramSegment | TheorySegment | TrainerSegment;

export type TheorySegment = {
  body: string[];
  boardOrientation?: BoardOrientation;
  fen?: string;
  id: string;
  title: string;
  type: "theory";
};

export type DiagramSegment = {
  body: string[];
  boardOrientation?: BoardOrientation;
  fen: string;
  id: string;
  title: string;
  type: "diagram";
};

export type TrainerSegment = {
  boardOrientation?: BoardOrientation;
  body: string[];
  id: string;
  steps: TrainerStep[];
  title: string;
  type: "trainer";
};

export type TrainerStep = {
  acceptedMoves: string[];
  boardOrientation?: BoardOrientation;
  explanation: string;
  fen: string;
  hints: string[];
  id: string;
  opponentReplies?: string[];
  prompt: string;
  review: ReviewPrompt;
};

export type ReviewChoice = {
  id: string;
  isCorrect: boolean;
  text: string;
};

export type ReviewPrompt = {
  choices: ReviewChoice[];
  question: string;
};

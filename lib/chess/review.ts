import { courses, getLesson, lessons } from "./catalog.ts";
import type {
  BoardOrientation,
  Course,
  Lesson,
  ReviewChoice,
  TrainerStep,
} from "./types.ts";

export type ReviewCard = {
  boardOrientation: BoardOrientation;
  choices: ReviewChoice[];
  courseId: string;
  courseTitle: string;
  fen: string;
  id: string;
  lessonId: string;
  lessonTitle: string;
  prompt: string;
  question: string;
  step: TrainerStep;
  stepId: string;
};

export type ReviewGrade = "again" | "easy" | "good";

export type ReviewScheduleInput = {
  consecutiveCorrect: number;
  ease: number;
  intervalDays: number;
  lapses: number;
};

export type ReviewSchedule = ReviewScheduleInput & {
  dueAt: string;
  grade: ReviewGrade;
};

export function getAllReviewCards() {
  return lessons.flatMap((lesson) => {
    const course = courses.find((item) => item.id === lesson.courseId);
    return course ? getLessonReviewCards(course, lesson) : [];
  });
}

export function getLessonReviewCards(course: Course, lesson: Lesson) {
  return lesson.segments.flatMap((segment) =>
    segment.type === "trainer"
      ? segment.steps.map((step) => ({
          boardOrientation:
            step.boardOrientation ?? segment.boardOrientation ?? "white",
          choices: step.review.choices,
          courseId: course.id,
          courseTitle: course.title,
          fen: step.fen,
          id: getReviewCardId(course.id, lesson.id, step.id),
          lessonId: lesson.id,
          lessonTitle: lesson.title,
          prompt: step.prompt,
          question: step.review.question,
          step,
          stepId: step.id,
        }))
      : [],
  );
}

export function getReviewCard(
  courseId: string,
  lessonId: string,
  stepId: string,
) {
  const course = courses.find((item) => item.id === courseId);
  const lesson = getLesson(courseId, lessonId);
  if (!course || !lesson) return null;
  return (
    getLessonReviewCards(course, lesson).find((card) => card.stepId === stepId) ??
    null
  );
}

export function getReviewCardId(
  courseId: string,
  lessonId: string,
  stepId: string,
) {
  return `${courseId}:${lessonId}:${stepId}`;
}

export function interleaveReviewCards(cards: ReviewCard[]) {
  const white = cards.filter((card) => card.boardOrientation === "white");
  const black = cards.filter((card) => card.boardOrientation === "black");
  const mixed: ReviewCard[] = [];
  const length = Math.max(white.length, black.length);
  for (let index = 0; index < length; index += 1) {
    if (white[index]) mixed.push(white[index]);
    if (black[index]) mixed.push(black[index]);
  }
  return mixed;
}

export function gradeReview(moveCorrect: boolean, reasonCorrect: boolean) {
  return moveCorrect && reasonCorrect
    ? ("good" satisfies ReviewGrade)
    : ("again" satisfies ReviewGrade);
}

export function scheduleNextReview(
  previous: ReviewScheduleInput | null,
  grade: ReviewGrade,
  now = new Date(),
): ReviewSchedule {
  const current = previous ?? {
    consecutiveCorrect: 0,
    ease: 2.3,
    intervalDays: 0,
    lapses: 0,
  };
  if (grade === "again") {
    return {
      consecutiveCorrect: 0,
      dueAt: new Date(now.getTime() + 20 * 60 * 1000).toISOString(),
      ease: Math.max(1.3, current.ease - 0.2),
      grade,
      intervalDays: 0,
      lapses: current.lapses + 1,
    };
  }
  const consecutiveCorrect = current.consecutiveCorrect + 1;
  const ease = grade === "easy" ? current.ease + 0.15 : current.ease;
  const firstInterval = grade === "easy" ? 3 : 1;
  const intervalDays =
    current.intervalDays === 0
      ? firstInterval
      : Math.max(1, Math.ceil(current.intervalDays * ease));
  return {
    consecutiveCorrect,
    dueAt: new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000).toISOString(),
    ease,
    grade,
    intervalDays,
    lapses: current.lapses,
  };
}

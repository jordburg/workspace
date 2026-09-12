import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClimbingService } from '../build/climbing.ts';
import {
  climbSchema,
  climbingGoalSchema,
  climbingPlanSchema,
  climbingSessionSchema,
  climbingStateSchema,
  consistencyProgress,
  emptyClimbing,
  routineSnapshot,
} from '../lib/climbing.ts';

const at = '2026-09-11T20:00:00.000Z';

function routine(overrides = {}) {
  return {
    id: randomUUID(),
    title: 'Limit bouldering',
    focus: 'power',
    description: 'Full rests and high-quality attempts.',
    estimatedMinutes: 60,
    steps: [{ id: randomUUID(), name: 'Warm up', prescription: 'Climb six easy problems', rest: 'As needed', notes: '' }],
    version: 1,
    archived: false,
    updatedAt: at,
    ...overrides,
  };
}

function climb(overrides = {}) {
  return {
    id: randomUUID(),
    name: 'Blue corner',
    discipline: 'boulder',
    ropeStyle: null,
    gradeSystem: 'gym',
    grade: 'Blue / V5-ish +',
    outcome: 'send',
    attempts: 3,
    notes: '',
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    id: randomUUID(),
    date: '2026-09-11',
    environment: 'indoor',
    venue: 'The Circuit',
    focus: 'bouldering',
    durationMinutes: 90,
    effort: 7,
    readiness: 'steady',
    notes: 'Good movement day.',
    climbs: [climb()],
    routine: null,
    deletedAt: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function consistencyGoal(overrides = {}) {
  return {
    id: randomUUID(),
    title: 'Climb twice a week',
    kind: 'consistency',
    description: '',
    status: 'active',
    archivedAt: null,
    progress: 0,
    nextStep: 'Book the next session',
    startDate: '2026-09-01',
    targetDate: '2026-09-30',
    sessionTarget: 8,
    venue: null,
    gradeSystem: null,
    grade: null,
    routineId: null,
    updatedAt: at,
    ...overrides,
  };
}

function climbingPlan(overrides = {}) {
  return {
    id: randomUUID(),
    title: 'Friday limit session',
    date: '2026-09-18',
    startTime: null,
    endDate: null,
    endTime: null,
    environment: 'indoor',
    venue: '',
    focus: 'training',
    goalId: null,
    routine: null,
    status: 'planned',
    sessionId: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function state(overrides = {}) {
  return { version: 1, revision: 0, sessions: [], goals: [], routines: [], plans: [], ...overrides };
}

test('Climbing schemas preserve entered grades and enforce climb, goal, and identity invariants', () => {
  const entered = climb();
  assert.equal(climbSchema.parse(entered).grade, 'Blue / V5-ish +');
  assert.equal(climbSchema.safeParse({ ...entered, gradeSystem: null }).success, false);
  assert.equal(climbSchema.safeParse({ ...entered, grade: null }).success, false);
  assert.equal(climbSchema.safeParse({ ...entered, grade: '   ' }).success, false);
  assert.equal(climbSchema.safeParse({ ...entered, ropeStyle: 'auto-belay' }).success, false);
  assert.equal(climbSchema.safeParse({ ...entered, gradeSystem: 'yds', grade: '5.10a' }).success, false);
  assert.equal(climbSchema.safeParse({ ...entered, outcome: 'flash', attempts: 2 }).success, false);
  assert.equal(climbSchema.safeParse({ ...entered, outcome: 'onsight', attempts: 1 }).success, false);
  assert.equal(climbSchema.safeParse({ ...entered, attempts: null }).success, true);
  assert.equal(climbSchema.safeParse({ ...entered, discipline: 'route', ropeStyle: null, gradeSystem: 'yds', grade: '5.10a/b' }).success, false);
  assert.equal(climbSchema.safeParse({ ...entered, discipline: 'route', ropeStyle: 'sport-lead', gradeSystem: 'v-scale', grade: 'V5' }).success, false);
  assert.equal(climbSchema.safeParse({ ...entered, discipline: 'route', ropeStyle: 'sport-lead', gradeSystem: 'yds', grade: '5.10a/b', outcome: 'onsight', attempts: 1 }).success, true);
  assert.equal(climbSchema.parse({ ...entered, discipline: 'route', ropeStyle: 'sport-lead', gradeSystem: 'yds', grade: '5.10a/b' }).grade, '5.10a/b');

  const goal = consistencyGoal();
  assert.equal(climbingGoalSchema.safeParse({ ...goal, sessionTarget: null }).success, false);
  assert.equal(climbingGoalSchema.safeParse({ ...goal, targetDate: '2026-08-31' }).success, false);
  assert.equal(climbingGoalSchema.safeParse({ ...goal, startDate: '2026-02-30' }).success, false);
  assert.equal(climbingGoalSchema.safeParse({ ...goal, kind: 'project', sessionTarget: null, gradeSystem: 'yds', grade: null }).success, false);
  assert.equal(climbingGoalSchema.safeParse({ ...goal, kind: 'project', sessionTarget: null, gradeSystem: 'yds', grade: '   ' }).success, false);
  assert.equal(climbingGoalSchema.safeParse({ ...goal, kind: 'project', startDate: null, targetDate: null, sessionTarget: null }).success, true);
  assert.equal(climbingGoalSchema.safeParse({ ...goal, status: 'archived' }).success, false);
  assert.equal(climbingGoalSchema.safeParse({ ...goal, status: 'paused', archivedAt: at }).success, true);

  const logged = session();
  assert.equal(climbingSessionSchema.safeParse({ ...logged, climbs: [logged.climbs[0], logged.climbs[0]] }).success, false);
  assert.equal(climbingStateSchema.safeParse(state({ sessions: [logged, logged] })).success, false);
  assert.equal(climbingStateSchema.safeParse(state({ goals: [goal, goal] })).success, false);
  const plan = routine();
  assert.equal(climbingStateSchema.safeParse(state({ routines: [plan, plan] })).success, false);
  assert.equal(climbingStateSchema.safeParse(state({ goals: [{ ...goal, routineId: randomUUID() }] })).success, false);
  assert.equal(climbingStateSchema.safeParse(state({ goals: [{ ...goal, routineId: plan.id }], routines: [plan] })).success, true);
  const workoutId=randomUUID();
  assert.equal(climbingStateSchema.safeParse(state({sessions:[session({healthWorkoutId:workoutId}),session({healthWorkoutId:workoutId.toUpperCase()})]})).success,false);
});

test('Climbing plans validate schedules, status transitions, and untouched routine snapshots', () => {
  const plannedRoutine = routineSnapshot(routine());
  const timed = climbingPlan({
    startTime: '18:00',
    endDate: '2026-09-18',
    endTime: '19:30',
    routine: plannedRoutine,
  });
  const parsed = climbingPlanSchema.parse(timed);
  assert.equal(parsed.venue, '', 'a venue may remain TBD');
  assert.equal(parsed.routine.steps[0].status, 'not-logged');
  assert.equal(climbingPlanSchema.safeParse({ ...timed, startTime: '18:00', endDate: null, endTime: null }).success, false);
  assert.equal(climbingPlanSchema.safeParse({ ...timed, startTime: null }).success, false);
  assert.equal(climbingPlanSchema.safeParse({ ...timed, endTime: '18:00' }).success, false);
  assert.equal(climbingPlanSchema.safeParse({ ...timed, endDate: '2026-09-17', endTime: '23:00' }).success, false);
  assert.equal(climbingPlanSchema.safeParse({ ...timed, endDate: '2026-09-19', endTime: '00:30' }).success, true, 'overnight plans may end the next day');
  assert.equal(climbingPlanSchema.safeParse({ ...timed, status: 'logged', sessionId: null }).success, false);
  assert.equal(climbingPlanSchema.safeParse({ ...timed, status: 'planned', sessionId: randomUUID() }).success, false);
  assert.equal(climbingPlanSchema.safeParse({
    ...timed,
    routine: { ...plannedRoutine, steps: [{ ...plannedRoutine.steps[0], status: 'done', result: 'Six climbs' }] },
  }).success, false, 'results belong to the eventual session rather than the plan snapshot');
  assert.equal(climbingPlanSchema.safeParse({
    ...timed,
    routine: { ...plannedRoutine, steps: [plannedRoutine.steps[0], plannedRoutine.steps[0]] },
  }).success, false, 'planned routine step IDs remain unique');
});

test('Legacy v1 state gains an empty plan collection and future plans never count as sessions', () => {
  const legacy = { version: 1, revision: 7, sessions: [], goals: [], routines: [] };
  const migrated = climbingStateSchema.parse(legacy);
  assert.deepEqual(migrated.plans, []);
  assert.deepEqual(emptyClimbing.plans, []);

  const goal = consistencyGoal({ sessionTarget: 1 });
  const withFuturePlan = climbingStateSchema.parse({ ...legacy, goals: [goal], plans: [climbingPlan({ goalId: goal.id, date: '2026-09-25' })] });
  assert.deepEqual(consistencyProgress(goal, withFuturePlan.sessions), { completed: 0, target: 1, percent: 0 });
});

test('Plan, session, goal, and Health workout links are reciprocal and unique', () => {
  const goal = consistencyGoal();
  const planId = randomUUID();
  const sessionId = randomUUID();
  const healthWorkoutId = randomUUID();
  const linkedSession = session({ id: sessionId, planId, healthWorkoutId });
  const loggedPlan = climbingPlan({ id: planId, date: linkedSession.date, goalId: goal.id, status: 'logged', sessionId });
  const linked = state({ sessions: [linkedSession], goals: [goal], plans: [loggedPlan] });
  assert.equal(climbingStateSchema.safeParse(linked).success, true);

  const removedSession = { ...linkedSession, deletedAt: at };
  assert.equal(climbingStateSchema.safeParse(state({ sessions: [removedSession], goals: [goal], plans: [loggedPlan] })).success, true, 'a removed session keeps its restorable logged-plan link');
  assert.equal(consistencyProgress(goal, [removedSession]).completed, 0, 'removed linked sessions stay excluded from goal progress');

  assert.equal(climbingStateSchema.safeParse(state({ sessions: [linkedSession], plans: [loggedPlan] })).success, false, 'plan goals must exist');
  assert.equal(climbingStateSchema.safeParse(state({ goals: [goal], plans: [loggedPlan] })).success, false, 'a logged plan must have its linked session');
  assert.equal(climbingStateSchema.safeParse(state({ sessions: [linkedSession], goals: [goal] })).success, false, 'a session plan link must resolve');
  assert.equal(climbingStateSchema.safeParse(state({ sessions: [{ ...linkedSession, planId: randomUUID() }], goals: [goal], plans: [loggedPlan] })).success, false, 'plan and session links must agree');
  assert.equal(climbingStateSchema.safeParse(state({ goals: [goal], plans: [loggedPlan, { ...loggedPlan }] })).success, false, 'plan IDs must be unique');

  const secondSession = session({ planId, healthWorkoutId: null });
  assert.equal(climbingStateSchema.safeParse(state({ sessions: [linkedSession, secondSession], goals: [goal], plans: [loggedPlan] })).success, false, 'one plan cannot link to multiple sessions');
  assert.equal(climbingStateSchema.safeParse(state({ sessions: [linkedSession, session({ healthWorkoutId })] })).success, false, 'one Health workout cannot link to multiple sessions');
  assert.equal(climbingStateSchema.safeParse(state({ sessions: [removedSession, session({ healthWorkoutId })], goals: [goal], plans: [loggedPlan] })).success, false, 'tombstones reserve their Health workout link for safe restoration');
});

test('Routine snapshots are independent historical records and consistency progress uses the inclusive goal window', () => {
  const plan = routine();
  const snapshot = routineSnapshot(plan);
  assert.notStrictEqual(snapshot.steps[0], plan.steps[0]);
  assert.equal(snapshot.steps[0].status, 'not-logged');
  assert.equal(snapshot.steps[0].result, '');
  assert.equal(snapshot.description, 'Full rests and high-quality attempts.');
  assert.equal(snapshot.estimatedMinutes, 60);

  plan.title = 'Changed routine';
  plan.description = 'Changed purpose';
  plan.estimatedMinutes = 90;
  plan.steps[0].name = 'Changed warm up';
  snapshot.steps[0].prescription = 'Completed four easy problems';
  assert.equal(snapshot.title, 'Limit bouldering');
  assert.equal(snapshot.description, 'Full rests and high-quality attempts.');
  assert.equal(snapshot.estimatedMinutes, 60);
  assert.equal(snapshot.steps[0].name, 'Warm up');
  assert.equal(plan.steps[0].prescription, 'Climb six easy problems');

  const historicalSession = session({ routine: snapshot });
  assert.equal(climbingStateSchema.safeParse(state({ sessions: [historicalSession], routines: [] })).success, true, 'logged snapshots must remain valid after a routine is removed');

  const goal = consistencyGoal({ sessionTarget: 3 });
  const sessions = [
    session({ date: '2026-08-31' }),
    session({ date: '2026-09-01' }),
    session({ date: '2026-09-30' }),
    session({ date: '2026-09-15', deletedAt: at }),
    session({ date: '2026-10-01' }),
  ];
  const inWindow = consistencyProgress(goal, sessions);
  assert.deepEqual({ completed: inWindow.completed, target: inWindow.target }, { completed: 2, target: 3 });
  assert.ok(Math.abs(inWindow.percent - (200 / 3)) < 1e-10);
  assert.deepEqual(consistencyProgress(goal, [...sessions, session({ date: '2026-09-15' }), session({ date: '2026-09-20' })]), { completed: 4, target: 3, percent: 100 });
  assert.deepEqual(consistencyProgress({ ...goal, kind: 'skill', progress: 45 }, sessions), { completed: 0, target: 0, percent: 45 });
});

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-climbing-'));
  const app = createClimbingService(directory);
  const server = createServer(app.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = headers => fetch(`${origin}/api/climbing`, { headers });
  const put = (data, headers = {}) => fetch(`${origin}/api/climbing`, {
    method: 'PUT',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(data),
  });
  return {
    directory,
    origin,
    get,
    put,
    cleanup: async () => {
      await new Promise(resolve => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('Climbing API persists private state and rejects stale, cross-origin, malformed, and oversized writes', async t => {
  const h = await harness();
  try {
    let saved;
    await t.test('starts empty and persists a validated state', async () => {
      const first = await h.get();
      assert.equal(first.status, 200);
      assert.equal(first.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await first.json(), state());

      const plan = routine();
      const logged = session({ routine: routineSnapshot(plan) });
      const goal = consistencyGoal({ routineId: plan.id });
      const upcoming = climbingPlan({ goalId: goal.id, routine: routineSnapshot(plan) });
      const response = await h.put(state({ sessions: [logged], goals: [goal], routines: [plan], plans: [upcoming] }));
      assert.equal(response.status, 200);
      saved = await response.json();
      assert.equal(saved.revision, 1);
      assert.equal(saved.sessions[0].climbs[0].grade, 'Blue / V5-ish +');
      assert.equal(saved.plans[0].routine.version, 1);
      assert.deepEqual(JSON.parse(await readFile(join(h.directory, 'climbing.private.json'), 'utf8')), saved);
      assert.equal((await stat(join(h.directory, 'climbing.private.json'))).mode & 0o777, 0o600);
      assert.deepEqual(await (await h.get()).json(), saved);
    });

    await t.test('rejects stale revisions without overwriting current data', async () => {
      const stale = await h.put({ ...saved, revision: 0, sessions: [] });
      assert.equal(stale.status, 409);
      const conflict = await stale.json();
      assert.equal(conflict.code, 'revision_conflict');
      assert.match(conflict.error, /another window/i);
      assert.deepEqual(await (await h.get()).json(), saved);
    });

    await t.test('reports lock contention separately from a stale revision', async () => {
      const lock = join(h.directory, 'climbing.private.json.lock');
      await writeFile(lock, '999999');
      const busy = await h.put(saved);
      assert.equal(busy.status, 423);
      const result = await busy.json();
      assert.equal(result.code, 'store_busy');
      assert.match(result.error, /another request/i);
      await rm(lock);
      assert.deepEqual(await (await h.get()).json(), saved);
    });

    await t.test('rejects cross-origin access and unsupported content types', async () => {
      assert.equal((await h.get({ Origin: 'https://example.com' })).status, 403);
      const wrongType = await fetch(`${h.origin}/api/climbing`, {
        method: 'PUT',
        headers: { Origin: h.origin, 'Content-Type': 'text/plain' },
        body: JSON.stringify(saved),
      });
      assert.equal(wrongType.status, 415);
      assert.deepEqual(await (await h.get()).json(), saved);
    });

    await t.test('rejects malformed state without changing the saved revision', async () => {
      const malformed = await h.put({ ...saved, sessions: [{ ...saved.sessions[0], date: '2026-02-30' }] });
      assert.equal(malformed.status, 400);
      assert.deepEqual(await (await h.get()).json(), saved);
    });

    await t.test('rejects oversized JSON before parsing or writing it', async () => {
      const oversized = await fetch(`${h.origin}/api/climbing`, {
        method: 'PUT',
        headers: { Origin: h.origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ padding: 'x'.repeat(3_000_000) }),
      });
      assert.equal(oversized.status, 413);
      assert.deepEqual(await (await h.get()).json(), saved);
    });

    await t.test('fails closed when the saved file is corrupt', async () => {
      const path = join(h.directory, 'climbing.private.json');
      await writeFile(path, 'broken json');
      const read = await h.get();
      assert.equal(read.status, 500);
      assert.match((await read.json()).error, /could not be read/i);
      assert.equal((await h.put(saved)).status, 500);
      assert.equal(await readFile(path, 'utf8'), 'broken json');
    });
  } finally {
    await h.cleanup();
  }
});

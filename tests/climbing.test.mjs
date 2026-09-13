import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
  goalReferenceSchema,
  routineSnapshot,
} from '../lib/climbing.ts';

const at = '2026-09-11T20:00:00.000Z';
const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const tinyMov = Buffer.from(
  'AAAAFGZ0eXBxdCAgAAAAAHF0ICAAAAAId2lkZQAAAKltZGF0AAAAHgYFGkdWStxcTEM/lO/FETzRQ6gB/8zM/wIAAeYAgAAAAD8luCAf3gjlTP+CrRJtQ24vsAFPLw+P8nvtRwElLPs2P3zhC+vQ/+A7QojM89nJJ5PeEp9cvBgAAKRgAP0MWrAAAAAYIeEIX6ATdfq61hQFgM/6gAkHySz5PxvQAAAAHAGogYr/+h3CYWP+QfusoUr/4XQuACStwbX0/2QAAAN9bW9vdgAAAGxtdmhkAAAAAObLXeHmy13hAAACWAAAALQAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAwl0cmFrAAAAXHRraGQAAAAP5std4ebLXeEAAAABAAAAAAAAALQAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAACAAAAAgAAAAAABEdGFwdAAAABRjbGVmAAAAAAAgAAAAIAAAAAAAFHByb2YAAAAAACAAAAAgAAAAAAAUZW5vZgAAAAAAIAAAACAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAALQAAAAAAAEAAAAAAj1tZGlhAAAAIG1kaGQAAAAA5std4ebLXeEAAAJYAAAAtFXEAAAAAAAxaGRscgAAAABtaGxydmlkZWFwcGwAAAAAAAAAABBDb3JlIE1lZGlhIFZpZGVvAAAB5G1pbmYAAAAUdm1oZAAAAAEAQIAAgACAAAAAADhoZGxyAAAAAGRobHJhbGlzYXBwbAAAAAAAAAAAF0NvcmUgTWVkaWEgRGF0YSBIYW5kbGVyAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADGFsaXMAAAABAAABbHN0YmwAAACRc3RzZAAAAAAAAAABAAAAgWF2YzEAAAAAAAAAAQAAAAAAAAAAAAACAAAAAgAAIAAgAEgAAABIAAAAAAAAAAEFSC4yNjQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY//8AAAAnYXZjQwFkAAv/4QAMJ2QAC6xWUMN4FGCFAQAEKO48sP34+AAAAAAAAAAAGHN0dHMAAAAAAAAAAQAAAAMAAAA8AAAAKGN0dHMAAAAAAAAAAwAAAAEAAAAAAAAAAQAAADwAAAAB////xAAAACBjc2xnAAAAAAAAADz////EAAAAPAAAAAAAAAC0AAAAFHN0c3MAAAAAAAAAAQAAAAEAAAAPc2R0cAAAAAAgEBgAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAMAAAABAAAAIHN0c3oAAAAAAAAAAAAAAAMAAABlAAAAHAAAACAAAAAUc3RjbwAAAAAAAAABAAAAJA==',
  'base64',
);

function isoBmff(majorBrand, compatibleBrands = []) {
  const value = Buffer.alloc(16 + compatibleBrands.length * 4);
  value.writeUInt32BE(value.length, 0);
  value.write('ftyp', 4, 'ascii');
  value.write(majorBrand, 8, 'ascii');
  value.writeUInt32BE(0, 12);
  compatibleBrands.forEach((brand, index) => value.write(brand, 16 + index * 4, 'ascii'));
  return value;
}

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

function uploadedReference(goalId, byteSize, overrides = {}) {
  return {
    id: randomUUID(),
    goalId,
    kind: 'video',
    label: '',
    url: null,
    fileName: 'beta.mp4',
    mimeType: 'video/mp4',
    byteSize,
    createdAt: at,
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
  return { version: 1, revision: 0, sessions: [], goals: [], routines: [], plans: [], goalReferences: [], ...overrides };
}

function withoutAdditiveProjectFields(goal) {
  const { environment, discipline, ropeStyle, attempts, ...legacy } = goal;
  return legacy;
}

function projectDetails(goal) {
  return {
    environment: goal.environment,
    discipline: goal.discipline,
    ropeStyle: goal.ropeStyle,
    attempts: goal.attempts,
  };
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
  const legacyProject = climbingGoalSchema.parse({ ...goal, kind: 'project', startDate: null, targetDate: null, sessionTarget: null });
  assert.equal(legacyProject.environment, null);
  assert.equal(legacyProject.discipline, null);
  assert.equal(legacyProject.ropeStyle, null);
  assert.equal(legacyProject.attempts, null);
  const boulderProject = { ...legacyProject, environment: 'indoor', discipline: 'boulder', ropeStyle: null, gradeSystem: 'v-scale', grade: 'V7', attempts: 0 };
  const routeProject = { ...legacyProject, environment: 'outdoor', discipline: 'route', ropeStyle: 'sport-lead', gradeSystem: 'yds', grade: '5.12a', attempts: 14 };
  assert.deepEqual(climbingGoalSchema.parse(boulderProject), boulderProject);
  assert.deepEqual(climbingGoalSchema.parse(routeProject), routeProject);
  assert.equal(climbingGoalSchema.safeParse({ ...boulderProject, ropeStyle: 'top-rope' }).success, false);
  assert.equal(climbingGoalSchema.safeParse({ ...legacyProject, ropeStyle: 'top-rope' }).success, false);
  assert.equal(climbingGoalSchema.safeParse({ ...boulderProject, gradeSystem: 'yds', grade: '5.12a' }).success, false);
  assert.equal(climbingGoalSchema.safeParse({ ...routeProject, gradeSystem: 'v-scale', grade: 'V7' }).success, false);
  assert.equal(climbingGoalSchema.safeParse({ ...routeProject, attempts: -1 }).success, false);
  assert.equal(climbingGoalSchema.safeParse({ ...routeProject, attempts: 1.5 }).success, false);
  assert.equal(climbingGoalSchema.safeParse({ ...routeProject, attempts: 10_000 }).success, false);
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

  const reference={id:randomUUID(),goalId:goal.id,kind:'link',label:'Crux beta',url:'https://example.com/beta',fileName:null,mimeType:null,byteSize:null,createdAt:at};
  assert.equal(goalReferenceSchema.safeParse(reference).success,true);
  assert.equal(goalReferenceSchema.safeParse({...reference,url:'http://example.com/beta'}).success,false);
  assert.equal(goalReferenceSchema.safeParse({...reference,kind:'video',url:null,fileName:'beta.mov',mimeType:'image/jpeg',byteSize:1}).success,false);
  assert.equal(climbingStateSchema.safeParse(state({goals:[goal],goalReferences:[reference]})).success,true);
  assert.equal(climbingStateSchema.safeParse(state({goals:[goal],goalReferences:[reference,reference]})).success,false);
  assert.equal(climbingStateSchema.safeParse(state({goalReferences:[reference]})).success,false);
  assert.equal(climbingStateSchema.safeParse(state({goals:[goal],goalReferences:Array.from({length:13},()=>({...reference,id:randomUUID()}))})).success,false);
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

test('Climbing state enforces per-goal and total media quotas from reference metadata', () => {
  const project = consistencyGoal({ title: 'Project route' });
  const exactlyOneGb = Array.from({ length: 5 }, () => uploadedReference(project.id, 200_000_000));
  assert.equal(climbingStateSchema.safeParse(state({ goals: [project], goalReferences: exactlyOneGb })).success, true);

  const goalOverage = climbingStateSchema.safeParse(state({
    goals: [project],
    goalReferences: [...exactlyOneGb, uploadedReference(project.id, 1)],
  }));
  assert.equal(goalOverage.success, false);
  assert.match(goalOverage.error.issues.map(issue => issue.message).join(' '), /1 GB/);

  const projects = Array.from({ length: 6 }, (_, index) => consistencyGoal({ title: `Project route ${index + 1}` }));
  const exactlyFiveGb = projects.slice(0, 5).flatMap(goal =>
    Array.from({ length: 5 }, () => uploadedReference(goal.id, 200_000_000)),
  );
  assert.equal(climbingStateSchema.safeParse(state({ goals: projects, goalReferences: exactlyFiveGb })).success, true);

  const workspaceOverage = climbingStateSchema.safeParse(state({
    goals: projects,
    goalReferences: [...exactlyFiveGb, uploadedReference(projects[5].id, 1)],
  }));
  assert.equal(workspaceOverage.success, false);
  assert.match(workspaceOverage.error.issues.map(issue => issue.message).join(' '), /5 GB/);
});

test('Legacy v1 state gains an empty plan collection and future plans never count as sessions', () => {
  const legacy = { version: 1, revision: 7, sessions: [], goals: [], routines: [] };
  const migrated = climbingStateSchema.parse(legacy);
  assert.deepEqual(migrated.plans, []);
  assert.deepEqual(migrated.goalReferences, []);
  assert.deepEqual(emptyClimbing.plans, []);
  assert.deepEqual(emptyClimbing.goalReferences, []);

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
  const post = (data, headers = {}) => fetch(`${origin}/api/climbing`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(data),
  });
  return {
    directory,
    origin,
    get,
    put,
    post,
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

    await t.test('serves conditional reads and applies idempotent per-record commands', async () => {
      const first=await h.get();const etag=first.headers.get('etag');assert.ok(etag);await first.arrayBuffer();const unchanged=await h.get({'If-None-Match':etag});assert.equal(unchanged.status,304);
      const goal=saved.goals[0];const changed={...goal,title:'Blue corner',kind:'project',startDate:null,sessionTarget:null,environment:'indoor',discipline:'boulder',ropeStyle:null,gradeSystem:'gym',grade:'Blue / V5-ish +',attempts:6,routineId:null,nextStep:'Reserve the next session',updatedAt:'2026-09-12T20:00:00.000Z'};
      const command={requestId:randomUUID(),changes:[{kind:'goal',expectedUpdatedAt:goal.updatedAt,value:changed}]};
      let response=await h.post(command);assert.equal(response.status,200);saved=await response.json();assert.equal(saved.goals[0].nextStep,'Reserve the next session');assert.equal(saved.goals[0].discipline,'boulder');assert.equal(saved.goals[0].attempts,6);assert.equal(saved.sessions.length,1);
      const revision=saved.revision;response=await h.post(command);assert.equal(response.status,200);saved=await response.json();assert.equal(saved.revision,revision);assert.equal(response.headers.get('x-idempotent-replay'),'true');
      response=await h.post({requestId:randomUUID(),changes:[{...command.changes[0],value:{...changed,nextStep:'Conflicting edit',updatedAt:'2026-09-12T21:00:00.000Z'}}]});assert.equal(response.status,409);assert.equal((await response.json()).code,'entity_revision_conflict');
    });

    await t.test('preserves additive project fields omitted by older writers while honoring explicit nulls', async () => {
      const expected = projectDetails(saved.goals[0]);
      const legacyCommandGoal = {
        ...withoutAdditiveProjectFields(saved.goals[0]),
        nextStep: 'Try the right heel hook',
        updatedAt: '2026-09-12T21:00:00.000Z',
      };
      let response = await h.post({
        requestId: randomUUID(),
        changes: [{ kind: 'goal', expectedUpdatedAt: saved.goals[0].updatedAt, value: legacyCommandGoal }],
      });
      assert.equal(response.status, 200);
      saved = await response.json();
      assert.deepEqual(projectDetails(saved.goals[0]), expected);
      assert.equal(saved.goals[0].nextStep, 'Try the right heel hook');

      const legacyStateGoal = {
        ...withoutAdditiveProjectFields(saved.goals[0]),
        description: 'Updated by an older whole-state client.',
        updatedAt: '2026-09-12T22:00:00.000Z',
      };
      response = await h.put({ ...saved, goals: [legacyStateGoal] });
      assert.equal(response.status, 200);
      saved = await response.json();
      assert.deepEqual(projectDetails(saved.goals[0]), expected);
      assert.equal(saved.goals[0].description, 'Updated by an older whole-state client.');

      const explicitNullCommandGoal = {
        ...saved.goals[0],
        environment: null,
        discipline: null,
        ropeStyle: null,
        attempts: null,
        updatedAt: '2026-09-12T23:00:00.000Z',
      };
      response = await h.post({
        requestId: randomUUID(),
        changes: [{ kind: 'goal', expectedUpdatedAt: saved.goals[0].updatedAt, value: explicitNullCommandGoal }],
      });
      assert.equal(response.status, 200);
      saved = await response.json();
      assert.deepEqual(projectDetails(saved.goals[0]), { environment: null, discipline: null, ropeStyle: null, attempts: null });

      const restoredCommandGoal = {
        ...saved.goals[0],
        ...expected,
        updatedAt: '2026-09-13T00:00:00.000Z',
      };
      response = await h.post({
        requestId: randomUUID(),
        changes: [{ kind: 'goal', expectedUpdatedAt: saved.goals[0].updatedAt, value: restoredCommandGoal }],
      });
      assert.equal(response.status, 200);
      saved = await response.json();
      assert.deepEqual(projectDetails(saved.goals[0]), expected);

      const explicitNullStateGoal = {
        ...saved.goals[0],
        environment: null,
        discipline: null,
        ropeStyle: null,
        attempts: null,
        updatedAt: '2026-09-13T01:00:00.000Z',
      };
      response = await h.put({ ...saved, goals: [explicitNullStateGoal] });
      assert.equal(response.status, 200);
      saved = await response.json();
      assert.deepEqual(projectDetails(saved.goals[0]), { environment: null, discipline: null, ropeStyle: null, attempts: null });
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

    await t.test('rejects a missing goal before an upload body is sent or spooled', async () => {
      const referenceId = randomUUID();
      const missingGoalId = randomUUID();
      const result = await new Promise((resolve, reject) => {
        let responseStarted = false;
        const request = httpRequest(`${h.origin}/api/climbing/media/upload`, {
          method: 'POST',
          headers: {
            Origin: h.origin,
            'Content-Type': 'image/png',
            'Content-Length': String(tinyPng.length),
            'X-Workspace-Request-Id': randomUUID(),
            'X-Workspace-Reference-Id': referenceId,
            'X-Workspace-Goal-Id': missingGoalId,
            'X-Workspace-File-Name': encodeURIComponent('unsaved-project.png'),
            'X-Workspace-Label': '',
          },
        }, response => {
          responseStarted = true;
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => {
            clearTimeout(timer);
            request.destroy();
            resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          });
        });
        const timer = setTimeout(() => {
          request.destroy();
          reject(new Error('The server waited for the upload body before rejecting its missing goal.'));
        }, 2_000);
        request.on('error', error => {
          if (!responseStarted) {
            clearTimeout(timer);
            reject(error);
          }
        });
        request.flushHeaders();
      });

      assert.equal(result.status, 404);
      assert.equal(result.body.code, 'goal_not_found');
      assert.equal((await h.get().then(response => response.json())).goalReferences.some(reference => reference.id === referenceId), false);
      const mediaNames = await readdir(join(h.directory, 'climbing-media'));
      assert.equal(mediaNames.some(name => name.includes(referenceId)), false);
    });

    await t.test('admits only one cross-process media upload at a time', async () => {
      const referenceId=randomUUID();
      const gate=join(h.directory,'climbing-media-upload.lock');
      await writeFile(gate,JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}),{mode:0o600});
      try {
        const response=await fetch(`${h.origin}/api/climbing/media/upload`,{
          method:'POST',
          headers:{
            Origin:h.origin,'Content-Type':'image/png','X-Workspace-Request-Id':randomUUID(),'X-Workspace-Reference-Id':referenceId,
            'X-Workspace-Goal-Id':saved.goals[0].id,'X-Workspace-File-Name':encodeURIComponent('queued-beta.png'),'X-Workspace-Label':'',
          },
          body:tinyPng,
        });
        assert.equal(response.status,423);
        assert.equal((await response.json()).code,'store_busy');
      } finally {
        await rm(gate);
      }
      assert.equal((await h.get().then(response=>response.json())).goalReferences.some(reference=>reference.id===referenceId),false);
      assert.equal((await readdir(join(h.directory,'climbing-media'))).some(name=>name.includes(referenceId)),false);
    });

    await t.test('keeps private goal media, streams byte ranges, preserves it across legacy saves, and deletes it', async () => {
      const goal=saved.goals[0],referenceId=randomUUID(),requestId=randomUUID();
      const png=tinyPng;
      const upload=()=>fetch(`${h.origin}/api/climbing/media/upload`,{
        method:'POST',
        headers:{
          Origin:h.origin,
          'Content-Type':'image/png',
          'X-Workspace-Request-Id':requestId,
          'X-Workspace-Reference-Id':referenceId,
          'X-Workspace-Goal-Id':goal.id,
          'X-Workspace-File-Name':encodeURIComponent('Moon board beta.png'),
          'X-Workspace-Label':encodeURIComponent('Crux sequence'),
        },
        body:png,
      });
      let response=await upload();
      assert.equal(response.status,200);
      saved=await response.json();
      assert.equal(saved.goalReferences.length,1);
      assert.deepEqual(saved.goalReferences[0],{
        id:referenceId,goalId:goal.id,kind:'image',label:'Crux sequence',url:null,fileName:'Moon board beta.png',
        mimeType:'image/png',byteSize:png.length,createdAt:saved.goalReferences[0].createdAt,
      });
      const mediaPath=join(h.directory,'climbing-media',referenceId);
      assert.deepEqual(await readFile(mediaPath),png);
      assert.equal((await stat(mediaPath)).mode&0o777,0o600);

      response=await upload();
      assert.equal(response.status,200);
      assert.equal(response.headers.get('x-idempotent-replay'),'true');
      assert.equal((await response.json()).revision,saved.revision);
      const conflicting=await fetch(`${h.origin}/api/climbing/media/upload`,{
        method:'POST',
        headers:{
          Origin:h.origin,'Content-Type':'image/png','X-Workspace-Request-Id':randomUUID(),'X-Workspace-Reference-Id':referenceId,
          'X-Workspace-Goal-Id':goal.id,'X-Workspace-File-Name':encodeURIComponent('Moon board beta.png'),'X-Workspace-Label':encodeURIComponent('Different label'),
        },
        body:png,
      });
      assert.equal(conflicting.status,409);

      response=await fetch(`${h.origin}/api/climbing/media/${referenceId}`,{headers:{Range:'bytes=8-10'}});
      assert.equal(response.status,206);
      assert.equal(response.headers.get('content-range'),`bytes 8-10/${png.length}`);
      assert.equal(response.headers.get('accept-ranges'),'bytes');
      assert.equal(response.headers.get('content-type'),'image/png');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),png.subarray(8,11));
      const head=await fetch(`${h.origin}/api/climbing/media/${referenceId}`,{method:'HEAD'});
      assert.equal(head.status,200);
      assert.equal(head.headers.get('content-length'),String(png.length));
      const invalidRange=await fetch(`${h.origin}/api/climbing/media/${referenceId}`,{headers:{Range:'bytes=999-1000'}});
      assert.equal(invalidRange.status,416);
      assert.equal(invalidRange.headers.get('content-range'),`bytes */${png.length}`);

      const linkReference={id:randomUUID(),goalId:goal.id,kind:'link',label:'Full route beta',url:'https://example.com/project-beta',fileName:null,mimeType:null,byteSize:null,createdAt:at};
      response=await fetch(`${h.origin}/api/climbing/media/link`,{method:'POST',headers:{Origin:h.origin,'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),reference:linkReference})});
      assert.equal(response.status,200);
      saved=await response.json();
      assert.equal(saved.goalReferences.length,2);
      const badLink=await fetch(`${h.origin}/api/climbing/media/link`,{method:'POST',headers:{Origin:h.origin,'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),reference:{...linkReference,id:randomUUID(),url:'http://example.com/beta'}})});
      assert.equal(badLink.status,400);

      const legacySave={...saved};
      delete legacySave.goalReferences;
      response=await h.put(legacySave);
      assert.equal(response.status,200);
      saved=await response.json();
      assert.equal(saved.goalReferences.length,2,'whole-state saves from older clients cannot erase references');

      const invalidId=randomUUID();
      const invalidUpload=await fetch(`${h.origin}/api/climbing/media/upload`,{
        method:'POST',
        headers:{
          Origin:h.origin,'Content-Type':'video/mp4','X-Workspace-Request-Id':randomUUID(),'X-Workspace-Reference-Id':invalidId,
          'X-Workspace-Goal-Id':goal.id,'X-Workspace-File-Name':encodeURIComponent('not-video.mp4'),'X-Workspace-Label':'',
        },
        body:Buffer.from('not actually media'),
      });
      assert.equal(invalidUpload.status,415);
      assert.equal((await h.get().then(value=>value.json())).goalReferences.length,2);

      for (const [fileName, bytes] of [
        ['audio-only.m4a', isoBmff('isom', ['M4A ', 'mp42'])],
        ['header-only.mp4', isoBmff('isom', ['mp42'])],
        ['unknown-brand.mp4', isoBmff('zzzz', ['zzzz'])],
      ]) {
        const unsupportedId=randomUUID();
        const unsupported=await fetch(`${h.origin}/api/climbing/media/upload`,{
          method:'POST',
          headers:{
            Origin:h.origin,'Content-Type':'video/mp4','X-Workspace-Request-Id':randomUUID(),'X-Workspace-Reference-Id':unsupportedId,
            'X-Workspace-Goal-Id':goal.id,'X-Workspace-File-Name':encodeURIComponent(fileName),'X-Workspace-Label':'',
          },
          body:bytes,
        });
        assert.equal(unsupported.status,415,`${fileName} must not be accepted as an MP4 video`);
        assert.equal((await h.get().then(value=>value.json())).goalReferences.some(reference=>reference.id===unsupportedId),false);
        assert.equal((await readdir(join(h.directory,'climbing-media'))).some(name=>name.includes(unsupportedId)),false);
      }

      const videoId=randomUUID();
      const videoUpload=await fetch(`${h.origin}/api/climbing/media/upload`,{
        method:'POST',
        headers:{
          Origin:h.origin,'Content-Type':'video/quicktime','X-Workspace-Request-Id':randomUUID(),'X-Workspace-Reference-Id':videoId,
          'X-Workspace-Goal-Id':goal.id,'X-Workspace-File-Name':encodeURIComponent('route-beta.mov'),'X-Workspace-Label':encodeURIComponent('Full sequence'),
        },
        body:tinyMov,
      });
      assert.equal(videoUpload.status,200);
      saved=await videoUpload.json();
      const videoReference=saved.goalReferences.find(reference=>reference.id===videoId);
      assert.ok(videoReference);
      assert.deepEqual(videoReference,{
        id:videoId,goalId:goal.id,kind:'video',label:'Full sequence',url:null,fileName:'route-beta.mov',
        mimeType:'video/quicktime',byteSize:tinyMov.length,createdAt:videoReference.createdAt,
      });
      const videoRead=await fetch(`${h.origin}/api/climbing/media/${videoId}`);
      assert.equal(videoRead.status,200);
      assert.deepEqual(Buffer.from(await videoRead.arrayBuffer()),tinyMov);
      const videoDelete=await fetch(`${h.origin}/api/climbing/media/delete`,{method:'POST',headers:{Origin:h.origin,'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),goalId:goal.id,referenceId:videoId})});
      assert.equal(videoDelete.status,200);
      saved=await videoDelete.json();

      if (process.platform !== 'win32' && process.getuid?.() !== 0) {
        const mediaDirectory=join(h.directory,'climbing-media');
        await chmod(mediaDirectory,0o500);
        try {
          const failedDelete=await fetch(`${h.origin}/api/climbing/media/delete`,{method:'POST',headers:{Origin:h.origin,'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),goalId:goal.id,referenceId})});
          assert.equal(failedDelete.status,500);
          assert.equal((await failedDelete.json()).code,'media_delete_failed');
          const retained=await h.get().then(value=>value.json());
          assert.equal(retained.goalReferences.some(reference=>reference.id===referenceId),true);
          assert.deepEqual(await readFile(mediaPath),png);
        } finally {
          await chmod(mediaDirectory,0o700);
        }
      } else {
        t.diagnostic('Delete-failure preservation needs non-root POSIX directory permissions; skipped on this runtime.');
      }

      response=await fetch(`${h.origin}/api/climbing/media/delete`,{method:'POST',headers:{Origin:h.origin,'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),goalId:goal.id,referenceId})});
      assert.equal(response.status,200);
      saved=await response.json();
      assert.equal(saved.goalReferences.some(reference=>reference.id===referenceId),false);
      await assert.rejects(stat(mediaPath),error=>error.code==='ENOENT');
      response=await fetch(`${h.origin}/api/climbing/media/delete`,{method:'POST',headers:{Origin:h.origin,'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),goalId:goal.id,referenceId})});
      assert.equal(response.headers.get('x-idempotent-replay'),'true');
      saved=await response.json();
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

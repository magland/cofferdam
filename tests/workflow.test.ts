import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  filterPatternToRegExp,
  matchFilterPatterns,
  parseWorkflow,
  pushMatches,
  WorkflowError,
} from '../src/ci/workflow';

// ---- parsing ----

const MINIMAL = `
on: push
jobs:
  build:
    runs-on: self-hosted
    steps:
      - run: make
`;

test('a minimal workflow parses, with a push trigger and one job', () => {
  const wf = parseWorkflow(MINIMAL);
  assert.equal(wf.name, null);
  assert.ok(wf.on.push);
  assert.equal(wf.jobs.length, 1);
  assert.equal(wf.jobs[0].key, 'build');
  assert.deepEqual(wf.jobs[0].runsOn, ['self-hosted']);
  assert.equal(wf.jobs[0].steps[0].run, 'make');
});

test('triggers may be a string, a list, or a map, and unknown events are kept by name', () => {
  const wf = parseWorkflow(`
on: [push, workflow_dispatch, pull_request]
jobs:
  a:
    runs-on: x
    steps:
      - run: 'true'
`);
  assert.ok(wf.on.push);
  assert.ok(wf.on.workflowDispatch);
  assert.deepEqual(wf.on.others, ['pull_request']);
});

test('push filters and dispatch inputs come through normalized', () => {
  const wf = parseWorkflow(`
on:
  push:
    branches: [main, 'release/*']
    paths-ignore:
      - docs/**
  workflow_dispatch:
    inputs:
      level:
        type: choice
        required: true
        options: [low, high]
      dry:
        type: boolean
        default: true
jobs:
  a:
    runs-on: x
    steps:
      - run: 'true'
`);
  assert.deepEqual(wf.on.push?.branches, ['main', 'release/*']);
  assert.deepEqual(wf.on.push?.pathsIgnore, ['docs/**']);
  const inputs = wf.on.workflowDispatch?.inputs ?? {};
  assert.equal(inputs.level.type, 'choice');
  assert.ok(inputs.level.required);
  assert.deepEqual(inputs.level.options, ['low', 'high']);
  assert.equal(inputs.dry.type, 'boolean');
  assert.equal(inputs.dry.default, true);
});

test('the missing pieces are each their own refusal', () => {
  assert.throws(() => parseWorkflow('jobs:\n  a:\n    runs-on: x\n    steps:\n      - run: t'), /"on:"/);
  assert.throws(() => parseWorkflow('on: push\n'), /no jobs/);
  assert.throws(() => parseWorkflow('on: push\njobs:\n  a:\n    steps:\n      - run: t'), /runs-on/);
  assert.throws(() => parseWorkflow('on: push\njobs:\n  a:\n    runs-on: x'), /no steps/);
  assert.throws(() => parseWorkflow('not: [valid'), WorkflowError);
});

test('a step needs run or uses, and not both', () => {
  const job = 'on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n';
  assert.throws(() => parseWorkflow(job + '      - name: empty'), /either "run" or "uses"/);
  assert.throws(() => parseWorkflow(job + '      - run: t\n        uses: some/action@v1'), /both/);
});

test('a job id is held to a path-safe shape', () => {
  assert.throws(
    () => parseWorkflow('on: push\njobs:\n  "../../x":\n    runs-on: x\n    steps:\n      - run: t'),
    /job id/
  );
});

test('needs must name jobs that exist', () => {
  assert.throws(
    () =>
      parseWorkflow(`
on: push
jobs:
  a:
    runs-on: x
    needs: ghost
    steps:
      - run: 'true'
`),
    /needs unknown job ghost/
  );
});

test('features the engine cannot run mark the job unsupported instead of failing the file', () => {
  const wf = parseWorkflow(`
on: push
jobs:
  reuse:
    uses: octo/repo/.github/workflows/x.yml@main
  boxed:
    container: node:20
    runs-on: x
    steps:
      - run: 'true'
`);
  assert.match(wf.jobs[0].unsupported ?? '', /reusable workflows/);
  assert.match(wf.jobs[1].unsupported ?? '', /container jobs/);
});

test('runs-on may be the {group, labels} form', () => {
  const wf = parseWorkflow(`
on: push
jobs:
  a:
    runs-on:
      group: default
      labels: [big, linux]
    steps:
      - run: 'true'
`);
  assert.deepEqual(wf.jobs[0].runsOn, ['big', 'linux']);
});

test('concurrency takes the string form and the map form, and a map needs a group', () => {
  const base = 'on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: t\n';
  assert.deepEqual(parseWorkflow(base + 'concurrency: ci').concurrency, {
    group: 'ci',
    cancelInProgress: 'false',
  });
  const mapForm = parseWorkflow(base + 'concurrency:\n  group: ci\n  cancel-in-progress: true');
  assert.equal(mapForm.concurrency?.cancelInProgress, 'true');
  assert.throws(() => parseWorkflow(base + 'concurrency:\n  cancel-in-progress: true'), /group/);
});

test('a reference to secrets is refused at parse time, naming the secret', () => {
  assert.throws(
    () =>
      parseWorkflow(`
on: push
jobs:
  a:
    runs-on: x
    steps:
      - run: deploy
        env:
          KEY: \${{ secrets.DEPLOY_KEY }}
`),
    /secrets\.DEPLOY_KEY/
  );
});

// ---- filter patterns ----

test('filter patterns: * stays within a segment, **/ spans directories', () => {
  assert.ok(filterPatternToRegExp('src/*').test('src/a.ts'));
  assert.ok(!filterPatternToRegExp('src/*').test('src/sub/a.ts'));
  assert.ok(filterPatternToRegExp('dist/**/*.js').test('dist/a.js'));
  assert.ok(filterPatternToRegExp('dist/**/*.js').test('dist/sub/deep/b.js'));
  assert.ok(filterPatternToRegExp('**').test('anything/at/all'));
  assert.ok(filterPatternToRegExp('release-?').test('release-1'));
  assert.ok(!filterPatternToRegExp('release-?').test('release-10'));
  assert.ok(filterPatternToRegExp('v[12].x').test('v1.x'));
  assert.ok(!filterPatternToRegExp('v[12].x').test('v3.x'));
  // A dot in a pattern is a dot, not any-character.
  assert.ok(!filterPatternToRegExp('v1.2').test('v1x2'));
});

test('negations apply in order, and a list of only negations starts from everything', () => {
  assert.ok(matchFilterPatterns(['main'], 'main'));
  assert.ok(!matchFilterPatterns(['*', '!wip'], 'wip'));
  assert.ok(matchFilterPatterns(['*', '!wip', 'wip'], 'wip'));
  assert.ok(matchFilterPatterns(['!wip'], 'main'));
  assert.ok(!matchFilterPatterns(['!wip'], 'wip'));
});

test('branch filters do not fire on tag pushes, nor tag filters on branches', () => {
  assert.ok(pushMatches({ branches: ['main'] }, 'refs/heads/main', null));
  assert.ok(!pushMatches({ branches: ['main'] }, 'refs/heads/dev', null));
  assert.ok(!pushMatches({ branches: ['main'] }, 'refs/tags/v1', null));
  assert.ok(pushMatches({ tags: ['v*'] }, 'refs/tags/v1', null));
  assert.ok(!pushMatches({ tags: ['v*'] }, 'refs/heads/main', null));
  assert.ok(pushMatches({}, 'refs/heads/anything', null));
  assert.ok(!pushMatches({ branchesIgnore: ['wip/*'] }, 'refs/heads/wip/x', null));
});

test('path filters consult the changed files, and unknown changes count as matched', () => {
  const f = { branches: ['main'], paths: ['src/**'] };
  assert.ok(pushMatches(f, 'refs/heads/main', ['src/a.ts', 'docs/b.md']));
  assert.ok(!pushMatches(f, 'refs/heads/main', ['docs/b.md']));
  assert.ok(pushMatches(f, 'refs/heads/main', null));
  assert.ok(!pushMatches({ pathsIgnore: ['docs/**'] }, 'refs/heads/main', ['docs/a.md']));
  assert.ok(pushMatches({ pathsIgnore: ['docs/**'] }, 'refs/heads/main', ['docs/a.md', 'src/b.ts']));
});

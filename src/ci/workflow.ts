import * as YAML from 'yaml';

// Parsing and normalizing workflow files (.github/workflows/*.yml and
// .mochi/workflows/*.yml). The result is a plain-data Workflow that the
// planner turns into a run. Parsing is strict about shapes it understands and
// forgiving about keys it does not: unknown top-level or job keys are
// ignored, so a workflow using a feature we have not implemented degrades to
// a clear failure at the point where the feature would matter, not a parse
// error that hides the rest of the file.

export class WorkflowError extends Error {}

export interface PushFilter {
  branches?: string[];
  branchesIgnore?: string[];
  tags?: string[];
  tagsIgnore?: string[];
  paths?: string[];
  pathsIgnore?: string[];
}

export interface DispatchInput {
  description?: string;
  required: boolean;
  default?: string | boolean | number;
  type: 'string' | 'boolean' | 'choice' | 'number' | 'environment';
  options?: string[];
}

export interface Triggers {
  push?: PushFilter;
  workflowDispatch?: { inputs: Record<string, DispatchInput> };
  // Events we recognize in `on:` but do not fire yet. Kept so the UI can say
  // "this workflow also triggers on pull_request" rather than losing it.
  others: string[];
}

export interface WorkflowStep {
  id?: string;
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
  shell?: string;
  workingDirectory?: string;
  env: Record<string, string>;
  continueOnError?: string;
  timeoutMinutes?: string;
}

export interface WorkflowJob {
  key: string;
  name?: string; // may contain expressions
  needs: string[];
  runsOn: string[]; // entries may contain expressions
  if?: string;
  env: Record<string, string>;
  defaults?: { shell?: string; workingDirectory?: string };
  steps: WorkflowStep[];
  strategy?: { matrix?: unknown; failFast: boolean; maxParallel?: number };
  timeoutMinutes?: string;
  continueOnError?: string;
  outputs: Record<string, string>;
  // Set when the job uses a feature the engine cannot run yet; the planner
  // completes such a job as failed with this message instead of queuing it.
  unsupported?: string;
}

export interface Workflow {
  name: string | null;
  on: Triggers;
  env: Record<string, string>;
  concurrency?: { group: string; cancelInProgress: string };
  jobs: WorkflowJob[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asScalarString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function stringList(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.map((x) => asScalarString(x) ?? '').filter((s) => s !== '');
  return undefined;
}

function envMap(v: unknown, where: string): Record<string, string> {
  if (v === undefined) return {};
  if (!isObj(v)) throw new WorkflowError(`${where}: env must be a map`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    const s = asScalarString(val);
    if (s === undefined) throw new WorkflowError(`${where}: env value for ${k} must be a scalar`);
    out[k] = s;
  }
  return out;
}

function parsePushFilter(v: unknown): PushFilter {
  if (v === null || v === undefined) return {};
  if (!isObj(v)) return {};
  return {
    branches: stringList(v.branches),
    branchesIgnore: stringList(v['branches-ignore']),
    tags: stringList(v.tags),
    tagsIgnore: stringList(v['tags-ignore']),
    paths: stringList(v.paths),
    pathsIgnore: stringList(v['paths-ignore']),
  };
}

function parseDispatchInputs(v: unknown): Record<string, DispatchInput> {
  const out: Record<string, DispatchInput> = {};
  if (!isObj(v)) return out;
  const inputs = v.inputs;
  if (!isObj(inputs)) return out;
  for (const [name, def] of Object.entries(inputs)) {
    const d = isObj(def) ? def : {};
    const type = typeof d.type === 'string' ? d.type : 'string';
    out[name] = {
      description: asScalarString(d.description),
      required: d.required === true,
      default: typeof d.default === 'boolean' || typeof d.default === 'number' ? d.default : asScalarString(d.default),
      type: type === 'boolean' || type === 'choice' || type === 'number' || type === 'environment' ? type : 'string',
      options: stringList(d.options),
    };
  }
  return out;
}

function parseTriggers(v: unknown): Triggers {
  const t: Triggers = { others: [] };
  const add = (event: string, config: unknown) => {
    if (event === 'push') t.push = parsePushFilter(config);
    else if (event === 'workflow_dispatch') t.workflowDispatch = { inputs: parseDispatchInputs(config) };
    else t.others.push(event);
  };
  if (typeof v === 'string') {
    add(v, null);
  } else if (Array.isArray(v)) {
    for (const e of v) {
      if (typeof e === 'string') add(e, null);
    }
  } else if (isObj(v)) {
    for (const [e, c] of Object.entries(v)) add(e, c);
  } else {
    throw new WorkflowError('the workflow has no usable "on:" triggers');
  }
  return t;
}

function parseConcurrency(v: unknown): { group: string; cancelInProgress: string } | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'string') return { group: v, cancelInProgress: 'false' };
  if (isObj(v)) {
    const group = asScalarString(v.group);
    if (!group) throw new WorkflowError('concurrency needs a group');
    return { group, cancelInProgress: asScalarString(v['cancel-in-progress']) ?? 'false' };
  }
  throw new WorkflowError('invalid concurrency');
}

function parseStep(v: unknown, where: string): WorkflowStep {
  if (!isObj(v)) throw new WorkflowError(`${where}: each step must be a map`);
  const step: WorkflowStep = { env: envMap(v.env, where) };
  if (v.id !== undefined) step.id = asScalarString(v.id);
  if (v.name !== undefined) step.name = asScalarString(v.name);
  if (v.if !== undefined) step.if = asScalarString(v.if);
  if (v.run !== undefined) step.run = asScalarString(v.run);
  if (v.uses !== undefined) step.uses = asScalarString(v.uses);
  if (v.shell !== undefined) step.shell = asScalarString(v.shell);
  if (v['working-directory'] !== undefined) step.workingDirectory = asScalarString(v['working-directory']);
  if (v['continue-on-error'] !== undefined) step.continueOnError = asScalarString(v['continue-on-error']);
  if (v['timeout-minutes'] !== undefined) step.timeoutMinutes = asScalarString(v['timeout-minutes']);
  if (isObj(v.with)) {
    step.with = {};
    for (const [k, val] of Object.entries(v.with)) {
      const s = asScalarString(val);
      if (s !== undefined) step.with[k] = s;
    }
  }
  if (!step.run && !step.uses) throw new WorkflowError(`${where}: a step needs either "run" or "uses"`);
  if (step.run && step.uses) throw new WorkflowError(`${where}: a step cannot have both "run" and "uses"`);
  return step;
}

// Job ids become path segments under <repo>.runs/<n>/jobs/, so this is a
// containment check and not only a syntax one: a workflow is repository
// content, and a key like "../../x" must never reach a filesystem path.
// GitHub's own rule for job ids is the same shape.
const JOB_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function parseJob(key: string, v: unknown): WorkflowJob {
  if (!JOB_KEY.test(key) || key.length > 100) {
    throw new WorkflowError(
      `job id "${key.slice(0, 40)}" is not valid: it must start with a letter or underscore and contain only letters, digits, dashes, and underscores`
    );
  }
  if (!isObj(v)) throw new WorkflowError(`job ${key} must be a map`);
  const job: WorkflowJob = {
    key,
    needs: stringList(v.needs) ?? [],
    runsOn: [],
    env: envMap(v.env, `job ${key}`),
    steps: [],
    outputs: {},
  };
  if (v.name !== undefined) job.name = asScalarString(v.name);
  if (v.if !== undefined) job.if = asScalarString(v.if);
  if (v['timeout-minutes'] !== undefined) job.timeoutMinutes = asScalarString(v['timeout-minutes']);
  if (v['continue-on-error'] !== undefined) job.continueOnError = asScalarString(v['continue-on-error']);

  if (v.uses !== undefined) {
    job.unsupported = 'reusable workflows (jobs.<id>.uses) are not supported yet';
    return job;
  }
  if (v.container !== undefined) {
    job.unsupported = 'container jobs (jobs.<id>.container) are not supported yet';
    return job;
  }
  if (v.services !== undefined) {
    job.unsupported = 'service containers (jobs.<id>.services) are not supported yet';
    return job;
  }

  const runsOn = stringList(v['runs-on']);
  if (!runsOn || runsOn.length === 0) {
    // runs-on may also be {group, labels}; take the labels if so.
    const ro = v['runs-on'];
    const labels = isObj(ro) ? stringList(ro.labels) : undefined;
    if (!labels || labels.length === 0) throw new WorkflowError(`job ${key} has no runs-on`);
    job.runsOn = labels;
  } else {
    job.runsOn = runsOn;
  }

  if (isObj(v.defaults) && isObj(v.defaults.run)) {
    job.defaults = {
      shell: asScalarString(v.defaults.run.shell),
      workingDirectory: asScalarString(v.defaults.run['working-directory']),
    };
  }

  if (isObj(v.strategy)) {
    job.strategy = {
      matrix: v.strategy.matrix,
      failFast: v.strategy['fail-fast'] !== false && v.strategy['fail-fast'] !== 'false',
      maxParallel: typeof v.strategy['max-parallel'] === 'number' ? v.strategy['max-parallel'] : undefined,
    };
  }

  if (isObj(v.outputs)) {
    for (const [k, val] of Object.entries(v.outputs)) {
      const s = asScalarString(val);
      if (s !== undefined) job.outputs[k] = s;
    }
  }

  if (!Array.isArray(v.steps) || v.steps.length === 0) {
    throw new WorkflowError(`job ${key} has no steps`);
  }
  job.steps = v.steps.map((s, i) => parseStep(s, `job ${key}, step ${i + 1}`));
  return job;
}

export function parseWorkflow(source: string): Workflow {
  let doc: unknown;
  try {
    doc = YAML.parse(source);
  } catch (e) {
    throw new WorkflowError(`YAML parse error: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObj(doc)) throw new WorkflowError('the workflow file is not a YAML map');
  // YAML 1.1 reads a bare `on:` key as boolean true; the yaml package in core
  // schema keeps it as the string 'on' only when quoted. Handle both spellings.
  const onValue = 'on' in doc ? doc.on : (doc as Record<string, unknown>)['true'];
  if (onValue === undefined) throw new WorkflowError('the workflow has no "on:" triggers');
  const jobsRaw = doc.jobs;
  if (!isObj(jobsRaw) || Object.keys(jobsRaw).length === 0) {
    throw new WorkflowError('the workflow has no jobs');
  }
  const jobs = Object.entries(jobsRaw).map(([k, v]) => parseJob(k, v));
  const keys = new Set(jobs.map((j) => j.key));
  for (const j of jobs) {
    for (const n of j.needs) {
      if (!keys.has(n)) throw new WorkflowError(`job ${j.key} needs unknown job ${n}`);
    }
  }
  // There is no secrets store, deliberately: workflows here run without
  // credentials. A reference to one would evaluate to an empty string, and an
  // empty credential fails somewhere far from its cause -- a push that is
  // refused, an API that 401s mid-deploy -- so the reference is refused here,
  // where the message can say what is actually going on.
  const secretRef = source.match(/\$\{\{[^}]*\bsecrets\s*\.\s*([A-Za-z0-9_-]+)/);
  if (secretRef) {
    throw new WorkflowError(
      `the workflow references secrets.${secretRef[1]}, and this vault has no secrets: workflows run without ` +
        `credentials, so the value would silently be an empty string. Remove the reference, or run this job ` +
        `somewhere that holds the secret`
    );
  }
  return {
    name: asScalarString(doc.name) ?? null,
    on: parseTriggers(onValue),
    env: envMap(doc.env, 'workflow'),
    concurrency: parseConcurrency(doc.concurrency),
    jobs,
  };
}

// ---- filter-pattern matching (branches:, tags:, paths:) ----

// GitHub filter patterns: * matches within a path segment, ** across
// segments, ? one character, [] ranges, and a leading ! negates (applied in
// order, so a later pattern can re-include).
export function filterPatternToRegExp(pattern: string): RegExp {
  let rx = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` spans zero or more directories, so that dist/**/*.js matches
        // dist/a.js as well as dist/sub/b.js. A bare `**` matches anything.
        if (pattern[i + 2] === '/') {
          rx += '(?:.*/)?';
          i += 3;
        } else {
          rx += '.*';
          i += 2;
        }
      } else {
        rx += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      rx += '[^/]';
      i++;
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        rx += '\\[';
        i++;
      } else {
        rx += `[${pattern.slice(i + 1, end).replace(/\\/g, '\\\\')}]`;
        i = end + 1;
      }
    } else {
      rx += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${rx}$`);
}

export function matchFilterPatterns(patterns: string[], target: string): boolean {
  let matched = false;
  let sawPositive = false;
  for (const p of patterns) {
    if (p.startsWith('!')) {
      if (filterPatternToRegExp(p.slice(1)).test(target)) matched = false;
    } else {
      sawPositive = true;
      if (filterPatternToRegExp(p).test(target)) matched = true;
    }
  }
  // A list of only negations implicitly starts from "everything matches".
  if (!sawPositive) {
    matched = true;
    for (const p of patterns) {
      if (p.startsWith('!') && filterPatternToRegExp(p.slice(1)).test(target)) matched = false;
    }
  }
  return matched;
}

// Whether a push to `ref` (refs/heads/x or refs/tags/x) fires this
// workflow's push trigger. `changedPaths` is null when unknown (a brand-new
// branch), in which case a paths filter is treated as matched, as on GitHub.
export function pushMatches(f: PushFilter, ref: string, changedPaths: string[] | null): boolean {
  const isTag = ref.startsWith('refs/tags/');
  const short = ref.replace(/^refs\/(heads|tags)\//, '');
  if (isTag) {
    // With branch filters and no tag filters, tag pushes do not fire.
    if (!f.tags && !f.tagsIgnore) {
      if (f.branches || f.branchesIgnore) return false;
    } else {
      if (f.tags && !matchFilterPatterns(f.tags, short)) return false;
      if (f.tagsIgnore && matchFilterPatterns(f.tagsIgnore, short)) return false;
    }
  } else {
    if (!f.branches && !f.branchesIgnore) {
      if (f.tags || f.tagsIgnore) return false;
    } else {
      if (f.branches && !matchFilterPatterns(f.branches, short)) return false;
      if (f.branchesIgnore && matchFilterPatterns(f.branchesIgnore, short)) return false;
    }
  }
  if ((f.paths || f.pathsIgnore) && changedPaths !== null) {
    const considered = f.paths
      ? changedPaths.filter((p) => matchFilterPatterns(f.paths!, p))
      : changedPaths;
    const surviving = f.pathsIgnore
      ? considered.filter((p) => !matchFilterPatterns(f.pathsIgnore!, p))
      : considered;
    if (surviving.length === 0) return false;
  }
  return true;
}

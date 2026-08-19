import { ExprEnv, ExprValue } from '../ci/expr';
import { JobSpec } from '../ci/protocol';
import { WorkflowStep } from '../ci/workflow';

// The state and helpers shared by everything that executes inside a job:
// the container paths, the environment, the expression contexts, and the
// parsers for the two ways a step talks back to the runner (workflow commands
// on stdout, and the file commands).
//
// This module holds no I/O. It exists so that job.ts (orchestration) and
// steps.ts (execution, including recursion into composite actions) can share
// definitions without importing each other.

export const WORKSPACE = '/cofferdam/workspace';
export const RUNNER_TEMP = '/cofferdam/temp';
export const RUNNER_TOOL_CACHE = '/cofferdam/tools';
export const FILE_COMMAND_DIR = '/cofferdam/files';
export const ACTIONS_MOUNT = '/cofferdam/actions';

// How deep composite actions may nest before we call it a loop.
export const MAX_ACTION_DEPTH = 10;

// Values a step asks to be redacted (::add-mask::) are removed from every
// later log line. Masking happens on the runner, before a line is shipped, so
// an unmasked value never reaches the vault.
export class Masker {
  private values: string[] = [];

  add(value: string): void {
    const v = value.trim();
    if (v.length >= 4 && !this.values.includes(v)) this.values.push(v);
  }

  apply(line: string): string {
    let out = line;
    for (const v of this.values) out = out.split(v).join('***');
    return out;
  }
}

// Job-wide state that outlives any one step.
export interface JobRuntime {
  // Set by steps through GITHUB_ENV; visible to every later step.
  env: Record<string, string>;
  // Prepended to PATH, from GITHUB_PATH.
  extraPath: string[];
  summaries: string[];
  postHooks: PostHook[];
}

export interface PostHook {
  label: string;
  condition?: string;
  run: (jobFailed: boolean) => Promise<void>;
}

// A scope is one `steps` namespace: the job's own steps, or the steps inside
// one composite action. Composite steps see their own outputs and their
// action's inputs, not the caller's.
export interface Scope {
  outputs: Record<string, Record<string, string>>;
  conclusions: Record<string, { outcome: string; conclusion: string }>;
  inputs: Record<string, string>;
  // Container path of the running action's directory, for GITHUB_ACTION_PATH.
  actionPath?: string;
  // env declared by the composite action's own `env:`, if any.
  actionEnv: Record<string, string>;
  depth: number;
}

export function newScope(depth = 0): Scope {
  return { outputs: {}, conclusions: {}, inputs: {}, actionEnv: {}, depth };
}

export function baseEnv(spec: JobSpec): Record<string, string> {
  const gh = spec.github as Record<string, unknown>;
  const str = (k: string): string => {
    const v = gh[k];
    return v === undefined || v === null ? '' : String(v);
  };
  return {
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    COFFERDAM_ACTIONS: 'true',
    GITHUB_WORKFLOW: spec.workflowName,
    GITHUB_WORKFLOW_REF: str('workflow_ref'),
    GITHUB_RUN_ID: String(spec.runNumber),
    GITHUB_RUN_NUMBER: String(spec.runNumber),
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_JOB: spec.address.job,
    GITHUB_ACTION: '',
    GITHUB_ACTOR: str('actor'),
    GITHUB_TRIGGERING_ACTOR: str('triggering_actor'),
    GITHUB_REPOSITORY: str('repository'),
    GITHUB_REPOSITORY_OWNER: str('repository_owner'),
    GITHUB_EVENT_NAME: str('event_name'),
    GITHUB_EVENT_PATH: `${RUNNER_TEMP}/event.json`,
    GITHUB_REF: spec.ref,
    GITHUB_REF_NAME: spec.refName,
    GITHUB_REF_TYPE: str('ref_type'),
    GITHUB_SHA: spec.sha,
    GITHUB_WORKSPACE: WORKSPACE,
    GITHUB_SERVER_URL: str('server_url'),
    GITHUB_API_URL: str('api_url'),
    GITHUB_GRAPHQL_URL: '',
    GITHUB_RETENTION_DAYS: '90',
    RUNNER_OS: 'Linux',
    RUNNER_ARCH: process.arch === 'arm64' ? 'ARM64' : 'X64',
    RUNNER_NAME: 'cofferdam',
    RUNNER_TEMP,
    RUNNER_TOOL_CACHE,
    RUNNER_DEBUG: '0',
  };
}

export interface ContextArgs {
  spec: JobSpec;
  scope: Scope;
  stepEnv: Record<string, string>;
  jobFailed: boolean;
  jobCancelled: boolean;
}

export function contextsFor(args: ContextArgs): ExprEnv['contexts'] {
  const { spec, scope, stepEnv } = args;
  const steps: Record<string, ExprValue> = {};
  const ids = new Set([...Object.keys(scope.outputs), ...Object.keys(scope.conclusions)]);
  for (const id of ids) {
    steps[id] = {
      outputs: (scope.outputs[id] ?? {}) as ExprValue,
      outcome: scope.conclusions[id]?.outcome ?? 'success',
      conclusion: scope.conclusions[id]?.conclusion ?? 'success',
    };
  }
  const github = { ...(spec.github as Record<string, ExprValue>) };
  github.workspace = WORKSPACE;
  if (scope.actionPath !== undefined) github.action_path = scope.actionPath;
  return {
    github: github as ExprValue,
    env: stepEnv as ExprValue,
    job: { status: args.jobFailed ? 'failure' : 'success', container: {}, services: {} },
    runner: {
      os: 'Linux',
      arch: process.arch === 'arm64' ? 'ARM64' : 'X64',
      name: 'cofferdam',
      temp: RUNNER_TEMP,
      tool_cache: RUNNER_TOOL_CACHE,
      debug: '0',
      environment: 'self-hosted',
    },
    strategy: spec.strategy
      ? {
          'fail-fast': spec.strategy.failFast,
          'job-index': spec.strategy.jobIndex,
          'job-total': spec.strategy.jobTotal,
        }
      : {},
    matrix: (spec.matrix ?? {}) as ExprValue,
    needs: spec.needs as unknown as ExprValue,
    // Inside a composite action `inputs` is the action's inputs; at job level
    // it is the workflow_dispatch inputs.
    inputs: (scope.depth > 0 ? scope.inputs : ((spec.inputs ?? {}) as Record<string, unknown>)) as ExprValue,
    vars: {},
    secrets: {},
    steps: steps as ExprValue,
  };
}

export function statusFunctions(jobFailed: boolean, jobCancelled: boolean): ExprEnv['functions'] {
  return {
    success: () => !jobFailed && !jobCancelled,
    failure: () => jobFailed && !jobCancelled,
    cancelled: () => jobCancelled,
    always: () => true,
  };
}

// The shell a `run:` step uses. GitHub's default on Linux is bash with -e,
// and an explicit `bash` adds -o pipefail; the distinction is preserved
// because workflows depend on it.
export function shellCommand(shell: string | undefined, scriptPath: string): string[] {
  const s = (shell ?? 'default').toLowerCase();
  if (s === 'bash') return ['bash', '--noprofile', '--norc', '-eo', 'pipefail', scriptPath];
  if (s === 'sh') return ['sh', '-e', scriptPath];
  if (s === 'default') return ['bash', '-e', scriptPath];
  if (s === 'python') return ['python3', scriptPath];
  if (s.includes('{0}')) {
    const parts = s.split(/\s+/).map((p) => (p === '{0}' ? scriptPath : p));
    return parts;
  }
  return [s, scriptPath];
}

// A step's display name. Expressions are resolved before the text is cut to
// length, since truncating first would leave a torn `${{` that then fails to
// render and shows the reader the raw expression instead of its value.
export function stepLabel(step: WorkflowStep, index: number, resolve?: (s: string) => string): string {
  const r = (s: string): string => {
    if (!resolve) return s;
    try {
      return resolve(s);
    } catch {
      return s;
    }
  };
  if (step.name) return r(step.name);
  if (step.uses) return step.uses;
  if (step.run) {
    const firstLine = r(step.run).split('\n').find((l) => l.trim() !== '') ?? '';
    const trimmed = firstLine.trim();
    return `Run ${trimmed.length > 70 ? trimmed.slice(0, 70) + '…' : trimmed}`;
  }
  return `Step ${index + 1}`;
}

// ---- workflow commands ----

export interface WorkflowCommand {
  name: string;
  props: Record<string, string>;
  message: string;
}

// ::name key=value,key=value::message, with the documented escapes. The older
// ##[name]message spelling is accepted too, since actions still emit it (the
// problem-matcher commands, for instance).
export function parseWorkflowCommand(line: string): WorkflowCommand | null {
  const hash = line.match(/^\s*##\[([A-Za-z-]+)\]([\s\S]*)$/);
  if (hash) return { name: hash[1].toLowerCase(), props: {}, message: hash[2] };
  const m = line.match(/^\s*::([A-Za-z-]+)(\s+(.*?))?::([\s\S]*)$/);
  if (!m) {
    const bare = line.match(/^\s*::([A-Za-z-]+)::$/);
    if (bare) return { name: bare[1].toLowerCase(), props: {}, message: '' };
    return null;
  }
  const props: Record<string, string> = {};
  if (m[3]) {
    for (const pair of m[3].split(',')) {
      const i = pair.indexOf('=');
      if (i === -1) continue;
      props[pair.slice(0, i).trim()] = unescapeProperty(pair.slice(i + 1));
    }
  }
  return { name: m[1].toLowerCase(), props, message: unescapeData(m[4]) };
}

function unescapeData(s: string): string {
  return s.replace(/%25/g, '%').replace(/%0D/g, '\r').replace(/%0A/g, '\n');
}

function unescapeProperty(s: string): string {
  return unescapeData(s).replace(/%3A/g, ':').replace(/%2C/g, ',');
}

// The GITHUB_OUTPUT / GITHUB_ENV format: `key=value` lines, plus the heredoc
// form for values containing newlines:
//
//   key<<EOF
//   line one
//   EOF
export function parseKeyValueFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const heredoc = line.match(/^([^=<]+)<<(\S+)\s*$/);
    if (heredoc) {
      const key = heredoc[1].trim();
      const delim = heredoc[2];
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== delim) {
        body.push(lines[i]);
        i++;
      }
      out[key] = body.join('\n');
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return out;
}

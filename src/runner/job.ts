import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { ExprEnv, ExprValue, evalCondition, render, renderDeep, stringify } from '../ci/expr';
import { JobSpec } from '../ci/protocol';
import { Conclusion, StepState } from '../ci/runs';
import { WorkflowStep } from '../ci/workflow';
import {
  execInContainer,
  imagePresent,
  pullImage,
  readFileInContainer,
  removeContainer,
  startContainer,
  writeFileInContainer,
} from './docker';

// Executing one job. The runner owns everything below the job boundary:
// resolving step expressions, running each step in the job's container,
// interpreting the workflow commands a step writes, and deciding the job's
// conclusion. The server planned the job and will record the result.

const WORKSPACE = '/hubbit/workspace';
const RUNNER_TEMP = '/hubbit/temp';
const RUNNER_TOOL_CACHE = '/hubbit/tools';
const FILE_COMMAND_DIR = '/hubbit/files';

export interface JobHooks {
  log: (stepIndex: number, line: string) => void;
  progress: (steps: StepState[]) => void;
  cancelled: () => boolean;
}

export interface RunnerContext {
  imageFor: (labels: string[]) => string;
  cloneUrl: (collection: string, repo: string) => string;
  workDir: string;
  network?: string;
}

export interface JobResult {
  conclusion: Conclusion;
  steps: StepState[];
  outputs: Record<string, string>;
  summaries: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function execFileAsync(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim()));
      else resolve(stdout.toString());
    });
  });
}

// Secrets are not implemented yet, but masking is: anything a step adds with
// ::add-mask:: is redacted from every later log line, since a step that
// prints a token it derived at runtime is the common case even without a
// secrets store.
class Masker {
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

interface StepRuntime {
  outputs: Record<string, Record<string, string>>; // by step id
  conclusions: Record<string, { outcome: string; conclusion: string }>;
  env: Record<string, string>;
  extraPath: string[];
  summaries: string[];
}

function baseEnv(spec: JobSpec): Record<string, string> {
  const gh = spec.github as Record<string, unknown>;
  const str = (k: string): string => {
    const v = gh[k];
    return v === undefined || v === null ? '' : String(v);
  };
  return {
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    HUBBIT_ACTIONS: 'true',
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
    RUNNER_NAME: 'hubbit',
    RUNNER_TEMP,
    RUNNER_TOOL_CACHE,
    RUNNER_DEBUG: '0',
  };
}

function contextsFor(spec: JobSpec, rt: StepRuntime, stepEnv: Record<string, string>): ExprEnv['contexts'] {
  const steps: Record<string, ExprValue> = {};
  for (const [id, outputs] of Object.entries(rt.outputs)) {
    steps[id] = {
      outputs: outputs as ExprValue,
      outcome: rt.conclusions[id]?.outcome ?? 'success',
      conclusion: rt.conclusions[id]?.conclusion ?? 'success',
    };
  }
  for (const [id, c] of Object.entries(rt.conclusions)) {
    if (!steps[id]) steps[id] = { outputs: {}, outcome: c.outcome, conclusion: c.conclusion };
  }
  return {
    github: spec.github as ExprValue,
    env: stepEnv as ExprValue,
    job: { status: 'success', container: {}, services: {} },
    runner: {
      os: 'Linux',
      arch: process.arch === 'arm64' ? 'ARM64' : 'X64',
      name: 'hubbit',
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
    inputs: (spec.inputs ?? {}) as ExprValue,
    vars: {},
    secrets: {},
    steps: steps as ExprValue,
  };
}

// The shell a `run:` step uses. GitHub's default on Linux is bash with -e,
// and `bash` explicitly adds -o pipefail; the distinction is preserved
// because workflows depend on it.
function shellCommand(shell: string | undefined, scriptPath: string): string[] {
  const s = (shell ?? 'default').toLowerCase();
  if (s === 'bash') return ['bash', '--noprofile', '--norc', '-eo', 'pipefail', scriptPath];
  if (s === 'sh') return ['sh', '-e', scriptPath];
  if (s === 'default') return ['bash', '-e', scriptPath];
  if (s === 'python') return ['python3', scriptPath];
  if (s.includes('{0}')) {
    // A custom shell template, e.g. `perl {0}`.
    const parts = s.split(/\s+/).map((p) => (p === '{0}' ? scriptPath : p));
    return parts;
  }
  return [s, scriptPath];
}

// A step's display name. Expressions are resolved before the text is cut to
// length, since truncating first would leave a torn `${{` that then fails to
// render and shows the reader the raw expression instead of its value.
function stepLabel(step: WorkflowStep, index: number, resolve?: (s: string) => string): string {
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

export async function runJob(spec: JobSpec, ctx: RunnerContext, hooks: JobHooks): Promise<JobResult> {
  const image = ctx.imageFor(spec.runsOn);
  const masker = new Masker();
  const stepStates: StepState[] = spec.steps.map((s, i) => ({
    name: stepLabel(s, i),
    status: 'pending',
  }));
  const rt: StepRuntime = { outputs: {}, conclusions: {}, env: {}, extraPath: [], summaries: [] };

  // Step index -1 carries the runner's own setup and teardown messages, so a
  // failure before the first step still has somewhere to be reported.
  const setupIndex = -1;
  const log = (i: number, line: string) => hooks.log(i, masker.apply(line));

  const hostWork = fs.mkdtempSync(path.join(ctx.workDir, 'job-'));
  const hostRepo = path.join(hostWork, 'workspace');
  const hostTemp = path.join(hostWork, 'temp');
  const hostFiles = path.join(hostWork, 'files');
  fs.mkdirSync(hostRepo, { recursive: true });
  fs.mkdirSync(hostTemp, { recursive: true });
  fs.mkdirSync(hostFiles, { recursive: true });

  let containerId: string | null = null;
  const finish = async (conclusion: Conclusion): Promise<JobResult> => {
    if (containerId) {
      log(setupIndex, 'Cleaning up the job container');
      await removeContainer(containerId);
    }
    try {
      fs.rmSync(hostWork, { recursive: true, force: true });
    } catch {
      // a leftover directory is not worth failing the job over
    }
    return {
      conclusion,
      steps: stepStates,
      outputs: resolveJobOutputs(spec, rt),
      summaries: rt.summaries,
    };
  };

  try {
    // ---- the workspace ----
    //
    // hubbit checks the repository out before the job starts, rather than
    // leaving an empty workspace for actions/checkout to fill. This is a
    // deliberate divergence from GitHub: it makes `run:` steps useful
    // without action support, and it keeps behavior identical once actions
    // arrive, when checkout becomes a re-sync rather than the first clone.
    log(setupIndex, `Job ${spec.name} on ${spec.runsOn.join(', ')}`);
    log(setupIndex, `Checking out ${spec.github.repository} at ${spec.sha.slice(0, 8)}`);
    const url = ctx.cloneUrl(spec.address.collection, spec.address.repo);
    await execFileAsync('git', ['init', '--quiet', hostRepo]);
    await execFileAsync('git', ['-C', hostRepo, 'remote', 'add', 'origin', url]);
    await execFileAsync('git', ['-C', hostRepo, 'fetch', '--quiet', '--depth', '1', 'origin', spec.sha]);
    await execFileAsync('git', ['-C', hostRepo, 'checkout', '--quiet', 'FETCH_HEAD']);

    fs.writeFileSync(path.join(hostTemp, 'event.json'), JSON.stringify(spec.github.event ?? {}, null, 1));

    // ---- the container ----
    if (!(await imagePresent(image))) {
      log(setupIndex, `Pulling ${image}`);
      await pullImage(image, (l) => log(setupIndex, l));
    }
    const env = baseEnv(spec);
    containerId = await startContainer({
      image,
      name: `hubbit-${spec.address.collection}-${spec.address.repo}-${spec.runNumber}-${spec.address.job}-${crypto
        .randomBytes(4)
        .toString('hex')}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '-'),
      binds: [
        { host: hostRepo, container: WORKSPACE },
        { host: hostTemp, container: RUNNER_TEMP },
        { host: hostFiles, container: FILE_COMMAND_DIR },
      ],
      env,
      workdir: WORKSPACE,
      network: ctx.network,
    });
    await execInContainer(containerId, ['mkdir', '-p', RUNNER_TOOL_CACHE], () => {}).done;
    log(setupIndex, `Container started from ${image}`);

    // ---- the steps ----
    let failed = false;
    let cancelled = false;

    for (let i = 0; i < spec.steps.length; i++) {
      const step = spec.steps[i];
      const state = stepStates[i];

      if (hooks.cancelled()) cancelled = true;

      // Env visible to this step's expressions: workflow and job env, then
      // whatever earlier steps exported through GITHUB_ENV, then step env.
      let stepEnv: Record<string, string> = { ...env };
      const evalEnv = (): ExprEnv => ({
        contexts: contextsFor(spec, rt, stepEnv),
        functions: {
          success: () => !failed && !cancelled,
          failure: () => failed && !cancelled,
          cancelled: () => cancelled,
          always: () => true,
        },
      });

      try {
        // Only the env written in the workflow file is a template. Values a
        // previous step exported through GITHUB_ENV are data, and evaluating
        // `${{ }}` found in them would let a step's output become an
        // expression evaluated in this step's context.
        const templated = renderDeep({ ...spec.env, ...step.env }, {
          contexts: contextsFor(spec, rt, { ...env, ...rt.env }),
        }) as Record<string, ExprValue>;
        stepEnv = { ...env, ...rt.env };
        for (const k of Object.keys(spec.env)) {
          if (k in templated) stepEnv[k] = stringify(templated[k]);
        }
        for (const [k, v] of Object.entries(rt.env)) stepEnv[k] = v;
        for (const k of Object.keys(step.env)) {
          if (k in templated) stepEnv[k] = stringify(templated[k]);
        }
      } catch (e) {
        log(i, `Error evaluating env: ${e instanceof Error ? e.message : String(e)}`);
        state.status = 'completed';
        state.conclusion = 'failure';
        failed = true;
        hooks.progress(stepStates);
        continue;
      }

      // Whether to run at all: the default gate is "nothing has failed", and
      // an explicit `if` replaces it.
      let shouldRun: boolean;
      try {
        shouldRun = step.if === undefined ? !failed && !cancelled : evalCondition(step.if, evalEnv());
      } catch (e) {
        log(i, `Error evaluating if: ${e instanceof Error ? e.message : String(e)}`);
        state.status = 'completed';
        state.conclusion = 'failure';
        failed = true;
        hooks.progress(stepStates);
        continue;
      }
      if (!shouldRun) {
        state.status = 'completed';
        state.conclusion = 'skipped';
        if (step.id) rt.conclusions[step.id] = { outcome: 'skipped', conclusion: 'skipped' };
        hooks.progress(stepStates);
        continue;
      }

      state.status = 'running';
      state.startedAt = nowIso();
      state.name = stepLabel(step, i, (text) => render(text, evalEnv()));
      hooks.progress(stepStates);
      log(i, `▸ ${state.name}`);

      if (step.uses) {
        // Actions are the next phase. Failing loudly beats pretending to
        // succeed: a workflow whose build step is an action would otherwise
        // "pass" having done nothing.
        log(i, `Steps that use an action are not supported yet: uses: ${step.uses}`);
        log(i, 'Rewrite this step as a run: step, or wait for action support.');
        state.status = 'completed';
        state.conclusion = 'failure';
        state.completedAt = nowIso();
        failed = true;
        hooks.progress(stepStates);
        continue;
      }

      const outcome = await runShellStep(containerId, spec, step, i, stepEnv, rt, {
        log: (line) => log(i, line),
        masker,
        evalEnv,
      });

      state.completedAt = nowIso();
      state.status = 'completed';

      let continued = false;
      if (!outcome.ok && step.continueOnError !== undefined) {
        try {
          continued = evalCondition(step.continueOnError, evalEnv());
        } catch {
          continued = false;
        }
      }
      state.conclusion = outcome.ok ? 'success' : continued ? 'success' : 'failure';
      if (step.id) {
        rt.conclusions[step.id] = {
          outcome: outcome.ok ? 'success' : 'failure',
          conclusion: state.conclusion,
        };
      }
      if (!outcome.ok && !continued) failed = true;
      hooks.progress(stepStates);

      if (hooks.cancelled()) {
        cancelled = true;
        log(setupIndex, 'Cancellation requested; stopping after this step');
        break;
      }
    }

    if (cancelled) return await finish('cancelled');
    return await finish(failed ? 'failure' : 'success');
  } catch (e) {
    log(setupIndex, `Job failed to run: ${e instanceof Error ? e.message : String(e)}`);
    return await finish(hooks.cancelled() ? 'cancelled' : 'failure');
  }
}

function resolveJobOutputs(spec: JobSpec, rt: StepRuntime): Record<string, string> {
  const out: Record<string, string> = {};
  if (Object.keys(spec.outputsTemplate).length === 0) return out;
  const env: ExprEnv = { contexts: contextsFor(spec, rt, {}) };
  for (const [k, template] of Object.entries(spec.outputsTemplate)) {
    try {
      out[k] = render(template, env);
    } catch {
      out[k] = '';
    }
  }
  return out;
}

interface ShellHooks {
  log: (line: string) => void;
  masker: Masker;
  evalEnv: () => ExprEnv;
}

async function runShellStep(
  containerId: string,
  spec: JobSpec,
  step: WorkflowStep,
  index: number,
  stepEnv: Record<string, string>,
  rt: StepRuntime,
  hooks: ShellHooks
): Promise<{ ok: boolean }> {
  let script: string;
  try {
    script = render(step.run ?? '', hooks.evalEnv());
  } catch (e) {
    hooks.log(`Error evaluating the step body: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false };
  }

  // The file commands: each step gets fresh files, and whatever it appends
  // to them is read back afterwards. This is the modern replacement for the
  // ::set-output:: and ::set-env:: stdout commands, and is what
  // @actions/core writes to.
  const tag = `${index}-${crypto.randomBytes(4).toString('hex')}`;
  const files = {
    output: `${FILE_COMMAND_DIR}/output-${tag}`,
    envFile: `${FILE_COMMAND_DIR}/env-${tag}`,
    pathFile: `${FILE_COMMAND_DIR}/path-${tag}`,
    summary: `${FILE_COMMAND_DIR}/summary-${tag}`,
    state: `${FILE_COMMAND_DIR}/state-${tag}`,
  };
  const scriptPath = `${FILE_COMMAND_DIR}/step-${tag}`;

  const shell = step.shell ?? spec.defaults?.shell;
  await writeFileInContainer(containerId, scriptPath, script.endsWith('\n') ? script : script + '\n');
  for (const f of Object.values(files)) await writeFileInContainer(containerId, f, '');

  let workdir = WORKSPACE;
  const wd = step.workingDirectory ?? spec.defaults?.workingDirectory;
  if (wd) {
    try {
      const rendered = render(wd, hooks.evalEnv());
      workdir = rendered.startsWith('/') ? rendered : `${WORKSPACE}/${rendered}`;
    } catch {
      // keep the workspace root
    }
  }

  const pathPrefix = rt.extraPath.length ? rt.extraPath.join(':') + ':' : '';
  const env: Record<string, string> = {
    ...stepEnv,
    GITHUB_OUTPUT: files.output,
    GITHUB_ENV: files.envFile,
    GITHUB_PATH: files.pathFile,
    GITHUB_STEP_SUMMARY: files.summary,
    GITHUB_STATE: files.state,
    GITHUB_ACTION: step.id ?? `__run_${index}`,
  };
  if (pathPrefix) env.PATH = `${pathPrefix}${stepEnv.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}`;

  let inGroup = false;
  const onLine = (raw: string) => {
    const cmd = parseWorkflowCommand(raw);
    if (!cmd) {
      hooks.log(raw);
      return;
    }
    switch (cmd.name) {
      case 'add-mask':
        hooks.masker.add(cmd.message);
        break;
      case 'group':
        inGroup = true;
        hooks.log(`▾ ${cmd.message}`);
        break;
      case 'endgroup':
        inGroup = false;
        break;
      case 'error':
      case 'warning':
      case 'notice': {
        const where = cmd.props.file ? ` (${cmd.props.file}${cmd.props.line ? `:${cmd.props.line}` : ''})` : '';
        hooks.log(`${cmd.name.toUpperCase()}${where}: ${cmd.message}`);
        break;
      }
      case 'debug':
        hooks.log(`DEBUG: ${cmd.message}`);
        break;
      case 'set-output':
        // The deprecated stdout form, still emitted by older tooling.
        if (step.id && cmd.props.name) {
          rt.outputs[step.id] = { ...(rt.outputs[step.id] ?? {}), [cmd.props.name]: cmd.message };
        }
        break;
      case 'echo':
      case 'save-state':
      case 'set-env':
      case 'add-path':
      case 'stop-commands':
        break;
      default:
        hooks.log(raw);
    }
    void inGroup;
  };

  const handle = execInContainer(containerId, shellCommand(shell, scriptPath), onLine, {
    workdir,
    env,
  });
  const code = await handle.done;

  // Read back what the step wrote to the file commands.
  const outputText = await readFileInContainer(containerId, files.output);
  const parsedOutputs = parseKeyValueFile(outputText);
  if (step.id && Object.keys(parsedOutputs).length) {
    rt.outputs[step.id] = { ...(rt.outputs[step.id] ?? {}), ...parsedOutputs };
  }
  const envText = await readFileInContainer(containerId, files.envFile);
  Object.assign(rt.env, parseKeyValueFile(envText));
  const pathText = await readFileInContainer(containerId, files.pathFile);
  for (const line of pathText.split('\n')) {
    const p = line.trim();
    if (p !== '' && !rt.extraPath.includes(p)) rt.extraPath.unshift(p);
  }
  const summaryText = await readFileInContainer(containerId, files.summary);
  if (summaryText.trim() !== '') rt.summaries.push(summaryText);

  if (code !== 0) hooks.log(`Process completed with exit code ${code}.`);
  return { ok: code === 0 };
}

// ---- workflow commands ----

export interface WorkflowCommand {
  name: string;
  props: Record<string, string>;
  message: string;
}

// ::name key=value,key=value::message, with the documented escapes.
export function parseWorkflowCommand(line: string): WorkflowCommand | null {
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

// The GITHUB_OUTPUT / GITHUB_ENV format: `key=value` lines, plus the
// heredoc form for values containing newlines:
//
//   key<<EOF
//   line one
//   line two
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

export function defaultWorkDir(): string {
  const dir = path.join(os.tmpdir(), 'hubbit-runner');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

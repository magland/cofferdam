import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';
import { ActionRef, actionCacheKey, refIsImmutable } from '../ci/actionref';
import { WorkflowStep } from '../ci/workflow';

// Fetching actions and reading their definitions. Actions come from a forge
// over HTTPS (github.com by default) as a source tarball, and are cached on
// the runner's disk so a repeated job does not re-download them.
//
// Nothing here executes anything: the store hands back a directory and a
// parsed action.yml, and steps.ts decides what to do with them.

export class ActionError extends Error {}

export interface ActionInput {
  default?: string;
  required: boolean;
  description?: string;
}

export interface CompositeStep extends WorkflowStep {
  // Composite steps carry the same shape as workflow steps; `shell` is
  // required by GitHub for `run` steps here, and we keep that requirement
  // because a composite that omits it behaves differently on every runner.
  with?: Record<string, string>;
}

export interface ActionDef {
  name?: string;
  description?: string;
  inputs: Record<string, ActionInput>;
  outputs: Record<string, { value?: string; description?: string }>;
  runs:
    | { using: 'node'; nodeMajor: number; main: string; pre?: string; preIf?: string; post?: string; postIf?: string }
    | { using: 'composite'; steps: CompositeStep[] }
    | { using: 'docker'; image: string; entrypoint?: string; args?: string[]; env?: Record<string, string> };
}

export interface ResolvedAction {
  // Where the action's files are on the runner's disk.
  dir: string;
  def: ActionDef;
  key: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

export function parseActionDef(source: string, where: string): ActionDef {
  let doc: unknown;
  try {
    doc = YAML.parse(source);
  } catch (e) {
    throw new ActionError(`${where}: could not parse action.yml: ${e instanceof Error ? e.message : e}`);
  }
  if (!isObj(doc)) throw new ActionError(`${where}: action.yml is not a YAML map`);
  const runsRaw = doc.runs;
  if (!isObj(runsRaw)) throw new ActionError(`${where}: action.yml has no "runs"`);
  const using = asString(runsRaw.using);
  if (!using) throw new ActionError(`${where}: action.yml has no "runs.using"`);

  const inputs: Record<string, ActionInput> = {};
  if (isObj(doc.inputs)) {
    for (const [name, def] of Object.entries(doc.inputs)) {
      const d = isObj(def) ? def : {};
      inputs[name] = {
        default: asString(d.default),
        required: d.required === true,
        description: asString(d.description),
      };
    }
  }
  const outputs: Record<string, { value?: string; description?: string }> = {};
  if (isObj(doc.outputs)) {
    for (const [name, def] of Object.entries(doc.outputs)) {
      const d = isObj(def) ? def : {};
      outputs[name] = { value: asString(d.value), description: asString(d.description) };
    }
  }

  const name = asString(doc.name);
  const description = asString(doc.description);

  const nodeMatch = using.match(/^node(\d+)$/);
  if (nodeMatch) {
    const main = asString(runsRaw.main);
    if (!main) throw new ActionError(`${where}: a ${using} action needs "runs.main"`);
    return {
      name,
      description,
      inputs,
      outputs,
      runs: {
        using: 'node',
        nodeMajor: parseInt(nodeMatch[1], 10),
        main,
        pre: asString(runsRaw.pre),
        preIf: asString(runsRaw['pre-if']),
        post: asString(runsRaw.post),
        postIf: asString(runsRaw['post-if']),
      },
    };
  }

  if (using === 'composite') {
    const stepsRaw = runsRaw.steps;
    if (!Array.isArray(stepsRaw)) throw new ActionError(`${where}: a composite action needs "runs.steps"`);
    const steps: CompositeStep[] = stepsRaw.map((s, i) => {
      if (!isObj(s)) throw new ActionError(`${where}: composite step ${i + 1} is not a map`);
      const step: CompositeStep = { env: {} };
      if (isObj(s.env)) {
        for (const [k, v] of Object.entries(s.env)) {
          const val = asString(v);
          if (val !== undefined) step.env[k] = val;
        }
      }
      step.id = asString(s.id);
      step.name = asString(s.name);
      step.if = asString(s.if);
      step.run = asString(s.run);
      step.uses = asString(s.uses);
      step.shell = asString(s.shell);
      step.workingDirectory = asString(s['working-directory']);
      step.continueOnError = asString(s['continue-on-error']);
      if (isObj(s.with)) {
        step.with = {};
        for (const [k, v] of Object.entries(s.with)) {
          const val = asString(v);
          if (val !== undefined) step.with[k] = val;
        }
      }
      if (!step.run && !step.uses) {
        throw new ActionError(`${where}: composite step ${i + 1} needs "run" or "uses"`);
      }
      if (step.run && !step.shell) {
        // GitHub requires this and it is worth keeping: a composite whose
        // shell depends on the caller's defaults behaves differently
        // depending on who calls it.
        throw new ActionError(`${where}: composite step ${i + 1} has "run" but no "shell"`);
      }
      return step;
    });
    return { name, description, inputs, outputs, runs: { using: 'composite', steps } };
  }

  if (using === 'docker') {
    const image = asString(runsRaw.image);
    if (!image) throw new ActionError(`${where}: a docker action needs "runs.image"`);
    const env: Record<string, string> = {};
    if (isObj(runsRaw.env)) {
      for (const [k, v] of Object.entries(runsRaw.env)) {
        const val = asString(v);
        if (val !== undefined) env[k] = val;
      }
    }
    return {
      name,
      description,
      inputs,
      outputs,
      runs: {
        using: 'docker',
        image,
        entrypoint: asString(runsRaw.entrypoint),
        args: Array.isArray(runsRaw.args)
          ? runsRaw.args.map((a) => asString(a) ?? '').filter((a) => a !== '')
          : undefined,
        env,
      },
    };
  }

  throw new ActionError(`${where}: unsupported "runs.using": ${using}`);
}

function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new ActionError((stderr || err.message).toString().trim()));
      else resolve(stdout.toString());
    });
  });
}

export function defaultActionCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
  return path.join(base, 'hubbit', 'actions');
}

// A cached branch checkout goes stale, since a branch moves. A sha never
// does, and a tag is treated as immutable by convention (GitHub's own action
// tags are moved occasionally, which this deliberately does not chase; pin a
// sha if that matters to you).
const STALE_MS = 24 * 60 * 60 * 1000;

export class ActionStore {
  constructor(
    private cacheDir: string = defaultActionCacheDir(),
    private forgeUrl: string = process.env.HUBBIT_ACTIONS_URL ?? 'https://github.com'
  ) {}

  // Fetch (or reuse) an action's source and read its definition. The
  // workspace path is needed for local (`./…`) actions, which live in the
  // repository being built rather than being downloaded.
  async resolve(
    ref: ActionRef,
    workspaceDir: string,
    onLine: (line: string) => void
  ): Promise<ResolvedAction> {
    const key = actionCacheKey(ref);
    if (ref.kind === 'docker') {
      throw new ActionError(
        `docker actions are not supported yet (uses: ${ref.raw}); rewrite the step as a run: step or use a JavaScript or composite action`
      );
    }
    if (ref.kind === 'local') {
      const dir = path.join(workspaceDir, ref.path);
      const real = fs.realpathSync(dir);
      const wsReal = fs.realpathSync(workspaceDir);
      if (real !== wsReal && !real.startsWith(wsReal + path.sep)) {
        throw new ActionError(`local action ${ref.raw} resolves outside the workspace`);
      }
      return { dir, def: this.readDef(dir, ref.raw), key };
    }

    const dest = path.join(this.cacheDir, key);
    const stamp = path.join(dest, '.hubbit-fetched');
    let fresh = false;
    try {
      const age = Date.now() - fs.statSync(stamp).mtimeMs;
      fresh = refIsImmutable(ref) || age < STALE_MS;
    } catch {
      fresh = false;
    }
    if (!fresh) {
      onLine(`Downloading ${ref.owner}/${ref.repo}@${ref.ref}`);
      await this.download(ref, dest);
      fs.writeFileSync(stamp, new Date().toISOString());
    }
    const dir = ref.subpath ? path.join(dest, ref.subpath) : dest;
    if (!fs.existsSync(dir)) {
      throw new ActionError(`${ref.raw}: ${ref.subpath || '.'} does not exist in ${ref.owner}/${ref.repo}@${ref.ref}`);
    }
    return { dir, def: this.readDef(dir, ref.raw), key };
  }

  private readDef(dir: string, where: string): ActionDef {
    for (const name of ['action.yml', 'action.yaml']) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return parseActionDef(fs.readFileSync(file, 'utf8'), where);
    }
    throw new ActionError(`${where}: no action.yml or action.yaml in the action directory`);
  }

  private async download(
    ref: Extract<ActionRef, { kind: 'repo' }>,
    dest: string
  ): Promise<void> {
    const url = `${this.forgeUrl.replace(/\/+$/, '')}/${ref.owner}/${ref.repo}/archive/${encodeURIComponent(
      ref.ref
    )}.tar.gz`;
    let res: Response;
    try {
      res = await fetch(url, { redirect: 'follow' });
    } catch (e) {
      throw new ActionError(`could not fetch ${ref.raw}: ${e instanceof Error ? e.message : e}`);
    }
    if (!res.ok) {
      throw new ActionError(
        `could not fetch ${ref.raw}: ${url} answered ${res.status}${
          res.status === 404 ? ' (check the owner, repository, and ref)' : ''
        }`
      );
    }
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const tarball = path.join(tmp, 'source.tar.gz');
    fs.writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
    const extracted = path.join(tmp, 'src');
    fs.mkdirSync(extracted);
    try {
      // The archive holds a single top-level directory named for the repo and
      // ref, which --strip-components removes.
      await run('tar', ['-xzf', tarball, '-C', extracted, '--strip-components=1']);
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new ActionError(`could not unpack ${ref.raw}: ${e instanceof Error ? e.message : e}`);
    }
    fs.rmSync(tarball, { force: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(extracted, dest);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Turn an action's declared inputs plus a step's `with:` into the INPUT_*
// environment an action reads. GitHub uppercases the name and replaces
// spaces with underscores, and leaves everything else alone.
export function inputEnvName(name: string): string {
  return `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
}

export function resolveInputs(
  def: ActionDef,
  provided: Record<string, string>
): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const [name, spec] of Object.entries(def.inputs)) {
    if (provided[name] !== undefined) values[name] = provided[name];
    else if (spec.default !== undefined) values[name] = spec.default;
    else if (spec.required) missing.push(name);
  }
  // Inputs a step passes that the action does not declare are still exported,
  // which matches the runner's behavior and is relied on by actions that read
  // undeclared inputs.
  for (const [name, value] of Object.entries(provided)) {
    if (values[name] === undefined) values[name] = value;
  }
  return { values, missing };
}

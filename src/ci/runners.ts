import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { globMatch } from '../vault';

// The runner registry, in <vault>/runners.json. A runner is not a user: it
// reads repositories (which are world-readable anyway) and writes run state
// for jobs it holds a lease on, and it can never push, edit, or administer.
// Keeping it out of vault.json keeps the two credential kinds from being
// confused for each other, and keeps a machine credential out of the file
// that governs human access.
//
// Only a hash of each runner token is stored, as with user tokens.

export const RUNNERS_FILE = 'runners.json';

export interface RunnerRecord {
  hash: string;
  labels: string[];
  // Globs over collection/repo saying which repositories' jobs this runner
  // may take. A runner executes repository-controlled code, so this is the
  // boundary an operator sets when handing one out.
  allow: string[];
  createdBy: string;
  createdAt: string;
}

export interface RunnerRegistry {
  runners: Record<string, RunnerRecord>;
}

export function runnersFilePath(root: string): string {
  return path.join(root, RUNNERS_FILE);
}

function normalize(parsed: unknown): RunnerRegistry {
  if (typeof parsed !== 'object' || parsed === null) throw new Error('runners.json must be a JSON object');
  const raw = (parsed as Record<string, unknown>).runners;
  if (raw === undefined) return { runners: {} };
  if (typeof raw !== 'object' || raw === null) throw new Error('runners.json must have a "runners" object');
  const runners: Record<string, RunnerRecord> = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) throw new Error(`runner ${name} must be an object`);
    const r = v as Record<string, unknown>;
    if (typeof r.hash !== 'string') throw new Error(`runner ${name} needs a "hash"`);
    const strings = (x: unknown, field: string): string[] => {
      if (x === undefined) return [];
      if (Array.isArray(x) && x.every((s) => typeof s === 'string')) return x as string[];
      throw new Error(`runner ${name}: "${field}" must be a list of strings`);
    };
    runners[name] = {
      hash: r.hash,
      labels: strings(r.labels, 'labels'),
      allow: strings(r.allow, 'allow'),
      createdBy: typeof r.createdBy === 'string' ? r.createdBy : '',
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
    };
  }
  return { runners };
}

let cache: { file: string; mtimeMs: number; size: number; registry: RunnerRegistry } | null = null;

export function loadRunners(root: string): RunnerRegistry {
  const file = runnersFilePath(root);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    cache = null;
    return { runners: {} };
  }
  if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
    return cache.registry;
  }
  let registry: RunnerRegistry;
  try {
    registry = normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    console.error(`runners.json could not be read: ${e instanceof Error ? e.message : e}`);
    registry = { runners: {} };
  }
  cache = { file, mtimeMs: st.mtimeMs, size: st.size, registry };
  return registry;
}

function write(root: string, registry: RunnerRegistry): void {
  const file = runnersFilePath(root);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  cache = null;
}

export function hashRunnerToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function registerRunner(
  root: string,
  name: string,
  opts: { labels: string[]; allow: string[]; createdBy: string }
): { token: string; runner: RunnerRecord } {
  const registry = loadRunners(root);
  const token = 'cofferdam_runner_' + crypto.randomBytes(32).toString('hex');
  const runner: RunnerRecord = {
    hash: hashRunnerToken(token),
    labels: opts.labels,
    allow: opts.allow,
    createdBy: opts.createdBy,
    createdAt: new Date().toISOString(),
  };
  registry.runners[name] = runner;
  write(root, registry);
  return { token, runner };
}

export function removeRunner(root: string, name: string): boolean {
  const registry = loadRunners(root);
  if (!registry.runners[name]) return false;
  delete registry.runners[name];
  write(root, registry);
  return true;
}

export interface RunnerAuth {
  name: string;
  runner: RunnerRecord;
}

export function authenticateRunner(root: string, token: string): RunnerAuth | null {
  const registry = loadRunners(root);
  const presented = Buffer.from(hashRunnerToken(token), 'hex');
  for (const [name, runner] of Object.entries(registry.runners)) {
    let stored: Buffer;
    try {
      stored = Buffer.from(runner.hash, 'hex');
    } catch {
      continue;
    }
    if (stored.length === presented.length && crypto.timingSafeEqual(stored, presented)) {
      return { name, runner };
    }
  }
  return null;
}

// Whether a runner is allowed to take jobs for a repository. An empty allow
// list means nothing, not everything: a runner handed out without a scope
// should sit idle rather than pick up every repository in the vault.
export function runnerAllows(runner: RunnerRecord, collection: string, repo: string): boolean {
  return runner.allow.some((g) => globMatch(g, `${collection}/${repo}`));
}

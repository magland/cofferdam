import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JobSpec } from '../ci/protocol';
import { StepState } from '../ci/runs';
import { ActionStore, defaultActionCacheDir } from './actions';
import { dockerAvailable } from './docker';
import { Externals, defaultExternalsDir } from './externals';
import { JobResult, defaultWorkDir, runJob } from './job';

// `hubbit runner run`: acquire a job, execute it, report back, repeat. The
// transport is plain HTTP with a long poll, so it works through any proxy
// that passes ordinary requests, and a runner behind NAT needs no inbound
// connectivity at all.

export interface RunnerConfig {
  host: string;
  token: string;
  labels?: string[];
  images?: Record<string, string>;
  workDir?: string;
  network?: string;
  /** Where `uses:` actions are downloaded from. */
  actionsUrl?: string;
  /** Where downloaded actions and node builds are cached. */
  cacheDir?: string;
}

export const DEFAULT_IMAGES: Record<string, string> = {
  'ubuntu-latest': 'catthehacker/ubuntu:act-latest',
  'ubuntu-24.04': 'catthehacker/ubuntu:act-24.04',
  'ubuntu-22.04': 'catthehacker/ubuntu:act-22.04',
  'self-hosted': 'catthehacker/ubuntu:act-latest',
};

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(base, 'hubbit', 'runner.json');
}

export function loadRunnerConfig(file = configPath()): RunnerConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RunnerConfig>;
    if (typeof parsed.host !== 'string' || typeof parsed.token !== 'string') return null;
    return parsed as RunnerConfig;
  } catch {
    return null;
  }
}

export function saveRunnerConfig(config: RunnerConfig, file = configPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

class JobClient {
  private buffer: { s: number; t: string; l: string }[] = [];
  private flushing = false;
  private cancelSeen = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private runner: Runner, private spec: JobSpec) {}

  private base(): string {
    const a = this.spec.address;
    return `${this.runner.host}/api/runner/jobs/${encodeURIComponent(a.collection)}/${encodeURIComponent(
      a.repo
    )}/${a.run}/${encodeURIComponent(a.job)}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.runner.token}`,
      'x-hubbit-lease': this.spec.lease,
      ...extra,
    };
  }

  log(stepIndex: number, line: string): void {
    this.buffer.push({ s: stepIndex, t: new Date().toISOString(), l: line });
    if (this.buffer.length >= 200) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      await fetch(`${this.base()}/logs`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/x-ndjson' }),
        body: batch.map((l) => JSON.stringify(l)).join('\n') + '\n',
      });
    } catch {
      // Losing a log batch must never fail the job; the work matters more
      // than its transcript.
    } finally {
      this.flushing = false;
    }
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.flush();
      void this.heartbeat();
    }, 3000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  cancelled(): boolean {
    return this.cancelSeen;
  }

  private async heartbeat(): Promise<void> {
    try {
      const res = await fetch(`${this.base()}/heartbeat`, { method: 'POST', headers: this.headers() });
      if (res.status === 409) {
        // The server took the job back (lease expired, run cancelled). Stop.
        this.cancelSeen = true;
        return;
      }
      const body = (await res.json()) as { cancel?: boolean };
      if (body.cancel) this.cancelSeen = true;
    } catch {
      // A transient failure is not a cancellation; keep working.
    }
  }

  async progress(steps: StepState[]): Promise<void> {
    await this.flush();
    try {
      await fetch(`${this.base()}/status`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ lease: this.spec.lease, status: 'running', stepStates: steps }),
      });
    } catch {
      // reported again on the next step
    }
  }

  async complete(result: JobResult): Promise<void> {
    await this.flush();
    try {
      await fetch(`${this.base()}/status`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          lease: this.spec.lease,
          status: 'completed',
          conclusion: result.conclusion,
          stepStates: result.steps,
          outputs: result.outputs,
          summaries: result.summaries,
        }),
      });
    } catch (e) {
      // The lease will expire and the server will requeue the job.
      console.error(`  could not report the result: ${e instanceof Error ? e.message : e}`);
    }
  }
}

export class Runner {
  readonly host: string;
  readonly token: string;
  private labels: string[];
  private images: Record<string, string>;
  private workDir: string;
  private network?: string;
  private stopping = false;
  private actions: ActionStore;
  private externals: Externals;

  constructor(config: RunnerConfig) {
    this.host = config.host.replace(/\/+$/, '');
    this.token = config.token;
    this.labels = config.labels ?? [];
    this.images = { ...DEFAULT_IMAGES, ...(config.images ?? {}) };
    this.workDir = config.workDir ?? defaultWorkDir();
    this.network = config.network;
    const actionCache = config.cacheDir ? path.join(config.cacheDir, 'actions') : defaultActionCacheDir();
    const externalsCache = config.cacheDir ? path.join(config.cacheDir, 'externals') : defaultExternalsDir();
    this.actions = new ActionStore(actionCache, config.actionsUrl);
    this.externals = new Externals(externalsCache);
  }

  imageFor(labels: string[]): string {
    for (const l of labels) {
      if (this.images[l]) return this.images[l];
    }
    // An unmapped label is taken as an image name when it looks like one,
    // which makes `runs-on: node:24` work without configuration.
    const looksLikeImage = labels.find((l) => l.includes('/') || l.includes(':'));
    return looksLikeImage ?? this.images['ubuntu-latest'];
  }

  cloneUrl(collection: string, repo: string): string {
    return `${this.host}/${encodeURIComponent(collection)}/${encodeURIComponent(repo)}`;
  }

  async whoami(): Promise<{ name: string; labels: string[]; allow: string[] }> {
    const res = await fetch(`${this.host}/api/runner/whoami`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `the server answered ${res.status}`);
    }
    return (await res.json()) as { name: string; labels: string[]; allow: string[] };
  }

  private async acquire(labels: string[]): Promise<JobSpec | null> {
    const res = await fetch(`${this.host}/api/runner/acquire`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ labels }),
    });
    if (res.status === 204) return null;
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `acquire failed with ${res.status}`);
    }
    return (await res.json()) as JobSpec;
  }

  stop(): void {
    this.stopping = true;
  }

  async loop(): Promise<void> {
    const docker = await dockerAvailable();
    if (!docker) {
      throw new Error(
        'Docker is not available. The runner executes every job in a container, so it needs a working `docker` command.'
      );
    }
    const identity = await this.whoami();
    const labels = this.labels.length ? this.labels.filter((l) => identity.labels.includes(l)) : identity.labels;
    if (labels.length === 0) {
      throw new Error(
        `none of the requested labels (${this.labels.join(', ')}) are registered for this runner (${identity.labels.join(
          ', '
        )})`
      );
    }
    console.log(`hubbit runner ${identity.name} ready`);
    console.log(`  server:  ${this.host}`);
    console.log(`  docker:  ${docker}`);
    console.log(`  labels:  ${labels.join(', ')}`);
    console.log(`  serving: ${identity.allow.join(', ')}`);
    console.log('Waiting for jobs.');

    let backoff = 1000;
    while (!this.stopping) {
      let spec: JobSpec | null = null;
      try {
        spec = await this.acquire(labels);
        backoff = 1000;
      } catch (e) {
        console.error(`  ${e instanceof Error ? e.message : e}; retrying in ${Math.round(backoff / 1000)}s`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60000);
        continue;
      }
      if (!spec) continue;
      await this.execute(spec);
    }
  }

  private async execute(spec: JobSpec): Promise<void> {
    const label = `${spec.address.collection}/${spec.address.repo} #${spec.runNumber} ${spec.name}`;
    console.log(`> ${label}`);
    const client = new JobClient(this, spec);
    client.start();
    const started = Date.now();
    let result: JobResult;
    try {
      result = await runJob(
        spec,
        {
          imageFor: (labels) => this.imageFor(labels),
          cloneUrl: (c, r) => this.cloneUrl(c, r),
          workDir: this.workDir,
          network: this.network,
          actions: this.actions,
          externals: this.externals,
          serverUrl: this.host,
          runnerToken: this.token,
        },
        {
          log: (i, line) => client.log(i, line),
          progress: (steps) => void client.progress(steps),
          cancelled: () => client.cancelled(),
        }
      );
    } catch (e) {
      client.log(-1, `runner error: ${e instanceof Error ? e.message : String(e)}`);
      result = { conclusion: 'failure', steps: [], outputs: {}, summaries: [] };
    }
    await client.complete(result);
    client.stop();
    const secs = Math.round((Date.now() - started) / 1000);
    console.log(`< ${label}: ${result.conclusion} in ${secs}s`);
  }
}

import * as os from 'os';
import { JobSpec } from '../ci/protocol';
import { WorkflowStep } from '../ci/workflow';
import { ActionStore, defaultActionCacheDir } from './actions';
import { DEFAULT_IMAGES, executeSpec, imageForLabels } from './client';
import { containerEngine } from './docker';
import { Externals, defaultExternalsDir } from './externals';
import { defaultWorkDir } from './job';

// `feorge job run`: the process behind a pasted command. It redeems the
// command for a session, then takes the run's manual jobs one at a time,
// showing each job's steps and asking before executing anything, and exits
// when the run has nothing left for it. Execution itself is the runner's own
// path (executeSpec), so a job runs here exactly as it would on a registered
// runner; what differs is how the lease was come by, and that a person
// approved the steps.

const ACQUIRE_BACKOFF_MAX = 60_000;

export interface ManualRunOptions {
  host: string;
  /** The mint token out of the pasted command; traded for a session at startup. */
  token: string;
  /** A glob over job keys/ids, or an exact job name; null takes any manual job. */
  jobFilter: string | null;
  /** Skip the per-job confirmation. */
  yes: boolean;
  images: Record<string, string>;
  workDir?: string;
  network?: string;
  cacheDir?: string;
  actionsUrl?: string;
  actionCache?: boolean;
  /**
   * Ask the person at the terminal to approve a job. Injected because this
   * module owns the session, not the terminal; the CLI supplies a prompt and
   * a test can supply an answer.
   */
  confirm: (question: string) => Promise<boolean>;
}

interface RedeemedRun {
  sessionToken: string;
  collection: string;
  repo: string;
  run: { number: number; workflowName: string; refName: string; sha: string; status: string };
  jobs: { id: string; key: string; name: string; status: string; conclusion: string | null; runsOn: string[] }[];
}

interface DoneBody {
  reason?: string;
  run?: { number: number; workflowName: string; status: string; conclusion: string | null } | null;
}

export class ManualSession {
  private session = '';
  private redeemed: RedeemedRun | null = null;
  private stopping = false;
  private polling: AbortController | null = null;
  private ran: { name: string; conclusion: string }[] = [];
  private readonly workDir: string;
  private readonly actions: ActionStore;
  private readonly externals: Externals;

  constructor(private opts: ManualRunOptions) {
    this.workDir = opts.workDir ?? defaultWorkDir();
    const actionCache = opts.cacheDir ? `${opts.cacheDir}/actions` : defaultActionCacheDir();
    const externalsCache = opts.cacheDir ? `${opts.cacheDir}/externals` : defaultExternalsDir();
    this.actions = new ActionStore(actionCache, opts.actionsUrl, opts.actionCache);
    this.externals = new Externals(externalsCache);
  }

  /** Finish the job in hand, then leave; a second call is the caller's business. */
  stop(): void {
    this.stopping = true;
    this.polling?.abort();
  }

  /** True when any job this session executed concluded failure. */
  sawFailure(): boolean {
    return this.ran.some((r) => r.conclusion === 'failure');
  }

  private async redeem(): Promise<RedeemedRun> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.host}/api/manual/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: this.opts.token, host: os.hostname() }),
      });
    } catch (e) {
      throw new Error(`could not reach ${this.opts.host}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `the server answered ${res.status}`);
    }
    return (await res.json()) as RedeemedRun;
  }

  private preview(spec: JobSpec): void {
    const image = imageForLabels({ ...DEFAULT_IMAGES, ...this.opts.images }, spec.runsOn);
    console.log('');
    console.log(
      `  ${spec.address.collection}/${spec.address.repo}  run #${spec.runNumber}  job "${spec.name}"  at ${spec.sha.slice(0, 8)} on ${spec.ref}`
    );
    console.log(`  image: ${image}  (engine: ${containerEngine()})`);
    if (spec.matrix) console.log(`  matrix: ${JSON.stringify(spec.matrix)}`);
    const steps = spec.steps as WorkflowStep[];
    steps.forEach((s, i) => {
      const n = String(i + 1).padStart(3);
      if (s.uses) {
        console.log(`${n}  uses: ${s.uses}${s.name ? `  (${s.name})` : ''}`);
      } else if (s.run !== undefined) {
        const lines = s.run.split('\n').filter((l) => l.trim() !== '');
        console.log(`${n}  run: ${lines[0] ?? ''}${s.name ? `  (${s.name})` : ''}`);
        for (const extra of lines.slice(1, 20)) console.log(`          ${extra}`);
        if (lines.length > 21) console.log(`          ... ${lines.length - 21} more lines`);
      } else {
        console.log(`${n}  (empty step)`);
      }
    });
    console.log('');
  }

  private async release(spec: JobSpec): Promise<void> {
    const a = spec.address;
    try {
      await fetch(
        `${this.opts.host}/api/manual/jobs/${encodeURIComponent(a.collection)}/${encodeURIComponent(a.repo)}/${a.run}/${encodeURIComponent(a.job)}/release`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${this.session}`, 'x-feorge-lease': spec.lease },
        }
      );
    } catch {
      // The lease expires on its own; a release that could not be delivered
      // costs a minute, not a job... except that an expired manual lease
      // fails the job, so say so rather than leaving it to be discovered.
      console.error('  could not hand the job back; the vault will fail it when the lease expires');
    }
  }

  private async acquire(): Promise<{ kind: 'job'; spec: JobSpec } | { kind: 'wait' } | { kind: 'done'; body: DoneBody }> {
    const poll = new AbortController();
    this.polling = poll;
    try {
      const res = await fetch(`${this.opts.host}/api/manual/acquire`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.session}`, 'content-type': 'application/json' },
        body: JSON.stringify({ job: this.opts.jobFilter ?? undefined }),
        signal: poll.signal,
      });
      if (res.status === 204) return { kind: 'wait' };
      if (res.status === 410) {
        return { kind: 'done', body: (await res.json().catch(() => ({}))) as DoneBody };
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `acquire failed with ${res.status}`);
      }
      return { kind: 'job', spec: (await res.json()) as JobSpec };
    } catch (e) {
      if (this.stopping) return { kind: 'wait' };
      throw e;
    } finally {
      this.polling = null;
    }
  }

  /**
   * Run the session to its end. Returns 0 when everything this session ran
   * succeeded (or it ran nothing), 1 when something it ran failed, so a
   * scripted `--yes` use gets an exit status worth checking.
   */
  async run(): Promise<number> {
    const redeemed = await this.redeem();
    this.redeemed = redeemed;
    this.session = redeemed.sessionToken;

    console.log(`feorge job run: ${redeemed.collection}/${redeemed.repo} run #${redeemed.run.number} "${redeemed.run.workflowName}"`);
    console.log(`  server:  ${this.opts.host}`);
    console.log(`  commit:  ${redeemed.run.sha.slice(0, 8)} on ${redeemed.run.refName}`);
    console.log(`  workdir: ${this.workDir}`);
    const manualJobs = redeemed.jobs;
    const waiting = manualJobs.filter((j) => j.status === 'queued');
    console.log(
      `  manual jobs: ${manualJobs.map((j) => `${j.name}${j.status === 'completed' ? ` (${j.conclusion})` : ''}`).join(', ') || 'none'}`
    );
    if (this.opts.jobFilter) {
      const matches = manualJobs.some(
        (j) => j.key === this.opts.jobFilter || j.id === this.opts.jobFilter || j.name === this.opts.jobFilter
      );
      // A glob can match without equalling, so this is a hint, not a refusal;
      // the server's answer is the authority and arrives on the first acquire.
      if (!matches) console.log(`  note: --job ${this.opts.jobFilter} names none of them exactly; globs are matched by the vault`);
    }
    if (waiting.length === 0) console.log('  nothing is waiting right now; jobs may yet become eligible as others finish');

    let backoff = 1000;
    let saidWaiting = false;
    for (;;) {
      if (this.stopping) {
        console.log('Stopped. Unclaimed manual jobs stay waiting; the run page mints a fresh command for them.');
        break;
      }
      let got: Awaited<ReturnType<ManualSession['acquire']>>;
      try {
        got = await this.acquire();
        backoff = 1000;
      } catch (e) {
        console.error(`  ${e instanceof Error ? e.message : e}; retrying in ${Math.round(backoff / 1000)}s`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, ACQUIRE_BACKOFF_MAX);
        continue;
      }
      if (got.kind === 'wait') {
        if (!this.stopping && !saidWaiting) {
          console.log('  waiting: the next manual job is blocked on jobs running elsewhere...');
          saidWaiting = true;
        }
        continue;
      }
      if (got.kind === 'done') {
        this.summarize(got.body);
        break;
      }
      saidWaiting = false;
      const spec = got.spec;
      if (!this.opts.yes) {
        this.preview(spec);
        const steps = (spec.steps as WorkflowStep[]).length;
        const ok = await this.opts.confirm(
          `Run ${steps === 1 ? 'this step' : `these ${steps} steps`} on ${os.hostname()}? [y/N] `
        );
        if (!ok) {
          await this.release(spec);
          console.log('Declined; the job goes back to waiting for a command.');
          break;
        }
      }
      const result = await executeSpec(spec, {
        host: this.opts.host,
        token: this.session,
        runnerName: `a manual session on ${os.hostname()}`,
        imageFor: (labels) => imageForLabels({ ...DEFAULT_IMAGES, ...this.opts.images }, labels),
        workDir: this.workDir,
        network: this.opts.network,
        actions: this.actions,
        externals: this.externals,
      });
      this.ran.push({ name: spec.name, conclusion: result.conclusion });
    }
    return this.sawFailure() ? 1 : 0;
  }

  private summarize(body: DoneBody): void {
    console.log('');
    if (this.ran.length > 0) {
      for (const r of this.ran) console.log(`  ${r.name}: ${r.conclusion}`);
    }
    const run = body.run;
    if (run?.status === 'completed') {
      console.log(`Run #${run.number} finished: ${run.conclusion ?? 'completed'}`);
    } else if (body.reason) {
      console.log(`Nothing more for this session: ${body.reason}`);
      if (run) console.log(`Run #${run.number} is ${run.status}; other jobs may still be running elsewhere.`);
    } else {
      console.log('Nothing more for this session.');
    }
    const n = this.redeemed;
    if (n) {
      console.log(`  ${this.opts.host}/${encodeURIComponent(n.collection)}/${encodeURIComponent(n.repo)}/actions/runs/${n.run.number}`);
    }
  }
}

import { api, remoteTarget } from './cli-api';
import { JSON_OPTION, jsonMode, pickFields, printJson, printTable } from './cli/output';
import { Command } from './cli/parse';
import { TARGET_OPTIONS, targetFrom } from './cli/target';
import { loadLogin } from './credentials';
import { DEFAULT_IMAGES, Runner, RunnerConfig, configPath, loadRunnerConfig, saveRunnerConfig } from './runner/client';
import { globMatch } from './vault';

// The `cofferdam runner ...` subcommands. Registration talks to the server with
// an admin token, exactly like `cofferdam user add`; running needs only the
// runner's own token and a working Docker.

interface RunnerArgs {
  name: string | null;
  host: string | null;
  token: string | null;
  runnerToken: string | null;
  labels: string[];
  allow: string[];
  images: Record<string, string>;
  workDir: string | null;
  network: string | null;
  cacheDir: string | null;
  actionsUrl: string | null;
  actionCache: boolean;
  save: boolean;
}

function parseArgs(args: string[], usage: () => never): RunnerArgs {
  const out: RunnerArgs = {
    name: null,
    host: null,
    token: null,
    runnerToken: null,
    labels: [],
    allow: [],
    images: {},
    workDir: null,
    network: null,
    cacheDir: null,
    actionsUrl: null,
    actionCache: true,
    save: false,
  };
  const list = (v: string): string[] => v.split(/[\s,]+/).filter((s) => s.length > 0);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') usage();
    else if (a === '--host') out.host = args[++i];
    else if (a === '--token') out.token = args[++i];
    else if (a === '--runner-token') out.runnerToken = args[++i];
    else if (a === '--labels' || a === '--label') out.labels.push(...list(args[++i] ?? ''));
    else if (a === '--allow') out.allow.push(...list(args[++i] ?? ''));
    else if (a === '--work-dir') out.workDir = args[++i];
    else if (a === '--cache-dir') out.cacheDir = args[++i];
    else if (a === '--actions-url') out.actionsUrl = args[++i];
    else if (a === '--no-action-cache') out.actionCache = false;
    else if (a === '--network') out.network = args[++i];
    else if (a === '--save') out.save = true;
    else if (a === '--image') {
      // --image ubuntu-latest=my/image:tag
      const spec = args[++i] ?? '';
      const eq = spec.indexOf('=');
      if (eq === -1) {
        console.error(`--image needs <label>=<image>, got: ${spec}`);
        process.exit(1);
      }
      out.images[spec.slice(0, eq)] = spec.slice(eq + 1);
    } else if (a.startsWith('-')) {
      console.error(`Unknown option: ${a}`);
      process.exit(1);
    } else if (!out.name) out.name = a;
    else {
      console.error(`Unexpected argument: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

// Registration is an ordinary admin operation, so it uses the same login as
// `cofferdam user add` rather than any arrangement of its own.

export async function runnerAddCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseArgs(args, usage);
  if (!a.name) {
    console.error('A runner name is required: cofferdam runner add <name> --allow <glob>');
    process.exit(1);
  }
  if (a.allow.length === 0) {
    console.error(
      'Say which repositories this runner may take jobs for: --allow "mycollection/*".\n' +
        'A runner executes whatever those repositories\' workflows contain, on the machine you start it on.'
    );
    process.exit(1);
  }
  const target = await remoteTarget(a);
  const labels = a.labels.length ? a.labels : ['ubuntu-latest'];
  const data = await api(target, 'POST', '/api/runners', { name: a.name, labels, allow: a.allow });
  console.log(`Registered runner ${data.name}`);
  console.log(`  labels:  ${(data.labels as string[]).join(', ')}`);
  console.log(`  serving: ${(data.allow as string[]).join(', ')}`);
  console.log('');
  console.log('Runner token (shown once; only its hash is stored):');
  console.log('');
  console.log(`  ${data.token}`);
  console.log('');
  if (a.save) {
    const config: RunnerConfig = { host: target.host, token: data.token as string, labels };
    if (a.workDir) config.workDir = a.workDir;
    if (a.network) config.network = a.network;
    if (Object.keys(a.images).length) config.images = a.images;
    saveRunnerConfig(config);
    console.log(`Saved to ${configPath()}. Start it with:`);
    console.log('');
    console.log('  cofferdam runner run');
  } else {
    console.log('On the machine that will run jobs (with Docker installed):');
    console.log('');
    console.log(`  cofferdam runner run --host ${target.host} --runner-token ${data.token}`);
  }
  console.log('');
}

interface RunnerRow extends Record<string, unknown> {
  name: string;
  labels: string[];
  allow: string[];
  createdBy: string;
  createdAt: string;
  lastSeen?: string | null;
  running: { collection: string; repo: string; run: number; job: string } | null;
}

interface QueuedJob {
  collection: string;
  repo: string;
  run: number;
  job: string;
  runsOn: string[];
}

/** "3s ago", for the one column where a bare ISO timestamp would be unreadable. */
function ago(iso: string | null): string {
  if (!iso) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (secs < 90) return `${secs}s ago`;
  if (secs < 5400) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

function jobLabel(j: { collection: string; repo: string; run: number; job: string }): string {
  return `${j.collection}/${j.repo} #${j.run} ${j.job}`;
}

/**
 * A queued job that no registered runner can take: its labels match nobody, or
 * nobody's allow list covers its repository. This is the answer to "the run
 * never started" that neither the run nor the registry gives on its own, so it
 * is worth computing here rather than leaving to the reader.
 */
function unservedJobs(queued: QueuedJob[], runners: RunnerRow[]): QueuedJob[] {
  return queued.filter(
    (j) =>
      !runners.some(
        (r) =>
          r.allow.some((g) => globMatch(g, `${j.collection}/${j.repo}`)) &&
          j.runsOn.some((l) => r.labels.includes(l))
      )
  );
}

export const runnerListCommand: Command = {
  path: ['runner', 'list'],
  summary: 'Show registered runners, whether each is connected, and what is queued',
  description: `Needs an admin token, as the other runner registration commands do.

Beside the registry it reports liveness: when each runner last spoke to the vault
(since the vault started; a restart forgets it and every live runner re-announces
within one poll), the job it is holding now, and the jobs waiting for a runner. A
queued job that no runner's labels and allow globs match is called out, since that
is the usual reason a run sits at queued forever.`,
  options: [JSON_OPTION, ...TARGET_OPTIONS],
  async run(inv) {
    const target = await targetFrom(inv);
    const data = await api(target, 'GET', '/api/runners');
    const runners = (data.runners ?? []) as RunnerRow[];
    const queued = (data.queued ?? []) as QueuedJob[];
    const json = jsonMode(inv);
    if (json.enabled) {
      printJson({ runners: pickFields(runners, json.fields), queued });
      return;
    }
    if (runners.length === 0) {
      console.log('No runners registered. Runs will queue and wait: cofferdam runner add <name> --allow <glob>');
    } else {
      printTable(
        runners.map((r) => [
          r.name,
          `labels: ${r.labels.join(', ') || '(none)'}`,
          `serving: ${r.allow.join(', ') || '(none)'}`,
          // A vault older than liveness reporting leaves both out, and saying
          // "seen never" of a runner that may be perfectly healthy would be
          // worse than saying nothing.
          r.lastSeen === undefined && !r.running
            ? r.createdBy
              ? `by ${r.createdBy}`
              : ''
            : r.running
              ? `running ${jobLabel(r.running)}`
              : `idle, seen ${ago(r.lastSeen ?? null)}`,
        ])
      );
    }
    if (queued.length > 0) {
      console.log('');
      console.log(`${queued.length} job${queued.length === 1 ? '' : 's'} waiting for a runner:`);
      for (const j of queued) console.log(`  ${jobLabel(j)}  (runs-on: ${j.runsOn.join(', ')})`);
      const unserved = unservedJobs(queued, runners);
      if (unserved.length > 0) {
        console.log('');
        console.log(
          `No registered runner can take ${
            unserved.length === queued.length ? 'them' : `${unserved.length} of them`
          }: check the runs-on labels against each runner's labels, and the repository against its serving globs.`
        );
      }
    }
  },
};

export async function runnerRemoveCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseArgs(args, usage);
  if (!a.name) {
    console.error('A runner name is required: cofferdam runner remove <name>');
    process.exit(1);
  }
  const target = await remoteTarget(a);
  await api(target, 'DELETE', `/api/runners/${encodeURIComponent(a.name)}`);
  console.log(`Removed runner ${a.name}`);
}

export async function runnerRunCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseArgs(args, usage);
  const saved = loadRunnerConfig();
  // A runner's token is its own, not a user's, so it is not something login
  // stored; only the vault URL can be borrowed from a login on this machine.
  const host = (a.host ?? saved?.host ?? loadLogin()?.host ?? '').replace(/\/+$/, '');
  const token = a.runnerToken ?? process.env.COFFERDAM_RUNNER_TOKEN ?? saved?.token ?? '';
  if (!host || !token) {
    console.error(
      `No runner credentials. Register one with:\n\n` +
        `  cofferdam runner add <name> --allow 'mycollection/*' --save\n\n` +
        `or pass --host and --runner-token, or write ${configPath()}.`
    );
    process.exit(1);
  }
  const config: RunnerConfig = {
    host,
    token,
    labels: a.labels.length ? a.labels : saved?.labels,
    images: { ...DEFAULT_IMAGES, ...(saved?.images ?? {}), ...a.images },
    workDir: a.workDir ?? saved?.workDir,
    network: a.network ?? saved?.network,
    cacheDir: a.cacheDir ?? saved?.cacheDir,
    actionsUrl: a.actionsUrl ?? saved?.actionsUrl,
    actionCache: a.actionCache && (saved?.actionCache ?? true),
  };
  if (a.save) {
    saveRunnerConfig(config);
    console.log(`Saved to ${configPath()}`);
  }
  const runner = new Runner(config);
  const stop = () => {
    console.log('\nStopping after the current job. Press Ctrl-C again to quit now.');
    runner.stop();
    process.once('SIGINT', () => process.exit(130));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await runner.loop();
}

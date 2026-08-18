import { DEFAULT_IMAGES, Runner, RunnerConfig, configPath, loadRunnerConfig, saveRunnerConfig } from './runner/client';

// The `hubbit runner ...` subcommands. Registration talks to the server with
// an admin token, exactly like `hubbit user add`; running needs only the
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

function adminTarget(a: RunnerArgs): { host: string; token: string } {
  const host = (a.host ?? process.env.HUBBIT_HOST ?? '').replace(/\/+$/, '');
  const token = a.token ?? process.env.HUBBIT_TOKEN ?? '';
  if (!host) {
    console.error('No server configured. Set HUBBIT_HOST (e.g. http://127.0.0.1:3000) or pass --host <url>.');
    process.exit(1);
  }
  if (!token) {
    console.error('No token configured. Set HUBBIT_TOKEN or pass --token <token>.');
    process.exit(1);
  }
  return { host, token };
}

async function api(
  target: { host: string; token: string },
  method: string,
  pathname: string,
  body?: unknown
): Promise<Record<string, any>> {
  let resp;
  try {
    resp = await fetch(`${target.host}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${target.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    console.error(`Could not reach ${target.host}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  let data: Record<string, any> | null = null;
  try {
    data = (await resp.json()) as Record<string, any>;
  } catch {
    data = null;
  }
  if (!resp.ok) {
    console.error(data && data.error ? `Error: ${data.error}` : `Error: HTTP ${resp.status}`);
    process.exit(1);
  }
  return data ?? {};
}

export async function runnerAddCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseArgs(args, usage);
  if (!a.name) {
    console.error('A runner name is required: hubbit runner add <name> --allow <glob>');
    process.exit(1);
  }
  if (a.allow.length === 0) {
    console.error(
      'Say which repositories this runner may take jobs for: --allow "mycollection/*".\n' +
        'A runner executes whatever those repositories\' workflows contain, on the machine you start it on.'
    );
    process.exit(1);
  }
  const target = adminTarget(a);
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
    console.log('  hubbit runner run');
  } else {
    console.log('On the machine that will run jobs (with Docker installed):');
    console.log('');
    console.log(`  hubbit runner run --host ${target.host} --runner-token ${data.token}`);
  }
  console.log('');
}

export async function runnerListCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseArgs(args, usage);
  const target = adminTarget(a);
  const data = await api(target, 'GET', '/api/runners');
  const runners = (data.runners ?? []) as {
    name: string;
    labels: string[];
    allow: string[];
    createdBy: string;
  }[];
  if (runners.length === 0) {
    console.log('No runners registered.');
    return;
  }
  const width = Math.max(...runners.map((r) => r.name.length), 4);
  for (const r of runners) {
    console.log(
      `${r.name.padEnd(width)}  labels: ${r.labels.join(', ') || '(none)'}  serving: ${
        r.allow.join(', ') || '(none)'
      }${r.createdBy ? `  by ${r.createdBy}` : ''}`
    );
  }
}

export async function runnerRemoveCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseArgs(args, usage);
  if (!a.name) {
    console.error('A runner name is required: hubbit runner remove <name>');
    process.exit(1);
  }
  const target = adminTarget(a);
  await api(target, 'DELETE', `/api/runners/${encodeURIComponent(a.name)}`);
  console.log(`Removed runner ${a.name}`);
}

export async function runnerRunCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseArgs(args, usage);
  const saved = loadRunnerConfig();
  const host = (a.host ?? saved?.host ?? process.env.HUBBIT_HOST ?? '').replace(/\/+$/, '');
  const token = a.runnerToken ?? process.env.HUBBIT_RUNNER_TOKEN ?? saved?.token ?? '';
  if (!host || !token) {
    console.error(
      `No runner credentials. Register one with:\n\n` +
        `  hubbit runner add <name> --allow 'mycollection/*' --save\n\n` +
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

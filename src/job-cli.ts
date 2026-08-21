import * as readline from 'readline';
import { probeEngine, setContainerEngine } from './runner/docker';
import { ManualSession } from './runner/manual-run';

// `mochi job run <vault-url> <token>`: the command a run page mints for its
// manual jobs, pasted on whatever machine should execute them. Parsing lives
// here in the style of runner-cli.ts; the session itself is
// src/runner/manual-run.ts, and execution below that is the runner's own.

interface JobRunArgs {
  url: string | null;
  token: string | null;
  job: string | null;
  yes: boolean;
  engine: 'docker' | 'podman' | null;
  images: Record<string, string>;
  workDir: string | null;
  network: string | null;
  cacheDir: string | null;
  actionsUrl: string | null;
  actionCache: boolean;
}

function parseArgs(args: string[], usage: () => never): JobRunArgs {
  const out: JobRunArgs = {
    url: null,
    token: null,
    job: null,
    yes: false,
    engine: null,
    images: {},
    workDir: null,
    network: null,
    cacheDir: null,
    actionsUrl: null,
    actionCache: true,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') usage();
    else if (a === '--job') out.job = args[++i] ?? null;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--engine') {
      const e = args[++i] ?? '';
      if (e !== 'docker' && e !== 'podman') {
        console.error(`--engine takes docker or podman, got: ${e}`);
        process.exit(1);
      }
      out.engine = e;
    } else if (a === '--image') {
      const spec = args[++i] ?? '';
      const eq = spec.indexOf('=');
      if (eq === -1) {
        console.error(`--image needs <label>=<image>, got: ${spec}`);
        process.exit(1);
      }
      out.images[spec.slice(0, eq)] = spec.slice(eq + 1);
    } else if (a === '--work-dir') out.workDir = args[++i] ?? null;
    else if (a === '--network') out.network = args[++i] ?? null;
    else if (a === '--cache-dir') out.cacheDir = args[++i] ?? null;
    else if (a === '--actions-url') out.actionsUrl = args[++i] ?? null;
    else if (a === '--no-action-cache') out.actionCache = false;
    else if (a.startsWith('-')) {
      console.error(`Unknown option: ${a}`);
      process.exit(1);
    } else if (!out.url) out.url = a;
    else if (!out.token) out.token = a;
    else {
      console.error(`Unexpected argument: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // A closed stdin (Ctrl-D, or the terminal going away) answers nothing,
    // and nothing must never read as consent. The flag matters: rl.close()
    // below emits 'close' synchronously, and without it the empty answer
    // would win the race against the real one.
    let answered = false;
    rl.on('close', () => {
      if (!answered) resolve('');
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Which container engine to use: the flag if given, whatever is present if
 * only one is, and a question with docker as the default when both are. The
 * probe demands a working daemon, not just a binary on the path, since a
 * docker command with nothing behind it runs nothing.
 */
export async function chooseEngine(flag: 'docker' | 'podman' | null, interactive: boolean): Promise<'docker' | 'podman'> {
  if (flag) {
    const v = await probeEngine(flag);
    if (!v) {
      console.error(`--engine ${flag}: ${flag} is not available here, or its daemon is not running.`);
      process.exit(1);
    }
    return flag;
  }
  const [docker, podman] = await Promise.all([probeEngine('docker'), probeEngine('podman')]);
  if (docker && !podman) return 'docker';
  if (podman && !docker) {
    console.log(`Using podman ${podman} (no working docker here).`);
    return 'podman';
  }
  if (!docker && !podman) {
    console.error('Neither docker nor podman works here. Jobs run in containers, so one of the two is needed.');
    process.exit(1);
  }
  if (!interactive) return 'docker';
  const answer = (await ask(`Both docker (${docker}) and podman (${podman}) work here. Use which? [docker] `)).trim().toLowerCase();
  if (answer === '' || answer === 'docker' || answer === 'd') return 'docker';
  if (answer === 'podman' || answer === 'p') return 'podman';
  console.error(`That is neither; pass --engine docker or --engine podman.`);
  process.exit(1);
}

export async function jobRunCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseArgs(args, usage);
  if (!a.url || !a.token) {
    console.error('Usage: mochi job run <vault-url> <token>   (both come from the run page, minted together)');
    process.exit(1);
  }
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!a.yes && !interactive) {
    console.error(
      'There is no terminal to confirm the steps on. Pass --yes to run without confirmation, knowing that this executes whatever the workflow contains.'
    );
    process.exit(1);
  }
  const engine = await chooseEngine(a.engine, interactive);
  setContainerEngine(engine);

  const session = new ManualSession({
    host: a.url.replace(/\/+$/, ''),
    token: a.token,
    jobFilter: a.job,
    yes: a.yes,
    images: a.images,
    workDir: a.workDir ?? undefined,
    network: a.network ?? undefined,
    cacheDir: a.cacheDir ?? undefined,
    actionsUrl: a.actionsUrl ?? undefined,
    actionCache: a.actionCache,
    confirm: async (q) => {
      const answer = (await ask(q)).trim().toLowerCase();
      return answer === 'y' || answer === 'yes';
    },
  });
  const stop = () => {
    console.log('\nStopping after the current job. Press Ctrl-C again to quit now, which fails a job in progress.');
    session.stop();
    process.once('SIGINT', () => process.exit(130));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.exit(await session.run());
}

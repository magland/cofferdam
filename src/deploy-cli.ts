import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  approveCredential,
  clearLogin,
  configuredHelper,
  credentialTarget,
  loadLogin,
  readCredential,
  rejectCredential,
  saveLogin,
} from './credentials';
import { mintToken } from './vault';

// `cofferdam deploy fly`: put a vault on Fly.io from one command, and deploy
// updates to it with the same one. This is a thin driver of the fly command
// rather than a client of Fly's API, so it inherits `fly auth login` and the
// user's existing organization; the only prerequisite is that flyctl is
// installed and logged in.
//
// Nothing about a deployment is remembered on this machine. Fly already knows
// the region, the volume size, and the machine's shape, so this reads them back
// from the live app and applies only what the flags change. A generated
// fly.toml goes to a temporary directory for the length of the deploy, which is
// why there is no fly.toml in this repository to keep in sync or to explain.

const IMAGE_REPO = 'ghcr.io/magland/cofferdam';
const VOLUME_NAME = 'vault';
const OWNER_TOKEN_SECRET = 'COFFERDAM_OWNER_TOKEN';
const INTERNAL_PORT = 3000;

interface FlyResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Settings {
  region: string;
  volumeGb: number;
  cpuKind: string;
  cpus: number;
  memory: string;
}

const DEFAULTS: Settings = { region: 'ewr', volumeGb: 10, cpuKind: 'shared', cpus: 1, memory: '512mb' };

interface DeployArgs {
  app: string | null;
  region: string | null;
  volumeGb: number | null;
  vmSize: string | null;
  memory: string | null;
  image: string | null;
  org: string | null;
  lfsBucket: boolean;
  yes: boolean;
}

// Quiet commands, whose output this code reads rather than the user. A non-zero
// exit is often the answer and not a failure (`fly status` on an app that does
// not exist), so the code is reported instead of thrown.
function fly(args: string[]): Promise<FlyResult> {
  return new Promise((resolve, reject) => {
    execFile('fly', args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') {
        reject(new Error('flyctl is not on PATH. Install it from https://fly.io/docs/flyctl/install/'));
        return;
      }
      resolve({ code: typeof code === 'number' ? code : err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function flyJson<T>(args: string[]): Promise<T | null> {
  const r = await fly([...args, '--json']);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    return null;
  }
}

// The commands whose progress the user should watch: deploying, creating a
// volume, provisioning a bucket. Their output is fly's to format, and hiding a
// three-minute deploy behind a spinner of our own would only lose detail.
function flyStream(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('fly', args, { stdio: 'inherit' });
    child.on('error', (e) => {
      reject((e as NodeJS.ErrnoException).code === 'ENOENT'
        ? new Error('flyctl is not on PATH. Install it from https://fly.io/docs/flyctl/install/')
        : e);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseDeployArgs(args: string[], usage: () => never): DeployArgs {
  const out: DeployArgs = {
    app: null,
    region: null,
    volumeGb: null,
    vmSize: null,
    memory: null,
    image: null,
    org: null,
    lfsBucket: false,
    yes: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') usage();
    else if (a === '--region') out.region = args[++i];
    else if (a === '--volume') {
      const gb = parseInt(args[++i], 10);
      if (!Number.isInteger(gb) || gb < 1) die('--volume takes a size in whole gigabytes, e.g. --volume 10');
      out.volumeGb = gb;
    } else if (a === '--vm-size') out.vmSize = args[++i];
    else if (a === '--vm-memory') out.memory = args[++i];
    else if (a === '--image') out.image = args[++i];
    else if (a === '--org') out.org = args[++i];
    else if (a === '--lfs-bucket') out.lfsBucket = true;
    else if (a === '-y' || a === '--yes') out.yes = true;
    else if (a.startsWith('-')) die(`Unknown option: ${a}`);
    else if (!out.app) out.app = a;
    else die(`Unexpected argument: ${a}`);
  }
  return out;
}

// Fly's own machine sizes name a CPU kind and a count: shared-cpu-4x,
// performance-2x. The generated config sets cpu_kind and cpus separately, since
// spelling those two out avoids having to know which shorthands Fly accepts
// today, so the shorthand is taken apart here.
function parseVmSize(size: string): { cpuKind: string; cpus: number } {
  const m = /^(shared|performance)(?:-cpu)?-(\d+)x$/.exec(size.trim());
  if (!m) {
    die(
      `Not a Fly machine size: ${size}\n` +
        'Expected something like shared-cpu-1x, shared-cpu-4x, or performance-2x.\n' +
        'See: fly platform vm-sizes'
    );
  }
  return { cpuKind: m[1], cpus: parseInt(m[2], 10) };
}

function normalizeMemory(memory: string): string {
  const m = /^(\d+)\s*(mb|gb)?$/i.exec(memory.trim());
  if (!m) die(`Not a memory size: ${memory}\nExpected something like 512mb, 1gb, or 2048.`);
  const n = parseInt(m[1], 10);
  const unit = (m[2] ?? 'mb').toLowerCase();
  const mb = unit === 'gb' ? n * 1024 : n;
  if (mb < 256) die(`Memory of ${memory} is below Fly's 256mb minimum.`);
  return `${mb}mb`;
}

/** The version of this CLI, which is the image tag deployed unless --image says otherwise. */
function ownVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch {
    /* fall through to the message below */
  }
  die('Could not read this package\'s version, so there is no image tag to deploy. Pass --image <ref>.');
}

async function requireFly(): Promise<void> {
  const who = await fly(['auth', 'whoami']);
  if (who.code !== 0) {
    die('Not logged in to Fly. Run:\n\n  fly auth login\n');
  }
}

interface VolumeInfo {
  id: string;
  name: string;
  region: string;
  size_gb: number;
  state?: string;
}

interface MachineInfo {
  id: string;
  state?: string;
  region?: string;
  config?: { image?: string; guest?: { cpu_kind?: string; cpus?: number; memory_mb?: number } };
}

async function appExists(app: string): Promise<boolean> {
  const r = await fly(['status', '-a', app]);
  return r.code === 0;
}

async function vaultVolume(app: string): Promise<VolumeInfo | null> {
  const vols = (await flyJson<VolumeInfo[]>(['volumes', 'list', '-a', app])) ?? [];
  return vols.find((v) => v.name === VOLUME_NAME) ?? null;
}

async function machines(app: string): Promise<MachineInfo[]> {
  return (await flyJson<MachineInfo[]>(['machines', 'list', '-a', app])) ?? [];
}

async function secretNames(app: string): Promise<string[]> {
  const secrets = (await flyJson<{ Name?: string; name?: string }[]>(['secrets', 'list', '-a', app])) ?? [];
  return secrets.map((s) => s.Name ?? s.name ?? '').filter(Boolean);
}

/** What Fly currently has, so that a flag-less redeploy changes nothing and one flag changes one thing. */
async function liveSettings(app: string): Promise<Partial<Settings>> {
  const out: Partial<Settings> = {};
  const vol = await vaultVolume(app);
  if (vol) {
    out.region = vol.region;
    out.volumeGb = vol.size_gb;
  }
  const guest = (await machines(app)).find((m) => m.config?.guest)?.config?.guest;
  if (guest) {
    if (guest.cpu_kind) out.cpuKind = guest.cpu_kind;
    if (guest.cpus) out.cpus = guest.cpus;
    if (guest.memory_mb) out.memory = `${guest.memory_mb}mb`;
  }
  return out;
}

function resolveSettings(a: DeployArgs, live: Partial<Settings>): Settings {
  const base: Settings = { ...DEFAULTS, ...live };
  const vm = a.vmSize ? parseVmSize(a.vmSize) : null;
  return {
    region: a.region ?? base.region,
    volumeGb: a.volumeGb ?? base.volumeGb,
    cpuKind: vm?.cpuKind ?? base.cpuKind,
    cpus: vm?.cpus ?? base.cpus,
    memory: a.memory ? normalizeMemory(a.memory) : base.memory,
  };
}

// A vault is a directory on one volume, so this app runs as exactly one
// machine: --ha=false at deploy time, and min_machines_running = 0 with
// auto-start here. A second machine would mean a second volume and a second
// vault, diverging silently from the first. For the same reason, a busier vault
// wants a bigger machine rather than more of them.
function flyToml(app: string, s: Settings): string {
  return `# Generated by cofferdam deploy for '${app}'. Written to a temporary
# directory for the length of one deploy; edit the deploy command, not this.
app = "${app}"
primary_region = "${s.region}"

[mounts]
  source = "${VOLUME_NAME}"
  destination = "/vault"

[http_service]
  internal_port = ${INTERNAL_PORT}
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0
  [http_service.concurrency]
    type = "requests"
    hard_limit = 250
    soft_limit = 200

[[vm]]
  cpu_kind = "${s.cpuKind}"
  cpus = ${s.cpus}
  memory = "${s.memory}"
`;
}

function writeTempConfig(app: string, s: Settings): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cofferdam-deploy-'));
  const file = path.join(dir, 'fly.toml');
  fs.writeFileSync(file, flyToml(app, s));
  return file;
}

function appUrl(app: string): string {
  return `https://${app}.fly.dev`;
}

/**
 * Wait for the deployed vault to answer as the token's owner. This is both the
 * health check and the proof that the injected token was adopted: a machine
 * that boots and then fails to read its volume answers nothing, and a vault
 * that was already initialized answers 401.
 */
async function waitForVault(
  url: string,
  token: string,
  seconds = 120
): Promise<{ ok: true; username: string } | { ok: false; reason: string }> {
  const deadline = Date.now() + seconds * 1000;
  let last = 'no answer yet';
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${url}/api/whoami`, { headers: { authorization: `Bearer ${token}` } });
      if (resp.ok) {
        const data = (await resp.json()) as { username?: unknown };
        if (typeof data.username === 'string' && data.username) return { ok: true, username: data.username };
        last = 'the vault answered without saying who the token belongs to';
      } else if (resp.status === 401 || resp.status === 403) {
        // Conclusive rather than worth retrying: the server is up and has
        // rejected this token, which means the vault was initialized before.
        return { ok: false, reason: `the vault did not accept the new owner token (HTTP ${resp.status})` };
      } else {
        last = `HTTP ${resp.status} from ${url}`;
      }
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { ok: false, reason: `timed out after ${seconds}s: ${last}` };
}

/**
 * Hand the owner token to git's credential store and remember the vault, which
 * is exactly what `cofferdam login` does with a token typed by hand. Reported
 * rather than fatal: the deployment is up either way, and a machine with no
 * credential helper should be told how to finish rather than told it failed.
 */
async function storeOwnerToken(url: string, username: string, token: string): Promise<boolean> {
  const target = credentialTarget(url);
  const helper = await configuredHelper(target.url);
  if (!helper) {
    console.log('');
    console.log(`No credential helper is configured for ${target.url}, so git has nowhere to keep the token.`);
    console.log('Finish by choosing where it should live:');
    console.log('');
    console.log(`  cofferdam login ${url} --helper store   # or cache, libsecret, osxkeychain`);
    console.log('');
    console.log('The owner token, which is shown here once:');
    console.log('');
    console.log(`  ${token}`);
    return false;
  }
  await approveCredential(target, username, token);
  const stored = await readCredential(target);
  if (!stored || stored.password !== token) {
    console.log('');
    console.log(`The credential helper '${helper}' did not keep the token. Store it by hand with:`);
    console.log('');
    console.log(`  cofferdam login ${url} --token ${token}`);
    return false;
  }
  saveLogin(url);
  return true;
}

export async function deployFlyCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseDeployArgs(args, usage);
  if (!a.app) {
    die(
      'Which app? Fly app names are globally unique, and the name becomes the URL:\n\n' +
        '  cofferdam deploy fly my-vault-name    ->  https://my-vault-name.fly.dev\n'
    );
  }
  const app = a.app;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(app)) {
    die(`Not a valid Fly app name: ${app}\nUse lowercase letters, digits, and dashes.`);
  }
  await requireFly();

  const existed = await appExists(app);
  const live = existed ? await liveSettings(app) : {};
  const settings = resolveSettings(a, live);
  const image = a.image ?? `${IMAGE_REPO}:${ownVersion()}`;

  // A volume cannot move, so a region flag that disagrees with the volume that
  // exists is a request this cannot carry out. Saying so beats deploying a
  // machine in one region that can never attach the disk in another.
  if (existed && live.region && a.region && a.region !== live.region) {
    die(
      `This vault's volume is in ${live.region}, and a volume cannot be moved to ${a.region}.\n` +
        'Deploying to another region means a new vault and copying the data across.'
    );
  }

  if (existed) {
    console.log(`==> Updating '${app}' (${appUrl(app)})`);
  } else {
    console.log(`==> Creating '${app}' in ${settings.region}`);
    const created = await flyStream(['apps', 'create', app, ...(a.org ? ['--org', a.org] : [])]);
    if (created !== 0) {
      die(
        `\nCould not create the Fly app '${app}'.\n` +
          'App names are globally unique, so a name in use by anyone stops this. Try another.'
      );
    }
  }

  const vol = await vaultVolume(app);
  if (!vol) {
    console.log(`==> Creating a ${settings.volumeGb}GB volume '${VOLUME_NAME}' in ${settings.region}`);
    const code = await flyStream([
      'volumes',
      'create',
      VOLUME_NAME,
      '-a',
      app,
      '--region',
      settings.region,
      '--size',
      String(settings.volumeGb),
      '--yes',
    ]);
    if (code !== 0) die('\nCould not create the volume, so there is nowhere to keep the vault.');
  } else if (settings.volumeGb > vol.size_gb) {
    console.log(`==> Extending volume '${VOLUME_NAME}' from ${vol.size_gb}GB to ${settings.volumeGb}GB`);
    const code = await flyStream(['volumes', 'extend', vol.id, '-a', app, '--size', String(settings.volumeGb)]);
    if (code !== 0) die('\nCould not extend the volume.');
  } else if (a.volumeGb !== null && a.volumeGb < vol.size_gb) {
    // Fly volumes only grow. Ignoring this quietly would leave the operator
    // believing the vault had been shrunk, and paying for the old size.
    die(
      `The volume is ${vol.size_gb}GB and Fly volumes cannot be shrunk, so --volume ${a.volumeGb} cannot be applied.\n` +
        'Leave the flag off to keep the size it has.'
    );
  }

  const secrets = existed ? await secretNames(app) : [];

  if (a.lfsBucket && !secrets.includes('BUCKET_NAME')) {
    // Tigris' own secret names are the ones the LFS store already reads, so
    // provisioning a bucket is the whole configuration step.
    console.log('==> Provisioning a Tigris bucket for Git LFS objects');
    const code = await flyStream(['storage', 'create', '-a', app, '-n', `${app}-lfs`, '--yes']);
    if (code !== 0) {
      die(
        '\nCould not provision the bucket. The app and volume are already there, so\n' +
          'this command is safe to run again once the bucket problem is sorted out.'
      );
    }
  } else if (a.lfsBucket) {
    console.log('==> A bucket is already configured (BUCKET_NAME is set), leaving it alone');
  }

  // An owner token is minted only for a vault that has none. The question is
  // whether the vault has been initialized rather than whether the app exists,
  // because a first deploy that fails leaves the app behind: on the next
  // attempt the app is not new but the vault still is, and that retry should
  // end logged in like any other first deploy. Whether a machine has ever run
  // is as close to that question as Fly can be asked.
  //
  // The secret already being set is deliberately not part of it. A Fly secret
  // can be written and not read, so a token from an abandoned attempt is a
  // token nobody has; overwriting it with one this run knows is the only way
  // the retry can end logged in.
  //
  // Minting here rather than on the server is what makes that possible: the
  // server adopts this token when it initializes the vault, stores only its
  // hash, and never prints it.
  const ownerToken = existed && (await machines(app)).length > 0 ? null : mintToken().token;
  if (ownerToken) {
    console.log('==> Setting the one-time owner token as a Fly secret');
    const r = await fly(['secrets', 'set', `${OWNER_TOKEN_SECRET}=${ownerToken}`, '-a', app, '--stage']);
    if (r.code !== 0) die(`Could not set the owner token secret:\n${r.stderr.trim() || r.stdout.trim()}`);
  }

  const config = writeTempConfig(app, settings);
  console.log(`==> Deploying ${image}`);
  const code = await flyStream([
    'deploy',
    '--app',
    app,
    '--config',
    config,
    '--image',
    image,
    '--ha=false',
    '--yes',
  ]);
  fs.rmSync(path.dirname(config), { recursive: true, force: true });
  if (code !== 0) {
    console.error('');
    console.error('The deploy failed. Nothing here is lost: the app, the volume, and the vault on it');
    console.error('survive, so fix the cause and run the same command again.');
    if (a.image === null) {
      console.error('');
      console.error(`If the image is the problem, check that ${image} exists,`);
      console.error('or deploy another tag with --image <ref>.');
    }
    process.exit(1);
  }

  const url = appUrl(app);
  console.log('');
  if (!ownerToken) {
    console.log(`==> Deployed: ${url}`);
    console.log('');
    console.log('The vault it serves is the one that was already there, users and all.');
    console.log(`  fly logs -a ${app}`);
    return;
  }

  console.log('==> Waiting for the vault to answer');
  const ready = await waitForVault(url, ownerToken);
  if (!ready.ok) {
    console.error('');
    console.error(`Deployed, but ${ready.reason}.`);
    console.error(`Look at what the server said: fly logs -a ${app}`);
    if (existed) {
      // The likeliest cause when the app was already there: a volume carrying
      // a vault that was initialized by an earlier machine. Its own tokens are
      // still the way in, and no token minted here will ever work on it.
      console.error('');
      console.error('If this app has served a vault before, that vault keeps the users and tokens it');
      console.error('already had, and a token minted now is not one of them. Log in with one of those:');
      console.error('');
      console.error(`  cofferdam login ${url}`);
    } else {
      console.error('');
      console.error('The owner token that was set as a secret, shown here once:');
      console.error('');
      console.error(`  ${ownerToken}`);
    }
    process.exit(1);
  }

  const loggedIn = await storeOwnerToken(url, ready.username, ownerToken);
  console.log('');
  console.log(`==> Ready: ${url}`);
  if (loggedIn) {
    console.log('');
    console.log(`Logged in as '${ready.username}'. Nothing to paste: the token is in git's credential`);
    console.log('store, so both cofferdam and git will use it.');
    console.log('');
    console.log('  cofferdam whoami');
    console.log("  cofferdam user add alice --scope 'alice/*'");
    console.log(`  cofferdam import https://github.com/someone/something.git mine`);
    console.log('');
    console.log('Deploy an update, or change a setting, with the same command:');
    console.log('');
    console.log(`  cofferdam deploy fly ${app}`);
    console.log(`  cofferdam deploy fly ${app} --volume 50 --vm-memory 1gb`);
  }
}

export async function deployShowCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseDeployArgs(args, usage);
  if (!a.app) die('Which app? Usage: cofferdam deploy show <app>');
  const app = a.app;
  await requireFly();
  if (!(await appExists(app))) {
    die(`No Fly app named '${app}' that you can see. Check the name, or: fly apps list`);
  }

  const url = appUrl(app);
  const vol = await vaultVolume(app);
  const ms = await machines(app);
  const secrets = await secretNames(app);

  console.log(`${app}  ${url}`);
  console.log('');
  if (ms.length === 0) {
    console.log('  machines  none, so nothing is serving this vault');
  } else {
    // More than one machine is worth naming rather than summarizing: it means
    // two volumes and two vaults, which is the failure --ha=false prevents.
    if (ms.length > 1) console.log(`  machines  ${ms.length}, which is one too many for a single-volume vault`);
    for (const m of ms) {
      const g = m.config?.guest;
      const shape = g ? `${g.cpu_kind}-cpu-${g.cpus}x, ${g.memory_mb}mb` : 'unknown shape';
      console.log(`  machine   ${m.id}  ${m.state ?? '?'}  ${m.region ?? '?'}  ${shape}`);
      console.log(`  image     ${m.config?.image ?? 'unknown'}`);
    }
  }
  console.log(vol ? `  volume    ${vol.size_gb}GB in ${vol.region} (${vol.state ?? 'created'})` : '  volume    none');
  console.log(`  lfs       ${secrets.includes('BUCKET_NAME') ? 'objects in a bucket (BUCKET_NAME is set)' : 'objects on the volume'}`);

  // Whether it works, which is the question `fly status` cannot answer. A
  // stored credential turns this into a report of who you are on it.
  const target = credentialTarget(url);
  const stored = await readCredential(target);
  let vault = 'not reachable';
  try {
    const resp = await fetch(`${url}/api/whoami`, {
      headers: stored ? { authorization: `Bearer ${stored.password}` } : {},
    });
    if (resp.ok) {
      const data = (await resp.json()) as { username?: unknown };
      vault = `answering, and you are '${String(data.username)}' on it`;
    } else if (resp.status === 401) {
      vault = stored ? 'answering, but your stored token is not valid on it' : 'answering (no token stored here)';
    } else {
      vault = `answering with HTTP ${resp.status}`;
    }
  } catch (e) {
    vault = `not reachable: ${e instanceof Error ? e.message : e}`;
  }
  console.log(`  vault     ${vault}`);
  const saved = loadLogin();
  if (saved && saved.host.replace(/\/+$/, '') === url) console.log('  login     this is the vault cofferdam commands use');
  console.log('');
  console.log(`  fly logs -a ${app}`);
}

function promptLine(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('Nothing to ask on: not a terminal. Pass --yes to confirm.'));
      return;
    }
    process.stdout.write(prompt);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      resolve(chunk.trim());
    };
    process.stdin.on('data', onData);
  });
}

export async function deployDestroyCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseDeployArgs(args, usage);
  if (!a.app) die('Which app? Usage: cofferdam deploy destroy <app> [--yes]');
  const app = a.app;
  await requireFly();
  if (!(await appExists(app))) {
    die(`No Fly app named '${app}' that you can see. Check the name, or: fly apps list`);
  }

  const vol = await vaultVolume(app);
  const hadBucket = (await secretNames(app)).includes('BUCKET_NAME');

  if (!a.yes) {
    console.log(`This destroys the Fly app '${app}' and its ${vol ? `${vol.size_gb}GB ` : ''}volume.`);
    console.log('Everything in the vault goes with it: repositories, issues, pull requests, users.');
    console.log('There is no undo, and Fly keeps no backup of a destroyed volume.');
    console.log('');
    const answer = await promptLine(`Type the app name to confirm: `);
    if (answer !== app) die('Not destroyed.');
  }

  const code = await flyStream(['apps', 'destroy', app, '--yes']);
  if (code !== 0) die('\nCould not destroy the app.');

  // A credential for a vault that no longer exists is litter, and a saved
  // login pointing at it would send the next command nowhere.
  const url = appUrl(app);
  const target = credentialTarget(url);
  const stored = await readCredential(target);
  if (stored) {
    await rejectCredential(target, stored.username);
    console.log(`Removed the stored credential for ${url}.`);
  }
  clearLogin(url);

  if (hadBucket) {
    console.log('');
    console.log('The Tigris bucket that held this vault\'s LFS objects is a separate resource and');
    console.log('was not destroyed. Remove it, and its contents, with:');
    console.log('');
    console.log('  fly storage list');
    console.log('  fly storage destroy <name>');
  }
}

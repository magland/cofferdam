#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import {
  CredentialTarget,
  approveCredential,
  clearLogin,
  configuredHelper,
  credentialTarget,
  loadLogin,
  loginPath,
  readCredential,
  rejectCredential,
  saveLogin,
  setHelper,
} from './credentials';
import { api } from './cli-api';
import { apiCommand } from './cli/api-cmd';
import { issueCommands } from './cli/issue-cmd';
import { prCommands } from './cli/pr-cmd';
import { repoCommands } from './cli/repo-cmd';
import { runCommands } from './cli/run-cmd';
import { CliError, EXIT_FAIL, EXIT_USAGE, jsonErrorsWanted } from './cli/exit';
import { readStdin } from './cli/input';
import { JSON_OPTION, jsonMode, pickFields, pickObject, printJson } from './cli/output';
import { Cli, Command, Invocation, OptionSpec, dispatch, registryJson } from './cli/parse';
import { TARGET_OPTIONS, targetFrom } from './cli/target';
import { collectionAddCmd, collectionListCmd, importCmd } from './import-cli';
import { deployDestroyCmd, deployFlyCmd, deployShowCmd } from './deploy-cli';
import { runnerAddCmd, runnerListCmd, runnerRemoveCmd, runnerRunCmd } from './runner-cli';
import { seedTrustProxy } from './config';
import { createApp } from './server';
import { isValidName } from './scan';
import { DEFAULT_THEME, themeNames } from './themes';
import { bootstrapVault } from './vault';

// The CLI's commands, as a registry rather than a chain of string comparisons
// with one help text covering all of them. See src/cli/parse.ts for why.

const FOOTER = `Configuration:
  cofferdam login https://vault.example.com   once, then the rest need no arguments

The vault URL is kept in ~/.config/cofferdam/login.json and the token in git's
own credential store. --host and --token override either for a single command,
and COFFERDAM_HOST and COFFERDAM_TOKEN sit between the two, for a caller with
no keyring and possibly no writable home directory.

Vault layout:
  <vault>/<collection>/<repo>.git    bare repositories (the .git suffix is optional)
  <vault>/<collection>/<repo>.site   optional static site for a repo
  <vault>/<collection>/<repo>.lfs    Git LFS objects, when no bucket is configured
  <vault>/<collection>/<repo>.runs   workflow run history and logs
  <vault>/vault.json                 users and hashed tokens (server-managed)
  <vault>/runners.json               registered runners (server-managed)
  <vault>/config.json                vault settings: theme, and CI run retention
  <vault>/.secret                    session-cookie signing key (server-managed)

Themes: ${themeNames().join(', ')} (default ${DEFAULT_THEME}). Pick one under
Admin > Appearance in the web interface, or write config.json by hand.`;

// ---- serve ----

function serveCmd(args: string[], usage: () => never) {
  let dir: string | null = null;
  let port = 3000;
  let host = '127.0.0.1';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') usage();
    else if (a === '-p' || a === '--port') port = parseInt(args[++i], 10);
    else if (a === '--host') host = args[++i];
    else if (a.startsWith('-')) throw new CliError(`Unknown option: ${a}`, EXIT_USAGE);
    else dir = a;
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new CliError('Invalid port', EXIT_USAGE);
  const vault = path.resolve(dir ?? process.env.COFFERDAM_VAULT ?? '.');
  if (!fs.existsSync(vault) || !fs.statSync(vault).isDirectory()) {
    throw new CliError(`Vault directory does not exist: ${vault}`);
  }
  // A vault with no vault.json is initialized on first start. The owner token
  // is normally minted here and printed once; COFFERDAM_OWNER_TOKEN lets the
  // operator supply it instead, which is how `cofferdam deploy` hands a remote
  // vault a token it already holds. A supplied token is not printed: it is
  // already where it needs to be, and a hosted server's log is not a good
  // place to leave a copy.
  const boot = bootstrapVault(vault, process.env.COFFERDAM_OWNER_TOKEN ?? null);
  // Set by `cofferdam deploy fly`, which knows there is a TLS proxy in front but
  // cannot write to the volume before the vault exists. It only seeds the
  // setting; config.json remains the place it lives and can be edited by hand.
  const seeded = process.env.COFFERDAM_TRUST_PROXY === '1' ? seedTrustProxy(vault) : false;
  const app = createApp(vault);
  app.listen(port, host, () => {
    const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
    if (boot && boot.preset) {
      console.log('');
      console.log('Initialized a new vault (no vault.json found).');
      console.log(`Owner '${boot.username}' was given the token from COFFERDAM_OWNER_TOKEN, so it is`);
      console.log('not repeated here; only its hash is stored.');
      console.log('');
    } else if (boot) {
      console.log('');
      console.log('Initialized a new vault (no vault.json found).');
      console.log(`Owner token for user '${boot.username}' (shown once; only its hash is stored):`);
      console.log('');
      console.log(`  ${boot.token}`);
      console.log('');
      console.log('Sign in on the web with it, or manage users from anywhere:');
      console.log(`  cofferdam login ${url}`);
      console.log('');
    }
    if (seeded) console.log('Recorded network.trustProxy: true in config.json (COFFERDAM_TRUST_PROXY is set).');
    console.log(`cofferdam serving vault ${vault}`);
    console.log(`  ${url}`);
  });
}

// ---- users ----

const SCOPE_OPTIONS: OptionSpec[] = [
  { name: 'scope', type: 'string[]', value: '<glob>', summary: 'Push scope, as a glob over collection/repo' },
  { name: 'admin', type: 'string[]', value: '<glob>', summary: 'Admin scope: may manage users within it' },
];

// Removed rather than renamed, and kept only to say so: a `--vault` that
// silently became an unknown option would look like a typo rather than like a
// change of design.
const VAULT_OPTION: OptionSpec = {
  name: 'vault',
  type: 'string',
  hidden: true,
  summary: 'Removed: user commands talk to a running server',
};

function refuseVaultOption(inv: Invocation): void {
  if (inv.str('vault') !== null) {
    throw new CliError(
      '--vault is gone: user commands talk to a running server. Run `cofferdam login <url>` first.',
      EXIT_USAGE
    );
  }
}

function formatScopes(user: { scope: string[]; admin: string[] }): string {
  const parts = [`push: ${user.scope.join(', ') || '(none)'}`];
  if (user.admin.length) parts.push(`admin: ${user.admin.join(', ')}`);
  return parts.join('  ');
}

async function userAddCmd(inv: Invocation) {
  refuseVaultOption(inv);
  const username = inv.args[0];
  if (!isValidName(username)) {
    throw new CliError('A valid username is required (letters, digits, dot, underscore, dash)', EXIT_USAGE);
  }
  const scope = inv.list('scope');
  const admin = inv.list('admin');
  const tokenScope = inv.list('token-scope');
  const target = await targetFrom(inv);
  const data = await api(target, 'POST', '/api/users', {
    username,
    scope: scope.length ? scope : undefined,
    admin: admin.length ? admin : undefined,
    tokenScope: tokenScope.length ? tokenScope : undefined,
  });
  const json = jsonMode(inv);
  if (json.enabled) {
    printJson(pickObject(data, json.fields));
    return;
  }
  console.log(
    data.created
      ? `Created user '${data.username}' on ${target.host}`
      : `Minted a new token for existing user '${data.username}'`
  );
  console.log(`  ${formatScopes(data as { scope: string[]; admin: string[] })}`);
  if (tokenScope.length) console.log(`  this token is restricted to: ${tokenScope.join(', ')}`);
  console.log('');
  console.log('Token (copy it now; only its hash is stored):');
  console.log(`  ${data.token}`);
  console.log('');
  console.log(`Use it as the password with username '${data.username}' when git asks for credentials.`);
}

async function userGrantCmd(inv: Invocation) {
  refuseVaultOption(inv);
  const username = inv.args[0];
  const scope = inv.list('scope');
  const admin = inv.list('admin');
  if (scope.length === 0 && admin.length === 0) {
    throw new CliError(
      `Nothing to grant. Example: cofferdam user grant ${username} --scope 'mycollection/*'`,
      EXIT_USAGE
    );
  }
  const target = await targetFrom(inv);
  const data = await api(target, 'POST', `/api/users/${encodeURIComponent(username)}/grant`, {
    scope: scope.length ? scope : undefined,
    admin: admin.length ? admin : undefined,
  });
  const json = jsonMode(inv);
  if (json.enabled) {
    printJson(pickObject(data, json.fields));
    return;
  }
  console.log(`Granted to '${data.username}'`);
  console.log(`  ${formatScopes(data as { scope: string[]; admin: string[] })}`);
}

async function userListCmd(inv: Invocation) {
  refuseVaultOption(inv);
  const target = await targetFrom(inv);
  const data = await api(target, 'GET', '/api/users');
  const users = (data.users ?? []) as { name: string; scope: string[]; admin: string[]; tokens: number }[];
  const json = jsonMode(inv);
  if (json.enabled) {
    printJson({ users: pickFields(users as unknown as Record<string, unknown>[], json.fields) });
    return;
  }
  if (users.length === 0) {
    console.log(`No users on ${target.host}`);
    return;
  }
  const width = Math.max(...users.map((u) => u.name.length));
  for (const u of users) {
    const tokens = `${u.tokens} token${u.tokens === 1 ? '' : 's'}`;
    console.log(`${u.name.padEnd(width)}  ${tokens.padEnd(9)}  ${formatScopes(u)}`);
  }
}

async function whoamiCmd(inv: Invocation) {
  const target = await targetFrom(inv);
  const data = await api(target, 'GET', '/api/whoami');
  const json = jsonMode(inv);
  if (json.enabled) {
    printJson(pickObject(data, json.fields));
    return;
  }
  console.log(`${data.username} @ ${target.host}`);
  console.log(`  ${formatScopes(data as { scope: string[]; admin: string[] })}`);
  if (data.tokenScope) console.log(`  this token is restricted to: ${(data.tokenScope as string[]).join(', ')}`);
}

// ---- login and logout ----

// The vault being logged in to or out of: the URL given, the environment, or
// the one logged in to last, which is what makes `cofferdam logout` need no
// arguments.
function loginTarget(host: string | null): { host: string; target: CredentialTarget } {
  const resolved = (host ?? process.env.COFFERDAM_HOST ?? loadLogin()?.host ?? '').replace(/\/+$/, '');
  if (!resolved) throw new CliError('Which vault? Give its URL, e.g. https://vault.example.com', EXIT_USAGE);
  try {
    return { host: resolved, target: credentialTarget(resolved) };
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e), EXIT_USAGE);
  }
}

// A token is a credential and a terminal keeps scrollback, so it is read
// without echo. Passing --token instead would leave it in shell history, and
// --token-stdin hands one over with no terminal at all.
// Raw mode rather than readline: readline redraws its line through cursor
// control that bypasses any echo suppression, which erases the prompt.
function promptToken(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) {
      reject(new Error('No token given and no terminal to ask on. Pass --token <t> or --token-stdin.'));
      return;
    }
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let value = '';
    const finish = (err: Error | null) => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      if (err) reject(err);
      else resolve(value.trim());
    };
    // Raw mode delivers ^C as a byte rather than as SIGINT, so cancelling has
    // to be handled here or it would be pasted into the token.
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish(null);
        if (ch === '\u0003') return finish(new Error('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    input.on('data', onData);
  });
}

// login is the one command that reads a token without contacting a vault
// first, so it resolves --token and --token-stdin itself rather than through
// targetFrom.
async function tokenFor(inv: Invocation): Promise<string | null> {
  const flag = inv.str('token');
  if (inv.bool('token-stdin')) {
    if (flag) throw new CliError('Pass either --token or --token-stdin, not both.', EXIT_USAGE);
    const value = (await readStdin()).trim();
    if (!value) throw new CliError('--token-stdin was given but stdin was empty.', EXIT_USAGE);
    return value;
  }
  return flag ?? process.env.COFFERDAM_TOKEN?.trim() ?? null;
}

async function loginCmd(inv: Invocation) {
  const { host, target } = loginTarget(inv.args[0] ?? inv.str('host'));

  // Settle where the token would go before asking for one: being prompted for
  // a token and only then told there is nowhere to put it is the wrong order.
  const chosen = inv.str('helper');
  if (chosen) await setHelper(target.url, chosen);
  const helper = await configuredHelper(target.url);
  if (!helper) {
    console.error(`No credential helper is configured for ${target.url}, so git has nowhere to keep a token.`);
    console.error('Storing one would silently do nothing, so this is refused rather than reported as success.');
    console.error('');
    console.error('Choose where the token should live and run login again:');
    console.error('  cofferdam login --helper store        a file at ~/.git-credentials, mode 0600, in plain text');
    console.error('  cofferdam login --helper cache        memory only, forgotten after 15 minutes');
    console.error('  cofferdam login --helper libsecret    the desktop keyring, on Linux');
    console.error('  cofferdam login --helper osxkeychain  the login keychain, on macOS');
    console.error('');
    console.error(`The choice is recorded for ${target.url} alone; other remotes keep whatever they use now.`);
    process.exit(EXIT_FAIL);
  }

  const given = await tokenFor(inv);
  const token = given ?? (await promptToken(`Token for ${target.url}: `));
  if (!token) throw new CliError('No token given.', EXIT_USAGE);

  // Verified before it is stored. A token that does not work is worse stored
  // than absent: git would then fail with it instead of asking for a better one.
  const who = await api({ host, token }, 'GET', '/api/whoami');
  const username = String(who.username ?? '');
  if (!username) throw new CliError(`${host} did not say who this token belongs to.`);

  await approveCredential(target, username, token);

  // Read back rather than trusting the exit code: approve succeeds whether or
  // not the helper kept anything, and a helper that is configured but not
  // installed fails only here.
  const stored = await readCredential(target);
  if (!stored || stored.username !== username || stored.password !== token) {
    console.error(`The credential helper '${helper}' did not keep the token for ${target.url}.`);
    console.error(`Check that git credential-${helper} is installed and working.`);
    process.exit(EXIT_FAIL);
  }

  // Recorded only now: a login that could not keep its token is not a login,
  // and pointing later commands at a vault they cannot reach would be worse
  // than pointing them nowhere.
  saveLogin(host);

  console.log(`Stored the token for '${username}' at ${target.url} (helper: ${helper}).`);
  console.log(`  ${formatScopes(who as { scope: string[]; admin: string[] })}`);
  if (who.tokenScope) console.log(`  this token is restricted to: ${(who.tokenScope as string[]).join(', ')}`);
  console.log('');
  console.log('git clone, fetch, push, and git lfs against this vault will no longer ask for a password,');
  console.log(`and cofferdam commands talk to it by default (${loginPath()}).`);
  console.log('Run `cofferdam logout` to remove it again.');
}

async function logoutCmd(inv: Invocation) {
  if (inv.str('token') || inv.str('helper')) {
    throw new CliError('logout takes only --host: it removes a stored credential rather than making one.', EXIT_USAGE);
  }
  const { host, target } = loginTarget(inv.args[0] ?? inv.str('host'));
  const stored = await readCredential(target);
  if (!stored) {
    clearLogin(host);
    console.log(`No stored credential for ${target.url}.`);
    return;
  }
  await rejectCredential(target, stored.username);
  const after = await readCredential(target);
  if (after) {
    throw new CliError(
      `The credential for '${after.username}' at ${target.url} is still there: the helper did not erase it.`
    );
  }
  clearLogin(host);
  console.log(`Removed the stored credential for '${stored.username}' at ${target.url}.`);
}

// ---- the registry ----

/** A command whose own argument handling is left alone; it is dispatched and documented here all the same. */
function raw(
  path: string[],
  summary: string,
  description: string,
  run: (args: string[], usage: () => never) => void | Promise<void>
): Command {
  return {
    path,
    summary,
    description: description || undefined,
    raw: true,
    run: (inv) => run(inv.argv, () => inv.help()),
  };
}

const commands: Command[] = [
  raw(
    ['serve'],
    'Serve a vault over HTTP',
    `Serve a vault: a directory of collections containing bare git repositories.
The vault defaults to $COFFERDAM_VAULT, then the current directory. On the
first start with no vault.json, the server initializes one and prints an owner
token once.

Options:
  -p, --port <n>   port to listen on (default 3000)
  --host <h>       address to bind (default 127.0.0.1)`,
    serveCmd
  ),
  raw(
    ['import'],
    'Bring an existing repository into the vault',
    `Usage: cofferdam import <source> <collection>[/<name>] [--lfs]

Clone the source into a temporary directory, push it here, which creates it,
and remove the clone again. The source is an https or ssh git URL, owner/repo
for GitHub, or a directory on this machine; the name defaults to its last
segment. Nothing happens on the server, so the source is read with whatever git
credentials this machine already has. Branches and tags come across; --lfs
carries Git LFS objects too, and needs git-lfs installed.`,
    importCmd
  ),
  raw(
    ['collection', 'add'],
    'Create an empty collection',
    `Pushing to a new path creates its collection on the way, so this is for the
other order: making the collection first and filling it afterwards.`,
    collectionAddCmd
  ),
  raw(
    ['collection', 'list'],
    "Show the vault's collections and how many repositories each holds",
    '',
    collectionListCmd
  ),
  {
    path: ['user', 'add'],
    summary: 'Create a user and print its token once',
    description: `A new user defaults to push scope "*"; --admin globs let the user manage other
users within those globs. Run again without --scope on an existing user to mint
an additional token. Only a SHA-256 hash of a token is ever stored, so the token
is shown once and cannot be recovered afterwards.`,
    args: [{ name: 'username', required: true }],
    options: [
      ...SCOPE_OPTIONS,
      { name: 'token-scope', type: 'string[]', value: '<glob>', summary: 'Restrict this token alone to these globs' },
      VAULT_OPTION,
      JSON_OPTION,
      ...TARGET_OPTIONS,
    ],
    run: userAddCmd,
  },
  {
    path: ['user', 'grant'],
    summary: "Extend an existing user's push and admin scope",
    description: `Globs match collection/repo: "mycollection/*" is a whole collection,
"mycollection/myrepo" a single repository, "*" everything. Existing globs are
kept.`,
    args: [{ name: 'username', required: true }],
    options: [...SCOPE_OPTIONS, VAULT_OPTION, JSON_OPTION, ...TARGET_OPTIONS],
    run: userGrantCmd,
  },
  {
    path: ['user', 'list'],
    summary: 'Show users, their scopes, and how many tokens each has',
    options: [VAULT_OPTION, JSON_OPTION, ...TARGET_OPTIONS],
    run: userListCmd,
  },
  {
    path: ['whoami'],
    summary: 'Show the user, scopes, and token restriction for the current token',
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    run: whoamiCmd,
  },
  {
    path: ['login'],
    summary: 'Log in to a vault and hand the token to git',
    description: `Ask for a token, check it, and hand it to git's credential store, so that clone,
fetch, push, git lfs, and every other cofferdam command stop asking for it. The
vault URL is remembered, so later commands need no arguments. The token is read
back after storing to confirm it was really kept.

--helper picks where it lives (store, cache, libsecret, osxkeychain) and is
recorded for this vault's host alone; without it, whatever git is already
configured to use for that host is used, and login refuses rather than storing
nothing when that is nothing.`,
    args: [{ name: 'vault-url' }],
    options: [
      {
        name: 'helper',
        type: 'string',
        value: '<name>',
        summary: 'Where the token lives: store, cache, libsecret, osxkeychain',
      },
      ...TARGET_OPTIONS,
    ],
    run: loginCmd,
  },
  {
    path: ['logout'],
    summary: "Remove this vault's stored credential and forget the vault",
    args: [{ name: 'vault-url' }],
    options: [
      { name: 'helper', type: 'string', value: '<name>', hidden: true, summary: 'Not accepted by logout' },
      ...TARGET_OPTIONS,
    ],
    run: logoutCmd,
  },
  raw(
    ['deploy', 'fly'],
    'Put a vault on Fly.io, or deploy an update to one',
    `Usage: cofferdam deploy fly <app> [--region <r>] [--volume <gb>] [--vm-size <s>]
                            [--vm-memory <m>] [--lfs-bucket] [--image <ref>] [--org <o>]

Needs flyctl installed, and fly auth login done. The app name is globally
unique on Fly and becomes the URL, https://<app>.fly.dev. Creating one mints
the owner token here and hands it to the server as a secret, then prints it once
the vault answers, with how to sign in on the web and how to store it for the
CLI and git. Nothing is kept on this machine: cofferdam login with that token is
what does that. Run it again to deploy a new version; settings not named by a
flag keep whatever the live app has, so a single flag changes a single thing. A
vault is a directory on one volume, so the app runs as exactly one machine: a
busier vault wants a bigger one, not more.

See also: cofferdam deploy fly show <app>, cofferdam deploy fly destroy <app>.`,
    deployFlyCmd
  ),
  raw(['deploy', 'fly', 'show'], 'What Fly has for this app, and whether the vault answers', '', deployShowCmd),
  raw(
    ['deploy', 'fly', 'destroy'],
    'Destroy the app and its volume, and with them the vault',
    'No undo. Pass --yes to skip the confirmation.',
    deployDestroyCmd
  ),
  raw(
    ['runner', 'add'],
    'Register a machine that will execute workflow jobs',
    `Usage: cofferdam runner add <name> --allow <glob>... [--labels <l,...>] [--save]

Prints its token once. --allow says which repositories it may take jobs for, as
globs over collection/repo; your admin scope must cover them. Jobs never run on
the vault's machine, so a vault with no runner queues its runs and waits.`,
    runnerAddCmd
  ),
  raw(
    ['runner', 'run'],
    'Take jobs and run them, one at a time, each in a Docker container',
    `Usage: cofferdam runner run [--host <url>] [--runner-token <t>] [--labels <l,...>]

Reads ~/.config/cofferdam/runner.json when given no arguments. Needs a working
docker command; --image <label>=<image> overrides which image a runs-on label
maps to. Actions named by uses: are fetched from github.com (--actions-url
changes that) and cached under ~/.cache/cofferdam (--cache-dir changes that),
keyed by the commit the ref resolves to, so a moved branch or tag is picked up
on the next run; --no-action-cache downloads every time. --work-dir sets where
job workspaces are made, --network which Docker network the container joins,
and COFFERDAM_RUNNER_TOKEN supplies the token instead of --runner-token.`,
    runnerRunCmd
  ),
  raw(['runner', 'list'], 'Show registered runners (admin token, as with users)', '', runnerListCmd),
  raw(['runner', 'remove'], 'Remove a registered runner', '', runnerRemoveCmd),
  ...repoCommands,
  ...issueCommands,
  ...prCommands,
  ...runCommands,
  apiCommand,
  {
    path: ['commands'],
    summary: 'List every command, its arguments, and its options',
    description: `With --json this is the whole registry as data, which is enough to discover the
command set without reading any documentation.`,
    options: [JSON_OPTION],
    run: (inv) => {
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(registryJson(cli));
        return;
      }
      for (const c of cli.commands) console.log(`${c.path.join(' ').padEnd(24)}  ${c.summary}`);
    },
  },
];

const cli: Cli = {
  name: 'cofferdam',
  groups: [
    { name: 'repo', summary: 'Repositories: what the vault holds' },
    { name: 'branch', summary: 'Branches' },
    { name: 'tag', summary: 'Tags' },
    { name: 'file', summary: 'Files in a repository, at a ref' },
    { name: 'commit', summary: 'Commits and their patches' },
    { name: 'issue', summary: 'Issues' },
    { name: 'pr', summary: 'Pull requests' },
    { name: 'workflow', summary: 'Workflow files, and dispatching them by hand' },
    { name: 'run', summary: 'Workflow runs, their logs, and their artifacts' },
    { name: 'collection', summary: 'Collections: the directories a vault holds repositories in' },
    { name: 'user', summary: 'Users, their scopes, and their tokens' },
    { name: 'deploy', summary: 'Put a vault on Fly.io and manage it there' },
    { name: 'runner', summary: 'Machines that execute workflow jobs' },
  ],
  commands,
  footer: FOOTER,
};

async function main() {
  await dispatch(cli, process.argv.slice(2));
}

main().catch((e) => {
  const message = e instanceof Error ? e.message : String(e);
  // A caller that asked for JSON gets JSON on failure too, so that parsing
  // stderr is possible rather than nearly possible.
  if (jsonErrorsWanted()) process.stderr.write(JSON.stringify({ error: message }) + '\n');
  else console.error(message);
  process.exit(e instanceof CliError ? e.code : EXIT_FAIL);
});

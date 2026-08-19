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
import { api, remoteTarget } from './cli-api';
import { collectionAddCmd, collectionListCmd, importCmd } from './import-cli';
import { runnerAddCmd, runnerListCmd, runnerRemoveCmd, runnerRunCmd } from './runner-cli';
import { createApp } from './server';
import { isValidName } from './scan';
import { DEFAULT_THEME, themeNames } from './themes';
import { bootstrapVault } from './vault';

function usage(code = 0): never {
  console.log(`Usage:
  cofferdam serve [vault-dir] [-p|--port <n>] [--host <h>]
      Serve a vault (a directory of collections containing bare git repositories).
      The vault defaults to $COFFERDAM_VAULT, then the current directory. On the
      first start with no vault.json, the server initializes one and prints
      an owner token once.

  cofferdam import <source> <collection>[/<name>]
      Bring an existing repository into the vault: clone it into a temporary
      directory, push it here, which creates it, and remove the clone again.
      The source is an https or ssh git URL, owner/repo for GitHub, or a
      directory on this machine; the name defaults to its last segment.
      Nothing happens on the server, so the source is read with whatever git
      credentials this machine already has. Branches and tags come across;
      --lfs carries Git LFS objects too, and needs git-lfs installed.

  cofferdam collection add <name>
      Create an empty collection. Pushing to a new path creates its collection
      on the way, so this is for the other order: making the collection first
      and filling it afterwards.

  cofferdam collection list
      Show the vault's collections and how many repositories each holds.

  cofferdam user add <username> [--scope <glob>]... [--admin <glob>]... [--token-scope <glob>]...
      Create a user and print its token once (only a SHA-256 hash is
      stored). A new user defaults to push scope "*"; --admin globs let the
      user manage other users within those globs. Run again without --scope
      on an existing user to mint an additional token.

  cofferdam user grant <username> [--scope <glob>]... [--admin <glob>]...
      Extend an existing user's push scope and/or admin scope. Globs match
      collection/repo: "mycollection/*" is a whole collection,
      "mycollection/myrepo" a single repository, "*" everything. Existing
      globs are kept.

  cofferdam user list
      Show users, their scopes, and how many tokens each has.

  cofferdam whoami
      Show the user, scopes, and token restriction for the current token.

  cofferdam login [<vault-url>] [--helper <name>]
      Log in to a vault: ask for a token, check it, and hand it to git's
      credential store, so that clone, fetch, push, git lfs, and every other
      cofferdam command stop asking for it. The vault URL is remembered, so
      later commands need no arguments. The token is read back after storing
      to confirm it was really kept. --helper picks where it lives (store,
      cache, libsecret, osxkeychain) and is recorded for this vault's host
      alone; without it, whatever git is already configured to use for that
      host is used, and login refuses rather than storing nothing when that
      is nothing.

  cofferdam logout [<vault-url>]
      Remove this vault's stored credential again, and forget it as the
      vault later commands talk to.

  cofferdam runner add <name> --allow <glob>... [--labels <l,...>] [--save]
      Register a machine that will execute workflow jobs, and print its
      token once. --allow says which repositories it may take jobs for, as
      globs over collection/repo; your admin scope must cover them. Jobs
      never run on the vault's machine, so a vault with no runner queues
      its runs and waits.

  cofferdam runner run [--host <url>] [--runner-token <t>] [--labels <l,...>]
      Take jobs and run them, one at a time, each in a Docker container.
      Reads ~/.config/cofferdam/runner.json when given no arguments. Needs a
      working docker command; --image <label>=<image> overrides which image
      a runs-on label maps to. Actions named by uses: are fetched from
      github.com (--actions-url changes that) and cached under
      ~/.cache/cofferdam (--cache-dir changes that), keyed by the commit the ref
      resolves to, so a moved branch or tag is picked up on the next run;
      --no-action-cache downloads every time.

  cofferdam runner list
  cofferdam runner remove <name>
      Show or remove registered runners (admin token, as with users).

User commands talk to a running cofferdam server, as the user you logged in as:

  cofferdam login https://vault.example.com   once, then the rest just work

The vault URL is kept in ~/.config/cofferdam/login.json and the token in git's
own credential store. --host <url> and --token <t> override either one for a
single command.

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
Admin > Appearance in the web interface, or write config.json by hand.
`);
  process.exit(code);
}

function serveCmd(args: string[]) {
  let dir: string | null = null;
  let port = 3000;
  let host = '127.0.0.1';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') usage();
    else if (a === '-p' || a === '--port') port = parseInt(args[++i], 10);
    else if (a === '--host') host = args[++i];
    else if (a.startsWith('-')) {
      console.error(`Unknown option: ${a}`);
      process.exit(1);
    } else dir = a;
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error('Invalid port');
    process.exit(1);
  }
  const vault = path.resolve(dir ?? process.env.COFFERDAM_VAULT ?? '.');
  if (!fs.existsSync(vault) || !fs.statSync(vault).isDirectory()) {
    console.error(`Vault directory does not exist: ${vault}`);
    process.exit(1);
  }
  const boot = bootstrapVault(vault);
  const app = createApp(vault);
  app.listen(port, host, () => {
    const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
    if (boot) {
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
    console.log(`cofferdam serving vault ${vault}`);
    console.log(`  ${url}`);
  });
}

interface UserArgs {
  username: string | null;
  host: string | null;
  token: string | null;
  scope: string[];
  admin: string[];
  tokenScope: string[];
}

function parseUserArgs(args: string[]): UserArgs {
  const out: UserArgs = { username: null, host: null, token: null, scope: [], admin: [], tokenScope: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') usage();
    else if (a === '--host') out.host = args[++i];
    else if (a === '--token') out.token = args[++i];
    else if (a === '--scope') out.scope.push(args[++i]);
    else if (a === '--admin') out.admin.push(args[++i]);
    else if (a === '--token-scope') out.tokenScope.push(args[++i]);
    else if (a === '--vault') {
      console.error('--vault is gone: user commands talk to a running server. Run `cofferdam login <url>` first.');
      process.exit(1);
    } else if (a.startsWith('-')) {
      console.error(`Unknown option: ${a}`);
      process.exit(1);
    } else if (!out.username) out.username = a;
    else {
      console.error(`Unexpected argument: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

function formatScopes(user: { scope: string[]; admin: string[] }): string {
  const parts = [`push: ${user.scope.join(', ') || '(none)'}`];
  if (user.admin.length) parts.push(`admin: ${user.admin.join(', ')}`);
  return parts.join('  ');
}

async function userAddCmd(args: string[]) {
  const a = parseUserArgs(args);
  if (!a.username || !isValidName(a.username)) {
    console.error('A valid username is required (letters, digits, dot, underscore, dash)');
    process.exit(1);
  }
  const target = await remoteTarget(a);
  const data = await api(target, 'POST', '/api/users', {
    username: a.username,
    scope: a.scope.length ? a.scope : undefined,
    admin: a.admin.length ? a.admin : undefined,
    tokenScope: a.tokenScope.length ? a.tokenScope : undefined,
  });
  console.log(
    data.created
      ? `Created user '${data.username}' on ${target.host}`
      : `Minted a new token for existing user '${data.username}'`
  );
  console.log(`  ${formatScopes(data as { scope: string[]; admin: string[] })}`);
  if (a.tokenScope.length) console.log(`  this token is restricted to: ${a.tokenScope.join(', ')}`);
  console.log('');
  console.log('Token (copy it now; only its hash is stored):');
  console.log(`  ${data.token}`);
  console.log('');
  console.log(`Use it as the password with username '${data.username}' when git asks for credentials.`);
}

async function userGrantCmd(args: string[]) {
  const a = parseUserArgs(args);
  if (!a.username) {
    console.error('Usage: cofferdam user grant <username> --scope <glob> [--admin <glob>]...');
    process.exit(1);
  }
  if (a.scope.length === 0 && a.admin.length === 0) {
    console.error(`Nothing to grant. Example: cofferdam user grant ${a.username} --scope 'mycollection/*'`);
    process.exit(1);
  }
  const target = await remoteTarget(a);
  const data = await api(target, 'POST', `/api/users/${encodeURIComponent(a.username)}/grant`, {
    scope: a.scope.length ? a.scope : undefined,
    admin: a.admin.length ? a.admin : undefined,
  });
  console.log(`Granted to '${data.username}'`);
  console.log(`  ${formatScopes(data as { scope: string[]; admin: string[] })}`);
}

async function userListCmd(args: string[]) {
  const a = parseUserArgs(args);
  if (a.username) {
    console.error(`Unexpected argument: ${a.username}`);
    process.exit(1);
  }
  const target = await remoteTarget(a);
  const data = await api(target, 'GET', '/api/users');
  const users = (data.users ?? []) as { name: string; scope: string[]; admin: string[]; tokens: number }[];
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

async function whoamiCmd(args: string[]) {
  const a = parseUserArgs(args);
  const target = await remoteTarget(a);
  const data = await api(target, 'GET', '/api/whoami');
  console.log(`${data.username} @ ${target.host}`);
  console.log(`  ${formatScopes(data as { scope: string[]; admin: string[] })}`);
  if (data.tokenScope) console.log(`  this token is restricted to: ${(data.tokenScope as string[]).join(', ')}`);
}

interface LoginArgs {
  host: string | null;
  token: string | null;
  helper: string | null;
}

function parseLoginArgs(args: string[]): LoginArgs {
  const out: LoginArgs = { host: null, token: null, helper: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') usage();
    else if (a === '--host') out.host = args[++i];
    else if (a === '--token') out.token = args[++i];
    else if (a === '--helper') out.helper = args[++i];
    else if (!a.startsWith('-') && !out.host) out.host = a;
    else {
      console.error(`Unexpected argument: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

// The vault being logged in to or out of: the URL given, or the one logged in
// to last, which is what makes `cofferdam logout` need no arguments.
function loginTarget(args: LoginArgs): { host: string; target: CredentialTarget } {
  const host = (args.host ?? loadLogin()?.host ?? '').replace(/\/+$/, '');
  if (!host) {
    console.error('Which vault? Give its URL, e.g. https://vault.example.com');
    process.exit(1);
  }
  try {
    return { host, target: credentialTarget(host) };
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

// A token is a credential and a terminal keeps scrollback, so it is read
// without echo. Passing --token instead would leave it in shell history.
// Raw mode rather than readline: readline redraws its line through cursor
// control that bypasses any echo suppression, which erases the prompt.
function promptToken(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) {
      reject(new Error('No token given and no terminal to ask on. Pass --token <t>.'));
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

async function loginCmd(args: string[]) {
  const a = parseLoginArgs(args);
  const { host, target } = loginTarget(a);

  // Settle where the token would go before asking for one: being prompted for
  // a token and only then told there is nowhere to put it is the wrong order.
  if (a.helper) await setHelper(target.url, a.helper);
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
    process.exit(1);
  }

  const token = a.token ?? (await promptToken(`Token for ${target.url}: `));
  if (!token) {
    console.error('No token given.');
    process.exit(1);
  }

  // Verified before it is stored. A token that does not work is worse stored
  // than absent: git would then fail with it instead of asking for a better one.
  const who = await api({ host, token }, 'GET', '/api/whoami');
  const username = String(who.username ?? '');
  if (!username) {
    console.error(`${host} did not say who this token belongs to.`);
    process.exit(1);
  }

  await approveCredential(target, username, token);

  // Read back rather than trusting the exit code: approve succeeds whether or
  // not the helper kept anything, and a helper that is configured but not
  // installed fails only here.
  const stored = await readCredential(target);
  if (!stored || stored.username !== username || stored.password !== token) {
    console.error(`The credential helper '${helper}' did not keep the token for ${target.url}.`);
    console.error(`Check that git credential-${helper} is installed and working.`);
    process.exit(1);
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

async function logoutCmd(args: string[]) {
  const a = parseLoginArgs(args);
  if (a.token || a.helper) {
    console.error('logout takes only --host: it removes a stored credential rather than making one.');
    process.exit(1);
  }
  const { host, target } = loginTarget(a);
  const stored = await readCredential(target);
  if (!stored) {
    clearLogin(host);
    console.log(`No stored credential for ${target.url}.`);
    return;
  }
  await rejectCredential(target, stored.username);
  const after = await readCredential(target);
  if (after) {
    console.error(`The credential for '${after.username}' at ${target.url} is still there: the helper did not erase it.`);
    process.exit(1);
  }
  clearLogin(host);
  console.log(`Removed the stored credential for '${stored.username}' at ${target.url}.`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === undefined || cmd === '-h' || cmd === '--help') usage();
  else if (cmd === 'serve') serveCmd(args.slice(1));
  else if (cmd === 'import') await importCmd(args.slice(1), usage);
  else if (cmd === 'collection' && args[1] === 'add') await collectionAddCmd(args.slice(2), usage);
  else if (cmd === 'collection' && args[1] === 'list') await collectionListCmd(args.slice(2), usage);
  else if (cmd === 'collection') {
    console.error('Usage: cofferdam collection <add|list> ... (see cofferdam --help)');
    process.exit(1);
  }
  else if (cmd === 'user' && args[1] === 'add') await userAddCmd(args.slice(2));
  else if (cmd === 'user' && args[1] === 'grant') await userGrantCmd(args.slice(2));
  else if (cmd === 'user' && args[1] === 'list') await userListCmd(args.slice(2));
  else if (cmd === 'whoami') await whoamiCmd(args.slice(1));
  else if (cmd === 'login') await loginCmd(args.slice(1));
  else if (cmd === 'logout') await logoutCmd(args.slice(1));
  else if (cmd === 'runner' && args[1] === 'add') await runnerAddCmd(args.slice(2), usage);
  else if (cmd === 'runner' && args[1] === 'run') await runnerRunCmd(args.slice(2), usage);
  else if (cmd === 'runner' && args[1] === 'list') await runnerListCmd(args.slice(2), usage);
  else if (cmd === 'runner' && args[1] === 'remove') await runnerRemoveCmd(args.slice(2), usage);
  else if (cmd === 'runner') {
    console.error('Usage: cofferdam runner <add|run|list|remove> ... (see cofferdam --help)');
    process.exit(1);
  }
  else if (cmd === 'user') {
    console.error('Usage: cofferdam user <add|grant|list> ... (see cofferdam --help)');
    process.exit(1);
  } else serveCmd(args);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

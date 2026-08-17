#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { createApp } from './server';
import { isValidName } from './scan';
import { bootstrapVault } from './vault';

function usage(code = 0): never {
  console.log(`Usage:
  repos serve [vault-dir] [-p|--port <n>] [--host <h>]
      Serve a vault (a directory of orgs containing bare git repositories).
      The vault defaults to $REPOS_VAULT, then the current directory. On the
      first start with no vault.json, the server initializes one and prints
      an owner token once.

  repos user add <username> [--scope <glob>]... [--admin <glob>]... [--token-scope <glob>]...
      Create a user and print its token once (only a SHA-256 hash is
      stored). A new user defaults to push scope "*"; --admin globs let the
      user manage other users within those globs. Run again without --scope
      on an existing user to mint an additional token.

  repos user grant <username> [--scope <glob>]... [--admin <glob>]...
      Extend an existing user's push scope and/or admin scope. Globs match
      org/repo: "myorg/*" is a whole organization, "myorg/myrepo" a single
      repository, "*" everything. Existing globs are kept.

  repos user list
      Show users, their scopes, and how many tokens each has.

  repos whoami
      Show the user, scopes, and token restriction for the current token.

User commands talk to a running repos server:
  REPOS_HOST    server URL, e.g. http://127.0.0.1:3000   (or --host <url>)
  REPOS_TOKEN   a token with admin scope                  (or --token <t>)

Vault layout:
  <vault>/<org>/<repo>.git    bare repositories (the .git suffix is optional)
  <vault>/<org>/<repo>.pages  optional static pages site for a repo
  <vault>/vault.json          users and hashed tokens (server-managed)
  <vault>/.secret             session-cookie signing key (server-managed)
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
  const vault = path.resolve(dir ?? process.env.REPOS_VAULT ?? '.');
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
      console.log(`  export REPOS_HOST=${url}`);
      console.log(`  export REPOS_TOKEN=${boot.token}`);
      console.log('');
    }
    console.log(`repos serving vault ${vault}`);
    console.log(`  ${url}`);
  });
}

interface RemoteTarget {
  host: string;
  token: string;
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
      console.error('--vault is gone: user commands talk to a running server. Set REPOS_HOST and REPOS_TOKEN.');
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

function remoteTarget(args: { host: string | null; token: string | null }): RemoteTarget {
  const host = (args.host ?? process.env.REPOS_HOST ?? '').replace(/\/+$/, '');
  const token = args.token ?? process.env.REPOS_TOKEN ?? '';
  if (!host) {
    console.error('No server configured. Set REPOS_HOST (e.g. http://127.0.0.1:3000) or pass --host <url>.');
    process.exit(1);
  }
  if (!token) {
    console.error('No token configured. Set REPOS_TOKEN or pass --token <token>.');
    process.exit(1);
  }
  return { host, token };
}

async function api(
  target: RemoteTarget,
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
    console.error(data && data.error ? `Error: ${data.error}` : `Error: HTTP ${resp.status} from ${target.host}${pathname}`);
    process.exit(1);
  }
  return data ?? {};
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
  const target = remoteTarget(a);
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
    console.error('Usage: repos user grant <username> --scope <glob> [--admin <glob>]...');
    process.exit(1);
  }
  if (a.scope.length === 0 && a.admin.length === 0) {
    console.error(`Nothing to grant. Example: repos user grant ${a.username} --scope 'myorg/*'`);
    process.exit(1);
  }
  const target = remoteTarget(a);
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
  const target = remoteTarget(a);
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
  const target = remoteTarget(a);
  const data = await api(target, 'GET', '/api/whoami');
  console.log(`${data.username} @ ${target.host}`);
  console.log(`  ${formatScopes(data as { scope: string[]; admin: string[] })}`);
  if (data.tokenScope) console.log(`  this token is restricted to: ${(data.tokenScope as string[]).join(', ')}`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === undefined || cmd === '-h' || cmd === '--help') usage();
  else if (cmd === 'serve') serveCmd(args.slice(1));
  else if (cmd === 'user' && args[1] === 'add') await userAddCmd(args.slice(2));
  else if (cmd === 'user' && args[1] === 'grant') await userGrantCmd(args.slice(2));
  else if (cmd === 'user' && args[1] === 'list') await userListCmd(args.slice(2));
  else if (cmd === 'whoami') await whoamiCmd(args.slice(1));
  else if (cmd === 'user') {
    console.error('Usage: repos user <add|grant|list> ... (see repos --help)');
    process.exit(1);
  } else serveCmd(args);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

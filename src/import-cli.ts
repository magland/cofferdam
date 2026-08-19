import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { api, apiFailed, apiTry, remoteTarget } from './cli-api';
import { isValidName } from './scan';
import { parseSource } from './source';

// `cofferdam import`: bring an existing repository into a vault. This runs on
// the operator's machine and not on the server, which is the same division the
// import page has always described: their own git credentials read
// the source, their cofferdam token writes the vault, and push-to-create makes
// the repository. What changes here is only who types the commands. A bare
// clone into a temporary directory, a mirror push at the vault, and the
// temporary directory is removed again.

interface ImportArgs {
  src: string | null;
  collection: string | null;
  name: string | null;
  host: string | null;
  token: string | null;
  lfs: boolean;
}

function parseImportArgs(args: string[], usage: () => never): ImportArgs {
  const out: ImportArgs = { src: null, collection: null, name: null, host: null, token: null, lfs: false };
  let positional = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') usage();
    else if (a === '--host') out.host = args[++i];
    else if (a === '--token') out.token = args[++i];
    else if (a === '--collection') out.collection = args[++i];
    else if (a === '--name') out.name = args[++i];
    else if (a === '--lfs') out.lfs = true;
    else if (a.startsWith('-')) {
      console.error(`Unknown option: ${a}`);
      process.exit(1);
    } else if (positional === 0) {
      out.src = a;
      positional++;
    } else if (positional === 1) {
      // The destination is written the way a repository is addressed
      // everywhere else in cofferdam: `collection` or `collection/repo`.
      const slash = a.indexOf('/');
      if (slash === -1) out.collection = a;
      else {
        out.collection = a.slice(0, slash);
        out.name = a.slice(slash + 1);
      }
      positional++;
    } else {
      console.error(`Unexpected argument: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

/** Run git with its output going straight to the terminal, so a long clone shows progress. */
function git(args: string[], env?: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: 'inherit', env: env ?? process.env });
    child.on('error', (e) =>
      reject(new Error((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'git is not on PATH' : String(e.message)))
    );
    child.on('close', (code) => resolve(code ?? 1));
  });
}

// The token is handed to the push through a helper that reads it from the
// environment rather than through the command line, where every process on the
// machine could read it. The empty helper first clears the list, so the answer
// comes from here and nowhere else, and no prompt can appear.
function pushEnv(username: string, token: string): NodeJS.ProcessEnv {
  return { ...process.env, COFFERDAM_USER: username, COFFERDAM_TOKEN: token, GIT_TERMINAL_PROMPT: '0' };
}

const CREDENTIAL_HELPER =
  `!f() { test "$1" = get && printf 'username=%s\\npassword=%s\\n' "$COFFERDAM_USER" "$COFFERDAM_TOKEN"; }; f`;

function pushArgs(dir: string): string[] {
  return ['-C', dir, '-c', 'credential.helper=', '-c', `credential.helper=${CREDENTIAL_HELPER}`];
}

export async function importCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseImportArgs(args, usage);
  if (!a.src) {
    console.error('Usage: cofferdam import <source> <collection>[/<name>]');
    console.error("  e.g. cofferdam import https://github.com/octocat/Hello-World mycollection");
    process.exit(1);
  }
  const source = parseSource(a.src);
  if (!source) {
    console.error(`Not a source we can clone: ${a.src}`);
    console.error('Give an https or ssh git URL, owner/repo for GitHub, or the path to a repository here.');
    process.exit(1);
  }
  const collection = a.collection ?? '';
  const name = a.name ?? source.name;
  if (!collection) {
    console.error(`Which collection should ${name} go into?`);
    console.error(`  cofferdam import ${a.src} mycollection`);
    process.exit(1);
  }
  if (!isValidName(collection) || !isValidName(name)) {
    console.error('Collection and repository names may use letters, digits, dot, underscore, and dash,');
    console.error('and must not be reserved words.');
    process.exit(1);
  }

  const target = await remoteTarget(a);

  // Who the push will be as, and whether the token still works: worth knowing
  // before a clone that may take minutes.
  const who = await api(target, 'GET', '/api/whoami');
  const username = String(who.username ?? '');
  if (!username) {
    console.error(`${target.host} did not say who this token belongs to.`);
    process.exit(1);
  }

  // A mirror push at an existing repository would replace its refs, so an
  // existing name stops the import here rather than after the clone.
  const listing = `/api/collections/${encodeURIComponent(collection)}`;
  const existing = await apiTry(target, 'GET', listing);
  if (existing.ok && ((existing.data.repos ?? []) as string[]).includes(name)) {
    console.error(`${collection}/${name} already exists on ${target.host}.`);
    console.error('A mirror push would replace its branches and tags, so this stops here. Import');
    console.error('under another name,');
    console.error(`  cofferdam import ${a.src} ${collection}/another-name`);
    console.error('or delete the existing repository first, from its settings page.');
    process.exit(1);
  }
  if (!existing.ok && existing.status !== 404) apiFailed(target, listing, existing);

  const dest = `${target.host}/${encodeURIComponent(collection)}/${encodeURIComponent(name)}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cofferdam-import-'));
  const cleanup = () => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // A leftover temporary directory is not worth failing the import over.
    }
  };
  try {
    // --bare rather than --mirror: mirroring a GitHub repository drags in
    // refs/pull/*, thousands of refs the vault has no use for. A bare clone
    // carries branches and tags, which is what the push then mirrors.
    console.log(`Cloning ${source.url}`);
    if ((await git(['clone', '--bare', '--', source.url, tmp])) !== 0) {
      throw new Error(`Could not clone ${source.url}.`);
    }
    if (a.lfs) {
      console.log('Fetching Git LFS objects');
      if ((await git(['-C', tmp, 'lfs', 'fetch', '--all'])) !== 0) {
        throw new Error('Could not fetch the LFS objects. Is git-lfs installed?');
      }
    }
    console.log(`Pushing to ${dest} as ${username}`);
    const env = pushEnv(username, target.token);
    if ((await git([...pushArgs(tmp), 'push', '--mirror', dest], env)) !== 0) {
      throw new Error(
        `Could not push to ${dest}.\nIf it refused the token, check that your push scope covers ${collection}/${name}.`
      );
    }
    if (a.lfs) {
      console.log('Pushing Git LFS objects');
      if ((await git([...pushArgs(tmp), 'lfs', 'push', '--all', dest], env)) !== 0) {
        throw new Error('The repository arrived, but its LFS objects did not.');
      }
    }
  } finally {
    // Reported through an exception rather than process.exit, since exiting
    // here would skip this and leave the bare clone behind.
    cleanup();
  }
  console.log('');
  console.log(`Imported ${collection}/${name}`);
  console.log(`  ${dest}`);
  // Worth saying rather than leaving to be discovered: a mirror push carries
  // LFS pointer files, so the files look present and read as missing.
  if (!a.lfs) console.log('  (Git LFS objects, if it has any, were not carried over; import again with --lfs)');
}

interface CollectionArgs {
  name: string | null;
  host: string | null;
  token: string | null;
}

function parseCollectionArgs(args: string[], usage: () => never): CollectionArgs {
  const out: CollectionArgs = { name: null, host: null, token: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') usage();
    else if (a === '--host') out.host = args[++i];
    else if (a === '--token') out.token = args[++i];
    else if (a.startsWith('-')) {
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

export async function collectionAddCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseCollectionArgs(args, usage);
  if (!a.name) {
    console.error('Usage: cofferdam collection add <name>');
    process.exit(1);
  }
  const target = await remoteTarget(a);
  const data = await api(target, 'POST', '/api/collections', { name: a.name });
  console.log(`Created collection '${data.name}' on ${target.host}`);
  console.log(`  ${target.host}/${encodeURIComponent(String(data.name))}`);
  console.log('');
  console.log('It has no repositories yet. Put one in it with');
  console.log(`  cofferdam import https://github.com/owner/repo ${data.name}`);
}

export async function collectionListCmd(args: string[], usage: () => never): Promise<void> {
  const a = parseCollectionArgs(args, usage);
  if (a.name) {
    console.error(`Unexpected argument: ${a.name}`);
    process.exit(1);
  }
  const target = await remoteTarget(a);
  const data = await api(target, 'GET', '/api/collections');
  const collections = (data.collections ?? []) as { name: string; repoCount: number }[];
  if (collections.length === 0) {
    console.log(`No collections on ${target.host}`);
    return;
  }
  const width = Math.max(...collections.map((c) => c.name.length));
  for (const c of collections) {
    console.log(`${c.name.padEnd(width)}  ${c.repoCount} ${c.repoCount === 1 ? 'repository' : 'repositories'}`);
  }
}

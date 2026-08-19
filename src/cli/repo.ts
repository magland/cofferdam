import { execFile } from 'child_process';
import { RemoteTarget } from '../cli-api';
import { CliError, EXIT_USAGE } from './exit';
import { Invocation, OptionSpec } from './parse';

// Which repository a command is about.
//
// This matters more than it looks, because a caller working inside a clone should
// not have to be told twice where it is: an agent that has just cloned a
// repository and is standing in it knows the answer, and so does git.

export const REPO_OPTION: OptionSpec = {
  name: 'repo',
  type: 'string',
  value: '<c/r>',
  summary: 'Repository as collection/repo; otherwise the git remote in this directory',
};

export interface RepoRef {
  collection: string;
  repo: string;
}

/** collection/repo, and nothing else: not a URL, not a bare name. */
function parseRef(given: string, where: string): RepoRef {
  const parts = given.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new CliError(`${where} should be <collection>/<repo>, not '${given}'`, EXIT_USAGE);
  }
  return { collection: parts[0], repo: parts[1].replace(/\.git$/, '') };
}

function git(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

/**
 * The repository named by the git remotes here that points at the vault we are
 * talking to, preferring origin. A remote for some other host is not an answer:
 * a clone of a GitHub repository standing in this directory must not be read as
 * naming a repository in this vault.
 */
async function fromGitRemotes(host: string): Promise<RepoRef | null> {
  let vaultHost: string;
  try {
    vaultHost = new URL(host).host.toLowerCase();
  } catch {
    return null;
  }
  const config = await git(['config', '--get-regexp', '^remote\\..*\\.url']);
  if (!config) return null;
  const candidates: { name: string; ref: RepoRef }[] = [];
  for (const line of config.split('\n')) {
    const space = line.indexOf(' ');
    if (space === -1) continue;
    const key = line.slice(0, space);
    const url = line.slice(space + 1).trim();
    const name = key.slice('remote.'.length, -'.url'.length);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.host.toLowerCase() !== vaultHost) continue;
    const segments = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (segments.length < 2) continue;
    const tail = segments.slice(-2);
    candidates.push({ name, ref: { collection: tail[0], repo: tail[1].replace(/\.git$/, '') } });
  }
  if (candidates.length === 0) return null;
  return (candidates.find((c) => c.name === 'origin') ?? candidates[0]).ref;
}

/**
 * Resolve the repository a command is about, in order: the argument or --repo,
 * then COFFERDAM_REPO, then the git remote here that points at this vault.
 * Failing all three, say so and name all three.
 */
export async function resolveRepo(
  inv: Invocation,
  target: RemoteTarget,
  positional: string | null = null
): Promise<RepoRef> {
  if (positional) return parseRef(positional, 'a repository');
  const flag = inv.str('repo');
  if (flag) return parseRef(flag, '--repo');
  const env = process.env.COFFERDAM_REPO?.trim();
  if (env) return parseRef(env, 'COFFERDAM_REPO');
  const remote = await fromGitRemotes(target.host);
  if (remote) return remote;
  throw new CliError(
    `Which repository? Name it as <collection>/<repo>, pass --repo <collection>/<repo>, set COFFERDAM_REPO,\n` +
      `or run this inside a clone whose remote points at ${target.host}.`,
    EXIT_USAGE
  );
}

/** The path prefix for a repository's API routes. */
export function repoPath(ref: RepoRef): string {
  return `/api/repos/${encodeURIComponent(ref.collection)}/${encodeURIComponent(ref.repo)}`;
}

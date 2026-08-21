import * as fs from 'fs';
import * as path from 'path';

// Where an import reads from. `mochi import` accepts an https git URL, an
// ssh git URL, `owner/repo` as shorthand for GitHub, or a directory on this
// machine, which is the case for a repository that only exists as a local clone.
//
// The accepted characters in a URL are an allowlist rather than a general URL
// parse. Nothing pastes a source into a shell any more (the import page writes
// its commands with placeholders), so this is defense in depth rather than the
// thing standing between a source and a shell, and it earns its place by
// rejecting a mistyped source with a clear message instead of handing it to git.
const HTTPS_SOURCE = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._/-]+$/;
const SSH_SOURCE = /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+$/;
const GITHUB_SHORTHAND = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ImportSource {
  /** What to hand `git clone`: a URL, or an absolute path for a local source. */
  url: string;
  /** The last segment, without a `.git` suffix: the repository's default name. */
  name: string;
  /** Set when the source is a GitHub repository, which has a description we can ask for. */
  github: { owner: string; repo: string } | null;
}

function nameOf(spec: string): string {
  const tail = spec.split(/[/:]/).pop() ?? '';
  return tail.replace(/\.git$/i, '');
}

function localSource(input: string): ImportSource | null {
  const dir = path.resolve(input.replace(/\/+$/, ''));
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  const name = nameOf(dir);
  return name === '' ? null : { url: dir, name, github: null };
}

// GitHub keeps a repository's one-line description outside the git data, so an
// import that carries it has to ask GitHub for it separately. Recognizing the
// source is the first half of that; asking is in the import command.
const GITHUB_REPO_URL = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?$/;

function githubOf(url: string): { owner: string; repo: string } | null {
  const m = GITHUB_REPO_URL.exec(url);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export function parseSource(input: string): ImportSource | null {
  // A path is recognized by being one: something that exists as a directory
  // here, or something written the way paths are written. Checked before the
  // GitHub shorthand, since `owner/repo` and a relative path have the same
  // shape and the directory in front of you is what you meant.
  if (/^[.~/]/.test(input) || input.includes(path.sep)) {
    const local = localSource(input);
    if (local) return local;
  }
  const url = GITHUB_SHORTHAND.test(input) ? `https://github.com/${input}.git` : input;
  if (!HTTPS_SOURCE.test(url) && !SSH_SOURCE.test(url)) return null;
  const name = nameOf(url);
  return name === '' ? null : { url, name, github: githubOf(url) };
}

// Where a fork came from. `mochi fork` records its source URL in the vault
// repository's config as `mochi.upstream`, and everything that later reads it
// back (the repo header, the API, `mochi sync`, `mochi pr export`) goes
// through this parse, so a stored value that stopped being a URL reads as no
// upstream rather than as a broken one.

export interface Upstream {
  /** What git fetch is handed: the https or ssh URL as stored. */
  url: string;
  /** host/path with the scheme and any .git suffix stripped, for display. */
  label: string;
  /** A browsable https URL, when one is known from the URL's shape. */
  web: string | null;
  /** Set when the upstream is a GitHub repository, which pull requests can be sent to. */
  github: { owner: string; repo: string } | null;
}

export function parseUpstream(input: string): Upstream | null {
  if (typeof input !== 'string' || input === '') return null;
  const github = githubOf(input);
  if (HTTPS_SOURCE.test(input)) {
    const label = input.replace(/^https:\/\//, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    return { url: input, label, web: `https://${label}`, github };
  }
  if (SSH_SOURCE.test(input)) {
    const label = input.replace(/^git@/, '').replace(':', '/').replace(/\.git$/i, '');
    return {
      url: input,
      label,
      web: github ? `https://github.com/${github.owner}/${github.repo}` : null,
      github,
    };
  }
  return null;
}

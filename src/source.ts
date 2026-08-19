import * as fs from 'fs';
import * as path from 'path';

// Where an import reads from. `cofferdam import` accepts an https git URL, an
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
  return name === '' ? null : { url: dir, name };
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
  return name === '' ? null : { url, name };
}

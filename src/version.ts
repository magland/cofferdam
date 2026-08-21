import * as fs from 'fs';
import * as path from 'path';

// What this vault is running, in the two forms something asks for it: the
// version of the package, and the build that version was compiled from.
//
// The version is read from the running package's own package.json. It is used
// where the server writes a command for somebody else's machine to run: the
// pasted `npx @magland/mochi@<version>` pins what that machine executes to
// what this vault was tested against, rather than to whatever npm serves the
// day the command is pasted.
//
// The build is a question package.json cannot answer. Two vaults reporting
// 0.3.0 can be different commits, since main carries the version of the last
// release until the next bump, and "is the fix I pushed the code that is
// running" is then unanswerable from the version alone. So the compile writes
// dist/build-info.json beside the code it emits (scripts/build-info.js, run by
// `npm run build`) and it is read back here. Running from source has no such
// file and says so rather than guessing.

let cached: string | null = null;

export function packageVersion(): string {
  if (cached !== null) return cached;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    cached = typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : 'latest';
  } catch {
    cached = 'latest';
  }
  return cached;
}

export interface BuildInfo {
  version: string;
  /** The commit it was compiled from, short form, or null if that was not known. */
  commit: string | null;
  /** When it was compiled, ISO 8601, or null when running from source. */
  builtAt: string | null;
}

let build: BuildInfo | null = null;

export function buildInfo(): BuildInfo {
  if (build !== null) return build;
  let commit: string | null = null;
  let builtAt: string | null = null;
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8')) as {
      commit?: unknown;
      builtAt?: unknown;
    };
    if (typeof stamp.commit === 'string' && stamp.commit !== '') commit = stamp.commit;
    if (typeof stamp.builtAt === 'string' && stamp.builtAt !== '') builtAt = stamp.builtAt;
  } catch {
    // No stamp: source under tsx, or a dist compiled by tsc on its own. Both
    // are honest as "unbuilt" and neither is worth inventing a date for.
  }
  build = { version: packageVersion(), commit, builtAt };
  return build;
}

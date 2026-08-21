import * as fs from 'fs';
import * as path from 'path';

// The version of the running package, read from its own package.json. Used
// where the server writes a command for somebody else's machine to run: the
// pasted `npx @magland/feorge@<version>` pins what that machine executes to
// what this vault was tested against, rather than to whatever npm serves the
// day the command is pasted.

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

import * as fs from 'fs';
import { CliError, EXIT_USAGE } from './exit';

// Reading input that is too long, too secret, or too awkward to be an argument.
// A token in argv is in the process table and in shell history; an issue body
// in argv is subject to whatever the shell does to it and to ARG_MAX. Both are
// read from a file or from stdin instead.

/** Everything on stdin, as text. */
export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
    process.stdin.resume();
  });
}

/** A file's contents, or stdin when the path is '-'. */
export async function readFileArg(file: string): Promise<string> {
  if (file === '-') return await readStdin();
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new CliError(`Could not read ${file}: ${e instanceof Error ? e.message : String(e)}`, EXIT_USAGE);
  }
}

import * as fs from 'fs';
import * as path from 'path';

/**
 * Replace a file's contents in one step, durably.
 *
 * A vault is a directory of plain files and nothing else, so the files that
 * hold its state are the state. Six places wrote one of them by the same
 * three lines, writing a sibling `.tmp` and renaming it over the target, which
 * is what stops a reader from seeing half a file: a rename within a directory
 * is atomic, so a concurrent read sees the old contents or the new ones.
 *
 * What those six lines did not do is reach the disk. A rename can be recorded
 * before the data the renamed file points at, so a machine that loses power at
 * the wrong moment can come back to a `vault.json` that exists, parses as
 * nothing, and locks every user out of a vault whose repositories are all
 * still there. That is the one failure here worth paying two fsyncs to avoid:
 * one on the contents before the rename, and one on the directory afterwards,
 * which is what makes the rename itself survive.
 *
 * The temporary name carries the process id, so two servers pointed at one
 * vault cannot write over each other's half-written file. It does not make the
 * larger read-modify-write safe, and nothing here pretends otherwise: two
 * processes editing `vault.json` at once still lose one of the edits.
 */
export function writeFileAtomic(file: string, data: string, opts: { mode?: number } = {}): void {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', opts.mode ?? 0o666);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  // The rename is what has to survive, and it lives in the directory rather
  // than in either file. Not every platform lets a directory be opened, and a
  // vault on one that does not is better served slightly less durably than not
  // at all, so this is attempted rather than required.
  let dir: number | null = null;
  try {
    dir = fs.openSync(path.dirname(file), 'r');
    fs.fsyncSync(dir);
  } catch {
    // no directory handle to sync on this platform
  } finally {
    if (dir !== null) fs.closeSync(dir);
  }
}

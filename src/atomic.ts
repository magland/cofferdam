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
 * vault cannot write over each other's half-written file. It does not by itself
 * make the larger read-modify-write safe; `withFileLock` below is what does
 * that, and a caller that reads a state file, changes it, and writes it back
 * belongs inside one.
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

// How long a lock may be held before another holder assumes its owner died.
// The critical sections here are a small read, an edit in memory, and a write,
// so anything approaching this is a crashed process rather than a slow one.
const LOCK_STALE_MS = 10 * 1000;
// How long to wait for a lock before giving up. Well beyond any honest holder,
// and beyond the staleness threshold, so a wait that ends in a throw means
// something is wrong rather than merely busy.
const LOCK_TIMEOUT_MS = 15 * 1000;
const LOCK_RETRY_MS = 20;

/** Sleep without yielding, which is what a synchronous critical section needs. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding an exclusive lock on `lockPath`, so that a read, an
 * edit, and a write back are one operation against other processes as well as
 * against other requests.
 *
 * The state files at a vault's root are read-modify-written by whoever has the
 * directory: the server answering `POST /api/users`, and `feorge user add`
 * run against the same path from a shell. Both were reading, editing in memory,
 * and writing the whole file back, so two of them overlapping lost one edit
 * entirely - a user created and then gone, or a token revoked and then back.
 * Node's single thread makes each of these safe within one process, since none
 * of them awaits; it says nothing about two.
 *
 * `open(O_CREAT|O_EXCL)` is the lock: it is one atomic step on every platform
 * this runs on, and it needs no dependency. A lock older than LOCK_STALE_MS is
 * taken to belong to a process that died holding it and is broken, because the
 * alternative is a vault that cannot be administered until someone finds a
 * stray file. The lock is advisory in the sense that matters: hand-editing
 * `vault.json` while the server runs still works, exactly as the documentation
 * promises, and is still the operator's own business to time.
 */
export function withFileLock<T>(lockPath: string, fn: () => T): T {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number | null = null;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        // It went away between the open and the stat; just retry.
        continue;
      }
      if (age > LOCK_STALE_MS) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for the lock at ${lockPath}; remove it if no feorge process is running`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    fd = null;
    return fn();
  } finally {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
  }
}

import * as fs from 'fs';

// A stat-checked cache of parsed state files, keyed by path.
//
// The vault's state files -- vault.json, config.json, redirects.json,
// runners.json, .secret -- are each read on the way in to requests, and each
// reader kept its own hand-rolled cache: one slot holding the last file seen,
// revalidated by mtime and size. One slot silently assumes the process serves
// one vault, which is true of the server but not a rule anything enforced,
// and five copies of the same dozen lines is five places for the next reader
// to check are actually the same.
//
// This is those dozen lines once, with a Map where the slot was. The map is
// keyed by the file's path, so a process that touches two vaults (a test, a
// CLI pointed somewhere unexpected) caches both instead of thrashing one
// slot; its size is bounded by the number of state files the process ever
// reads, which is a handful per vault.
//
// The revalidation itself is unchanged, and so is its known limit: a write
// that lands within the mtime granularity and keeps the size is invisible.
// That is why every read-modify-write in this codebase rereads the file
// under its lock rather than trusting a load, and a cache built here must be
// invalidated wherever that reread happens.

export interface FileCache<T> {
  /** The file's value, reread only when its stat has changed since last time. */
  get(file: string): T;
  /** Forget one file, so the next get rereads it whatever its stat says. */
  invalidate(file: string): void;
}

/**
 * `read` parses the file and is only called when the stat is fresh; what it
 * returns is cached, so it should catch its own parse errors and return the
 * value the caller should see, or the error state it wants remembered.
 * `missing` answers for a file that does not exist, and is not cached: a file
 * that appears later is noticed on the next get.
 */
export function fileCache<T>(opts: { read: (file: string) => T; missing: (file: string) => T }): FileCache<T> {
  const slots = new Map<string, { mtimeMs: number; size: number; value: T }>();
  return {
    get(file) {
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        slots.delete(file);
        return opts.missing(file);
      }
      const hit = slots.get(file);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
      const value = opts.read(file);
      slots.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
      return value;
    },
    invalidate(file) {
      slots.delete(file);
    },
  };
}

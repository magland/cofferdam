import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { withFileLock, writeFileAtomic } from './atomic';
import { loadConfig } from './config';
import { isValidName } from './scan';
import { isUnderSitesHost, parseSiteHost } from './siteshost';

// Outgoing bytes, counted and capped.
//
// A host that bills for egress and does not cap it -- Fly is the one this was
// written for -- turns a popular repository, a crawler, or a badly written CI
// loop into a bill nobody chose. Nothing else in cofferdam bounds it: the rate
// limiter in src/limit.ts counts requests, and a request for a 2 GB release
// asset costs the same one request as a request for the front page.
//
// So this counts bytes instead, keeps a running total per day, and refuses to
// send more once the day's budget is spent. Two deliberate asymmetries with the
// rate limiter, which keeps nothing on disk:
//
//   - The counts are persisted, because a budget that a restart forgives is not
//     a budget. A crash loop would otherwise send 20 GB per restart.
//   - The cap is read per request rather than once at startup, unlike every
//     other setting in the limits block. The moment an operator wants to change
//     it is the moment the vault has stopped answering, and telling them to
//     restart it then is telling them to reach the volume by hand.
//
// Two limitations, both worth stating plainly rather than engineering around.
//
// LFS objects served from a configured S3 bucket leave through presigned URLs
// that never touch this process, so those bytes are invisible here and the admin
// page says so. The cap is not defeated by that, only measured around it: the
// batch endpoint that mints those URLs is an ordinary route, so it is refused
// with everything else once the budget is spent, and what still works afterwards
// is the URLs signed in the previous hour. The bytes are uncounted; the
// permission is not.
//
// And the numbers are bytes written to sockets by this process, which is close to
// what a host meters but not identical: it excludes the TCP/TLS framing a proxy
// adds, and includes bytes queued for a client that hung up before reading them.

export const EGRESS_FILE = 'egress.json';

/** Days of history kept in the file, today included. */
const HISTORY_DAYS = 30;

/**
 * The most repositories one day may be broken down by. The key space is derived
 * from request paths, so it is influenced by whoever is making the requests:
 * `GET /a1/b1`, `/a2/b2`, ... would otherwise grow the map and the file without
 * bound. Beyond the ceiling, bytes are still counted, under one overflow row.
 */
const MAX_KEYS = 2000;

/** The row bytes land in once the ceiling is reached. */
const OVERFLOW_KEY = '(other)';

/** The row for everything that belongs to no repository: the front page, the admin pages, assets, the API. */
const VAULT_KEY = '(vault)';

/** How a site's row is spelled, so the parser and the page agree on one thing. */
const SITE_SUFFIX = ':site';

/**
 * How often the file may be written while counting is happening. Every request
 * touches the in-memory total; a write per request would put a synchronous fsync
 * on the hot path for a number nobody reads more than once a minute. Half a
 * minute of counting is what a hard kill costs.
 */
const FLUSH_MS = 30000;

const GB = 1024 * 1024 * 1024;

/**
 * How much the exempt paths -- /admin, /login, the stylesheet they need -- may
 * send after the budget is spent. Without an allowance they are unreachable, and
 * an operator locked out of the page that would raise the cap is worse off than
 * one whose vault sent a few megabytes too many. Without a bound on the
 * allowance, a crawler on /assets/style.css would send those bytes forever.
 */
const EXEMPT_GRACE = 64 * 1024 * 1024;

interface DayRecord {
  /** The UTC date, YYYY-MM-DD. */
  day: string;
  /** Bytes out that day, which is always the sum of `keys`. */
  total: number;
  keys: Record<string, number>;
}

export interface EgressRow {
  /** `collection/repo`, or one of the two bracketed pseudo-rows. */
  repo: string;
  /** Whether these are the bytes of that repository's site rather than of the repository itself. */
  site: boolean;
  bytes: number;
}

export interface EgressSnapshot {
  /** Today, in UTC, which is the window the cap applies to. */
  day: string;
  /** Bytes out today, per row, largest first. */
  rows: EgressRow[];
  /** Bytes out today. */
  total: number;
  /** The cap in bytes, or 0 when it is disabled. */
  capBytes: number;
  capGb: number;
  /** Whether ordinary traffic is being refused right now. */
  overBudget: boolean;
  /** Seconds until the counters reset, which is the next UTC midnight. */
  resetsIn: number;
  /** Earlier days, most recent first. Today is not among them. */
  history: { day: string; total: number }[];
}

/** What a refusal needs to say. */
export interface EgressDecision {
  retryAfter: number;
  /** The cap that was reached, for the message. */
  capBytes: number;
}

export interface Egress {
  /** Count what one response writes. Call before anything can write to it. */
  watch(req: Request, res: Response): void;
  /** Null when the request may be answered, or the refusal it gets. */
  allow(req: Request): EgressDecision | null;
  /** Today's totals and the recent history, for the admin page. */
  snapshot(): EgressSnapshot;
  /** Write the counts out now. Safe to call at any time; a no-op when nothing is pending. */
  flush(): void;
}

/** How long until the window resets, as a person would say it. */
function untilReset(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${Math.max(1, m)}m`;
}

/**
 * What a refused visitor is told. One sentence, and it names the setting and
 * when the vault comes back: someone reading this wants to know whether to wait
 * or to go and raise a number.
 */
export function egressMessage(decision: EgressDecision): string {
  const cap = decision.capBytes / GB;
  const gb = cap >= 10 ? cap.toFixed(0) : cap.toFixed(1);
  return (
    `This vault has sent its daily limit of ${gb} GB and is not sending more. ` +
    `The limit resets at 00:00 UTC, in ${untilReset(decision.retryAfter)}.`
  );
}

export function egressFilePath(root: string): string {
  return path.join(root, EGRESS_FILE);
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The next UTC midnight after `ms`, which is when the window rolls over. */
function nextRollover(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function sum(keys: Record<string, number>): number {
  let total = 0;
  for (const v of Object.values(keys)) if (Number.isFinite(v) && v > 0) total += v;
  return total;
}

/**
 * Read the file, keeping only what is well formed. A file that has been
 * hand-edited into nonsense loses its history rather than the day's cap: the
 * counts are an accounting record, and the thing that must not happen is a
 * parse error taking the vault down.
 */
function readDays(file: string): DayRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const days = (parsed as { days?: unknown } | null)?.days;
  if (!Array.isArray(days)) return [];
  const out: DayRecord[] = [];
  for (const entry of days) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.day)) continue;
    const keys: Record<string, number> = {};
    if (typeof e.keys === 'object' && e.keys !== null) {
      for (const [k, v] of Object.entries(e.keys as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) keys[k] = Math.floor(v);
      }
    }
    out.push({ day: e.day, total: sum(keys), keys });
  }
  out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  return out.slice(0, HISTORY_DAYS);
}

/**
 * Paths that keep working after the budget is spent, within EXEMPT_GRACE.
 *
 * /admin and /login because that is the path to raising the cap; the API's
 * config and egress routes because they are the same two operations for a
 * program, and reading the number is what an operator does before changing it;
 * the stylesheet and the icon because the admin page is unreadable without them.
 *
 * None of it applies on a sites hostname, where these paths belong to the site
 * being served and are ordinary traffic, exactly as isRateExempt has it.
 */
function isEgressExempt(root: string, req: Request): boolean {
  if (isUnderSitesHost(loadConfig(root).sites.host, req.hostname)) return false;
  const p = req.path;
  if (p === '/login' || p === '/logout' || p === '/api/config' || p === '/api/egress') return true;
  if (p === '/admin' || p.startsWith('/admin/')) return true;
  return p.startsWith('/assets/') || p === '/favicon.svg' || p === '/favicon.ico';
}

/**
 * Which row a request's bytes belong to.
 *
 * A site on its own hostname is recognised from the hostname; on the forge host
 * every repository surface lives under /:collection/:repo, so one regex covers
 * browsing, the git wire protocol, LFS, releases, issues, and CI alike, and
 * /:collection/:repo/site is the site. isValidName is what keeps /api/... and
 * /admin/... out of the repository rows: it refuses the reserved names.
 *
 * Nothing here touches the filesystem. Attribution is not authorization, and
 * paying a stat per response to learn that a 404 named no real repository would
 * be paying it on every response.
 */
function keyFor(root: string, req: Request): string {
  const site = parseSiteHost(loadConfig(root).sites.host, req.hostname);
  if (site) return `${site.collection}/${site.repo}${SITE_SUFFIX}`;
  const m = /^\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(req.path);
  if (!m) return VAULT_KEY;
  let collection: string;
  let repo: string;
  try {
    collection = decodeURIComponent(m[1]);
    repo = decodeURIComponent(m[2]);
  } catch {
    return VAULT_KEY;
  }
  if (!isValidName(collection) || !isValidName(repo)) return VAULT_KEY;
  const rest = m[3] ?? '';
  const isSite = rest === 'site' || rest.startsWith('site/');
  return `${collection}/${repo}${isSite ? SITE_SUFFIX : ''}`;
}

function splitKey(key: string): EgressRow {
  return key.endsWith(SITE_SUFFIX)
    ? { repo: key.slice(0, -SITE_SUFFIX.length), site: true, bytes: 0 }
    : { repo: key, site: false, bytes: 0 };
}

/**
 * The counter one server holds.
 *
 * `capGb` is a thunk rather than a number, so the caller decides where the
 * setting comes from and a change to it is in force on the next request.
 *
 * The day's total is kept in two halves: `base`, as last seen on disk, and
 * `pending`, counted here since then. Every flush adds the pending half to
 * whatever the file says and adopts the result as the new base, so two servers
 * pointed at one vault add up instead of overwriting each other, and so does a
 * server sharing a vault with a hand-edited file. Neither sees the other's bytes
 * until a flush, which means each may send up to FLUSH_MS worth past the cap.
 */
export function createEgress(root: string, capGb: () => number): Egress {
  const file = egressFilePath(root);
  const lock = `${file}.lock`;

  let day = utcDay(Date.now());
  let rollAt = nextRollover(Date.now());
  let base = new Map<string, number>();
  let baseTotal = 0;
  let pending = new Map<string, number>();
  let pendingTotal = 0;
  let past: DayRecord[] = [];
  let timer: NodeJS.Timeout | null = null;
  let warnedAt = 0;

  // Load once at startup. A vault whose file says 19 GB have gone out today
  // comes back still knowing that, which is the whole reason the file exists.
  {
    const days = readDays(file);
    const today = days.find((d) => d.day === day);
    if (today) {
      base = new Map(Object.entries(today.keys));
      baseTotal = today.total;
    }
    past = days.filter((d) => d.day !== day);
  }

  const capBytes = (): number => {
    const gb = capGb();
    return Number.isFinite(gb) && gb > 0 ? Math.floor(gb * GB) : 0;
  };

  const used = (): number => baseTotal + pendingTotal;

  function writeOut(): void {
    if (pending.size === 0) return;
    // Taken out of the way first, so that bytes counted while the file is being
    // written are not lost to the reset below.
    const mine = pending;
    const myDay = day;
    pending = new Map();
    pendingTotal = 0;
    try {
      withFileLock(lock, () => {
        const days = readDays(file);
        let rec = days.find((d) => d.day === myDay);
        if (!rec) {
          rec = { day: myDay, total: 0, keys: {} };
          days.push(rec);
        }
        for (const [k, v] of mine) rec.keys[k] = (rec.keys[k] ?? 0) + v;
        rec.total = sum(rec.keys);
        days.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
        const kept = days.slice(0, HISTORY_DAYS);
        writeFileAtomic(file, JSON.stringify({ version: 1, days: kept }, null, 2) + '\n');
        if (myDay === day) {
          base = new Map(Object.entries(rec.keys));
          baseTotal = rec.total;
        }
        past = kept.filter((d) => d.day !== day);
      });
    } catch (e) {
      // Put the counts back rather than dropping them: a full disk or a lock
      // held by a dead process is a reason to try again in half a minute, not a
      // reason to forgive the traffic. Reported at most once per flush interval,
      // so a persistent failure does not fill the log.
      for (const [k, v] of mine) pending.set(k, (pending.get(k) ?? 0) + v);
      for (const v of mine.values()) pendingTotal += v;
      const now = Date.now();
      if (now - warnedAt > FLUSH_MS) {
        warnedAt = now;
        console.warn(`could not write ${EGRESS_FILE}: ${e instanceof Error ? e.message : String(e)}`);
      }
      schedule();
    }
  }

  function schedule(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      writeOut();
    }, FLUSH_MS);
    // A pending flush is not a reason to keep the process alive; the exit
    // handler below is what makes sure the counts are written on the way out.
    timer.unref?.();
  }

  /** Roll the window if the day has turned. Called from the two paths that read the total. */
  function rollIfNeeded(): void {
    const now = Date.now();
    if (now < rollAt) return;
    // The pending half belongs to the day it was counted in, so it is written
    // under the old date before anything is reset.
    writeOut();
    if (baseTotal > 0) {
      past = [{ day, total: baseTotal, keys: Object.fromEntries(base) }, ...past].slice(0, HISTORY_DAYS);
    }
    day = utcDay(now);
    rollAt = nextRollover(now);
    base = new Map();
    baseTotal = 0;
  }

  function add(key: string, bytes: number): void {
    rollIfNeeded();
    let k = key;
    if (!base.has(k) && !pending.has(k) && base.size + pending.size >= MAX_KEYS) k = OVERFLOW_KEY;
    pending.set(k, (pending.get(k) ?? 0) + bytes);
    pendingTotal += bytes;
    schedule();
  }

  // Written on the way out, so an ordinary restart or a Fly deploy loses
  // nothing. `exit` covers a clean end; the two signals do not reach it on
  // their own, because a handler for either replaces the default of
  // terminating, so each ends the process itself once the counts are down.
  process.on('exit', () => writeOut());
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      writeOut();
      process.exit(0);
    });
  }

  return {
    watch(req, res) {
      // The socket is captured now rather than read at the end: a response that
      // ends because the client hung up has no res.socket left, and the object
      // still remembers what was written to it. bytesWritten is cumulative over
      // a keep-alive connection, so the delta over one response is this
      // response's share -- HTTP/1.1 answers one request at a time per
      // connection, which is what makes the delta attributable at all.
      const sock = res.socket;
      if (!sock) return;
      const start = sock.bytesWritten;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const bytes = sock.bytesWritten - start;
        // Headers alone are never zero, so a zero here means the response never
        // reached the socket. Negative cannot happen, and is guarded because a
        // negative would silently buy back budget.
        if (bytes > 0) add(keyFor(root, req), bytes);
      };
      // Both, because only one of them fires: 'finish' when the response was
      // written, 'close' when it was abandoned. An aborted clone is ordinary
      // traffic and its bytes were still sent.
      res.on('finish', finish);
      res.on('close', finish);
    },

    allow(req) {
      const cap = capBytes();
      if (cap <= 0) return null;
      rollIfNeeded();
      const total = used();
      if (total < cap) return null;
      if (total < cap + EXEMPT_GRACE && isEgressExempt(root, req)) return null;
      return { retryAfter: Math.max(1, Math.ceil((rollAt - Date.now()) / 1000)), capBytes: cap };
    },

    snapshot() {
      rollIfNeeded();
      const merged = new Map(base);
      for (const [k, v] of pending) merged.set(k, (merged.get(k) ?? 0) + v);
      const rows = [...merged.entries()]
        .map(([k, bytes]) => ({ ...splitKey(k), bytes }))
        .filter((r) => r.bytes > 0)
        .sort((a, b) => b.bytes - a.bytes);
      const cap = capBytes();
      const total = used();
      return {
        day,
        rows,
        total,
        capBytes: cap,
        capGb: capGb(),
        overBudget: cap > 0 && total >= cap,
        resetsIn: Math.max(0, Math.ceil((rollAt - Date.now()) / 1000)),
        history: past.map((d) => ({ day: d.day, total: d.total })),
      };
    },

    flush: writeOut,
  };
}

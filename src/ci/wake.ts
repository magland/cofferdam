import * as crypto from 'crypto';
import { CiEngine } from './engine';
import { RunnerRecord, loadRunners, runnerAllows, runnerLastSeen } from './runners';

// Starting a runner that is not there.
//
// A runner reaches the vault and never the other way round, which is what lets
// one sit behind NAT with nothing open. The cost of that arrangement is that a
// runner which has stopped to save money cannot be told there is work: it has
// to be started by whatever is in front of it. A runner may therefore carry a
// wake address, and this pokes it when there is a job it could take and no
// sign of it.
//
// The request means nothing by itself. Nothing is sent but the shared secret,
// nothing is expected back, and the runner learns what to do the ordinary way,
// by polling. All that matters is that the thing in front of the runner - a
// Fly proxy, a systemd socket, anything - treats an arriving request as the
// signal to start it.

/** How recently a runner must have spoken to the vault to count as present. */
const PRESENT_MS = 60 * 1000;

/** The least time between two wake requests to the same runner. */
const RETRY_MS = 60 * 1000;

/**
 * How long to give one wake request.
 *
 * Generous, because the platform in front of a stopped runner usually holds
 * the request open while it starts the machine rather than answering and
 * starting one behind it: a cold Fly machine with a Docker daemon to bring up
 * took half a minute to answer in testing. The answer is discarded either way;
 * this is only how long the attempt is allowed to occupy.
 */
const REQUEST_TIMEOUT_MS = 120 * 1000;

/** How often to look for work waiting on a runner that is not there. */
const SWEEP_MS = 20 * 1000;

export interface WakeDispatcher {
  /** Look now rather than at the next sweep. */
  sweep(): void;
  stop(): void;
}

interface Attempt {
  at: number;
  inFlight: boolean;
  /** The last failure reported, so that the same one is not logged every minute. */
  lastError: string | null;
}

/**
 * Send one wake request, and say what happened.
 *
 * Exported because both the timer below and `feorge runner wake` want the
 * same request with the same headers; a wake tested by hand that differed
 * from the one the vault sends would test the wrong thing.
 */
export async function sendWake(wake: { url: string; secret: string }, timeoutMs = REQUEST_TIMEOUT_MS): Promise<void> {
  const res = await fetch(wake.url, {
    method: 'POST',
    headers: { 'x-feorge-wake': wake.secret, 'content-length': '0' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  // A runner that answers 401 is running somebody else's secret, and one that
  // answers 404 is not the endpoint anybody meant. Both are worth a message,
  // since the visible symptom otherwise is a run that never starts.
  if (!res.ok && res.status !== 204) {
    throw new Error(`the wake endpoint answered HTTP ${res.status}`);
  }
}

/**
 * The secret a wake request must present.
 *
 * Not a token in the vault's sense: it authenticates the vault to a runner
 * rather than a caller to the vault, both sides keep it in the clear because
 * both sides have to send it, and all it buys is the right to start a machine
 * that will then ask for work in the ordinary way. It exists because starting
 * a machine costs its owner money, and an address anyone could poke would be a
 * way to spend it.
 */
export function newWakeSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function wakeOf(runner: RunnerRecord): { url: string; secret: string } | null {
  if (!runner.wakeUrl || !runner.wakeSecret) return null;
  return { url: runner.wakeUrl, secret: runner.wakeSecret };
}

/**
 * Watch for queued jobs whose runner is not present, and start it.
 *
 * The unit throttled here is the runner, not the job. A run of twelve jobs
 * that all wait on the same stopped runner is one machine to start, and
 * twelve requests would be eleven wasted and a good way to look like an
 * attack to whatever is in front of it.
 */
export function startWakeDispatcher(root: string, engine: CiEngine): WakeDispatcher {
  const attempts = new Map<string, Attempt>();
  let stopped = false;

  const wakeRunner = (name: string, wake: { url: string; secret: string }, attempt: Attempt): void => {
    attempt.at = Date.now();
    attempt.inFlight = true;
    void sendWake(wake)
      .then(() => {
        if (attempt.lastError) console.log(`CI: runner ${name} answered a wake request`);
        attempt.lastError = null;
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        // Once per distinct failure. A runner whose wake address is wrong
        // stays wrong, and a line a minute about it for as long as a job is
        // queued would bury everything else in the log.
        if (attempt.lastError !== message) {
          console.error(`CI: could not wake runner ${name} at ${wake.url}: ${message}`);
          attempt.lastError = message;
        }
      })
      .finally(() => {
        attempt.inFlight = false;
        // The request is answered only once the runner is up, so this is the
        // moment its first poll is imminent: the throttle should count from
        // here rather than from when the attempt began.
        attempt.at = Date.now();
      });
  };

  const sweep = (): void => {
    if (stopped) return;
    const load = engine.runnerLoad();
    if (load.queued.length === 0) return;
    const registry = loadRunners(root);
    const now = Date.now();
    for (const [name, runner] of Object.entries(registry.runners)) {
      const wake = wakeOf(runner);
      if (!wake) continue;
      // Present, by either measure: holding a job, or having polled within
      // the last minute. Waking a runner that is already there costs nothing
      // but is a request nobody needed.
      if (load.running[name]) continue;
      const seen = runnerLastSeen(name);
      if (seen && now - Date.parse(seen) < PRESENT_MS) continue;
      // A manual job is waiting for a person, not a machine; starting a
      // runner for one would cost its owner a boot for a job it may not take.
      const waiting = load.queued.some(
        (j) => !j.manual && runnerAllows(runner, j.collection, j.repo) && j.runsOn.some((l) => runner.labels.includes(l))
      );
      if (!waiting) continue;
      const attempt = attempts.get(name) ?? { at: 0, inFlight: false, lastError: null };
      attempts.set(name, attempt);
      if (attempt.inFlight || now - attempt.at < RETRY_MS) continue;
      wakeRunner(name, wake, attempt);
    }
  };

  // Both a timer and the engine's own signal: the signal makes the usual case
  // immediate, since a push that queues a job should not wait out a sweep,
  // and the timer is what keeps trying for a job that is still sitting there.
  const timer = setInterval(sweep, SWEEP_MS);
  timer.unref();
  const unsubscribe = engine.onQueueChanged(sweep);

  return {
    sweep,
    stop() {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
    },
  };
}

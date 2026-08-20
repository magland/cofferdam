import express, { Express, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { AuthLimiter } from '../limit';
import { isValidName } from '../scan';
import { siteHostUrl } from '../site';
import { canAdminRunnerGlobs, isSiteAdmin } from '../perms';
import { AuthResult, authenticateToken, loadVault } from '../vault';
import { baseUrlOf } from '../web';
import { ArtifactError, artifactPath, artifactsDir, deploySite, isValidArtifactName, listArtifacts } from './artifacts';
import { CiEngine } from './engine';
import { LogLine } from './protocol';
import { Conclusion, StepState } from './runs';
import {
  RunnerAuth,
  authenticateRunner,
  loadRunners,
  noteRunnerSeen,
  regenerateRunnerToken,
  registerRunner,
  removeRunner,
  runnerLastSeen,
  setRunnerWake,
} from './runners';
import { sendWake, wakeOf } from './wake';

// The runner-facing API and the admin API for runner registration.
//
// Runner endpoints are authenticated by a runner token (Bearer), never by a
// session cookie and never by a user token. Registration endpoints are the
// mirror image: a user token with standing over the runner, never a runner token. The two
// credential kinds do not overlap at any endpoint.

const ACQUIRE_TIMEOUT_MS = 25 * 1000;
const MAX_LOG_BODY = 4 * 1024 * 1024;

export function registerCiApi(app: Express, root: string, engine: CiEngine, authLimiter: AuthLimiter): void {
  const json = express.json({ limit: '1mb' });

  function apiError(res: Response, status: number, message: string) {
    res.status(status).json({ error: message });
  }

  /**
   * Where a repository's site is served, which only the vault knows: with a
   * sites hostname configured each site has an origin of its own and sits at
   * its root, and without one it is a path under the forge host. A runner
   * computing this from the server URL gets the second answer always, and a
   * build told the wrong base path produces a site whose every asset URL is
   * wrong, so the answer travels with the job rather than being guessed.
   */
  function siteOf(req: Request, collection: string, repo: string): { url: string; basePath: string } {
    const own = siteHostUrl(root, req, collection, repo);
    if (own) return { url: `${own}/`, basePath: '/' };
    const p = `/${encodeURIComponent(collection)}/${encodeURIComponent(repo)}/site`;
    return { url: `${baseUrlOf(req)}${p}/`, basePath: p };
  }

  // A missing header is not a failed attempt and is not charged; a wrong token
  // is. Nothing here throttles a working credential, which matters because the
  // runner calls these endpoints continuously with a valid one.
  function denyTooMany(res: Response, retryAfter: number) {
    res.setHeader('Retry-After', String(retryAfter));
    apiError(res, 429, 'too many failed authentication attempts; try again later');
  }

  function requireAdmin(req: Request, res: Response): AuthResult | null {
    const state = loadVault(root);
    if (state.status !== 'ok') {
      apiError(res, 500, 'vault unavailable');
      return null;
    }
    const m = (req.get('authorization') ?? '').match(/^bearer\s+(.+)$/i);
    if (!m) {
      apiError(res, 401, 'missing bearer token: send Authorization: Bearer <token>');
      return null;
    }
    const allowed = authLimiter.allow(req, null);
    if (!allowed.ok) {
      denyTooMany(res, allowed.retryAfter);
      return null;
    }
    const auth = authenticateToken(state.vault, m[1].trim());
    if (!auth) {
      authLimiter.fail(req, null);
      apiError(res, 401, 'invalid token');
      return null;
    }
    return auth;
  }

  function requireRunner(req: Request, res: Response): RunnerAuth | null {
    const m = (req.get('authorization') ?? '').match(/^bearer\s+(.+)$/i);
    if (!m) {
      apiError(res, 401, 'missing runner token');
      return null;
    }
    const allowed = authLimiter.allow(req, null);
    if (!allowed.ok) {
      denyTooMany(res, allowed.retryAfter);
      return null;
    }
    const auth = authenticateRunner(root, m[1].trim());
    if (!auth) {
      authLimiter.fail(req, null);
      apiError(res, 401, 'invalid runner token');
      return null;
    }
    // Every runner endpoint passes through here, so this is the one place that
    // sees a runner alive, whether it is polling for work or reporting on a
    // job it already has.
    noteRunnerSeen(auth.name);
    return auth;
  }

  // ---- runner registration (admin) ----

  app.get('/api/runners', json, (req, res) => {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    // A site admin sees every runner; anyone else sees the runners they could
    // administer, which are the ones confined to collections they own.
    const registry = loadRunners(root);
    const visible = Object.entries(registry.runners).filter(
      ([, r]) => isSiteAdmin(auth) || canAdminRunnerGlobs(root, auth, r.allow)
    );
    const load = engine.runnerLoad();
    res.json({
      runners: visible.map(([name, r]) => ({
        name,
        labels: r.labels,
        allow: r.allow,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        // Registration says what a runner may do; these two say whether it is
        // there at all and what it is doing, which is what a caller looking at
        // a run that has not started actually wants to know.
        lastSeen: runnerLastSeen(name),
        running: load.running[name] ?? null,
        // The address, never the secret: a caller deciding whether a runner
        // can be started needs to know that it can be, not what to send.
        wakeUrl: r.wakeUrl ?? null,
      })),
      queued: load.queued,
    });
  });

  /**
   * The wake address in a request body, or a message saying what is wrong.
   *
   * Both halves or neither: an address with no secret is one the vault cannot
   * authenticate itself to, and a secret with no address is nowhere to send
   * it. The URL is checked for being a URL and for being HTTP, which is as
   * far as this can go: where it points is the administrator's business, and
   * they are already trusted with a runner that executes repository code.
   */
  function wakeFrom(body: Record<string, unknown>): { wake: { url: string; secret: string } | null } | { error: string } {
    const url = body.wakeUrl;
    const secret = body.wakeSecret;
    if (url === undefined && secret === undefined) return { wake: null };
    if (typeof url !== 'string' || typeof secret !== 'string' || !url || !secret) {
      return { error: '"wakeUrl" and "wakeSecret" must be given together, as non-empty strings' };
    }
    if (secret.length > 500) return { error: '"wakeSecret" is too long' };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { error: `"wakeUrl" is not a URL: ${url}` };
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { error: '"wakeUrl" must be an http or https URL' };
    }
    return { wake: { url, secret } };
  }

  app.post('/api/runners', json, (req, res) => {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name : '';
    if (!isValidName(name)) {
      apiError(res, 400, 'a valid "name" is required');
      return;
    }
    const strings = (v: unknown): string[] | null => {
      if (v === undefined) return [];
      if (Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0 && s.length < 200)) {
        return v as string[];
      }
      return null;
    };
    const labels = strings(body.labels);
    const allow = strings(body.allow);
    if (!labels || !allow) {
      apiError(res, 400, '"labels" and "allow" must be lists of strings');
      return;
    }
    if (allow.length === 0) {
      apiError(res, 400, 'a runner needs at least one --allow glob saying which repositories it serves');
      return;
    }
    // A runner may take jobs for every repository its allow list covers, and
    // those jobs execute repository-controlled code on the runner's machine.
    // Registering one therefore demands ownership of every collection in that set.
    if (!canAdminRunnerGlobs(root, auth, allow)) {
      apiError(res, 403, 'you must own every collection this runner serves; a site admin may manage any runner');
      return;
    }
    if (loadRunners(root).runners[name]) {
      apiError(res, 409, `a runner named ${name} is already registered; remove it first`);
      return;
    }
    const wake = wakeFrom(body);
    if ('error' in wake) {
      apiError(res, 400, wake.error);
      return;
    }
    const { token, runner } = registerRunner(root, name, {
      labels: labels.length ? labels : ['ubuntu-latest'],
      allow,
      createdBy: auth.username,
      wake: wake.wake,
    });
    res.json({ name, token, labels: runner.labels, allow: runner.allow, wakeUrl: runner.wakeUrl ?? null });
  });

  /**
   * Issue a new token for a runner, invalidating the one it had.
   *
   * The web interface has had this since runners did, and the API not having
   * it meant that the one way to give a runner a token nobody holds any more
   * was a browser. `cofferdam deploy fly runner` needs exactly that: a runner
   * registered by an earlier deploy has a token that only the machine knows,
   * and a machine being rebuilt has to be given one it can hold.
   */
  app.post('/api/runners/:name/token', json, (req, res) => {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    const name = req.params.name;
    const existing = loadRunners(root).runners[name];
    if (!existing) {
      apiError(res, 404, `no runner named ${name}`);
      return;
    }
    if (!canAdminRunnerGlobs(root, auth, existing.allow)) {
      apiError(res, 403, 'you must own every collection this runner serves; a site admin may manage any runner');
      return;
    }
    const issued = regenerateRunnerToken(root, name);
    if (!issued) {
      apiError(res, 404, `no runner named ${name}`);
      return;
    }
    res.json({ name, token: issued.token, labels: issued.runner.labels, allow: issued.runner.allow });
  });

  /**
   * Point a runner's wake address somewhere, or clear it with an empty body.
   *
   * Separate from registration because the app that will run a runner usually
   * does not exist until after the runner is registered: `cofferdam deploy fly
   * runner` needs the token to put in the machine's secrets before it can know
   * the URL that starts the machine.
   */
  app.put('/api/runners/:name/wake', json, (req, res) => {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    const name = req.params.name;
    const existing = loadRunners(root).runners[name];
    if (!existing) {
      apiError(res, 404, `no runner named ${name}`);
      return;
    }
    if (!canAdminRunnerGlobs(root, auth, existing.allow)) {
      apiError(res, 403, 'you must own every collection this runner serves; a site admin may manage any runner');
      return;
    }
    const wake = wakeFrom((req.body ?? {}) as Record<string, unknown>);
    if ('error' in wake) {
      apiError(res, 400, wake.error);
      return;
    }
    const runner = setRunnerWake(root, name, wake.wake);
    res.json({ name, wakeUrl: runner?.wakeUrl ?? null });
  });

  /**
   * Send this runner's wake request now, and report what came back.
   *
   * The vault sends it rather than the caller because the vault is the only
   * party that has the secret; and it is worth being able to ask for, since
   * the alternative way to test a wake address is to queue a job and watch
   * whether anything happens.
   */
  app.post('/api/runners/:name/wake', json, async (req, res) => {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    const name = req.params.name;
    const existing = loadRunners(root).runners[name];
    if (!existing) {
      apiError(res, 404, `no runner named ${name}`);
      return;
    }
    if (!canAdminRunnerGlobs(root, auth, existing.allow)) {
      apiError(res, 403, 'you must own every collection this runner serves; a site admin may manage any runner');
      return;
    }
    const wake = wakeOf(existing);
    if (!wake) {
      apiError(res, 400, `runner ${name} has no wake address, so there is nothing to start it`);
      return;
    }
    const started = Date.now();
    try {
      await sendWake(wake);
    } catch (e) {
      apiError(res, 502, `${wake.url} did not answer: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    res.json({ name, wakeUrl: wake.url, woke: true, seconds: Math.round((Date.now() - started) / 1000) });
  });

  app.delete('/api/runners/:name', (req, res) => {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    const name = req.params.name;
    const registry = loadRunners(root);
    const existing = registry.runners[name];
    if (!existing) {
      apiError(res, 404, `no runner named ${name}`);
      return;
    }
    if (!canAdminRunnerGlobs(root, auth, existing.allow)) {
      apiError(res, 403, 'you must own every collection this runner serves; a site admin may manage any runner');
      return;
    }
    removeRunner(root, name);
    res.json({ name, removed: true });
  });

  // ---- the runner protocol ----

  app.post('/api/runner/acquire', json, async (req, res) => {
    const auth = requireRunner(req, res);
    if (!auth) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const requested = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((l) => typeof l === 'string') : [];
    // A runner may narrow its registered labels per call but never widen
    // them: the registry is the authority on what it may claim to be.
    const labels = (requested as string[]).filter((l) => auth.runner.labels.includes(l));
    if (labels.length === 0) {
      res.status(204).end();
      return;
    }
    // Detect a runner that hangs up while we hold the poll open. Note that
    // this must watch the response, not the request: a request whose body has
    // been fully read emits 'close' immediately, long before the client goes
    // away, and treating that as a disconnect would cancel every job at the
    // moment it was leased.
    let closed = false;
    const gone = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        closed = true;
        gone.abort();
      }
    });
    const spec = await engine.waitForJob(
      auth.name,
      labels,
      auth.runner.allow,
      baseUrlOf(req),
      ACQUIRE_TIMEOUT_MS,
      gone.signal
    );
    if (!spec) {
      if (!closed) res.status(204).end();
      return;
    }
    spec.site = siteOf(req, spec.address.collection, spec.address.repo);
    if (closed) {
      // The runner hung up while we were leasing; release it immediately so
      // the job does not wait out a lease expiry with nobody running it.
      engine.reportStatus(spec.address.collection, spec.address.repo, spec.address.run, spec.address.job, {
        lease: spec.lease,
        runner: auth.name,
        status: 'completed',
        conclusion: 'cancelled',
      });
      return;
    }
    res.json(spec);
  });

  // Every job-scoped endpoint checks the lease token, so a runner can only
  // touch the job it currently holds, whatever else it is allowed to run.
  function addressOf(req: Request): { collection: string; repo: string; run: number; job: string } | null {
    const collection = req.params.collection;
    const repo = req.params.repo;
    const run = parseInt(req.params.run, 10);
    const job = req.params.job;
    if (!isValidName(collection) || !isValidName(repo)) return null;
    if (!Number.isInteger(run) || run <= 0) return null;
    if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(job)) return null;
    return { collection, repo, run, job };
  }

  function leaseOf(req: Request): string {
    const v = req.get('x-cofferdam-lease');
    return typeof v === 'string' ? v : '';
  }

  app.post('/api/runner/jobs/:collection/:repo/:run/:job/heartbeat', json, (req, res) => {
    const auth = requireRunner(req, res);
    if (!auth) return;
    const a = addressOf(req);
    if (!a) {
      apiError(res, 400, 'invalid job address');
      return;
    }
    const result = engine.heartbeat(a.collection, a.repo, a.run, a.job, leaseOf(req), auth.name);
    if (!result) {
      apiError(res, 409, 'the lease on this job is no longer valid');
      return;
    }
    res.json(result);
  });

  app.post(
    '/api/runner/jobs/:collection/:repo/:run/:job/logs',
    express.text({ type: '*/*', limit: MAX_LOG_BODY }),
    (req, res) => {
      const auth = requireRunner(req, res);
      if (!auth) return;
      const a = addressOf(req);
      if (!a) {
        apiError(res, 400, 'invalid job address');
        return;
      }
      const body = typeof req.body === 'string' ? req.body : '';
      // Validate every line before appending: the log file is read back as
      // ndjson by the UI, so a malformed line would corrupt the stream.
      const lines: string[] = [];
      for (const raw of body.split('\n')) {
        if (raw.trim() === '') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        const p = parsed as Partial<LogLine>;
        if (typeof p.l !== 'string' || typeof p.s !== 'number') continue;
        lines.push(JSON.stringify({ s: p.s, t: typeof p.t === 'string' ? p.t : new Date().toISOString(), l: p.l }));
      }
      if (lines.length === 0) {
        res.json({ ok: true });
        return;
      }
      const ok = engine.appendLogs(
        a.collection,
        a.repo,
        a.run,
        a.job,
        leaseOf(req),
        auth.name,
        lines.join('\n') + '\n'
      );
      if (!ok) {
        apiError(res, 409, 'the lease on this job is no longer valid');
        return;
      }
      res.json({ ok: true });
    }
  );

  app.post('/api/runner/jobs/:collection/:repo/:run/:job/status', json, (req, res) => {
    const auth = requireRunner(req, res);
    if (!auth) return;
    const a = addressOf(req);
    if (!a) {
      apiError(res, 400, 'invalid job address');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const status = body.status === 'completed' ? 'completed' : 'running';
    const conclusion =
      typeof body.conclusion === 'string' &&
      ['success', 'failure', 'cancelled', 'skipped'].includes(body.conclusion)
        ? (body.conclusion as Conclusion)
        : undefined;
    const stepStates = Array.isArray(body.stepStates) ? (body.stepStates as StepState[]) : undefined;
    const outputs =
      typeof body.outputs === 'object' && body.outputs !== null
        ? (Object.fromEntries(
            Object.entries(body.outputs as Record<string, unknown>)
              .filter(([, v]) => typeof v === 'string')
              .map(([k, v]) => [k, v as string])
          ) as Record<string, string>)
        : undefined;
    const summaries = Array.isArray(body.summaries)
      ? (body.summaries as unknown[]).filter((s): s is string => typeof s === 'string')
      : undefined;
    const ok = engine.reportStatus(a.collection, a.repo, a.run, a.job, {
      lease: leaseOf(req),
      runner: auth.name,
      status,
      conclusion,
      stepStates,
      outputs,
      summaries,
    });
    if (!ok) {
      apiError(res, 409, 'the lease on this job is no longer valid');
      return;
    }
    res.json({ ok: true });
  });

  // ---- artifacts ----
  //
  // A job uploads under a name and a later job in the same run downloads by
  // that name. Authorization is the job's lease, so an artifact can only be
  // written by a job that is actually running, and only into its own run.

  app.put('/api/runner/jobs/:collection/:repo/:run/:job/artifacts/:name', (req, res) => {
    const auth = requireRunner(req, res);
    if (!auth) return;
    const a = addressOf(req);
    if (!a) {
      apiError(res, 400, 'invalid job address');
      return;
    }
    const name = req.params.name;
    if (!isValidArtifactName(name)) {
      apiError(res, 400, 'invalid artifact name');
      return;
    }
    if (!engine.heartbeat(a.collection, a.repo, a.run, a.job, leaseOf(req), auth.name)) {
      apiError(res, 409, 'the lease on this job is no longer valid');
      return;
    }
    const dir = artifactsDir(root, a.collection, a.repo, a.run);
    const file = artifactPath(root, a.collection, a.repo, a.run, name);
    if (!dir || !file) {
      apiError(res, 400, 'invalid artifact target');
      return;
    }
    const limit = engine.artifactLimitBytes();
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    const out = fs.createWriteStream(tmp);
    let written = 0;
    let failed = false;
    const abort = (status: number, message: string) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.rmSync(tmp, { force: true });
      req.unpipe(out);
      req.resume();
      apiError(res, status, message);
    };
    req.on('data', (chunk: Buffer) => {
      written += chunk.length;
      if (written > limit) {
        abort(413, `artifact ${name} exceeds the ${Math.round(limit / (1024 * 1024))} MB limit for this vault`);
      }
    });
    req.on('error', () => abort(400, 'the upload was interrupted'));
    out.on('error', () => abort(500, 'could not store the artifact'));
    out.on('finish', () => {
      if (failed) return;
      try {
        fs.renameSync(tmp, file);
      } catch {
        apiError(res, 500, 'could not store the artifact');
        return;
      }
      res.json({ name, size: written });
    });
    req.pipe(out);
  });

  app.get('/api/runner/jobs/:collection/:repo/:run/:job/artifacts/:name', (req, res) => {
    const auth = requireRunner(req, res);
    if (!auth) return;
    const a = addressOf(req);
    if (!a) {
      apiError(res, 400, 'invalid job address');
      return;
    }
    if (!engine.heartbeat(a.collection, a.repo, a.run, a.job, leaseOf(req), auth.name)) {
      apiError(res, 409, 'the lease on this job is no longer valid');
      return;
    }
    const file = artifactPath(root, a.collection, a.repo, a.run, req.params.name);
    if (!file || !fs.existsSync(file)) {
      apiError(res, 404, `no artifact named ${req.params.name} in this run`);
      return;
    }
    res.type('application/x-tar').sendFile(path.resolve(file));
  });

  app.get('/api/runner/jobs/:collection/:repo/:run/:job/artifacts', (req, res) => {
    const auth = requireRunner(req, res);
    if (!auth) return;
    const a = addressOf(req);
    if (!a) {
      apiError(res, 400, 'invalid job address');
      return;
    }
    if (!engine.heartbeat(a.collection, a.repo, a.run, a.job, leaseOf(req), auth.name)) {
      apiError(res, 409, 'the lease on this job is no longer valid');
      return;
    }
    res.json({ artifacts: listArtifacts(root, a.collection, a.repo, a.run) });
  });

  // Publishing an artifact as the repository's site. The extraction happens
  // here rather than on the runner because the site directory is vault
  // state; artifacts.ts treats the archive as untrusted.
  app.post('/api/runner/jobs/:collection/:repo/:run/:job/site', json, async (req, res) => {
    const auth = requireRunner(req, res);
    if (!auth) return;
    const a = addressOf(req);
    if (!a) {
      apiError(res, 400, 'invalid job address');
      return;
    }
    if (!engine.heartbeat(a.collection, a.repo, a.run, a.job, leaseOf(req), auth.name)) {
      apiError(res, 409, 'the lease on this job is no longer valid');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.artifact === 'string' ? body.artifact : 'github-pages';
    if (!isValidArtifactName(name)) {
      apiError(res, 400, 'invalid artifact name');
      return;
    }
    try {
      const result = await deploySite(root, a.collection, a.repo, a.run, name);
      res.json({
        deployed: true,
        files: result.files,
        url: siteOf(req, a.collection, a.repo).url,
      });
    } catch (e) {
      apiError(res, e instanceof ArtifactError ? 400 : 500, e instanceof Error ? e.message : String(e));
    }
  });

  // Runner-side liveness check, so `cofferdam runner run` can fail fast with a
  // clear message rather than long-polling against a bad token or host.
  app.get('/api/runner/whoami', (req, res) => {
    const auth = requireRunner(req, res);
    if (!auth) return;
    res.json({ name: auth.name, labels: auth.runner.labels, allow: auth.runner.allow });
  });
}

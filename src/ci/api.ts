import express, { Express, Request, Response } from 'express';
import { isValidName } from '../scan';
import { AuthResult, authenticateToken, canAdmin, loadVault } from '../vault';
import { baseUrlOf } from '../web';
import { CiEngine } from './engine';
import { LogLine } from './protocol';
import { Conclusion, StepState } from './runs';
import { RunnerAuth, authenticateRunner, loadRunners, registerRunner, removeRunner } from './runners';

// The runner-facing API and the admin API for runner registration.
//
// Runner endpoints are authenticated by a runner token (Bearer), never by a
// session cookie and never by a user token. Registration endpoints are the
// mirror image: a user token with admin scope, never a runner token. The two
// credential kinds do not overlap at any endpoint.

const ACQUIRE_TIMEOUT_MS = 25 * 1000;
const MAX_LOG_BODY = 4 * 1024 * 1024;

export function registerCiApi(app: Express, root: string, engine: CiEngine): void {
  const json = express.json({ limit: '1mb' });

  function apiError(res: Response, status: number, message: string) {
    res.status(status).json({ error: message });
  }

  function requireAdmin(req: Request, res: Response): AuthResult | null {
    const state = loadVault(root);
    if (state.status !== 'ok') {
      apiError(res, 500, 'vault unavailable');
      return null;
    }
    const m = (req.get('authorization') ?? '').match(/^bearer\s+(.+)$/i);
    if (!m) {
      apiError(res, 401, 'missing bearer token; set HUBBIT_TOKEN');
      return null;
    }
    const auth = authenticateToken(state.vault, m[1].trim());
    if (!auth) {
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
    const auth = authenticateRunner(root, m[1].trim());
    if (!auth) {
      apiError(res, 401, 'invalid runner token');
      return null;
    }
    return auth;
  }

  // ---- runner registration (admin) ----

  app.get('/api/runners', json, (req, res) => {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    if (!canAdmin(auth, [])) {
      apiError(res, 403, 'admin access required (with an unrestricted token)');
      return;
    }
    const registry = loadRunners(root);
    res.json({
      runners: Object.entries(registry.runners).map(([name, r]) => ({
        name,
        labels: r.labels,
        allow: r.allow,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
      })),
    });
  });

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
    // Registering one therefore demands admin scope over exactly that set.
    if (!canAdmin(auth, allow)) {
      apiError(res, 403, `your admin scope does not cover: ${allow.join(', ')}`);
      return;
    }
    if (loadRunners(root).runners[name]) {
      apiError(res, 409, `a runner named ${name} is already registered; remove it first`);
      return;
    }
    const { token, runner } = registerRunner(root, name, {
      labels: labels.length ? labels : ['ubuntu-latest'],
      allow,
      createdBy: auth.username,
    });
    res.json({ name, token, labels: runner.labels, allow: runner.allow });
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
    if (!canAdmin(auth, existing.allow)) {
      apiError(res, 403, `your admin scope does not cover: ${existing.allow.join(', ')}`);
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
    res.on('close', () => {
      if (!res.writableEnded) closed = true;
    });
    const spec = await engine.waitForJob(auth.name, labels, auth.runner.allow, baseUrlOf(req), ACQUIRE_TIMEOUT_MS);
    if (!spec) {
      if (!closed) res.status(204).end();
      return;
    }
    if (closed) {
      // The runner hung up while we were leasing; release it immediately so
      // the job does not wait out a lease expiry with nobody running it.
      engine.reportStatus(spec.address.collection, spec.address.repo, spec.address.run, spec.address.job, {
        lease: spec.lease,
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
    const v = req.get('x-hubbit-lease');
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
    const result = engine.heartbeat(a.collection, a.repo, a.run, a.job, leaseOf(req));
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
      const ok = engine.appendLogs(a.collection, a.repo, a.run, a.job, leaseOf(req), lines.join('\n') + '\n');
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

  // Runner-side liveness check, so `hubbit runner run` can fail fast with a
  // clear message rather than long-polling against a bad token or host.
  app.get('/api/runner/whoami', (req, res) => {
    const auth = requireRunner(req, res);
    if (!auth) return;
    res.json({ name: auth.name, labels: auth.runner.labels, allow: auth.runner.allow });
  });
}

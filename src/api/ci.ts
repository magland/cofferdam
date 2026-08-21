import { Express } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { artifactPath, isValidArtifactName, listArtifacts } from '../ci/artifacts';
import { dispatchWorkflow } from '../ci/dispatch';
import { CiEngine, listWorkflowsAt } from '../ci/engine';
import { MINT_TTL_MS } from '../ci/manual';
import { RunStatus, isValidJobId, jobLogPath, listRuns, readJob, readRun } from '../ci/runs';
import { isValidRefName } from '../git';
import { AuthLimiter } from '../limit';
import { packageVersion } from '../version';
import { baseUrlOf } from '../web';
import { apiError, bodyOf, limitParam, requireRepo, requirePush, sendOpError, stringField } from './auth';

// Workflows and their runs.
//
// The one thing here that is not a thin transport is the log: a job log can be
// large and is capped by the server, and an agent diagnosing a failure wants the
// end of it. Handing it the whole thing wastes its context, so ?tail= defaults to
// the last two hundred lines and the response says when it truncated something.

const MAX_LISTED_RUNS = 200;
const DEFAULT_TAIL = 200;

function runNumber(raw: string | undefined): number | null {
  return /^[1-9][0-9]*$/.test(raw ?? '') ? parseInt(raw as string, 10) : null;
}

/**
 * A job log, as lines. It is stored as NDJSON, one object per line, which is what
 * the runner posts and what the tailer reads; a caller asking for text gets the
 * text out of it.
 */
function readLog(file: string): { lines: string[]; raw: string[] } {
  let content = '';
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return { lines: [], raw: [] };
  }
  const raw = content.split('\n').filter((l) => l !== '');
  const lines: string[] = [];
  for (const line of raw) {
    try {
      const parsed = JSON.parse(line) as { text?: unknown };
      lines.push(typeof parsed.text === 'string' ? parsed.text : line);
    } catch {
      lines.push(line);
    }
  }
  return { lines, raw };
}

export function registerCiRunApi(app: Express, root: string, limiter: AuthLimiter, engine: CiEngine): void {
  // The workflows at a ref, with the inputs each dispatch takes. A caller that
  // means to run one needs both.
  app.get('/api/repos/:collection/:repo/workflows', async (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const asked = String(req.query.ref ?? '');
    if (asked !== '' && !isValidRefName(asked)) {
      apiError(res, 400, 'ref is not a usable ref name');
      return;
    }
    const branches = await found.repo.listRefs('heads');
    const ref = asked || (await found.repo.defaultBranch(branches)) || '';
    const sha = ref === '' ? null : await found.repo.resolve(ref);
    if (!sha) {
      res.json({ ref, workflows: [] });
      return;
    }
    res.json({ ref, sha, workflows: await listWorkflowsAt(found.repo, sha) });
  });

  app.get('/api/repos/:collection/:repo/runs', (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const status = String(req.query.status ?? '');
    if (status !== '' && !['queued', 'running', 'completed'].includes(status)) {
      apiError(res, 400, 'status must be queued, running, or completed');
      return;
    }
    const all = listRuns(root, found.repo.collection, found.repo.name);
    const selected = status === '' ? all : all.filter((r) => r.status === (status as RunStatus));
    const limit = limitParam(req.query.limit, 30, MAX_LISTED_RUNS);
    res.json({ runs: selected.slice(0, limit), total: selected.length });
  });

  app.get('/api/repos/:collection/:repo/runs/:n', (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const n = runNumber(req.params.n);
    const run = n === null ? null : readRun(root, found.repo.collection, found.repo.name, n);
    if (!run) {
      apiError(res, 404, `no run #${req.params.n} in ${found.repo.collection}/${found.repo.name}`);
      return;
    }
    // The jobs with their step states, because "which step failed" is the next
    // question after "did it fail" and a second request per job to answer it
    // would be a poor trade.
    const jobs = run.jobs
      .map((id) => readJob(root, found.repo.collection, found.repo.name, n as number, id))
      .filter((j) => j !== null);
    res.json({ ...run, jobs });
  });

  app.get('/api/repos/:collection/:repo/runs/:n/jobs/:job', (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const n = runNumber(req.params.n);
    if (n === null || !isValidJobId(req.params.job)) {
      apiError(res, 404, 'no such job');
      return;
    }
    const job = readJob(root, found.repo.collection, found.repo.name, n, req.params.job);
    if (!job) {
      apiError(res, 404, `no job ${req.params.job} in run #${n}`);
      return;
    }
    res.json(job);
  });

  // ?tail=<n> for the last n lines, ?tail=0 for all of it, ?format=ndjson for
  // the records as the runner posted them.
  app.get('/api/repos/:collection/:repo/runs/:n/jobs/:job/log', (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const n = runNumber(req.params.n);
    if (n === null || !isValidJobId(req.params.job)) {
      apiError(res, 404, 'no such job');
      return;
    }
    const job = readJob(root, found.repo.collection, found.repo.name, n, req.params.job);
    if (!job) {
      apiError(res, 404, `no job ${req.params.job} in run #${n}`);
      return;
    }
    const format = String(req.query.format ?? 'text');
    if (format !== 'text' && format !== 'ndjson') {
      apiError(res, 400, 'format must be text or ndjson');
      return;
    }
    const asked = req.query.tail;
    const tail = asked === undefined ? DEFAULT_TAIL : Number(asked);
    if (!Number.isInteger(tail) || tail < 0) {
      apiError(res, 400, 'tail must be a whole number; 0 means the whole log');
      return;
    }
    const { lines, raw } = readLog(jobLogPath(root, found.repo.collection, found.repo.name, n, req.params.job));
    const source = format === 'ndjson' ? raw : lines;
    const kept = tail === 0 ? source : source.slice(-tail);
    res.json({
      job: job.id,
      status: job.status,
      conclusion: job.conclusion ?? null,
      // Two kinds of truncation, and they are not the same thing: the server
      // caps a log as it is written, and tail keeps only the end of what is
      // there. A caller diagnosing a failure should be told which happened.
      lines: kept,
      truncated: kept.length < source.length,
      capped: job.logCapped === true,
      total: source.length,
      // A job that failed in the planner has no log at all, only a reason.
      error: job.error ?? null,
    });
  });

  app.get('/api/repos/:collection/:repo/runs/:n/artifacts', (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const n = runNumber(req.params.n);
    if (n === null) {
      apiError(res, 404, 'no such run');
      return;
    }
    res.json({ artifacts: listArtifacts(root, found.repo.collection, found.repo.name, n) });
  });

  app.get('/api/repos/:collection/:repo/runs/:n/artifacts/:name', (req, res) => {
    const found = requireRepo(root, limiter, req, res);
    if (!found) return;
    const n = runNumber(req.params.n);
    if (n === null || !isValidArtifactName(req.params.name)) {
      apiError(res, 404, 'no such artifact');
      return;
    }
    const file = artifactPath(root, found.repo.collection, found.repo.name, n, req.params.name);
    if (!file || !fs.existsSync(file)) {
      apiError(res, 404, `no artifact named ${req.params.name} in run #${n}`);
      return;
    }
    res
      .type('application/x-tar')
      .set('Content-Disposition', `attachment; filename="${req.params.name}.tar"`)
      .sendFile(path.resolve(file));
  });

  // Cancelling, re-running, and dispatching write, so they take the write role on
  // the repository, which is what the web requires of them too.
  app.post('/api/repos/:collection/:repo/runs/:n/cancel', (req, res) => {
    const ctx = requirePush(root, limiter, req, res);
    if (!ctx) return;
    const n = runNumber(req.params.n);
    if (n === null || !readRun(root, ctx.repo.collection, ctx.repo.name, n)) {
      apiError(res, 404, `no run #${req.params.n}`);
      return;
    }
    // A run that is already over is not cancellable, which is a state refusal
    // rather than a missing run.
    const cancelled = engine.cancelRun(ctx.repo.collection, ctx.repo.name, n);
    if (!cancelled) {
      apiError(res, 409, `run #${n} is not in progress`);
      return;
    }
    res.json({ cancelled: n });
  });

  app.post('/api/repos/:collection/:repo/runs/:n/rerun', async (req, res) => {
    const ctx = requirePush(root, limiter, req, res);
    if (!ctx) return;
    const n = runNumber(req.params.n);
    if (n === null) {
      apiError(res, 404, 'no such run');
      return;
    }
    try {
      const fresh = await engine.rerun(ctx.repo.collection, ctx.repo.name, n);
      if (!fresh) {
        apiError(res, 404, `no run #${n}`);
        return;
      }
      res.json({ number: fresh.number, workflowName: fresh.workflowName, status: fresh.status });
    } catch (e) {
      apiError(res, 400, e instanceof Error ? e.message : String(e));
    }
  });

  /**
   * Mint the command that runs this run's manual jobs on a machine of the
   * caller's. Takes the write role, the same standing that dispatches and
   * re-runs workflows: minting decides that repository code will execute
   * somewhere, which is exactly what those decide.
   *
   * The token is in the response once and only its hash is kept, as with
   * every credential a vault issues. It must be redeemed within fifteen
   * minutes and is spent by redemption; the npx version is pinned to this
   * vault's own, so the pasted command runs the client this server was
   * released with.
   */
  app.post('/api/repos/:collection/:repo/runs/:n/exec-command', (req, res) => {
    const ctx = requirePush(root, limiter, req, res);
    if (!ctx) return;
    const n = runNumber(req.params.n);
    if (n === null || !readRun(root, ctx.repo.collection, ctx.repo.name, n)) {
      apiError(res, 404, `no run #${req.params.n}`);
      return;
    }
    const minted = engine.mintManual(ctx.repo.collection, ctx.repo.name, n, ctx.actor.username);
    if ('error' in minted) {
      if (minted.error === 'finished') apiError(res, 409, `run #${n} has finished; there is nothing left to run`);
      else apiError(res, 400, `run #${n} has no manual jobs (none of its jobs has 'manual' in runs-on)`);
      return;
    }
    const url = baseUrlOf(req);
    res.status(201).json({
      run: n,
      token: minted.token,
      expiresAt: minted.grant.expiresAt,
      expiresInMinutes: Math.round(MINT_TTL_MS / 60000),
      command: `npx @magland/mochi@${packageVersion()} job run ${url} ${minted.token}`,
    });
  });

  app.post('/api/repos/:collection/:repo/dispatches', async (req, res) => {
    const ctx = requirePush(root, limiter, req, res);
    if (!ctx) return;
    const body = bodyOf(req);
    const workflow = stringField(body, 'workflow');
    if (workflow === null) {
      apiError(res, 400, 'a "workflow" is required; list them at /workflows');
      return;
    }
    const rawInputs = body.inputs;
    if (rawInputs !== undefined && (typeof rawInputs !== 'object' || rawInputs === null || Array.isArray(rawInputs))) {
      apiError(res, 400, '"inputs" must be an object');
      return;
    }
    const branches = await ctx.repo.listRefs('heads');
    try {
      const run = await dispatchWorkflow(engine, ctx.repo, branches, await ctx.repo.defaultBranch(branches), ctx.actor.username, {
        workflow,
        ref: stringField(body, 'ref') ?? '',
        inputs: (rawInputs ?? {}) as Record<string, unknown>,
      });
      res.status(201).json({ number: run.number, workflowName: run.workflowName, status: run.status, sha: run.sha });
    } catch (e) {
      sendOpError(res, e, 'could not dispatch the workflow');
    }
  });
}

import express, { Express, Request, Response } from 'express';
import * as fs from 'fs';
import { isValidRefName } from '../git';
import { findRepo, isValidName } from '../scan';
import { Viewer, checkCsrf, getViewer, viewerIsAdmin } from '../session';
import { canAdmin } from '../vault';
import * as forms from '../forms';
import { ah, loadRepo, makeCtx, send404 } from '../web';
import { CiEngine, listWorkflowsAt } from './engine';
import { JobRecord, RunRecord, jobLogPath, listRuns } from './runs';
import { loadRunners, registerRunner, removeRunner } from './runners';
import * as ciViews from './views';
import { WorkflowError } from './workflow';

// The Actions pages and their operations. Reading is anonymous, as everywhere
// else in a vault; cancelling, re-running, and dispatching require push scope
// over the repository, and runner registration requires admin scope.

const RUNS_PER_PAGE = 50;
const MAX_LOG_RENDER_BYTES = 4 * 1024 * 1024;

const form = express.urlencoded({ extended: false, limit: '1mb' });

function field(req: Request, name: string): string {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof v === 'string' ? v : '';
}

// Read a job log as ndjson from a byte offset. Returning the new offset lets
// the tailer poll without re-reading, and lets a huge log render its tail
// rather than exhausting memory.
export function readLog(
  file: string,
  offset: number
): { lines: { s: number; l: string }[]; offset: number } {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { lines: [], offset: 0 };
  }
  let start = Math.max(0, Math.min(offset, size));
  let truncated = false;
  if (size - start > MAX_LOG_RENDER_BYTES) {
    start = size - MAX_LOG_RENDER_BYTES;
    truncated = true;
  }
  let text: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { lines: [], offset };
  }
  // A trailing partial line means the writer is mid-append; leave it for the
  // next poll by reporting an offset before it.
  const lastNewline = text.lastIndexOf('\n');
  let consumed = size;
  if (lastNewline === -1) {
    return { lines: [], offset: start };
  }
  if (lastNewline !== text.length - 1) {
    consumed = start + Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8');
    text = text.slice(0, lastNewline + 1);
  }
  const lines: { s: number; l: string }[] = [];
  if (truncated) lines.push({ s: 0, l: '[earlier output omitted]' });
  for (const raw of text.split('\n')) {
    if (raw === '') continue;
    try {
      const p = JSON.parse(raw) as { s?: number; l?: string };
      if (typeof p.l === 'string') lines.push({ s: typeof p.s === 'number' ? p.s : 0, l: p.l });
    } catch {
      // skip a damaged line rather than failing the page
    }
  }
  return { lines, offset: consumed };
}

export function registerCiWeb(app: Express, root: string, engine: CiEngine): void {
  function fail(res: Response, status: number, message: string, viewer: Viewer | null, backUrl?: string): void {
    res.status(status).type('html').send(forms.opErrorPage(status, message, { viewer, backUrl }));
  }

  function requireViewerPost(req: Request, res: Response): Viewer | null {
    const viewer = getViewer(req, root);
    if (!viewer) {
      fail(res, 403, 'You must be signed in to do that.', null, '/login');
      return null;
    }
    if (!checkCsrf(req, viewer)) {
      fail(res, 403, 'The form has expired; go back, reload the page, and try again.', viewer);
      return null;
    }
    return viewer;
  }

  // ---- the runs list ----

  app.get(
    '/:collection/:repo/actions',
    ah(async (req, res) => {
      const viewer = getViewer(req, root);
      const loaded = await loadRepo(root, req, res, viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', viewer);
      const filter = typeof req.query.workflow === 'string' ? req.query.workflow : null;
      let runs = listRuns(root, loaded.repo.collection, loaded.repo.name);
      if (filter) runs = runs.filter((r) => r.workflowPath === filter);
      runs = runs.slice(0, RUNS_PER_PAGE);
      // Live runs are held in memory; prefer those records so a listing
      // refreshed mid-run shows the current status rather than the last write.
      runs = runs.map((r) => engine.activeRun(loaded.repo.collection, loaded.repo.name, r.number) ?? r);

      let workflows: Awaited<ReturnType<typeof listWorkflowsAt>> = [];
      const tip = loaded.branches.find((b) => b.name === loaded.defaultBranch);
      if (tip) {
        try {
          workflows = await listWorkflowsAt(loaded.repo, tip.sha);
        } catch {
          workflows = [];
        }
      }
      const flash = typeof req.query.flash === 'string' ? req.query.flash : undefined;
      res.type('html').send(ciViews.runsPage(ctx, runs, workflows, filter, flash));
    })
  );

  // ---- one run ----

  async function loadRunPage(
    req: Request,
    res: Response
  ): Promise<{ viewer: Viewer | null; loaded: Awaited<ReturnType<typeof loadRepo>>; run: RunRecord } | null> {
    const viewer = getViewer(req, root);
    const loaded = await loadRepo(root, req, res, viewer);
    if (!loaded) return null;
    const n = parseInt(req.params.run, 10);
    if (!Number.isInteger(n) || n <= 0) {
      send404(res, 'No such run', viewer);
      return null;
    }
    const run = engine.runOf(loaded.repo.collection, loaded.repo.name, n);
    if (!run) {
      send404(res, `Run #${n} not found`, viewer);
      return null;
    }
    return { viewer, loaded, run };
  }

  app.get(
    '/:collection/:repo/actions/runs/:run',
    ah(async (req, res) => {
      const page = await loadRunPage(req, res);
      if (!page) return;
      const { viewer, loaded, run } = page;
      const repo = loaded!.repo;
      const ctx = await makeCtx(root, req, loaded!, run.refName || (loaded!.defaultBranch ?? ''), viewer);

      const jobs: JobRecord[] = [];
      for (const id of run.jobs) {
        const j = engine.jobOf(repo.collection, repo.name, run.number, id);
        if (j) jobs.push(j);
      }
      const wanted = typeof req.query.job === 'string' ? req.query.job : null;
      const selected =
        (wanted ? jobs.find((j) => j.id === wanted) : undefined) ??
        jobs.find((j) => j.status === 'running') ??
        jobs.find((j) => j.conclusion === 'failure') ??
        jobs[0] ??
        null;

      let lines: { s: number; l: string }[] = [];
      let offset = 0;
      if (selected) {
        const r = readLog(jobLogPath(root, repo.collection, repo.name, run.number, selected.id), 0);
        lines = r.lines;
        offset = r.offset;
      }
      res.type('html').send(ciViews.runPage(ctx, run, jobs, selected, lines, offset));
    })
  );

  // The tailer's endpoint: new log lines since an offset, plus whether the
  // job has finished (at which point the page reloads into the step view).
  app.get(
    '/:collection/:repo/actions/runs/:run/log/:job',
    ah(async (req, res) => {
      const collection = req.params.collection;
      const repoName = req.params.repo;
      const repo = findRepo(root, collection, repoName);
      if (!repo) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const n = parseInt(req.params.run, 10);
      if (!Number.isInteger(n) || n <= 0) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const job = engine.jobOf(repo.collection, repo.name, n, req.params.job);
      if (!job) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);
      const r = readLog(jobLogPath(root, repo.collection, repo.name, n, job.id), offset);
      res.set('Cache-Control', 'no-store').json({
        done: job.status === 'completed',
        offset: r.offset,
        lines: r.lines.map((l) => l.l),
      });
    })
  );

  // ---- operations ----

  function repoActor(req: Request, res: Response): { viewer: Viewer; collection: string; repo: string } | null {
    const viewer = requireViewerPost(req, res);
    if (!viewer) return null;
    const collection = req.params.collection;
    const repoName = req.params.repo;
    if (!isValidName(collection) || !isValidName(repoName)) {
      fail(res, 404, 'No such repository', viewer);
      return null;
    }
    return { viewer, collection, repo: repoName };
  }

  app.post(
    '/:collection/:repo/actions/runs/:run/cancel',
    form,
    ah(async (req, res) => {
      const actor = repoActor(req, res);
      if (!actor) return;
      const loaded = await loadRepo(root, req, res, actor.viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', actor.viewer);
      if (!ctx.canPush) {
        fail(res, 403, 'You do not have permission to cancel runs in this repository.', actor.viewer);
        return;
      }
      const n = parseInt(req.params.run, 10);
      engine.cancelRun(loaded.repo.collection, loaded.repo.name, n);
      res.redirect(
        `/${encodeURIComponent(loaded.repo.collection)}/${encodeURIComponent(loaded.repo.name)}/actions/runs/${n}`
      );
    })
  );

  app.post(
    '/:collection/:repo/actions/runs/:run/rerun',
    form,
    ah(async (req, res) => {
      const actor = repoActor(req, res);
      if (!actor) return;
      const loaded = await loadRepo(root, req, res, actor.viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', actor.viewer);
      if (!ctx.canPush) {
        fail(res, 403, 'You do not have permission to run workflows in this repository.', actor.viewer);
        return;
      }
      const n = parseInt(req.params.run, 10);
      const base = `/${encodeURIComponent(loaded.repo.collection)}/${encodeURIComponent(loaded.repo.name)}/actions`;
      try {
        const fresh = await engine.rerun(loaded.repo.collection, loaded.repo.name, n);
        if (!fresh) {
          fail(res, 404, `Run #${n} not found`, actor.viewer, base);
          return;
        }
        res.redirect(`${base}/runs/${fresh.number}`);
      } catch (e) {
        fail(res, 400, e instanceof Error ? e.message : String(e), actor.viewer, base);
      }
    })
  );

  app.post(
    '/:collection/:repo/actions/dispatch',
    form,
    ah(async (req, res) => {
      const actor = repoActor(req, res);
      if (!actor) return;
      const loaded = await loadRepo(root, req, res, actor.viewer);
      if (!loaded) return;
      const ctx = await makeCtx(root, req, loaded, loaded.defaultBranch ?? '', actor.viewer);
      const base = `/${encodeURIComponent(loaded.repo.collection)}/${encodeURIComponent(loaded.repo.name)}/actions`;
      if (!ctx.canPush) {
        fail(res, 403, 'You do not have permission to run workflows in this repository.', actor.viewer);
        return;
      }
      const workflowPath = field(req, 'workflow');
      const ref = field(req, 'ref') || loaded.defaultBranch || '';
      if (!isValidRefName(ref) || ref.startsWith('-')) {
        fail(res, 400, 'Invalid branch', actor.viewer, base);
        return;
      }
      const branch = loaded.branches.find((b) => b.name === ref);
      if (!branch) {
        fail(res, 400, `Branch ${ref} not found`, actor.viewer, base);
        return;
      }
      const inputs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries((req.body ?? {}) as Record<string, unknown>)) {
        if (k.startsWith('input.') && typeof v === 'string') inputs[k.slice(6)] = v;
      }
      try {
        const run = await engine.handleDispatch(
          loaded.repo,
          workflowPath,
          `refs/heads/${ref}`,
          branch.sha,
          actor.viewer.auth.username,
          inputs
        );
        res.redirect(`${base}/runs/${run.number}`);
      } catch (e) {
        fail(res, 400, e instanceof WorkflowError ? e.message : String(e), actor.viewer, base);
      }
    })
  );

  // ---- runners, under Admin ----

  app.get('/admin/runners', (req, res) => {
    const viewer = getViewer(req, root);
    if (!viewer) {
      res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    if (!viewerIsAdmin(viewer)) {
      fail(res, 403, 'Admin access is required to manage runners.', viewer);
      return;
    }
    const registry = loadRunners(root);
    const runners = Object.entries(registry.runners).map(([name, r]) => ({
      name,
      labels: r.labels,
      allow: r.allow,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
    }));
    const flash = typeof req.query.flash === 'string' ? req.query.flash : undefined;
    res.type('html').send(ciViews.runnersPage(viewer, runners, flash));
  });

  app.post('/admin/runners', form, (req, res) => {
    const viewer = requireViewerPost(req, res);
    if (!viewer) return;
    if (!viewerIsAdmin(viewer)) {
      fail(res, 403, 'Admin access is required to register runners.', viewer);
      return;
    }
    const name = field(req, 'name');
    const labels = field(req, 'labels')
      .split(/[\s,]+/)
      .filter((s) => s.length > 0 && s.length < 200);
    const allow = field(req, 'allow')
      .split(/[\s,]+/)
      .filter((s) => s.length > 0 && s.length < 200);
    const registry = loadRunners(root);
    const showError = (msg: string) => {
      const runners = Object.entries(registry.runners).map(([n, r]) => ({
        name: n,
        labels: r.labels,
        allow: r.allow,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
      }));
      res.status(400).type('html').send(ciViews.runnersPage(viewer, runners, undefined, msg));
    };
    if (!isValidName(name)) {
      showError('A runner needs a simple name (letters, digits, dot, dash, underscore).');
      return;
    }
    if (registry.runners[name]) {
      showError(`A runner named ${name} is already registered; remove it first.`);
      return;
    }
    if (allow.length === 0) {
      showError('Say which repositories this runner may take jobs for, as globs over collection/repo.');
      return;
    }
    if (!canAdmin(viewer.auth, allow)) {
      showError(`Your admin scope does not cover: ${allow.join(', ')}`);
      return;
    }
    const { token } = registerRunner(root, name, {
      labels: labels.length ? labels : ['ubuntu-latest'],
      allow,
      createdBy: viewer.auth.username,
    });
    const host = `${req.protocol}://${req.get('host')}`;
    res.type('html').send(ciViews.runnerTokenPage(viewer, name, token, host));
  });

  app.post('/admin/runners/:name/remove', form, (req, res) => {
    const viewer = requireViewerPost(req, res);
    if (!viewer) return;
    if (!viewerIsAdmin(viewer)) {
      fail(res, 403, 'Admin access is required to manage runners.', viewer);
      return;
    }
    const existing = loadRunners(root).runners[req.params.name];
    if (existing && !canAdmin(viewer.auth, existing.allow)) {
      fail(res, 403, `Your admin scope does not cover: ${existing.allow.join(', ')}`, viewer);
      return;
    }
    removeRunner(root, req.params.name);
    res.redirect('/admin/runners?flash=' + encodeURIComponent(`Runner ${req.params.name} removed.`));
  });
}

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { ActionRef } from '../ci/actionref';
import { isValidArtifactName } from '../ci/artifacts';
import { filterPatternToRegExp } from '../ci/workflow';
import type { StepExecContext } from './steps';

// Actions hubbit implements itself.
//
// Most actions are ordinary programs and run unmodified. A few are not: they
// are thin clients for services that exist only inside GitHub, such as the
// artifact store, the cache service, and the Pages deployment API (which
// hubbit answers with a site). Running
// those verbatim against a hubbit vault cannot work, so hubbit substitutes
// its own implementation of the same interface, chosen by the `uses:` string.
//
// Overriding by name rather than implementing GitHub's wire protocols is a
// deliberate trade: far less code, at the cost of tracking a handful of
// action interfaces as they change. The overrides are matched at any nesting
// depth, so one inside somebody else's composite action is substituted too.

export interface OverrideArgs {
  ctx: StepExecContext;
  ref: ActionRef;
  inputs: Record<string, string>;
  stepEnv: Record<string, string>;
}

export interface OverrideResult {
  ok: boolean;
  outputs?: Record<string, string>;
}

export interface Override {
  name: string;
  run: (args: OverrideArgs) => Promise<OverrideResult>;
}

function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim()));
      else resolve(stdout.toString());
    });
  });
}

function boolInput(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v.trim() === '') return dflt;
  return v.trim().toLowerCase() === 'true';
}

// ---- actions/checkout ----

// hubbit checks the repository out before the job starts, so this is usually
// a no-op that reports what is already there. It does real work when the step
// asks for something different: another repository, another ref, another
// directory, full history, or submodules.
const checkout: Override = {
  name: 'checkout',
  async run({ ctx, inputs }) {
    const wanted = (inputs.repository ?? '').trim();
    const current = String((ctx.spec.github as Record<string, unknown>).repository ?? '');
    const ref = (inputs.ref ?? '').trim();
    const target = (inputs.path ?? '').trim();
    const depthRaw = (inputs['fetch-depth'] ?? '1').trim();
    const depth = Number.isFinite(Number(depthRaw)) ? Number(depthRaw) : 1;
    const submodules = (inputs.submodules ?? '').trim().toLowerCase();

    const sameRepo = wanted === '' || wanted === current;
    const sameRef =
      ref === '' || ref === ctx.spec.sha || ref === ctx.spec.ref || ref === ctx.spec.refName;
    const samePath = target === '' || target === '.' || target === './';

    if (sameRepo && sameRef && samePath) {
      ctx.log(`${current} is already checked out at ${ctx.spec.sha.slice(0, 8)} (hubbit checks out before the job starts)`);
      if (depth === 0) {
        ctx.log('fetch-depth: 0 requested; fetching the full history');
        try {
          await git(['fetch', '--quiet', '--unshallow', 'origin'], ctx.hostPaths.workspace);
        } catch {
          // Not a shallow clone; nothing to deepen.
        }
        try {
          await git(
            ['fetch', '--quiet', '--tags', '--force', 'origin', '+refs/heads/*:refs/remotes/origin/*'],
            ctx.hostPaths.workspace
          );
        } catch (e) {
          ctx.log(`could not fetch the full history: ${e instanceof Error ? e.message : e}`);
          return { ok: false };
        }
      }
      if (submodules !== '' && submodules !== 'false') {
        const args = ['submodule', 'update', '--init'];
        if (submodules === 'recursive') args.push('--recursive');
        try {
          await git(args, ctx.hostPaths.workspace);
        } catch (e) {
          ctx.log(`could not initialize submodules: ${e instanceof Error ? e.message : e}`);
          return { ok: false };
        }
      }
      return { ok: true, outputs: { ref: ctx.spec.ref, commit: ctx.spec.sha } };
    }

    // A different repository, ref, or directory: a real checkout. Note that
    // `repository:` names a repository in this vault, since github.server_url
    // is the vault; a workflow copied from GitHub that pulls in a second
    // repository from github.com needs its own git commands.
    const repoSpec = sameRepo ? current : wanted;
    const [collection, name] = repoSpec.split('/');
    if (!collection || !name) {
      ctx.log(`repository: ${repoSpec} is not collection/repo`);
      return { ok: false };
    }
    const dest = samePath ? ctx.hostPaths.workspace : path.join(ctx.hostPaths.workspace, target);
    const real = path.resolve(dest);
    if (real !== path.resolve(ctx.hostPaths.workspace) && !real.startsWith(path.resolve(ctx.hostPaths.workspace) + path.sep)) {
      ctx.log(`path: ${target} resolves outside the workspace`);
      return { ok: false };
    }
    const url = ctx.cloneUrl(collection, name);
    ctx.log(`Checking out ${repoSpec}${ref ? `@${ref}` : ''} into ${samePath ? '.' : target}`);
    try {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(dest, { recursive: true });
      await git(['init', '--quiet', dest]);
      await git(['remote', 'add', 'origin', url], dest);
      const fetchArgs = ['fetch', '--quiet'];
      if (depth > 0) fetchArgs.push('--depth', String(depth));
      fetchArgs.push('origin', ref === '' ? ctx.spec.sha : ref);
      await git(fetchArgs, dest);
      await git(['checkout', '--quiet', 'FETCH_HEAD'], dest);
      if (submodules !== '' && submodules !== 'false') {
        const args = ['submodule', 'update', '--init'];
        if (submodules === 'recursive') args.push('--recursive');
        await git(args, dest);
      }
      const sha = (await git(['rev-parse', 'HEAD'], dest)).trim();
      return { ok: true, outputs: { ref: ref || ctx.spec.ref, commit: sha } };
    } catch (e) {
      ctx.log(`checkout failed: ${e instanceof Error ? e.message : e}`);
      return { ok: false };
    }
  },
};


// ---- artifacts ----

// GitHub's upload-artifact and download-artifact are clients for its
// artifact service. These do the same job against the vault: the runner
// builds a tar of the requested paths and PUTs it to the run's artifact
// endpoint, authorized by the job's lease.

function splitPaths(input: string | undefined): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const raw of (input ?? '').split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('!')) exclude.push(line.slice(1));
    else include.push(line);
  }
  return { include, exclude };
}

// Expand one path, which may contain * and **, against the workspace. The
// glob dialect is the one workflow filters use, so there is one answer in the
// codebase to what a pattern means.
function expandPattern(rootDir: string, pattern: string): string[] {
  const normalized = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  const absolute = path.isAbsolute(normalized);
  const full = absolute ? normalized : path.join(rootDir, normalized);
  if (!/[*?[]/.test(normalized)) {
    return fs.existsSync(full) ? [full] : [];
  }
  // Start from the deepest directory the pattern names literally. Walking
  // from the filesystem root instead would be both slow and wrong.
  const segments = full.split('/');
  const firstGlob = segments.findIndex((s) => /[*?[]/.test(s));
  const start = segments.slice(0, firstGlob).join('/') || '/';
  const rx = filterPatternToRegExp(absolute ? full : normalized);
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = path.join(dir, e.name);
      const candidate = absolute ? child : path.relative(rootDir, child);
      if (rx.test(candidate)) out.push(child);
      if (e.isDirectory()) walk(child);
    }
  };
  walk(start);
  return out;
}

// Every file the pattern set selects, with the directory their paths are
// relative to. GitHub uses the least common ancestor of the matched paths as
// that root, so `path: dist` uploads dist's contents rather than a dist/
// prefix; this reproduces that.
function collectArtifactFiles(
  ctx: StepExecContext,
  input: string | undefined
): { root: string; files: string[] } {
  const workspace = ctx.hostPaths.workspace;
  const { include, exclude } = splitPaths(input);
  // A path in a workflow or an action is written as the step sees it inside
  // the container, so it is translated before touching the host filesystem.
  const onHost = (p: string): string | null => (path.isAbsolute(p) ? ctx.hostPath(p) : p);
  const matched = new Set<string>();
  for (const p of include) {
    const mapped = onHost(p);
    if (mapped === null) {
      ctx.log(`WARNING: ${p} is not inside the workspace or the runner temp directory; ignoring it`);
      continue;
    }
    for (const m of expandPattern(workspace, mapped)) matched.add(m);
  }
  const excluded = new Set<string>();
  for (const p of exclude) {
    const mapped = onHost(p);
    if (mapped === null) continue;
    for (const m of expandPattern(workspace, mapped)) excluded.add(m);
  }
  const files: string[] = [];
  const addFile = (p: string) => {
    if (excluded.has(p)) return;
    if ([...excluded].some((e) => p.startsWith(e + path.sep))) return;
    files.push(p);
  };
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else addFile(full);
    }
  };
  for (const m of matched) {
    try {
      if (fs.statSync(m).isDirectory()) walk(m);
      else addFile(m);
    } catch {
      // vanished; skip
    }
  }
  if (files.length === 0) return { root: workspace, files: [] };
  let root = path.dirname(files[0]);
  for (const f of files.slice(1)) {
    const dir = path.dirname(f);
    while (root !== dir && !dir.startsWith(root + path.sep)) {
      const parent = path.dirname(root);
      if (parent === root) break;
      root = parent;
    }
  }
  return { root, files };
}

function tar(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('tar', args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim()));
      else resolve(stdout.toString());
    });
  });
}

function artifactUrl(ctx: StepExecContext, name?: string): string {
  const a = ctx.spec.address;
  const base = `${ctx.serverUrl}/api/runner/jobs/${encodeURIComponent(a.collection)}/${encodeURIComponent(
    a.repo
  )}/${a.run}/${encodeURIComponent(a.job)}/artifacts`;
  return name === undefined ? base : `${base}/${encodeURIComponent(name)}`;
}

const uploadArtifact: Override = {
  name: 'upload-artifact',
  async run({ ctx, inputs }) {
    const name = (inputs.name ?? 'artifact').trim() || 'artifact';
    if (!isValidArtifactName(name)) {
      ctx.log(`artifact name "${name}" is not usable as a file name`);
      return { ok: false };
    }
    const { root, files } = collectArtifactFiles(ctx, inputs.path);
    if (files.length === 0) {
      const behavior = (inputs['if-no-files-found'] ?? 'warn').trim().toLowerCase();
      const message = `no files matched ${JSON.stringify((inputs.path ?? '').trim())}`;
      if (behavior === 'error') {
        ctx.log(`ERROR: ${message}`);
        return { ok: false };
      }
      if (behavior !== 'ignore') ctx.log(`WARNING: ${message}`);
      return { ok: true, outputs: { 'artifact-id': '', 'artifact-url': '' } };
    }
    const listFile = path.join(ctx.hostPaths.temp, `artifact-${name}.list`);
    fs.writeFileSync(listFile, files.map((f) => path.relative(root, f)).join('\n') + '\n');
    const tarFile = path.join(ctx.hostPaths.temp, `artifact-${name}.tar`);
    try {
      await tar(['-cf', tarFile, '-C', root, '--files-from', listFile]);
      const size = fs.statSync(tarFile).size;
      ctx.log(`Uploading artifact ${name} (${files.length} file${files.length === 1 ? '' : 's'}, ${size} bytes)`);
      // Streamed rather than read into memory: an artifact may be hundreds of
      // megabytes, and the runner is somebody's laptop.
      const res = await fetch(artifactUrl(ctx, name), {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${ctx.runnerToken}`,
          'x-hubbit-lease': ctx.spec.lease,
          'content-type': 'application/x-tar',
          'content-length': String(size),
        },
        body: Readable.toWeb(fs.createReadStream(tarFile)) as ReadableStream,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        ctx.log(`uploading the artifact failed: ${err.error ?? res.status}`);
        return { ok: false };
      }
      return {
        ok: true,
        outputs: { 'artifact-id': name, 'artifact-url': artifactUrl(ctx, name) },
      };
    } catch (e) {
      ctx.log(`uploading the artifact failed: ${e instanceof Error ? e.message : e}`);
      return { ok: false };
    } finally {
      fs.rmSync(listFile, { force: true });
      fs.rmSync(tarFile, { force: true });
    }
  },
};

const downloadArtifact: Override = {
  name: 'download-artifact',
  async run({ ctx, inputs }) {
    const name = (inputs.name ?? '').trim();
    const target = (inputs.path ?? '').trim();
    const mapped = target === '' ? ctx.hostPaths.workspace : ctx.hostPath(target);
    if (mapped === null) {
      ctx.log(`path: ${target} is not inside the workspace or the runner temp directory`);
      return { ok: false };
    }
    const dest = path.resolve(mapped);
    const wsReal = path.resolve(ctx.hostPaths.workspace);
    const tmpReal = path.resolve(ctx.hostPaths.temp);
    const inside = (base: string) => dest === base || dest.startsWith(base + path.sep);
    if (!inside(wsReal) && !inside(tmpReal)) {
      ctx.log(`path: ${target} resolves outside the workspace`);
      return { ok: false };
    }
    const headers = { authorization: `Bearer ${ctx.runnerToken}`, 'x-hubbit-lease': ctx.spec.lease };

    let names: string[];
    if (name !== '') {
      names = [name];
    } else {
      const res = await fetch(artifactUrl(ctx), { headers });
      if (!res.ok) {
        ctx.log(`could not list the run's artifacts: ${res.status}`);
        return { ok: false };
      }
      const body = (await res.json()) as { artifacts?: { name: string }[] };
      names = (body.artifacts ?? []).map((a) => a.name);
      if (names.length === 0) {
        ctx.log('this run has no artifacts to download');
        return { ok: true };
      }
    }

    for (const one of names) {
      const res = await fetch(artifactUrl(ctx, one), { headers });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        ctx.log(`could not download artifact ${one}: ${err.error ?? res.status}`);
        return { ok: false };
      }
      // With no name given, each artifact lands in its own subdirectory, as
      // download-artifact does.
      const into = name === '' ? path.join(dest, one) : dest;
      fs.mkdirSync(into, { recursive: true });
      const tmp = path.join(ctx.hostPaths.temp, `download-${one}.tar`);
      if (res.body) {
        await new Promise<void>((resolve, reject) => {
          const out = fs.createWriteStream(tmp);
          out.on('error', reject);
          out.on('finish', () => resolve());
          Readable.fromWeb(res.body as never).on('error', reject).pipe(out);
        });
      } else {
        fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      }
      try {
        await tar(['-xf', tmp, '-C', into, '--no-same-owner']);
        ctx.log(`Downloaded artifact ${one} into ${path.relative(wsReal, into) || '.'}`);
      } catch (e) {
        ctx.log(`could not unpack artifact ${one}: ${e instanceof Error ? e.message : e}`);
        return { ok: false };
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    return { ok: true, outputs: { 'download-path': dest } };
  },
};

// ---- the site ----
//
// These two keep GitHub's spelling in their `uses:` keys and in the
// `github-pages` artifact name, because those are somebody else's interface.
// hubbit's own noun for what they publish is a site.

function siteUrls(ctx: StepExecContext): { origin: string; basePath: string; baseUrl: string; host: string } {
  const a = ctx.spec.address;
  const origin = ctx.serverUrl.replace(/\/+$/, '');
  const basePath = `/${a.collection}/${a.repo}/site`;
  let host = origin;
  try {
    host = new URL(origin).host;
  } catch {
    // keep the whole string if it is not a URL
  }
  return { origin, basePath, baseUrl: `${origin}${basePath}`, host };
}

// configure-pages exists to tell the rest of a workflow where the site will
// live. The real one asks GitHub's API; this answers from the vault's own
// URL. Note the shape differs from GitHub's: a hubbit site is served at
// /<collection>/<repo>/site/ rather than at /<repo>/, so a generator that
// computes its own base path instead of reading base_path will be wrong, and
// needs the path passed to it explicitly.
const configurePages: Override = {
  name: 'configure-pages',
  async run({ ctx }) {
    const u = siteUrls(ctx);
    ctx.log(`This site will be served at ${u.baseUrl}/`);
    ctx.rt.env.HUBBIT_SITE_BASE_PATH = u.basePath;
    // The former name of the same variable, kept so workflows written against
    // it keep working; remove it once they have moved.
    ctx.rt.env.HUBBIT_PAGES_BASE_PATH = u.basePath;
    return {
      ok: true,
      outputs: { base_url: u.baseUrl, origin: u.origin, host: u.host, base_path: u.basePath },
    };
  },
};

// deploy-pages publishes the artifact that upload-pages-artifact produced.
// The server unpacks it, since the site directory is vault state.
const deployPages: Override = {
  name: 'deploy-pages',
  async run({ ctx, inputs }) {
    const artifact = (inputs.artifact_name ?? 'github-pages').trim() || 'github-pages';
    const a = ctx.spec.address;
    const url = `${ctx.serverUrl}/api/runner/jobs/${encodeURIComponent(a.collection)}/${encodeURIComponent(
      a.repo
    )}/${a.run}/${encodeURIComponent(a.job)}/site`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ctx.runnerToken}`,
        'x-hubbit-lease': ctx.spec.lease,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ artifact }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; files?: number; url?: string };
    if (!res.ok) {
      ctx.log(`deploying the site failed: ${body.error ?? res.status}`);
      return { ok: false };
    }
    ctx.log(`Deployed ${body.files} file${body.files === 1 ? '' : 's'} to ${body.url}`);
    return { ok: true, outputs: { page_url: body.url ?? siteUrls(ctx).baseUrl + '/' } };
  },
};

// ---- the registry ----

// Matched on owner/repo, ignoring the ref, since the point is to substitute
// every version of these actions.
const OVERRIDES: Record<string, Override> = {
  'actions/checkout': checkout,
  'actions/upload-artifact': uploadArtifact,
  'actions/download-artifact': downloadArtifact,
  'actions/configure-pages': configurePages,
  'actions/deploy-pages': deployPages,
};

export function findOverride(ref: ActionRef): Override | null {
  if (ref.kind !== 'repo') return null;
  const key = `${ref.owner}/${ref.repo}${ref.subpath ? '/' + ref.subpath : ''}`.toLowerCase();
  return OVERRIDES[key] ?? null;
}

export function registerOverride(key: string, override: Override): void {
  OVERRIDES[key.toLowerCase()] = override;
}

export { boolInput };

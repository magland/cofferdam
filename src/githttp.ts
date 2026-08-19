import { Express, Request, Response } from 'express';
import { spawn } from 'child_process';
import * as zlib from 'zlib';
import { CiEngine } from './ci/engine';
import { GitRepo, execGit } from './git';
import { createRepo } from './ops';
import { displayName, findRepo, isValidName, reservedRepoSuffix } from './scan';
import { AuthLimiter, BUSY_RETRY_SECONDS, Gates } from './limit';
import { AuthResult, authenticate, canPush, loadVault } from './vault';
import { ah } from './web';

// git smart HTTP. Anonymous fetch (upload-pack) stays open; push
// (receive-pack) requires a token presented over HTTP Basic auth. Session
// cookies are never consulted here: git and the browser present distinct
// credentials by design.

function pkt(s: string): string {
  return (s.length + 4).toString(16).padStart(4, '0') + s;
}

function gitEnv(req: Request): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const proto = req.get('git-protocol');
  if (proto) env.GIT_PROTOCOL = proto;
  return env;
}

export function parseBasicAuth(req: Request): { username: string; password: string } | null {
  const h = req.get('authorization');
  if (!h || !/^basic /i.test(h)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const i = decoded.indexOf(':');
  if (i === -1) return null;
  return { username: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

// The push-authorization decision, shared with the LFS endpoints. The caller
// renders a denial in its own content type (plain text for git, LFS JSON for
// the batch API), so this returns a result rather than writing the response.
export type PushAuthCheck =
  | { ok: true; auth: AuthResult }
  | { ok: false; status: 401 | 403 | 429 | 500; message: string; retryAfter?: number };

export function checkPushAuth(
  root: string,
  limiter: AuthLimiter,
  req: Request,
  collection: string,
  repoName: string
): PushAuthCheck {
  const state = loadVault(root);
  if (state.status === 'missing') {
    return {
      ok: false,
      status: 401,
      message: 'push denied: no vault.json in this vault; restart the server to initialize one',
    };
  }
  if (state.status === 'error') {
    return { ok: false, status: 500, message: `push denied: vault.json could not be read: ${state.message}` };
  }
  // git's first request to a push endpoint carries no Basic auth by protocol and
  // always will, so a missing credential is not a failed attempt and is not
  // charged.
  const creds = parseBasicAuth(req);
  if (!creds) {
    return { ok: false, status: 401, message: 'authentication required to push' };
  }
  const allowed = limiter.allow(req, creds.username);
  if (!allowed.ok) {
    return {
      ok: false,
      status: 429,
      message: 'too many failed authentication attempts; try again later',
      retryAfter: allowed.retryAfter,
    };
  }
  const auth = authenticate(state.vault, creds.username, creds.password);
  if (!auth) {
    limiter.fail(req, creds.username);
    return { ok: false, status: 401, message: 'invalid username or token' };
  }
  if (!canPush(auth, collection, repoName)) {
    return {
      ok: false,
      status: 403,
      message: `user ${creds.username} is not allowed to push to ${collection}/${repoName}`,
    };
  }
  return { ok: true, auth };
}

// The refs a push may have changed, read before and after receive-pack. A
// snapshot diff rather than a post-receive hook script: it needs no hook
// installed in each repository, so it works for repositories imported by
// `git clone --bare` as well as ones this server created.
async function refSnapshot(repo: GitRepo): Promise<Map<string, string>> {
  const snap = new Map<string, string>();
  try {
    const out = (
      await execGit(repo.dir, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads', 'refs/tags'])
    ).toString('utf8');
    for (const line of out.split('\n')) {
      if (!line) continue;
      const [name, sha] = line.split('\0');
      if (name && sha) snap.set(name, sha);
    }
  } catch {
    // an unreadable ref list yields no events rather than failing the push
  }
  return snap;
}

const ZERO = '0'.repeat(40);

export function registerGitHttp(app: Express, root: string, gates: Gates, authLimiter: AuthLimiter, engine?: CiEngine): void {
  // git shows the body of a 503 on the RPC to the person who ran the command, so
  // it is one sentence. Not 429: this is server capacity rather than a client
  // quota, and git's own error surface reads better with 503.
  function denyBusy(res: Response) {
    res.status(503).setHeader('Retry-After', String(BUSY_RETRY_SECONDS));
    res.type('text/plain').send('the server is busy with other git work; please try again in a moment\n');
  }

  function denyPush(res: Response, status: number, message: string, retryAfter?: number) {
    if (status === 401) res.setHeader('WWW-Authenticate', 'Basic realm="cofferdam"');
    if (retryAfter !== undefined) res.setHeader('Retry-After', String(retryAfter));
    res.status(status).type('text/plain').send(message + '\n');
  }

  function requirePushAuth(req: Request, res: Response, collection: string, repoName: string): AuthResult | null {
    const check = checkPushAuth(root, authLimiter, req, collection, repoName);
    if (!check.ok) {
      denyPush(res, check.status, check.message, check.retryAfter);
      return null;
    }
    return check.auth;
  }

  async function ensureHead(repo: GitRepo): Promise<void> {
    const branches = await repo.listRefs('heads');
    if (branches.length === 0) return;
    try {
      const head = (await execGit(repo.dir, ['symbolic-ref', '--short', 'HEAD'])).toString('utf8').trim();
      if (branches.some((b) => b.name === head)) return;
    } catch {
      // detached or unreadable HEAD; repoint below
    }
    const names = branches.map((b) => b.name).sort();
    const pick = names.includes('main') ? 'main' : names.includes('master') ? 'master' : names[0];
    await execGit(repo.dir, ['symbolic-ref', 'HEAD', `refs/heads/${pick}`]);
  }

  // Both of these spawn git, and both hold their gate slot until the child is
  // gone rather than until the handler returns: runService pipes and returns
  // immediately, so releasing on return would bound nothing at all. The gate's
  // release is idempotent, which is what lets it be wired to both the child
  // closing and the response closing; an aborted clone is ordinary traffic, and
  // a gate that leaked a slot per abort would stop answering after four of them.
  function gateFor(service: 'git-upload-pack' | 'git-receive-pack') {
    return service === 'git-upload-pack' ? gates.clone : gates.push;
  }

  async function advertise(
    req: Request,
    res: Response,
    service: 'git-upload-pack' | 'git-receive-pack',
    dir: string
  ): Promise<void> {
    const release = await gateFor(service).enter();
    if (!release) {
      denyBusy(res);
      return;
    }
    res.on('close', release);
    res.setHeader('Content-Type', `application/x-${service}-advertisement`);
    res.setHeader('Cache-Control', 'no-cache');
    res.write(pkt(`# service=${service}\n`) + '0000');
    const child = spawn('git', [service.slice(4), '--stateless-rpc', '--advertise-refs', dir], {
      env: gitEnv(req),
    });
    child.on('close', release);
    child.stdout.pipe(res);
    child.on('error', () => {
      release();
      res.end();
    });
  }

  async function runService(
    req: Request,
    res: Response,
    service: 'git-upload-pack' | 'git-receive-pack',
    dir: string,
    onClose?: (code: number | null) => void
  ): Promise<void> {
    const release = await gateFor(service).enter();
    if (!release) {
      denyBusy(res);
      return;
    }
    res.on('close', release);
    res.setHeader('Content-Type', `application/x-${service}-result`);
    res.setHeader('Cache-Control', 'no-cache');
    const child = spawn('git', [service.slice(4), '--stateless-rpc', dir], { env: gitEnv(req) });
    let body: NodeJS.ReadableStream = req;
    if (req.headers['content-encoding'] === 'gzip') {
      body = req.pipe(zlib.createGunzip());
    }
    body.pipe(child.stdin);
    child.stdout.pipe(res);
    child.on('error', () => {
      release();
      res.status(500).end();
    });
    child.on('close', (code) => {
      release();
      if (onClose) onClose(code);
    });
  }

  app.get(
    '/:collection/:repo/info/refs',
    ah(async (req, res) => {
      const service = req.query.service;
      const collectionName = req.params.collection;
      const repoName = displayName(req.params.repo);
      if (service === 'git-upload-pack') {
        const repo = findRepo(root, collectionName, req.params.repo);
        if (!repo) {
          res.status(404).type('text/plain').send('repository not found\n');
          return;
        }
        await advertise(req, res, 'git-upload-pack', repo.dir);
        return;
      }
      if (service === 'git-receive-pack') {
        if (!isValidName(collectionName) || !isValidName(repoName)) {
          res.status(404).type('text/plain').send('invalid repository name\n');
          return;
        }
        const auth = requirePushAuth(req, res, collectionName, repoName);
        if (!auth) return;
        let repo = findRepo(root, collectionName, req.params.repo);
        if (!repo) {
          // Push-to-create, so the name has to survive the same check the web
          // form applies. An existing repository is served whatever it is
          // called; only a new one is refused.
          const reserved = reservedRepoSuffix(repoName);
          if (reserved) {
            res
              .status(400)
              .type('text/plain')
              .send(`repository names may not end in ${reserved}, which is reserved for the directories a repository keeps beside it\n`);
            return;
          }
          repo = await createRepo(root, collectionName, repoName);
        }
        await advertise(req, res, 'git-receive-pack', repo.dir);
        return;
      }
      res.status(403).type('text/plain').send('unsupported service\n');
    })
  );

  app.post(
    '/:collection/:repo/git-upload-pack',
    ah(async (req, res) => {
      const repo = findRepo(root, req.params.collection, req.params.repo);
      if (!repo) {
        res.status(404).type('text/plain').send('repository not found\n');
        return;
      }
      // The gate is entered after findRepo and before anything expensive.
      await runService(req, res, 'git-upload-pack', repo.dir);
    })
  );

  app.post(
    '/:collection/:repo/git-receive-pack',
    ah(async (req, res) => {
      const collectionName = req.params.collection;
      const repoName = displayName(req.params.repo);
      if (!isValidName(collectionName) || !isValidName(repoName)) {
        res.status(404).type('text/plain').send('invalid repository name\n');
        return;
      }
      const auth = requirePushAuth(req, res, collectionName, repoName);
      if (!auth) return;
      let repo = findRepo(root, collectionName, req.params.repo);
      if (!repo) {
        const reserved = reservedRepoSuffix(repoName);
        if (reserved) {
          res
            .status(400)
            .type('text/plain')
            .send(`repository names may not end in ${reserved}, which is reserved for the directories a repository keeps beside it\n`);
          return;
        }
        repo = await createRepo(root, collectionName, repoName);
      }
      const target = repo;
      const actor = auth.username;
      const before = await refSnapshot(target);
      // The push gate is entered only now, after requirePushAuth has succeeded:
      // an unauthenticated request must not be able to occupy a slot that
      // authorized users depend on.
      await runService(req, res, 'git-receive-pack', repo.dir, (code) => {
        if (code !== 0) return;
        ensureHead(target)
          .then(() => (engine ? firePushEvents(engine, target, before, actor) : undefined))
          .catch((e) => console.error(`post-receive handling failed: ${e instanceof Error ? e.message : e}`));
      });
    })
  );
}

// Turn a before/after ref snapshot into push events for the CI engine. Ref
// deletions are reported (with an all-zero "after") and ignored downstream;
// a workflow file that fails to parse still produces a visible failed run,
// which is why nothing here filters on content.
async function firePushEvents(
  engine: CiEngine,
  repo: GitRepo,
  before: Map<string, string>,
  actor: string
): Promise<void> {
  const after = await refSnapshot(repo);
  for (const [ref, sha] of after) {
    if (before.get(ref) === sha) continue;
    await engine.handlePush(repo, { ref, before: before.get(ref) ?? ZERO, after: sha, actor });
  }
}

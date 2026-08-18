import { Express, Request, Response } from 'express';
import { spawn } from 'child_process';
import * as zlib from 'zlib';
import { GitRepo, execGit } from './git';
import { createRepo } from './ops';
import { displayName, findRepo, isValidName } from './scan';
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
  | { ok: false; status: 401 | 403 | 500; message: string };

export function checkPushAuth(
  root: string,
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
  const creds = parseBasicAuth(req);
  if (!creds) {
    return { ok: false, status: 401, message: 'authentication required to push' };
  }
  const auth = authenticate(state.vault, creds.username, creds.password);
  if (!auth) {
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

export function registerGitHttp(app: Express, root: string): void {
  function denyPush(res: Response, status: number, message: string) {
    if (status === 401) res.setHeader('WWW-Authenticate', 'Basic realm="doqpod"');
    res.status(status).type('text/plain').send(message + '\n');
  }

  function requirePushAuth(req: Request, res: Response, collection: string, repoName: string): AuthResult | null {
    const check = checkPushAuth(root, req, collection, repoName);
    if (!check.ok) {
      denyPush(res, check.status, check.message);
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

  function advertise(req: Request, res: Response, service: 'git-upload-pack' | 'git-receive-pack', dir: string) {
    res.setHeader('Content-Type', `application/x-${service}-advertisement`);
    res.setHeader('Cache-Control', 'no-cache');
    res.write(pkt(`# service=${service}\n`) + '0000');
    const child = spawn('git', [service.slice(4), '--stateless-rpc', '--advertise-refs', dir], {
      env: gitEnv(req),
    });
    child.stdout.pipe(res);
    child.on('error', () => res.end());
  }

  function runService(
    req: Request,
    res: Response,
    service: 'git-upload-pack' | 'git-receive-pack',
    dir: string,
    onClose?: (code: number | null) => void
  ) {
    res.setHeader('Content-Type', `application/x-${service}-result`);
    res.setHeader('Cache-Control', 'no-cache');
    const child = spawn('git', [service.slice(4), '--stateless-rpc', dir], { env: gitEnv(req) });
    let body: NodeJS.ReadableStream = req;
    if (req.headers['content-encoding'] === 'gzip') {
      body = req.pipe(zlib.createGunzip());
    }
    body.pipe(child.stdin);
    child.stdout.pipe(res);
    child.on('error', () => res.status(500).end());
    if (onClose) child.on('close', onClose);
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
        advertise(req, res, 'git-upload-pack', repo.dir);
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
        if (!repo) repo = await createRepo(root, collectionName, repoName);
        advertise(req, res, 'git-receive-pack', repo.dir);
        return;
      }
      res.status(403).type('text/plain').send('unsupported service\n');
    })
  );

  app.post('/:collection/:repo/git-upload-pack', (req, res) => {
    const repo = findRepo(root, req.params.collection, req.params.repo);
    if (!repo) {
      res.status(404).type('text/plain').send('repository not found\n');
      return;
    }
    runService(req, res, 'git-upload-pack', repo.dir);
  });

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
      if (!repo) repo = await createRepo(root, collectionName, repoName);
      const target = repo;
      runService(req, res, 'git-receive-pack', repo.dir, (code) => {
        if (code === 0) ensureHead(target).catch(() => {});
      });
    })
  );
}

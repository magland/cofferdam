import { AwsClient } from 'aws4fetch';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { containedIn } from './ops';
import { repoPath } from './layout';
import { isValidName } from './scan';
import { getSecret } from './session';

// Storage for Git LFS objects. Two backends behind one interface: "s3" issues
// presigned URLs against any S3-compatible bucket, so large-file bytes never
// pass through this process; "local" stores objects inside the vault and
// issues HMAC-signed URLs pointing back at cofferdam's own transfer routes, so
// LFS works with no credentials (dev, smoke test, laptop vaults). The choice
// is made from the environment at startup and never recorded in the vault.
//
// Objects are sharded the way git-lfs itself shards them on the client:
//   <collection>/<repo>.lfs/<oid[0:2]>/<oid[2:4]>/<oid>
// That is a bucket key as written; on the volume the same shards sit under
// the repository, at <vault>/collections/<collection>/repos/<repo>.lfs/. The
// key kept its shape when the vault's layout changed, since a bucket is not
// the vault's directory and rewriting every key would mean moving objects
// nobody asked to move.

const EXPIRES_SECONDS = 3600;
const DEFAULT_MAX_SIZE = 5_000_000_000; // below the S3 single-PUT ceiling of 5 GB

export interface LfsObjectInfo {
  size: number;
}

export interface SignedAction {
  href: string;
  header: Record<string, string>;
  expiresIn: number;
}

export interface LfsStore {
  readonly kind: 'local' | 's3';
  head(collection: string, repo: string, oid: string): Promise<LfsObjectInfo | null>;
  signDownload(
    collection: string,
    repo: string,
    oid: string,
    opts?: { filename?: string }
  ): Promise<SignedAction>;
  signUpload(collection: string, repo: string, oid: string, size: number): Promise<SignedAction>;
  deleteRepo(collection: string, repo: string): Promise<void>;
  /** Move a repository's objects when the repository itself is renamed or moved. */
  renameRepo(collection: string, repo: string, toCollection: string, toRepo: string): Promise<void>;
}

export interface LfsContext {
  store: LfsStore;
  maxSize: number;
  // One line for the startup log; names the backend but never the credentials.
  label: string;
  /**
   * Whether object bytes leave through the store rather than through this
   * server. A bucket hands the client a presigned URL, so those downloads never
   * touch the process and are not in anything it counts; the local store streams
   * them itself. Egress accounting says so on the page rather than quietly
   * under-reporting, which is the only reason this is here.
   */
  offloaded: boolean;
}

export class LfsConfigError extends Error {}

// Content-Disposition filenames must stay inside printable ASCII with no
// quote or backslash, or the header becomes malformed.
function sanitizeFilename(name: string): string {
  return name.replace(/[^\x20-\x7e]|["\\]/g, '_');
}

// The route layer validates names with isValidName and object ids against
// /^[0-9a-f]{64}$/ before anything reaches this module. Re-checking here means
// a future caller that forgets cannot turn a name or an id into a path
// outside the vault, or into a key outside the repository's own prefix.
function checkTarget(collection: string, repo: string, oid: string): void {
  if (!isValidName(collection) || !isValidName(repo)) {
    throw new Error(`invalid collection or repository name for LFS storage: ${collection}/${repo}`);
  }
  if (!/^[0-9a-f]{64}$/.test(oid)) {
    throw new Error('invalid LFS object id');
  }
}

function checkRepoTarget(collection: string, repo: string): void {
  if (!isValidName(collection) || !isValidName(repo)) {
    throw new Error(`invalid collection or repository name for LFS storage: ${collection}/${repo}`);
  }
}

export function lfsKey(collection: string, repo: string, oid: string): string {
  checkTarget(collection, repo, oid);
  return `${collection}/${repo}.lfs/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`;
}

// ---- the local backend ----

export function localLfsDir(root: string, collection: string, repo: string): string {
  checkRepoTarget(collection, repo);
  return repoPath(root, collection, `${repo}.lfs`);
}

export function localObjectPath(root: string, collection: string, repo: string, oid: string): string {
  checkTarget(collection, repo, oid);
  return path.join(localLfsDir(root, collection, repo), oid.slice(0, 2), oid.slice(2, 4), oid);
}

// HMAC over a NUL-delimited payload with an explicit domain prefix. The same
// secret signs session cookies; the "lfs" prefix guarantees an LFS href can
// never be replayed as a session token. Every value that appears in the URL
// is inside the signed payload, so none of them can be altered.
export function signTransfer(
  root: string,
  op: 'download' | 'upload',
  collection: string,
  repo: string,
  oid: string,
  exp: number,
  disp: string
): string {
  const payload = ['lfs', op, collection, repo, oid, String(exp), disp].join('\0');
  return crypto.createHmac('sha256', getSecret(root)).update(payload).digest('base64url');
}

export function verifyTransfer(
  root: string,
  op: 'download' | 'upload',
  collection: string,
  repo: string,
  oid: string,
  exp: number,
  disp: string,
  sig: string
): boolean {
  const a = Buffer.from(sig);
  const b = Buffer.from(signTransfer(root, op, collection, repo, oid, exp, disp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class LocalLfsStore implements LfsStore {
  readonly kind = 'local' as const;

  constructor(private root: string) {}

  async head(collection: string, repo: string, oid: string): Promise<LfsObjectInfo | null> {
    // The path is built outside the try so a rejected name or object id
    // propagates as an error; only a missing file becomes null.
    const file = localObjectPath(this.root, collection, repo, oid);
    try {
      const st = fs.statSync(file);
      return st.isFile() ? { size: st.size } : null;
    } catch {
      return null;
    }
  }

  // The hrefs are relative; the route layer prefixes the request's own base
  // URL, since the store does not know what host it is being served under.
  private sign(op: 'download' | 'upload', collection: string, repo: string, oid: string, disp: string): SignedAction {
    const exp = Math.floor(Date.now() / 1000) + EXPIRES_SECONDS;
    const sig = signTransfer(this.root, op, collection, repo, oid, exp, disp);
    const q = new URLSearchParams({ exp: String(exp), sig });
    if (disp !== '') q.set('disp', disp);
    const href = `/${encodeURIComponent(collection)}/${encodeURIComponent(repo)}/info/lfs/objects/${oid}?${q.toString()}`;
    return { href, header: {}, expiresIn: EXPIRES_SECONDS };
  }

  async signDownload(
    collection: string,
    repo: string,
    oid: string,
    opts?: { filename?: string }
  ): Promise<SignedAction> {
    const disp = opts?.filename ? sanitizeFilename(path.basename(opts.filename)) : '';
    return this.sign('download', collection, repo, oid, disp);
  }

  async signUpload(collection: string, repo: string, oid: string, _size: number): Promise<SignedAction> {
    return this.sign('upload', collection, repo, oid, '');
  }

  async deleteRepo(collection: string, repo: string): Promise<void> {
    const dir = localLfsDir(this.root, collection, repo);
    let rootReal: string;
    try {
      rootReal = fs.realpathSync(this.root);
    } catch {
      return;
    }
    // containedIn resolves the real path, so a missing directory (already
    // deleted, or never created) is a no-op rather than an error.
    if (!containedIn(rootReal, dir)) return;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // The objects are a directory beside the repository, so moving them is
  // moving that directory. A repository with no LFS objects has none.
  async renameRepo(collection: string, repo: string, toCollection: string, toRepo: string): Promise<void> {
    const from = localLfsDir(this.root, collection, repo);
    const to = localLfsDir(this.root, toCollection, toRepo);
    let rootReal: string;
    try {
      rootReal = fs.realpathSync(this.root);
    } catch {
      return;
    }
    if (!containedIn(rootReal, from)) return;
    if (fs.existsSync(to)) throw new Error(`LFS objects already exist at ${toCollection}/${toRepo}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  }
}

// ---- the s3 backend ----

interface S3Options {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  prefix: string;
  addressing: 'path' | 'vhost';
}

// SigV4 signs a canonical query string in which a space is `%20`, but the URL
// aws4fetch hands back is serialized by URLSearchParams, which writes a space
// as `+`. The two disagree for any parameter containing a space, which for us
// is every `response-content-disposition` (the `; ` alone contains one), and
// the bucket then answers 403 SignatureDoesNotMatch. Rewriting `+` to `%20`
// in the query is unambiguous: URLSearchParams emits a literal plus as `%2B`,
// so no `+` here ever stands for itself.
function fixQueryEncoding(href: string): string {
  const i = href.indexOf('?');
  if (i === -1) return href;
  return href.slice(0, i) + href.slice(i).replace(/\+/g, '%20');
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&amp;/g, '&');
}

class S3LfsStore implements LfsStore {
  readonly kind = 's3' as const;
  readonly bucket: string;
  readonly endpoint: string;
  private aws: AwsClient;
  private baseUrl: string;
  private prefix: string;

  constructor(opts: S3Options) {
    this.bucket = opts.bucket;
    this.endpoint = opts.endpoint;
    this.prefix = opts.prefix;
    this.aws = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      region: opts.region,
      service: 's3',
    });
    let url: URL;
    try {
      url = new URL(opts.endpoint);
    } catch {
      throw new LfsConfigError(`the LFS endpoint is not a valid URL: ${opts.endpoint}`);
    }
    if (opts.addressing === 'vhost') {
      url.host = `${opts.bucket}.${url.host}`;
      this.baseUrl = url.origin;
    } else {
      this.baseUrl = `${url.origin}/${opts.bucket}`;
    }
  }

  private key(collection: string, repo: string, oid: string): string {
    return this.prefix + lfsKey(collection, repo, oid);
  }

  private objectUrl(collection: string, repo: string, oid: string): URL {
    return new URL(`${this.baseUrl}/${this.key(collection, repo, oid)}`);
  }

  async head(collection: string, repo: string, oid: string): Promise<LfsObjectInfo | null> {
    const res = await this.aws.fetch(this.objectUrl(collection, repo, oid).toString(), { method: 'HEAD' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`LFS bucket HEAD returned ${res.status}`);
    const len = res.headers.get('content-length');
    return { size: len ? parseInt(len, 10) : 0 };
  }

  async signDownload(
    collection: string,
    repo: string,
    oid: string,
    opts?: { filename?: string }
  ): Promise<SignedAction> {
    const url = this.objectUrl(collection, repo, oid);
    url.searchParams.set('X-Amz-Expires', String(EXPIRES_SECONDS));
    if (opts?.filename) {
      url.searchParams.set(
        'response-content-disposition',
        `attachment; filename="${sanitizeFilename(path.basename(opts.filename))}"`
      );
    }
    const signed = await this.aws.sign(new Request(url.toString(), { method: 'GET' }), {
      aws: { signQuery: true },
    });
    return { href: fixQueryEncoding(signed.url), header: {}, expiresIn: EXPIRES_SECONDS };
  }

  // No Content-Type is signed: R2 requires the client to send a header
  // exactly matching any content type in the signature, and git-lfs sends its
  // own, so signing one is a reliable source of 403s at upload time.
  async signUpload(collection: string, repo: string, oid: string, _size: number): Promise<SignedAction> {
    const url = this.objectUrl(collection, repo, oid);
    url.searchParams.set('X-Amz-Expires', String(EXPIRES_SECONDS));
    const signed = await this.aws.sign(new Request(url.toString(), { method: 'PUT' }), {
      aws: { signQuery: true },
    });
    return { href: fixQueryEncoding(signed.url), header: {}, expiresIn: EXPIRES_SECONDS };
  }

  // List the repository's key prefix and delete in batches of up to 1000,
  // following continuation tokens. Idempotent: deleting keys that are already
  // gone succeeds, and an empty listing does nothing.
  async deleteRepo(collection: string, repo: string): Promise<void> {
    // Validated before it becomes a delete prefix: an unchecked name here
    // would widen the prefix and delete other repositories' objects.
    checkRepoTarget(collection, repo);
    for (const keys of await this.listKeys(`${this.prefix}${collection}/${repo}.lfs/`)) {
      await this.deleteKeys(keys);
    }
  }

  /**
   * Objects carry the repository in their key, so moving a repository means
   * copying every object to the new prefix and deleting the old ones. There
   * is no rename in S3; a server-side copy is the closest thing, and it never
   * moves bytes through this process.
   */
  async renameRepo(collection: string, repo: string, toCollection: string, toRepo: string): Promise<void> {
    checkRepoTarget(collection, repo);
    checkRepoTarget(toCollection, toRepo);
    const fromPrefix = `${this.prefix}${collection}/${repo}.lfs/`;
    const toPrefix = `${this.prefix}${toCollection}/${toRepo}.lfs/`;
    for (const keys of await this.listKeys(fromPrefix)) {
      for (const key of keys) {
        const target = toPrefix + key.slice(fromPrefix.length);
        const res = await this.aws.fetch(`${this.baseUrl}/${target}`, {
          method: 'PUT',
          headers: { 'x-amz-copy-source': `/${this.bucket}/${key}` },
        });
        if (!res.ok) throw new Error(`LFS bucket COPY returned ${res.status}`);
      }
      await this.deleteKeys(keys);
    }
  }

  /** Every key under a prefix, in the batches the listing returns them in. */
  private async listKeys(prefix: string): Promise<string[][]> {
    const batches: string[][] = [];
    let continuation: string | undefined;
    do {
      const listUrl = new URL(`${this.baseUrl}/`);
      listUrl.searchParams.set('list-type', '2');
      listUrl.searchParams.set('prefix', prefix);
      if (continuation) listUrl.searchParams.set('continuation-token', continuation);
      const res = await this.aws.fetch(listUrl.toString());
      if (!res.ok) throw new Error(`LFS bucket LIST returned ${res.status}`);
      const xml = await res.text();
      const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => decodeXml(m[1]));
      if (keys.length > 0) batches.push(keys);
      continuation = undefined;
      if (/<IsTruncated>true<\/IsTruncated>/.test(xml)) {
        const m = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
        // Stopping quietly here would leave the rest of the repository's
        // objects behind with nothing left to point at them, so raise it.
        if (!m) throw new Error('LFS bucket listing was truncated without a continuation token');
        continuation = decodeXml(m[1]);
      }
    } while (continuation);
    return batches;
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    const body =
      '<Delete><Quiet>true</Quiet>' +
      keys.map((k) => `<Object><Key>${escapeXml(k)}</Key></Object>`).join('') +
      '</Delete>';
    const url = new URL(`${this.baseUrl}/`);
    url.searchParams.set('delete', '');
    const res = await this.aws.fetch(url.toString(), {
      method: 'POST',
      headers: {
        // DeleteObjects requires Content-MD5 on AWS; harmless elsewhere.
        'Content-MD5': crypto.createHash('md5').update(body).digest('base64'),
        'Content-Type': 'application/xml',
      },
      body,
    });
    if (!res.ok) throw new Error(`LFS bucket DELETE returned ${res.status}`);
  }
}

// ---- backend selection ----

// Credentials come from the environment only; nothing about the choice is
// recorded in the vault, which stays portable between deployments. The
// BUCKET_NAME and AWS_* spellings are honored so a Fly deployment using
// Tigris works with the credentials Fly injects.
export function createLfsStore(root: string, env: NodeJS.ProcessEnv = process.env): LfsContext {
  let maxSize = DEFAULT_MAX_SIZE;
  if (env.COFFERDAM_LFS_MAX_SIZE !== undefined) {
    maxSize = parseInt(env.COFFERDAM_LFS_MAX_SIZE, 10);
    if (!Number.isSafeInteger(maxSize) || maxSize <= 0) {
      throw new LfsConfigError(`COFFERDAM_LFS_MAX_SIZE must be a positive integer, got: ${env.COFFERDAM_LFS_MAX_SIZE}`);
    }
  }
  const local = (): LfsContext => ({
    store: new LocalLfsStore(root),
    maxSize,
    label: 'local (objects stored inside the vault)',
    offloaded: false,
  });
  if (env.COFFERDAM_LFS === 'off') return local();

  const vars: [string, string | undefined][] = [
    ['COFFERDAM_LFS_BUCKET (or BUCKET_NAME)', env.COFFERDAM_LFS_BUCKET || env.BUCKET_NAME],
    ['COFFERDAM_LFS_ENDPOINT (or AWS_ENDPOINT_URL_S3)', env.COFFERDAM_LFS_ENDPOINT || env.AWS_ENDPOINT_URL_S3],
    ['AWS_ACCESS_KEY_ID', env.AWS_ACCESS_KEY_ID],
    ['AWS_SECRET_ACCESS_KEY', env.AWS_SECRET_ACCESS_KEY],
  ];
  const missing = vars.filter(([, v]) => !v).map(([name]) => name);
  if (missing.length === vars.length) return local();
  if (missing.length > 0) {
    // A partially configured deployment must not silently fall back to
    // storing large objects on the volume; that is the exact failure the
    // bucket backend exists to prevent.
    throw new LfsConfigError(
      `Git LFS bucket configuration is incomplete; missing: ${missing.join(', ')}. ` +
        `Set the missing variables, or set COFFERDAM_LFS=off to store LFS objects inside the vault.`
    );
  }
  const [bucket, endpoint] = [vars[0][1] as string, vars[1][1] as string];
  const addressing = env.COFFERDAM_LFS_ADDRESSING ?? 'path';
  if (addressing !== 'path' && addressing !== 'vhost') {
    throw new LfsConfigError(`COFFERDAM_LFS_ADDRESSING must be "path" or "vhost", got: ${addressing}`);
  }
  let prefix = env.COFFERDAM_LFS_PREFIX ?? '';
  if (prefix !== '') prefix = prefix.replace(/^\/+|\/+$/g, '') + '/';
  const store = new S3LfsStore({
    bucket,
    endpoint,
    accessKeyId: env.AWS_ACCESS_KEY_ID as string,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY as string,
    region: env.AWS_REGION || 'auto',
    prefix,
    addressing,
  });
  return { store, maxSize, label: `s3 (endpoint ${endpoint}, bucket ${bucket})`, offloaded: true };
}

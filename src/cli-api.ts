import { vaultTarget } from './credentials';
import { CliError, EXIT_AUTH, UnreachableError, exitCodeForStatus } from './cli/exit';

// The client side of the JSON API, shared by every CLI command that talks to a
// running vault. Failures are reported as CliError rather than by exiting here,
// so that the exit code is decided in one place and a caller in the middle of
// something (an import holding a temporary clone) still runs its cleanup.

export interface RemoteTarget {
  host: string;
  token: string;
}

/** The vault a command works against: --host/--token, then the environment, then the last login. */
export async function remoteTarget(args: { host?: string | null; token?: string | null }): Promise<RemoteTarget> {
  try {
    return await vaultTarget(args);
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e), EXIT_AUTH);
  }
}

export interface RawResponse {
  ok: boolean;
  status: number;
  contentType: string;
  body: string;
}

/**
 * One request, with the body left as text. `feorge api` prints it verbatim,
 * and the routes that answer with a patch, a log, or an archive are not JSON at
 * all.
 */
export async function request(
  target: RemoteTarget,
  method: string,
  pathname: string,
  opts: { body?: string; contentType?: string } = {}
): Promise<RawResponse> {
  let resp;
  try {
    resp = await fetch(`${target.host}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${target.token}`,
        ...(opts.body !== undefined ? { 'content-type': opts.contentType ?? 'application/json' } : {}),
      },
      body: opts.body,
    });
  } catch (e) {
    throw new UnreachableError(`Could not reach ${target.host}: ${e instanceof Error ? e.message : e}`);
  }
  return {
    ok: resp.ok,
    status: resp.status,
    contentType: resp.headers.get('content-type') ?? '',
    body: await resp.text(),
  };
}

/**
 * The same, with the body left as bytes. A tar or an archive is not text, and
 * decoding it as UTF-8 to hand it back would corrupt it beyond recognition.
 */
export async function requestBytes(
  target: RemoteTarget,
  method: string,
  pathname: string
): Promise<{ ok: boolean; status: number; body: Buffer }> {
  let resp;
  try {
    resp = await fetch(`${target.host}${pathname}`, { method, headers: { authorization: `Bearer ${target.token}` } });
  } catch (e) {
    throw new UnreachableError(`Could not reach ${target.host}: ${e instanceof Error ? e.message : e}`);
  }
  return { ok: resp.ok, status: resp.status, body: Buffer.from(await resp.arrayBuffer()) };
}

/** One API call, with the status left to the caller: for the calls where a 404 is an answer rather than a failure. */
export async function apiTry(
  target: RemoteTarget,
  method: string,
  pathname: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: Record<string, any> }> {
  const r = await request(target, method, pathname, {
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: Record<string, any> | null = null;
  try {
    data = JSON.parse(r.body) as Record<string, any>;
  } catch {
    data = null;
  }
  return { ok: r.ok, status: r.status, data: data ?? {} };
}

/** The vault refused: report what it said, with the exit code its status maps to. */
export function apiFailed(
  target: RemoteTarget,
  pathname: string,
  r: { status: number; data: Record<string, any> }
): never {
  throw new CliError(
    r.data.error ? String(r.data.error) : `HTTP ${r.status} from ${target.host}${pathname}`,
    exitCodeForStatus(r.status)
  );
}

export async function api(
  target: RemoteTarget,
  method: string,
  pathname: string,
  body?: unknown
): Promise<Record<string, any>> {
  const r = await apiTry(target, method, pathname, body);
  if (!r.ok) apiFailed(target, pathname, r);
  return r.data;
}

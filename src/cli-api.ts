import { vaultTarget } from './credentials';

// The client side of the JSON API, shared by every CLI command that talks to a
// running vault: the user commands, the runner commands, and import. Errors are
// reported and the process exits, since these are all one-shot commands where a
// failed call is the end of the command.

export interface RemoteTarget {
  host: string;
  token: string;
}

/** The vault a command works against: whatever `cofferdam login` left behind, unless --host or --token says otherwise. */
export async function remoteTarget(args: { host?: string | null; token?: string | null }): Promise<RemoteTarget> {
  try {
    return await vaultTarget(args);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

/** One API call, with the status left to the caller: for the calls where a 404 is an answer rather than a failure. */
export async function apiTry(
  target: RemoteTarget,
  method: string,
  pathname: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: Record<string, any> }> {
  let resp;
  try {
    resp = await fetch(`${target.host}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${target.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    console.error(`Could not reach ${target.host}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  let data: Record<string, any> | null = null;
  try {
    data = (await resp.json()) as Record<string, any>;
  } catch {
    data = null;
  }
  return { ok: resp.ok, status: resp.status, data: data ?? {} };
}

export function apiFailed(target: RemoteTarget, pathname: string, r: { status: number; data: Record<string, any> }): never {
  console.error(r.data.error ? `Error: ${r.data.error}` : `Error: HTTP ${r.status} from ${target.host}${pathname}`);
  process.exit(1);
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

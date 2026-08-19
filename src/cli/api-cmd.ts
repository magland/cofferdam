import { request } from '../cli-api';
import { CliError, EXIT_USAGE, exitCodeForStatus } from './exit';
import { readFileArg } from './input';
import { Command, Invocation, OptionSpec } from './parse';
import { TARGET_OPTIONS, targetFrom } from './target';

// The escape hatch. Every route the vault has is reachable the day it lands,
// whether or not a typed command has been written for it, which is what keeps a
// gap in the command set an inconvenience rather than a blocker. The shape
// follows `gh api` closely enough that someone who knows that one needs no
// second explanation.

const FIELD_OPTIONS: OptionSpec[] = [
  {
    name: 'method',
    type: 'string',
    value: '<m>',
    short: 'X',
    summary: 'HTTP method; defaults to GET, or POST when a body is given',
  },
  {
    name: 'field',
    type: 'string[]',
    value: '<k=v>',
    summary: 'JSON body field; true, false, null, and whole numbers are coerced',
  },
  { name: 'raw-field', type: 'string[]', value: '<k=v>', summary: 'JSON body field, always a string' },
  { name: 'input', type: 'string', value: '<f>', summary: "Send this file as the body; '-' reads stdin" },
  { name: 'include', type: 'boolean', short: 'i', summary: 'Print the status line and headers before the body' },
];

/**
 * A path as typed becomes a path as sent. All four of these name the same
 * route, because remembering which one this CLI wanted is not a good use of
 * anyone's attention:
 *
 *   repos/demo/proj    /repos/demo/proj    api/repos/demo/proj    /api/repos/demo/proj
 */
export function normalizeApiPath(given: string): string {
  let p = given.trim();
  if (/^https?:\/\//i.test(p)) {
    // A full URL is accepted for its path only: the host comes from the login,
    // so that a token is never sent somewhere the caller did not configure.
    try {
      const u = new URL(p);
      p = u.pathname + u.search;
    } catch {
      throw new CliError(`not a URL: ${given}`, EXIT_USAGE);
    }
  }
  p = p.replace(/^\/+/, '');
  if (!p.startsWith('api/') && p !== 'api') p = `api/${p}`;
  return `/${p}`;
}

function coerce(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

function splitField(pair: string, flag: string): [string, string] {
  const i = pair.indexOf('=');
  if (i <= 0) throw new CliError(`--${flag} takes key=value, not '${pair}'`, EXIT_USAGE);
  return [pair.slice(0, i), pair.slice(i + 1)];
}

async function bodyFor(inv: Invocation): Promise<string | undefined> {
  const input = inv.str('input');
  const fields = inv.list('field');
  const rawFields = inv.list('raw-field');
  if (input && (fields.length || rawFields.length)) {
    throw new CliError('Pass either --input or --field/--raw-field, not both.', EXIT_USAGE);
  }
  if (input) return await readFileArg(input);
  if (!fields.length && !rawFields.length) return undefined;
  const body: Record<string, unknown> = {};
  for (const pair of fields) {
    const [k, v] = splitField(pair, 'field');
    body[k] = coerce(v);
  }
  for (const pair of rawFields) {
    const [k, v] = splitField(pair, 'raw-field');
    body[k] = v;
  }
  return JSON.stringify(body);
}

export const apiCommand: Command = {
  path: ['api'],
  summary: 'Call any route of the vault JSON API and print what it answers',
  description: `The path may be written with or without a leading slash and with or without the
'api/' prefix, so 'repos/demo/proj' and '/api/repos/demo/proj' are the same
route. The response body is printed verbatim on stdout, whatever its type; a
non-2xx status prints the body on stderr instead and exits non-zero, with the
same exit codes every other command uses (4 for 404, 5 for 409).

  cofferdam api repos/demo/proj/issues
  cofferdam api repos/demo/proj/issues -X POST --field title=Bug --field 'body=It broke'
  cofferdam api repos/demo/proj/issues/1/state -X POST --field state=closed
  cofferdam api repos/demo/proj/contents/README.md --input patch.json -X PUT`,
  args: [{ name: 'path', required: true }],
  options: [...FIELD_OPTIONS, ...TARGET_OPTIONS],
  async run(inv) {
    const target = await targetFrom(inv);
    const pathname = normalizeApiPath(inv.args[0]);
    const body = await bodyFor(inv);
    const method = (inv.str('method') ?? (body === undefined ? 'GET' : 'POST')).toUpperCase();
    const r = await request(target, method, pathname, { body });
    if (inv.bool('include')) {
      process.stderr.write(`HTTP ${r.status}\n`);
      if (r.contentType) process.stderr.write(`content-type: ${r.contentType}\n\n`);
    }
    if (!r.ok) {
      process.stderr.write(r.body.endsWith('\n') || r.body === '' ? r.body : r.body + '\n');
      process.exit(exitCodeForStatus(r.status));
    }
    process.stdout.write(r.body.endsWith('\n') || r.body === '' ? r.body : r.body + '\n');
  },
};

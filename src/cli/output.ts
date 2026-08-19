import { CliError, EXIT_USAGE } from './exit';
import { Invocation, OptionSpec } from './parse';

// The output contract, which a program depends on more than a person does:
// --json puts a single JSON value on stdout and nothing else, and every
// diagnostic goes to stderr, so `cofferdam issue list --json | jq` never has to
// filter anything out.

export const JSON_OPTION: OptionSpec = {
  name: 'json',
  type: 'string?',
  value: '[<fields>]',
  summary: 'JSON on stdout; --json=<a,b> or --json <a,b> keeps only those fields',
};

export interface JsonMode {
  /** Whether --json was given at all. */
  enabled: boolean;
  /** The requested field list, or null for every field. */
  fields: string[] | null;
}

export function jsonMode(inv: Invocation): JsonMode {
  const v = inv.optional('json');
  if (v === false) return { enabled: false, fields: null };
  if (v === true) return { enabled: true, fields: null };
  const fields = v
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  return { enabled: true, fields: fields.length ? fields : null };
}

/** One JSON value on stdout, with a trailing newline and nothing else. */
export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

/**
 * Keep only the requested keys. Unknown names are an error naming the valid
 * ones, since silently returning nothing for a misspelled field is the kind of
 * failure a caller does not notice until much later.
 */
export function pickFields<T extends Record<string, unknown>>(rows: T[], fields: string[] | null): unknown[] {
  if (!fields) return rows;
  const valid = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row)) valid.add(k);
  // An empty result set has no keys to check against, so nothing can be
  // rejected; the filter is then a no-op over no rows anyway.
  if (valid.size > 0) {
    const unknown = fields.filter((f) => !valid.has(f));
    if (unknown.length) {
      throw new CliError(
        `unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}. Valid: ${[...valid].sort().join(', ')}`,
        EXIT_USAGE
      );
    }
  }
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const f of fields) if (f in row) out[f] = row[f];
    return out;
  });
}

/** The same, for a single object rather than a list. */
export function pickObject(row: Record<string, unknown>, fields: string[] | null): unknown {
  return pickFields([row], fields)[0];
}

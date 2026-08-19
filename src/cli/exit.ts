// Exit codes and the error type that carries them. A person reads the message
// on stderr; a program reads the code, so the codes are part of the CLI's
// contract and are documented in docs/cli.md and docs/agents.md. The two that
// pay for themselves are 4 and 5: "does this exist" and "did someone else get
// there first" are the questions a retrying caller asks, and both used to be
// indistinguishable from every other failure.

export const EXIT_OK = 0;
/** Generic failure, including a 4xx or 5xx from the vault with no code of its own. */
export const EXIT_FAIL = 1;
/** Unknown command, unknown flag, missing argument. */
export const EXIT_USAGE = 2;
/** No token, or the vault rejected the one given. */
export const EXIT_AUTH = 3;
/** The vault answered 404 for the addressed resource. */
export const EXIT_NOTFOUND = 4;
/** The vault answered 409, or an operation was refused because of state. */
export const EXIT_CONFLICT = 5;

export class CliError extends Error {
  readonly code: number;
  constructor(message: string, code: number = EXIT_FAIL) {
    super(message);
    this.code = code;
  }
}

/**
 * The vault could not be reached at all: DNS, the connection, or the TLS
 * handshake, rather than anything the vault said. It is an ordinary failure to
 * anything that just reports it, but a polling command wants to tell it apart,
 * because one dropped request in the middle of a watch is not a reason to
 * abandon a run that is still going.
 */
export class UnreachableError extends CliError {
  constructor(message: string) {
    super(message, EXIT_FAIL);
  }
}

/**
 * The exit code an HTTP status from the vault maps to. 403 is deliberately a
 * generic failure rather than 3: the token was accepted and is simply not
 * allowed to do this, which is not something a caller fixes by logging in
 * again.
 */
export function exitCodeForStatus(status: number): number {
  if (status === 401) return EXIT_AUTH;
  if (status === 404) return EXIT_NOTFOUND;
  if (status === 409) return EXIT_CONFLICT;
  return EXIT_FAIL;
}

// Whether this run asked for JSON. Set by the parser, because a failure can
// happen before the command reaches its own output code, and a caller that
// passed --json expects {"error": "..."} either way.
let jsonRequested = false;

export function setJsonErrors(on: boolean): void {
  jsonRequested = on;
}

export function jsonErrorsWanted(): boolean {
  return jsonRequested;
}

import { execFile, spawn } from 'child_process';

// Client-side git, shared by the commands that move repositories between a
// vault and somewhere else: `mochi import` and `mochi fork` (clone from a
// source, push to the vault), `mochi sync` (fetch from an upstream, push to
// the vault), and `mochi pr export` (clone from the vault, push to GitHub).
// All of them run on the operator's machine, which is the point: the vault
// holds no credential for any system but itself.

/** Run a command with its output going straight to the terminal, so a long clone shows progress. */
export function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env: env ?? process.env });
    child.on('error', (e) =>
      reject(new Error((e as NodeJS.ErrnoException).code === 'ENOENT' ? `${cmd} is not on PATH` : String(e.message)))
    );
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Run a command quietly and capture its stdout, or null when it fails to run or exits nonzero. */
export function capture(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024, env: env ?? process.env }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

// The token is handed to git through a helper that reads it from the
// environment rather than through the command line, where every process on the
// machine could read it. The empty helper first clears the list, so the answer
// comes from here and nowhere else, and no prompt can appear.
export function mochiCredentialEnv(username: string, token: string): NodeJS.ProcessEnv {
  return { ...process.env, MOCHI_USER: username, MOCHI_TOKEN: token, GIT_TERMINAL_PROMPT: '0' };
}

const MOCHI_CREDENTIAL_HELPER =
  `!f() { test "$1" = get && printf 'username=%s\\npassword=%s\\n' "$MOCHI_USER" "$MOCHI_TOKEN"; }; f`;

/** git options that make a vault URL authenticate from mochiCredentialEnv and nothing else. */
export function mochiCredentialArgs(): string[] {
  return ['-c', 'credential.helper=', '-c', `credential.helper=${MOCHI_CREDENTIAL_HELPER}`];
}

/**
 * git options that make a github.com URL authenticate through `gh`'s own
 * credential helper. `pr export` pushes with these, so having run
 * `gh auth login` once is the only GitHub credential setup it asks for.
 */
export function ghCredentialArgs(): string[] {
  return ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];
}

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { api } from '../cli-api';
import { parseUpstream } from '../source';
import { CliError, EXIT_CONFLICT, EXIT_FAIL, EXIT_USAGE } from './exit';
import { capture, mochiCredentialArgs, mochiCredentialEnv, run } from './gitrun';
import { REPO_OPTION, repoPath, resolveRepo } from './repo';
import { TARGET_OPTIONS, targetFrom } from './target';
import { Command } from './parse';

// `mochi sync`: bring a fork's branch up to date with the upstream it was
// forked from. Without this a fork silently rots, and a pull request exported
// from a stale base arrives already conflicted.
//
// Like import and export, it runs on the operator's machine: a bare clone of
// the vault's branch, a fetch from the upstream URL on top of it (so only the
// new objects cross the network), and a push of the result back to the vault.
// The push is not forced, and the vault refuses non-fast-forwards anyway, so a
// branch that has grown its own commits is reported as diverged rather than
// overwritten.

export const syncCommand: Command = {
  path: ['sync'],
  summary: 'Fast-forward a branch from the upstream the repository was forked from',
  description: `The upstream is the URL \`mochi fork\` recorded (or \`mochi repo edit --upstream\`
set). The branch defaults to the repository's default branch. The fetch uses
whatever git credentials this machine already has, the push uses your mochi
token, and only a fast-forward is ever pushed: a branch that has diverged from
its upstream is reported and left alone.`,
  args: [{ name: 'repo' }],
  options: [
    { name: 'branch', type: 'string', value: '<b>', summary: 'Branch to sync (default: the default branch)' },
    REPO_OPTION,
    ...TARGET_OPTIONS,
  ],
  async run(inv) {
    const target = await targetFrom(inv);
    const ref = await resolveRepo(inv, target, inv.args[0] ?? null);
    const data = await api(target, 'GET', repoPath(ref));
    const upstream = parseUpstream(String(data.upstream ?? ''));
    if (!upstream) {
      throw new CliError(
        `${ref.collection}/${ref.repo} has no upstream recorded. Fork with mochi fork, or record one:\n` +
          `  mochi repo edit ${ref.collection}/${ref.repo} --upstream https://github.com/owner/repo`,
        EXIT_USAGE
      );
    }
    const branch = inv.str('branch') ?? String(data.defaultBranch ?? '');
    if (!branch) throw new CliError('No branch to sync: the repository is empty. Pass --branch.', EXIT_USAGE);

    const vaultUrl = `${target.host}/${encodeURIComponent(ref.collection)}/${encodeURIComponent(ref.repo)}`;
    const env = mochiCredentialEnv('mochi', target.token);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-sync-'));
    try {
      // The vault side first, so the upstream fetch only carries what is new.
      console.log(`Fetching ${ref.collection}/${ref.repo} @ ${branch}`);
      if ((await run('git', [...mochiCredentialArgs(), 'clone', '--bare', '--quiet', '--single-branch', '--branch', branch, vaultUrl, tmp], env)) !== 0) {
        throw new CliError(`Could not fetch branch ${branch} from ${vaultUrl}.`, EXIT_FAIL);
      }
      console.log(`Fetching ${upstream.label} @ ${branch}`);
      if ((await run('git', ['-C', tmp, 'fetch', '--quiet', upstream.url, branch])) !== 0) {
        throw new CliError(`Could not fetch branch ${branch} from ${upstream.url}.`, EXIT_FAIL);
      }
      const count = async (range: string): Promise<number> => {
        const out = await capture('git', ['-C', tmp, 'rev-list', '--count', range]);
        if (out === null) throw new CliError('git rev-list failed in the temporary clone.', EXIT_FAIL);
        return parseInt(out.trim(), 10);
      };
      const behind = await count(`refs/heads/${branch}..FETCH_HEAD`);
      const ahead = await count(`FETCH_HEAD..refs/heads/${branch}`);
      if (behind === 0) {
        console.log(
          ahead === 0
            ? `${branch} is up to date with ${upstream.label}.`
            : `${branch} is up to date with ${upstream.label}, and ${ahead} commit${ahead === 1 ? '' : 's'} ahead of it.`
        );
        return;
      }
      if (ahead > 0) {
        throw new CliError(
          `${branch} has diverged from ${upstream.label}: ${ahead} commit${ahead === 1 ? '' : 's'} of its own, ` +
            `${behind} upstream. Nothing was pushed; merge or rebase by hand in a clone.`,
          EXIT_CONFLICT
        );
      }
      console.log(`Pushing ${behind} commit${behind === 1 ? '' : 's'} to ${vaultUrl}`);
      if ((await run('git', ['-C', tmp, ...mochiCredentialArgs(), 'push', '--quiet', vaultUrl, `FETCH_HEAD:refs/heads/${branch}`], env)) !== 0) {
        throw new CliError(`Could not push ${branch} to ${vaultUrl}.`, EXIT_FAIL);
      }
      console.log(`Fast-forwarded ${branch} by ${behind} commit${behind === 1 ? '' : 's'} from ${upstream.label}.`);
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        // A leftover temporary directory is not worth failing the sync over.
      }
    }
  },
};

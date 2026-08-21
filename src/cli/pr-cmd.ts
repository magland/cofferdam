import { api, apiTry } from '../cli-api';
import { CliError, EXIT_CONFLICT, EXIT_USAGE, exitCodeForStatus } from './exit';
import { readFileArg } from './input';
import { JSON_OPTION, jsonMode, pickFields, pickObject, printJson, printTable, shortDate } from './output';
import { Command, Invocation, OptionSpec } from './parse';
import { REPO_OPTION, repoPath, resolveRepo } from './repo';
import { TARGET_OPTIONS, targetFrom } from './target';

// The pull request commands. `pr merge` and `pr checks` are the two with
// something to say beyond the shape of the API underneath.

const COMMON: OptionSpec[] = [REPO_OPTION, ...TARGET_OPTIONS];

const BODY_OPTIONS: OptionSpec[] = [
  { name: 'body', type: 'string', value: '<b>', summary: 'Body text' },
  { name: 'body-file', type: 'string', value: '<f>', summary: "Read the body from a file, or '-' for stdin" },
];

async function bodyOf(inv: Invocation, required = false): Promise<string | undefined> {
  const inline = inv.str('body');
  const file = inv.str('body-file');
  if (inline !== null && file !== null) throw new CliError('Pass either --body or --body-file, not both.', EXIT_USAGE);
  if (file !== null) return await readFileArg(file);
  if (inline !== null) return inline;
  if (required) throw new CliError('A body is required: pass --body <text> or --body-file <path>.', EXIT_USAGE);
  return undefined;
}

function pullRef(inv: Invocation): number {
  const raw = inv.args[0] ?? '';
  if (!/^[1-9][0-9]*$/.test(raw)) throw new CliError(`'${raw}' is not a pull request number`, EXIT_USAGE);
  return parseInt(raw, 10);
}

export const prCommands: Command[] = [
  {
    path: ['pr', 'list'],
    summary: 'List pull requests',
    options: [
      { name: 'state', type: 'string', value: '<s>', summary: 'open (default), closed, merged, or all' },
      { name: 'limit', type: 'int', value: '<n>', summary: 'At most this many' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const ref = await resolveRepo(inv, target);
      const query = new URLSearchParams();
      const state = inv.str('state');
      if (state !== null) query.set('state', state);
      const limit = inv.int('limit');
      if (limit !== null) query.set('limit', String(limit));
      const data = await api(target, 'GET', `${repoPath(ref)}/pulls?${query.toString()}`);
      const pulls = (data.pulls ?? []) as Record<string, unknown>[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ pulls: pickFields(pulls, json.fields) });
        return;
      }
      if (pulls.length === 0) {
        console.log(`No pull requests in ${ref.collection}/${ref.repo}`);
        return;
      }
      printTable(
        pulls.map((p) => [
          `#${p.number}`,
          String(p.state),
          String(p.title),
          `${p.head} -> ${p.base}`,
          String(p.author),
          shortDate(p.updated as string),
        ])
      );
    },
  },
  {
    path: ['pr', 'view'],
    summary: 'Show one pull request, with its comments',
    args: [{ name: 'number', required: true }],
    options: [
      { name: 'comments', type: 'boolean', summary: 'Print the comments in full (implied by --json)' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const ref = await resolveRepo(inv, target);
      const data = await api(target, 'GET', `${repoPath(ref)}/pulls/${pullRef(inv)}`);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`#${data.number} ${data.title}`);
      console.log(`${data.state} - ${data.head} into ${data.base}, opened by ${data.author} on ${shortDate(data.created)}`);
      if (data.mergeSha) console.log(`merged by ${data.mergedBy} as ${String(data.mergeSha).slice(0, 10)}`);
      console.log('');
      console.log(String(data.body ?? '').trimEnd());
      const comments = (data.commentList ?? []) as Record<string, unknown>[];
      if (comments.length && inv.bool('comments')) {
        for (const c of comments) {
          console.log('');
          console.log(`--- ${c.author} on ${shortDate(c.created as string)}`);
          console.log(String(c.body ?? '').trimEnd());
        }
      } else if (comments.length) {
        console.log('');
        console.log(`(${comments.length} comment${comments.length === 1 ? '' : 's'}; --comments shows them)`);
      }
    },
  },
  {
    path: ['pr', 'create'],
    summary: 'Open a pull request',
    options: [
      { name: 'base', type: 'string', value: '<b>', summary: 'Branch to merge into' },
      { name: 'head', type: 'string', value: '<h>', summary: 'Branch to merge from' },
      { name: 'title', type: 'string', value: '<t>', summary: 'Title' },
      ...BODY_OPTIONS,
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const base = inv.str('base');
      const head = inv.str('head');
      const title = inv.str('title');
      if (base === null || head === null || title === null) {
        throw new CliError('--base, --head, and --title are all required', EXIT_USAGE);
      }
      const target = await targetFrom(inv);
      const ref = await resolveRepo(inv, target);
      const data = await api(target, 'POST', `${repoPath(ref)}/pulls`, {
        base,
        head,
        title,
        body: (await bodyOf(inv)) ?? '',
      });
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`${target.host}/${ref.collection}/${ref.repo}/pulls/${data.number}`);
    },
  },
  {
    path: ['pr', 'diff'],
    summary: 'Print the diff a pull request proposes',
    args: [{ name: 'number', required: true }],
    options: [JSON_OPTION, ...COMMON],
    async run(inv) {
      const target = await targetFrom(inv);
      const ref = await resolveRepo(inv, target);
      const data = await api(target, 'GET', `${repoPath(ref)}/pulls/${pullRef(inv)}/diff`);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      process.stdout.write(String(data.patch ?? ''));
    },
  },
  {
    path: ['pr', 'comment'],
    summary: 'Add a comment to a pull request',
    args: [{ name: 'number', required: true }],
    options: [...BODY_OPTIONS, JSON_OPTION, ...COMMON],
    async run(inv) {
      const target = await targetFrom(inv);
      const ref = await resolveRepo(inv, target);
      const n = pullRef(inv);
      const data = await api(target, 'POST', `${repoPath(ref)}/pulls/${n}/comments`, { body: await bodyOf(inv, true) });
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`Commented on #${n}`);
    },
  },
  {
    path: ['pr', 'merge'],
    summary: 'Merge a pull request',
    description: `Without --squash the merge keeps both parents, which is the record of where the
work came from. A conflict is reported with the conflicting paths and exits 5, so
a caller can tell "it does not apply" from "it went wrong".

Whether it would apply can be asked without merging anything, which is the read
worth making first:

  mochi api repos/<collection>/<repo>/pulls/<n>/merge`,
    args: [{ name: 'number', required: true }],
    options: [
      { name: 'squash', type: 'boolean', summary: 'One commit on the base rather than a merge commit' },
      { name: 'delete-branch', type: 'boolean', summary: 'Delete the head branch afterwards' },
      { name: 'message', type: 'string', value: '<m>', summary: 'Commit message; a default is built if omitted' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const ref = await resolveRepo(inv, target);
      const n = pullRef(inv);
      const path = `${repoPath(ref)}/pulls/${n}/merge`;
      const r = await apiTry(target, 'POST', path, {
        method: inv.bool('squash') ? 'squash' : 'merge',
        message: inv.str('message') ?? undefined,
        deleteBranch: inv.bool('delete-branch'),
      });
      const json = jsonMode(inv);
      if (!r.ok) {
        // The conflicting paths are the useful part of a refusal, so they are
        // printed rather than swallowed by a one-line error.
        if (json.enabled) {
          process.stderr.write(JSON.stringify(r.data) + '\n');
        } else {
          console.error(String(r.data.error ?? `HTTP ${r.status}`));
          for (const p of (r.data.conflicts ?? []) as string[]) console.error(`  conflict: ${p}`);
        }
        process.exit(Array.isArray(r.data.conflicts) ? EXIT_CONFLICT : exitCodeForStatus(r.status));
      }
      if (json.enabled) {
        printJson(pickObject(r.data, json.fields));
        return;
      }
      console.log(`Merged #${n} as ${String(r.data.sha).slice(0, 10)}`);
      if (r.data.branchDeleted) console.log('and deleted the head branch');
    },
  },
  {
    path: ['pr', 'checks'],
    summary: 'Workflow runs whose commit is this pull request head',
    description: `mochi has no equivalent of a check suite or a commit status, so there is
nothing behind this but the runs whose sha matches the pull request's head
commit. That is what this reports, and it is worth knowing that is what it means.`,
    args: [{ name: 'number', required: true }],
    options: [JSON_OPTION, ...COMMON],
    async run(inv) {
      const target = await targetFrom(inv);
      const ref = await resolveRepo(inv, target);
      const n = pullRef(inv);
      const commits = await api(target, 'GET', `${repoPath(ref)}/pulls/${n}/commits`);
      const head = ((commits.commits ?? []) as Record<string, unknown>[])[0];
      const sha = head ? String(head.sha) : null;
      const runs = await api(target, 'GET', `${repoPath(ref)}/runs?limit=100`);
      const matching = ((runs.runs ?? []) as Record<string, unknown>[]).filter((r) => sha !== null && r.sha === sha);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ sha, runs: pickFields(matching, json.fields) });
        return;
      }
      if (!sha) {
        console.log('This pull request has no commits, so there is nothing to have run.');
        return;
      }
      if (matching.length === 0) {
        console.log(`No workflow runs for ${sha.slice(0, 10)}`);
        return;
      }
      printTable(
        matching.map((r) => [`#${r.number}`, String(r.status), String(r.conclusion ?? ''), String(r.workflowName ?? r.workflow ?? '')])
      );
    },
  },
  ...(['close', 'reopen'] as const).map((verb) => ({
    path: ['pr', verb],
    summary: verb === 'close' ? 'Close a pull request without merging it' : 'Reopen a closed pull request',
    args: [{ name: 'number', required: true }],
    options: [JSON_OPTION, ...COMMON],
    async run(inv: Invocation) {
      const target = await targetFrom(inv);
      const ref = await resolveRepo(inv, target);
      const n = pullRef(inv);
      const data = await api(target, 'POST', `${repoPath(ref)}/pulls/${n}/state`, {
        state: verb === 'close' ? 'closed' : 'open',
      });
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`#${n} is now ${data.state}`);
    },
  })),
];

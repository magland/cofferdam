import { api } from '../cli-api';
import { CliError, EXIT_USAGE } from './exit';
import { readFileArg } from './input';
import { JSON_OPTION, jsonMode, pickFields, pickObject, printJson, printTable, shortDate } from './output';
import { Command, Invocation, OptionSpec } from './parse';
import { REPO_OPTION, repoPath, resolveRepo } from './repo';
import { TARGET_OPTIONS, targetFrom } from './target';

// The issue commands, named as gh names them, because that is the point: someone
// who knows gh should guess right.

const COMMON: OptionSpec[] = [REPO_OPTION, ...TARGET_OPTIONS];

const BODY_OPTIONS: OptionSpec[] = [
  { name: 'body', type: 'string', value: '<b>', summary: 'Body text' },
  { name: 'body-file', type: 'string', value: '<f>', summary: "Read the body from a file, or '-' for stdin" },
];

/**
 * The body a command was given. An issue body is frequently longer than a shell
 * argument should be, so --body-file exists alongside --body, and asking for
 * both is a mistake rather than a precedence question.
 */
async function bodyOf(inv: Invocation, required = false): Promise<string | undefined> {
  const inline = inv.str('body');
  const file = inv.str('body-file');
  if (inline !== null && file !== null) throw new CliError('Pass either --body or --body-file, not both.', EXIT_USAGE);
  if (file !== null) return await readFileArg(file);
  if (inline !== null) return inline;
  if (required) throw new CliError('A body is required: pass --body <text> or --body-file <path>.', EXIT_USAGE);
  return undefined;
}

function issueRef(inv: Invocation): number {
  const raw = inv.args[0] ?? '';
  if (!/^[1-9][0-9]*$/.test(raw)) throw new CliError(`'${raw}' is not an issue number`, EXIT_USAGE);
  return parseInt(raw, 10);
}

export const issueCommands: Command[] = [
  {
    path: ['issue', 'list'],
    summary: 'List issues',
    options: [
      { name: 'state', type: 'string', value: '<s>', summary: 'open (default), closed, or all' },
      { name: 'label', type: 'string', value: '<l>', summary: 'Only issues carrying this label' },
      { name: 'author', type: 'string', value: '<a>', summary: 'Only issues opened by this user' },
      { name: 'search', type: 'string', value: '<q>', summary: 'Only issues matching this text' },
      { name: 'sort', type: 'string', value: '<s>', summary: 'newest, oldest, updated, or comments' },
      { name: 'limit', type: 'int', value: '<n>', summary: 'At most this many' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const ref = await resolveRepo(inv, target);
      const query = new URLSearchParams();
      for (const [flag, key] of [
        ['state', 'state'],
        ['label', 'label'],
        ['author', 'author'],
        ['sort', 'sort'],
        ['search', 'q'],
      ] as const) {
        const v = inv.str(flag);
        if (v !== null) query.set(key, v);
      }
      const limit = inv.int('limit');
      if (limit !== null) query.set('limit', String(limit));
      const data = await api(target, 'GET', `${repoPath(ref)}/issues?${query.toString()}`);
      const issues = (data.issues ?? []) as Record<string, unknown>[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ issues: pickFields(issues, json.fields) });
        return;
      }
      if (issues.length === 0) {
        console.log(`No issues in ${ref.collection}/${ref.repo}`);
        return;
      }
      printTable(
        issues.map((i) => [
          `#${i.number}`,
          String(i.state),
          String(i.title),
          String(i.author),
          shortDate(i.updated as string),
          (i.labels as string[]).join(','),
        ])
      );
    },
  },
  {
    path: ['issue', 'view'],
    summary: 'Show one issue, with its comments',
    args: [{ name: 'number', required: true }],
    options: [
      { name: 'comments', type: 'boolean', summary: 'Print the comments in full (implied by --json)' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const ref = await resolveRepo(inv, target);
      const data = await api(target, 'GET', `${repoPath(ref)}/issues/${issueRef(inv)}`);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`#${data.number} ${data.title}`);
      console.log(`${data.state} - opened by ${data.author} on ${shortDate(data.created)}`);
      if ((data.labels as string[]).length) console.log(`labels: ${(data.labels as string[]).join(', ')}`);
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
    path: ['issue', 'create'],
    summary: 'Open an issue',
    options: [
      { name: 'title', type: 'string', value: '<t>', summary: 'Title' },
      ...BODY_OPTIONS,
      { name: 'label', type: 'string[]', value: '<l>', summary: 'Label to attach' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const title = inv.str('title');
      if (title === null) throw new CliError('--title is required', EXIT_USAGE);
      const target = await targetFrom(inv);
      const ref = await resolveRepo(inv, target);
      const labels = inv.list('label');
      const data = await api(target, 'POST', `${repoPath(ref)}/issues`, {
        title,
        body: (await bodyOf(inv)) ?? '',
        labels: labels.length ? labels : undefined,
      });
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`${target.host}/${ref.collection}/${ref.repo}/issues/${data.number}`);
    },
  },
  {
    path: ['issue', 'edit'],
    summary: 'Change an issue title, body, or labels',
    description: `--label replaces the whole set, which is what the API does; --add-label keeps what is
there and adds to it, which means reading the issue first.`,
    args: [{ name: 'number', required: true }],
    options: [
      { name: 'title', type: 'string', value: '<t>', summary: 'New title' },
      ...BODY_OPTIONS,
      { name: 'label', type: 'string[]', value: '<l>', summary: 'Replace the labels with these' },
      { name: 'add-label', type: 'string[]', value: '<l>', summary: 'Keep the existing labels and add these' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const ref = await resolveRepo(inv, target);
      const n = issueRef(inv);
      const title = inv.str('title');
      const body = await bodyOf(inv);
      const set = inv.list('label');
      const add = inv.list('add-label');
      if (set.length && add.length) throw new CliError('Pass either --label or --add-label, not both.', EXIT_USAGE);
      let labels: string[] | undefined = set.length ? set : undefined;
      if (add.length) {
        const current = await api(target, 'GET', `${repoPath(ref)}/issues/${n}`);
        labels = [...new Set([...((current.labels ?? []) as string[]), ...add])];
      }
      if (title === null && body === undefined && labels === undefined) {
        throw new CliError('Nothing to change. Pass --title, --body, --body-file, --label, or --add-label.', EXIT_USAGE);
      }
      const data = await api(target, 'PATCH', `${repoPath(ref)}/issues/${n}`, { title: title ?? undefined, body, labels });
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`Updated #${n}`);
    },
  },
  {
    path: ['issue', 'comment'],
    summary: 'Add a comment to an issue',
    args: [{ name: 'number', required: true }],
    options: [...BODY_OPTIONS, JSON_OPTION, ...COMMON],
    async run(inv) {
      const target = await targetFrom(inv);
      const ref = await resolveRepo(inv, target);
      const n = issueRef(inv);
      const data = await api(target, 'POST', `${repoPath(ref)}/issues/${n}/comments`, {
        body: await bodyOf(inv, true),
      });
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`Commented on #${n}`);
    },
  },
  ...(['close', 'reopen'] as const).map((verb) => ({
    path: ['issue', verb],
    summary: verb === 'close' ? 'Close an issue' : 'Reopen a closed issue',
    args: [{ name: 'number', required: true }],
    options: [JSON_OPTION, ...COMMON],
    async run(inv: Invocation) {
      const target = await targetFrom(inv);
      const ref = await resolveRepo(inv, target);
      const n = issueRef(inv);
      const data = await api(target, 'POST', `${repoPath(ref)}/issues/${n}/state`, {
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

import { api, request } from '../cli-api';
import { CliError, EXIT_USAGE, exitCodeForStatus } from './exit';
import { JSON_OPTION, jsonMode, pickFields, pickObject, printJson, printTable, shortDate } from './output';
import { Command, OptionSpec } from './parse';
import { REPO_OPTION, repoPath, resolveRepo } from './repo';
import { TARGET_OPTIONS, targetFrom } from './target';

// Reading a repository from the command line: what is in it, what one file says,
// what changed, and where something appears. Between them these are what let a
// caller work on a repository without cloning it.

const COMMON: OptionSpec[] = [REPO_OPTION, ...TARGET_OPTIONS];
const REF_OPTION: OptionSpec = {
  name: 'ref',
  type: 'string',
  value: '<r>',
  summary: 'Branch, tag, or commit; the default branch otherwise',
};

function refQuery(ref: string | null, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(extra);
  if (ref !== null) q.set('ref', ref);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const repoCommands: Command[] = [
  {
    path: ['repo', 'list'],
    summary: 'List the repositories in the vault',
    args: [{ name: 'collection' }],
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const data = await api(target, 'GET', '/api/repos');
      const only = inv.args[0] ?? null;
      const repos = ((data.repos ?? []) as Record<string, unknown>[]).filter(
        (r) => only === null || r.collection === only
      );
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ repos: pickFields(repos, json.fields) });
        return;
      }
      if (repos.length === 0) {
        console.log(only ? `No repositories in ${only}` : `No repositories on ${target.host}`);
        return;
      }
      printTable(repos.map((r) => [`${r.collection}/${r.name}`, String(r.description ?? '')]));
    },
  },
  {
    path: ['repo', 'view'],
    summary: 'Show one repository: its default branch, counts, and whether it has a site',
    args: [{ name: 'repo' }],
    options: [JSON_OPTION, ...COMMON],
    async run(inv) {
      const target = await targetFrom(inv);
      const ref = await resolveRepo(inv, target, inv.args[0] ?? null);
      const data = await api(target, 'GET', repoPath(ref));
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`${data.collection}/${data.name}`);
      if (data.description) console.log(String(data.description));
      if (data.forkedFrom) {
        const from = data.forkedFrom as { collection: string; repo: string };
        console.log(`forked from ${from.collection}/${from.repo}`);
      }
      printTable([
        ['default branch', String(data.defaultBranch ?? '(none)')],
        ['last updated', shortDate(data.updated)],
        ['branches', String(data.branches)],
        ['tags', String(data.tags)],
        ['releases', String(data.releases)],
        ['open issues', String(data.openIssues)],
        ['open pull requests', String(data.openPulls)],
        ['site', data.hasSite ? 'yes' : 'no'],
      ]);
    },
  },
  {
    path: ['branch', 'list'],
    summary: 'List branches',
    options: [JSON_OPTION, ...COMMON],
    async run(inv) {
      const target = await targetFrom(inv);
      const ref = await resolveRepo(inv, target);
      const data = await api(target, 'GET', `${repoPath(ref)}/branches`);
      const branches = (data.branches ?? []) as Record<string, unknown>[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ branches: pickFields(branches, json.fields), defaultBranch: data.defaultBranch });
        return;
      }
      printTable(
        branches.map((b) => [
          b.name === data.defaultBranch ? `* ${b.name}` : `  ${b.name}`,
          String(b.sha).slice(0, 10),
          shortDate(b.date as string),
          String(b.subject ?? ''),
        ])
      );
    },
  },
  {
    path: ['tag', 'list'],
    summary: 'List tags',
    options: [JSON_OPTION, ...COMMON],
    async run(inv) {
      const target = await targetFrom(inv);
      const ref = await resolveRepo(inv, target);
      const data = await api(target, 'GET', `${repoPath(ref)}/tags`);
      const tags = (data.tags ?? []) as Record<string, unknown>[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ tags: pickFields(tags, json.fields) });
        return;
      }
      if (tags.length === 0) {
        console.log('No tags');
        return;
      }
      printTable(tags.map((t) => [String(t.name), String(t.sha).slice(0, 10), shortDate(t.date as string), String(t.subject ?? '')]));
    },
  },
  {
    path: ['file', 'list'],
    summary: 'List a directory, or every path in the tree',
    description: `With no path this lists the repository root. --all lists every path in the tree
instead, which is the listing a caller looking for a file wants.`,
    args: [{ name: 'path' }],
    options: [
      REF_OPTION,
      { name: 'all', type: 'boolean', summary: 'Every path in the tree, recursively' },
      { name: 'commits', type: 'boolean', summary: 'Add the last commit for each entry (one git log each)' },
      { name: 'limit', type: 'int', value: '<n>', summary: 'With --all, at most this many paths' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const ref = inv.str('ref');
      const json = jsonMode(inv);
      if (inv.bool('all')) {
        const limit = inv.int('limit');
        const data = await api(
          target,
          'GET',
          `${repoPath(repo)}/paths${refQuery(ref, limit !== null ? { limit: String(limit) } : {})}`
        );
        if (json.enabled) {
          printJson(pickObject(data, json.fields));
          return;
        }
        for (const p of (data.paths ?? []) as string[]) console.log(p);
        if (data.truncated) console.error('(the list was capped by the server; ask for fewer paths)');
        return;
      }
      const dir = (inv.args[0] ?? '').replace(/^\/+/, '');
      const query = refQuery(ref, inv.bool('commits') ? { commits: '1' } : {});
      const data = await api(target, 'GET', `${repoPath(repo)}/tree/${dir}${query}`);
      const entries = (data.entries ?? []) as Record<string, unknown>[];
      if (json.enabled) {
        printJson({ ref: data.ref, path: data.path, entries: pickFields(entries, json.fields) });
        return;
      }
      printTable(
        entries.map((e) => {
          const last = e.lastCommit as Record<string, unknown> | null | undefined;
          const row = [String(e.type), String(e.name), e.size === null ? '' : String(e.size)];
          return last ? [...row, shortDate(last.date as string), String(last.subject ?? '')] : row;
        })
      );
    },
  },
  {
    path: ['file', 'view'],
    summary: 'Print one file',
    description: `Text is printed as text. A binary file is refused rather than written to a
terminal, unless --raw is given, which streams the bytes exactly as the vault
serves them. A Git LFS pointer is reported as one rather than handed over as if it
were the file, since the bytes are elsewhere.`,
    args: [{ name: 'path', required: true }],
    options: [
      REF_OPTION,
      { name: 'raw', type: 'boolean', summary: 'The bytes, unchanged, whatever they are' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const ref = inv.str('ref');
      const filePath = inv.args[0].replace(/^\/+/, '');
      if (inv.bool('raw')) {
        const r = await request(target, 'GET', `${repoPath(repo)}/raw/${filePath}${refQuery(ref)}`);
        if (!r.ok) {
          process.stderr.write(r.body.endsWith('\n') ? r.body : r.body + '\n');
          process.exit(exitCodeForStatus(r.status));
        }
        process.stdout.write(r.body);
        return;
      }
      const data = await api(target, 'GET', `${repoPath(repo)}/contents/${filePath}${refQuery(ref)}`);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      if (data.encoding === 'lfs-pointer') {
        const lfs = data.lfs as { oid: string; size: number };
        console.error(`${filePath} is a Git LFS pointer (oid ${lfs.oid}, ${lfs.size} bytes).`);
        console.error('Fetch it with a clone that has git-lfs, or with --raw.');
        process.exit(EXIT_USAGE);
      }
      if (data.encoding === 'base64') {
        console.error(`${filePath} is binary (${data.size} bytes). Pass --raw to write the bytes out.`);
        process.exit(EXIT_USAGE);
      }
      process.stdout.write(String(data.content ?? ''));
    },
  },
  {
    path: ['commit', 'list'],
    summary: 'List commits',
    options: [
      REF_OPTION,
      { name: 'path', type: 'string', value: '<p>', summary: 'Only commits touching this path' },
      { name: 'limit', type: 'int', value: '<n>', summary: 'At most this many' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const extra: Record<string, string> = {};
      const filePath = inv.str('path');
      if (filePath !== null) extra.path = filePath;
      const limit = inv.int('limit');
      if (limit !== null) extra.limit = String(limit);
      const data = await api(target, 'GET', `${repoPath(repo)}/commits${refQuery(inv.str('ref'), extra)}`);
      const commits = (data.commits ?? []) as Record<string, unknown>[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ ref: data.ref, commits: pickFields(commits, json.fields) });
        return;
      }
      printTable(commits.map((c) => [String(c.sha).slice(0, 10), shortDate(c.date as string), String(c.author), String(c.subject)]));
    },
  },
  {
    path: ['commit', 'view'],
    summary: 'Show one commit',
    args: [{ name: 'sha', required: true }],
    options: [
      { name: 'patch', type: 'boolean', summary: 'Print the patch instead of the summary' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const sha = inv.args[0];
      if (inv.bool('patch')) {
        const r = await request(target, 'GET', `${repoPath(repo)}/commits/${encodeURIComponent(sha)}/patch`);
        if (!r.ok) {
          process.stderr.write(r.body.endsWith('\n') ? r.body : r.body + '\n');
          process.exit(exitCodeForStatus(r.status));
        }
        process.stdout.write(r.body);
        return;
      }
      const data = await api(target, 'GET', `${repoPath(repo)}/commits/${encodeURIComponent(sha)}`);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`commit ${data.sha}`);
      console.log(`author ${data.author} <${data.email ?? ''}>`);
      console.log(`date   ${data.date}`);
      if ((data.parents as string[] | undefined)?.length) console.log(`parents ${(data.parents as string[]).join(' ')}`);
      console.log('');
      console.log(String(data.message ?? '').trimEnd());
    },
  },
  {
    path: ['diff'],
    summary: 'Compare two refs, as <base>...<head>',
    args: [{ name: 'range', required: true }],
    options: [
      { name: 'stat', type: 'boolean', summary: 'Only the counts and the commit list' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const range = inv.args[0];
      if (!range.includes('...')) throw new CliError("ask for a comparison as <base>...<head>", EXIT_USAGE);
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const data = await api(target, 'GET', `${repoPath(repo)}/compare/${range}`);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      if (inv.bool('stat')) {
        console.log(`${data.ahead} ahead, ${data.behind} behind`);
        printTable(((data.commits ?? []) as Record<string, unknown>[]).map((c) => [String(c.sha).slice(0, 10), String(c.subject)]));
        return;
      }
      process.stdout.write(String(data.patch ?? ''));
    },
  },
  {
    path: ['search'],
    summary: 'Search a repository for literal text',
    args: [{ name: 'query', required: true }],
    options: [REF_OPTION, JSON_OPTION, ...COMMON],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const query = refQuery(inv.str('ref'), { q: inv.args[0] });
      const data = await api(target, 'GET', `${repoPath(repo)}/search${query}`);
      const hits = (data.hits ?? []) as Record<string, unknown>[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ ref: data.ref, query: data.query, hits: pickFields(hits, json.fields), truncated: data.truncated });
        return;
      }
      if (hits.length === 0) {
        console.log('No matches');
        return;
      }
      for (const h of hits) console.log(`${h.path}:${h.line}: ${String(h.text ?? '').trim()}`);
      if (data.truncated) console.error('(the server capped the results)');
    },
  },
];

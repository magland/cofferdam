import { api } from '../cli-api';
import { CliError, EXIT_USAGE } from './exit';
import { readFileArg } from './input';
import { JSON_OPTION, jsonMode, pickFields, pickObject, printJson, printTable, shortDate } from './output';
import { Command, Invocation, OptionSpec } from './parse';
import { REPO_OPTION, repoPath, resolveRepo } from './repo';
import { TARGET_OPTIONS, targetFrom } from './target';

// Releases: notes attached to a tag that already exists.
//
// There is no `release upload`, because a release's downloads are the archive
// routes and there is nothing to upload. Anyone who knows `gh release upload`
// will look for one, so docs/agents.md says plainly that it is not here.

const COMMON: OptionSpec[] = [REPO_OPTION, ...TARGET_OPTIONS];

const NOTES_OPTIONS: OptionSpec[] = [
  { name: 'title', type: 'string', value: '<t>', summary: 'Release title; the tag names itself otherwise' },
  { name: 'notes', type: 'string', value: '<n>', summary: 'Release notes' },
  { name: 'notes-file', type: 'string', value: '<f>', summary: "Read the notes from a file, or '-' for stdin" },
  { name: 'prerelease', type: 'boolean', summary: 'Mark it a prerelease' },
];

async function notesOf(inv: Invocation): Promise<string | undefined> {
  const inline = inv.str('notes');
  const file = inv.str('notes-file');
  if (inline !== null && file !== null) throw new CliError('Pass either --notes or --notes-file, not both.', EXIT_USAGE);
  if (file !== null) return await readFileArg(file);
  return inline ?? undefined;
}

/** A tag may contain slashes, so it is encoded as one path segment. */
function tagPath(tag: string): string {
  return encodeURIComponent(tag);
}

async function put(inv: Invocation, tag: string, prereleaseGiven: boolean): Promise<void> {
  const target = await targetFrom(inv);
  const repo = await resolveRepo(inv, target);
  const data = await api(target, 'PUT', `${repoPath(repo)}/releases/${tagPath(tag)}`, {
    name: inv.str('title') ?? undefined,
    body: await notesOf(inv),
    // Absent means "leave it as it is", which is what makes create and edit the
    // same call; only a flag that was actually given changes anything.
    prerelease: prereleaseGiven ? true : undefined,
  });
  const json = jsonMode(inv);
  if (json.enabled) {
    printJson(pickObject(data, json.fields));
    return;
  }
  console.log(`${target.host}/${repo.collection}/${repo.repo}/releases/${tag}`);
}

export const releaseCommands: Command[] = [
  {
    path: ['release', 'list'],
    summary: 'List releases, newest first',
    options: [JSON_OPTION, ...COMMON],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const data = await api(target, 'GET', `${repoPath(repo)}/releases`);
      const releases = (data.releases ?? []) as Record<string, unknown>[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ releases: pickFields(releases, json.fields) });
        return;
      }
      if (releases.length === 0) {
        console.log('No releases');
        return;
      }
      printTable(
        releases.map((r) => [
          String(r.tag),
          r.prerelease ? 'prerelease' : '',
          String(r.name || r.tag),
          String(r.author),
          shortDate(r.created as string),
        ])
      );
    },
  },
  {
    path: ['release', 'view'],
    summary: 'Show one release',
    args: [{ name: 'tag', required: true }],
    options: [JSON_OPTION, ...COMMON],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const data = await api(target, 'GET', `${repoPath(repo)}/releases/${tagPath(inv.args[0])}`);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`${data.tag}${data.prerelease ? ' (prerelease)' : ''}`);
      if (data.name) console.log(String(data.name));
      console.log(`published by ${data.author} on ${shortDate(data.created)}`);
      console.log('');
      console.log(String(data.body ?? '').trimEnd());
    },
  },
  {
    path: ['release', 'create'],
    summary: 'Publish notes for a tag that already exists',
    description: `The tag has to be in the repository first: notes for a tag nobody can check out
are notes about nothing. 'cofferdam tag create' makes one.

Creating and editing are the same call underneath, since a release is keyed by its
tag, so 'release create' on an existing release edits it rather than refusing.`,
    args: [{ name: 'tag', required: true }],
    options: [...NOTES_OPTIONS, JSON_OPTION, ...COMMON],
    run: (inv) => put(inv, inv.args[0], inv.bool('prerelease')),
  },
  {
    path: ['release', 'edit'],
    summary: 'Change a release title, notes, or prerelease flag',
    args: [{ name: 'tag', required: true }],
    options: [
      ...NOTES_OPTIONS,
      { name: 'latest', type: 'boolean', summary: 'Clear the prerelease flag' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      if (inv.bool('prerelease') && inv.bool('latest')) {
        throw new CliError('Pass either --prerelease or --latest, not both.', EXIT_USAGE);
      }
      if (inv.bool('latest')) {
        const target = await targetFrom(inv);
        const repo = await resolveRepo(inv, target);
        const data = await api(target, 'PUT', `${repoPath(repo)}/releases/${tagPath(inv.args[0])}`, {
          name: inv.str('title') ?? undefined,
          body: await notesOf(inv),
          prerelease: false,
        });
        const json = jsonMode(inv);
        if (json.enabled) printJson(pickObject(data, json.fields));
        else console.log(`${inv.args[0]} is no longer a prerelease`);
        return;
      }
      await put(inv, inv.args[0], inv.bool('prerelease'));
    },
  },
  {
    path: ['release', 'delete'],
    summary: "Delete a release's notes, keeping the tag",
    args: [{ name: 'tag', required: true }],
    options: [
      { name: 'yes', type: 'boolean', summary: 'Required: confirm that this cannot be undone' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      if (!inv.bool('yes')) throw new CliError('Deleting a release cannot be undone. Pass --yes.', EXIT_USAGE);
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const data = await api(target, 'DELETE', `${repoPath(repo)}/releases/${tagPath(inv.args[0])}`);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      // Worth saying, because the two are separate operations and a caller
      // expecting the tag to go with the notes would be surprised.
      console.log(`Deleted the release notes for ${data.deleted}; the tag itself is still there.`);
    },
  },
];

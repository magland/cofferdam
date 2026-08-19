import { api } from '../cli-api';
import { CliError, EXIT_USAGE } from './exit';
import { JSON_OPTION, jsonMode, pickFields, pickObject, printJson, printTable, shortDate } from './output';
import { Command, OptionSpec } from './parse';
import { TARGET_OPTIONS, targetFrom } from './target';

// The rest of administration: reading and removing users, listing and revoking
// their tokens, removing an empty collection, and the vault's own settings.

const YES_OPTION: OptionSpec = {
  name: 'yes',
  type: 'boolean',
  summary: 'Required: confirm that this cannot be undone',
};

export const adminCommands: Command[] = [
  {
    path: ['user', 'view'],
    summary: "Show one user's scopes and the tokens they hold",
    description: `Never a token, and never a token's hash: only a SHA-256 hash is stored, so there
is nothing to show even if it were a good idea. What comes back is the id
revocation takes, when the token was minted, and any scope of its own.`,
    args: [{ name: 'username', required: true }],
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const data = await api(target, 'GET', `/api/users/${encodeURIComponent(inv.args[0])}`);
      const tokens = (data.tokens ?? []) as Record<string, unknown>[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`${data.name} @ ${target.host}`);
      console.log(`  push: ${(data.scope as string[]).join(', ') || '(none)'}`);
      if ((data.admin as string[]).length) console.log(`  admin: ${(data.admin as string[]).join(', ')}`);
      console.log('');
      if (tokens.length === 0) {
        console.log('No tokens, so this user cannot sign in or push.');
        return;
      }
      printTable(
        tokens.map((t) => [
          String(t.id),
          shortDate(t.created as string) || '(unknown date)',
          t.scope ? `restricted to: ${(t.scope as string[]).join(', ')}` : '',
        ])
      );
    },
  },
  {
    path: ['user', 'delete'],
    summary: 'Remove a user and every token they hold',
    args: [{ name: 'username', required: true }],
    options: [YES_OPTION, JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      if (!inv.bool('yes')) throw new CliError('Removing a user cannot be undone. Pass --yes.', EXIT_USAGE);
      const name = inv.args[0];
      const target = await targetFrom(inv);
      const data = await api(target, 'DELETE', `/api/users/${encodeURIComponent(name)}?confirm=${encodeURIComponent(name)}`);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`Removed ${data.deleted}`);
    },
  },
  {
    path: ['user', 'token', 'list'],
    summary: "List a user's tokens, by the id revocation takes",
    args: [{ name: 'username', required: true }],
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const data = await api(target, 'GET', `/api/users/${encodeURIComponent(inv.args[0])}/tokens`);
      const tokens = (data.tokens ?? []) as Record<string, unknown>[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ tokens: pickFields(tokens, json.fields) });
        return;
      }
      if (tokens.length === 0) {
        console.log('No tokens');
        return;
      }
      printTable(
        tokens.map((t) => [
          String(t.id),
          shortDate(t.created as string) || '(unknown date)',
          t.scope ? `restricted to: ${(t.scope as string[]).join(', ')}` : '',
        ])
      );
    },
  },
  {
    path: ['user', 'token', 'revoke'],
    summary: 'Revoke one token, leaving the user and their other tokens',
    description: `Revoking the token you are using is allowed and is reported rather than refused:
locking yourself out is your business, and vault.json remains hand-editable.`,
    args: [
      { name: 'username', required: true },
      { name: 'token-id', required: true },
    ],
    options: [YES_OPTION, JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      if (!inv.bool('yes')) throw new CliError('Revoking a token cannot be undone. Pass --yes.', EXIT_USAGE);
      const target = await targetFrom(inv);
      const data = await api(
        target,
        'DELETE',
        `/api/users/${encodeURIComponent(inv.args[0])}/tokens/${encodeURIComponent(inv.args[1])}`
      );
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`Revoked ${data.revoked}; ${data.remaining} token${data.remaining === 1 ? '' : 's'} left.`);
      if (data.wasThisToken) console.log('That was the token this command authenticated with, so it will not work again.');
    },
  },
  {
    path: ['collection', 'delete'],
    summary: 'Remove an empty collection',
    description: `A collection is a directory, so this is an rmdir: one holding anything at all is
refused rather than emptied.`,
    args: [{ name: 'name', required: true }],
    options: [YES_OPTION, JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      if (!inv.bool('yes')) throw new CliError('Removing a collection cannot be undone. Pass --yes.', EXIT_USAGE);
      const target = await targetFrom(inv);
      const data = await api(target, 'DELETE', `/api/collections/${encodeURIComponent(inv.args[0])}`);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`Removed ${data.deleted}`);
    },
  },
  {
    path: ['config', 'view'],
    summary: "Show the vault's settings",
    options: [JSON_OPTION, ...TARGET_OPTIONS],
    async run(inv) {
      const target = await targetFrom(inv);
      const data = await api(target, 'GET', '/api/config');
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      const ci = (data.ci ?? {}) as Record<string, unknown>;
      const sites = (data.sites ?? {}) as Record<string, unknown>;
      const network = (data.network ?? {}) as Record<string, unknown>;
      const limits = (data.limits ?? {}) as Record<string, unknown>;
      printTable([
        ['theme', String(data.theme)],
        ['ci.runs', String(ci.runs)],
        ['ci.days', String(ci.days)],
        ['ci.artifactMb', String(ci.artifactMb)],
        ['sites.host', String(sites.host || '(none; sites are sandboxed on the forge host)')],
        ['network.trustProxy', String(network.trustProxy)],
        ['limits.requestsPerMinute', String(limits.requestsPerMinute)],
        ['limits.authFailures', String(limits.authFailures)],
      ]);
      console.log('');
      console.log(`themes: ${(data.themes as string[]).join(', ')}`);
      // Saying which of these a write can reach saves a caller discovering it by
      // being refused.
      console.log('Only theme and ci can be set here; network, limits, and sites are read at startup.');
      console.log('Edit config.json in the vault and restart the server to change those.');
    },
  },
  {
    path: ['config', 'set'],
    summary: 'Change the theme or the CI retention settings',
    description: `Only these two: network.trustProxy, the limits block, and sites.host are read
once when the server starts, so a command that changed them would report a change
the running server had not made. Edit config.json in the vault and restart.`,
    options: [
      { name: 'theme', type: 'string', value: '<t>', summary: 'Theme name' },
      { name: 'ci-runs', type: 'int', value: '<n>', summary: 'Completed runs to keep per repository' },
      { name: 'ci-days', type: 'int', value: '<n>', summary: 'Also drop runs older than this; 0 disables' },
      { name: 'ci-artifact-mb', type: 'int', value: '<n>', summary: 'Largest artifact a job may upload' },
      JSON_OPTION,
      ...TARGET_OPTIONS,
    ],
    async run(inv) {
      const theme = inv.str('theme');
      const runs = inv.int('ci-runs');
      const days = inv.int('ci-days');
      const artifactMb = inv.int('ci-artifact-mb');
      if (theme === null && runs === null && days === null && artifactMb === null) {
        throw new CliError(
          'Nothing to change. Pass --theme, --ci-runs, --ci-days, or --ci-artifact-mb.',
          EXIT_USAGE
        );
      }
      const target = await targetFrom(inv);
      // The CI block is written whole, so the fields not named have to come from
      // what is there now rather than from a default.
      let ci: Record<string, number> | undefined;
      if (runs !== null || days !== null || artifactMb !== null) {
        const current = (await api(target, 'GET', '/api/config')).ci as Record<string, number>;
        ci = {
          runs: runs ?? current.runs,
          days: days ?? current.days,
          artifactMb: artifactMb ?? current.artifactMb,
        };
      }
      const data = await api(target, 'PATCH', '/api/config', { theme: theme ?? undefined, ci });
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`theme: ${data.theme}`);
      const saved = data.ci as Record<string, unknown>;
      console.log(`ci: keep ${saved.runs} runs, ${saved.days} days, artifacts up to ${saved.artifactMb} MB`);
    },
  },
];

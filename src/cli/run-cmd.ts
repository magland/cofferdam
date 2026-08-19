import * as fs from 'fs';
import * as path from 'path';
import { api, requestBytes } from '../cli-api';
import { CliError, EXIT_FAIL, EXIT_USAGE, exitCodeForStatus } from './exit';
import { JSON_OPTION, jsonMode, pickFields, pickObject, printJson, printTable, shortDate } from './output';
import { Command, Invocation, OptionSpec } from './parse';
import { REPO_OPTION, RepoRef, repoPath, resolveRepo } from './repo';
import { TARGET_OPTIONS, targetFrom } from './target';

// Workflows and their runs. `run watch` is the command that turns "an agent can
// start a workflow" into "an agent can act on the result", and `run view --log`
// is what it reads when the result is a failure.

const COMMON: OptionSpec[] = [REPO_OPTION, ...TARGET_OPTIONS];

function runNumber(inv: Invocation): number {
  const raw = inv.args[0] ?? '';
  if (!/^[1-9][0-9]*$/.test(raw)) throw new CliError(`'${raw}' is not a run number`, EXIT_USAGE);
  return parseInt(raw, 10);
}

function runRow(r: Record<string, unknown>): string[] {
  return [
    `#${r.number}`,
    String(r.status),
    String(r.conclusion ?? ''),
    String(r.workflowName ?? ''),
    String(r.refName ?? r.ref ?? ''),
    String(r.sha ?? '').slice(0, 10),
    shortDate(r.createdAt as string),
  ];
}

/** Print a job's log, which is what a caller looking at a failure came for. */
async function printLog(
  target: Awaited<ReturnType<typeof targetFrom>>,
  repo: RepoRef,
  n: number,
  jobId: string,
  tail: number | null
): Promise<void> {
  const query = tail === null ? '' : `?tail=${tail}`;
  const data = await api(target, 'GET', `${repoPath(repo)}/runs/${n}/jobs/${encodeURIComponent(jobId)}/log${query}`);
  if (data.error) {
    console.error(`job ${jobId} failed before it ran: ${data.error}`);
    return;
  }
  for (const line of (data.lines ?? []) as string[]) console.log(line);
  // Diagnostics go to stderr so that piping the log somewhere gets the log.
  if (data.truncated) {
    console.error(`(the last ${(data.lines as string[]).length} of ${data.total} lines; --tail 0 for all of it)`);
  }
  if (data.capped) console.error('(the server capped this log while it was being written)');
}

export const runCommands: Command[] = [
  {
    path: ['workflow', 'list'],
    summary: 'List the workflows at a ref, with the inputs each takes',
    options: [
      { name: 'ref', type: 'string', value: '<r>', summary: 'Branch or tag; the default branch otherwise' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const ref = inv.str('ref');
      const data = await api(target, 'GET', `${repoPath(repo)}/workflows${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
      const workflows = (data.workflows ?? []) as Record<string, unknown>[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ ref: data.ref, workflows: pickFields(workflows, json.fields) });
        return;
      }
      if (workflows.length === 0) {
        console.log(`No workflows at ${data.ref}`);
        return;
      }
      printTable(
        workflows.map((w) => [
          String(w.name),
          String(w.path),
          w.dispatch ? `dispatch: ${Object.keys(w.dispatch as object).join(',') || 'no inputs'}` : '',
          w.error ? `error: ${w.error}` : '',
        ])
      );
    },
  },
  {
    path: ['workflow', 'run'],
    summary: 'Dispatch a workflow by hand',
    description: `The workflow is named by its path, as 'workflow list' reports it. --field k=v
supplies a workflow_dispatch input; the inputs a workflow takes are in the same
listing.`,
    args: [{ name: 'workflow', required: true }],
    options: [
      { name: 'ref', type: 'string', value: '<r>', summary: 'Branch to run on; the default branch otherwise' },
      { name: 'field', type: 'string[]', value: '<k=v>', summary: 'A workflow_dispatch input' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const inputs: Record<string, string> = {};
      for (const pair of inv.list('field')) {
        const i = pair.indexOf('=');
        if (i <= 0) throw new CliError(`--field takes key=value, not '${pair}'`, EXIT_USAGE);
        inputs[pair.slice(0, i)] = pair.slice(i + 1);
      }
      const data = await api(target, 'POST', `${repoPath(repo)}/dispatches`, {
        workflow: inv.args[0],
        ref: inv.str('ref') ?? undefined,
        inputs: Object.keys(inputs).length ? inputs : undefined,
      });
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`Started run #${data.number} of ${data.workflowName}`);
      console.log(`  cofferdam run watch ${data.number} --repo ${repo.collection}/${repo.repo}`);
    },
  },
  {
    path: ['run', 'list'],
    summary: 'List workflow runs, newest first',
    options: [
      { name: 'status', type: 'string', value: '<s>', summary: 'queued, running, or completed' },
      { name: 'limit', type: 'int', value: '<n>', summary: 'At most this many' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const query = new URLSearchParams();
      const status = inv.str('status');
      if (status !== null) query.set('status', status);
      const limit = inv.int('limit');
      if (limit !== null) query.set('limit', String(limit));
      const data = await api(target, 'GET', `${repoPath(repo)}/runs?${query.toString()}`);
      const runs = (data.runs ?? []) as Record<string, unknown>[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ runs: pickFields(runs, json.fields) });
        return;
      }
      if (runs.length === 0) {
        console.log('No runs');
        return;
      }
      printTable(runs.map(runRow));
    },
  },
  {
    path: ['run', 'view'],
    summary: 'Show one run, its jobs, and optionally a job log',
    description: `--log prints the log of the failed job, or of the only job, without needing to be
told which. --job names one explicitly. The log comes back as its last 200 lines
by default, because handing a caller the whole of a large log wastes its attention;
--tail 0 asks for all of it.`,
    args: [{ name: 'number', required: true }],
    options: [
      { name: 'job', type: 'string', value: '<j>', summary: 'A job id, as run view reports it' },
      { name: 'log', type: 'boolean', summary: 'Print a job log as well' },
      { name: 'tail', type: 'int', value: '<n>', summary: 'Log lines to keep from the end; 0 for all' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const n = runNumber(inv);
      const data = await api(target, 'GET', `${repoPath(repo)}/runs/${n}`);
      const jobs = (data.jobs ?? []) as Record<string, unknown>[];
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`#${data.number} ${data.workflowName} (${data.event}) on ${data.refName ?? data.ref}`);
      console.log(`${data.status}${data.conclusion ? ` - ${data.conclusion}` : ''} at ${String(data.sha).slice(0, 10)}`);
      if (data.error) console.log(`workflow error: ${data.error}`);
      if (jobs.length) {
        console.log('');
        printTable(jobs.map((j) => [String(j.id), String(j.status), String(j.conclusion ?? ''), String(j.name)]));
      }
      if (!inv.bool('log') && inv.str('job') === null) return;
      // The failed job is the one being asked about, when there is one; a run
      // with a single job needs no naming either.
      const named = inv.str('job');
      const chosen =
        named ??
        String(
          (jobs.find((j) => j.conclusion === 'failure') ?? (jobs.length === 1 ? jobs[0] : undefined))?.id ?? ''
        );
      if (!chosen) {
        console.error('Which job? Name one with --job; the ids are in the table above.');
        process.exit(EXIT_USAGE);
      }
      console.log('');
      console.log(`--- ${chosen}`);
      await printLog(target, repo, n, chosen, inv.int('tail'));
    },
  },
  {
    path: ['run', 'watch'],
    summary: 'Wait for a run to finish, then report how it went',
    description: `Polls until the run completes. --exit-status makes a failed run a non-zero exit,
which is what a script wants; without it a finished run is a success whatever it
concluded.

Polling rather than streaming: the engine has no event channel and the vault reads
its state off disk per request, so a five-second poll against a local process costs
nothing and needs no protocol.`,
    args: [{ name: 'number', required: true }],
    options: [
      { name: 'interval', type: 'int', value: '<s>', summary: 'Seconds between polls (default 5)' },
      { name: 'timeout', type: 'int', value: '<s>', summary: 'Give up after this long (default 1800)' },
      { name: 'exit-status', type: 'boolean', summary: 'Exit non-zero when the run did not succeed' },
      { name: 'log', type: 'boolean', summary: 'Print the failed job log when it finishes' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const n = runNumber(inv);
      const interval = Math.max(1, inv.int('interval') ?? 5) * 1000;
      const timeout = Math.max(1, inv.int('timeout') ?? 1800) * 1000;
      const json = jsonMode(inv);
      const started = Date.now();
      let data = await api(target, 'GET', `${repoPath(repo)}/runs/${n}`);
      let last = '';
      while (data.status !== 'completed') {
        if (Date.now() - started > timeout) {
          if (json.enabled) process.stderr.write(JSON.stringify({ error: 'timed out waiting for the run' }) + '\n');
          else console.error(`Gave up after ${Math.round(timeout / 1000)}s; run #${n} is still ${data.status}.`);
          process.exit(EXIT_FAIL);
        }
        // Progress on stderr, so that --json still puts one value on stdout.
        const now = `${data.status}`;
        if (!json.enabled && now !== last) {
          console.error(`run #${n} is ${now}...`);
          last = now;
        }
        await new Promise((r) => setTimeout(r, interval));
        data = await api(target, 'GET', `${repoPath(repo)}/runs/${n}`);
      }
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
      } else {
        console.log(`#${data.number} ${data.workflowName}: ${data.conclusion ?? 'completed'}`);
        const jobs = (data.jobs ?? []) as Record<string, unknown>[];
        if (jobs.length) {
          printTable(jobs.map((j) => [String(j.id), String(j.status), String(j.conclusion ?? ''), String(j.name)]));
        }
        if (inv.bool('log')) {
          const failed = jobs.find((j) => j.conclusion === 'failure') ?? (jobs.length === 1 ? jobs[0] : undefined);
          if (failed) {
            console.log('');
            console.log(`--- ${failed.id}`);
            await printLog(target, repo, n, String(failed.id), null);
          }
        }
      }
      if (inv.bool('exit-status') && data.conclusion !== 'success') process.exit(EXIT_FAIL);
    },
  },
  {
    path: ['run', 'cancel'],
    summary: 'Cancel a run that is queued or running',
    args: [{ name: 'number', required: true }],
    options: [JSON_OPTION, ...COMMON],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const n = runNumber(inv);
      const data = await api(target, 'POST', `${repoPath(repo)}/runs/${n}/cancel`);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`Cancelled run #${n}`);
    },
  },
  {
    path: ['run', 'rerun'],
    summary: 'Run the same workflow at the same commit again',
    args: [{ name: 'number', required: true }],
    options: [JSON_OPTION, ...COMMON],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const n = runNumber(inv);
      const data = await api(target, 'POST', `${repoPath(repo)}/runs/${n}/rerun`);
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson(pickObject(data, json.fields));
        return;
      }
      console.log(`Started run #${data.number} of ${data.workflowName}`);
    },
  },
  {
    path: ['run', 'download'],
    summary: "Download a run's artifacts",
    description: `An artifact is a tar. Without --artifact every artifact of the run is downloaded;
with it, just that one. They land in the current directory unless --dir says
otherwise.`,
    args: [{ name: 'number', required: true }],
    options: [
      { name: 'artifact', type: 'string', value: '<name>', summary: 'Only this artifact' },
      { name: 'dir', type: 'string', value: '<d>', summary: 'Where to write them (default: here)' },
      JSON_OPTION,
      ...COMMON,
    ],
    async run(inv) {
      const target = await targetFrom(inv);
      const repo = await resolveRepo(inv, target);
      const n = runNumber(inv);
      const dir = inv.str('dir') ?? '.';
      const only = inv.str('artifact');
      const listed = await api(target, 'GET', `${repoPath(repo)}/runs/${n}/artifacts`);
      const artifacts = ((listed.artifacts ?? []) as Record<string, unknown>[]).filter(
        (a) => only === null || a.name === only
      );
      if (artifacts.length === 0) {
        throw new CliError(only ? `run #${n} has no artifact named ${only}` : `run #${n} has no artifacts`, EXIT_FAIL);
      }
      fs.mkdirSync(dir, { recursive: true });
      const written: { name: string; file: string; bytes: number }[] = [];
      for (const a of artifacts) {
        const name = String(a.name);
        const r = await requestBytes(target, 'GET', `${repoPath(repo)}/runs/${n}/artifacts/${encodeURIComponent(name)}`);
        if (!r.ok) {
          process.stderr.write(r.body.toString('utf8').trimEnd() + '\n');
          process.exit(exitCodeForStatus(r.status));
        }
        const file = path.join(dir, `${name}.tar`);
        fs.writeFileSync(file, r.body);
        written.push({ name, file, bytes: r.body.length });
      }
      const json = jsonMode(inv);
      if (json.enabled) {
        printJson({ artifacts: written });
        return;
      }
      printTable(written.map((w) => [w.name, w.file, String(w.bytes)]));
    },
  },
];

import { ansiLineHtml, stripAnsi } from '../ansi';
import { avatar } from '../avatar';
import { IconName, icon } from '../icons';
import { esc, formatSize, timeTag } from '../render';
import { Viewer } from '../session';
import { adminShell } from '../forms';
import { RepoCtx, copyRow, csrfField, encPath, layout, repoHeader, repoOpts, repoUrl } from '../views';
import { ArtifactInfo } from './artifacts';
import { DispatchableWorkflow } from './engine';
import { JobRecord, RunRecord, StepState } from './runs';

// The Actions pages: the runs list, one run with its jobs and logs, and the
// runner listing under Admin. Same conventions as the rest of the interface:
// template literals, esc() on every interpolation, no client framework. The
// one piece of script is the log tailer on a running job.

type Status = 'queued' | 'running' | 'success' | 'failure' | 'cancelled' | 'skipped';

function statusOf(x: { status: string; conclusion?: string }): Status {
  if (x.status !== 'completed') return x.status === 'running' ? 'running' : 'queued';
  const c = x.conclusion;
  if (c === 'success' || c === 'failure' || c === 'cancelled' || c === 'skipped') return c;
  return 'failure';
}

const STATUS_LABEL: Record<Status, string> = {
  queued: 'Queued',
  running: 'Running',
  success: 'Success',
  failure: 'Failure',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
};

// The status glyphs are the ringed ones from icons.ts: a tick in a ring for
// success, a cross in a ring for failure, a turning arc while a job runs, and
// grey for the states where nothing happened. Ringed rather than filled, so a
// column of them reads at the weight of the text beside it.
const STATUS_ICON: Record<Status, IconName> = {
  queued: 'clock',
  running: 'sync',
  success: 'check-circle',
  failure: 'x-circle',
  cancelled: 'stop',
  skipped: 'skip',
};

function statusIcon(s: Status): string {
  return `<span class="run-status ${s}" title="${STATUS_LABEL[s]}" aria-label="${STATUS_LABEL[s]}" role="img">${icon(
    STATUS_ICON[s]
  )}</span>`;
}

function duration(from?: string, to?: string): string {
  if (!from) return '';
  const start = new Date(from).getTime();
  const end = to ? new Date(to).getTime() : Date.now();
  const secs = Math.max(0, Math.round((end - start) / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function runTitle(run: RunRecord): string {
  if (run.message) return run.message;
  if (run.event === 'workflow_dispatch') return `${run.workflowName} (manual)`;
  return run.workflowName;
}

// ---- the runs list ----

export function runsPage(
  ctx: RepoCtx,
  runs: RunRecord[],
  workflows: DispatchableWorkflow[],
  selectedWorkflow: string | null,
  flash?: string
): string {
  const base = repoUrl(ctx);
  const actionsBase = `${base}/actions`;

  const rows = runs
    .map((r) => {
      const s = statusOf(r);
      const when = r.createdAt ? timeTag(r.createdAt) : '';
      const dur = duration(r.startedAt, r.completedAt);
      const sha = r.sha
        ? ` <a class="sha" href="${base}/commit/${esc(r.sha)}">${esc(r.sha.slice(0, 7))}</a>`
        : '';
      return `<tr>
<td class="run-cell">${statusIcon(s)}<span><a href="${actionsBase}/runs/${r.number}"><b>${esc(runTitle(r))}</b></a>
<div class="muted small run-sub">${esc(r.workflowName)} #${r.number}: ${esc(r.event)} by ${avatar(
        r.actor,
        16
      )}${esc(r.actor)}${sha}</div></span></td>
<td class="right muted small"><span class="chip">${icon('git-branch')}${esc(r.refName)}</span></td>
<td class="right muted small">${when}${dur ? ` &middot; ${esc(dur)}` : ''}</td>
</tr>`;
    })
    .join('');

  // GitHub lists the workflows down the side of the runs, which is both the
  // filter and the answer to "what can this repository do".
  const sidebar = workflows.length
    ? `<aside class="wf-side"><div class="side-block"><h3>${icon('workflow')}Workflows</h3><div class="side-links">${[
        `<a class="${selectedWorkflow === null ? 'current' : ''}" href="${actionsBase}">${icon(
          'history'
        )}<span>All workflows</span></a>`,
        ...workflows.map(
          (w) =>
            `<a class="${selectedWorkflow === w.path ? 'current' : ''}" href="${actionsBase}?workflow=${encodeURIComponent(
              w.path
            )}" title="${esc(w.path)}">${icon('play')}<span>${esc(w.name)}</span></a>`
        ),
      ].join('')}</div></div></aside>`
    : '';

  const brokenList = workflows.filter((w) => w.error);
  const broken = brokenList.length
    ? `<div class="form-error">${brokenList
        .map((w) => `<div>${esc(w.path)}: ${esc(w.error!)}</div>`)
        .join('')}</div>`
    : '';

  const dispatchable = workflows.filter((w) => w.dispatch !== null);
  const dispatchForm =
    ctx.canPush && ctx.viewer && dispatchable.length
      ? dispatchBox(ctx, ctx.viewer, dispatchable)
      : '';

  const body = runs.length
    ? `<table class="listing runs"><tbody>${rows}</tbody></table>`
    : `<div class="empty-state"><p><b>No workflow runs yet.</b></p><p class="muted">Runs appear here when a push matches a workflow in <code>.github/workflows</code> or <code>.cofferdam/workflows</code>.</p><p class="muted small">Workflows run without credentials: this vault holds no secrets, and a workflow that references <code>secrets.*</code> is refused with a message saying so.</p></div>`;

  const content = `${repoHeader(ctx, 'actions')}
${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
${broken}
<div class="page-head"><h2>Workflow runs</h2>${dispatchForm}</div>
<div class="actions-layout">${sidebar}<div class="actions-main">${body}</div></div>`;
  return layout(`Actions - ${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, actionsBase));
}

function dispatchBox(ctx: RepoCtx, viewer: Viewer, workflows: DispatchableWorkflow[]): string {
  const base = repoUrl(ctx);
  const panels = workflows
    .map((w, i) => {
      const inputs = Object.entries(w.dispatch ?? {})
        .map(([name, def]) => {
          const id = `wf${i}-${name}`;
          const label = `<label for="${esc(id)}">${esc(name)}${def.required ? ' *' : ''}</label>`;
          const help = def.description ? `<p class="muted small">${esc(def.description)}</p>` : '';
          if (def.type === 'choice' && def.options?.length) {
            const opts = def.options
              .map(
                (o) =>
                  `<option value="${esc(o)}"${String(def.default ?? '') === o ? ' selected' : ''}>${esc(o)}</option>`
              )
              .join('');
            return `<div class="field">${label}<select id="${esc(id)}" name="input.${esc(name)}">${opts}</select>${help}</div>`;
          }
          if (def.type === 'boolean') {
            return `<div class="field"><label class="checkbox"><input type="checkbox" id="${esc(
              id
            )}" name="input.${esc(name)}" value="true"${def.default === true || def.default === 'true' ? ' checked' : ''}> ${esc(
              name
            )}</label>${help}</div>`;
          }
          return `<div class="field">${label}<input type="text" id="${esc(id)}" name="input.${esc(
            name
          )}" value="${esc(String(def.default ?? ''))}"${def.required ? ' required' : ''}>${help}</div>`;
        })
        .join('');
      const refOptions = ctx.branches
        .map(
          (b) =>
            `<option value="${esc(b.name)}"${b.name === ctx.defaultBranch ? ' selected' : ''}>${esc(b.name)}</option>`
        )
        .join('');
      return `<form method="post" action="${base}/actions/dispatch" class="dispatch-panel" data-wf="${esc(w.path)}"${
        i === 0 ? '' : ' hidden'
      }>
${csrfField(viewer)}
<input type="hidden" name="workflow" value="${esc(w.path)}">
<div class="field"><label>Use branch</label><select name="ref">${refOptions}</select></div>
${inputs}
<button type="submit" class="btn btn-primary">Run workflow</button>
</form>`;
    })
    .join('');
  const picker =
    workflows.length > 1
      ? `<div class="field"><label>Workflow</label><select onchange="pickWorkflow(this)">${workflows
          .map((w) => `<option value="${esc(w.path)}">${esc(w.name)}</option>`)
          .join('')}</select></div>`
      : '';
  return `<details class="dropdown dispatch">
<summary class="btn">${icon('play')}<span>Run workflow</span>${icon('chevron-down', 'caret')}</summary>
<div class="dropdown-menu dd-right dispatch-body">${picker}${panels}</div>
<script>
function pickWorkflow(sel) {
  var root = sel.closest('.dispatch-body');
  var forms = root.querySelectorAll('.dispatch-panel');
  for (var i = 0; i < forms.length; i++) {
    forms[i].hidden = forms[i].getAttribute('data-wf') !== sel.value;
  }
}
</script>
</details>`;
}

// ---- one run ----

// The runner logs its own setup and cleanup against step index -1, which is
// not a workflow step at all; it gets its own block rather than being
// mistaken for one.
function stepBlocks(job: JobRecord, logLines: { s: number; l: string }[]): string {
  const byStep = new Map<number, string[]>();
  for (const line of logLines) {
    if (!byStep.has(line.s)) byStep.set(line.s, []);
    byStep.get(line.s)!.push(line.l);
  }
  const states: StepState[] = job.stepStates ?? [];
  const indices = new Set<number>([...byStep.keys(), ...states.map((_, i) => i)]);
  const ordered = [...indices].sort((a, b) => a - b);
  if (ordered.length === 0) return '';
  return ordered
    .map((i) => {
      const lines = byStep.get(i) ?? [];
      if (i < 0) {
        return `<details class="step">
<summary><span class="run-status queued" aria-hidden="true">&middot;</span><span class="step-name">Runner</span></summary>
<pre class="joblog">${lines.map((l) => ansiLineHtml(l)).join('\n')}</pre>
</details>`;
      }
      const st = states[i];
      const name = st?.name ?? `Step ${i + 1}`;
      const s: Status = st ? statusOf({ status: st.status, conclusion: st.conclusion }) : 'queued';
      const open = s === 'failure' || s === 'running';
      return `<details class="step"${open ? ' open' : ''}>
<summary>${statusIcon(s)}<span class="step-name">${esc(name)}</span><span class="muted small">${esc(
        duration(st?.startedAt, st?.completedAt)
      )}</span></summary>
<pre class="joblog">${lines.map((l) => ansiLineHtml(l)).join('\n')}</pre>
</details>`;
    })
    .join('');
}

export function runPage(
  ctx: RepoCtx,
  run: RunRecord,
  jobs: JobRecord[],
  selected: JobRecord | null,
  logLines: { s: number; l: string }[],
  logOffset: number,
  artifacts: ArtifactInfo[] = []
): string {
  const base = repoUrl(ctx);
  const actionsBase = `${base}/actions`;
  const runBase = `${actionsBase}/runs/${run.number}`;
  const s = statusOf(run);
  const viewer = ctx.viewer;

  const jobList = jobs
    .map((j) => {
      const js = statusOf(j);
      const current = selected && j.id === selected.id;
      return `<a class="job-item${current ? ' current' : ''}" href="${runBase}?job=${encodeURIComponent(j.id)}">${statusIcon(
        js
      )}<span>${esc(j.name)}</span><span class="muted small">${esc(duration(j.startedAt, j.completedAt))}</span></a>`;
    })
    .join('');

  let detail = '';
  if (run.error) {
    detail = `<div class="form-error"><b>${esc(run.workflowPath)}</b> could not be used: ${esc(run.error)}</div>`;
  } else if (!selected) {
    detail = `<div class="empty-state">This run has no jobs.</div>`;
  } else if (selected.error && selected.stepStates.length === 0) {
    detail = `<div class="form-error">${esc(selected.error)}</div>`;
  } else {
    const js = statusOf(selected);
    const live = js === 'running' || js === 'queued';
    const summaries = (selected.summaries ?? []).filter((x) => x.trim() !== '');
    const summaryBox = summaries.length
      ? `<div class="box"><div class="box-header">Summary</div><div class="box-body"><pre class="joblog">${esc(
          summaries.join('\n')
        )}</pre></div></div>`
      : '';
    const errorBox = selected.error ? `<div class="form-error">${esc(selected.error)}</div>` : '';
    if (live) {
      // The tailer appends as textContent, so a live log is stripped of
      // escapes rather than coloured; colour arrives with the step view when
      // the job completes and the page reloads into it.
      const initial = logLines.map((l) => stripAnsi(l.l)).join('\n');
      detail = `${errorBox}<div class="job-head"><b>${esc(selected.name)}</b> ${statusIcon(js)} <span class="muted small">${esc(
        js === 'queued' ? 'waiting for a runner' : 'running'
      )}</span></div>
<pre class="joblog live" id="livelog">${esc(initial)}</pre>
<script>
(function () {
  var el = document.getElementById('livelog');
  var offset = ${logOffset};
  var url = ${JSON.stringify(`${runBase}/log/${encodeURIComponent(selected.id)}`)};
  var stick = true;
  el.addEventListener('scroll', function () {
    stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
  });
  function poll() {
    fetch(url + '?offset=' + offset, { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.lines && d.lines.length) {
          el.textContent += (el.textContent ? '\\n' : '') + d.lines.join('\\n');
          if (stick) el.scrollTop = el.scrollHeight;
        }
        offset = d.offset;
        if (d.done) { location.reload(); return; }
        setTimeout(poll, 1500);
      })
      .catch(function () { setTimeout(poll, 5000); });
  }
  el.scrollTop = el.scrollHeight;
  setTimeout(poll, 1000);
})();
</script>`;
    } else {
      detail = `${errorBox}<div class="job-head"><b>${esc(selected.name)}</b> ${statusIcon(js)} <span class="muted small">${esc(
        duration(selected.startedAt, selected.completedAt)
      )}</span></div>
${stepBlocks(selected, logLines)}
${summaryBox}`;
    }
  }

  const canOperate = ctx.canPush && viewer;
  const cancelBtn =
    canOperate && run.status !== 'completed'
      ? `<form method="post" action="${runBase}/cancel">${csrfField(viewer!)}<button type="submit" class="btn btn-danger-outline">Cancel run</button></form>`
      : '';
  const rerunBtn = canOperate
    ? `<form method="post" action="${runBase}/rerun">${csrfField(viewer!)}<button type="submit" class="btn">Re-run</button></form>`
    : '';

  const artifactBox = artifacts.length
    ? `<div class="box artifacts"><div class="box-header">Artifacts</div><div class="box-body">${artifacts
        .map(
          (a) =>
            `<a class="artifact" href="${runBase}/artifacts/${encodeURIComponent(a.name)}"><b>${esc(
              a.name
            )}</b><span class="muted small">${esc(formatSize(a.size))}</span></a>`
        )
        .join('')}<p class="muted small">Artifacts are tar archives, and are removed when the run is pruned.</p></div></div>`
    : '';

  const content = `${repoHeader(ctx, 'actions')}
<div class="run-head">
  <div class="run-title">${statusIcon(s)}<h2>${esc(runTitle(run))}</h2></div>
  <div class="right-group">${rerunBtn}${cancelBtn}</div>
</div>
<div class="run-meta muted small">
  <a href="${actionsBase}?workflow=${encodeURIComponent(run.workflowPath)}">${esc(run.workflowName)}</a>
  &middot; #${run.number}
  &middot; ${esc(run.event)} by <span class="run-actor">${avatar(run.actor, 16)}${esc(run.actor)}</span>
  &middot; <span class="chip">${esc(run.refName)}</span>
  ${run.sha ? `&middot; <a class="sha" href="${base}/commit/${esc(run.sha)}">${esc(run.sha.slice(0, 7))}</a>` : ''}
  &middot; <a href="${base}/blob/${encPath(run.refName)}/${encPath(run.workflowPath)}">${esc(run.workflowPath)}</a>
  ${run.createdAt ? `&middot; ${timeTag(run.createdAt, '')}` : ''}
</div>
<div class="run-body">
  <div class="job-list">${jobList}</div>
  <div class="job-detail">${detail}</div>
</div>
${artifactBox}`;
  return layout(`${runTitle(run)} - ${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, runBase));
}

// ---- runners, under Admin ----

export interface RunnerView {
  name: string;
  labels: string[];
  allow: string[];
  createdBy: string;
  createdAt: string;
  tokenUpdatedAt?: string;
  // Where the runner is now, as far as the server can tell: when it last
  // spoke, and the job it holds a lease on. Both are in-memory facts, so a
  // runner that has not polled since the server started reads as absent.
  lastSeen: string | null;
  running: { collection: string; repo: string; run: number; job: string } | null;
  // Where the vault sends a request to start this runner, for one that stops
  // when it has nothing to do. Null for the ordinary kind that is left
  // running, which is most of them.
  wakeUrl?: string | null;
}

// A runner is either working on something, idle but in touch, or not there at
// all. The third case is the one an operator is usually looking for, so it gets
// a plain word rather than an empty cell.
function runnerStatus(r: RunnerView): string {
  if (r.running) {
    const at = `/${encodeURIComponent(r.running.collection)}/${encodeURIComponent(
      r.running.repo
    )}/actions/runs/${r.running.run}?job=${encodeURIComponent(r.running.job)}`;
    return `${statusIcon('running')}<span>running <a href="${at}">${esc(r.running.collection)}/${esc(
      r.running.repo
    )} #${r.running.run}</a> ${esc(r.running.job)}</span>`;
  }
  if (r.lastSeen) {
    return `${statusIcon('success')}<span>idle, last heard from ${timeTag(r.lastSeen, '')}</span>`;
  }
  // A runner with a wake address is meant to be absent between jobs, so the
  // absence is the arrangement working rather than something to look into.
  if (r.wakeUrl) {
    return `${statusIcon('queued')}<span class="muted">stopped; the vault starts it when a job is waiting</span>`;
  }
  return `${statusIcon('queued')}<span class="muted">not seen since the vault restarted</span>`;
}

export function runnersPage(viewer: Viewer, runners: RunnerView[], flash?: string, error?: string): string {
  const rows = runners
    .map(
      (r) =>
        `<tr><td class="with-avatar-row">${icon('server', 'icon')}<span><b><a href="/admin/runners/${encodeURIComponent(
          r.name
        )}">${esc(r.name)}</a></b><div class="muted small">registered by ${esc(r.createdBy)}${
          r.createdAt ? ` ${timeTag(r.createdAt, '')}` : ''
        }</div></span></td>
<td class="small"><div class="runner-status">${runnerStatus(r)}</div></td>
<td class="small">${r.labels.map((l) => `<span class="chip">${esc(l)}</span>`).join(' ')}</td>
<td class="small mono">${esc(r.allow.join(' '))}</td>
<td class="right"><a class="btn" href="/admin/runners/${encodeURIComponent(r.name)}">Details</a></td></tr>`
    )
    .join('');
  const content = `<div class="page-head"><h1>Runners</h1></div>
${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
${error ? `<div class="form-error">${esc(error)}</div>` : ''}
<p class="muted">A runner is a machine that executes workflow jobs. Jobs never run on the vault's own machine: register a runner, then start it with <code>cofferdam runner run</code> somewhere with Docker.</p>
${
  runners.length
    ? `<table class="listing"><tbody>${rows}</tbody></table>`
    : '<div class="empty-state">No runners registered.</div>'
}
<div class="form-box wide" style="margin-top:24px">
<h2>Register a runner</h2>
<form method="post" action="/admin/runners">
${csrfField(viewer)}
<div class="field"><label for="name">Name</label><input type="text" id="name" name="name" placeholder="laptop" required>
<p class="muted small">Identifies the machine in job history.</p></div>
<div class="field"><label for="labels">Labels</label><input type="text" id="labels" name="labels" value="ubuntu-latest">
<p class="muted small">Matched against a job's <code>runs-on</code>. Space or comma separated.</p></div>
<div class="field"><label for="allow">Repositories</label><input type="text" id="allow" name="allow" placeholder="mycollection/*" required>
<p class="muted small">Globs over <code>collection/repo</code>. A runner executes whatever those repositories' workflows say, on the machine you start it on, so grant it only what you trust. Your own admin scope must cover what you grant.</p></div>
<button type="submit" class="btn btn-primary">Register runner</button>
</form>
</div>`;
  return adminShell(viewer, 'runners', 'Runners', '/admin/runners', content);
}

// One runner: what it is allowed to do, whether it is there, and the two
// operations an operator comes here for, which are getting the start command
// and replacing a token that was lost or leaked.
export function runnerPage(viewer: Viewer, r: RunnerView, host: string, flash?: string): string {
  const fact = (label: string, value: string) =>
    value ? `<div class="fact"><span class="k">${esc(label)}</span><span class="v">${value}</span></div>` : '';
  const facts = `<div class="facts">
${fact('Status', `<span class="runner-status">${runnerStatus(r)}</span>`)}
${fact(
    'Labels',
    r.labels.length ? r.labels.map((l) => `<span class="chip">${esc(l)}</span>`).join(' ') : '<span class="muted">none</span>'
  )}
${fact('Repositories', `<span class="mono">${esc(r.allow.join(' '))}</span>`)}
${fact('Registered', `by ${esc(r.createdBy)}${r.createdAt ? ` ${timeTag(r.createdAt, '')}` : ''}`)}
${fact('Token', r.tokenUpdatedAt ? `regenerated ${timeTag(r.tokenUpdatedAt, '')}` : 'the one issued at registration')}
${fact('Wake', r.wakeUrl ? `<span class="mono">${esc(r.wakeUrl)}</span>` : '<span class="muted">nothing starts this runner</span>')}
</div>`;
  const content = `<div class="page-head"><h1>${icon('server', 'icon')}${esc(r.name)}</h1></div>
${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
<p class="muted"><a href="/admin/runners">Runners</a> &middot; a machine that takes jobs for ${esc(
    r.allow.join(', ')
  )} and runs them under Docker.</p>
${facts}
<div class="form-box wide" style="margin-top:24px">
<h2>Start this runner</h2>
<p class="muted">On the machine that will execute the jobs, with Docker installed and running, and the <code>cofferdam</code> CLI on the path (<code>npm install -g @magland/cofferdam</code>):</p>
${copyRow(`cofferdam runner run --host ${host} --runner-token <token>`)}
<p class="muted small">The token is shown only when it is issued, so if you no longer have it, regenerate it below and the command will be filled in for you. Adding <code>--save</code> writes the host and token to <code>~/.config/cofferdam/runner.json</code>, after which <code>cofferdam runner run</code> needs no arguments; <code>COFFERDAM_RUNNER_TOKEN</code> supplies the token where a command line is the wrong place for it, as in a systemd unit. Leave the process running; it polls for work and exits only when you stop it.</p>
<p class="muted small">Jobs are matched by label, so this runner will be offered jobs whose <code>runs-on</code> names ${
    r.labels.length ? r.labels.map((l) => `<code>${esc(l)}</code>`).join(' or ') : 'nothing yet'
  }.</p>
</div>
<div class="form-box wide" style="margin-top:24px">
<h2>Wake address</h2>
<p class="muted">A runner started with <code>--idle</code> stops when it has had no job for that long, which is how a runner on hardware billed by the minute stops costing anything between runs. It cannot be told that work has arrived, though, so the vault sends a request to this address instead, and whatever is in front of the runner (a Fly proxy, a socket unit) starts it. The request carries a secret and nothing else; a new one is generated when you save an address, and the runner has to be started with it.</p>
<p class="muted">Sent at most once a minute per runner, however many jobs are waiting, and only when the runner has not been heard from.</p>
<form method="post" action="/admin/runners/${encodeURIComponent(r.name)}/wake">
${csrfField(viewer)}
<div class="field"><label for="wakeUrl">URL</label><input type="text" id="wakeUrl" name="wakeUrl" value="${esc(
    r.wakeUrl ?? ''
  )}" placeholder="https://my-runner.fly.dev/wake">
<p class="muted small">Leave empty to remove the address, after which nothing starts this runner.</p></div>
<button type="submit" class="btn">${icon('sync')}<span>Save wake address</span></button>
</form>
${
  r.wakeUrl
    ? `<form method="post" action="/admin/runners/${encodeURIComponent(r.name)}/wake/send" style="margin-top:12px">
${csrfField(viewer)}
<button type="submit" class="btn">${icon('play')}<span>Send a wake request now</span></button>
<p class="muted small">Tests the address without queuing a job. A machine that has to boot may take half a minute to answer.</p>
</form>`
    : ''
}
</div>
<div class="form-box wide" style="margin-top:24px">
<h2>Regenerate token</h2>
<p class="muted">Issues a new token for ${esc(
    r.name
  )} and invalidates the current one. Its labels and repositories are kept, but a runner still running with the old token will start failing to poll and has to be restarted.</p>
<form method="post" action="/admin/runners/${encodeURIComponent(
    r.name
  )}/token" onsubmit="return confirm('Regenerate the token for ${esc(
    r.name
  )}? The current token stops working immediately.')">
${csrfField(viewer)}
<button type="submit" class="btn">${icon('sync')}<span>Regenerate token</span></button>
</form>
</div>
<div class="form-box wide" style="margin-top:24px">
<h2>Remove runner</h2>
<p class="muted">Removes ${esc(
    r.name
  )} from the registry. It stops being able to take jobs; a job it is running now will be handed back to the queue when its lease expires.</p>
<form method="post" action="/admin/runners/${encodeURIComponent(
    r.name
  )}/remove" onsubmit="return confirm('Remove runner ${esc(r.name)}? It will stop being able to take jobs.')">
${csrfField(viewer)}
<button type="submit" class="btn btn-danger-outline">${icon('trash')}<span>Remove runner</span></button>
</form>
</div>`;
  return adminShell(viewer, 'runners', `Runner ${r.name}`, '/admin/runners', content);
}

export function runnerTokenPage(
  viewer: Viewer,
  name: string,
  token: string,
  host: string,
  regenerated = false
): string {
  const heading = regenerated ? `New token for ${name}` : 'Runner registered';
  const content = `<div class="form-box wide">
<h1>${esc(heading)}</h1>
<p>The token for <b>${esc(name)}</b> is shown once; only its hash is stored.${
    regenerated ? ' The previous token no longer works.' : ''
  }</p>
${copyRow(token)}
<h2>Start it</h2>
<p class="muted">On a machine with Docker:</p>
${copyRow(`cofferdam runner run --host ${host} --runner-token ${token}`)}
<p class="muted small">Adding <code>--save</code> keeps the host and token in <code>~/.config/cofferdam/runner.json</code>, so <code>cofferdam runner run</code> needs no arguments afterwards.${
    regenerated ? ' If the runner is already running with the old token, restart it now.' : ''
  }</p>
<p><a class="btn" href="/admin/runners/${encodeURIComponent(name)}">Back to ${esc(name)}</a> <a class="btn" href="/admin/runners">All runners</a></p>
</div>`;
  return layout(heading, content, { viewer, path: '/admin/runners' });
}

// The secret a saved wake address is given, shown once for the same reason a
// token is: the vault keeps it in order to send it, and the runner has to be
// started with the same one, so this page is the only place the two halves
// meet.
export function runnerWakePage(viewer: Viewer, name: string, url: string, secret: string): string {
  const content = `<div class="form-box wide">
<h1>Wake address saved</h1>
<p>The vault will start <b>${esc(name)}</b> by sending a request to <span class="mono">${esc(
    url
  )}</span> when a job it could take is waiting and it has not been heard from.</p>
<p>The secret that request carries, shown once here because the runner has to be started with it:</p>
${copyRow(secret)}
<h2>Start it</h2>
<p class="muted">With an idle timeout, so that there is something to wake, and a port for the request to arrive on:</p>
${copyRow(`COFFERDAM_WAKE_SECRET=${secret} cofferdam runner run --idle 5m --wake-port 3000`)}
<p class="muted small">A runner deployed with <code>cofferdam deploy fly runner</code> is given all of this already; this page is for a runner you start yourself. Saving an address again issues a new secret, so the runner has to be restarted with it.</p>
<p><a class="btn" href="/admin/runners/${encodeURIComponent(name)}">Back to ${esc(name)}</a> <a class="btn" href="/admin/runners">All runners</a></p>
</div>`;
  return layout('Wake address saved', content, { viewer, path: '/admin/runners' });
}

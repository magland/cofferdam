import { esc, formatDate, formatSize } from '../render';
import { Viewer } from '../session';
import { RepoCtx, csrfField, encPath, layout, repoHeader, repoOpts, repoUrl } from '../views';
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

function statusIcon(s: Status): string {
  const glyph =
    s === 'success' ? '&check;' : s === 'failure' ? '&times;' : s === 'running' ? '&bull;' : s === 'queued' ? '&#9679;' : '&ndash;';
  return `<span class="run-status ${s}" title="${STATUS_LABEL[s]}" aria-label="${STATUS_LABEL[s]}">${glyph}</span>`;
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
      const when = r.createdAt ? formatDate(r.createdAt) : '';
      const dur = duration(r.startedAt, r.completedAt);
      return `<tr>
<td class="run-cell">${statusIcon(s)}<span><a href="${actionsBase}/runs/${r.number}"><b>${esc(runTitle(r))}</b></a>
<div class="muted small">${esc(r.workflowName)} #${r.number}: ${esc(r.event)} by ${esc(r.actor)}</div></span></td>
<td class="right muted small"><span class="chip">${esc(r.refName)}</span></td>
<td class="right muted small">${esc(when)}${dur ? ` &middot; ${esc(dur)}` : ''}</td>
</tr>`;
    })
    .join('');

  const filterBar = workflows.length
    ? `<div class="wf-filter">${[
        `<a class="${selectedWorkflow === null ? 'current' : ''}" href="${actionsBase}">All workflows</a>`,
        ...workflows.map(
          (w) =>
            `<a class="${selectedWorkflow === w.path ? 'current' : ''}" href="${actionsBase}?workflow=${encodeURIComponent(
              w.path
            )}">${esc(w.name)}</a>`
        ),
      ].join('')}</div>`
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
    : `<div class="empty-state"><p><b>No workflow runs yet.</b></p><p class="muted">Runs appear here when a push matches a workflow in <code>.github/workflows</code> or <code>.hubbit/workflows</code>.</p></div>`;

  const content = `${repoHeader(ctx, 'actions')}
${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
${broken}
<div class="page-head"><h2>Workflow runs</h2>${dispatchForm}</div>
${filterBar}
${body}`;
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
  return `<details class="dispatch">
<summary class="btn">Run workflow</summary>
<div class="dispatch-body">${picker}${panels}</div>
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
<pre class="joblog">${lines.map((l) => esc(l)).join('\n')}</pre>
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
<pre class="joblog">${lines.map((l) => esc(l)).join('\n')}</pre>
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
      const initial = logLines.map((l) => l.l).join('\n');
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
  &middot; ${esc(run.event)} by ${esc(run.actor)}
  &middot; <span class="chip">${esc(run.refName)}</span>
  ${run.sha ? `&middot; <a class="sha" href="${base}/commit/${esc(run.sha)}">${esc(run.sha.slice(0, 7))}</a>` : ''}
  &middot; <a href="${base}/blob/${encPath(run.refName)}/${encPath(run.workflowPath)}">${esc(run.workflowPath)}</a>
  ${run.createdAt ? `&middot; ${esc(formatDate(run.createdAt))}` : ''}
</div>
<div class="run-body">
  <div class="job-list">${jobList}</div>
  <div class="job-detail">${detail}</div>
</div>
${artifactBox}`;
  return layout(`${runTitle(run)} - ${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, runBase));
}

// ---- runners, under Admin ----

export function runnersPage(
  viewer: Viewer,
  runners: { name: string; labels: string[]; allow: string[]; createdBy: string; createdAt: string }[],
  flash?: string,
  error?: string
): string {
  const rows = runners
    .map(
      (r) =>
        `<tr><td><b>${esc(r.name)}</b><div class="muted small">registered by ${esc(r.createdBy)}${
          r.createdAt ? ` on ${esc(formatDate(r.createdAt))}` : ''
        }</div></td>
<td class="small">${r.labels.map((l) => `<span class="chip">${esc(l)}</span>`).join(' ')}</td>
<td class="small mono">${esc(r.allow.join(' '))}</td>
<td class="right"><form method="post" action="/admin/runners/${encodeURIComponent(
          r.name
        )}/remove" onsubmit="return confirm('Remove runner ${esc(r.name)}? It will stop being able to take jobs.')">${csrfField(
          viewer
        )}<button type="submit" class="btn btn-danger-outline">Remove</button></form></td></tr>`
    )
    .join('');
  const content = `<div class="page-head"><h1>Runners</h1><a class="btn" href="/admin">Back to admin</a></div>
${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
${error ? `<div class="form-error">${esc(error)}</div>` : ''}
<p class="muted">A runner is a machine that executes workflow jobs. Jobs never run on the vault's own machine: register a runner, then start it with <code>hubbit runner run</code> somewhere with Docker.</p>
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
  return layout('Runners', content, { viewer, path: '/admin/runners' });
}

export function runnerTokenPage(viewer: Viewer, name: string, token: string, host: string): string {
  const content = `<div class="form-box wide">
<h1>Runner registered</h1>
<p>The token for <b>${esc(name)}</b> is shown once; only its hash is stored.</p>
<div class="token-box"><code>${esc(token)}</code></div>
<h2>Start it</h2>
<p class="muted">On a machine with Docker:</p>
<div class="cmd-row"><code>hubbit runner run --host ${esc(host)} --runner-token ${esc(token)}</code><button class="copy-btn" type="button" onclick="copyCmd(this)">Copy</button></div>
<p class="muted small">Or save it with <code>hubbit runner login</code> once and run <code>hubbit runner run</code> with no arguments afterwards.</p>
<p><a class="btn" href="/admin/runners">Back to runners</a></p>
</div>`;
  return layout('Runner registered', content, { viewer, path: '/admin/runners' });
}

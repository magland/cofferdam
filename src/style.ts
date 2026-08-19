// The structural stylesheet. Every color, radius, and font here comes from a
// custom property defined by the active theme (see themes.ts); nothing in
// this file names a color directly, so a new theme needs no changes here.

export const CSS = `
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: var(--font-ui);
  font-size: 14px;
  line-height: 1.5;
  color: var(--fg);
  background: var(--bg);
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, pre, .mono { font-family: var(--font-mono); }
.container { max-width: 1216px; margin: 0 auto; padding: 0 16px; }
.topbar { background: var(--surface); border-bottom: 1px solid var(--border); }
.topbar .container { display: flex; align-items: center; gap: 12px; height: 52px; }
/* The brand is the logotype from logo.ts, which inherits the text colour. Its
   243 x 60 box runs ascender to baseline with nothing below, and the x-height
   fills the lower two thirds, so 16px here puts the x-height at 10.7px and the
   word at 65px wide. */
.brand { display: flex; align-items: center; color: var(--fg); flex: none; }
.brand svg { display: block; height: 16px; width: auto; }
.brand:hover { text-decoration: none; }
.topbar .crumbs { color: var(--fg-muted); }
.userbox { margin-left: auto; display: flex; align-items: center; gap: 12px; }
.user-menu > summary { display: flex; align-items: center; gap: 2px; }
.user-menu .dropdown-menu { width: 220px; }
.user-menu form { margin: 0; }

/* An identicon in its frame (see avatar.ts): a circle for a person, a rounded
   square for a collection, as GitHub distinguishes people from organizations. */
.avatar { display: inline-flex; flex: none; border-radius: 50%; overflow: hidden; background: var(--surface); }
.avatar.square { border-radius: var(--radius); }
.avatar svg { display: block; width: 100%; height: 100%; }
.with-avatar { display: flex; align-items: center; gap: 8px; }

/* The file finder: one box, and the tree under it. */
.find-input {
  width: 100%; padding: 8px 14px; font-size: 15px; font-family: inherit; margin-bottom: 12px;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--input-bg); color: var(--fg);
}
.find-list { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.find-item {
  display: flex; align-items: center; gap: 8px; padding: 6px 12px; color: var(--fg);
  border-top: 1px solid var(--border-soft); font-family: var(--font-mono); font-size: 12px;
}
.find-item:first-child { border-top: none; }
.find-item:hover { background: var(--surface); text-decoration: none; }
.find-item .icon { margin-right: 0; }

.list-filter {
  width: 320px; max-width: 100%; padding: 5px 12px; font-size: 14px; font-family: inherit;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--input-bg); color: var(--fg);
}
.btn-link { border: none; background: none; padding: 0; font: inherit; color: var(--accent); cursor: pointer; }
.btn-link:hover { text-decoration: underline; }
main { padding: 24px 16px 64px; }
h1 { font-family: var(--font-head); font-size: 22px; margin: 0 0 16px; }
h2 { font-family: var(--font-head); font-size: 18px; }
.muted { color: var(--fg-muted); }
.small { font-size: 12px; }
.page-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.page-head h1, .page-head h2 { margin: 0; }

/* Icons are inline SVG (see icons.ts). text-bottom is what sits a 16px glyph
   on the same baseline as the label beside it; flex:none keeps one from being
   squeezed when it sits in a flex row. */
.octicon { display: inline-block; vertical-align: text-bottom; flex: none; overflow: visible; }

.repo-title { display: flex; align-items: center; gap: 8px; font-size: 18px; margin-bottom: 8px; }
.repo-title .icon { color: var(--fg-muted); margin-right: 0; }
.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); margin-bottom: 16px; overflow-x: auto; }
.tab {
  display: flex; align-items: center; gap: 8px; white-space: nowrap; padding: 8px 12px;
  color: var(--fg); border-bottom: 2px solid transparent; margin-bottom: -1px;
  border-radius: var(--radius) var(--radius) 0 0;
}
.tab .octicon { color: var(--fg-muted); }
.tab:hover { background: var(--surface); text-decoration: none; }
.tab.active { font-weight: 600; border-bottom-color: var(--tab-marker); }
.tab.active .octicon { color: var(--fg); }
.counter { display: inline-block; background: var(--chip-bg); border-radius: 2em; padding: 0 6px; font-size: 12px; color: var(--fg-muted); margin-left: 4px; }
/* The outlined pill GitHub uses for a label on a name: Default, and its kin. */
.badge { display: inline-block; border: 1px solid var(--accent); color: var(--accent); border-radius: 2em; padding: 0 7px; font-size: 12px; line-height: 18px; }
.ref-name { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.ref-name .icon { color: var(--fg-muted); margin-right: 0; }
.ref-name div { flex-basis: 100%; }
.ref-form { padding: 16px; width: 300px; }
.ref-form .field:last-of-type { margin-bottom: 16px; }

.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
/* flex:1 is load-bearing: a wrapping flex container's max-content width is its
   widest item rather than the sum, so without it .left collapses to the ref
   selector and drops the breadcrumb onto a second line. */
.toolbar .left { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; flex: 1 1 auto; min-width: 0; }
.right-group { display: flex; align-items: center; gap: 6px; }
.crumb { font-size: 15px; }
.crumb b { font-weight: 600; }

/* Menus: a <details> whose summary is a button and whose body is a popover.
   The ref picker, the Code button, and the workflow dispatch form all use it. */
.dropdown { position: relative; }
.dropdown > summary { list-style: none; cursor: pointer; }
.dropdown > summary::-webkit-details-marker { display: none; }
.dropdown > summary .caret { opacity: 0.7; }
.dropdown-menu {
  position: absolute; left: 0; z-index: 20; margin-top: 6px; width: 320px; max-width: 92vw;
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: 0 8px 24px var(--shadow); text-align: left; overflow: hidden;
}
.dropdown-menu.dd-right { left: auto; right: 0; }
.dropdown-menu > .cmd-row, .dropdown-menu > p { margin: 10px 12px; }
.dd-section {
  padding: 8px 12px; font-size: 12px; font-weight: 600; color: var(--fg-muted);
  border-bottom: 1px solid var(--border-soft); background: var(--surface);
}
.dd-group + .dd-group .dd-section { border-top: 1px solid var(--border-soft); }
.dd-filter {
  display: block; width: calc(100% - 24px); margin: 10px 12px; padding: 5px 10px; font-size: 13px;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--input-bg); color: var(--fg);
}
.dd-scroll { max-height: 320px; overflow-y: auto; }
.dd-item {
  display: flex; align-items: center; gap: 8px; padding: 7px 12px; color: var(--fg);
  border-top: 1px solid var(--border-soft); font-size: 13px;
}
.dd-item:first-child { border-top: none; }
.dd-item:hover { background: var(--surface); text-decoration: none; }
button.dd-item { width: 100%; background: none; font: inherit; font-size: 13px; cursor: pointer; }
.dd-item.current { font-weight: 600; }
.dd-item .dd-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dd-check { width: 16px; flex: none; color: var(--accent); }
.dd-current { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.clone-menu .cmd-row input {
  flex: 1; min-width: 0; padding: 5px 8px; font-size: 12px; border: 1px solid var(--border);
  border-radius: var(--radius); background: var(--input-bg); color: var(--fg); font-family: var(--font-mono);
}
.btn {
  display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; font-size: 13px;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface);
  color: var(--fg); cursor: pointer; font-family: inherit; line-height: 1.5; white-space: nowrap;
}
.btn:hover { background: var(--surface-hover); text-decoration: none; }
.btn-primary { background: var(--primary); border-color: var(--primary); color: var(--on-primary); font-weight: 600; }
.btn-primary:hover { background: var(--primary-hover); }
.btn-danger { background: var(--danger); border-color: var(--danger); color: var(--on-danger); font-weight: 600; }
.btn-danger:hover { background: var(--danger-hover); }
.btn-danger-outline { color: var(--danger); }
.btn-danger-outline:hover { background: var(--danger); border-color: var(--danger); color: var(--on-danger); }

/* The repository root: the listing beside the About panel, stacking on a
   narrow screen. Every other tree page is one column. */
.repo-layout { display: flex; align-items: flex-start; gap: 24px; }
.repo-main { flex: 1 1 auto; min-width: 0; }
.repo-side { flex: 0 0 296px; }
.side-block { padding-bottom: 16px; margin-bottom: 16px; border-bottom: 1px solid var(--border-soft); }
.side-block:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
.side-block h3 { display: flex; align-items: center; gap: 8px; font-family: var(--font-head); font-size: 15px; margin: 0 0 8px; }
.side-edit { margin-left: auto; color: var(--fg-muted); display: flex; }
.side-edit:hover { color: var(--accent); }
.side-desc { margin: 0 0 12px; }
.side-links { display: flex; flex-direction: column; gap: 8px; }
.side-links a { display: flex; align-items: center; gap: 8px; color: var(--fg); font-size: 13px; }
.side-links a:hover { color: var(--accent); text-decoration: none; }
.side-links .octicon { color: var(--fg-muted); }
@media (max-width: 1000px) {
  .repo-layout { flex-direction: column; }
  .repo-side { flex: 1 1 auto; width: 100%; }
}

table.listing { width: 100%; border-collapse: collapse; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
table.listing th { text-align: left; font-weight: 600; background: var(--surface); padding: 8px 12px; border-bottom: 1px solid var(--border); }
table.listing td { padding: 7px 12px; border-top: 1px solid var(--border-soft); }
table.listing tr:first-child td { border-top: none; }
table.listing tr:hover td { background: var(--surface); }
td.right, th.right { text-align: right; }
.icon { display: inline-block; width: 16px; text-align: center; margin-right: 6px; color: var(--accent-soft); }
.icon.file { color: var(--fg-subtle); }

/* Tree listings: name, then the message and age of the commit that last
   touched the entry. The name column is sized to the content so long file
   names are not truncated, and the message column takes the slack. */
table.listing.tree td.tree-name { width: 1%; white-space: nowrap; }
table.listing.tree td.tree-message { max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
table.listing.tree td.tree-message a { color: var(--fg-muted); }
table.listing.tree td.tree-message a:hover { color: var(--accent); }
table.listing.tree td.tree-age { width: 1%; white-space: nowrap; }
@media (max-width: 700px) {
  table.listing.tree td.tree-message { display: none; }
}

.latest-commit {
  display: flex; justify-content: space-between; gap: 12px; align-items: center; flex-wrap: wrap;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius) var(--radius) 0 0;
  padding: 8px 12px; border-bottom: none;
}
.latest-commit + table.listing { border-radius: 0 0 var(--radius) var(--radius); }
.latest-commit .lc-main { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.latest-commit .lc-main a { color: var(--fg-muted); }
.latest-commit .lc-main a:hover { color: var(--accent); }
.latest-commit .lc-meta { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.lc-history { display: flex; align-items: center; gap: 6px; color: var(--fg); padding-left: 8px; border-left: 1px solid var(--border); }
.lc-history:hover { color: var(--accent); text-decoration: none; }
.lc-history .octicon { color: var(--fg-muted); }

.box { border: 1px solid var(--border); border-radius: var(--radius); margin-top: 24px; }
.box-header {
  display: flex; align-items: center; gap: 8px; background: var(--surface); border-bottom: 1px solid var(--border);
  padding: 8px 12px; font-weight: 600; border-radius: var(--radius) var(--radius) 0 0;
}
.box-header .octicon { color: var(--fg-muted); }
.box-body { padding: 16px 24px; }
.box-header a { color: var(--fg); }
.box-header a:hover { color: var(--accent); text-decoration: none; }

.code-meta {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  border: 1px solid var(--border); border-bottom: none; border-radius: var(--radius) var(--radius) 0 0;
  background: var(--surface); padding: 6px 12px;
}
/* The file view is one element per line, so a line can be linked to and
   highlighted when linked to (#L12). The row is as wide as its content but
   never narrower than the viewport, which is what lets the highlight run the
   full width; the number stays put while the code scrolls under it. */
.code-lines {
  border: 1px solid var(--border); border-radius: 0 0 var(--radius) var(--radius);
  background: var(--code-bg); overflow-x: auto; padding: 8px 0;
  font-family: var(--font-mono); font-size: 12px; line-height: 20px;
}
.cline { display: flex; width: max-content; min-width: 100%; }
.cline:target { background: var(--line-mark); }
.lnum {
  position: sticky; left: 0; z-index: 1; flex: none; width: 56px; padding: 0 12px 0 8px;
  text-align: right; color: var(--fg-subtle); background: var(--code-bg); user-select: none;
}
.lnum:hover { color: var(--fg-muted); text-decoration: none; }
.cline:target .lnum { background: var(--line-mark); color: var(--fg-muted); }
.ltext { white-space: pre; padding: 0 16px 0 4px; }
.blob-image { border: 1px solid var(--border); border-radius: 0 0 var(--radius) var(--radius); padding: 16px; text-align: center; background: var(--code-bg); }
.blob-image img { max-width: 100%; }
.blob-binary { border: 1px solid var(--border); border-radius: 0 0 var(--radius) var(--radius); padding: 32px; text-align: center; color: var(--fg-muted); }
.rendered {
  border: 1px solid var(--border); border-radius: 0 0 var(--radius) var(--radius);
  padding: 20px 32px 28px; background: var(--bg);
}

/* Segmented Preview/Code switch on rendered files. */
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.seg a { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; font-size: 13px; line-height: 1.5; color: var(--fg-muted); background: var(--surface); }
.seg a + a { border-left: 1px solid var(--border); }
.seg a:hover { background: var(--surface-hover); text-decoration: none; }
.seg a.current { background: var(--chip-bg); color: var(--fg); font-weight: 600; }

.commit-row { display: flex; justify-content: space-between; gap: 12px; align-items: center; border: 1px solid var(--border); border-top: none; padding: 8px 12px; }
/* A day's commits are one bordered group under the day's heading. */
.commit-day { display: flex; align-items: center; gap: 8px; font-weight: 600; margin: 20px 0 8px; }
.commit-day .octicon { color: var(--fg-muted); }
.commit-group { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.commit-group .commit-row { border: none; border-top: 1px solid var(--border-soft); }
.commit-group .commit-row:first-child { border-top: none; }
.commit-main { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
.commit-main > span { min-width: 0; }
.commit-row .title { font-weight: 600; color: var(--fg); }
.commit-row .title:hover { color: var(--accent); }
.sha {
  font-family: var(--font-mono); font-size: 12px;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 2px 6px; color: var(--accent);
}
.pagination { display: flex; gap: 8px; justify-content: center; margin-top: 16px; }

.commit-head { border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 16px; }
.commit-head .subject { font-size: 16px; font-weight: 600; padding: 12px 16px 4px; }
.commit-head .body { padding: 0 16px; white-space: pre-wrap; color: var(--fg-muted); font-size: 13px; }
.commit-head .meta { display: flex; flex-wrap: wrap; gap: 16px; padding: 8px 16px 12px; color: var(--fg-muted); font-size: 12px; align-items: center; }

.diff-file { border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 16px; overflow: hidden; }
.diff-file-header {
  background: var(--surface); border-bottom: 1px solid var(--border); padding: 8px 12px; font-weight: 600;
  font-family: var(--font-mono); font-size: 12px;
}
.diff-body { overflow-x: auto; font-family: var(--font-mono); font-size: 12px; line-height: 20px; background: var(--code-bg); }
.dline { white-space: pre; padding: 0 10px; }
.dline.add { background: var(--diff-add); }
.dline.del { background: var(--diff-del); }
.dline.hunk { background: var(--diff-hunk); color: var(--fg-muted); }
.dline.meta { color: var(--fg-subtle); background: var(--diff-meta); }

.markdown-body { font-size: 15px; }
.markdown-body > *:first-child { margin-top: 0; }
.markdown-body > *:last-child { margin-bottom: 0; }
.markdown-body h1, .markdown-body h2, .markdown-body h3 { font-family: var(--font-head); }
.markdown-body h1 { font-size: 1.7em; border-bottom: 1px solid var(--border-soft); padding-bottom: 0.3em; margin: 0.7em 0 0.5em; }
.markdown-body h2 { font-size: 1.4em; border-bottom: 1px solid var(--border-soft); padding-bottom: 0.3em; }
.markdown-body h3 { font-size: 1.15em; }
.markdown-body code { background: var(--inline-code-bg); padding: 0.2em 0.4em; border-radius: var(--radius); font-size: 85%; }
.markdown-body pre { margin: 0; background: var(--surface); padding: 16px; border-radius: var(--radius); overflow-x: auto; }
.markdown-body pre code { background: none; padding: 0; font-size: 12px; }

/* Fenced code: the copy button appears on hover, as on GitHub. */
.markdown-body .code-block { position: relative; margin: 1em 0; }
.markdown-body .code-block .copy-btn { position: absolute; top: 8px; right: 8px; opacity: 0; transition: opacity 0.1s; }
.markdown-body .code-block:hover .copy-btn, .markdown-body .code-block .copy-btn:focus { opacity: 1; }

.heading-anchor { margin-left: 8px; font-weight: 400; color: var(--fg-subtle); opacity: 0; }
.markdown-body h1:hover .heading-anchor, .markdown-body h2:hover .heading-anchor,
.markdown-body h3:hover .heading-anchor, .markdown-body h4:hover .heading-anchor,
.markdown-body h5:hover .heading-anchor, .markdown-body h6:hover .heading-anchor,
.heading-anchor:focus { opacity: 1; text-decoration: none; }

.markdown-body li.task-item { list-style: none; margin-left: -1.3em; }
.markdown-body li.task-item input[type="checkbox"] { margin-right: 6px; }

/* GitHub-style alert callouts: > [!NOTE] and friends. */
.markdown-body blockquote.alert { border-left-color: var(--alert); color: var(--fg); }
.markdown-body .alert-title { font-weight: 600; color: var(--alert); margin: 0 0 4px; }
.markdown-body .alert-note { --alert: var(--accent); }
.markdown-body .alert-tip { --alert: var(--alert-tip); }
.markdown-body .alert-important { --alert: var(--alert-important); }
.markdown-body .alert-warning { --alert: var(--alert-warning); }
.markdown-body .alert-caution { --alert: var(--danger); }

/* Math. Display math scrolls sideways rather than widening the page. */
.markdown-body .math-block { overflow-x: auto; overflow-y: hidden; margin: 1em 0; }
.markdown-body .katex-display { margin: 0; padding: 2px 0; }
.markdown-body .math-error { color: var(--danger); }

.markdown-body .footnotes { font-size: 13px; color: var(--fg-muted); }
.markdown-body .footnotes-sep { margin-top: 32px; }
.markdown-body .footnote-backref { text-decoration: none; }
.markdown-body kbd {
  font-family: var(--font-mono); font-size: 85%; padding: 2px 5px; border: 1px solid var(--border);
  border-bottom-width: 2px; border-radius: var(--radius); background: var(--surface);
}
.markdown-body summary { cursor: pointer; font-weight: 600; }
.markdown-body blockquote { margin: 0; padding-left: 16px; border-left: 4px solid var(--border); color: var(--fg-muted); }
.markdown-body img { max-width: 100%; }
.markdown-body table { border-collapse: collapse; }
.markdown-body table th, .markdown-body table td { border: 1px solid var(--border); padding: 6px 12px; }
.markdown-body table th { background: var(--surface); }
.markdown-body table { display: block; overflow-x: auto; max-width: 100%; }
.markdown-body hr { border: none; border-top: 1px solid var(--border-soft); margin: 24px 0; }
.markdown-body li + li { margin-top: 0.25em; }
.markdown-body h1:target, .markdown-body h2:target, .markdown-body h3:target,
.markdown-body h4:target, .markdown-body h5:target, .markdown-body h6:target { scroll-margin-top: 16px; }

.cmd-row { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
.cmd-row code {
  flex: 1; overflow-x: auto; white-space: pre; padding: 5px 8px; background: var(--input-bg);
  border: 1px solid var(--border); border-radius: var(--radius); font-size: 12px;
}
.copy-btn {
  display: inline-flex; align-items: center; padding: 4px 10px; font-size: 12px; border: 1px solid var(--border);
  border-radius: var(--radius); background: var(--surface); cursor: pointer; color: var(--fg);
  white-space: nowrap; font-family: inherit; line-height: 1.5;
}
.copy-btn:hover { background: var(--surface-hover); }
/* Both faces of the button are in the page; copying swaps which one shows. */
.copy-btn span { display: inline-flex; align-items: center; gap: 6px; }
.copy-btn .copy-done { display: none; color: var(--alert-tip); }
.copy-btn.copied .copy-idle { display: none; }
.copy-btn.copied .copy-done { display: inline-flex; }
/* The command blocks on the empty-repository page: several lines with one
   button, where .cmd-row is one line with one button. */
.cmd-block { display: flex; align-items: flex-start; gap: 8px; margin: 4px 0 20px; }
.cmd-block pre {
  flex: 1; margin: 0; overflow-x: auto; padding: 10px 12px; background: var(--input-bg);
  border: 1px solid var(--border); border-radius: var(--radius); font-size: 12px; line-height: 20px;
}
.setup-head { font-family: var(--font-head); font-size: 15px; margin: 24px 0 8px; }

.empty-state { border: 1px dashed var(--border); border-radius: var(--radius); padding: 48px; text-align: center; color: var(--fg-muted); }
.error-page { text-align: center; padding: 64px 0; color: var(--fg-muted); }
.error-page .code { font-family: var(--font-head); font-size: 48px; font-weight: 700; color: var(--fg); }

/* Sign-in: the mark, a heading, and one narrow card, centred. */
.signin { max-width: 340px; margin: 40px auto; }
.signin-mark svg { display: block; width: 44px; height: 44px; margin: 0 auto 16px; color: var(--fg); }
.signin h1 { font-size: 20px; text-align: center; }
.signin .form-box { padding: 16px; }
.signin .btn { width: 100%; justify-content: center; }
.signin-note { margin: 16px 0 0; text-align: center; }

/* Two fields reading as one address, "collection / name". */
.name-row { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; }
.name-row .field { flex: 1 1 200px; margin-bottom: 0; }
.name-row .field input { width: 100%; }
.name-slash { font-size: 20px; color: var(--fg-muted); padding-bottom: 4px; }
hr.rule { border: none; border-top: 1px solid var(--border-soft); margin: 20px 0; }

/* A label that only a screen reader needs, where the placeholder or the
   surrounding heading already says what the field is. */
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

.form-box { border: 1px solid var(--border); border-radius: var(--radius); padding: 20px 24px; max-width: 620px; }
.form-box.wide { max-width: 880px; }
.form-box h1, .form-box h2 { margin-top: 0; }
.field { margin-bottom: 14px; }
.field label { display: block; font-weight: 600; margin-bottom: 4px; }
.field label.checkbox { font-weight: 400; }
.field p { margin: 4px 0 0; }
input[type="text"], input[type="password"], select {
  width: 100%; max-width: 420px; padding: 5px 12px; font-size: 14px; font-family: inherit;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--input-bg); color: var(--fg);
}
.inline-form input[type="text"], .inline-form select { width: auto; }
input:focus, textarea:focus, select:focus { outline: 2px solid var(--focus); border-color: var(--accent); }
textarea.code-editor {
  width: 100%; padding: 10px 12px; font-size: 12px; line-height: 20px; tab-size: 4;
  font-family: var(--font-mono); border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--input-bg); color: var(--fg); resize: vertical;
}
.commit-box { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); padding: 12px 16px; margin-top: 12px; max-width: 620px; }
.commit-box .field { margin-bottom: 10px; }
.commit-box-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.commit-box input[type="text"], .commit-box textarea { max-width: 100%; }
textarea {
  width: 100%; max-width: 100%; padding: 6px 12px; font-size: 14px; font-family: inherit; line-height: 1.5;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--input-bg); color: var(--fg); resize: vertical;
}
.settings-box { max-width: 760px; }
.settings-box .box-body { padding: 16px 20px; }
.actions { display: flex; gap: 8px; align-items: center; }
.file-head { font-weight: 400; }
.file-head .mono { font-weight: 600; }
.filename-row { display: flex; align-items: center; gap: 4px; }
.filename-row input { flex: 1; }
.inline-form { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 4px 0; }
.inline-form label { display: flex; align-items: center; gap: 6px; color: var(--fg-muted); font-size: 13px; }
.user-actions { padding: 12px; display: flex; flex-direction: column; gap: 10px; width: 380px; }
.user-actions .inline-form { margin: 0; }
.user-actions input[type="text"] { width: 100%; }
.flash { background: var(--ok-bg); border: 1px solid var(--ok-border); border-radius: var(--radius); padding: 8px 12px; margin-bottom: 16px; max-width: 620px; }
.form-error { background: var(--err-bg); border: 1px solid var(--err-border); border-radius: var(--radius); padding: 8px 12px; margin-bottom: 16px; max-width: 620px; }
.danger-zone { border: 1px solid var(--danger); border-radius: var(--radius); padding: 16px 24px; margin-top: 24px; max-width: 620px; }
.danger-zone h3 { margin-top: 0; color: var(--danger); }

/* Administration: the sections down the left, the page beside them. */
.admin-layout { display: flex; align-items: flex-start; gap: 32px; }
.admin-main { flex: 1 1 auto; min-width: 0; }
.admin-side { flex: 0 0 220px; }
.admin-side .side-links a { padding: 6px 8px; border-radius: var(--radius); }
.admin-side .side-links a:hover { background: var(--surface); }
.admin-side .side-links a.current { background: var(--surface); font-weight: 600; }
@media (max-width: 800px) {
  .admin-layout { flex-direction: column; gap: 16px; }
  .admin-side { flex: 1 1 auto; width: 100%; }
}
.with-avatar-row { display: flex; align-items: flex-start; gap: 8px; }
.with-avatar-row .icon { margin-right: 0; color: var(--fg-muted); }

.card-list { display: flex; flex-direction: column; gap: 12px; margin-bottom: 20px; max-width: 760px; }
.card-list a.card { display: block; border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 16px; color: var(--fg); }
.card-list a.card:hover { background: var(--surface); text-decoration: none; }
.card-list a.card b { display: block; }

.theme-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; margin-bottom: 20px; }
.theme-card { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.theme-card.current { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.theme-card label { display: block; cursor: pointer; }
.theme-swatch { padding: 12px 14px; border-bottom: 1px solid var(--border); }
.theme-swatch .bar { height: 8px; border-radius: 4px; margin-bottom: 8px; }
.theme-swatch .row { display: flex; gap: 6px; align-items: center; }
.theme-swatch .dot { width: 16px; height: 16px; border-radius: 50%; }
.theme-meta { padding: 10px 14px; }
.theme-meta .name { font-weight: 600; display: flex; align-items: center; gap: 8px; }
.theme-meta p { margin: 4px 0 0; }

/* --- Actions: runs, jobs, logs --- */
.chip { display: inline-block; background: var(--chip-bg); border-radius: 2em; padding: 1px 8px; font-size: 12px; color: var(--fg-muted); }
.run-status { display: inline-flex; align-items: center; justify-content: center; flex: none; }
.run-status.success { color: var(--alert-tip); }
.run-status.failure { color: var(--danger); }
/* A run in progress turns, as it does on GitHub; a reader who has motion
   turned off gets the same amber ring, still. */
.run-status.running { color: var(--alert-warning); }
.run-status.running .octicon { animation: spin 1.4s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .run-status.running .octicon { animation: none; } }
.run-status.queued { color: var(--fg-subtle); }
.run-status.cancelled, .run-status.skipped { color: var(--fg-subtle); }
.listing.runs td.run-cell { display: flex; align-items: flex-start; gap: 10px; }
.listing.runs td.run-cell > span { min-width: 0; }
/* The runs, with the repository's workflows listed down the side. */
.actions-layout { display: flex; align-items: flex-start; gap: 24px; }
.actions-main { flex: 1 1 auto; min-width: 0; }
.wf-side { flex: 0 0 240px; }
.wf-side .side-links a { padding: 5px 8px; border-radius: var(--radius); }
.wf-side .side-links a:hover { background: var(--surface); }
.wf-side .side-links a.current { background: var(--surface); font-weight: 600; }
.wf-side .side-links a span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 900px) {
  .actions-layout { flex-direction: column; }
  .wf-side { flex: 1 1 auto; width: 100%; }
}
.run-sub { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.chip .octicon { vertical-align: text-bottom; margin-right: 2px; }
.dispatch-body { padding: 16px; }
.run-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.run-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
.run-title h2 { margin: 0; }
.run-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 6px 0 16px; }
.run-actor { display: inline-flex; align-items: center; gap: 4px; }
.run-body { display: flex; gap: 20px; align-items: flex-start; }
.job-list { flex: 0 0 240px; display: flex; flex-direction: column; gap: 2px; }
.job-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--radius); color: var(--fg); }
.job-item:hover { background: var(--surface); text-decoration: none; }
.job-item.current { background: var(--surface); font-weight: 600; }
.job-item > span:first-of-type { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.job-detail { flex: 1; min-width: 0; }
.job-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.step { border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 6px; overflow: hidden; }
.step > summary { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; background: var(--surface); }
.step > summary .step-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.joblog { background: var(--code-bg); color: var(--fg); font-family: var(--font-mono); font-size: 12px; line-height: 1.5; padding: 10px 12px; margin: 0; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
.step .joblog { border-top: 1px solid var(--border); }
.joblog.live { border: 1px solid var(--border); border-radius: var(--radius); max-height: 70vh; overflow-y: auto; }
@media (max-width: 700px) {
  .run-body { flex-direction: column; }
  .job-list { flex: 1 1 auto; width: 100%; }
}

.artifacts { margin-top: 20px; max-width: 620px; }
.artifacts .box-body { display: flex; flex-direction: column; gap: 6px; }
.artifacts a.artifact { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius); color: var(--fg); }
.artifacts a.artifact:hover { background: var(--surface); text-decoration: none; }
.artifacts p { margin: 4px 0 0; }

/* --- history: a commit row carries actions on its right --- */
.commit-main .title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.commit-actions { display: flex; align-items: center; gap: 6px; flex: none; }
.commit-actions .btn { padding: 4px 8px; }

/* --- blame: the file view with a commit column down its left --- */
.blame {
  border: 1px solid var(--border); border-radius: 0 0 var(--radius) var(--radius);
  background: var(--code-bg); overflow-x: auto;
  font-family: var(--font-mono); font-size: 12px; line-height: 20px;
}
.blame-row { display: flex; width: max-content; min-width: 100%; }
.blame-row:target { background: var(--line-mark); }
/* A run of lines from one commit reads as a block, so only its first row
   names the commit and only its first row carries the rule above it. */
.blame-row.blame-start { border-top: 1px solid var(--border-soft); }
.blame-row:first-child { border-top: none; }
.blame-commit {
  position: sticky; left: 0; z-index: 1; flex: none; display: flex; align-items: center; gap: 6px;
  width: 320px; padding: 0 10px; overflow: hidden; background: var(--surface);
  border-right: 1px solid var(--border); font-family: var(--font-ui);
}
.blame-subject { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); font-size: 12px; }
.blame-when { flex: none; white-space: nowrap; }
.blame-when time { color: inherit; }
.blame-prior { flex: none; display: flex; color: var(--fg-subtle); }
.blame-prior:hover { color: var(--accent); }
/* The commit column and the numbers both stay put while the code scrolls
   under them, so the number sits at exactly the column's width. */
.blame .lnum { left: 320px; }
@media (max-width: 700px) {
  .blame-commit { width: 180px; }
  .blame .lnum { left: 180px; }
  .blame-when { display: none; }
}

/* --- diffs: the numbers down each side, and the shape of the change. These
   rules come after the base .dline and .diff-file-header ones and refine
   them, rather than editing them in place. --- */
.diff-summary { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.stat-add { color: var(--alert-tip); font-weight: 600; font-size: 12px; }
.stat-del { color: var(--danger); font-weight: 600; font-size: 12px; margin-left: 6px; }
/* Five squares in the proportion of the change, as on GitHub. */
.statbar { display: inline-flex; gap: 2px; margin-left: 8px; }
.statbar .sq { width: 8px; height: 8px; border-radius: 2px; background: var(--chip-bg); }
.statbar .sq.add { background: var(--alert-tip); }
.statbar .sq.del { background: var(--danger); }
details.diff-file > summary.diff-file-header {
  display: flex; align-items: center; gap: 8px; cursor: pointer; list-style: none; font-family: var(--font-ui);
}
details.diff-file > summary::-webkit-details-marker { display: none; }
.diff-file-header .fold { color: var(--fg-muted); transition: transform 0.1s; }
details.diff-file:not([open]) .fold { transform: rotate(-90deg); }
details.diff-file:not([open]) > summary.diff-file-header { border-bottom: none; }
.diff-path { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.diff-file-stat { flex: none; display: flex; align-items: center; }
.diff-none { padding: 16px; }
.dline { display: flex; padding: 0; width: max-content; min-width: 100%; }
/* The numbers stay put while a long line scrolls under them; inheriting the
   background keeps an added or removed line's colour behind its number. */
.dnum {
  position: sticky; flex: none; width: 44px; padding: 0 6px; text-align: right;
  color: var(--fg-subtle); user-select: none; background: inherit;
}
.dline .dnum:first-child { left: 0; }
.dline .dnum:nth-child(2) { left: 44px; box-shadow: 1px 0 0 var(--border-soft); }
.dtext { white-space: pre; padding: 0 10px; flex: 1 1 auto; }
@media (max-width: 700px) {
  .dnum { width: 34px; }
  .dline .dnum:nth-child(2) { left: 34px; }
}

/* --- Languages: the share bar in the About panel. Each segment's colour is
   inline rather than here, because a language's colour belongs to the language
   (it is Linguist's) and not to the theme; the table in languages.ts is where
   they live. Only the shape is this file's business. --- */
.lang-bar { display: flex; height: 8px; border-radius: 6px; overflow: hidden; background: var(--border-soft); margin-bottom: 12px; }
.lang-seg { display: block; height: 100%; }
.lang-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.lang-list li { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.lang-dot { flex: none; width: 10px; height: 10px; border-radius: 50%; }
.lang-name { font-weight: 600; }
.lang-pct { margin-left: auto; }

/* --- search: the box in the repository header, and the results --- */
.repo-search { margin-left: auto; }
.search-form { position: relative; display: flex; align-items: center; }
.repo-search, .search-form { position: relative; }
.search-input {
  width: 260px; max-width: 100%; padding: 5px 10px 5px 30px; font-size: 13px; font-family: inherit;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--input-bg); color: var(--fg);
}
.search-form .search-input { width: 360px; }
.search-glyph { position: absolute; left: 8px; top: 50%; margin-top: -8px; color: var(--fg-muted); pointer-events: none; }
.search-file { margin-top: 16px; }
.search-file .box-header a { font-family: var(--font-mono); font-size: 12px; }
.search-hits { background: var(--code-bg); border-radius: 0 0 var(--radius) var(--radius); overflow-x: auto; }
.search-hit {
  display: flex; gap: 12px; padding: 2px 12px; color: var(--fg);
  font-family: var(--font-mono); font-size: 12px; line-height: 20px;
}
.search-hit:hover { background: var(--surface); text-decoration: none; }
.search-hit .lnum { flex: none; width: 44px; text-align: right; color: var(--fg-subtle); position: static; }
.search-hit .ltext { white-space: pre; padding: 0; }
.search-hit mark { background: var(--line-mark); color: inherit; font-weight: 600; }
.search-more { display: block; padding: 6px 12px; font-size: 12px; border-top: 1px solid var(--border-soft); }
@media (max-width: 860px) {
  .repo-search { display: none; }
  .search-form .search-input { width: 100%; }
}

/* --- comparing two revisions --- */
.cmp-form { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
.cmp-picker { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--fg-muted); }
.cmp-picker select { width: auto; max-width: 220px; padding: 4px 8px; font-size: 13px; }
.cmp-status {
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface);
  padding: 10px 12px; margin-bottom: 16px;
}
.cmp-commits { margin-bottom: 20px; }

/* --- contributors, and a filter the reader can take off --- */
.contributors { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.contributor { display: inline-flex; }
.contributor:hover { text-decoration: none; opacity: 0.85; }
.filter-chip {
  display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; font-size: 12px;
  border: 1px solid var(--border); border-radius: 2em; background: var(--surface); color: var(--fg);
}
.filter-chip .octicon { color: var(--fg-muted); }
.filter-chip a { display: inline-flex; color: var(--fg-muted); }
.filter-chip a:hover { color: var(--danger); }

/* --- issues: the list, one issue and its thread --- */
.state-filter { display: flex; gap: 4px; flex-wrap: wrap; }
.state-tab { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: var(--radius); color: var(--fg-muted); font-size: 13px; }
.state-tab:hover { background: var(--surface); text-decoration: none; }
.state-tab.current { color: var(--fg); font-weight: 600; }
.state-tab .octicon { color: var(--fg-muted); }
/* Open is green and closed is purple, the colours GitHub taught for these. */
.octicon.issue-open { color: var(--alert-tip); }
.octicon.issue-closed { color: var(--alert-important); }
table.listing.issues td.issue-cell { display: flex; align-items: flex-start; gap: 10px; }
table.listing.issues td.issue-cell > span { min-width: 0; }
.issue-link { color: var(--fg); font-weight: 600; }
.issue-link:hover { color: var(--accent); text-decoration: none; }
.chip.label { margin-left: 6px; }
.issue-comments { display: inline-flex; align-items: center; gap: 4px; color: var(--fg-muted); }
.issue-comments:hover { color: var(--accent); text-decoration: none; }

.issue-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.issue-title { font-size: 24px; margin: 0 0 8px; }
.issue-sub {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding-bottom: 12px; border-bottom: 1px solid var(--border); margin-bottom: 20px;
}
.state-badge {
  display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 2em;
  font-size: 13px; font-weight: 600; color: var(--on-primary); background: var(--alert-tip);
}
.state-badge.closed { background: var(--alert-important); }
.issue-thread { display: flex; flex-direction: column; gap: 16px; max-width: 880px; }
.issue-comment { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.issue-comment-head {
  display: flex; align-items: center; gap: 8px; background: var(--surface);
  border-bottom: 1px solid var(--border); padding: 8px 12px;
}
.issue-comment-body { padding: 16px 20px; }
.issue-event { display: flex; align-items: center; gap: 8px; color: var(--fg-muted); font-size: 13px; }
.issue-reply { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.issue-reply .issue-comment-head { border-bottom: 1px solid var(--border); }
.issue-reply textarea { border: none; border-radius: 0; }
.issue-reply .actions { padding: 10px 12px; justify-content: flex-end; border-top: 1px solid var(--border); }

/* --- releases: notes attached to a tag --- */
.release { display: flex; gap: 24px; align-items: flex-start; padding: 20px 0; border-top: 1px solid var(--border-soft); }
.release:first-of-type { border-top: none; }
.release-side { flex: 0 0 200px; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.release-tag { display: inline-flex; align-items: center; gap: 6px; color: var(--fg); font-size: 15px; }
.release-tag .octicon { color: var(--fg-muted); }
.release-main { flex: 1 1 auto; min-width: 0; }
.release-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.release-head h2 { margin: 0; }
.release-head h2 a { color: var(--fg); }
.release-actions { margin-left: auto; }
.chip-latest { background: var(--primary); color: var(--on-primary); font-weight: 600; }
.chip-pre { background: transparent; border: 1px solid var(--alert-warning); color: var(--alert-warning); }
.release-notes { margin: 12px 0 16px; }
.release-downloads { display: flex; flex-direction: column; gap: 6px; max-width: 320px; }
.release-download { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius); color: var(--fg); font-size: 13px; }
.release-download:hover { background: var(--surface); text-decoration: none; }
.release-download .octicon { color: var(--fg-muted); }
@media (max-width: 860px) {
  .release { flex-direction: column; gap: 8px; }
  .release-side { flex: 1 1 auto; flex-direction: row; align-items: center; }
}

/* --- forks --- */
.fork-note { display: flex; align-items: center; gap: 6px; margin: -4px 0 8px 24px; }
.fork-note .octicon { color: var(--fg-subtle); }

/* --- the commit box's branch choice --- */
.commit-target { border-top: 1px solid var(--border); margin-top: 10px; padding-top: 10px; }
.commit-target .field { margin: 8px 0 4px; }
.commit-target p { margin: 0; }

/* --- pull requests: the merge box, and the branch pair. Merged is drawn in
   the purple each theme already carries for an important callout, which is
   the same purple GitHub uses for a merged pull request. --- */
.cmp-status { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.state-badge.merged { background: var(--alert-important); border-color: var(--alert-important); color: var(--on-primary); }
.pull-merged { color: var(--alert-important); }
.merge-box {
  display: flex; align-items: flex-start; gap: 12px; margin: 16px 0;
  border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; background: var(--surface);
}
.merge-box > .octicon { margin-top: 2px; }
.merge-box form { margin-left: auto; }
.merge-do { display: flex; align-items: center; gap: 8px; }
.merge-method select { width: auto; padding: 4px 8px; font-size: 13px; }
.merge-box.clean > .octicon { color: var(--alert-tip); }
.merge-box.conflict > .octicon { color: var(--danger); }
.merge-box.merged > .octicon { color: var(--alert-important); }
.merge-box.closed > .octicon, .merge-box.unknown > .octicon { color: var(--fg-muted); }
.merge-conflicts { margin: 6px 0 0; padding-left: 18px; font-size: 12px; color: var(--fg-muted); }
.pull-commits { display: flex; flex-direction: column; }
.pull-commits .commit-row { border: none; border-top: 1px solid var(--border-soft); padding: 8px 0; }
.pull-commits .commit-row:first-child { border-top: none; }
.pull-files { margin: 24px 0 12px; font-size: 16px; }

/* --- narrowing a list of issues --- */
.issue-filters { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.issue-search { position: relative; }
.issue-search .search-input { width: 320px; max-width: 100%; }
/* A label chip is a link when it narrows the list, and keeps its own colour
   rather than the link colour. */
a.chip.label:hover { text-decoration: none; filter: brightness(1.1); }
.issue-filters .dropdown-menu { width: 260px; }
.issue-filters .dd-item .muted { margin-left: auto; }
@media (max-width: 700px) {
  .issue-search .search-input { width: 100%; }
  .issue-filters { flex-direction: column; align-items: stretch; }
}
`;

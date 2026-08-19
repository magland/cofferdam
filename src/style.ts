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
.userbox .user-name { font-weight: 600; }
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
.commit-row:first-of-type { border-top: 1px solid var(--border); border-radius: var(--radius) var(--radius) 0 0; }
.commit-row:last-of-type { border-radius: 0 0 var(--radius) var(--radius); }
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
.empty-cmds { max-width: 520px; margin: 12px auto; text-align: left; }

.empty-state { border: 1px dashed var(--border); border-radius: var(--radius); padding: 48px; text-align: center; color: var(--fg-muted); }
.error-page { text-align: center; padding: 64px 0; color: var(--fg-muted); }
.error-page .code { font-family: var(--font-head); font-size: 48px; font-weight: 700; color: var(--fg); }

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
.actions { display: flex; gap: 8px; align-items: center; }
.file-head { font-weight: 400; }
.file-head .mono { font-weight: 600; }
.filename-row { display: flex; align-items: center; gap: 4px; }
.filename-row input { flex: 1; }
.inline-form { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 4px 0; }
.inline-form label { display: flex; align-items: center; gap: 6px; color: var(--fg-muted); font-size: 13px; }
.user-actions { padding: 8px 0 4px; }
.flash { background: var(--ok-bg); border: 1px solid var(--ok-border); border-radius: var(--radius); padding: 8px 12px; margin-bottom: 16px; max-width: 620px; }
.form-error { background: var(--err-bg); border: 1px solid var(--err-border); border-radius: var(--radius); padding: 8px 12px; margin-bottom: 16px; max-width: 620px; }
.danger-zone { border: 1px solid var(--danger); border-radius: var(--radius); padding: 16px 24px; margin-top: 24px; max-width: 620px; }
.danger-zone h3 { margin-top: 0; color: var(--danger); }

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
.run-status { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; min-width: 18px; border-radius: 50%; font-size: 12px; line-height: 1; border: 1px solid currentColor; }
.run-status.success { color: var(--alert-tip); }
.run-status.failure { color: var(--danger); }
.run-status.running { color: var(--alert-warning); }
.run-status.queued { color: var(--fg-subtle); }
.run-status.cancelled, .run-status.skipped { color: var(--fg-subtle); }
.listing.runs td.run-cell { display: flex; align-items: flex-start; gap: 10px; }
.listing.runs td.run-cell > span { min-width: 0; }
.wf-filter { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 12px; }
.wf-filter a { padding: 4px 10px; border: 1px solid var(--border); border-radius: 2em; color: var(--fg-muted); font-size: 13px; }
.wf-filter a:hover { background: var(--surface); text-decoration: none; }
.wf-filter a.current { color: var(--fg); border-color: var(--accent); font-weight: 600; }
.dispatch-body { padding: 16px; }
.run-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.run-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
.run-title h2 { margin: 0; }
.run-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 6px 0 16px; }
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
.commit-main { min-width: 0; }
.commit-main .title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.commit-actions { display: flex; align-items: center; gap: 6px; flex: none; }
.commit-actions .btn { padding: 4px 8px; }
`;

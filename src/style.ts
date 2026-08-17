export const CSS = `
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: #1f2328;
  background: #ffffff;
}
a { color: #0969da; text-decoration: none; }
a:hover { text-decoration: underline; }
code, pre, .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; }
.container { max-width: 1080px; margin: 0 auto; padding: 0 16px; }
.topbar { background: #f6f8fa; border-bottom: 1px solid #d0d7de; }
.topbar .container { display: flex; align-items: center; gap: 12px; height: 52px; }
.brand { font-weight: 700; font-size: 16px; color: #1f2328; }
.brand:hover { text-decoration: none; }
.topbar .crumbs { color: #57606a; }
.userbox { margin-left: auto; display: flex; align-items: center; gap: 12px; }
.userbox .user-name { font-weight: 600; }
.btn-link { border: none; background: none; padding: 0; font: inherit; color: #0969da; cursor: pointer; }
.btn-link:hover { text-decoration: underline; }
main { padding: 24px 16px 64px; }
h1 { font-size: 22px; margin: 0 0 16px; }
h2 { font-size: 18px; }
.muted { color: #57606a; }
.small { font-size: 12px; }
.page-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.page-head h1, .page-head h2 { margin: 0; }

.repo-title { font-size: 18px; margin-bottom: 8px; }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid #d0d7de; margin-bottom: 16px; }
.tab { padding: 8px 14px; color: #57606a; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tab:hover { color: #1f2328; text-decoration: none; }
.tab.active { color: #1f2328; font-weight: 600; border-bottom-color: #fd8c73; }
.counter { display: inline-block; background: rgba(175,184,193,0.2); border-radius: 2em; padding: 0 6px; font-size: 12px; color: #57606a; margin-left: 4px; }

.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.toolbar .left { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.right-group { display: flex; align-items: center; gap: 6px; }
.ref-select { padding: 4px 8px; border: 1px solid #d0d7de; border-radius: 6px; background: #f6f8fa; font-size: 13px; }
.crumb { font-size: 15px; }
.crumb b { font-weight: 600; }
.clone-box { display: flex; align-items: center; gap: 6px; }
.clone-box input {
  width: 320px; padding: 4px 8px; font-size: 12px; border: 1px solid #d0d7de;
  border-radius: 6px; background: #f6f8fa; color: #1f2328;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.btn {
  display: inline-block; padding: 4px 12px; font-size: 13px; border: 1px solid #d0d7de;
  border-radius: 6px; background: #f6f8fa; color: #1f2328; cursor: pointer;
  font-family: inherit; line-height: 1.5;
}
.btn:hover { background: #eef1f4; text-decoration: none; }
.btn-primary { background: #1f883d; border-color: #1f883d; color: #ffffff; font-weight: 600; }
.btn-primary:hover { background: #1a7f37; }
.btn-danger { background: #cf222e; border-color: #cf222e; color: #ffffff; font-weight: 600; }
.btn-danger:hover { background: #a40e26; }
.btn-danger-outline { color: #cf222e; }
.btn-danger-outline:hover { background: #cf222e; border-color: #cf222e; color: #ffffff; }

table.listing { width: 100%; border-collapse: collapse; border: 1px solid #d0d7de; border-radius: 6px; overflow: hidden; }
table.listing th { text-align: left; font-weight: 600; background: #f6f8fa; padding: 8px 12px; border-bottom: 1px solid #d0d7de; }
table.listing td { padding: 7px 12px; border-top: 1px solid #d8dee4; }
table.listing tr:first-child td { border-top: none; }
table.listing tr:hover td { background: #f6f8fa; }
td.right, th.right { text-align: right; }
.icon { display: inline-block; width: 16px; text-align: center; margin-right: 6px; color: #54aeff; }
.icon.file { color: #636c76; }

.latest-commit {
  display: flex; justify-content: space-between; gap: 12px; align-items: baseline;
  background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px 6px 0 0;
  padding: 8px 12px; border-bottom: none;
}
.latest-commit + table.listing { border-radius: 0 0 6px 6px; }

.box { border: 1px solid #d0d7de; border-radius: 6px; margin-top: 24px; }
.box-header { background: #f6f8fa; border-bottom: 1px solid #d0d7de; padding: 8px 12px; font-weight: 600; border-radius: 6px 6px 0 0; }
.box-body { padding: 16px 24px; }

.code-wrap { display: flex; border: 1px solid #d0d7de; border-radius: 0 0 6px 6px; overflow: hidden; }
.code-meta {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  border: 1px solid #d0d7de; border-bottom: none; border-radius: 6px 6px 0 0;
  background: #f6f8fa; padding: 6px 12px;
}
.gutter {
  margin: 0; padding: 10px 4px 10px 10px; text-align: right; color: #6e7781;
  user-select: none; font-size: 12px; line-height: 20px; background: #ffffff;
}
pre.codeview { margin: 0; padding: 10px 16px; overflow-x: auto; flex: 1; font-size: 12px; line-height: 20px; }
.blob-image { border: 1px solid #d0d7de; border-radius: 0 0 6px 6px; padding: 16px; text-align: center; }
.blob-image img { max-width: 100%; }
.blob-binary { border: 1px solid #d0d7de; border-radius: 0 0 6px 6px; padding: 32px; text-align: center; color: #57606a; }

.commit-row { display: flex; justify-content: space-between; gap: 12px; align-items: center; border: 1px solid #d0d7de; border-top: none; padding: 8px 12px; }
.commit-row:first-of-type { border-top: 1px solid #d0d7de; border-radius: 6px 6px 0 0; }
.commit-row:last-of-type { border-radius: 0 0 6px 6px; }
.commit-row .title { font-weight: 600; color: #1f2328; }
.commit-row .title:hover { color: #0969da; }
.sha {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px;
  background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 2px 6px; color: #0969da;
}
.pagination { display: flex; gap: 8px; justify-content: center; margin-top: 16px; }

.commit-head { border: 1px solid #d0d7de; border-radius: 6px; margin-bottom: 16px; }
.commit-head .subject { font-size: 16px; font-weight: 600; padding: 12px 16px 4px; }
.commit-head .body { padding: 0 16px; white-space: pre-wrap; color: #57606a; font-size: 13px; }
.commit-head .meta { display: flex; flex-wrap: wrap; gap: 16px; padding: 8px 16px 12px; color: #57606a; font-size: 12px; align-items: center; }

.diff-file { border: 1px solid #d0d7de; border-radius: 6px; margin-bottom: 16px; overflow: hidden; }
.diff-file-header {
  background: #f6f8fa; border-bottom: 1px solid #d0d7de; padding: 8px 12px; font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px;
}
.diff-body { overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 20px; }
.dline { white-space: pre; padding: 0 10px; }
.dline.add { background: #e6ffec; }
.dline.del { background: #ffebe9; }
.dline.hunk { background: #ddf4ff; color: #57606a; }
.dline.meta { color: #6e7781; background: #fafbfc; }

.markdown-body { font-size: 15px; }
.markdown-body h1 { font-size: 1.7em; border-bottom: 1px solid #d8dee4; padding-bottom: 0.3em; margin: 0.7em 0 0.5em; }
.markdown-body h2 { font-size: 1.4em; border-bottom: 1px solid #d8dee4; padding-bottom: 0.3em; }
.markdown-body h3 { font-size: 1.15em; }
.markdown-body code { background: rgba(175,184,193,0.2); padding: 0.2em 0.4em; border-radius: 6px; font-size: 85%; }
.markdown-body pre { background: #f6f8fa; padding: 16px; border-radius: 6px; overflow-x: auto; }
.markdown-body pre code { background: none; padding: 0; font-size: 12px; }
.markdown-body blockquote { margin: 0; padding-left: 16px; border-left: 4px solid #d0d7de; color: #57606a; }
.markdown-body img { max-width: 100%; }
.markdown-body table { border-collapse: collapse; }
.markdown-body table th, .markdown-body table td { border: 1px solid #d0d7de; padding: 6px 12px; }
.markdown-body table th { background: #f6f8fa; }

.cmd-row { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
.cmd-row code {
  flex: 1; overflow-x: auto; white-space: pre; padding: 5px 8px; background: #ffffff;
  border: 1px solid #d0d7de; border-radius: 6px; font-size: 12px;
}
.copy-btn {
  padding: 4px 10px; font-size: 12px; border: 1px solid #d0d7de; border-radius: 6px;
  background: #f6f8fa; cursor: pointer; color: #1f2328; white-space: nowrap;
}
.copy-btn:hover { background: #eef1f4; }
.empty-cmds { max-width: 520px; margin: 12px auto; text-align: left; }

.empty-state { border: 1px dashed #d0d7de; border-radius: 6px; padding: 48px; text-align: center; color: #57606a; }
.error-page { text-align: center; padding: 64px 0; color: #57606a; }
.error-page .code { font-size: 48px; font-weight: 700; color: #1f2328; }

.form-box { border: 1px solid #d0d7de; border-radius: 6px; padding: 20px 24px; max-width: 620px; }
.form-box h1, .form-box h2 { margin-top: 0; }
.field { margin-bottom: 14px; }
.field label { display: block; font-weight: 600; margin-bottom: 4px; }
.field label.checkbox { font-weight: 400; }
.field p { margin: 4px 0 0; }
input[type="text"], input[type="password"], select {
  width: 100%; max-width: 420px; padding: 5px 12px; font-size: 14px; font-family: inherit;
  border: 1px solid #d0d7de; border-radius: 6px; background: #ffffff; color: #1f2328;
}
.inline-form input[type="text"], .inline-form select { width: auto; }
input:focus, textarea:focus, select:focus { outline: 2px solid #0969da33; border-color: #0969da; }
textarea.code-editor {
  width: 100%; padding: 10px 12px; font-size: 12px; line-height: 20px; tab-size: 4;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  border: 1px solid #d0d7de; border-radius: 6px; background: #ffffff; color: #1f2328; resize: vertical;
}
.commit-box { border: 1px solid #d0d7de; border-radius: 6px; background: #f6f8fa; padding: 12px 16px; margin-top: 12px; max-width: 620px; }
.commit-box .field { margin-bottom: 10px; }
.commit-box input[type="text"] { background: #ffffff; }
.actions { display: flex; gap: 8px; align-items: center; }
.file-head { font-weight: 400; }
.file-head .mono { font-weight: 600; }
.filename-row { display: flex; align-items: center; gap: 4px; }
.filename-row input { flex: 1; }
.inline-form { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 4px 0; }
.inline-form label { display: flex; align-items: center; gap: 6px; color: #57606a; font-size: 13px; }
.user-actions { padding: 8px 0 4px; }
.flash { background: #dafbe1; border: 1px solid #1f883d55; border-radius: 6px; padding: 8px 12px; margin-bottom: 16px; max-width: 620px; }
.form-error { background: #ffebe9; border: 1px solid #cf222e55; border-radius: 6px; padding: 8px 12px; margin-bottom: 16px; max-width: 620px; }
.danger-zone { border: 1px solid #cf222e66; border-radius: 6px; padding: 16px 24px; margin-top: 24px; max-width: 620px; }
.danger-zone h3 { margin-top: 0; color: #cf222e; }
`;

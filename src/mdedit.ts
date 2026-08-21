import { Html, html, joinHtml } from './html';
import { IconName, icon } from './icons';
import { RepoCtx, repoUrl } from './views';

// The markdown editor: the writing surface every issue, comment, pull request,
// release, and markdown file shares.
//
// The shape is GitHub's, because that is the shape people know: Write and
// Preview tabs over the field, and a toolbar that writes markdown into it.
// The rendering is not imitated, though; the toolbar draws with the vault's
// own icon set and sits in the vault's own chrome, and the preview comes from
// the same server-side pipeline that renders the saved page, so what the tab
// shows is exactly what saving will show, cross-references and all. The
// toolbar is a convenience over a plain textarea, not a requirement: with
// script off the field still submits, and only the tabs and buttons are gone.
//
// The endpoint the Preview tab posts to is registered in webops.ts with the
// other repository POSTs; this module is markup only, so the form pages can
// import it without pulling the route layer in.

export interface MdEditorOpts {
  /** The form field the textarea posts as. */
  name: string;
  /** Where the Preview tab posts the draft; previewUrl(ctx) for repo pages. */
  preview: string;
  rows: number;
  id?: string;
  value?: string;
  placeholder?: string;
  /** The ref relative links in the preview resolve against; the default branch otherwise. */
  ref?: string;
  /** The directory they resolve in, for a file being edited somewhere below the root. */
  dir?: string;
  /**
   * Style and behave as the file editor: monospace, Tab indents. For prose
   * fields the textarea is the ordinary kind and Tab moves focus on.
   */
  codeEditor?: boolean;
}

export function previewUrl(ctx: RepoCtx): string {
  return `${repoUrl(ctx)}/preview`;
}

export function markdownEditor(o: MdEditorOpts): Html {
  const btn = (act: string, glyph: IconName, title: string) =>
    html`<button type="button" class="md-btn" data-md-act="${act}" title="${title}" aria-label="${title}" tabindex="-1">${icon(
      glyph
    )}</button>`;
  const groups: Html[] = [
    html`<span class="md-group">${btn('heading', 'heading', 'Heading')}${btn('bold', 'bold', 'Bold (Ctrl+B)')}${btn(
      'italic',
      'italic',
      'Italic (Ctrl+I)'
    )}${btn('strike', 'strikethrough', 'Strikethrough')}</span>`,
    html`<span class="md-group">${btn('quote', 'quote', 'Quote')}${btn('code', 'code', 'Code (Ctrl+E)')}${btn(
      'link',
      'link',
      'Link (Ctrl+K)'
    )}</span>`,
    html`<span class="md-group">${btn('ul', 'list-unordered', 'Bulleted list')}${btn(
      'ol',
      'list-ordered',
      'Numbered list'
    )}${btn('task', 'tasklist', 'Task list')}</span>`,
  ];
  return html`<div class="md-editor" data-md-editor data-md-preview="${o.preview}"${
    o.ref ? html` data-md-ref="${o.ref}"` : ''
  }${o.dir ? html` data-md-dir="${o.dir}"` : ''}>
<div class="md-head">
<div class="md-tabs" role="tablist">
<button type="button" class="md-tab current" data-md-pane="write" role="tab" aria-selected="true">Write</button>
<button type="button" class="md-tab" data-md-pane="preview" role="tab" aria-selected="false">Preview</button>
</div>
<div class="md-toolbar" role="toolbar" aria-label="Formatting">${joinHtml(groups)}</div>
</div>
<textarea class="${o.codeEditor ? 'code-editor ' : ''}md-input" name="${o.name}"${
    o.id ? html` id="${o.id}"` : ''
  } rows="${String(o.rows)}"${o.placeholder ? html` placeholder="${o.placeholder}"` : ''}${
    o.codeEditor ? html` spellcheck="false"` : ''
  }>${o.value ?? ''}</textarea>
<div class="md-render markdown-body" hidden></div>
</div>`;
}

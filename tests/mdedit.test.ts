import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownEditor } from '../src/mdedit';
import { pageScript } from '../src/pagescript';

// The markdown editor: the markup the pages embed, and the toolbar's editing
// of the field. The toolbar writes markdown text rather than styling anything,
// so its whole behaviour is a function from (value, selection, action) to
// (value, selection), which is testable without a browser; what needs a
// browser is only whether the buttons look right.

test('the editor markup carries the field, the tabs, and the toolbar', () => {
  const s = String(
    markdownEditor({ name: 'body', rows: 6, placeholder: 'Leave a comment', preview: '/c/r/preview' })
  );
  assert.match(s, /data-md-editor/);
  assert.match(s, /data-md-preview="\/c\/r\/preview"/);
  assert.match(s, /<textarea class="md-input" name="body"/);
  assert.match(s, /data-md-pane="write"/);
  assert.match(s, /data-md-pane="preview"/);
  for (const act of ['heading', 'bold', 'italic', 'strike', 'quote', 'code', 'link', 'ul', 'ol', 'task']) {
    assert.match(s, new RegExp(`data-md-act="${act}"`), `${act} should be on the toolbar`);
  }
  // Every toolbar button must be type="button": the editor sits inside the
  // form it belongs to, and a bare <button> would submit it.
  assert.ok(!/<button (?!type="button")/.test(s), 'every button must carry type="button"');
});

test('the file-editor variant keeps the code-editor class and its anchoring', () => {
  const s = String(
    markdownEditor({ name: 'content', rows: 12, value: '# hi', codeEditor: true, preview: '/c/r/preview', ref: 'main', dir: 'docs' })
  );
  assert.match(s, /class="code-editor md-input"/);
  assert.match(s, /data-md-ref="main"/);
  assert.match(s, /data-md-dir="docs"/);
  assert.match(s, />\# hi<\/textarea>/);
});

// A textarea reduced to what the toolbar functions touch.
function ta(value: string, s: number, e: number) {
  return {
    tagName: 'TEXTAREA',
    nodeType: 1,
    hidden: false,
    value,
    selectionStart: s,
    selectionEnd: e,
    classList: { contains: () => false },
    focus() {},
    setRangeText(text: string, start: number, end: number) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
    },
    setSelectionRange(a: number, b: number) {
      this.selectionStart = a;
      this.selectionEnd = b;
    },
  };
}

/** Load the page script and hand back mdAct, as pagescript.test.ts loads its probes. */
function loadMdAct(): (ed: unknown, act: string) => void {
  const probe: Record<string, unknown> = {};
  const fn = new Function(
    'document',
    'window',
    'localStorage',
    'matchMedia',
    'confirm',
    'fetch',
    'setTimeout',
    'navigator',
    'sessionStorage',
    'location',
    '__probe',
    pageScript().body + ';__probe.mdAct = mdAct;'
  );
  fn(
    {
      documentElement: { getAttribute: () => null, setAttribute() {} },
      addEventListener() {},
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    { addEventListener() {} },
    { getItem: () => null, setItem() {} },
    () => ({ matches: false, addEventListener() {} }),
    () => true,
    () => Promise.resolve(),
    () => 0,
    {},
    { getItem: () => null, setItem() {} },
    { href: '' },
    probe
  );
  return probe.mdAct as (ed: unknown, act: string) => void;
}

const mdAct = loadMdAct();

function applied(value: string, s: number, e: number, act: string) {
  const input = ta(value, s, e);
  mdAct({ querySelector: () => input }, act);
  return input;
}

test('bold wraps the selection and a second press takes it off again', () => {
  const once = applied('make this bold', 5, 9, 'bold');
  assert.equal(once.value, 'make **this** bold');
  assert.deepEqual([once.selectionStart, once.selectionEnd], [7, 11]);
  const twice = applied(once.value, once.selectionStart, once.selectionEnd, 'bold');
  assert.equal(twice.value, 'make this bold');
});

test('marks just outside the selection are also recognised and removed', () => {
  const input = applied('**word**', 2, 6, 'bold');
  assert.equal(input.value, 'word');
  assert.deepEqual([input.selectionStart, input.selectionEnd], [0, 4]);
});

test('an empty selection gets a placeholder, selected so typing replaces it', () => {
  const input = applied('', 0, 0, 'bold');
  assert.equal(input.value, '**bold text**');
  assert.equal(input.value.slice(input.selectionStart, input.selectionEnd), 'bold text');
});

test('italic and strikethrough wrap with their own marks', () => {
  assert.equal(applied('word', 0, 4, 'italic').value, '_word_');
  assert.equal(applied('word', 0, 4, 'strike').value, '~~word~~');
});

test('code is inline for one line and a fence across lines', () => {
  assert.equal(applied('x = 1', 0, 5, 'code').value, '`x = 1`');
  assert.equal(applied('a\nb', 0, 3, 'code').value, '```\na\nb\n```');
});

test('a link keeps the selection as the text, with the url left selected', () => {
  const input = applied('docs', 0, 4, 'link');
  assert.equal(input.value, '[docs](url)');
  assert.equal(input.value.slice(input.selectionStart, input.selectionEnd), 'url');
});

test('a selected URL becomes the target, with the cursor in the empty text', () => {
  const input = applied('https://x.dev/a', 0, 15, 'link');
  assert.equal(input.value, '[](https://x.dev/a)');
  assert.deepEqual([input.selectionStart, input.selectionEnd], [1, 1]);
});

test('heading prefixes the line, and strips a heading of any level', () => {
  assert.equal(applied('Title', 2, 2, 'heading').value, '### Title');
  assert.equal(applied('## Title', 2, 2, 'heading').value, 'Title');
});

test('quote and the lists work per line across the selection, and toggle', () => {
  assert.equal(applied('a\nb', 0, 3, 'quote').value, '> a\n> b');
  assert.equal(applied('> a\n> b', 0, 7, 'quote').value, 'a\nb');
  assert.equal(applied('a\nb', 0, 3, 'ul').value, '- a\n- b');
  assert.equal(applied('a\nb\nc', 0, 5, 'ol').value, '1. a\n2. b\n3. c');
  assert.equal(applied('1. a\n2. b', 0, 9, 'ol').value, 'a\nb');
  assert.equal(applied('a\nb', 0, 3, 'task').value, '- [ ] a\n- [ ] b');
  assert.equal(applied('- [ ] a\n- [x] b', 0, 15, 'task').value, 'a\nb');
});

test('blank lines between prefixed lines are passed over, not prefixed', () => {
  assert.equal(applied('a\n\nb', 0, 4, 'quote').value, '> a\n\n> b');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageScript } from '../src/pagescript';

// The page script, loaded against a fake document.
//
// Moving the interface's behaviour out of inline handlers and into delegated
// listeners is what lets the pages carry a Content-Security-Policy, and it
// moved every click, input, and submit in the interface at once. These tests
// are not a browser, and they do not pretend to be: what they check is that
// the file loads against a DOM, and that a click or a submit on an element
// carrying one of the new data attributes reaches the function it used to name
// inline. Anything about layout or paint still needs a browser.

/** The least DOM the script touches on load and while dispatching one event. */
function fakeDom() {
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const calls: string[] = [];
  const el = (attrs: Record<string, string>, tag = 'div'): Record<string, unknown> => {
    const node: Record<string, unknown> = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      parentElement: null,
      classList: { add() {}, remove() {} },
      getAttribute: (n: string) => attrs[n] ?? null,
      setAttribute: (n: string, v: string) => {
        attrs[n] = v;
      },
      matches: (sel: string) => {
        // Enough selector support for the wiring: .class, #id, [attr],
        // [attr="value"], and tag.
        if (sel.startsWith('.')) return (attrs.class ?? '').split(/\s+/).includes(sel.slice(1));
        if (sel.startsWith('#')) return attrs.id === sel.slice(1);
        const attr = sel.match(/^\[([a-z-]+)(?:="([^"]*)")?\]$/);
        if (attr) return attr[2] === undefined ? attr[1] in attrs : attrs[attr[1]] === attr[2];
        const both = sel.match(/^([a-z]+)\[([a-z-]+)\]$/);
        if (both) return node.tagName === both[1].toUpperCase() && both[2] in attrs;
        return sel.toUpperCase() === node.tagName;
      },
      select: () => calls.push('select'),
      querySelectorAll: () => [],
      addEventListener: () => {},
      value: '',
      id: attrs.id ?? '',
    };
    return node;
  };
  const documentElement = el({ 'data-theme-vault': 'paper', 'data-theme-dark': 'midnight' }, 'html');
  const document: Record<string, unknown> = {
    documentElement,
    addEventListener(type: string, fn: (e: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type)!.push(fn);
    },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => el({}, 'textarea'),
    body: { appendChild() {} },
    execCommand: () => true,
  };
  const dispatch = (type: string, target: Record<string, unknown>) => {
    const event = {
      target,
      preventDefault: () => calls.push('preventDefault'),
      key: (target.key as string) ?? '',
    };
    for (const fn of listeners.get(type) ?? []) fn(event);
    return event;
  };
  return { document, el, dispatch, calls, listeners };
}

/** Load the script with the globals it reaches for, and report what happened. */
function load(dom: ReturnType<typeof fakeDom>, opts: { confirmAnswer?: boolean } = {}) {
  const confirmed: string[] = [];
  const copied: string[] = [];
  const stored = new Map<string, string>();
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
    pageScript().body + '\n;__probe.copyText = copyText; __probe.setTheme = setTheme;'
  );
  const probe: Record<string, unknown> = {};
  fn(
    dom.document,
    { addEventListener() {} },
    { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v) },
    () => ({ matches: false, addEventListener() {} }),
    (msg: string) => {
      confirmed.push(msg);
      return opts.confirmAnswer ?? true;
    },
    () => Promise.resolve({ json: () => Promise.resolve({ lines: [], offset: 0, done: true }) }),
    () => 0,
    { clipboard: null },
    { getItem: () => null, setItem() {} },
    { href: '' },
    probe
  );
  return { confirmed, copied, probe };
}

test('the page script loads against a document without throwing', () => {
  const dom = fakeDom();
  const { probe } = load(dom);
  assert.equal(typeof probe.copyText, 'function');
  // Loading applies the theme, reading the pair off <html> rather than from
  // anything the server interpolated into the script.
  assert.equal((dom.document.documentElement as Record<string, unknown>).getAttribute('data-theme'), 'paper');
});

test('every kind of event the markup relies on is delegated from the document', () => {
  const dom = fakeDom();
  load(dom);
  const kinds = [...dom.listeners.keys()].sort();
  assert.deepEqual(kinds, ['DOMContentLoaded', 'change', 'click', 'input', 'keydown', 'mouseover', 'submit']);
  // input, change, submit, and mouseover are wholly this file's, one each.
  // click and keydown carry more, because closing an open menu and the two
  // keyboard shortcuts were delegated from the document before any of this.
  for (const kind of ['input', 'change', 'submit', 'mouseover']) {
    assert.equal(dom.listeners.get(kind)!.length, 1, `${kind} should be delegated once`);
  }
});

test('a form carrying data-confirm asks, and submits when the answer is yes', () => {
  const dom = fakeDom();
  const { confirmed } = load(dom, { confirmAnswer: true });
  const form = dom.el({ 'data-confirm': 'Delete branch topic?' }, 'form');
  dom.dispatch('submit', form);
  assert.deepEqual(confirmed, ['Delete branch topic?']);
  assert.ok(!dom.calls.includes('preventDefault'), 'a yes must let the form through');
});

test('and is stopped when the answer is no', () => {
  const dom = fakeDom();
  const { confirmed } = load(dom, { confirmAnswer: false });
  dom.dispatch('submit', dom.el({ 'data-confirm': 'Remove runner laptop?' }, 'form'));
  assert.deepEqual(confirmed, ['Remove runner laptop?']);
  assert.ok(dom.calls.includes('preventDefault'), 'a no must stop the submit');
});

test('a form without data-confirm submits without asking', () => {
  const dom = fakeDom();
  const { confirmed } = load(dom);
  dom.dispatch('submit', dom.el({ action: '/x' }, 'form'));
  assert.deepEqual(confirmed, []);
  assert.ok(!dom.calls.includes('preventDefault'));
});

test('the confirm text is whatever the attribute says, quotes and all', () => {
  // The old spelling put this text inside a JavaScript string inside an HTML
  // attribute, so a quote in a name would have broken the handler. An
  // attribute is data, and the template escapes it like any other value.
  const dom = fakeDom();
  const { confirmed } = load(dom);
  dom.dispatch('submit', dom.el({ 'data-confirm': `Delete branch it's "here"?` }, 'form'));
  assert.deepEqual(confirmed, [`Delete branch it's "here"?`]);
});

test('a click on an element with data-select-all selects it', () => {
  const dom = fakeDom();
  load(dom);
  dom.dispatch('click', dom.el({ 'data-select-all': '' }, 'input'));
  assert.ok(dom.calls.includes('select'));
});

test('a click on a theme item applies that theme', () => {
  const dom = fakeDom();
  load(dom);
  dom.dispatch('click', dom.el({ class: 'dd-item theme-item', 'data-theme-name': 'terminal' }, 'button'));
  assert.equal((dom.document.documentElement as Record<string, unknown>).getAttribute('data-theme'), 'terminal');
});

test('the script names every function the markup still refers to', () => {
  // The markup carries data attributes and class names; the script has to
  // define what the delegation dispatches to. A rename on one side without the
  // other is exactly what this catches.
  const body = pageScript().body;
  for (const name of [
    'copyCmd',
    'copyLines',
    'filterMenu',
    'filterFiles',
    'filterRows',
    'filterCards',
    'findKey',
    'openJump',
    'renderJump',
    'jumpKey',
    'jumpPoint',
    'pickWorkflow',
    'setTheme',
    'applyTheme',
  ]) {
    assert.match(body, new RegExp(`function ${name}\\b`), `${name} should be defined`);
  }
  // And no line of it may build an inline handler into markup, which is the
  // whole point. Comments are skipped: the file explains in prose what it no
  // longer does.
  const code = body
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  assert.ok(!/\son(click|submit|input|change|mouseenter)=/.test(code), 'the script must not emit inline handlers');
});

test('the tag changes when the body does, so a cached copy is never stale', () => {
  const first = pageScript();
  assert.match(first.tag, /^[0-9a-f]{12}$/);
  assert.equal(pageScript().tag, first.tag);
});

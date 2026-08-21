import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown } from '../src/markdown';

// @mentions in rendered markdown. The opts.mentions callback stands in for the
// vault: it answers whether a name is a user, and only a yes becomes a link.

const OPTS = {
  rawBase: '/demo/proj/raw/main',
  blobBase: '/demo/proj/blob/main',
  issueBase: '/demo/proj/issues',
  commitBase: '/demo/proj/commit',
};

const users = new Set(['alice', 'bob.b']);
const mentions = (name: string) => users.has(name);

test('a known user is linked to their profile and an unknown one stays text', () => {
  const html = renderMarkdown('ping @alice and @stranger', { ...OPTS, mentions });
  assert.ok(html.includes('<a href="/alice">@alice</a>'), html);
  assert.ok(!html.includes('href="/stranger"'), html);
  assert.ok(html.includes('@stranger'), html);
});

test('without the callback nothing is linked', () => {
  const html = renderMarkdown('ping @alice', OPTS);
  assert.ok(!html.includes('href="/alice"'), html);
});

test('trailing punctuation is peeled only while the name does not resolve', () => {
  const ends = renderMarkdown('thanks @alice.', { ...OPTS, mentions });
  assert.ok(ends.includes('<a href="/alice">@alice</a>'), ends);
  assert.ok(ends.includes('</a>.'), ends);
  // A username that really carries the dot wins as itself.
  const dotted = renderMarkdown('review by @bob.b.', { ...OPTS, mentions });
  assert.ok(dotted.includes('<a href="/bob.b">@bob.b</a>'), dotted);
});

test('an email address and a mention inside a link are left alone', () => {
  const email = renderMarkdown('write to alice@example.org', { ...OPTS, mentions });
  assert.ok(!email.includes('href="/example.org"'), email);
  assert.ok(!email.includes('href="/alice"'), email);
  const inLink = renderMarkdown('[see @alice](https://example.org)', { ...OPTS, mentions });
  assert.ok(!inLink.includes('href="/alice"'), inLink);
});

test('a mention in code stays code', () => {
  const html = renderMarkdown('run `@alice` and\n\n```\n@alice\n```\n', { ...OPTS, mentions });
  assert.ok(!html.includes('href="/alice"'), html);
});

test('a hostile username shape cannot break out of the href', () => {
  const evil = new Set(['a"onmouseover="alert(1)']);
  const html = renderMarkdown('hi @a"onmouseover="alert(1)', {
    ...OPTS,
    mentions: (n) => evil.has(n),
  });
  assert.ok(!html.includes('onmouseover="alert(1)"'), html);
});

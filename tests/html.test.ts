import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Html, esc, html, joinHtml, raw } from '../src/html';

test('interpolated values are escaped, literal text is not', () => {
  assert.equal(html`<b>${'<script>'}</b>`.text, '<b>&lt;script&gt;</b>');
  assert.equal(html`<a title="${`"quoted" & 'single'`}">`.text, '<a title="&quot;quoted&quot; &amp; &#39;single&#39;">');
});

test('an Html value passes through unescaped, which is how fragments nest', () => {
  const inner = html`<i>${'a & b'}</i>`;
  assert.equal(html`<p>${inner}</p>`.text, '<p><i>a &amp; b</i></p>');
  assert.equal(html`<p>${raw('<br>')}</p>`.text, '<p><br></p>');
});

test('numbers render as themselves', () => {
  assert.equal(html`<span>${42}</span>`.text, '<span>42</span>');
});

test('null, undefined, and booleans render as nothing, making && a conditional', () => {
  assert.equal(html`<p>${null}${undefined}${false}${true}</p>`.text, '<p></p>');
  const admin = false;
  assert.equal(html`<div>${admin && html`<a>Admin</a>`}</div>`.text, '<div></div>');
});

test('arrays render each element by the same rules, joined by nothing', () => {
  const items = ['a<b', raw('<hr>'), html`<li>${'x'}</li>`];
  assert.equal(html`${items}`.text, 'a&lt;b<hr><li>x</li>');
});

test('joinHtml keeps fragments as fragments, unlike Array.prototype.join', () => {
  const items = [html`<li>a</li>`, html`<li>b</li>`];
  assert.equal(joinHtml(items, '\n').text, '<li>a</li>\n<li>b</li>');
  // The trap this exists for: .join() flattens to a plain string, which a
  // template would then escape.
  assert.equal(html`${items.join('')}`.text, '&lt;li&gt;a&lt;/li&gt;&lt;li&gt;b&lt;/li&gt;');
});

test('toString lets an unconverted string template interpolate a fragment', () => {
  const frag = html`<b>${'safe & sound'}</b>`;
  assert.equal(`before ${frag} after`, 'before <b>safe &amp; sound</b> after');
  assert.ok(frag instanceof Html);
});

test('esc covers the five characters that matter in text and attributes', () => {
  assert.equal(esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ansiLineHtml, stripAnsi } from '../src/ansi';

// The contract under test: SGR colour and emphasis become classed spans,
// every other escape disappears, carriage returns resolve to what a terminal
// would show at rest, and nothing a job wrote can come out as markup.

test('a plain line passes through untouched', () => {
  assert.equal(stripAnsi('hello world'), 'hello world');
  assert.equal(ansiLineHtml('hello world'), 'hello world');
});

test('text is HTML-escaped, styled or not', () => {
  assert.equal(ansiLineHtml('a < b & c'), 'a &lt; b &amp; c');
  assert.equal(ansiLineHtml('\x1b[31m<script>\x1b[0m'), '<span class="a-red">&lt;script&gt;</span>');
});

test('the sixteen-colour palette becomes classes', () => {
  assert.equal(ansiLineHtml('\x1b[31mred\x1b[0m plain'), '<span class="a-red">red</span> plain');
  assert.equal(ansiLineHtml('\x1b[96mcyan\x1b[m'), '<span class="a-bcyn">cyan</span>');
});

test('an empty SGR parameter list is a reset', () => {
  assert.equal(ansiLineHtml('\x1b[31ma\x1b[mb'), '<span class="a-red">a</span>b');
});

test('bold and colour combine, and 39 returns to the default foreground', () => {
  assert.equal(ansiLineHtml('\x1b[1;32mok\x1b[0m'), '<span class="a-grn a-b">ok</span>');
  assert.equal(ansiLineHtml('\x1b[31mr\x1b[39md'), '<span class="a-red">r</span>d');
});

test('dim, italic, and underline each have a class and a reset', () => {
  assert.equal(ansiLineHtml('\x1b[2;3;4mx\x1b[22;23;24my'), '<span class="a-d a-i a-u">x</span>y');
});

test('256-colour indices 0-15 map onto the classed palette', () => {
  assert.equal(ansiLineHtml('\x1b[38;5;1mx'), '<span class="a-red">x</span>');
  assert.equal(ansiLineHtml('\x1b[38;5;9mx'), '<span class="a-bred">x</span>');
});

test('a cube colour is rendered inline, and an extreme one is clamped', () => {
  // 196 is (255,0,0) in the xterm cube: readable, so kept as written.
  assert.equal(ansiLineHtml('\x1b[38;5;196mx'), '<span style="color:rgb(255,0,0)">x</span>');
  // 16 is (0,0,0): invisible on a dark theme, so pulled to the muted token.
  assert.equal(ansiLineHtml('\x1b[38;5;16mx'), '<span style="color:var(--fg-muted, #6e7781)">x</span>');
});

test('truecolour foregrounds are rendered inline with the same clamp', () => {
  assert.equal(ansiLineHtml('\x1b[38;2;200;100;50mx'), '<span style="color:rgb(200,100,50)">x</span>');
  assert.equal(ansiLineHtml('\x1b[38;2;255;255;255mx'), '<span style="color:var(--fg-muted, #6e7781)">x</span>');
});

test('backgrounds are dropped, including the extended forms', () => {
  assert.equal(ansiLineHtml('\x1b[41mx\x1b[0m'), 'x');
  assert.equal(ansiLineHtml('\x1b[48;5;196mx'), 'x');
  // The extended background consumes its parameters rather than misreading
  // them as further SGR codes: 48;2;31;… must not turn the text red.
  assert.equal(ansiLineHtml('\x1b[48;2;31;31;31mx'), 'x');
});

test('a carriage return resolves to what the terminal would show at rest', () => {
  assert.equal(stripAnsi('50%\r100%'), '100%');
  assert.equal(stripAnsi('done\r'), 'done');
  assert.equal(ansiLineHtml('\x1b[32m50%\r\x1b[32m100%'), '<span class="a-grn">100%</span>');
});

test('non-SGR escapes disappear: OSC titles, cursor movement, stray escapes', () => {
  assert.equal(stripAnsi('\x1b]0;window title\x07text'), 'text');
  assert.equal(stripAnsi('\x1b[2Ktext'), 'text');
  assert.equal(stripAnsi('a\x1b7b'), 'ab');
  assert.equal(ansiLineHtml('\x1b]0;title\x07text'), 'text');
});

test('stripAnsi removes SGR sequences along with everything else', () => {
  assert.equal(stripAnsi('\x1b[1;31merror\x1b[0m: it failed'), 'error: it failed');
});

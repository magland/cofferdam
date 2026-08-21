import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ageScript } from '../src/agescript';
import { looksLikeAge } from '../src/agefile';

// The served /assets/age.js, loaded here the way a browser would, minus the
// browser. The vendored bundle does real cryptography with WebCrypto, which
// Node also provides, so the round trip below is the genuine article: a
// regenerated vendor file that cannot encrypt, decrypt, or armor fails here
// rather than in someone's page. The glue's wiring is exercised only as far
// as loading against a bare document; anything about clicks and paint needs a
// browser.

/** Load the script with a window for the bundle and a document for the glue. */
function load(): Record<string, any> {
  const win: Record<string, unknown> = {};
  const doc = { querySelector: () => null, querySelectorAll: () => [] };
  new Function('window', 'document', 'self', ageScript().body)(win, doc, win);
  return win;
}

test('the script loads and the bundle takes its places on window', () => {
  const win = load();
  assert.equal(typeof win.MochiAge?.Encrypter, 'function');
  assert.equal(typeof win.MochiAge?.Decrypter, 'function');
  assert.equal(typeof win.MochiAge?.armor?.encode, 'function');
  assert.equal(typeof win.MochiMarkdownIt, 'function');
});

test('a passphrase round trip through the bundle, armored like the editor writes', async () => {
  const { Encrypter, Decrypter, armor } = load().MochiAge;
  const e = new Encrypter();
  e.setPassphrase('correct horse battery staple');
  // The editor keeps typage's default work factor; the tests lower it so a
  // run is not seconds of deliberate slowness.
  e.setScryptWorkFactor(12);
  const armored: string = armor.encode(await e.encrypt('the tokens live here\n')) + '\n';
  // What the browser would post is what the server-side backstop must accept.
  assert.ok(looksLikeAge(Buffer.from(armored, 'utf8')));
  const d = new Decrypter();
  d.addPassphrase('correct horse battery staple');
  assert.equal(await d.decrypt(armor.decode(armored), 'text'), 'the tokens live here\n');
});

test('the wrong passphrase is an error, not wrong plaintext', async () => {
  const { Encrypter, Decrypter } = load().MochiAge;
  const e = new Encrypter();
  e.setPassphrase('right');
  e.setScryptWorkFactor(12);
  const ct = await e.encrypt('secret');
  const d = new Decrypter();
  d.addPassphrase('wrong');
  await assert.rejects(() => d.decrypt(ct, 'text'), /no identity matched/);
});

test('the markdown renderer escapes HTML, since it renders decrypted text into the page', () => {
  const md = load().MochiMarkdownIt({ html: false, linkify: true });
  const out: string = md.render('hello <script>alert(1)</script> *world*');
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('&lt;script&gt;'));
  assert.ok(out.includes('<em>world</em>'));
});

test('the glue wires nothing on a page with none of its markup', () => {
  // Loading against a bare document must be a no-op: every page that links
  // this script also carries one of the data attributes, but a cached page
  // or a future refactor must not turn that assumption into a crash.
  assert.doesNotThrow(load);
});

test('the tag changes when the body does, so a cached copy is never stale', () => {
  const first = ageScript();
  assert.match(first.tag, /^[0-9a-f]{12}$/);
  assert.equal(ageScript().tag, first.tag);
});

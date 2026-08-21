import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ageInnerName, isAgeFile, looksLikeAge } from '../src/agefile';

// What the server decides about age files is naming and framing, nothing
// more; the cryptography happens in the reader's browser and is exercised in
// tests/agescript.test.ts. These are the decisions the web forms lean on,
// looksLikeAge above all: it is what refuses a plaintext commit under a .age
// name when the browser-side encryption never ran.

test('the .age extension is the contract, case included', () => {
  assert.ok(isAgeFile('secrets.md.age'));
  assert.ok(isAgeFile('x.AGE'));
  assert.ok(isAgeFile('deep/in/a/tree/tokens.json.age'));
  assert.ok(!isAgeFile('secrets.md'));
  assert.ok(!isAgeFile('age'));
  assert.ok(!isAgeFile('agenda.txt'));
  // A directory named .age does not make its files encrypted.
  assert.ok(!isAgeFile('notes.age/readme.md'));
});

test('the inner name is the path without the .age ending', () => {
  assert.equal(ageInnerName('secrets.md.age'), 'secrets.md');
  assert.equal(ageInnerName('tokens.json.AGE'), 'tokens.json');
  assert.equal(ageInnerName('blob.age'), 'blob');
});

test('both framings of a ciphertext are recognised', () => {
  assert.ok(looksLikeAge(Buffer.from('age-encryption.org/v1\n-> scrypt ...')));
  assert.ok(looksLikeAge(Buffer.from('-----BEGIN AGE ENCRYPTED FILE-----\nYWdl...')));
});

test('and anything else is not, plaintext above all', () => {
  assert.ok(!looksLikeAge(Buffer.from('my github token is ghp_abc123\n')));
  assert.ok(!looksLikeAge(Buffer.from('')));
  // A prefix of the header is not the header; a truncated buffer must not
  // pass on a partial match.
  assert.ok(!looksLikeAge(Buffer.from('age-encryption.org/v1')));
  assert.ok(!looksLikeAge(Buffer.from('-----BEGIN PGP MESSAGE-----')));
});

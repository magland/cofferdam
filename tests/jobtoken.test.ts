import assert from 'node:assert/strict';
import { test } from 'node:test';
import { grantCovers, mintJobToken, verifyJobToken } from '../src/jobtoken';
import { makeVaultDir } from './helpers';

// The ephemeral per-job credential: minted by the engine, presented by the
// runner as a Basic-auth password, verified by recomputing the signature.

test('a minted token verifies, carries its grant, and covers only its repository', () => {
  const root = makeVaultDir();
  const token = mintJobToken(root, { collection: 'demo', repo: 'webapp', run: '7' }, 60_000);
  const grant = verifyJobToken(root, token);
  assert.ok(grant);
  assert.deepEqual(grant, { collection: 'demo', repo: 'webapp', run: '7' });
  assert.ok(grantCovers(grant, 'demo', 'webapp'));
  assert.ok(!grantCovers(grant, 'demo', 'other'));
  assert.ok(!grantCovers(grant, 'other', 'webapp'));
});

test('an expired token verifies as nothing', () => {
  const root = makeVaultDir();
  const token = mintJobToken(root, { collection: 'demo', repo: 'webapp', run: '7' }, -1);
  assert.equal(verifyJobToken(root, token), null);
});

test('a tampered token, a foreign secret, and a non-token all verify as nothing', () => {
  const root = makeVaultDir();
  const token = mintJobToken(root, { collection: 'demo', repo: 'webapp', run: '7' }, 60_000);
  // Flip a character in the signed body; the signature no longer covers it.
  const dot = token.lastIndexOf('.');
  const tampered = token.slice(0, dot - 1) + (token[dot - 1] === 'A' ? 'B' : 'A') + token.slice(dot);
  assert.equal(verifyJobToken(root, tampered), null);
  // A token minted under another vault's secret means nothing here.
  const elsewhere = makeVaultDir();
  const foreign = mintJobToken(elsewhere, { collection: 'demo', repo: 'webapp', run: '7' }, 60_000);
  assert.equal(verifyJobToken(root, foreign), null);
  // Ordinary user tokens and junk fall out at the prefix.
  assert.equal(verifyJobToken(root, 'cofferdam_' + 'a'.repeat(64)), null);
  assert.equal(verifyJobToken(root, 'not a token at all'), null);
  assert.equal(verifyJobToken(root, 'cofferdamjob_missingdot'), null);
});

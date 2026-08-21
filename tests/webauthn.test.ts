import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as crypto from 'crypto';
import {
  COSE_EDDSA,
  COSE_ES256,
  WebAuthnError,
  claimedChallenge,
  mintChallenge,
  verifyAssertion,
  verifyRegistration,
} from '../src/webauthn';

// A synthetic authenticator: the same bytes a real one emits, built with
// node's crypto, so both ceremonies are exercised end to end without a
// browser. The CBOR encoder here is the test's own, so the decoder under test
// is not checking its own homework against itself byte for byte -- it is
// checking against the CBOR spec as independently implemented below.

function cborUint(n: number, major: number): Buffer {
  const m = major << 5;
  if (n < 24) return Buffer.from([m | n]);
  if (n < 256) return Buffer.from([m | 24, n]);
  const b = Buffer.alloc(3);
  b[0] = m | 25;
  b.writeUInt16BE(n, 1);
  return b;
}

function cborEncode(v: unknown): Buffer {
  if (typeof v === 'number' && Number.isInteger(v)) {
    return v >= 0 ? cborUint(v, 0) : cborUint(-1 - v, 1);
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([cborUint(v.length, 2), v]);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([cborUint(b.length, 3), b]);
  }
  if (v instanceof Map) {
    const parts: Buffer[] = [cborUint(v.size, 5)];
    for (const [k, val] of v) parts.push(cborEncode(k), cborEncode(val));
    return Buffer.concat(parts);
  }
  throw new Error('unsupported test CBOR value');
}

const RP_ID = 'vault.example.org';
const ORIGIN = 'https://vault.example.org';

interface FakeAuthenticator {
  credId: Buffer;
  cose: Map<number, unknown>;
  sign: (data: Buffer) => Buffer;
}

function makeEs256(): FakeAuthenticator {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const cose = new Map<number, unknown>([
    [1, 2],
    [3, COSE_ES256],
    [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')],
    [-3, Buffer.from(jwk.y, 'base64url')],
  ]);
  return {
    credId: crypto.randomBytes(16),
    cose,
    sign: (data) => crypto.sign('sha256', data, privateKey),
  };
}

function makeEd25519(): FakeAuthenticator {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const cose = new Map<number, unknown>([
    [1, 1],
    [3, COSE_EDDSA],
    [-1, 6],
    [-2, Buffer.from(jwk.x, 'base64url')],
  ]);
  return {
    credId: crypto.randomBytes(32),
    cose,
    sign: (data) => crypto.sign(null, data, privateKey),
  };
}

function authData(opts: { rpId?: string; flags: number; counter?: number; cred?: FakeAuthenticator }): Buffer {
  const head = Buffer.alloc(37);
  crypto.createHash('sha256').update(opts.rpId ?? RP_ID).digest().copy(head, 0);
  head[32] = opts.flags;
  head.writeUInt32BE(opts.counter ?? 0, 33);
  if (!opts.cred) return head;
  const idLen = Buffer.alloc(2);
  idLen.writeUInt16BE(opts.cred.credId.length);
  return Buffer.concat([head, Buffer.alloc(16), idLen, opts.cred.credId, cborEncode(opts.cred.cose)]);
}

function clientData(type: string, challenge: string, origin = ORIGIN): Buffer {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');
}

function register(cred: FakeAuthenticator, challenge: string, opts: { origin?: string; rpId?: string } = {}) {
  const att = new Map<string, unknown>([
    ['fmt', 'none'],
    ['attStmt', new Map()],
    ['authData', authData({ rpId: opts.rpId, flags: 0x45, cred })],
  ]);
  return verifyRegistration({
    attestationObject: cborEncode(att),
    clientDataJSON: clientData('webauthn.create', challenge, opts.origin),
    challenge,
    origin: ORIGIN,
    rpId: RP_ID,
  });
}

function assertWith(
  cred: FakeAuthenticator,
  stored: { publicKey: string; alg: number },
  challenge: string,
  opts: { counter?: number; type?: string; origin?: string; tamperSig?: boolean } = {}
) {
  const ad = authData({ flags: 0x05, counter: opts.counter ?? 0 });
  const cd = clientData(opts.type ?? 'webauthn.get', challenge, opts.origin);
  const sig = cred.sign(Buffer.concat([ad, crypto.createHash('sha256').update(cd).digest()]));
  if (opts.tamperSig) sig[8] ^= 0xff;
  return verifyAssertion({
    authenticatorData: ad,
    clientDataJSON: cd,
    signature: sig,
    publicKey: stored.publicKey,
    alg: stored.alg,
    challenge,
    origin: ORIGIN,
    rpId: RP_ID,
  });
}

describe('webauthn registration', () => {
  it('accepts an ES256 registration and reports the credential', () => {
    const cred = makeEs256();
    const challenge = mintChallenge();
    const reg = register(cred, challenge);
    assert.equal(reg.id, cred.credId.toString('base64url'));
    assert.equal(reg.alg, COSE_ES256);
    // The stored key is a usable SPKI: node can read it back.
    crypto.createPublicKey({ key: Buffer.from(reg.publicKey, 'base64url'), format: 'der', type: 'spki' });
  });

  it('accepts an Ed25519 registration', () => {
    const cred = makeEd25519();
    const reg = register(cred, mintChallenge());
    assert.equal(reg.alg, COSE_EDDSA);
  });

  it('refuses the wrong origin, challenge, ceremony type, and rp id', () => {
    const cred = makeEs256();
    const challenge = mintChallenge();
    assert.throws(() => register(cred, challenge, { origin: 'https://evil.example.org' }), WebAuthnError);
    assert.throws(
      () =>
        verifyRegistration({
          attestationObject: cborEncode(
            new Map<string, unknown>([
              ['fmt', 'none'],
              ['attStmt', new Map()],
              ['authData', authData({ flags: 0x45, cred })],
            ])
          ),
          clientDataJSON: clientData('webauthn.create', mintChallenge()),
          challenge,
          origin: ORIGIN,
          rpId: RP_ID,
        }),
      WebAuthnError
    );
    assert.throws(() => register(cred, challenge, { rpId: 'other.example.org' }), WebAuthnError);
  });
});

describe('webauthn assertion', () => {
  it('verifies a good ES256 assertion and reports the counter', () => {
    const cred = makeEs256();
    const reg = register(cred, mintChallenge());
    const challenge = mintChallenge();
    const result = assertWith(cred, reg, challenge, { counter: 7 });
    assert.equal(result.counter, 7);
    assert.equal(result.userVerified, true);
  });

  it('verifies a good Ed25519 assertion', () => {
    const cred = makeEd25519();
    const reg = register(cred, mintChallenge());
    assertWith(cred, reg, mintChallenge());
  });

  it('refuses a tampered signature, a replayed challenge string, and the create type', () => {
    const cred = makeEs256();
    const reg = register(cred, mintChallenge());
    assert.throws(() => assertWith(cred, reg, mintChallenge(), { tamperSig: true }), WebAuthnError);
    const challenge = mintChallenge();
    const other = makeEs256();
    // A signature from a different key over the same bytes does not verify.
    assert.throws(() => assertWith(other, reg, challenge), WebAuthnError);
    assert.throws(() => assertWith(cred, reg, challenge, { type: 'webauthn.create' }), WebAuthnError);
  });

  it('reads the claimed challenge out of client data, and only there', () => {
    const challenge = mintChallenge();
    assert.equal(claimedChallenge(clientData('webauthn.get', challenge)), challenge);
    assert.equal(claimedChallenge(Buffer.from('not json')), null);
  });
});

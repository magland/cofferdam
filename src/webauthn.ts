import * as crypto from 'crypto';

// WebAuthn (passkey) verification, on node's own crypto and nothing else.
//
// A passkey is a public-key credential the browser keeps: registration hands
// the vault a public key, and signing in proves possession of the private one
// by signing a server-minted challenge. What a server has to implement is
// small and precisely specified -- parse the authenticator's CBOR, check the
// challenge, the origin, and the RP ID hash, and verify one signature -- so it
// is implemented here rather than through a dependency, the way the multipart
// parser and the cookie parser are. The subset is deliberate:
//
//   - Attestation is not verified. Attestation says which make of
//     authenticator minted the key, which matters to a bank with a hardware
//     policy and not to a vault whose user is registering a key on their own
//     account. Browsers send fmt "none" unless asked; whatever arrives, only
//     authData is read.
//   - Three algorithms: ES256 (-7) and EdDSA (-8), which are what passkeys
//     are minted with today, and RS256 (-257) for older platform
//     authenticators. The COSE key is converted to a DER SPKI once, at
//     registration, so signing in is a single crypto.verify.
//
// Nothing here touches the vault or the request: callers hand in the expected
// challenge, origin, and RP ID, and get back parsed facts or a thrown
// WebAuthnError whose message is safe to show.

export class WebAuthnError extends Error {}

// COSE algorithm identifiers, the only ones offered at registration.
export const COSE_ES256 = -7;
export const COSE_EDDSA = -8;
export const COSE_RS256 = -257;
export const SUPPORTED_ALGS = [COSE_ES256, COSE_EDDSA, COSE_RS256];

export function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function fromB64url(s: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new WebAuthnError('not base64url');
  return Buffer.from(s, 'base64url');
}

/** A fresh challenge, base64url, as the client APIs expect to echo it back. */
export function mintChallenge(): string {
  return b64url(crypto.randomBytes(32));
}

// ---- CBOR ----
//
// The subset CTAP2 emits: definite lengths only, major types 0-5, and the
// three simple values. That is what an attestation object and a COSE key are
// made of; anything else here is malformed input, not a case to support.

type CborValue = number | Buffer | string | CborValue[] | Map<CborValue, CborValue> | boolean | null;

function cborItem(buf: Buffer, at: number): { value: CborValue; next: number } {
  if (at >= buf.length) throw new WebAuthnError('truncated CBOR');
  const initial = buf[at];
  const major = initial >> 5;
  const info = initial & 0x1f;
  let length = 0;
  let next = at + 1;
  if (info < 24) {
    length = info;
  } else if (info === 24 || info === 25 || info === 26) {
    const bytes = info === 24 ? 1 : info === 25 ? 2 : 4;
    if (next + bytes > buf.length) throw new WebAuthnError('truncated CBOR');
    length = info === 24 ? buf[next] : info === 25 ? buf.readUInt16BE(next) : buf.readUInt32BE(next);
    next += bytes;
  } else {
    // 27 is a 64-bit length and 31 an indefinite one; neither appears in the
    // structures this parses, and a credential id or key that claimed to need
    // one would not be worth believing.
    throw new WebAuthnError('unsupported CBOR length');
  }
  switch (major) {
    case 0:
      return { value: length, next };
    case 1:
      return { value: -1 - length, next };
    case 2: {
      if (next + length > buf.length) throw new WebAuthnError('truncated CBOR');
      return { value: buf.subarray(next, next + length), next: next + length };
    }
    case 3: {
      if (next + length > buf.length) throw new WebAuthnError('truncated CBOR');
      return { value: buf.subarray(next, next + length).toString('utf8'), next: next + length };
    }
    case 4: {
      const arr: CborValue[] = [];
      for (let i = 0; i < length; i++) {
        const item = cborItem(buf, next);
        arr.push(item.value);
        next = item.next;
      }
      return { value: arr, next };
    }
    case 5: {
      const map = new Map<CborValue, CborValue>();
      for (let i = 0; i < length; i++) {
        const key = cborItem(buf, next);
        const val = cborItem(buf, key.next);
        map.set(key.value, val.value);
        next = val.next;
      }
      return { value: map, next };
    }
    case 7: {
      if (info === 20) return { value: false, next };
      if (info === 21) return { value: true, next };
      if (info === 22) return { value: null, next };
      throw new WebAuthnError('unsupported CBOR simple value');
    }
    default:
      throw new WebAuthnError('unsupported CBOR type');
  }
}

function cborDecode(buf: Buffer): CborValue {
  return cborItem(buf, 0).value;
}

// ---- COSE keys ----

function coseField(key: Map<CborValue, CborValue>, label: number): CborValue {
  const v = key.get(label);
  if (v === undefined) throw new WebAuthnError('COSE key is missing a field');
  return v;
}

function coseBytes(key: Map<CborValue, CborValue>, label: number): Buffer {
  const v = coseField(key, label);
  if (!Buffer.isBuffer(v)) throw new WebAuthnError('COSE key field is not bytes');
  return v;
}

/**
 * A COSE public key as a node KeyObject, via JWK import so no ASN.1 is built
 * by hand. Returns the key with the algorithm it signs under, checked against
 * the key's own type: a mismatched pair is refused here rather than trusted
 * into vault.json.
 */
function coseToKey(cose: Map<CborValue, CborValue>): { key: crypto.KeyObject; alg: number } {
  const kty = coseField(cose, 1);
  const alg = coseField(cose, 3);
  if (typeof alg !== 'number' || !SUPPORTED_ALGS.includes(alg)) {
    throw new WebAuthnError('the authenticator chose an algorithm this vault does not accept');
  }
  if (kty === 2 && alg === COSE_ES256) {
    if (coseField(cose, -1) !== 1) throw new WebAuthnError('ES256 key is not on P-256');
    const x = coseBytes(cose, -2);
    const y = coseBytes(cose, -3);
    if (x.length !== 32 || y.length !== 32) throw new WebAuthnError('P-256 coordinates have the wrong length');
    const jwk = { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) };
    return { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), alg };
  }
  if (kty === 1 && alg === COSE_EDDSA) {
    if (coseField(cose, -1) !== 6) throw new WebAuthnError('EdDSA key is not Ed25519');
    const jwk = { kty: 'OKP', crv: 'Ed25519', x: b64url(coseBytes(cose, -2)) };
    return { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), alg };
  }
  if (kty === 3 && alg === COSE_RS256) {
    const jwk = { kty: 'RSA', n: b64url(coseBytes(cose, -1)), e: b64url(coseBytes(cose, -2)) };
    return { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), alg };
  }
  throw new WebAuthnError('unsupported COSE key type');
}

// ---- authenticator data ----

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

interface AuthData {
  rpIdHash: Buffer;
  userPresent: boolean;
  userVerified: boolean;
  counter: number;
  credential: { id: Buffer; cose: Map<CborValue, CborValue> } | null;
}

function parseAuthData(data: Buffer): AuthData {
  if (data.length < 37) throw new WebAuthnError('authenticator data is too short');
  const flags = data[32];
  const counter = data.readUInt32BE(33);
  let credential: AuthData['credential'] = null;
  if (flags & FLAG_AT) {
    if (data.length < 55) throw new WebAuthnError('attested credential data is too short');
    const idLen = data.readUInt16BE(53);
    if (55 + idLen > data.length) throw new WebAuthnError('credential id is truncated');
    const id = data.subarray(55, 55 + idLen);
    const cose = cborItem(data, 55 + idLen).value;
    if (!(cose instanceof Map)) throw new WebAuthnError('credential public key is not a COSE map');
    credential = { id, cose };
  }
  return {
    rpIdHash: data.subarray(0, 32),
    userPresent: (flags & FLAG_UP) !== 0,
    userVerified: (flags & FLAG_UV) !== 0,
    counter,
    credential,
  };
}

// ---- client data ----

function checkClientData(
  clientDataJSON: Buffer,
  expect: { type: string; challenge: string; origin: string }
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(clientDataJSON.toString('utf8'));
  } catch {
    throw new WebAuthnError('clientDataJSON is not JSON');
  }
  const c = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  if (c.type !== expect.type) throw new WebAuthnError('wrong WebAuthn ceremony type');
  if (typeof c.challenge !== 'string' || c.challenge !== expect.challenge) {
    throw new WebAuthnError('the challenge does not match');
  }
  if (typeof c.origin !== 'string' || c.origin !== expect.origin) {
    throw new WebAuthnError(`the origin does not match this vault (${String(c.origin)})`);
  }
}

/**
 * The challenge a client data blob claims to answer, read before anything is
 * verified. It is how the server finds the pending challenge to check the rest
 * against; nothing is trusted from it until checkClientData has run.
 */
export function claimedChallenge(clientDataJSON: Buffer): string | null {
  try {
    const parsed = JSON.parse(clientDataJSON.toString('utf8')) as { challenge?: unknown };
    return typeof parsed.challenge === 'string' ? parsed.challenge : null;
  } catch {
    return null;
  }
}

function rpIdHashOk(authData: AuthData, rpId: string): boolean {
  const expected = crypto.createHash('sha256').update(rpId).digest();
  return authData.rpIdHash.length === expected.length && crypto.timingSafeEqual(authData.rpIdHash, expected);
}

// ---- the two ceremonies ----

export interface RegistrationResult {
  /** The credential id, base64url; how the key is named ever after. */
  id: string;
  /** The public key as a DER SPKI, base64url. */
  publicKey: string;
  /** The COSE algorithm the key signs under. */
  alg: number;
  counter: number;
}

/**
 * Verify a navigator.credentials.create() response. The challenge must be one
 * this server minted (the caller's business to have checked, via a one-time
 * store); everything else is checked here.
 */
export function verifyRegistration(input: {
  attestationObject: Buffer;
  clientDataJSON: Buffer;
  challenge: string;
  origin: string;
  rpId: string;
}): RegistrationResult {
  checkClientData(input.clientDataJSON, {
    type: 'webauthn.create',
    challenge: input.challenge,
    origin: input.origin,
  });
  const att = cborDecode(input.attestationObject);
  if (!(att instanceof Map)) throw new WebAuthnError('attestation object is not a CBOR map');
  const rawAuthData = att.get('authData');
  if (!Buffer.isBuffer(rawAuthData)) throw new WebAuthnError('attestation object has no authData');
  const authData = parseAuthData(rawAuthData);
  if (!rpIdHashOk(authData, input.rpId)) {
    throw new WebAuthnError('the credential was made for a different hostname');
  }
  if (!authData.userPresent) throw new WebAuthnError('the authenticator did not report user presence');
  if (!authData.credential) throw new WebAuthnError('no credential in the registration');
  if (authData.credential.id.length < 8 || authData.credential.id.length > 1023) {
    throw new WebAuthnError('credential id has an unreasonable length');
  }
  const { key, alg } = coseToKey(authData.credential.cose);
  return {
    id: b64url(authData.credential.id),
    publicKey: b64url(key.export({ type: 'spki', format: 'der' }) as Buffer),
    alg,
    counter: authData.counter,
  };
}

export interface AssertionResult {
  counter: number;
  userVerified: boolean;
}

/**
 * Verify a navigator.credentials.get() response against a stored public key.
 * The signature covers authenticatorData plus the hash of clientDataJSON,
 * which is what binds the challenge and the origin to the key.
 */
export function verifyAssertion(input: {
  authenticatorData: Buffer;
  clientDataJSON: Buffer;
  signature: Buffer;
  publicKey: string;
  alg: number;
  challenge: string;
  origin: string;
  rpId: string;
}): AssertionResult {
  checkClientData(input.clientDataJSON, {
    type: 'webauthn.get',
    challenge: input.challenge,
    origin: input.origin,
  });
  const authData = parseAuthData(input.authenticatorData);
  if (!rpIdHashOk(authData, input.rpId)) {
    throw new WebAuthnError('the assertion was made for a different hostname');
  }
  if (!authData.userPresent) throw new WebAuthnError('the authenticator did not report user presence');
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey({ key: fromB64url(input.publicKey), format: 'der', type: 'spki' });
  } catch {
    throw new WebAuthnError('the stored public key could not be read');
  }
  const signed = Buffer.concat([
    input.authenticatorData,
    crypto.createHash('sha256').update(input.clientDataJSON).digest(),
  ]);
  // ES256 and RS256 hash before signing and their WebAuthn signatures are
  // ASN.1 DER, which is node's default; Ed25519 signs the message itself.
  const ok =
    input.alg === COSE_EDDSA
      ? crypto.verify(null, signed, key, input.signature)
      : crypto.verify('sha256', signed, key, input.signature);
  if (!ok) throw new WebAuthnError('the signature does not verify');
  return { counter: authData.counter, userVerified: authData.userVerified };
}

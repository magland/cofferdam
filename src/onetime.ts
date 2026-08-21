import * as crypto from 'crypto';

// Single-use values with a lifetime: WebAuthn challenges, the codes behind
// `mochi web`, and the short codes that carry a session to another device.
// All in memory, like the rate limiters and for the same reason -- the state
// is worthless once stale, and a vault directory of plain durable files is
// no place for it. A restart forgets every pending code, which costs a person
// one retry.

export interface OneTimeStore<T> {
  /** Keep value for ttlMs and return the id that redeems it. */
  put(value: T, ttlMs: number): string;
  /** Redeem: the value if id is live, gone from the store either way. */
  take(id: string): T | null;
  /** Look without redeeming, for a page that asks before it acts. */
  peek(id: string): T | null;
}

/** How many entries a store holds before new ones are refused a slot: the
 * mints are all authenticated or rate-limited, so this is a backstop, not a
 * quota anyone should meet. When it is hit, the oldest entry is dropped,
 * which turns an attempted flood into self-inflicted expiry. */
const MAX_ENTRIES = 5000;

export function createOneTimeStore<T>(mint: () => string = mintOpaqueId): OneTimeStore<T> {
  const entries = new Map<string, { value: T; expiresAt: number }>();

  const sweep = (now: number): void => {
    for (const [id, e] of entries) {
      if (e.expiresAt <= now) entries.delete(id);
    }
  };

  const live = (id: string): { value: T; expiresAt: number } | null => {
    const e = entries.get(id);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) {
      entries.delete(id);
      return null;
    }
    return e;
  };

  return {
    put(value, ttlMs) {
      const now = Date.now();
      sweep(now);
      if (entries.size >= MAX_ENTRIES) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
      const id = mint();
      entries.set(id, { value, expiresAt: now + ttlMs });
      return id;
    },
    take(id) {
      const e = live(id);
      if (!e) return null;
      entries.delete(id);
      return e.value;
    },
    peek(id) {
      return live(id)?.value ?? null;
    },
  };
}

function mintOpaqueId(): string {
  return crypto.randomBytes(24).toString('base64url');
}

// The alphabet a person retypes across the room: no 0/O, 1/I/L, or lowercase.
// Eight characters carry just under 40 bits, which with a five-minute life
// and the sign-in rate limit is far beyond guessing.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A code like MQ4V-7XKP, for typing on another device. */
export function mintHandoffCode(): string {
  const chars: string[] = [];
  for (let i = 0; i < 8; i++) {
    chars.push(CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]);
    if (i === 3) chars.push('-');
  }
  return chars.join('');
}

/** The reading of a typed code: case, spaces, and the dash are the display's
 * business and are dropped; the characters themselves must match, which the
 * alphabet makes unambiguous by never containing 0/O or 1/I/L. The dash is
 * re-inserted so the normalized form is the minted form. */
export function normalizeHandoffCode(typed: string): string {
  const s = typed.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

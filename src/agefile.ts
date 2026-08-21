// Age-encrypted files, as the web interface understands them.
//
// A file named `*.age` is treated as an age encryption (age-encryption.org)
// ciphertext: the blob page offers to decrypt it in the browser, and the web
// editor encrypts before committing, so the plaintext and the passphrase
// never reach the server. The extension is the whole contract, the way `.md`
// is: the vault stores and serves bytes it cannot read, and the same file
// decrypts with the standard `age` CLI anywhere else.
//
// The two spellings of the format are both honoured when reading: the binary
// framing, which begins with the version line, and the ASCII armor the spec
// defines (and the browser editor always writes, so its commits diff as
// text). What this module decides is only naming and framing; the cryptography
// itself happens in the reader's browser, in the vendored typage bundle (see
// src/vendor-age.ts), or in whatever age client the user prefers.

/** Whether this path names an age ciphertext, by its extension. */
export function isAgeFile(path: string): boolean {
  return /\.age$/i.test(path);
}

/**
 * The name inside the encryption: `secrets.md.age` is a markdown file, and
 * the viewer renders the decrypted text accordingly. A bare `x.age` has no
 * inner extension and is shown as plain text.
 */
export function ageInnerName(path: string): string {
  return path.replace(/\.age$/i, '');
}

const BINARY_HEADER = Buffer.from('age-encryption.org/v1\n');
const ARMOR_HEADER = Buffer.from('-----BEGIN AGE ENCRYPTED FILE-----');

/**
 * Whether these bytes begin the way an age ciphertext does, in either
 * framing. This is what stands between a failed script and a plaintext
 * commit: the web forms refuse to write a `*.age` path whose content is not
 * age-shaped, because the likeliest way to produce one is a browser that
 * never ran the encryption. It is a framing check, not a validation; a
 * truncated or corrupted ciphertext still passes and fails at decryption,
 * where it can be reported honestly.
 */
export function looksLikeAge(buf: Buffer): boolean {
  return (
    buf.subarray(0, BINARY_HEADER.length).equals(BINARY_HEADER) ||
    buf.subarray(0, ARMOR_HEADER.length).equals(ARMOR_HEADER)
  );
}

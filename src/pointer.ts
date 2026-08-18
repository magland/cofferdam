// Strict parser for Git LFS pointer files. A pointer is exactly the version
// line, an oid line, and a size line, LF-terminated, in that order. Strictness
// matters: this parser decides whether a blob renders as a download card
// instead of as its contents, and a false positive would hide a legitimate
// text file.

const VERSION_LINE = 'version https://git-lfs.github.com/spec/v1';
const MAX_POINTER_SIZE = 200;
// The loose check below reads only the first line, so it can afford a larger
// bound than the strict parser: a pointer carrying extension lines runs past
// 200 bytes, and refusing to edit it is the whole point of that check.
const MAX_LOOSE_POINTER_SIZE = 4096;

export interface LfsPointer {
  oid: string;
  size: number;
}

// A deliberately looser test than parsePointer, used only to decide whether
// the browser editor must refuse a file. Committing text over a pointer
// corrupts the repository's LFS state, so the refusal must also cover pointers
// this module will not fully parse: the real format permits extension lines
// (`ext-0-<name> …`) between the version and the oid, which parsePointer
// rejects because rendering has to stay strict. Erring toward refusing an edit
// costs a user one git command; erring the other way silently breaks a file.
export function looksLikePointer(buf: Buffer): boolean {
  if (buf.length > MAX_LOOSE_POINTER_SIZE) return false;
  return buf.toString('utf8', 0, VERSION_LINE.length + 1) === `${VERSION_LINE}\n`;
}

export function parsePointer(buf: Buffer): LfsPointer | null {
  if (buf.length > MAX_POINTER_SIZE) return null;
  let text: string;
  try {
    text = buf.toString('utf8');
  } catch {
    return null;
  }
  if (!text.endsWith('\n')) return null;
  const lines = text.slice(0, -1).split('\n');
  if (lines.length !== 3) return null;
  if (lines[0] !== VERSION_LINE) return null;
  const oidMatch = lines[1].match(/^oid sha256:([0-9a-f]{64})$/);
  if (!oidMatch) return null;
  const sizeMatch = lines[2].match(/^size ([0-9]+)$/);
  if (!sizeMatch) return null;
  const size = parseInt(sizeMatch[1], 10);
  if (!Number.isSafeInteger(size)) return null;
  return { oid: oidMatch[1], size };
}

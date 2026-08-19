// Parsing multipart/form-data, which is how a browser sends files.
//
// cofferdam parses this itself rather than taking a dependency, for the same
// reason it renders its own HTML: the format is small, the surface it is
// exposed to is one form, and a parser in the tree is one that can be read.
// The body arrives whole (express.raw with a cap) rather than as a stream,
// which is what lets the parser be forty lines: an upload here is bounded by
// the same cap either way, and streaming would buy nothing but complexity.
//
// The grammar, from RFC 7578 and RFC 2046: parts are separated by a line
// `--<boundary>`, each part has headers, then a blank line, then its bytes,
// and the epilogue begins at `--<boundary>--`. Every separator is preceded by
// CRLF that belongs to the separator, not to the part's content.

export interface Part {
  /** The form field's name. */
  name: string;
  /** The client's file name, when the part is a file. */
  filename?: string;
  contentType?: string;
  data: Buffer;
}

/** The boundary out of a Content-Type header, or null if there is not one. */
export function boundaryOf(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const m = contentType.match(/^\s*multipart\/form-data\s*;(.*)$/i);
  if (!m) return null;
  const b = m[1].match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (!b) return null;
  return b[1] ?? b[2] ?? null;
}

function headerValue(headers: string, name: string): string | undefined {
  const m = headers.match(new RegExp(`^${name}:\\s*(.*)$`, 'im'));
  return m ? m[1].trim() : undefined;
}

// Content-Disposition parameters. A filename may be quoted and may contain
// escaped quotes; anything else is taken up to the next semicolon.
function dispositionParam(disposition: string, key: string): string | undefined {
  const m = disposition.match(new RegExp(`${key}=(?:"((?:[^"\\\\]|\\\\.)*)"|([^;]*))`, 'i'));
  if (!m) return undefined;
  return (m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? '')).trim();
}

/**
 * Split a body into its parts. Anything malformed yields the parts that were
 * well formed rather than an exception: a caller checks for what it needs.
 */
export function parseMultipart(body: Buffer, boundary: string): Part[] {
  const parts: Part[] = [];
  const sep = Buffer.from(`--${boundary}`);
  let index = body.indexOf(sep);
  if (index === -1) return parts;
  while (index !== -1) {
    const after = index + sep.length;
    // `--` here closes the whole body; anything else is a CRLF and a part.
    if (body.length >= after + 2 && body[after] === 0x2d && body[after + 1] === 0x2d) break;
    const headerStart = after + 2;
    const blank = body.indexOf('\r\n\r\n', headerStart);
    const next = body.indexOf(sep, headerStart);
    if (blank === -1 || next === -1 || blank > next) break;
    const headers = body.subarray(headerStart, blank).toString('utf8');
    // The CRLF before the next separator belongs to the separator.
    const data = body.subarray(blank + 4, Math.max(blank + 4, next - 2));
    const disposition = headerValue(headers, 'content-disposition') ?? '';
    const name = dispositionParam(disposition, 'name');
    if (name !== undefined) {
      const filename = dispositionParam(disposition, 'filename');
      parts.push({
        name,
        filename: filename === undefined || filename === '' ? undefined : filename,
        contentType: headerValue(headers, 'content-type'),
        data: Buffer.from(data),
      });
    }
    index = next;
  }
  return parts;
}

/** The value of a plain (non-file) field. */
export function partField(parts: Part[], name: string): string {
  const part = parts.find((p) => p.name === name && p.filename === undefined);
  return part ? part.data.toString('utf8') : '';
}

/** Every part that carries a file, in the order the browser sent them. */
export function partFiles(parts: Part[], name: string): Part[] {
  return parts.filter((p) => p.name === name && p.filename !== undefined && p.data.length > 0);
}

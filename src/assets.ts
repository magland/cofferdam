import { createHash } from 'crypto';
import { CSS } from './style';
import { Theme, allThemeVarsCss } from './themes';

/**
 * The forge's stylesheet, with a tag naming this exact body.
 *
 * The sheet is 76 KB and every page links it, so what it costs is decided by
 * whether the browser may keep it. It used to say `no-cache`, which bought a
 * conditional request on every navigation -- 304 at best, and a round trip
 * before anything could be painted. The tag ends that: it is a hash of the
 * bytes, so a changed theme or an edited style.ts changes the URL, and any URL
 * that carries the right tag can be kept for good.
 *
 * Built once per theme rather than per request, which also stops the 76 KB
 * concatenation from happening on every hit.
 */
const sheets = new Map<string, { body: string; tag: string }>();

export function styleSheet(theme: Theme): { body: string; tag: string } {
  const made = sheets.get(theme.name);
  if (made) return made;
  const body = allThemeVarsCss(theme) + CSS;
  const sheet = { body, tag: createHash('sha256').update(body).digest('hex').slice(0, 12) };
  sheets.set(theme.name, sheet);
  return sheet;
}

// HTML with escaping as the default rather than the discipline.
//
// Every page here is built from template literals, and for a long time each
// interpolation escaped its own value by hand: `${esc(name)}`. The rule was
// simple and the failure mode was simpler: one forgotten esc() is an
// injection, and nothing but review stood between the two. This module turns
// the rule into the type system. The html`` tag escapes every interpolated
// value unless it is already Html, and a value is only Html because a
// template built it or because raw() was told, in so many words, to trust it.
//
// The composition rule falls out of the type: a fragment built by html`` can
// be interpolated into another html`` template and is not escaped again, so
// pages nest the way they always did, and the only places that need a
// decision are the borders where pre-rendered HTML comes in from elsewhere --
// markdown output, highlighted code, a diff -- which is exactly where the
// decision belongs.
//
// One trap is worth naming. An array of Html fragments interpolates
// correctly, joined by nothing, but calling .join() on one produces a plain
// string, which the tag then escapes: `${items.join('\n')}` is the bug and
// `${joinHtml(items, '\n')}` is the spelling. The type system cannot refuse
// .join on an array, so this is the one place the old discipline survives.
//
// Where escaping is checked: layout() takes Html and nothing else, so a page
// cannot be assembled from a plain string at all, and tests/escaping.test.ts
// drives the real page functions with a script tag and an attribute break
// where a name, a path, or a description goes. What it asserts is both halves:
// that nothing executable comes out, and that the payload reached the page, so
// a test cannot pass by rendering nothing.

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A string of HTML that is what it says it is, and may be interpolated without escaping. */
export class Html {
  constructor(readonly text: string) {}
  toString(): string {
    return this.text;
  }
}

/**
 * Trust a string as HTML. This is the whole of the escape hatch, and the name
 * is a flag for review: every raw() should be able to say where its argument
 * was made safe.
 */
export function raw(text: string): Html {
  return new Html(text);
}

function render(v: unknown): string {
  if (v instanceof Html) return v.text;
  if (Array.isArray(v)) return v.map(render).join('');
  // Dropping the non-values is what makes `${cond && fragment}` a
  // conditional and `${maybe?.thing}` an optional, without either spelling
  // out an empty-string alternative.
  if (v === null || v === undefined || typeof v === 'boolean') return '';
  return esc(String(v));
}

/** The tag. Literal text passes through; every value is escaped unless it is Html. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + strings[i + 1];
  }
  return new Html(out);
}

/** Fragments joined by a literal separator, since Array.prototype.join would flatten them to escaped text. */
export function joinHtml(items: unknown[], separator = ''): Html {
  return new Html(items.map(render).join(separator));
}

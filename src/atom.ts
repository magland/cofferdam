import { esc } from './render';

// Atom feeds. GitHub hangs one off every list worth following - commits,
// releases, tags - and a feed is the one way a reader can watch a repository
// without an account on it, which suits a vault: no notifications to store, no
// subscriptions to keep, just a document that says what changed.

export interface FeedEntry {
  /** Stable and globally unique: a URL is both. */
  id: string;
  title: string;
  updated: string;
  link: string;
  author: string;
  /** Plain text; it is escaped into a text-typed content element. */
  summary?: string;
}

export interface Feed {
  id: string;
  title: string;
  /** The feed's own address, and the page it describes. */
  selfLink: string;
  htmlLink: string;
  entries: FeedEntry[];
}

function iso(date: string): string {
  const d = new Date(date);
  return isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

export function atomFeed(feed: Feed): string {
  // The feed's own timestamp is that of its newest entry, and the epoch when
  // it has none, so a reader can tell a quiet feed from a broken one.
  const updated = feed.entries.length ? iso(feed.entries[0].updated) : new Date(0).toISOString();
  const entries = feed.entries
    .map(
      (e) => `  <entry>
    <id>${esc(e.id)}</id>
    <title>${esc(e.title)}</title>
    <updated>${esc(iso(e.updated))}</updated>
    <link rel="alternate" type="text/html" href="${esc(e.link)}"/>
    <author><name>${esc(e.author)}</name></author>${
      e.summary ? `\n    <content type="text">${esc(e.summary)}</content>` : ''
    }
  </entry>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${esc(feed.id)}</id>
  <title>${esc(feed.title)}</title>
  <updated>${esc(updated)}</updated>
  <link rel="self" type="application/atom+xml" href="${esc(feed.selfLink)}"/>
  <link rel="alternate" type="text/html" href="${esc(feed.htmlLink)}"/>
${entries}
</feed>
`;
}
